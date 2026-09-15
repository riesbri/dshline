/**
 * The wrapper's first run, checked by running it.
 *
 * Everything here is a real child process: the decision this file exists for —
 * whether to offer to create the profile, and what to launch afterwards — is
 * made from `process.stdin.isTTY`, an exit status, and the presence of one
 * file, none of which a unit test can fake without also faking the thing under
 * test. So the wrapper is spawned, given a stub launcher that records what it
 * was asked to do, and pointed at a `DSH_HOME` in a temporary directory. The
 * user's own harness, profile, and global installs are never touched.
 *
 * The stub launcher stands in for `dsh` and imitates exactly the part of it
 * this wrapper depends on: `plugin ... add` initializes the profile by writing
 * its `package.json`, the way `dsh plugin` does on first use. It is a stub
 * rather than the real launcher because what is under test is which command
 * the wrapper runs and when — the real thing installing real packages is
 * proved separately by `tools/consumer-smoke.mjs --bootstrap`.
 *
 * The questions need a terminal on both ends, so those cases run the wrapper
 * under `script(1)`'s pseudo-terminal and skip themselves where that is not
 * available (Windows, or a machine without it). Everything that does not need
 * a terminal is checked everywhere, including the decision function itself.
 */

import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapPlan, installArguments, quoteForCmd, saidYes, spawnPlan } from '../bin/dshline.mjs'

/** The executable under test, run as a real command line. */
const WRAPPER = fileURLToPath(new URL('../bin/dshline.mjs', import.meta.url))

/** The version the manifest declares, which `--version` must answer with. */
const VERSION = JSON.parse(
  await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version as string

/**
 * The exact `dsh plugin` line the wrapper must ask for when it installs itself.
 *
 * Taken from the wrapper rather than retyped, so every case below asserts the ONE
 * command; what that command has to contain is pinned separately, by name, in
 * `the install the wrapper asks for` — which is what keeps this from asserting
 * only that the wrapper agrees with itself.
 */
const INSTALL = installArguments() as string[]

/** Long enough for a Node child on a loaded CI runner, short enough to fail fast. */
const CHILD_TIMEOUT_MS = 30_000

/** What one stub-launcher invocation recorded about itself. */
interface Invocation {
  /** The arguments the wrapper passed, after the launcher's own prefix. */
  argv: string[]
  /** The folder the launcher ran in. */
  cwd: string
  /** The `DSH_HOME` it inherited, which decides which profile it would touch. */
  home: string | undefined
}

/** One finished wrapper run. */
interface Run {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  /**
   * Both streams together. A pseudo-terminal has one, so a message a piped run
   * finds on stderr arrives on stdout there; what is asserted is that the user
   * saw it.
   */
  output: string
  /** Everything the stub launcher was asked to do, in order. */
  calls: Invocation[]
}

/** A scratch installation: a stub launcher, a `DSH_HOME`, and a folder to run in. */
interface Fixture {
  root: string
  /** The stub launcher, as `$DSH_BIN` would name it. */
  dsh: string
  /**
   * The same stub behind an npm-style `dsh.cmd` batch shim, and the folder that
   * holds it so it can also be found on PATH. What npm actually installs on
   * Windows, and the only thing that can prove the hand-off to one.
   */
  shim: string
  shimDir: string
  /**
   * A folder holding a `pnpm` that exists and does nothing.
   *
   * Every profile mutation needs pnpm, so the default fixture provides one: the
   * wrapper asks PATH rather than running it, so a file is the whole requirement.
   * Cases that need it missing drop this folder from PATH.
   */
  pnpmDir: string
  home: string
  /** Where the profile would live, whether or not it exists. */
  profileDir: string
  /** The file whose presence means "the harness has initialized this profile". */
  manifest: string
  log: string
}

let fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.map(async dir => rm(dir, { recursive: true, force: true })))
  fixtures = []
})

/**
 * A stub launcher, a fresh harness home, and nothing else.
 *
 * The stub is a real executable with a shebang, because that is what the
 * wrapper spawns for `$DSH_BIN` and for a `dsh` on PATH; running it through
 * `node` instead would prove less about the hand-off.
 * @returns the fixture's paths.
 */
async function fixture(): Promise<Fixture> {
  // Through realpath, because the wrapper passes `process.cwd()` — which Node
  // reports resolved — and the system temp directory is a symlink on macOS.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dshline-bootstrap-')))
  fixtures.push(root)
  const home = join(root, 'dsh-home')
  await mkdir(home, { recursive: true })
  const dsh = join(root, 'dsh')
  await writeFile(dsh, STUB_LAUNCHER, 'utf8')
  await chmod(dsh, 0o755)
  // The shim and the module it calls are written everywhere and used on Windows:
  // an npm shim is a batch file that re-invokes its target with `%*`, which is
  // the second `cmd` parse the quoting has to survive.
  const recorder = join(root, 'stub.cjs')
  await writeFile(recorder, STUB_LAUNCHER, 'utf8')
  const shimDir = join(root, 'shim-bin')
  await mkdir(shimDir, { recursive: true })
  const shim = join(shimDir, 'dsh.cmd')
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`, 'utf8')
  const pnpmDir = join(root, 'pnpm-bin')
  await mkdir(pnpmDir, { recursive: true })
  await writeFile(
    join(pnpmDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
    process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
    'utf8',
  )
  return {
    root,
    // On Windows the stub IS the shim: `$DSH_BIN` there names what npm installs,
    // a batch file, so every process case below exercises that hand-off rather
    // than a shape Windows cannot run.
    dsh: process.platform === 'win32' ? shim : dsh,
    shim,
    shimDir,
    pnpmDir,
    home,
    profileDir: join(home, 'profiles', 'dshline'),
    manifest: join(home, 'profiles', 'dshline', 'package.json'),
    log: join(root, 'calls.jsonl'),
  }
}

/**
 * The stub launcher's source.
 *
 * It answers as the harness answers for the two things the wrapper asks of it:
 * `plugin ... add` initializes the profile and then installs, and anything else
 * is a launch.
 *
 * The ORDER is the part that matters and is copied exactly from `dsh plugin`:
 * the profile manifest is written FIRST, before the install runs at all. So a
 * slow stub spends its delay with the manifest already on disk, which is the
 * real state a second launcher can observe — the state that makes "a manifest
 * appeared, so someone must have finished" false. A failing stub leaves the
 * same half-made profile a failed `dsh plugin` leaves behind.
 *
 * A launch waits for a keystroke when asked to, so a test can send `ctrl-c`
 * while the child owns the terminal; it ignores SIGINT for the same reason the
 * real frontend does. The knobs are environment variables, so one file covers a
 * failing install, a killed install, a slow one, and a session that stays open.
 */
const STUB_LAUNCHER = `#!/usr/bin/env node
// CommonJS on purpose: this file has no extension, because that is what an
// installed \`dsh\` looks like, and a file with no extension is CommonJS on
// every Node this package supports.
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const args = process.argv.slice(2)
appendFileSync(process.env.STUB_LOG, JSON.stringify({
  argv: args,
  cwd: process.cwd(),
  home: process.env.DSH_HOME,
}) + '\\n')

if (args[0] === 'plugin') {
  // Initialization first, exactly as dsh plugin does it: the manifest exists
  // from here on, while the install below has not run yet.
  if (process.env.STUB_SETUP_SKIP_INIT !== '1') {
    const dir = join(process.env.DSH_HOME, 'profiles', args[2])
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + args[2] }) + '\\n')
  }
  const finish = () => {
    process.stdout.write('stub: plugin done\\n')
    const signal = process.env.STUB_SETUP_SIGNAL ?? ''
    const code = Number(process.env.STUB_SETUP_CODE ?? '0')
    // A setup that FINISHES records the dependency, which is precisely what a setup
    // that stops never gets to do. Modelling only the manifest write would leave every
    // successful install looking like the half-made profile this file now tests for.
    if (code === 0 && signal === '') {
      const dir = join(process.env.DSH_HOME, 'profiles', args[2])
      const spec = args[args.length - 1].replace(/^@dshline\\/dshline@/, '')
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'dsh-profile-' + args[2], dependencies: { '@dshline/dshline': spec } }) + '\\n',
      )
    }
    if (signal !== '') {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code)
  }
  const delay = Number(process.env.STUB_SETUP_DELAY_MS ?? '0')
  if (delay > 0) setTimeout(finish, delay)
  else finish()
} else if (process.env.STUB_LAUNCH_HOLDS === '1') {
  // A frontend that owns the terminal: ctrl-c is its keystroke to interpret, so
  // it ignores the signal and leaves on its own key.
  process.on('SIGINT', () => process.stdout.write('stub: saw ctrl-c\\n'))
  process.stdout.write('stub: launched\\n')
  process.stdin.resume()
  process.stdin.on('data', (chunk) => {
    if (String(chunk).includes('q')) process.exit(0)
  })
} else {
  process.stdout.write('stub: launched\\n')
}
`

/**
 * The environment one wrapper run gets.
 *
 * Built from nothing rather than from this process's, so a `dsh` on the
 * developer's own PATH cannot answer instead of the stub and the user's real
 * `~/.dsh` is unreachable. `PATH` still carries the Node that runs the stub's
 * shebang.
 * @param fix - the fixture whose paths this run uses.
 * @param overrides - values to add or remove (undefined removes).
 * @returns the environment for `spawn`.
 */
function environment(fix: Fixture, overrides: Record<string, string | undefined> = {}): Record<string, string> {
  // What Windows cannot be denied: `cmd.exe` is named by `%ComSpec%` and lives
  // under `%SystemRoot%`, and a shim resolves nothing without `%PATHEXT%`. An
  // environment built from literally nothing made the wrapper report `could not
  // start` — a fact about this fixture, not about a Windows install.
  const system = process.platform === 'win32'
    ? Object.fromEntries(
      ['ComSpec', 'SystemRoot', 'windir', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
        .map(name => [name, process.env[name]]),
    )
    : {}
  const systemPath = process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
    // The folders `script(1)` and `bash` live in, for the terminal cases.
    : ['/bin', '/usr/bin']
  const base: Record<string, string | undefined> = {
    ...system,
    // Node's own folder first, for the stub's shebang. Deliberately not the
    // developer's PATH: a real `dsh` there could answer instead of the stub.
    PATH: [join(process.execPath, '..'), fix.pnpmDir, ...systemPath].join(delimiter),
    DSH_BIN: fix.dsh,
    DSH_HOME: fix.home,
    STUB_LOG: fix.log,
    ...overrides,
  }
  return Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/**
 * Read what the stub launcher recorded.
 * @param log - the file it recorded into.
 * @returns every invocation, in order; empty when the launcher never ran.
 */
async function calls(log: string): Promise<Invocation[]> {
  if (!existsSync(log)) return []
  const raw = await readFile(log, 'utf8')
  return raw.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Invocation)
}

/**
 * Run the wrapper with no terminal on either end.
 * @param fix - the fixture.
 * @param args - the wrapper's arguments.
 * @param options - `env` overrides and the folder to run from.
 * @returns the finished run.
 */
async function runWrapper(
  fix: Fixture,
  args: readonly string[],
  options: RunOptions = {},
): Promise<Run> {
  const log = options.log ?? fix.log
  const child = spawn(process.execPath, [WRAPPER, ...args], {
    env: environment(fix, { STUB_LOG: log, ...options.env ?? {} }),
    cwd: options.cwd ?? fix.root,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // Closed at once: a piped stdin that stays open is still not a terminal, and
  // this is the shape a script or a CI job has.
  child.stdin.end()
  return finish(child, log)
}

/** How to run the wrapper once. */
interface RunOptions {
  env?: Record<string, string | undefined>
  cwd?: string
  /**
   * Where the stub launcher records its invocations. Its own file per run
   * wherever two runs overlap, so one process's calls are never read as
   * another's.
   */
  log?: string
}

/**
 * Collect a child's output and exit, then read the launcher log.
 * @param child - the spawned wrapper.
 * @param log - the file the stub launcher recorded into.
 * @returns the finished run.
 */
function finish(child: ReturnType<typeof spawn>, log: string): Promise<Run> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`the wrapper did not exit within ${String(CHILD_TIMEOUT_MS)}ms\n${stdout}\n${stderr}`))
    }, CHILD_TIMEOUT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      void calls(log).then(recorded => resolvePromise({
        code,
        signal,
        stdout,
        stderr,
        output: `${stdout}${stderr}`,
        calls: recorded,
      }))
    })
  })
}

/**
 * Wait for something a child has already been asked to do.
 * @param ready - the condition to poll.
 * @returns nothing, once the condition holds.
 */
async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('the child never got that far')
    await new Promise(settle => setTimeout(settle, 20))
  }
}

/** The marker the confirmation ends with, matched with whitespace removed. */
const QUESTION = 'Set it up now?'

/** One thing to type once something has appeared on the terminal. */
interface Reply {
  /** Text to wait for, compared with all whitespace removed. */
  after: string
  /** What to send when it appears. */
  send: string
  /** Something to do before sending, for the races below. */
  before?: () => Promise<void>
}

/** `ctrl-c`, as the terminal delivers it. */
const CTRL_C = String.fromCharCode(3)

/**
 * Run the wrapper with a real pseudo-terminal on both ends.
 *
 * `script(1)` is the only pty this repository can use — no dependency provides
 * one, and the check is worthless without a real terminal, since that is the
 * fact the wrapper reads. The two invocations differ because the two
 * implementations do: util-linux takes the command as one string after `-qec`,
 * BSD's takes it as arguments and refuses a stdin that is not a pipe, which is
 * what the process substitution supplies (Node's own piped stdin is a socket).
 * @param fix - the fixture.
 * @param args - the wrapper's arguments.
 * @param replies - what to type, and what to wait for first.
 * @param options - `env` overrides and the folder to run from.
 * @returns the finished run.
 */
async function runOnTerminal(
  fix: Fixture,
  args: readonly string[],
  replies: readonly Reply[],
  options: RunOptions = {},
): Promise<Run> {
  const log = options.log ?? fix.log
  const inner = [process.execPath, WRAPPER, ...args].map(part => `'${part.replace(/'/gu, `'\\''`)}'`).join(' ')
  const line = process.platform === 'linux'
    ? `exec script -qec ${JSON.stringify(inner)} /dev/null`
    : `exec script -q /dev/null ${inner} < <(cat)`
  const child = spawn('bash', ['-c', line], {
    env: { ...environment(fix, { STUB_LOG: log, ...options.env ?? {} }), TERM: 'xterm-256color' },
    cwd: options.cwd ?? fix.root,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let seen = ''
  let next = 0
  child.stdout?.on('data', chunk => {
    seen += String(chunk)
    const flat = seen.replace(/\s+/gu, '')
    const reply = replies[next]
    if (reply === undefined) return
    if (!flat.includes(reply.after.replace(/\s+/gu, ''))) return
    next += 1
    void (reply.before?.() ?? Promise.resolve()).then(() => child.stdin?.write(reply.send))
  })
  return finish(child, log)
}

/** Whether a pseudo-terminal is available here, probed once. */
let terminalAvailable: Promise<boolean> | undefined

/**
 * Whether the pty cases can run.
 *
 * Probed by running something through the same command line they use, rather
 * than inferred from the platform: a container without util-linux `script`
 * would otherwise fail every one of them for a reason that is not a bug.
 * @returns whether a pseudo-terminal was obtained.
 */
async function hasTerminal(): Promise<boolean> {
  terminalAvailable ??= (async () => {
    const probe = "process.stdout.write(process.stdin.isTTY === true && process.stdout.isTTY === true ? 'tty' : 'no')"
    const inner = [process.execPath, '-e', probe].map(part => `'${part.replace(/'/gu, `'\\''`)}'`).join(' ')
    const line = process.platform === 'linux'
      ? `exec script -qec ${JSON.stringify(inner)} /dev/null`
      : `exec script -q /dev/null ${inner} < <(cat)`
    return new Promise<boolean>(resolvePromise => {
      const child = spawn('bash', ['-c', line], { stdio: ['pipe', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.on('data', chunk => { out += String(chunk) })
      child.on('error', () => resolvePromise(false))
      child.on('exit', () => resolvePromise(out.includes('tty')))
    })
  })()
  return terminalAvailable
}

/**
 * Skip one pty case where no pty exists, rather than failing it.
 * @param name - the case name.
 * @param body - the case, given a fresh fixture.
 */
function terminalCase(name: string, body: (fix: Fixture) => Promise<void>): void {
  it(name, async context => {
    if (!await hasTerminal()) {
      context.skip()
      return
    }
    await body(await fixture())
  }, CHILD_TIMEOUT_MS + 10_000)
}

/** Where `cmd.exe` lives, for a PATH a Windows case builds itself. */
function systemFolder(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
}

/** The arguments the wrapper adds for an ordinary launch from `cwd`. */
function launchArgs(cwd: string, rest: readonly string[] = []): string[] {
  return ['--profile', 'dshline', '--cwd', cwd, ...rest]
}

/**
 * Mark a profile as set up, the way a finished install leaves it.
 *
 * The recorded spec is this wrapper's own version, because that is what `dshline
 * --setup` installs and what the version check compares against. A fixture writing
 * some other version would be describing a skewed profile, which is a different case
 * with its own tests below.
 */
async function initializeProfile(fix: Fixture): Promise<void> {
  await initializeProfileRecording(fix, VERSION)
}

/**
 * Mark a profile as recording a given dependency spec.
 * @param fix - the fixture.
 * @param spec - the spec to record against this package.
 */
async function initializeProfileRecording(fix: Fixture, spec: string): Promise<void> {
  await mkdir(fix.profileDir, { recursive: true })
  await writeFile(
    fix.manifest,
    `${JSON.stringify({ name: 'dsh-profile-dshline', dependencies: { '@dshline/dshline': spec } })}\n`,
    'utf8',
  )
}

/**
 * Mark a profile as one a failed setup left behind.
 *
 * The exact state the QA run found: `dsh plugin` writes the manifest before it
 * installs anything, so a setup that stops — no pnpm, a package it could not fetch —
 * leaves a profile that exists and holds nothing at all.
 * @param fix - the fixture.
 */
async function initializeEmptyProfile(fix: Fixture): Promise<void> {
  await mkdir(fix.profileDir, { recursive: true })
  await writeFile(fix.manifest, `${JSON.stringify({ name: 'dsh-profile-dshline', dependencies: {} })}\n`, 'utf8')
}

describe('the bootstrap decision', () => {
  /**
   * The plan for one profile state.
   * @param state - what `profileState` found.
   * @param options - the arguments and terminal this invocation has.
   * @returns the plan.
   */
  function plan(
    state: Record<string, unknown>,
    options: { args?: string[], interactive?: boolean, wrapperVersion?: string } = {},
  ): string {
    return bootstrapPlan({
      args: options.args ?? [],
      // The wrapper is plain JavaScript, so this import carries no type for the
      // state union; the shapes below are the four `profileState` returns.
      state: state as never,
      wrapperVersion: options.wrapperVersion ?? VERSION,
      interactive: options.interactive ?? true,
    }) as string
  }

  it('launches a profile that records this same release', () => {
    // The invariant `dshline --setup` establishes: it installs this wrapper's exact
    // version, so the two agreeing is the ordinary case and must stay silent.
    for (const spec of [VERSION, `^${VERSION}`, `~${VERSION}`]) {
      expect(plan({ kind: 'registry', spec, version: VERSION }), spec).toBe('launch')
    }
  })

  it('offers setup for an absent profile with a terminal', () => {
    expect(plan({ kind: 'absent' })).toBe('confirm')
  })

  it('refuses to install anything without a terminal to ask on', () => {
    // Not a silent install: the mutation reaches the network through pnpm, and
    // a scripted launch never agreed to one.
    expect(plan({ kind: 'absent' }, { interactive: false })).toBe('no-terminal')
  })

  it('reports a profile a failed setup left behind, and launches nothing into it', () => {
    // The QA state, and the one that produced a blank terminal: the manifest exists,
    // so the old wrapper read the profile as initialized and handed over to a
    // frontend that had never been installed. A terminal must not change the answer —
    // the repair is asked about by the caller, not decided by this function.
    expect(plan({ kind: 'incomplete' })).toBe('incomplete')
    expect(plan({ kind: 'incomplete' }, { interactive: false })).toBe('incomplete')
  })

  it('reports a profile recording a different release, and launches nothing into it', () => {
    // The other QA state: `npm i -g @dshline/dshline@latest` moved the wrapper to
    // 0.22.0 while the profile still had 0.20.0, and the launch died with
    // `cannot get property "agent" without inject`.
    for (const older of ['0.0.1', '0.20.0']) {
      expect(plan({ kind: 'registry', spec: older, version: older }), older).toBe('skew')
      expect(plan({ kind: 'registry', spec: older, version: older }, { interactive: false }), older).toBe('skew')
    }
  })

  it('does not call an unparsable registry spec a mismatch', () => {
    // A tag or a wildcard names no release, so there is nothing to compare, and an
    // unprovable mismatch is not worth refusing to start over.
    for (const spec of ['latest', '*', 'next']) {
      expect(plan({ kind: 'registry', spec }), spec).toBe('launch')
    }
  })

  it('leaves a checkout spec alone, however it differs from this release', () => {
    // Source-checkout development is a supported mode. The recorded spec is a folder
    // rather than a release, so there is nothing for it to be out of step WITH — and
    // subjecting it to npm-version equality would break the mode outright.
    const specs = [
      './packages/dshline',
      '../dshline/packages/dshline',
      '/srv/dshline/packages/dshline',
      'file:../dshline',
      'link:../dshline',
      'workspace:*',
      'github:riesbri/dshline',
    ]
    for (const spec of specs) {
      expect(plan({ kind: 'local', spec }), spec).toBe('launch')
      expect(plan({ kind: 'local', spec }, { interactive: false }), spec).toBe('launch')
    }
  })

  it('stands aside entirely when the caller chose a profile', () => {
    // Ownership, not string equality: `--profile dshline` is someone using
    // harness profile semantics directly, so the wrapper's own lifecycle
    // behaviour is off — including for the profile it would have picked. That is
    // also the documented way past either diagnostic.
    const states: Record<string, unknown>[] = [
      { kind: 'absent' },
      { kind: 'incomplete' },
      { kind: 'registry', spec: '0.0.1', version: '0.0.1' },
    ]
    for (const args of [['--profile', 'other'], ['--profile=other'], ['--profile', 'dshline'], ['--profile=dshline']]) {
      for (const state of states) {
        const label = `${args.join(' ')} ${String(state.kind)}`
        expect(plan(state, { args }), label).toBe('launch')
        expect(plan(state, { args, interactive: false }), label).toBe('launch')
      }
    }
  })

  it('reads a profile choice wherever it appears, including after a task', () => {
    expect(plan({ kind: 'absent' }, { args: ['run the tests', '--profile', 'other'], interactive: false })).toBe('launch')
  })
})

describe('the answer to a default-yes question', () => {
  it('takes enter, y, and yes', () => {
    for (const answer of ['', ' ', 'y', 'Y', ' y ', 'yes', 'YES']) expect(saidYes(answer), answer).toBe(true)
  })

  it('takes anything else as no, cancellation included', () => {
    for (const answer of ['n', 'N', 'no', 'nope', 'later', 'q']) expect(saidYes(answer), answer).toBe(false)
    expect(saidYes(undefined)).toBe(false)
  })
})

describe('the install the wrapper asks for', () => {
  // The failure this pins down, exactly as it happened: a 0.16.0 wrapper asked
  // for a bare `@dshline/dshline`, pnpm 11 applied its own built-in release-age
  // default, npm's `latest` had moved to 0.16.0 hours earlier, and pnpm quietly
  // settled for the newest version old enough to pass — 0.15.0. The wrapper then
  // booted a frontend a release behind itself, against a harness generation that
  // release had never seen. Both halves of the answer are asserted by name here,
  // so the cases that compare against INSTALL are not just agreeing with it.

  it('names this wrapper\'s own exact version', () => {
    expect(INSTALL).toContain(`@dshline/dshline@${VERSION}`)
  })

  it('never asks for the bare package name, which is what allowed the downgrade', () => {
    expect(INSTALL).not.toContain('@dshline/dshline')
    expect(INSTALL.filter(argument => argument.startsWith('@dshline/'))).toHaveLength(1)
  })

  it('carries dshline\'s release-age window on the command line', () => {
    // On the command line and not in a file, because the file it would have to
    // be written to is the harness's profile `pnpm-workspace.yaml`.
    expect(INSTALL).toContain('--config.minimum-release-age=120')
  })

  it('is still a `dsh plugin add` into dshline\'s own profile', () => {
    expect(INSTALL.slice(0, 4)).toEqual(['plugin', '--profile', 'dshline', 'add'])
  })

  it('puts the window ahead of the spec, where `dsh plugin` forwards both to pnpm', () => {
    // `dsh plugin` hands everything after its own `--profile <name>` to pnpm
    // verbatim, and its parser starts the pass-through run at the first argument
    // it does not recognize. The spec has to follow the flag, not precede it.
    expect(INSTALL.indexOf('--config.minimum-release-age=120'))
      .toBeLessThan(INSTALL.indexOf(`@dshline/dshline@${VERSION}`))
  })
})

describe('spawning the launcher', () => {
  const launcher = { command: '/usr/local/bin/dsh', prefix: [], describe: 'test' }

  it('passes argv through unchanged where no shell is involved', () => {
    const plan = spawnPlan(launcher, ['--profile', 'dshline', 'run the tests'], 'linux')
    expect(plan).toEqual({
      command: '/usr/local/bin/dsh',
      argv: ['--profile', 'dshline', 'run the tests'],
      verbatim: false,
    })
  })

  it('keeps a source checkout\'s own prefix in front of the arguments', () => {
    const checkout = { command: 'node', prefix: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'], describe: 'test' }
    expect(spawnPlan(checkout, ['plugin'], 'linux').argv).toEqual(['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'plugin'])
  })

  it('runs a Windows npm shim through cmd.exe, because a batch file is not an executable', () => {
    // What npm installs on Windows is `dsh.cmd`; spawn has refused to run one
    // directly since the CVE-2024-27980 hardening, so this one case needs the
    // interpreter that can — and Node must not requote what is already quoted.
    const plan = spawnPlan({ command: 'C:\\npm\\dsh.cmd', prefix: [], describe: 'test' }, ['--profile', 'dshline'], 'win32')
    expect(plan.command.toLowerCase()).toContain('cmd')
    expect(plan.argv.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(plan.verbatim).toBe(true)
    expect(plan.argv[3]).toContain('dsh.cmd')
  })

  it('carries the release-age flag and the versioned spec through cmd.exe intact', () => {
    // The two new arguments cross the Windows shim path, where every argument is
    // rewritten for `cmd`: `=`, `@`, `.` and `/` must all arrive as data, or the
    // first run installs something other than what this wrapper asked for.
    const plan = spawnPlan({ command: 'C:\\npm\\dsh.cmd', prefix: [], describe: 'test' }, INSTALL, 'win32')
    expect(plan.verbatim).toBe(true)
    const line = plan.argv[3] ?? ''
    for (const argument of INSTALL) expect(line, argument).toContain(argument)
    // And nothing inside them needed escaping: `=`, `@`, `.`, `/` and `-` are
    // all data to `cmd`, so quoting adds the wrapping and leaves the payload
    // character for character.
    for (const argument of ['--config.minimum-release-age=120', `@dshline/dshline@${VERSION}`]) {
      expect(quoteForCmd(argument), argument).toBe(`^^^"${argument}^^^"`)
    }
  })

  it('leaves a real Windows executable alone', () => {
    const plan = spawnPlan({ command: 'C:\\node\\node.exe', prefix: ['cli.js'], describe: 'test' }, ['x'], 'win32')
    expect(plan).toEqual({ command: 'C:\\node\\node.exe', argv: ['cli.js', 'x'], verbatim: false })
  })

  it('keeps one argument one argument, however it is spelled', () => {
    // Arguments stay argv, never shell syntax: a first task is one word to the
    // launcher whether it contains spaces, quotes, or characters cmd would
    // otherwise read as its own. What that quoting actually delivers is proved
    // on Windows itself, by the job that records the argv a shim received.
    const plan = spawnPlan({ command: 'dsh.cmd', prefix: [], describe: 'test' }, ['run the "tests" & stop'], 'win32')
    const line = plan.argv[3] ?? ''
    expect(line).toContain(quoteForCmd('run the "tests" & stop'))
    // Escaped twice, because a shim is a batch file that re-invokes its target
    // with `%*` and the same line is parsed by cmd a second time.
    expect(quoteForCmd('a & b')).toBe('^^^"a^^^ ^^^&^^^ b^^^"')
    expect(quoteForCmd('a & b', false)).toBe('^"a^ ^&^ b^"')
    // One `cmd` parse only, for comparison with the double-escaped form above.
    expect(quoteForCmd('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"')
    // The whole command line is wrapped for `/s`, which strips exactly those
    // outer quotes and takes the rest verbatim.
    expect(line.startsWith('"')).toBe(true)
    expect(line.endsWith('"')).toBe(true)
  })

  it('doubles every backslash before a quote, not just the last one', () => {
    // The shape the Windows job caught: with an even run of backslashes reaching
    // the program, `CommandLineToArgvW` reads the quote as a quote and drops it,
    // so `a\\"b` arrived as `a\\b`. Pinned here as well so the regression is
    // visible on any platform, in one line rather than a whole Windows run.
    const doubled = quoteForCmd(`a${'\\'.repeat(2)}"b`, false)
    expect(doubled).toBe(`^"a${'\\'.repeat(5)}^"b^"`)
    // Odd runs stay odd, which is what makes the quote literal.
    expect(quoteForCmd('a\\"b', false)).toBe(`^"a${'\\'.repeat(3)}^"b^"`)
  })

  it('refuses a line break through a shim rather than letting cmd read it as syntax', () => {
    // A cmd command line has no representation for a newline inside an
    // argument: the character ends the command. Refusing is the one honest
    // answer; every other platform, and a real executable on Windows, take the
    // argument as it is.
    const shim = { command: 'C:\\npm\\dsh.cmd', prefix: [], describe: 'test' }
    expect(spawnPlan(shim, ['first\nsecond'], 'win32').refuse).toContain('line break')
    expect(spawnPlan(shim, ['first\rsecond'], 'win32').refuse).toContain('line break')
    expect(spawnPlan({ command: 'dsh.exe', prefix: [], describe: 'test' }, ['first\nsecond'], 'win32').refuse).toBeUndefined()
    expect(spawnPlan({ command: 'dsh', prefix: [], describe: 'test' }, ['first\nsecond'], 'linux')).toEqual({
      command: 'dsh',
      argv: ['first\nsecond'],
      verbatim: false,
    })
  })
})

describe('an initialized profile', () => {
  it('launches, adding the profile and the folder and nothing else', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root))
  })

  it('keeps a first task, a resume, and a folder exactly as given', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    for (const rest of [
      ['run the tests'],
      ['--resume'],
      ['--resume', 'abc123'],
      ['--resume', 'abc123', 'and then stop'],
    ]) {
      await rm(fix.log, { force: true })
      const run = await runWrapper(fix, rest, { cwd: fix.root })
      expect(run.code, rest.join(' ')).toBe(0)
      expect(run.calls[0]?.argv, rest.join(' ')).toEqual(launchArgs(fix.root, rest))
    }
  })

  it('leaves an explicit folder alone rather than adding its own', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    for (const rest of [['-C', '/tmp'], ['--cwd', '/tmp'], ['--cwd=/tmp']]) {
      await rm(fix.log, { force: true })
      const run = await runWrapper(fix, rest, { cwd: fix.root })
      expect(run.calls[0]?.argv, rest.join(' ')).toEqual(['--profile', 'dshline', ...rest])
    }
  })

  it('is never silently repaired, however broken it is', async () => {
    // A profile recording this package at this release launches, whatever else is
    // wrong with it: no node_modules, a bundle list that resolves to nothing. Those
    // stay the harness's to diagnose, and a reinstall here would hide the diagnosis
    // behind a package operation nobody asked for. What this wrapper answers for is
    // the one fact it can see — whether its OWN package is in its OWN profile at its
    // OWN release — and a profile that disagrees is a different case, below.
    const fix = await fixture()
    await initializeProfile(fix)
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.calls.map(call => call.argv[0])).toEqual(['--profile'])
    expect(run.calls.some(call => call.argv.includes('plugin'))).toBe(false)
  })
})

describe('a profile a failed setup left behind', () => {
  it('is reported by cause, and nothing is launched into it', async () => {
    // The QA state, and the failure this block exists for. `dsh plugin` writes the
    // manifest BEFORE it installs anything, so a setup that stopped — no pnpm, a
    // package it could not fetch — leaves a profile that exists and holds nothing.
    // The harness never gets far enough to complain about it, so a launch used to
    // open a blank terminal and wait there: no message, no exit, no way out.
    const fix = await fixture()
    await initializeEmptyProfile(fix)
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('half set up')
    expect(run.stderr).toContain('dshline --setup')
    expect(run.calls).toEqual([])
  })

  it('is a different sentence from a version mismatch', async () => {
    // Two causes, two messages. Reporting an empty profile as a version mismatch
    // would send the reader looking for a release that was never installed.
    const fix = await fixture()
    await initializeEmptyProfile(fix)
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.stderr).toContain('half set up')
    expect(run.stderr).not.toContain('profile has')
    expect(run.stderr).not.toContain(VERSION)
  })

  it('names the explicit profile as the way to drive it anyway', async () => {
    // The escape hatch, and it is the ownership rule that already existed rather than
    // anything new: naming a profile is a decision to use harness profiles directly.
    const fix = await fixture()
    await initializeEmptyProfile(fix)
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.stderr).toContain('dshline --profile dshline')
  })

  terminalCase('offers to finish it, and finishes it when told yes', async fix => {
    // A dead end turned back into the first-run path the user already knows. Asked
    // rather than done, because the repair is a package install into a profile that
    // already exists.
    await initializeEmptyProfile(fix)
    const run = await runOnTerminal(fix, [], [{ after: 'Set it up now?', send: 'y\n' }], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls.map(call => call.argv)).toEqual([INSTALL, launchArgs(fix.root)])
  })

  terminalCase('changes nothing when the repair is declined', async fix => {
    await initializeEmptyProfile(fix)
    const run = await runOnTerminal(fix, [], [{ after: 'Set it up now?', send: 'n\n' }], { cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.calls).toEqual([])
    expect(run.stdout).toContain('dshline --setup')
  })
})

describe('a profile recording a different release', () => {
  it('is reported by cause, and nothing is launched into it', async () => {
    // The upgrade the QA run followed, and the crash it produced:
    // `npm i -g @dshline/dshline@latest` moved the wrapper to a new release while the
    // profile still held the old one, and the launch died inside the harness with
    // `cannot get property "agent" without inject` — an error about Cordis internals
    // rather than about the two versions that disagreed.
    const fix = await fixture()
    await initializeProfileRecording(fix, '0.0.1')
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('0.0.1')
    expect(run.stderr).toContain(VERSION)
    expect(run.stderr).toContain('dshline --setup')
    expect(run.calls).toEqual([])
  })

  it('launches when the recorded spec names this release behind a range', async () => {
    for (const spec of [VERSION, `^${VERSION}`, `~${VERSION}`]) {
      const fix = await fixture()
      await initializeProfileRecording(fix, spec)
      const run = await runWrapper(fix, [], { cwd: fix.root })
      expect(run.code, spec).toBe(0)
      expect(run.calls[0]?.argv, spec).toEqual(launchArgs(fix.root))
    }
  })

  it('leaves a profile installed from a checkout alone, however it differs', async () => {
    // The mode this must never break. A recorded path is not a release, so there is
    // nothing for it to be out of step with, and subjecting it to npm-version equality
    // would make source-checkout development unusable.
    for (const spec of ['./packages/dshline', '../dshline/packages/dshline', 'file:../dshline', 'link:../dshline']) {
      const fix = await fixture()
      await initializeProfileRecording(fix, spec)
      const run = await runWrapper(fix, [], { cwd: fix.root })
      expect(run.code, spec).toBe(0)
      expect(run.calls[0]?.argv, spec).toEqual(launchArgs(fix.root))
    }
  })

  terminalCase('offers to reconcile it, and does when told yes', async fix => {
    await initializeProfileRecording(fix, '0.0.1')
    const run = await runOnTerminal(fix, [], [{ after: 'Reconcile it now?', send: 'y\n' }], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls.map(call => call.argv)).toEqual([INSTALL, launchArgs(fix.root)])
  })
})

describe('the pnpm prerequisite', () => {
  /**
   * A PATH that resolves no pnpm at all.
   *
   * Only the system folders: deliberately not the folder Node lives in, because some
   * installs (nvm on Windows, for one) put a global `pnpm` beside `node`, and a PATH
   * built from `process.execPath`'s directory would find it and prove nothing. Nothing
   * is spawned in the cases that use this, so a PATH without node is still faithful.
   * @returns the PATH value.
   */
  function noPnpmPath(): string {
    return (process.platform === 'win32' ? [systemFolder()] : ['/bin', '/usr/bin']).join(delimiter)
  }

  it('is checked before --setup can create anything', async () => {
    // What the QA run hit: setup ran, the harness created the profile, and only then
    // did the machine say `'pnpm' is not recognized`. The profile was left half made
    // and the next launch hung on it. Nothing here may create anything at all.
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup'], { env: { PATH: noPnpmPath() }, cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('pnpm is not available')
    expect(run.stderr).toContain('npm install -g pnpm')
    expect(run.stderr).toContain('Nothing has been changed')
    // A package install has no declared pnpm of its own, so corepack is not the
    // remedy here and must not be offered as one.
    expect(run.stderr).not.toContain('corepack')
    expect(existsSync(fix.profileDir)).toBe(false)
    expect(run.calls).toEqual([])
  })

  it('is not reached by a scripted first run, which is refused before it', async () => {
    // With no terminal there is no question to ask, so setup is never offered: the
    // answer is `dshline --setup`, which then meets the check above. Nothing is created
    // on either path, which is the property that matters.
    const fix = await fixture()
    const run = await runWrapper(fix, [], { env: { PATH: noPnpmPath() }, cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('is not set up')
    expect(run.calls).toEqual([])
    expect(existsSync(fix.profileDir)).toBe(false)
  })

  terminalCase('is checked before the first-run question is even asked', async fix => {
    // Agreeing to a setup that cannot run is how the half-made profile happened, so
    // the check belongs before the question rather than after the answer.
    const run = await runOnTerminal(fix, [], [], { env: { PATH: noPnpmPath() }, cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.output).toContain('pnpm is not available')
    expect(run.output).not.toContain('Set it up now?')
    expect(run.calls).toEqual([])
    expect(existsSync(fix.profileDir)).toBe(false)
  })

  it('names corepack for a harness checkout, which declares its own pnpm', async () => {
    // A checkout is not an npm-global install: it declares its own pnpm in
    // `packageManager`, so the remedy that keeps that version is corepack rather than
    // a second global one.
    const fix = await fixture()
    const checkout = join(fix.root, 'harness')
    await mkdir(checkout, { recursive: true })
    await writeFile(join(checkout, 'launch.cjs'), STUB_LAUNCHER, 'utf8')
    await writeFile(
      join(checkout, 'package.json'),
      `${JSON.stringify({ name: 'harness', packageManager: 'pnpm@11.7.0', scripts: { dsh: `"${process.execPath}" launch.cjs` } })}\n`,
      'utf8',
    )
    const run = await runWrapper(fix, ['--setup'], {
      env: { DSH_BIN: undefined, DSH_HARNESS: checkout, PATH: noPnpmPath() },
      cwd: fix.root,
    })
    expect(run.code).toBe(1)
    // corepack first, because the checkout declares the pnpm version it wants; a
    // second global install is the fallback rather than the recommendation.
    expect(run.stderr).toContain('corepack')
    expect(run.stderr.indexOf('corepack')).toBeLessThan(run.stderr.indexOf('npm install -g pnpm'))
    expect(run.calls).toEqual([])
  })

  it('proceeds once pnpm is available', async () => {
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup'], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls.map(call => call.argv)).toEqual([INSTALL])
    expect(existsSync(fix.manifest)).toBe(true)
  })
})

describe('--help', () => {
  it('answers with no harness, no profile, and no terminal', async () => {
    // Wrapper-owned, like --version, and for the same reason: the person working out
    // why an installation will not start is exactly the person who cannot get a
    // profile to exist first.
    const fix = await fixture()
    for (const flag of ['--help', '-h']) {
      const run = await runWrapper(fix, [flag], { env: { DSH_BIN: undefined, PATH: '' } })
      expect(run.code, flag).toBe(0)
      expect(run.stdout, flag).toContain('--setup')
      expect(run.stdout, flag).toContain('--version')
      expect(run.calls, flag).toEqual([])
    }
    expect(existsSync(fix.profileDir)).toBe(false)
  })

  it('names dshline rather than the harness invocation it forwards to', async () => {
    // The harness reports its own usage as `dsh --profile dshline`, and repeating that
    // as the primary program name tells the reader to run a command they did not type.
    const fix = await fixture()
    const run = await runWrapper(fix, ['--help'], { env: { DSH_BIN: undefined, PATH: '' } })
    expect(run.stdout).toContain('Usage:')
    expect(run.stdout).toContain('dshline [harness options]')
    expect(run.stdout).not.toContain('Usage: dsh --profile dshline')
  })

  it('carries the diagnostics command the documentation has to agree with', async () => {
    // One canonical answer for the profile dump, and it is the harness's own option
    // reached through the harness — not a second wrapper flag that would have to be
    // maintained beside it.
    const fix = await fixture()
    const run = await runWrapper(fix, ['--help'], { env: { DSH_BIN: undefined, PATH: '' } })
    expect(run.stdout).toContain('dsh --profile dshline --dump-config')
  })

  it('still works with a half-made profile, which is when it is needed most', async () => {
    const fix = await fixture()
    await initializeEmptyProfile(fix)
    const run = await runWrapper(fix, ['--help'], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('--setup')
    expect(run.calls).toEqual([])
  })

  it('is forwarded when something precedes it, because only the first argument is ours', async () => {
    // The same rule --version follows. A caller who put a task first is asking the
    // harness for help, not this wrapper.
    const fix = await fixture()
    await initializeProfile(fix)
    const run = await runWrapper(fix, ['run the tests', '--help'], { cwd: fix.root })
    expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root, ['run the tests', '--help']))
  })
})

describe('an uninitialized profile, with nobody to ask', () => {
  it('says how to set it up and mutates nothing', async () => {
    const fix = await fixture()
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('dshline --setup')
    expect(run.calls).toEqual([])
    expect(existsSync(fix.profileDir)).toBe(false)
  })

  it('counts a directory with no manifest as uninitialized', async () => {
    // The state an interrupted first install leaves behind. `dsh plugin`
    // decides the same way, so a wrapper that asked whether the folder existed
    // would refuse setup for a profile the harness considers uninitialized.
    const fix = await fixture()
    await mkdir(fix.profileDir, { recursive: true })
    const run = await runWrapper(fix, [], { cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('is not set up')
  })

  it('still launches when the caller chose a profile explicitly', async () => {
    // The old wrapper checked its own profile whatever was asked for, so
    // `dshline --profile other` refused to start on a machine that had never
    // used the dshline profile.
    const fix = await fixture()
    for (const chosen of [['--profile', 'other'], ['--profile=other'], ['--profile', 'dshline'], ['--profile=dshline']]) {
      await rm(fix.log, { force: true })
      const run = await runWrapper(fix, chosen, { cwd: fix.root })
      expect(run.code, chosen.join(' ')).toBe(0)
      expect(run.calls, chosen.join(' ')).toHaveLength(1)
      expect(run.calls[0]?.argv, chosen.join(' ')).toEqual(['--cwd', fix.root, ...chosen])
      expect(existsSync(fix.profileDir), chosen.join(' ')).toBe(false)
    }
  })
})

describe('the explicit --setup', () => {
  it('installs and stops there, with no terminal needed', async () => {
    // The user named the mutation, which is what makes this the scriptable
    // path and the answer to a first run that went wrong.
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup'], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]?.argv).toEqual(INSTALL)
    expect(existsSync(fix.manifest)).toBe(true)
  })

  it('passes a source through, so a checkout can be installed instead', async () => {
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup', './packages/dshline'], { cwd: fix.root })
    expect(run.calls[0]?.argv).toEqual(['plugin', '--profile', 'dshline', 'add', './packages/dshline'])
  })

  it('reports a release-age refusal as a failed setup, with nothing installed', async () => {
    // The scriptable path meets the same window. pnpm's own exit status is what
    // the caller sees, so a script can tell "too young" from "no such version".
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup'], { env: { STUB_SETUP_CODE: '1' } })
    expect(run.code).toBe(1)
    expect(run.calls.map(call => call.argv)).toEqual([INSTALL])
  })

  it('leaves with the launcher\'s own status when the install fails', async () => {
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup'], { env: { STUB_SETUP_CODE: '7' } })
    expect(run.code).toBe(7)
  })

  // POSIX only: Node simulates every signal on Windows as an abrupt
  // termination, so there is no signalled child there to report.
  it.skipIf(process.platform === 'win32')('dies of the signal that killed the install, rather than reporting success', async () => {
    const fix = await fixture()
    const run = await runWrapper(fix, ['--setup'], { env: { STUB_SETUP_SIGNAL: 'SIGTERM' } })
    expect(run.signal).toBe('SIGTERM')
    expect(run.code).toBeNull()
  })
})

describe('however the command was reached', () => {
  // POSIX only: creating a symlink on Windows needs a privilege CI does not
  // grant, and what npm puts on the PATH there is the `.cmd` shim the Windows
  // block below covers.
  it.skipIf(process.platform === 'win32')('runs when it was reached through a symlink, which is how npm installs it', async () => {
    // The failure this exists for: `argv[1]` is the link on the PATH while
    // `import.meta.url` names the file it points at, so a wrapper that compared
    // the two as strings did nothing at all and exited zero — invisible in a
    // checkout, where no link is involved, and total in every global install.
    const fix = await fixture()
    await initializeProfile(fix)
    const link = join(fix.root, 'dshline-link')
    await symlink(WRAPPER, link)
    const child = spawn(process.execPath, [link], {
      env: environment(fix),
      cwd: fix.root,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end()
    const run = await finish(child, fix.log)
    expect(run.code).toBe(0)
    expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root))
  })
})

describe('--version', () => {
  it('answers with no harness, no profile, and no terminal', async () => {
    // What a bug report asks for, on a machine where the rest of the setup is
    // what is broken.
    const fix = await fixture()
    for (const flag of ['--version', '-V']) {
      const run = await runWrapper(fix, [flag], { env: { DSH_BIN: undefined, PATH: '' } })
      expect(run.code, flag).toBe(0)
      expect(run.stdout.trim(), flag).toBe(VERSION)
      expect(run.calls, flag).toEqual([])
    }
    expect(existsSync(fix.profileDir)).toBe(false)
  })
})

describe('finding the launcher', () => {
  it('prefers an explicit DSH_BIN to a dsh on PATH', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    const other = join(fix.root, 'path-bin')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'dsh'), '#!/bin/sh\nexit 3\n', 'utf8')
    await chmod(join(other, 'dsh'), 0o755)
    const run = await runWrapper(fix, [], { env: { PATH: `${other}:${join(process.execPath, '..')}` } })
    expect(run.code).toBe(0)
    expect(run.calls).toHaveLength(1)
  })

  it('runs a DSH_HARNESS checkout\'s own script, from the checkout', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    const checkout = join(fix.root, 'harness')
    await mkdir(checkout, { recursive: true })
    await writeFile(join(checkout, 'launch.cjs'), STUB_LAUNCHER, 'utf8')
    // Quoted, because a command line is what a shell would read and this program path
    // contains a space on Windows (`C:\Program Files\nodejs`, or an nvm install under
    // a folder with one). An unquoted run of tokens naming one file is genuinely
    // ambiguous, which is why the wrapper honors quotes rather than guessing.
    await writeFile(
      join(checkout, 'package.json'),
      `${JSON.stringify({ name: 'harness', scripts: { dsh: `"${process.execPath}" launch.cjs` } })}\n`,
      'utf8',
    )
    const run = await runWrapper(fix, [], { env: { DSH_BIN: undefined, DSH_HARNESS: checkout }, cwd: fix.root })
    expect(run.code).toBe(0)
    // The checkout is the child's folder, which is why the session's own folder
    // travels as an argument instead.
    expect(run.calls[0]?.cwd).toBe(checkout)
    expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root))
  })

  it('says what to install when there is no launcher at all', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    const run = await runWrapper(fix, [], { env: { DSH_BIN: undefined, PATH: '' } })
    expect(run.code).toBe(127)
    expect(run.stderr).toContain('@deepseek-ai/dsh')
  })
})

describe('the first run, on a terminal', () => {
  terminalCase('asks once, sets up, and continues into the launch', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], { cwd: fix.root })
    expect(run.output).toContain('first run')
    expect(run.code).toBe(0)
    expect(run.calls.map(call => call.argv)).toEqual([
      INSTALL,
      launchArgs(fix.root),
    ])
  })

  terminalCase('stops when the release-age window refuses the install, and launches nothing', async fix => {
    // What pnpm does to `add --config.minimum-release-age=120 @dshline/dshline@X`
    // while X is still inside the window: ERR_PNPM_NO_MATURE_MATCHING_VERSION,
    // a non-zero exit, and no dependency recorded. `dsh plugin` has already
    // written the profile manifest by then, which is why the stub keeps writing
    // it here. The wrapper's part is to stop — a first run that says why beats
    // one that boots a frontend a release behind itself.
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], {
      cwd: fix.root,
      env: { STUB_SETUP_CODE: '1' },
    })
    expect(run.code).toBe(1)
    expect(run.output).toContain('setup did not finish')
    expect(run.calls.map(call => call.argv)).toEqual([INSTALL])
  })

  terminalCase('takes enter as yes', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: '\n' }], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls).toHaveLength(2)
  })

  terminalCase('sets up a directory that exists but was never initialized', async fix => {
    await mkdir(fix.profileDir, { recursive: true })
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls[0]?.argv[0]).toBe('plugin')
  })

  terminalCase('carries the original invocation through the setup, unchanged', async fix => {
    const args = ['--resume', 'abc123', 'run the tests']
    const run = await runOnTerminal(fix, args, [{ after: QUESTION, send: 'y\n' }], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls[1]?.argv).toEqual(launchArgs(fix.root, args))
  })

  terminalCase('respects an explicit folder through the setup too', async fix => {
    const elsewhere = join(fix.root, 'project')
    await mkdir(elsewhere, { recursive: true })
    const run = await runOnTerminal(fix, ['-C', elsewhere], [{ after: QUESTION, send: 'y\n' }], { cwd: fix.root })
    expect(run.calls[1]?.argv).toEqual(['--profile', 'dshline', '-C', elsewhere])
  })

  terminalCase('installs and launches inside the DSH_HOME it was given', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], { cwd: fix.root })
    expect(run.calls.map(call => call.home)).toEqual([fix.home, fix.home])
    expect(existsSync(fix.manifest)).toBe(true)
  })

  terminalCase('installs nothing when the answer is no, and starts nothing either', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'n\n' }], { cwd: fix.root })
    expect(run.code).toBe(1)
    expect(run.calls).toEqual([])
    expect(existsSync(fix.profileDir)).toBe(false)
    expect(run.stdout).toContain('dshline --setup')
  })

  terminalCase('cancels on ctrl-c without starting the install', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: CTRL_C }], { cwd: fix.root })
    // 130 is what a shell reports for a process ended by SIGINT, which is what
    // the keystroke meant.
    expect(run.code).toBe(130)
    expect(run.calls).toEqual([])
  })

  terminalCase('does not launch after a failed install', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], {
      cwd: fix.root,
      env: { STUB_SETUP_CODE: '9', STUB_SETUP_SKIP_INIT: '1' },
    })
    expect(run.code).toBe(9)
    expect(run.calls).toHaveLength(1)
    expect(run.output).toContain('setup did not finish')
  })

  terminalCase('does not launch after an install that was killed', async fix => {
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], {
      cwd: fix.root,
      env: { STUB_SETUP_SIGNAL: 'SIGTERM', STUB_SETUP_SKIP_INIT: '1' },
    })
    expect(run.calls).toHaveLength(1)
    expect(run.code).not.toBe(0)
  })
})

describe('two first launches at once', () => {
  terminalCase('runs the setup it was given permission to run, manifest or no manifest', async fix => {
    // A manifest that appeared while the question was on screen proves that a
    // setup STARTED — `dsh plugin` writes it before installing anything — never
    // that one finished. Skipping the install on it would launch the frontend
    // into a profile still being installed, and telling the difference means
    // reading dependencies, node_modules, or bundle state: profile health, which
    // is the harness's judgement and not this wrapper's.
    const run = await runOnTerminal(fix, [], [{
      after: QUESTION,
      before: () => initializeProfile(fix),
      send: 'y\n',
    }], { cwd: fix.root })
    expect(run.code).toBe(0)
    expect(run.calls.map(call => call.argv)).toEqual([
      INSTALL,
      launchArgs(fix.root),
    ])
  })

  terminalCase('does not launch when the manifest exists but the install then fails', async fix => {
    // The real ordering, modelled: manifest written, install still running,
    // install fails later. A wrapper that read the manifest as "done" would
    // start the frontend against a half-installed profile — so this case must
    // fail if that short-circuit ever comes back.
    const run = await runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], {
      cwd: fix.root,
      env: { STUB_SETUP_DELAY_MS: '300', STUB_SETUP_CODE: '9' },
    })
    expect(existsSync(fix.manifest)).toBe(true)
    expect(run.code).toBe(9)
    expect(run.calls.map(call => call.argv[0])).toEqual(['plugin'])
  })

  terminalCase('lets both confirmed launches delegate, and neither launch on a failed setup', async fix => {
    // Two overlapping first runs are the harness's own concurrent-mutation
    // question; dshline's part is that each invocation runs the command it was
    // authorized to run and launches only after its own setup succeeded.
    const both = await Promise.all([
      runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], {
        cwd: fix.root,
        log: join(fix.root, 'first.jsonl'),
        env: { STUB_SETUP_DELAY_MS: '300' },
      }),
      runOnTerminal(fix, [], [{ after: QUESTION, send: 'y\n' }], {
        cwd: fix.root,
        log: join(fix.root, 'second.jsonl'),
        env: { STUB_SETUP_DELAY_MS: '300' },
      }),
    ])
    expect(existsSync(fix.manifest)).toBe(true)
    for (const run of both) {
      const installed = run.calls.filter(call => call.argv[0] === 'plugin')
      const launched = run.calls.filter(call => call.argv[0] === '--profile')
      expect(installed).toHaveLength(1)
      expect(launched).toHaveLength(run.code === 0 ? 1 : 0)
    }
  })
})

describe('while the frontend owns the terminal', () => {
  // POSIX only, and not a gap in the Windows story: `ctrl-c` there is a console
  // event rather than a deliverable signal, and Node's `kill('SIGINT')` on
  // Windows terminates the target outright — there is no "ignored" to observe.
  it.skipIf(process.platform === 'win32')('ignores SIGINT and leaves with the child\'s own status', async () => {
    // The property that predates this change and has to survive it: once the
    // frontend has the terminal, `ctrl-c` is a keystroke it interprets, and a
    // wrapper that died on the signal would tear the session down mid-turn.
    // Signalled directly rather than through a terminal, because that isolates
    // the wrapper: a pty delivers the signal to every process in the foreground
    // group, including `script(1)`'s own shell, whose death would then be
    // reported as this run's exit status and prove nothing about dshline.
    const fix = await fixture()
    await initializeProfile(fix)
    const child = spawn(process.execPath, [WRAPPER], {
      env: environment(fix, { STUB_LAUNCH_HOLDS: '1' }),
      cwd: fix.root,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let seen = ''
    child.stdout?.on('data', chunk => { seen += String(chunk) })
    const finished = finish(child, fix.log)
    await waitFor(() => seen.includes('stub: launched'))
    child.kill('SIGINT')
    // Not a race with the signal: the wrapper is single-threaded, and had it
    // died the write below would reach a closed stdin and the run would end
    // with a signal instead of the child's status.
    child.stdin?.write('q\n')
    const run = await finished
    expect(run.signal).toBeNull()
    expect(run.code).toBe(0)
    expect(run.calls.map(call => call.argv[0])).toEqual(['--profile'])
  }, CHILD_TIMEOUT_MS + 10_000)

  terminalCase('passes ctrl-c through to the child on a real terminal', async fix => {
    // The keystroke half of the same property, on a pty. Only the output is
    // asserted: this run's exit status belongs to `script(1)`, which shares the
    // foreground group and dies of the signal itself.
    await initializeProfile(fix)
    const run = await runOnTerminal(fix, [], [
      { after: 'stub: launched', send: CTRL_C },
      { after: 'stub: saw ctrl-c', send: 'q\n' },
    ], { cwd: fix.root, env: { STUB_LAUNCH_HOLDS: '1' } })
    expect(run.output).toContain('stub: saw ctrl-c')
    expect(run.calls.map(call => call.argv[0])).toEqual(['--profile'])
  })
})

describe('shell syntax in a task', () => {
  // Proof by side effect, not by inspection: a task that WOULD run a command if
  // anything interpreted it must arrive whole, and must leave nothing behind.
  // The marker lives inside the fixture, so a failure cannot touch anything the
  // developer owns, and nothing in this path runs a shell — the wrapper spawns
  // with `shell: false` and the fixture spawns the wrapper the same way.
  it.skipIf(process.platform === 'win32')('is data: it reaches the launcher whole and runs nothing', async () => {
    const fix = await fixture()
    await initializeProfile(fix)
    const marker = join(fix.root, 'injected')
    const tasks = [
      `look at this ; touch ${marker}`,
      `look at this && touch ${marker}`,
      `look at this $(touch ${marker})`,
      `look at this \`touch ${marker}\``,
      `look at this | tee ${marker}`,
      `look at this > ${marker}`,
      `look at this \n touch ${marker}`,
    ]
    for (const task of tasks) {
      await rm(fix.log, { force: true })
      const run = await runWrapper(fix, [task], { cwd: fix.root })
      expect(run.code, task).toBe(0)
      // One argv entry, byte for byte, including the shell syntax.
      expect(run.calls[0]?.argv, task).toEqual(launchArgs(fix.root, [task]))
      expect(existsSync(marker), task).toBe(false)
    }
  }, CHILD_TIMEOUT_MS + 10_000)

  it.skipIf(process.platform === 'win32')('is data in a --setup source spec too', async () => {
    // The other place a caller's text reaches the launcher.
    const fix = await fixture()
    const marker = join(fix.root, 'injected-setup')
    const spec = `./packages/dshline ; touch ${marker}`
    const run = await runWrapper(fix, ['--setup', spec], { cwd: fix.root })
    expect(run.calls[0]?.argv).toEqual(['plugin', '--profile', 'dshline', 'add', spec])
    expect(existsSync(marker)).toBe(false)
  }, CHILD_TIMEOUT_MS + 10_000)
})

describe('a Windows npm install', () => {
  // Real where it matters and skipped everywhere else: an npm `.cmd` shim is a
  // batch file, so only Windows can run one, and only running one can prove what
  // arrives on the other side. `.github/workflows/ci.yml` runs exactly this
  // block on windows-latest; the `spawnPlan` cases above check the command line
  // it builds on every platform, which is not the same evidence.
  const windows = process.platform === 'win32' ? describe : describe.skip

  windows('through the shim', () => {
    it('reaches it for --setup', async () => {
      const fix = await fixture()
      const run = await runWrapper(fix, ['--setup'], { env: { DSH_BIN: fix.shim } })
      expect(run.code).toBe(0)
      expect(run.calls[0]?.argv).toEqual(INSTALL)
      expect(existsSync(fix.manifest)).toBe(true)
    }, CHILD_TIMEOUT_MS + 10_000)

    it('reaches it for an ordinary launch found on PATH', async () => {
      // PATH discovery is half the fix: what npm puts on PATH is `dsh.cmd`, and
      // spawning the bare name `dsh` there finds no file at all.
      const fix = await fixture()
      await initializeProfile(fix)
      const run = await runWrapper(fix, [], {
        env: { DSH_BIN: undefined, PATH: [fix.shimDir, join(process.execPath, '..'), systemFolder()].join(delimiter) },
        cwd: fix.root,
      })
      expect(run.code).toBe(0)
      expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root))
    }, CHILD_TIMEOUT_MS + 10_000)

    it('reaches it for a first run, then launches', async () => {
      const fix = await fixture()
      // `fix.pnpmDir` is on this PATH because the first-run setup is a profile
      // mutation, and the wrapper refuses one without pnpm. The lookup itself is what
      // this case is about; the prerequisite is checked before it does anything.
      const path = [fix.shimDir, fix.pnpmDir, join(process.execPath, '..'), systemFolder()].join(delimiter)
      const setup = await runWrapper(fix, ['--setup'], { env: { DSH_BIN: undefined, PATH: path } })
      expect(setup.code).toBe(0)
      await rm(fix.log, { force: true })
      const launch = await runWrapper(fix, [], { env: { DSH_BIN: undefined, PATH: path }, cwd: fix.root })
      expect(launch.calls[0]?.argv).toEqual(launchArgs(fix.root))
    }, CHILD_TIMEOUT_MS + 10_000)

    // One argument in, one argument out, byte for byte — recorded from the argv
    // the shim's target actually received, never from the command line this
    // process built. Each of these is a character `cmd` would otherwise act on.
    const tasks = [
      ['spaces', 'run the tests'],
      ['double quotes', 'say "hi" now'],
      ['an ampersand', 'a & b'],
      ['a pipe', 'a | b'],
      ['a caret', 'a ^ b'],
      ['percent signs', 'a %PATH% b'],
      ['an exclamation mark', 'a ! b'],
      ['parentheses', 'a (b) c'],
      ['a semicolon and a comma', 'a ; b , c'],
      ['a redirect pair', 'a > b < c'],
      ['a backtick and a star', 'a `b` *c*'],
      ['a trailing backslash', 'C:\\some\\path\\'],
      ['a trailing quote', 'unbalanced "'],
      ['doubled backslashes before a quote', 'a\\\\"b'],
      ['every one of them at once', 'x &|^%!()<>;,`* "q" \\'],
    ] as const

    for (const [name, task] of tasks) {
      it(`keeps a task with ${name} as one argument`, async () => {
        const fix = await fixture()
        await initializeProfile(fix)
        const run = await runWrapper(fix, [task], { env: { DSH_BIN: fix.shim }, cwd: fix.root })
        expect(run.code).toBe(0)
        expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root, [task]))
      }, CHILD_TIMEOUT_MS + 10_000)
    }

    it('runs no cmd side effect from a task that looks like a command', async () => {
      // The Windows half of the same proof, through the real shim: `cmd` parses
      // this line twice, so a task carrying its syntax has two chances to be
      // obeyed. It must be obeyed neither time — one argv entry, no marker.
      const fix = await fixture()
      await initializeProfile(fix)
      const marker = join(fix.root, 'injected.txt')
      const tasks = [
        `normal & echo injected > ${marker}`,
        `normal && echo injected > ${marker}`,
        `normal | echo injected > ${marker}`,
        `normal ^& echo injected > ${marker}`,
        `normal & type nul > ${marker}`,
      ]
      for (const task of tasks) {
        await rm(fix.log, { force: true })
        const run = await runWrapper(fix, [task], { env: { DSH_BIN: fix.shim }, cwd: fix.root })
        expect(run.code, task).toBe(0)
        expect(run.calls[0]?.argv, task).toEqual(launchArgs(fix.root, [task]))
        expect(existsSync(marker), task).toBe(false)
      }
    }, CHILD_TIMEOUT_MS + 10_000)

    it('runs a shim whose own path carries spaces and cmd metacharacters', async () => {
      // The command is tainted too, and a Windows filename may legally contain a
      // space, `&`, `(`, `)`, `,`, `^` and `%`. One `^` layer covers it: the path
      // takes part in the first parse only, since the shim replays `%*` — the
      // arguments — and not itself.
      const fix = await fixture()
      await initializeProfile(fix)
      const awkward = join(fix.root, 'shim (a) & b, c^d')
      await mkdir(awkward, { recursive: true })
      const shim = join(awkward, 'dsh.cmd')
      await writeFile(shim, `@echo off\r\n"${process.execPath}" "${join(fix.root, 'stub.cjs')}" %*\r\n`, 'utf8')
      const run = await runWrapper(fix, ['run the tests'], { env: { DSH_BIN: shim }, cwd: fix.root })
      expect(run.code).toBe(0)
      expect(run.calls[0]?.argv).toEqual(launchArgs(fix.root, ['run the tests']))
    }, CHILD_TIMEOUT_MS + 10_000)

    it('refuses a line break instead of handing cmd a second command', async () => {
      // The one case with no faithful representation on a cmd command line: a
      // newline ends the command rather than sitting inside an argument.
      const fix = await fixture()
      await initializeProfile(fix)
      for (const task of ['first\nsecond', 'first\r\nsecond']) {
        await rm(fix.log, { force: true })
        const run = await runWrapper(fix, [task], { env: { DSH_BIN: fix.shim }, cwd: fix.root })
        expect(run.code, JSON.stringify(task)).toBe(1)
        expect(run.stderr, JSON.stringify(task)).toContain('line break')
        expect(run.calls, JSON.stringify(task)).toEqual([])
      }
    }, CHILD_TIMEOUT_MS + 10_000)
  })
})
