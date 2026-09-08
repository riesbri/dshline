/**
 * Prove, end to end, what a consumer experiences today.
 *
 * The type-level jobs answer whether this bundle compiles against Harness; a
 * plugin also has to install into a real profile beside the real launcher and
 * draw on a real terminal. That path crosses three tools this repository does
 * not control — pnpm's installer, the harness's profile loader, the terminal
 * handshake — where only an actual run is evidence. The audit that produced
 * this workflow ran those steps by hand; this script is that run, committed.
 *
 * The sequence mirrors docs/install.md exactly: install the published
 * `@deepseek-ai/dsh` launcher, pack this bundle, add it to a fresh profile,
 * boot it under a pseudo-terminal, confirm the startup banner reached the
 * screen, and leave with ctrl-d. Everything runs inside a temporary directory;
 * nothing here reads or writes user state, and no model is configured, so the
 * launch session browser is as far as it gets — which is the point being
 * tested.
 *
 * `--bootstrap` proves the other advertised sequence, the one a new user
 * actually types: install both packages, run `dshline`, answer the first-run
 * question, end up in a session. The two modes answer two different questions
 * and are kept apart on purpose:
 *
 * - the default mode asks whether the plugin code IN THIS COMMIT installs and
 *   boots against this Harness line, so it installs the packed tarball (and
 *   substitutes a packed renderer when the registry cannot serve one yet);
 * - `--bootstrap` asks whether THIS COMMIT'S WRAPPER implements the user
 *   lifecycle, so it runs the packed executable against a genuinely empty
 *   `DSH_HOME` and lets the first run install from the registry — the package a
 *   real first run gets. Which install that is comes from the wrapper itself
 *   (its own exact version, under dshline's release-age window), so this mode
 *   also decides which outcome is correct: installed and booted when the
 *   registry can serve that version, refused when it is still too young to.
 *   Ending up on any OTHER version is a failure either way. Nothing here
 *   touches the profile before or after; the harness creates all of it.
 *
 * Requires a `script(1)` for the pseudo-terminal — util-linux's on Linux, BSD's
 * on macOS, which take their command differently — and skips itself where there
 * is none rather than failing; the daily job runs on Linux, where the check is
 * real. Set CONSUMER_SMOKE_STORE_DIR to point pnpm at a writable
 * content-addressable store on machines whose default store location is
 * restricted; unset in CI, where the default is fine.
 *
 * @module tools/consumer-smoke
 */

import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { installArguments } from '../packages/dshline/bin/dshline.mjs'

const execFileAsync = promisify(execFile)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_DIR = join(repoRoot, 'packages', 'dshline')
const RENDERER_DIR = join(repoRoot, 'packages', 'renderer')
const LAUNCHER_PACKAGE = '@deepseek-ai/dsh'
const REGISTRY_HOST = 'https://registry.npmjs.org'
const PLUGIN_PACKAGE_NAME = '@dshline/dshline'
const RENDERER_PACKAGE_NAME = '@dshline/renderer'
const PROFILE_NAME = 'dshline'

/**
 * The pseudo-terminal's geometry, an ordinary terminal size rather than
 * whatever `script(1)` leaves unconfigured.
 *
 * This check proves a normal packaged startup, not narrow-terminal
 * presentation — that is `packages/dshline/tests/narrow-root.spec.ts`'s job,
 * against the real code paths rather than a captured transcript. Left
 * unconfigured, a pty with no controlling terminal to inherit from (which is
 * every CI runner) can come up at an unusably small size, and a startup that
 * genuinely never reaches `ready` at that size can still read as evidence
 * this check passed.
 */
const PTY_COLUMNS = 80
const PTY_ROWS = 24

/** How long the boot may take to show its banner before this is a failure. */
export const BOOT_TIMEOUT_MS = 60_000

/** How long a graceful ctrl-d exit may take before the process is killed. */
const QUIT_TIMEOUT_MS = 30_000

/**
 * How long the first-run install may take before the boot timeout gives up.
 * A profile install downloads the harness's whole plugin set through pnpm, so
 * this is the network's budget, not the interface's.
 */
const BOOTSTRAP_TIMEOUT_MS = 600_000

/**
 * A credential for the route a stock profile selects by default.
 *
 * Given to the DEFAULT mode only, and the split is the point. That mode asks
 * whether the plugin code in this commit boots against the real launcher and
 * reaches a session — a question that presumes a machine someone has
 * configured. It is not a question about a machine nobody has.
 *
 * Those became different startups in this line. `dsh-base` composes a default
 * selection (`deepseek-official/deepseek-v4-flash`) and `llm-deepseek`
 * registers that route before any key exists, so a runner with no key is a
 * genuinely unconfigured machine — and dshline now opens its guided setup
 * there rather than a composer that could not send a turn. Without this the
 * default mode reads that correct behaviour as `ready=false` and fails.
 *
 * So the environment states the thing that assertion always assumed. The value
 * is never sent anywhere: no turn is taken, and the credential seam is asked
 * only whether the reference resolves.
 *
 * `--bootstrap` deliberately does NOT get it — see {@link SETUP_MARKER}.
 */
const STOCK_CREDENTIAL = { DEEPSEEK_API_KEY: 'consumer-smoke-placeholder' }

/**
 * The smallest stable evidence that the guided setup is on screen.
 *
 * `--bootstrap` runs against a genuinely empty home with no credential, which
 * is the state a real first run is in — so once a released dshline carries the
 * setup gate, that run meets the picker instead of a composer, and this check
 * has to answer it rather than time out waiting for `ready`.
 *
 * "Not now" is an invariant of the surface rather than a line to match: the
 * way out is labelled that whenever the launch could not send a turn, and a
 * launch that COULD send one never opens setup at all. Matching the credential
 * sentence or a step label instead would tie this to one reason; matching the
 * `Setup` frame title would tie it to nothing, since the wrapper's own
 * question already says "not set up yet".
 *
 * Inert until then, and safely so: replies fire in order and only on a match,
 * so against a published dshline with no setup gate this simply never fires.
 */
const SETUP_MARKER = 'Not now'

/** Dismiss a bounded overlay, exactly as `esc` does for a human. */
const DISMISS = '\u001b'

/** The end of the wrapper's first-run question, matched whitespace-free. */
const QUESTION_MARKER = 'set it up now?'


/**
 * Decide whether a captured terminal stream shows a healthy startup.
 *
 * The renderer updates the screen by moving the cursor, so the stream splits
 * words across writes and rows; matching happens on a whitespace-free,
 * escape-free flattening of everything received, which is why a frame with the
 * right characters in the wrong order cannot pass by accident.
 * @param raw - everything the pseudo-terminal produced so far.
 * @param version - the bundle version the banner is expected to print.
 * @returns which pieces of startup evidence are present.
 */
export function parseBootEvidence(raw, version) {
  const flat = flatten(raw)
  return {
    // A missing or empty version must disable banner matching rather than
    // match everything: String.prototype.includes('') is always true.
    sawBanner: Boolean(version) && flat.includes('dshline') && flat.includes(version.toLowerCase()),
    sawReady: flat.includes('ready'),
  }
}

/**
 * Flatten captured terminal output for matching.
 *
 * Escape sequences removed, case folded, whitespace dropped: the renderer moves
 * the cursor to draw, so a word arrives split across writes and rows, and a
 * frame with the right characters in the wrong order still cannot pass.
 * @param raw - everything the pseudo-terminal produced so far.
 * @returns the flattened form.
 */
function flatten(raw) {
  return raw
    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]|\u001b\][^\u0007]*\u0007/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, '')
}

/**
 * Run a command, capturing failure as a thrown error that names what ran.
 * @param command - the executable.
 * @param args - its arguments.
 * @param options - spawn options; `cwd` and `env` matter here.
 * @param description - the phrase used when reporting a non-zero exit.
 * @returns stdout plus stderr of the finished command.
 */
async function run(command, args, options, description) {
  try {
    return await execFileAsync(command, args, { timeout: 600_000, ...options })
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message].find(text => text !== undefined && text !== '') ?? ''
    throw new Error(`${description} failed (${command} ${args.join(' ')}):\n${String(detail).slice(-2000)}`)
  }
}

/**
 * Extra arguments every pnpm invocation needs on restricted machines.
 * @returns the flag list from CONSUMER_SMOKE_STORE_DIR, or empty.
 */
function storeArgs() {
  const configured = (process.env.CONSUMER_SMOKE_STORE_DIR ?? '').trim()
  return configured === '' ? [] : ['--store-dir', configured]
}

/**
 * The version an ordinary consumer would install today, following `latest`
 * (`npm install -g @deepseek-ai/dsh`).
 *
 * Only the fallback for a hand-run `pnpm test:consumer`. CI always passes
 * `--launcher-version`, because the launcher it must boot against is the
 * adopted Harness generation in `HARNESS_TARGET` — an exact version — and not
 * whichever line a dist-tag happens to name that day.
 * @param packageName - the package to look up.
 * @returns the exact version string.
 */
async function publishedVersion(packageName) {
  const tag = 'latest'
  const response = await fetch(`${REGISTRY_HOST}/${encodeURIComponent(packageName)}`)
  if (!response.ok) throw new Error(`registry returned ${String(response.status)} for ${packageName}`)
  const packument = await response.json()
  const version = packument['dist-tags']?.[tag]
  if (version === undefined) throw new Error(`${packageName} has no ${tag} dist-tag on the registry`)
  return version
}

/**
 * What this commit's wrapper will ask the harness to install, and under what
 * window.
 *
 * Read from the wrapper itself rather than restated, because a copy here that
 * drifted would let this mode pass while proving the wrong flow. `bin/dshline.mjs`
 * starts nothing when imported, which is what makes that possible.
 * @returns the exact package spec, and the release-age window in minutes.
 */
function requestedInstall() {
  const args = installArguments()
  const flag = args.find(argument => argument.startsWith('--config.minimum-release-age='))
  if (flag === undefined) throw new Error('the wrapper no longer passes a release-age window to the harness')
  const spec = args.at(-1)
  if (spec === undefined) throw new Error('the wrapper no longer names a package to install')
  return { spec, minutes: Number(flag.slice(flag.indexOf('=') + 1)) }
}

/**
 * How long ago the registry published one exact version, in minutes.
 * @param packageName - the package to look up.
 * @param version - the exact version to time.
 * @returns the age in minutes, or undefined when that version is not published.
 */
async function publishedAgeMinutes(packageName, version) {
  const response = await fetch(`${REGISTRY_HOST}/${encodeURIComponent(packageName)}`)
  if (!response.ok) throw new Error(`registry returned ${String(response.status)} for ${packageName}`)
  const packument = await response.json()
  const published = packument.time?.[version]
  if (typeof published !== 'string') return undefined
  return (Date.now() - Date.parse(published)) / 60_000
}

/**
 * Pack one workspace package into a directory of its own.
 * Packing runs the prepare script (tsc -b), so lib/ exists even in a fresh
 * checkout — the same reason a consumer installing from npm gets working code.
 * Each tarball gets its own directory so the one produced here is identified by
 * where it landed rather than by guessing among several.
 * @param packageDir - the workspace package to pack.
 * @param destination - the directory receiving this tarball.
 * @param description - what to call this step when it fails.
 * @returns the absolute path of the packed tarball.
 */
async function packPackage(packageDir, destination, description) {
  await mkdir(destination, { recursive: true })
  await run('pnpm', ['pack', '--pack-destination', destination], { cwd: packageDir }, description)
  const files = await readdir(destination)
  const tarball = files.find(file => file.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`pnpm pack produced no tarball in ${destination}`)
  return join(destination, tarball)
}

/**
 * Install the launcher into a scratch prefix, exactly once per run.
 * @param consumerDir - the scratch project directory.
 * @param launcherVersion - the published version to install.
 */
async function installLauncher(consumerDir, launcherVersion) {
  await writeFile(join(consumerDir, 'package.json'), `${JSON.stringify({ name: 'consumer-smoke', private: true }, null, 2)}\n`)
  // Marking the scratch project its own workspace root is not a policy
  // bypass: it stops pnpm from walking UP into whatever repository contains
  // the temporary directory and applying rules that were never meant to
  // govern a throwaway install. On CI, where /tmp is outside any workspace,
  // the file changes nothing.
  const workspaceConfig = [
    '# Written by tools/consumer-smoke.mjs: this scratch project is its own',
    '# workspace root so enclosing repositories\' pnpm policies do not apply.',
    "packages:\n  - '.'",
    // The launcher's dependency graph contains native addons, and pnpm refuses
    // to build a dependency's scripts unless it is named. Refusing them here
    // does not make this install safer than the one being reproduced: the
    // documented consumer path is `npm install -g @deepseek-ai/dsh`, and npm
    // runs those same scripts by default. It only makes the install unbootable
    // and the lane's verdict meaningless — a launcher whose `fs-ext` binary was
    // never compiled fails inside the loader, which is a fact about this
    // scratch directory rather than about the published pair.
    //
    // Allowing all of them rather than listing names on purpose: the set is
    // upstream's, it changes with the adopted generation (this one added
    // `fs-ext`, `koffi`, and `node-pty` where the previous had none), and a
    // list here would be dshline asserting a dependency inventory it does not
    // own. The blast radius is one temporary directory in CI installing the
    // exact first-party package under test.
    'dangerouslyAllowAllBuilds: true',
  ]
  const configuredStore = (process.env.CONSUMER_SMOKE_STORE_DIR ?? '').trim()
  if (configuredStore !== '') workspaceConfig.push(`storeDir: ${configuredStore}`)
  await writeFile(join(consumerDir, 'pnpm-workspace.yaml'), `${workspaceConfig.join('\n')}\n`)
  await run('pnpm', ['add', ...storeArgs(), `${LAUNCHER_PACKAGE}@${launcherVersion}`],
    { cwd: consumerDir }, `installing ${LAUNCHER_PACKAGE}@${launcherVersion}`)
}

/**
 * Add the packed bundle to a fresh profile via the harness's own command.
 *
 * The first attempt is the real consumer path: pnpm resolves the bundle's own
 * dependency on the renderer from the registry, exactly as an install from npm
 * would. Two things can make that attempt fail for reasons a consumer would not
 * hit, and each is recovered by appending one line to the profile's own
 * pnpm-workspace.yaml and trying once more — never by inventing profile state
 * this script does not understand, because the harness wrote everything except
 * the appended line:
 *
 * - pnpm's default store is not writable on this machine, so the configured
 *   store has to be named in the profile too;
 * - the renderer version this commit depends on is not on the registry yet,
 *   which is the state of things between a rename or a version bump and the
 *   publish that follows it. The locally packed renderer stands in, so the boot
 *   is still proved against the code in this tree. Which renderer answered is
 *   reported, so a substitution is never silent.
 * @param dshBin - the launcher executable inside the scratch prefix.
 * @param home - DSH_HOME for this run.
 * @param tarball - the packed bundle to install.
 * @param rendererTarball - the packed renderer, used only if the registry
 *   cannot serve the version the bundle asks for.
 * @returns where the renderer came from, for the run's own report.
 */
async function installProfile(dshBin, home, tarball, rendererTarball) {
  const environment = {
    ...process.env,
    CI: 'true',
    DSH_HOME: home,
    PATH: `${dirname(dshBin)}:${process.env.PATH ?? ''}`,
  }
  const attempt = () => run(dshBin, ['plugin', '--profile', PROFILE_NAME, 'add', tarball], { cwd: dirname(tarball), env: environment }, 'adding the plugin to a fresh profile')
  try {
    await attempt()
    return 'registry'
  } catch (firstError) {
    const profileWorkspace = join(home, 'profiles', PROFILE_NAME, 'pnpm-workspace.yaml')
    let existing = ''
    try {
      existing = await readFile(profileWorkspace, 'utf8')
    } catch {
      throw firstError
    }
    let repaired = existing
    const configuredStore = (process.env.CONSUMER_SMOKE_STORE_DIR ?? '').trim()
    if (configuredStore !== '' && !existing.includes('storeDir')) {
      repaired += `storeDir: ${configuredStore}\n`
    }
    let renderer = 'registry'
    if (rendererTarball !== undefined && !existing.includes('overrides:')) {
      repaired += `overrides:\n  "${RENDERER_PACKAGE_NAME}": "file:${rendererTarball}"\n`
      renderer = 'packed'
    }
    // Nothing left to try: the failure is the answer, not a machine quirk.
    if (repaired === existing) throw firstError
    await writeFile(profileWorkspace, repaired)
    await attempt()
    if (renderer === 'packed') {
      process.stdout.write(
        `renderer: the registry does not serve ${RENDERER_PACKAGE_NAME} for this bundle yet;`
        + ' the locally packed renderer was used instead\n',
      )
    }
    return renderer
  }
}

/**
 * Watch a spawned process's own stdout in real time until it shows startup
 * evidence, then quit it with ctrl-d — the key the WINDOW owns everywhere,
 * per design — and wait for a clean exit.
 *
 * This reads the process's piped stdout, never a file. `script(1)` mirrors
 * the pty session to both its own stdout and the transcript file named on its
 * command line, but the two paths do not become readable at the same time:
 * writing to its own stdout is effectively unbuffered, while the file write
 * goes through ordinary buffered stdio, so a periodic re-read of that file
 * can observe "not ready yet" for as long as a buffer's worth of output takes
 * to fill or flush — long enough, in practice, to make this check give up
 * and quit before ever seeing evidence the terminal had already rendered.
 * Watching the pipe removes that lag: a `data` event fires as soon as Node's
 * own stream delivers the bytes.
 * A reply is answered the same way, and for the same reason: the first-run
 * question is on the terminal, not in a file, and it has to be answered when it
 * appears rather than after a fixed wait that could be too early on a fast
 * machine and too late on a slow one.
 * @param child - the spawned process; stdout, stderr, and stdin must be piped.
 * @param version - the bundle version expected in the banner.
 * @param bootTimeoutMs - how long to wait for both evidence flags before quitting anyway.
 * @param quitTimeoutMs - how long a graceful quit may take before the process is killed.
 * @param replies - things to type, in order: `{ after, send }`, where `after` is
 *   matched against the same whitespace-free flattening the evidence uses.
 * @param requireBanner - whether the banner must be seen before quitting. False
 *   where the version the banner will print is not known until after the run —
 *   a first run installs whatever the registry serves it, so the banner is
 *   checked afterwards against the version that actually landed.
 * @returns the exit outcome, the evidence observed when quit was requested, what
 *   was replied to, and everything captured.
 */
export function observeUntilReady(child, version, bootTimeoutMs, quitTimeoutMs, replies = [], requireBanner = true) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = ''
    let stderr = ''
    let evidence = { sawBanner: false, sawReady: false }
    let quitRequested = false
    const replied = []

    const requestQuit = () => {
      if (quitRequested) return
      quitRequested = true
      clearTimeout(bootTimer)
      child.stdin.write('\u0004')
    }

    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      const pending = replies[replied.length]
      if (pending !== undefined && flatten(stdout).includes(flatten(pending.after))) {
        replied.push(pending.after)
        child.stdin.write(pending.send)
      }
      evidence = parseBootEvidence(stdout, version)
      if (evidence.sawReady && (evidence.sawBanner || !requireBanner)) requestQuit()
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })

    // Give up waiting for evidence and quit anyway; the caller decides
    // pass/fail from the evidence actually observed, not from this timeout.
    const bootTimer = setTimeout(requestQuit, bootTimeoutMs)
    const killTimer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectPromise(new Error(
        `the process did not exit within ${String(bootTimeoutMs + quitTimeoutMs)}ms\nstderr:\n${stderr.slice(-1000)}`
        + `\ncaptured stdout:\n${stdout.slice(-2000)}`,
      ))
    }, bootTimeoutMs + quitTimeoutMs)

    child.on('error', error => {
      clearTimeout(bootTimer)
      clearTimeout(killTimer)
      rejectPromise(new Error(`could not run the child process: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      clearTimeout(bootTimer)
      clearTimeout(killTimer)
      if (signal !== null) {
        rejectPromise(new Error(`the interface was terminated by ${signal} instead of quitting cleanly\nstderr:\n${stderr.slice(-1000)}`))
        return
      }
      resolvePromise({ code: code ?? -1, evidence, replied, stdout })
    })
  })
}

/**
 * Quote one argument for the shell that starts `script(1)`.
 * @param argument - one argv entry.
 * @returns the argument as a single shell word.
 */
function shellWord(argument) {
  return `'${argument.replace(/'/gu, `'\\''`)}'`
}

/**
 * Spawn a command with a real pseudo-terminal on both ends.
 *
 * The two `script` implementations disagree about everything except that they
 * provide a terminal: util-linux takes the command as one string after `-qec`
 * and writes its transcript to the file named last, while BSD's takes the
 * command as arguments and refuses a stdin that is not a pipe — which is what
 * the process substitution supplies, since Node's own piped stdin is a socket.
 * Both are driven through `bash -c` rather than spawned directly so that one
 * command line covers the difference.
 * @param argv - the command and its arguments.
 * @param options - `cwd`, `env`, and where the transcript may be written.
 * @returns the spawned, fully piped child.
 */
function ptySpawn(argv, { cwd, env, transcript }) {
  // `stty` sets the pty's winsize the moment it is this shell's controlling
  // terminal, which `script(1)` has just made it — before the real command
  // ever reads it. `shift 2` drops the size arguments so `"$@"` is exactly
  // `argv` again, so the numbers travel as ordinary arguments rather than
  // being spliced into the script text.
  const sized = [
    'bash', '-c', 'stty cols "$1" rows "$2" && shift 2 && exec "$@"',
    'bash', String(PTY_COLUMNS), String(PTY_ROWS), ...argv,
  ]
  const inner = sized.map(part => shellWord(part)).join(' ')
  const line = process.platform === 'linux'
    ? `exec script -qec ${shellWord(inner)} ${shellWord(transcript)}`
    : `exec script -q ${shellWord(transcript)} ${inner} < <(cat)`
  return spawn('bash', ['-c', line], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
}

/**
 * Boot the interface under a pseudo-terminal and quit it once ready.
 * @param dshBin - the launcher executable.
 * @param home - DSH_HOME for this run.
 * @param cwd - the folder the session opens into.
 * @param version - the bundle version expected in the banner.
 * @returns the evidence found before quitting.
 */
function bootAndQuit(dshBin, home, cwd, version) {
  // The transcript file is a postmortem artifact only, kept on disk beside a
  // failed run's preserved workspace for a human to inspect; this check
  // itself never reads it — see observeUntilReady's module comment for why.
  const child = ptySpawn([dshBin, '--profile', PROFILE_NAME, '-C', cwd], {
    cwd,
    env: {
      ...process.env,
      ...STOCK_CREDENTIAL,
      DSH_HOME: home,
      TERM: process.env.TERM ?? 'xterm-256color',
    },
    transcript: join(cwd, 'boot.out'),
  })
  return observeUntilReady(child, version, BOOT_TIMEOUT_MS, QUIT_TIMEOUT_MS).catch(error => {
    throw error.message.startsWith('could not run the child process')
      ? new Error(`${error.message}. This check needs script(1).`)
      : error
  })
}

/**
 * Unpack the packed bundle far enough to run its executable.
 *
 * The wrapper imports nothing from its own package — that is the point of it —
 * so it runs from an unpacked tarball with no install at all. Which is what
 * makes it testable here: what a consumer gets from
 * `npm install -g @dshline/dshline` is exactly this file.
 * @param tarball - the packed bundle.
 * @param destination - a directory to unpack into.
 * @returns the path of the packed `dshline` executable.
 */
async function extractWrapper(tarball, destination) {
  await mkdir(destination, { recursive: true })
  await run('tar', ['-xzf', tarball, '-C', destination], {}, 'unpacking the bundle')
  return join(destination, 'package', 'bin', 'dshline.mjs')
}

/**
 * Run the packed wrapper's first run under a pseudo-terminal: answer the
 * question, let the harness install, and land in a session.
 *
 * No version is expected up front, and the caller decides afterwards which
 * outcome was the right one: a first run asks for the wrapper's OWN version
 * under dshline's release-age window, so a version still inside that window
 * makes a refusal correct and a session wrong. This function only runs the
 * flow and captures it.
 * @param wrapper - the packed `dshline` executable.
 * @param dshBin - the launcher executable, reached through PATH as a user's is.
 * @param home - DSH_HOME for this run.
 * @param cwd - the folder the session opens into.
 * @returns the exit outcome, the evidence, what was answered, and the capture.
 */
function firstRunAndQuit(wrapper, dshBin, home, cwd) {
  const child = ptySpawn([process.execPath, wrapper], {
    cwd,
    env: {
      ...process.env,
      // No credential here, unlike the default mode: this IS the fresh-install
      // path, and giving it one would configure away the very state it exists
      // to walk through.
      DSH_HOME: home,
      // Set explicitly rather than inherited, so a hand-run smoke sees what CI
      // sees. It decides one thing here: pnpm ASKS before it would install a
      // version still inside the release-age window, and where nothing can be
      // asked it refuses outright. Both are correct answers for a user — the
      // silent downgrade this mode exists to catch is neither — but only the
      // second is an outcome a check can assert, and the terminal this runs
      // under is a pseudo-terminal precisely so the wrapper's own question is
      // real, which makes pnpm's question real too.
      CI: 'true',
      // No DSH_BIN: the launcher is found the way an ordinary global install is
      // found, on PATH, so this exercises the resolution a consumer gets.
      DSH_BIN: '',
      PATH: `${dirname(dshBin)}:${process.env.PATH ?? ''}`,
      TERM: process.env.TERM ?? 'xterm-256color',
    },
    transcript: join(cwd, 'first-run.out'),
  })
  return observeUntilReady(child, undefined, BOOTSTRAP_TIMEOUT_MS, QUIT_TIMEOUT_MS, [
    { after: QUESTION_MARKER, send: 'y\n' },
    // Answered the way a person answers it — dismissed — after which the
    // session attaches and reaches `ready` as the assertions below expect.
    { after: SETUP_MARKER, send: DISMISS },
  ], false)
}

// Entry point, guarded like the other tools so tests import cleanly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.platform === 'win32') {
    process.stdout.write('consumer smoke skipped: needs script(1) for a pseudo-terminal, which Windows has no equivalent of\n')
    process.exit(0)
  }
  const args = process.argv.slice(2)
  const pinIndex = args.indexOf('--launcher-version')
  const pinnedLauncher = pinIndex === -1 ? undefined : args[pinIndex + 1]
  // The advertised first-run sequence, rather than a profile this script
  // installed itself: see the module comment.
  const bootstrap = args.includes('--bootstrap')
  if (pinIndex !== -1 && pinnedLauncher === undefined) {
    process.stderr.write('usage: node tools/consumer-smoke.mjs [--bootstrap] [--launcher-version <version>]\n')
    process.exit(1)
  }
  const bundleManifest = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-consumer-smoke-'))
  try {
    // CI always pins: the launcher it must boot against is the exact adopted
    // Harness generation, and installing `latest` would prove a boot against
    // a line this repository makes no claim about.
    const launcherVersion = pinnedLauncher ?? await publishedVersion(LAUNCHER_PACKAGE)
    const consumerDir = join(workspace, 'consumer')
    await mkdir(consumerDir, { recursive: true })
    process.stdout.write(`launcher: ${LAUNCHER_PACKAGE}@${launcherVersion} (${pinnedLauncher === undefined ? 'latest' : 'pinned'})\n`)
    await installLauncher(consumerDir, launcherVersion)

    const tarball = await packPackage(BUNDLE_DIR, join(workspace, 'bundle'), 'packing the bundle')
    const tarballBytes = (await stat(tarball)).size
    process.stdout.write(`plugin: ${PLUGIN_PACKAGE_NAME}@${bundleManifest.version} (${tarballBytes.toString()} bytes)\n`)
    const dshBin = join(consumerDir, 'node_modules', '.bin', 'dsh')
    const scratch = join(workspace, 'session-folder')
    await mkdir(scratch, { recursive: true })

    if (bootstrap) {
      // What this mode proves, and nothing else: that THIS commit's wrapper
      // implements the lifecycle a new user meets. So the only thing taken from
      // the tarball is the executable, the harness home is genuinely empty, and
      // the package the first run installs is whatever the registry serves for
      // `@dshline/dshline` — because that is the name the wrapper passes, and
      // making that name resolve to a local tarball would mean editing the
      // profile's pnpm settings, i.e. testing a profile this script had already
      // touched. Whether the UNPUBLISHED plugin code in this commit installs and
      // boots is the other mode's question, and it answers it with the packed
      // tarball and a renderer fallback this mode needs none of.
      const wrapper = await extractWrapper(tarball, join(workspace, 'unpacked'))
      const home = join(workspace, '.dsh-first-run')
      // Which outcome is CORRECT depends on the registry, so it is decided before
      // the run rather than read off it. The wrapper asks for its own exact
      // version under dshline's release-age window, and that has exactly two
      // right answers: install it, or refuse. Installing anything ELSE — the
      // silent downgrade to the previous release that this mode caught once
      // already — is never one of them.
      const { spec, minutes } = requestedInstall()
      const ageMinutes = await publishedAgeMinutes(PLUGIN_PACKAGE_NAME, bundleManifest.version)
      const mature = ageMinutes !== undefined && ageMinutes >= minutes
      process.stdout.write(
        `first run will ask for ${spec} under a ${String(minutes)}-minute release-age window`
        + ` (${ageMinutes === undefined ? 'not published yet' : `published ${ageMinutes.toFixed(0)} minutes ago`})`
        + `: expecting the install to ${mature ? 'succeed' : 'be refused'}\n`,
      )
      const result = await firstRunAndQuit(wrapper, dshBin, home, scratch)
      if (!result.replied.includes(QUESTION_MARKER)) {
        throw new Error(
          'the first-run question never appeared, so nothing proved the advertised flow\n'
          + `captured terminal output:\n${result.stdout.slice(-2000)}`,
        )
      }
      const profileDir = join(home, 'profiles', PROFILE_NAME)
      // `dsh plugin` writes the profile manifest before it installs, so it is
      // there either way; what it RECORDS is the evidence.
      const bootstrapped = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8').catch(() => '{}'))
      const recorded = bootstrapped.dependencies ?? {}
      if (!mature) {
        // The window is doing its job, which is the whole point of stating it:
        // a version too young to install must stop the first run, not quietly
        // become an older version of dshline than the wrapper asking for it.
        if (PLUGIN_PACKAGE_NAME in recorded) {
          throw new Error(
            `${spec} is inside the release-age window, but the first run installed`
            + ` ${JSON.stringify(recorded[PLUGIN_PACKAGE_NAME])} anyway — the silent downgrade is back`,
          )
        }
        if (result.evidence.sawReady || result.code === 0) {
          throw new Error(
            `${spec} could not be installed, yet the first run reached a session (exit code=${String(result.code)})\n`
            + `captured terminal output:\n${result.stdout.slice(-2000)}`,
          )
        }
        if (!result.stdout.includes('setup did not finish')) {
          throw new Error(
            'the refused install did not say the setup had not finished, so the user was left without a reason\n'
            + `captured terminal output:\n${result.stdout.slice(-2000)}`,
          )
        }
        process.stdout.write(
          `first run passed: ${spec} is younger than the ${String(minutes)}-minute window,`
          + ' so the harness refused it, nothing was installed, and no session started\n',
        )
      } else {
        if (!result.evidence.sawReady) {
          throw new Error(
            `first run never reached a session (exit code=${String(result.code)})\n`
            + `captured terminal output:\n${result.stdout.slice(-2000)}`,
          )
        }
        if (result.code !== 0) throw new Error(`ctrl-d exit was ${String(result.code)}, expected 0`)
        if (!(PLUGIN_PACKAGE_NAME in recorded)) {
          throw new Error(`the harness did not record ${PLUGIN_PACKAGE_NAME} in the profile it created: ${JSON.stringify(recorded)}`)
        }
        const installed = JSON.parse(
          await readFile(join(profileDir, 'node_modules', PLUGIN_PACKAGE_NAME, 'package.json'), 'utf8'),
        ).version
        // The invariant this mode exists for, now that the wrapper names a
        // version: a wrapper installs ITSELF. The old check read whatever landed
        // and only asked the banner to agree with it, which is exactly how a
        // profile holding the previous release passed.
        if (installed !== bundleManifest.version) {
          throw new Error(
            `the ${bundleManifest.version} wrapper installed ${PLUGIN_PACKAGE_NAME}@${installed} into the profile`
            + ' — a first run must never end up on a different release than the wrapper that ran it',
          )
        }
        if (!parseBootEvidence(result.stdout, installed).sawBanner) {
          throw new Error(
            `the banner did not name ${PLUGIN_PACKAGE_NAME}@${installed}, the version this first run installed\n`
            + `captured terminal output:\n${result.stdout.slice(-2000)}`,
          )
        }
        process.stdout.write(
          'first run passed: empty home, question answered, harness created and installed the profile,'
          + ` banner showed ${PLUGIN_PACKAGE_NAME}@${installed}, ctrl-d exited cleanly\n`,
        )
      }
    } else {
      // Packed unconditionally so the fallback exists before it is known to be
      // needed; the registry is still preferred, and this is discarded unused
      // once these versions are published.
      const rendererTarball = await packPackage(RENDERER_DIR, join(workspace, 'renderer'), 'packing the renderer')
      const home = join(workspace, '.dsh')
      const renderer = await installProfile(dshBin, home, tarball, rendererTarball)
      const profileManifest = JSON.parse(await readFile(join(home, 'profiles', PROFILE_NAME, 'package.json'), 'utf8'))
      if (!(PLUGIN_PACKAGE_NAME in (profileManifest.dependencies ?? {}))) {
        throw new Error(`profile manifest does not reference ${PLUGIN_PACKAGE_NAME}: ${JSON.stringify(profileManifest.dependencies ?? {})}`)
      }

      const { code, evidence, stdout } = await bootAndQuit(dshBin, home, scratch, bundleManifest.version)
      if (!evidence.sawBanner || !evidence.sawReady) {
        throw new Error(
          `startup incomplete (banner=${String(evidence.sawBanner)}, ready=${String(evidence.sawReady)}, exit code=${String(code)})\n`
          + `captured terminal output:\n${stdout.slice(-2000)}`,
        )
      }
      if (code !== 0) {
        throw new Error(`ctrl-d exit was ${String(code)}, expected 0`)
      }
      process.stdout.write(
        `smoke passed: profile loaded, banner showed ${PLUGIN_PACKAGE_NAME}@${bundleManifest.version},`
        + ` renderer from ${renderer}, ctrl-d exited cleanly\n`,
      )
    }
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  } catch (error) {
    process.stderr.write(`consumer smoke: workspace kept for inspection at ${workspace}\n`)
    throw error
  }
}
