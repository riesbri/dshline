#!/usr/bin/env node
/**
 * `dshline` — start a terminal session in the current folder.
 *
 * This frontend is a plugin, so it is started by the harness's own launcher with
 * `dsh --profile dshline`. That is two decisions to remember (which launcher, which
 * profile) before anything happens, and on a server it is the difference between
 * using this and not bothering. This wrapper makes the whole thing one word.
 *
 * It finds the launcher, adds `--profile dshline` unless another profile was asked for,
 * pins the session to the folder you ran it from, and hands over the terminal. Every
 * other argument is passed through untouched, so `dshline --resume`, `dshline "run the
 * tests"` and `dshline --help` all reach the real launcher.
 *
 * On a first run it asks once whether the harness may create and install that profile,
 * then continues into the launch that was asked for. That is the whole of its lifecycle
 * involvement: the mutation is `dsh plugin --profile dshline add` for this wrapper's OWN
 * version under dshline's release-age window (see `installArguments`), run
 * through the launcher found below, because the harness owns profile initialization,
 * package installation, the bundle list, and every reconciliation between them.
 *
 * Three narrow things it does decide, and each exists because leaving it to the
 * harness produced a failure a user could not act on:
 *
 * - Whether `pnpm` is reachable BEFORE it offers to mutate anything. The harness
 *   installs a profile's plugins with pnpm, so a machine without it got a profile
 *   created, an install that never ran, and a message about a command not found.
 * - Whether this package is actually recorded in its own profile (see `profileState`).
 *   A manifest is written before the install runs, so "the profile exists" was never
 *   the same claim as "setup finished", and treating the two as one launched a
 *   frontend into an empty profile — a blank terminal with no way out.
 * - Whether the profile's recorded release is the release this wrapper is. The profile
 *   holds the frontend that runs, so a pair that disagrees died inside the harness on
 *   an error naming its own internals.
 *
 * What it still does not do is judge profile health. A coherent bundle list, a
 * resolvable node_modules, another plugin's breakage: those stay the harness's to
 * diagnose, and a second package manager here would be a second answer to the same
 * question. The three questions above are about dshline's own package in dshline's own
 * profile, which is the part this wrapper is entitled to answer.
 *
 * Deliberately a launcher and nothing else: it starts no session logic of its own,
 * so there is only ever one implementation of the frontend to reason about.
 * @module dshline/bin/dshline
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** The profile this wrapper starts, and installs into with `--setup`. */
const PROFILE = 'dshline'

/** This package, as `dsh plugin add` names it. */
const PACKAGE = '@dshline/dshline'

/**
 * How long a published version is quarantined before this wrapper installs it.
 *
 * The same window `pnpm-workspace.yaml` sets for the repository, in the same unit
 * (minutes), stated a second time because the first run does not install into this
 * repository. It installs into a harness profile the harness just created, and the
 * profile's `pnpm-workspace.yaml` is the harness's file with the harness's settings
 * in it — dshline neither writes it nor reads it. So the policy travels on the
 * command line instead, where it is dshline's own argument to an install dshline
 * asked for, and the profile stays entirely the harness's.
 */
const RELEASE_AGE_MINUTES = 120

/**
 * The first-run install, as arguments for the harness's own `dsh plugin`.
 *
 * Two decisions, and both exist to stop the same failure. A `0.16.0` wrapper that
 * asked for a bare `@dshline/dshline` got `0.15.0` installed under it: pnpm 11
 * carries a built-in release-age default, npm's `latest` had just moved, and a
 * range install quietly settles for the newest version old enough to pass — so the
 * wrapper booted a frontend a release behind itself and crashed on an API that
 * generation never had.
 *
 * - The exact running version, not the package name. There is one right answer to
 *   "which dshline should this dshline install", and it is not whatever the
 *   registry can serve today.
 * - The window, stated explicitly. pnpm treats an explicitly configured
 *   `minimumReleaseAge` as binding on an exact request and refuses the install; left
 *   at its built-in default it silently writes the request onto an exclusion list
 *   instead. Naming the number is therefore what turns a too-young version into an
 *   error rather than a bypass — the failure this wrapper wants, because a first run
 *   that stops with a reason beats one that installs the wrong frontend.
 *
 * pnpm's `--config.<setting>` form is used rather than a file, because writing a
 * file would mean writing the harness's.
 * @returns the arguments, launcher-ready.
 */
export function installArguments() {
  return [
    'plugin', '--profile', PROFILE, 'add',
    `--config.minimum-release-age=${RELEASE_AGE_MINUTES.toString()}`,
    `${PACKAGE}@${ownVersion()}`,
  ]
}

/** The harness's launcher package, resolved when no `dsh` is on PATH. */
const LAUNCHER_PACKAGE = '@deepseek-ai/dsh'

/**
 * The script a harness source checkout uses to launch itself.
 *
 * A checkout has no `dsh` executable at all — the launcher is a TypeScript entry run
 * through a loader, and the checkout's own `package.json` is where that command is
 * written down. Reading it from there rather than hardcoding the path means this
 * keeps working when the harness moves its own files.
 */
const HARNESS_SCRIPT = 'dsh'

/** Exit status when the user declines or cancels the first-run question. */
const DECLINED = 1

/**
 * Exit status after `ctrl-c` at the question: the shell convention for a process
 * ended by SIGINT, which is what the keystroke meant even though nothing here died
 * of a signal to produce it.
 */
const CANCELLED = 130

/**
 * How to run the harness launcher: a command and any arguments that must precede
 * the ones this wrapper passes.
 *
 * `origin` is not how the launcher is run — it is what a prerequisite failure should
 * say. A checkout gets pnpm through its own declaration; a package install gets it
 * globally. Reading it from the launcher rather than from the environment keeps the
 * two together, since the launcher already knows which mechanism produced it.
 * @typedef {{ command: string, prefix: string[], cwd?: string, describe: string, origin: 'package' | 'checkout' }} Launcher
 */

/**
 * Split a command line from a manifest into a program and its arguments.
 *
 * Quote-aware, because a command line is what a shell would read and a program path
 * may legally contain a space. The one real case is Windows: Node lives under
 * `C:\Program Files\nodejs` on a default install, so a checkout whose `dsh` script
 * names its interpreter in full — `"C:\Program Files\nodejs\node.exe" apps/cli.ts` —
 * was split into `C:\Program` and `Files\nodejs\node.exe`, and the launch failed with
 * ENOENT beside a checkout that worked from a shell. The harness's own script happens
 * to use a bare `node`, which is why this survived: any machine whose PATH needs the
 * full path is where it shows.
 *
 * Not a shell parser and deliberately not one: no expansion, no escapes, no
 * redirection. A value that needs those is a value this cannot honour, and the
 * alternative — running it through a shell — is the one thing this file never does.
 * @param line - the command line, as a manifest wrote it.
 * @returns the program and its arguments, in order.
 */
export function splitCommandLine(line) {
  const parts = []
  let current = ''
  let quote = ''
  let quoted = false
  for (const character of line.trim()) {
    if (quote !== '') {
      if (character === quote) quote = ''
      else current += character
      continue
    }
    if (character === '"' || character === '\'') {
      quote = character
      quoted = true
      continue
    }
    if (/\s/u.test(character)) {
      // A quoted empty argument is still an argument; an unquoted run of spaces is not.
      if (quoted || current !== '') parts.push(current)
      current = ''
      quoted = false
      continue
    }
    current += character
  }
  if (quoted || current !== '') parts.push(current)
  return parts
}

/**
 * Where a command is on PATH.
 *
 * Looked up rather than probed by running it. Running `dsh --version` to find out
 * whether `dsh` exists would put a whole Node startup in front of every launch, for
 * an answer the filesystem already has. The Windows extensions are tried because a
 * launcher installed by npm there is a `.cmd` shim rather than the name itself — and
 * the path is returned, not just a yes, because that shim is the file that has to be
 * run: `spawn('dsh')` on Windows looks for a `dsh` with no extension and finds
 * nothing.
 * @param name - the command to look for.
 * @param env - the environment whose PATH is searched; defaults to this process's.
 * @returns the path of the first match, or undefined when there is none.
 */
function onPath(name, env = process.env) {
  const candidates = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name]
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const candidate of candidates) {
      const path = join(directory, candidate)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

/**
 * Find the harness launcher.
 *
 * Four ways, in the order that respects what the user has already decided:
 * `DSH_BIN` when they have pointed at one explicitly, then `DSH_HARNESS` for a source
 * checkout, then `dsh` on PATH for the ordinary global install, then the launcher
 * package resolved from this one — which is what makes
 * `npm i -g @deepseek-ai/dsh @dshline/dshline` enough, since a global install puts the
 * two side by side.
 * @returns the launcher, an `error` to print, or undefined when none can be found.
 */
function findLauncher() {
  const configured = (process.env.DSH_BIN ?? '').trim()
  if (configured !== '') {
    // Checked rather than handed to spawn, so a wrong path is a sentence instead of
    // an ENOENT naming a file the reader already believed was there.
    if (!existsSync(configured)) {
      return { error: `$DSH_BIN points at ${configured}, which does not exist.${sourceCheckoutHint(configured)}` }
    }
    return { command: configured, prefix: [], describe: `$DSH_BIN (${configured})`, origin: 'package' }
  }
  const checkout = (process.env.DSH_HARNESS ?? '').trim()
  if (checkout !== '') {
    const expanded = checkout.startsWith('~/') ? join(homedir(), checkout.slice(2)) : checkout
    const manifestPath = join(expanded, 'package.json')
    if (!existsSync(manifestPath)) {
      return { error: `$DSH_HARNESS points at ${expanded}, which is not a harness checkout (no package.json).` }
    }
    let command
    try {
      command = JSON.parse(readFileSync(manifestPath, 'utf8')).scripts?.[HARNESS_SCRIPT]
    } catch {
      command = undefined
    }
    if (typeof command !== 'string' || command.trim() === '') {
      return { error: `${manifestPath} has no "${HARNESS_SCRIPT}" script, so this does not look like a harness checkout.` }
    }
    // The script is a plain command line — `node --import tsx/esm apps/cli/src/bin.ts`
    // — with paths relative to the checkout, so it runs from there. Split the way a
    // shell would read it, so a quoted program path survives; see `splitCommandLine`.
    const [program, ...rest] = splitCommandLine(command)
    return {
      command: program ?? 'node',
      prefix: rest,
      cwd: expanded,
      describe: `$DSH_HARNESS (${expanded}: ${command})`,
      origin: 'checkout',
    }
  }
  const found = onPath('dsh')
  if (found !== undefined) {
    // The bare name everywhere but Windows, so Node resolves it the way a shell
    // would; the shim's own path there, because a bare `dsh` names no file.
    return { command: process.platform === 'win32' ? found : HARNESS_SCRIPT, prefix: [], describe: 'dsh on your PATH', origin: 'package' }
  }
  try {
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve(`${LAUNCHER_PACKAGE}/package.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (typeof entry !== 'string') return undefined
    const script = join(dirname(manifestPath), entry)
    if (!existsSync(script)) return undefined
    // Run through this Node rather than the script's own shebang, so it does not
    // matter whether the file is executable in the install that provided it.
    return { command: process.execPath, prefix: [script], describe: `${LAUNCHER_PACKAGE} (${script})`, origin: 'package' }
  } catch {
    return undefined
  }
}

/**
 * Where the harness keeps this profile.
 *
 * Resolved the same way the harness resolves it — `$DSH_HOME` when set, `~/.dsh`
 * otherwise, with a leading `~` expanded — because a wrapper that guessed
 * differently would announce a missing profile that is really there.
 * @returns the absolute profile directory.
 */
function profileDirectory() {
  const configured = (process.env.DSH_HOME ?? '').trim()
  const home = configured === ''
    ? join(homedir(), '.dsh')
    : configured === '~'
      ? homedir()
      : configured.startsWith('~/') || configured.startsWith('~\\')
        ? join(homedir(), configured.slice(2))
        : configured
  return join(home, 'profiles', PROFILE)
}

/**
 * Spec forms that name a folder, a link, or a version-control source rather than a
 * registry release.
 *
 * A profile built from a checkout records a path. A path is not a version: it cannot
 * be compared with this wrapper's own release, and reporting it as a stale one would
 * break the supported way to run unreleased code. Source-checkout development is a
 * first-class mode, so the state model has to tell the two apart rather than reading
 * "not this exact version string" as "wrong".
 */
const SOURCE_SPEC = /^(?:file:|link:|portal:|workspace:|git\+|github:|gitlab:|bitbucket:|https?:)/iu

/**
 * Whether a dependency spec names a folder or a remote source rather than a release.
 * @param spec - the recorded dependency spec.
 * @returns whether it is a source spec.
 */
function isSourceSpec(spec) {
  return SOURCE_SPEC.test(spec)
    // Bare paths, in the spellings pnpm accepts: `./x`, `../x`, `/x`, `C:\x`, `\\host\x`.
    || spec.startsWith('.')
    || spec.startsWith('/')
    || spec.startsWith('\\')
    || /^[A-Za-z]:[\\/]/u.test(spec)
}

/**
 * The first release-shaped version inside a dependency spec.
 *
 * Only the leading `major.minor.patch`, with any prerelease tag, because that is what
 * a comparison between a wrapper and a profile is about; the range operator in front
 * of it (`^`, `~`, `>=`) says how the install was allowed to move, not which release
 * is recorded.
 * @param spec - the recorded dependency spec.
 * @returns the version, or undefined when the spec names no release.
 */
export function versionInSpec(spec) {
  return /(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(spec)?.groups?.version
}

/**
 * What this package's own profile says about this package — and nothing else.
 *
 * The narrow question this wrapper is entitled to answer, because it is about its own
 * package in its own profile, and because answering it wrong is what turned a failed
 * setup into a blank terminal. `dsh plugin` WRITES the manifest before it installs
 * anything, so a manifest on disk proves a setup began and never that one finished;
 * the dependency list is the first thing that can tell the two apart.
 *
 * Everything else about a profile stays the harness's judgement: a coherent bundle
 * list, a resolvable node_modules, another plugin's breakage. Reinstalling on any of
 * those would hide a diagnosis behind a package operation nobody asked for.
 *
 * Four states, and the two that are easy to conflate are kept apart on purpose:
 * `incomplete` is a setup that did not finish, while `registry` with a different
 * version is a setup that finished and then went out of step with this wrapper. They
 * need different sentences and, in the end, the same repair.
 * @param profileDir - the profile folder; defaults to this wrapper's own profile.
 * @returns one of `absent`, `incomplete`, `local`, or `registry`.
 */
export function profileState(profileDir = profileDirectory()) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return { kind: 'absent' }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    // A manifest that cannot be read describes no installed package, which is the
    // same answer as one that lists none.
    return { kind: 'incomplete' }
  }
  const recorded = manifest?.dependencies?.[PACKAGE]
  if (typeof recorded !== 'string' || recorded.trim() === '') return { kind: 'incomplete' }
  const spec = recorded.trim()
  if (isSourceSpec(spec)) return { kind: 'local', spec }
  return { kind: 'registry', spec, version: versionInSpec(spec) }
}

/**
 * Whether an argument list already chooses a profile, in either accepted form.
 * @param args - the arguments this wrapper was given.
 * @returns whether `--profile` is present.
 */
function choosesProfile(args) {
  return args.some(argument => argument === '--profile' || argument.startsWith('--profile='))
}

/**
 * Whether an argument list already chooses a working folder.
 * @param args - the arguments this wrapper was given.
 * @returns whether a cwd flag is present.
 */
function choosesCwd(args) {
  return args.some(argument => argument === '-C' || argument === '--cwd' || argument.startsWith('--cwd='))
}

/**
 * What this invocation should do about the profile before launching.
 *
 * A separate function from the acting on it because this is the whole of the
 * policy, and the policy is what has to be provable:
 *
 * - `--profile` in the arguments means the caller is speaking harness profile
 *   language directly, so nothing here inspects, creates, or repairs anything. That
 *   holds for `--profile dshline` too: the distinction is ownership, not which name
 *   was typed. The old wrapper checked its own profile no matter which one was asked
 *   for, which is how `dshline --profile other` could refuse to start — and it is
 *   also the escape hatch from the two diagnostics below, because naming the profile
 *   is a decision to drive the harness directly.
 * - A profile that names a source spec launches. A checkout is a decision already
 *   made, and there is no registry release to compare it with.
 * - A profile recording this same release launches.
 * - A profile that never finished being set up, or that records a different release,
 *   is reported by cause and never launched into. Both used to reach the harness and
 *   die inside it — an empty profile or a mismatched pair — which is a blank terminal
 *   or an error about Cordis internals, neither of which a user can act on.
 * - An absent profile is offered setup, and only with a terminal on both ends: it may
 *   install packages from the network, so a scripted run must say so and stop rather
 *   than mutate anything.
 *
 * `interactive` governs the first-run question, which is the one case where the
 * answer is to ask. The two repair causes are returned as themselves rather than as
 * a question, because whether to offer the repair is a decision about this terminal
 * and belongs to the caller with it in hand.
 * @param decision - the arguments, the profile's state, and the two facts about this invocation.
 * @param decision.args - the arguments this wrapper was given.
 * @param decision.state - what `profileState` found in dshline's own profile.
 * @param decision.wrapperVersion - this wrapper's own version, from its manifest.
 * @param decision.interactive - whether stdin and stdout are both terminals.
 * @returns `'launch'`, `'confirm'`, `'no-terminal'`, `'incomplete'`, or `'skew'`.
 */
export function bootstrapPlan({ args, state, wrapperVersion, interactive }) {
  if (choosesProfile(args)) return 'launch'
  switch (state.kind) {
    case 'absent':
      return interactive ? 'confirm' : 'no-terminal'
    case 'incomplete':
      return 'incomplete'
    case 'registry':
      // A spec naming no release — a tag, a wildcard — cannot be compared, and an
      // unprovable mismatch is not worth refusing to start over.
      return state.version !== undefined && state.version !== wrapperVersion ? 'skew' : 'launch'
    default:
      return 'launch'
  }
}

/**
 * Whether `pnpm` can be reached the way the harness will reach it.
 *
 * The harness installs a profile's plugins with pnpm, so a first run without it got
 * as far as creating the profile and no further: the install never ran, and the only
 * symptom was `'pnpm' is not recognized` printed by `cmd.exe`. Checking first is the
 * difference between a sentence before anything changes and a half-made profile after.
 *
 * Asked of PATH rather than by running `pnpm --version`, for the reason the launcher
 * lookup is: the answer is already on the filesystem, and a probe would put a whole
 * process startup in front of it.
 * @param env - the environment whose PATH is searched; defaults to this process's.
 * @returns whether pnpm is available.
 */
export function pnpmAvailable(env = process.env) {
  return onPath('pnpm', env) !== undefined
}

/**
 * Whether setup can start, and what to print when it cannot.
 *
 * A checkout is told about `corepack` first because a harness checkout declares its
 * own pnpm in `packageManager`, so that is the route that keeps the version the
 * checkout asked for; a package install has no such declaration and gets the global
 * one. Both are real commands, and neither is a dependency-resolution bypass.
 * @param decision - whether pnpm was found, and how the launcher was reached.
 * @param decision.available - whether `pnpmAvailable` found it.
 * @param decision.origin - `'checkout'` for a `$DSH_HARNESS` launcher, else `'package'`.
 * @returns `{ ok: true }`, or `{ ok: false }` with the message to print.
 */
export function pnpmRequirement({ available, origin }) {
  if (available) return { ok: true }
  const install = origin === 'checkout'
    ? ['  corepack enable pnpm        # the harness checkout declares its own pnpm',
      '  npm install -g pnpm         # if corepack is not available']
    : ['  npm install -g pnpm']
  return {
    ok: false,
    message: [
      `dshline: cannot set up the "${PROFILE}" profile, because pnpm is not available.`,
      '',
      'The harness installs a profile\'s plugins with pnpm, so pnpm has to be on your',
      'PATH before setup can begin. Nothing has been changed: no profile was created',
      'and nothing was installed.',
      '',
      'Install pnpm, then run setup again:',
      '',
      ...install,
      '',
      '  dshline --setup',
      '',
    ].join('\n'),
  }
}

/**
 * Whether the confirmation can be asked at all.
 * @returns whether stdin and stdout are both terminals.
 */
function hasTerminal() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

/**
 * Read the version this package declares.
 *
 * From the manifest beside `bin/`, not from anything compiled: `--version` is what a
 * bug report asks for, so it has to answer in a source checkout that was never
 * built, with no harness installed, no profile, and no terminal.
 * @returns the version string.
 */
function ownVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}

/**
 * Ask the first-run question and read one answer.
 *
 * `readline` rather than a raw read of stdin: it puts the terminal in the mode where
 * `ctrl-c` arrives as a keystroke this process can answer for, which is what lets the
 * question be cancelled without a signal killing the wrapper mid-sentence. Both ways
 * out — `ctrl-c` and an end of input — resolve to undefined, because they mean the
 * same thing here: nobody said yes, so nothing is installed.
 * @param question - the prompt to write, including its trailing space.
 * @returns the answer, or undefined when the question was cancelled.
 */
function ask(question) {
  return new Promise(resolvePromise => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    // Every path answers before closing, never after. `close()` emits its event
    // synchronously, so closing first would let the end-of-input case below settle
    // this promise with undefined while an answer was already in hand.
    rl.on('SIGINT', () => {
      resolvePromise(undefined)
      rl.close()
    })
    // End of input — `ctrl-d`, or a stdin that went away — means the same as a no.
    // Also fires after an answered question, when this promise is already settled.
    rl.on('close', () => resolvePromise(undefined))
    rl.question(question, answer => {
      resolvePromise(answer)
      rl.close()
    })
  })
}

/**
 * Whether an answer to a default-yes question means yes.
 * @param answer - what the user typed, or undefined when they cancelled.
 * @returns whether to go ahead.
 */
export function saidYes(answer) {
  if (answer === undefined) return false
  const trimmed = answer.trim().toLowerCase()
  return trimmed === '' || trimmed === 'y' || trimmed === 'yes'
}

/**
 * Characters `cmd.exe` reads as syntax rather than as data.
 *
 * The set is `cross-spawn`'s, which is the list that has survived contact with real
 * Windows installs; the reasoning behind each entry is qntm's "Escaping in
 * cmd.exe" (https://qntm.org/cmd), which this implementation follows step for step
 * rather than approximately.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/gu

/**
 * Quote one argument for `cmd.exe`, which sits between this process and a `.cmd`
 * shim.
 *
 * Two parsers in a row, so two layers of escaping. The backslash-and-quote work is
 * what `CommandLineToArgvW` undoes to rebuild argv in the program that finally
 * runs; the `^` escapes are what stop `cmd` from acting on a character before that
 * happens. A shim is escaped TWICE because a shim is a batch file that re-invokes
 * its real target with `%*`, so the same command line is parsed by `cmd` a second
 * time — one layer would leave the second parse acting on the data.
 *
 * The `^` layers are `cross-spawn`'s, transcribed rather than depended on: the
 * wrapper must run before anything is installed or built, so it imports nothing.
 * Node's own `shell: true` is not an alternative either — it joins arguments with
 * spaces and quotes none of them, so a first task with a space in it would arrive
 * as several arguments.
 *
 * The backslash rule below is qntm's, and deliberately NOT cross-spawn's
 * expression of it: cross-spawn matches the run of backslashes before a quote with
 * a lazy group inside a lookahead, which for two or more backslashes matches only
 * the last one and leaves the rest undoubled. `a\\"b` then reaches the program as
 * `a\\b` — an even run of backslashes, so `CommandLineToArgvW` reads the quote as
 * a quote and drops it. Found by the Windows job, which is the only place that
 * difference is visible.
 * @param argument - one argument, verbatim from argv.
 * @param doubleEscape - whether a second `cmd` parse will see this line.
 * @returns the argument as `cmd.exe` must be given it.
 */
export function quoteForCmd(argument, doubleEscape = true) {
  // Double EVERY backslash that precedes a quote and escape the quote, then double a
  // trailing run so the closing quote below cannot be escaped by it.
  let value = argument.replace(/(\\*)"/gu, '$1$1\\"')
  value = value.replace(/(\\*)$/u, '$1$1')
  value = `"${value}"`
  value = value.replace(CMD_META, '^$1')
  if (doubleEscape) value = value.replace(CMD_META, '^$1')
  return value
}

/**
 * Whether a command is a Windows batch shim rather than an executable.
 * @param command - the command to run.
 * @returns whether `cmd.exe` has to interpret it.
 */
function isBatchShim(command) {
  return /\.(?:cmd|bat)$/iu.test(command)
}

/**
 * How to spawn one launcher invocation.
 *
 * Everywhere but Windows this is the command and the arguments, unchanged:
 * arguments are argv, never shell syntax, and no shell is involved. A Windows npm
 * install provides its launcher as a `.cmd` shim — a batch file, which `spawn` has
 * refused to run directly since the CVE-2024-27980 hardening — so that one case
 * goes through `cmd.exe`, quoted the way `cmd` requires and handed to Node
 * verbatim so it cannot be quoted twice.
 *
 * A carriage return or newline inside an argument is refused there instead. A
 * `cmd` command line has no representation for one: the character ends the command
 * rather than sitting inside an argument, and no amount of quoting changes that. A
 * wrapper that passed it anyway would be handing user text to `cmd` as syntax,
 * which is the one thing this function exists to prevent. The refusal is specific
 * to the shim path — a real executable, and every other platform, take the
 * argument as it is.
 * @param launcher - how to run the launcher.
 * @param args - the arguments to pass after its own prefix.
 * @param platform - the platform to plan for; defaults to this one.
 * @returns the command and its argv, or a `refuse` message instead.
 */
export function spawnPlan(launcher, args, platform = process.platform) {
  const argv = [...launcher.prefix, ...args]
  if (platform !== 'win32' || !isBatchShim(launcher.command)) {
    return { command: launcher.command, argv, verbatim: false }
  }
  const newline = argv.find(argument => /[\r\n]/u.test(argument))
  if (newline !== undefined) {
    return {
      refuse: `an argument contains a line break, which cannot be passed through ${launcher.command}.`
        + ' Run the harness launcher directly, or pass the text without line breaks.',
    }
  }
  // The command is escaped once and the arguments twice, and the asymmetry is the
  // point: only the arguments are replayed. `cmd` parses this line, hands the shim
  // its arguments, and the shim re-invokes its own target with `%*` — a second
  // parse of the ARGUMENTS alone, which the command path never reaches. One layer
  // is therefore exactly right for it, and a second would leave literal carets in
  // the path. The path is `^`-escaped rather than quoted because a Windows
  // filename may legally contain `& ( ) ^ , %` and a space; a line break it may
  // not, and the CR/LF refusal above covers every argument anyway.
  const line = [
    launcher.command.replace(CMD_META, '^$1'),
    ...argv.map(argument => quoteForCmd(argument)),
  ].join(' ')
  // `/d` skips AutoRun commands, `/s` takes the whole quoted remainder as the
  // command line, and the outer quotes are what `/s` strips.
  return { command: process.env.ComSpec ?? 'cmd.exe', argv: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/**
 * Run the launcher with this process's own terminal and wait for it.
 *
 * `stdio: 'inherit'` is the whole point: the frontend refuses to start without a
 * real terminal, so the child must be given this process's own, and an install's
 * pnpm output is the only progress there is. SIGINT is ignored here for the same
 * reason — `ctrl-c` is a keystroke the frontend decides the meaning of, and a wrapper
 * that died on it would tear down the session mid-turn.
 * @param launcher - how to run the launcher.
 * @param args - the arguments to pass.
 * @returns how the child ended.
 */
function runLauncher(launcher, args) {
  return new Promise(resolvePromise => {
    const plan = spawnPlan(launcher, args)
    if (plan.refuse !== undefined) {
      process.stderr.write(`dshline: ${plan.refuse}\n`)
      process.exit(1)
    }
    // Installed for exactly as long as this child runs, and removed by name when it
    // ends: the ignore belongs to the hand-off, not to the process. Left behind, it
    // would also swallow a re-raised signal — which is how a wrapper that outlived a
    // killed child came to exit zero — and `removeAllListeners` is not the fix for a
    // listener this file added itself.
    process.on('SIGINT', ignoreSigint)
    const settle = (outcome) => {
      process.off('SIGINT', ignoreSigint)
      resolvePromise(outcome)
    }
    const child = spawn(plan.command, plan.argv, {
      // Security boundary: Node never interprets this argv through a shell. A
      // Windows batch shim is the one case that needs an interpreter, and
      // `spawnPlan` has already turned it into `cmd.exe` plus a deliberately
      // built argv — quoted for that parse, line breaks refused. Written out
      // rather than left to the default, because the default is what a reader
      // (and a scanner) would otherwise have to take on trust.
      shell: false,
      stdio: 'inherit',
      ...plan.verbatim ? { windowsVerbatimArguments: true } : {},
      // A source checkout's launcher is a relative path inside it, and its loader
      // resolves from there too, so that launcher only runs with the checkout as the
      // working directory. The session's own folder is passed as an argument instead.
      ...launcher.cwd === undefined ? {} : { cwd: launcher.cwd },
    })
    child.on('error', (error) => {
      process.off('SIGINT', ignoreSigint)
      process.stderr.write(`dshline: could not start ${launcher.describe}: ${error.message}\n`)
      process.exit(127)
    })
    child.on('exit', (code, signal) => settle({ code, signal }))
  })
}

/**
 * Ignore SIGINT while a child owns the terminal.
 *
 * `ctrl-c` is a keystroke the frontend decides the meaning of, and a wrapper that
 * died on it would tear down the session mid-turn. Declared once, so it can be
 * taken off again by name.
 */
function ignoreSigint() {}

/**
 * Leave the way a child left.
 *
 * The signal is re-raised rather than turned into a status, so a caller sees the
 * same fact the child reported. Nothing has to be uninstalled first: the ignore is
 * owned by the run it was installed for and is already gone by here.
 * @param ended - the child's exit code and signal.
 */
function leaveAs(ended) {
  if (ended.signal !== null) {
    process.kill(process.pid, ended.signal)
    return
  }
  process.exit(ended.code ?? 0)
}

/**
 * Run the launcher and exit with its status.
 * @param launcher - how to run the launcher.
 * @param args - the arguments to pass.
 */
async function handOver(launcher, args) {
  leaveAs(await runLauncher(launcher, args))
}

/**
 * Resolve the launcher or leave, having said why.
 * @returns the launcher, once it is known to be usable.
 */
function launcherOrExit() {
  const found = findLauncher()
  if (found === undefined) {
    process.stderr.write(missingLauncherMessage())
    process.exit(127)
  }
  if (found.error !== undefined) {
    process.stderr.write(`dshline: ${found.error}\n`)
    process.exit(127)
  }
  return found
}

/**
 * Create the profile through the harness, having been told to.
 *
 * Permission was given for this command, so this command runs — the profile is not
 * re-examined first. It is tempting to skip the install when a manifest has appeared
 * since the question went up, on the theory that another launcher must have finished
 * the same setup. That inference is wrong: `dsh plugin` WRITES that manifest before
 * it starts installing, so the file's presence proves a setup began, never that one
 * finished, and skipping on it would launch the frontend into a profile that is
 * still being installed. Deciding otherwise would mean reading dependencies,
 * node_modules, or bundle state — profile health, which is the harness's to judge.
 *
 * Two overlapping confirmed first runs therefore both run the mutation, which is the
 * harness's own concurrent-mutation question and not something a second lock here
 * would answer. Either way a failed setup fails this invocation and launches
 * nothing.
 * @param launcher - how to run the launcher.
 * @returns nothing, or does not return at all when setup failed.
 */
async function setUpProfile(launcher) {
  const ended = await runLauncher(launcher, installArguments())
  if (ended.signal !== null || (ended.code ?? 0) !== 0) {
    // Nothing is launched after a failed setup: the harness has already said what
    // went wrong, and starting the frontend anyway would bury that under a second
    // failure from a profile that was never installed.
    process.stderr.write(setupFailedMessage())
    leaveAs(ended)
  }
}

/**
 * What to print when a setup the user authorized did not finish.
 *
 * The one prerequisite dshline can see for itself — pnpm — is checked before setup
 * starts, so what reaches here is whatever the harness itself reported. The earlier
 * message said only "try again", which reads as advice to repeat something that may
 * fail identically; this says that a retry is safe, where the reason is, and how to
 * look at the profile without starting a session.
 * @returns the message, ending in a newline.
 */
function setupFailedMessage() {
  return [
    '',
    'dshline: setup did not finish, so nothing was started.',
    '',
    'The harness printed the reason above — a package it could not install, a network',
    'failure, or a release still inside this package\'s release-age window. Nothing is',
    'launched until a setup succeeds, and running it again is safe:',
    '',
    '  dshline --setup',
    '',
    'To see what the profile loads, and from where:',
    '',
    '  dsh --profile dshline --dump-config',
    '',
  ].join('\n')
}

/**
 * Why a profile cannot be launched into, in plain language.
 *
 * `incomplete` and `skew` are different facts about the same profile and need
 * different sentences, because the reader has to know whether they are finishing
 * something or repairing it. What they share is the requirement that the failure is
 * described here: left to the harness, the first was a blank terminal with no message
 * at all, and the second was `cannot get property "agent" without inject`.
 * @param cause - `'incomplete'` or `'skew'`.
 * @param detail - the wrapper's version, and the recorded one when there is one.
 * @returns the explanation, as lines.
 */
function profileProblem(cause, { wrapperVersion, version }) {
  if (cause === 'incomplete') {
    return [
      `dshline: the "${PROFILE}" profile is half set up, so there is nothing to launch.`,
      '',
      'A previous setup created the profile and then stopped before installing this',
      'package into it. The profile exists and is empty, which is a state the harness',
      'never gets far enough to report: a launch into it used to open a blank terminal',
      'and wait there.',
    ]
  }
  return [
    `dshline: this dshline is ${wrapperVersion}, but the "${PROFILE}" profile has`,
    `@dshline/dshline ${version ?? 'another release'}.`,
    '',
    'The profile holds the frontend that actually runs and this wrapper only starts it,',
    'so the two have to be the same release. A mismatched pair fails inside the harness,',
    'with an error about its own internals rather than about the versions.',
  ]
}

/**
 * The question asked before repairing a profile, on a terminal.
 *
 * Asking rather than reconciling on sight: the repair is a package install into a
 * profile the user already has, and doing that uninvited is the mutation this wrapper
 * refuses to make everywhere else.
 * @param cause - `'incomplete'` or `'skew'`.
 * @param detail - the wrapper's version, and the recorded one when there is one.
 * @returns the prompt, ending in the answer position.
 */
function repairQuestion(cause, detail) {
  return [
    ...profileProblem(cause, detail),
    '',
    'This will run:',
    '',
    `  dsh ${installArguments().join(' ')}`,
    '',
    cause === 'incomplete' ? 'Set it up now? [Y/n] ' : 'Reconcile it now? [Y/n] ',
  ].join('\n')
}

/**
 * What to print about a profile that cannot be launched into, with no terminal.
 * @param cause - `'incomplete'` or `'skew'`.
 * @param detail - the wrapper's version, and the recorded one when there is one.
 * @returns the message, ending in a newline.
 */
function profileProblemMessage(cause, detail) {
  return [
    ...profileProblem(cause, detail),
    '',
    'Bring the profile back in step with this wrapper:',
    '',
    '  dshline --setup',
    '',
    'That needs no terminal, so a script can run it. To drive the harness with this',
    'profile as it is, name it explicitly — that is you using harness profiles directly:',
    '',
    `  dshline --profile ${PROFILE}`,
    '',
  ].join('\n')
}

/**
 * Refuse a setup whose prerequisite is missing, before anything is created.
 * @param launcher - how the harness is reached, which decides the remedy.
 */
function requirePnpm(launcher) {
  const requirement = pnpmRequirement({ available: pnpmAvailable(), origin: launcher.origin })
  if (requirement.ok) return
  process.stderr.write(requirement.message)
  process.exit(1)
}

/**
 * The wrapper's own help.
 *
 * Wrapper-owned, like `--version`, so somebody working out why an installation will
 * not start can read it on the machine where the harness, the profile, or both are
 * the broken part. It documents the wrapper and names the harness command for
 * everything else rather than restating a CLI reference that would then drift.
 *
 * The wording of the first line matters: the harness reports its own usage as
 * `dsh --profile dshline`, and repeating that here would name a command the reader
 * did not type.
 * @returns the help text, ending in a newline.
 */
function helpText() {
  return [
    `dshline ${ownVersion()} — a terminal frontend for the DeepSeek Harness.`,
    '',
    'Usage:',
    '  dshline [harness options] [task...]',
    '',
    'Wrapper options:',
    '  --setup [spec]   install this package into the "dshline" harness profile, then',
    '                   stop. With no spec: the exact version this wrapper is, which is',
    '                   also how a profile is finished or repaired. With a path',
    '                   (`dshline --setup ./packages/dshline`): that folder instead,',
    '                   which is how code from a source checkout is used.',
    '                   Needs no terminal, so it is also the scriptable path.',
    '  -V, --version    this package\'s version. No harness and no profile needed.',
    '  -h, --help       this text. No harness and no profile needed either.',
    '',
    'Anything else is forwarded to the harness\'s own launcher unchanged, with',
    '`--profile dshline` and `--cwd <current folder>` added unless you gave them:',
    '',
    '  dshline                         start a session in this folder',
    '  dshline "run the tests"         start a session with a first task',
    '  dshline --resume                reopen a past session',
    '  dshline -C ~/code/api           start in another folder',
    '  dshline --profile other         use another harness profile; dshline then',
    '                                  inspects nothing and forwards the choice',
    '',
    'The harness\'s own options belong to the harness, which documents them itself:',
    '',
    '  dsh --profile dshline --help',
    '  dsh --profile dshline --dump-config    what the profile loads, and from where',
    '',
    'Environment:',
    '  DSH_BIN        an explicit harness launcher executable',
    '  DSH_HARNESS    a harness SOURCE CHECKOUT; the `dsh` script it declares is run',
    '  DSH_HOME       where profiles live (~/.dsh by default)',
    '',
    `The "${PROFILE}" profile holds the frontend that runs, so it has to be the same`,
    'release as this wrapper. `dshline --setup` reconciles it. A profile installed from',
    'a checkout path is a decision already made and is left alone.',
    '',
  ].join('\n')
}

/**
 * The one-time question, and what saying yes will run.
 * @returns the prompt, ending in the answer position.
 */
function firstRunQuestion() {
  return [
    `dshline: first run — the "${PROFILE}" harness profile is not set up yet.`,
    '',
    'This will run:',
    '',
    `  dsh ${installArguments().join(' ')}`,
    '',
    'The harness creates the profile and installs this package into it, which uses',
    'the network through pnpm.',
    '',
    'Set it up now? [Y/n] ',
  ].join('\n')
}

/**
 * What to print when setup is needed and there is no terminal to ask on.
 * @returns the message, ending in a newline.
 */
function noTerminalMessage() {
  return [
    `dshline: the "${PROFILE}" harness profile is not set up.`,
    'Automatic first-run setup asks first, because it installs packages, and there is',
    'no terminal here to ask on.',
    '',
    'Run once:',
    '',
    '  dshline --setup',
    '',
  ].join('\n')
}

/**
 * Do what this invocation asked for.
 * @param args - the arguments after the executable.
 */
async function main(args) {
  // Before the launcher is looked for, and before anything touches a profile: these
  // answers are this package's own, and a bug report — or somebody working out why an
  // installation will not start — has to be able to get them from a machine where the
  // rest of the setup is what is broken.
  if (args[0] === '--version' || args[0] === '-V') {
    process.stdout.write(`${ownVersion()}\n`)
    return
  }
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(helpText())
    return
  }
  if (args[0] === '--setup') {
    const launcher = launcherOrExit()
    // Before anything is created. The harness installs a profile's plugins with pnpm,
    // so without it setup created a profile and stopped there; refusing here leaves the
    // filesystem exactly as it was, which is the whole difference between a sentence
    // and a half-made profile.
    requirePnpm(launcher)
    // A source may be given instead of the published package — `dshline --setup
    // ./packages/dshline` is how someone testing a checkout installs it, and it is the
    // same argument `dsh plugin add` takes, so it is passed through rather than
    // reinvented. Anything further goes to the launcher untouched.
    //
    // Untouched includes a relative path, and under `$DSH_HARNESS` that means
    // something surprising: the launcher must run from the harness checkout, and
    // `dsh plugin` anchors a relative spec against the folder IT runs in, so
    // `./packages/dshline` names a folder inside the harness. Rewriting it here would
    // mean owning a copy of the harness's package-spec parser — which spec forms are
    // paths at all, and what `file:` versus a bare path means to pnpm — to make one
    // argument mean something different from what the same argument means to
    // `dsh plugin add`. An absolute path is the answer, and docs/install.md says so.
    //
    // A named source replaces the whole install, version pin and release-age window
    // included: those two exist to pick the right REGISTRY release, and a caller who
    // named a checkout has already picked. Quarantining a folder would be a window
    // on a file's mtime, and pinning would contradict the argument just given.
    const source = args.length > 1 ? args.slice(1) : undefined
    const install = source === undefined
      ? installArguments()
      : ['plugin', '--profile', PROFILE, 'add', ...source]
    process.stdout.write(`dshline: installing ${source?.[0] ?? `${PACKAGE}@${ownVersion()}`} into the "${PROFILE}" profile\n`)
    // No question here, and no terminal requirement: the user asked for this exact
    // mutation by name, which is what makes `--setup` the scriptable path and the
    // answer to a first run that went wrong.
    await handOver(launcher, install)
    return
  }
  const launcher = launcherOrExit()
  const wrapperVersion = ownVersion()
  const state = profileState()
  const plan = bootstrapPlan({ args, state, wrapperVersion, interactive: hasTerminal() })
  if (plan === 'no-terminal') {
    process.stderr.write(noTerminalMessage())
    process.exit(1)
  }
  if (plan === 'incomplete' || plan === 'skew') {
    // A profile this wrapper cannot launch into and cannot repair without installing a
    // package. Reported as a diagnostic where there is no terminal to ask on, because
    // the repair is a mutation; offered as the same question the first run asks where
    // there is one, because the state a failed setup leaves behind is otherwise one the
    // user can only escape by guessing.
    const detail = { wrapperVersion, version: state.kind === 'registry' ? state.version : undefined }
    if (!hasTerminal()) {
      process.stderr.write(profileProblemMessage(plan, detail))
      process.exit(1)
    }
    const answer = await ask(repairQuestion(plan, detail))
    if (answer === undefined) {
      process.stdout.write('\n')
      process.exit(CANCELLED)
    }
    if (!saidYes(answer)) {
      process.stdout.write(`\nNothing was changed. When you want it:\n\n  dshline --setup\n\n`)
      process.exit(DECLINED)
    }
    requirePnpm(launcher)
    await setUpProfile(launcher)
  }
  if (plan === 'confirm') {
    // Asked before the question rather than after the answer: agreeing to a setup that
    // cannot run is exactly how a profile came to be created and left empty.
    requirePnpm(launcher)
    const answer = await ask(firstRunQuestion())
    if (answer === undefined) {
      // The question was cancelled, and the cursor is sitting at the end of it.
      process.stdout.write('\n')
      process.exit(CANCELLED)
    }
    if (!saidYes(answer)) {
      process.stdout.write(`\nNothing was installed. When you want it:\n\n  dshline --setup\n\n`)
      process.exit(DECLINED)
    }
    await setUpProfile(launcher)
  }
  // Added BEFORE the caller's arguments, never after. A first task is a positional
  // argument — `dshline "run the tests"` — and appending a flag behind positionals
  // leaves the parser deciding whether `--cwd` belongs to the option or to the task.
  const added = []
  if (!choosesProfile(args)) added.push('--profile', PROFILE)
  // The folder is pinned explicitly rather than left to the launcher's own default,
  // because the launcher may be reached through something that changed folder on the
  // way — a shell function that enters a harness checkout first, for instance.
  // `--resume` ignores it by design and keeps the folder its session was created in.
  if (!choosesCwd(args)) added.push('--cwd', process.cwd())
  await handOver(launcher, [...added, ...args])
}

/**
 * The likely correction when `$DSH_BIN` names something that is not there.
 *
 * A source checkout has no `dsh` executable to point at — the launcher is a
 * TypeScript entry run through a loader — so this is the mistake a reader is most
 * likely to have made, and `$DSH_HARNESS` is the answer to it.
 * @param configured - the path that did not exist.
 * @returns a sentence beginning with a space, or an empty string.
 */
function sourceCheckoutHint(configured) {
  if (!/node_modules[\\/]\.bin[\\/]dsh$/u.test(configured)) return ''
  const checkout = configured.replace(/[\\/]node_modules[\\/]\.bin[\\/]dsh$/u, '')
  return ` A harness SOURCE CHECKOUT has no such executable — its launcher is a script.`
    + ` Point at the checkout itself instead:\n\n  export DSH_HARNESS=${checkout}\n`
}

/**
 * What to print when no launcher can be found.
 * @returns the message, ending in a newline.
 */
function missingLauncherMessage() {
  return [
    'dshline: cannot find the DeepSeek Harness launcher.',
    '',
    'This is a plugin for the harness, so the harness has to be installed too:',
    '',
    `  npm install -g ${LAUNCHER_PACKAGE}`,
    '  dshline',
    '',
    'If you run the harness from a SOURCE CHECKOUT, name the checkout — not a',
    'binary, because a checkout does not build one:',
    '',
    '  export DSH_HARNESS=~/path/to/deepseek-harness',
    '',
    'Or name an executable directly, if you have one:',
    '',
    '  export DSH_BIN=/path/to/dsh',
    '',
  ].join('\n')
}

/**
 * Whether this file was run as the command, rather than imported.
 *
 * Both sides are resolved through the filesystem before being compared, and
 * that is not defensive dressing: npm installs this executable as a SYMLINK on
 * the PATH, and Node reports `import.meta.url` for the file the link points at
 * while `argv[1]` is the link itself. A plain string comparison is therefore
 * false for every ordinary global install — the whole product — while looking
 * correct in a checkout, where the path has no link in it. That is exactly how
 * it was found: `dshline` did nothing at all and exited zero.
 * @returns whether to run.
 */
function invokedAsCommand() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(resolve(invoked)) === fileURLToPath(import.meta.url)
  } catch {
    // A name that resolves to nothing cannot be this file.
    return false
  }
}

// Run only as the executable, so the decisions above can be imported and
// checked without starting anything.
if (invokedAsCommand()) {
  await main(process.argv.slice(2))
}
