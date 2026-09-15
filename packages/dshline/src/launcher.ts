/**
 * Finding the harness launcher, the same four ways `bin/dshline.mjs` does.
 *
 * `/profiles` mutations shell out to `dsh plugin` (see `profiles/actions.ts`
 * for why that is the mechanism), so they have to reach the launcher in every
 * environment this frontend itself starts in. A PATH lookup alone does not:
 * a person who set `DSH_BIN`, or who runs against a source checkout through
 * `DSH_HARNESS`, has a working `dshline` and would have had a `/profiles` that
 * could not install anything.
 *
 * The order is the wrapper's, and it is the order that respects what the user
 * has already decided:
 *
 * ```
 * DSH_BIN          an explicit launcher path
 * DSH_HARNESS      a source checkout, run through its own `dsh` script
 * dsh on PATH      the ordinary global install
 * @deepseek-ai/dsh resolved from this package, run through this Node
 * ```
 *
 * `bin/dshline.mjs` keeps its own copy of this policy and must: it is the
 * package's executable, it runs before anything is built, and giving it an
 * import from `lib/` would make the primary entry point fail in a source
 * checkout that has not run `pnpm build`. The duplication is therefore
 * deliberate and guarded rather than accidental —
 * `tests/launcher-policy.spec.ts` reads the wrapper and asserts both honour
 * the same mechanisms in the same order, so the two cannot drift in silence.
 * Behaviour that belongs to only one of them (the wrapper's `--setup`, its
 * first-run profile bootstrap, its `stdio: 'inherit'` hand-off) stays where it
 * is.
 * @module dshline/launcher
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

/** The harness's launcher package, resolved when no `dsh` is on PATH. */
export const LAUNCHER_PACKAGE = '@deepseek-ai/dsh'

/** The script a harness source checkout uses to launch itself. */
const HARNESS_SCRIPT = 'dsh'

/** How to run the launcher: a command, arguments that must precede ours, and where from. */
export interface Launcher {
  /** The executable to spawn. */
  readonly command: string
  /** Arguments that must come before the ones a caller passes. */
  readonly prefix: readonly string[]
  /**
   * The working directory the launcher must run from, when it has one.
   *
   * A source checkout's launcher is a relative path inside it and its loader
   * resolves from there too, so that launcher only runs with the checkout as
   * the working directory.
   */
  readonly cwd?: string
  /** How to name this launcher in a diagnostic. */
  readonly describe: string
  /**
   * Which mechanism produced this launcher.
   *
   * Not how it is run — what a prerequisite failure should say. A checkout declares
   * its own pnpm in `packageManager`, so the remedy that keeps that version is
   * corepack; a package install has no such declaration and gets the global one.
   */
  readonly origin: 'package' | 'checkout'
}

/** What resolution found: a launcher, a misconfiguration, or nothing. */
export type LauncherResolution =
  /** A usable launcher. */
  | { readonly kind: 'found'; readonly launcher: Launcher }
  /**
   * The user pointed at a launcher that is not there. Distinct from `'none'`
   * because the answer is different: a wrong `DSH_BIN` is a sentence about the
   * value they set, not an invitation to install anything.
   */
  | { readonly kind: 'misconfigured'; readonly message: string }
  /** No launcher could be found by any mechanism. */
  | { readonly kind: 'none' }

/** Expand a leading `~` the way the wrapper and the harness both do. */
function expandHome(value: string): string {
  if (value === '~') return homedir()
  return value.startsWith('~/') || value.startsWith('~\\') ? join(homedir(), value.slice(2)) : value
}

/**
 * Where a command is on PATH.
 *
 * Looked up rather than probed by running it: running `dsh --version` to find
 * out whether `dsh` exists would put a whole Node startup in front of an
 * answer the filesystem already has. The Windows extensions are tried because
 * a launcher installed by npm there is a `.cmd` shim rather than the name —
 * and the path is returned rather than a yes, because on Windows that shim is
 * the file that has to run: a bare `dsh` names nothing there, so spawning it
 * fails with ENOENT beside a launcher that is installed and working.
 * @param name - the command to look for.
 * @param env - the environment to read PATH from.
 * @returns the path of the first match, or undefined when there is none.
 */
export function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const candidates = process.platform === 'win32'
    ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name]
    : [name]
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
 * Split a manifest's `dsh` command line into a program and its arguments.
 *
 * Quote-aware, because a command line is what a shell would read and a program path
 * may legally contain a space. The case that needs it is Windows: Node lives under
 * `C:\Program Files\nodejs` on a default install, so a checkout naming its
 * interpreter in full — `"C:\Program Files\nodejs\node.exe" apps/cli.ts` — was split
 * into `C:\Program` and `Files\nodejs\node.exe`, and every launch failed with ENOENT
 * beside a checkout that worked from a shell.
 *
 * Kept identical to `bin/dshline.mjs`'s copy, for the reason the rest of this module
 * is duplicated: both have to run before anything is built, and a checkout that
 * launches from the wrapper must behave the same when a `/profiles` mutation reaches
 * the harness through it.
 *
 * Not a shell parser and deliberately not one: no expansion, no escapes, no
 * redirection. A value needing those is a value this cannot honour, and the
 * alternative — handing it to a shell — is what this project never does.
 * @param line - the command line, as a manifest wrote it.
 * @returns the program and its arguments, in order.
 */
export function splitCommandLine(line: string): string[] {
  const parts: string[] = []
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
 * Resolve the launcher named by `DSH_HARNESS`: a source checkout, run through
 * the `dsh` script its own manifest defines.
 * @param checkout - the raw `DSH_HARNESS` value, already known non-empty.
 * @returns the resolution.
 */
function fromCheckout(checkout: string): LauncherResolution {
  const expanded = expandHome(checkout)
  const manifestPath = join(expanded, 'package.json')
  if (!existsSync(manifestPath)) {
    return {
      kind: 'misconfigured',
      message: `$DSH_HARNESS points at ${expanded}, which is not a harness checkout (no package.json)`,
    }
  }
  let command: unknown
  try {
    command = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { scripts?: Record<string, unknown> })
      .scripts?.[HARNESS_SCRIPT]
  } catch {
    // An unparsable manifest is the same answer as a missing script: this is
    // not a checkout this can launch.
    command = undefined
  }
  if (typeof command !== 'string' || command.trim() === '') {
    return {
      kind: 'misconfigured',
      message: `${manifestPath} has no "${HARNESS_SCRIPT}" script, so this does not look like a harness checkout`,
    }
  }
  // The script is a plain command line — `node --import tsx/esm apps/cli/src/bin.ts`
  // — with paths relative to the checkout. Split the way a shell would read it, so a
  // quoted program path survives; see `splitCommandLine`.
  const [program, ...rest] = splitCommandLine(command)
  return {
    kind: 'found',
    launcher: {
      command: program ?? 'node',
      prefix: rest,
      cwd: expanded,
      describe: `$DSH_HARNESS (${expanded}: ${command})`,
      origin: 'checkout',
    },
  }
}

/**
 * Resolve `@deepseek-ai/dsh`'s own bin from this package's module graph.
 *
 * This is what makes `npm i -g @deepseek-ai/dsh @dshline/dshline` enough: a
 * global install puts the two side by side. Run through this Node rather than
 * the script's own shebang, so it does not matter whether the file is
 * executable in the install that provided it.
 * @param anchor - the module URL to resolve from.
 * @returns the resolution.
 */
function fromLauncherPackage(anchor: string): LauncherResolution {
  try {
    const manifestPath = createRequire(anchor).resolve(`${LAUNCHER_PACKAGE}/package.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: string | Record<string, string> }
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (typeof entry !== 'string') return { kind: 'none' }
    const script = join(dirname(manifestPath), entry)
    if (!existsSync(script)) return { kind: 'none' }
    return {
      kind: 'found',
      launcher: { command: process.execPath, prefix: [script], describe: `${LAUNCHER_PACKAGE} (${script})`, origin: 'package' },
    }
  } catch {
    // Not resolvable from here, which is not an error: PATH is the ordinary
    // route and this is the fallback for a side-by-side global install.
    return { kind: 'none' }
  }
}

/**
 * Find the harness launcher.
 * @param env - the environment to read; defaults to this process's.
 * @param anchor - module URL for the package fallback; defaults to this module.
 * @returns the resolution.
 */
export function resolveLauncher(
  env: NodeJS.ProcessEnv = process.env,
  anchor: string = import.meta.url,
): LauncherResolution {
  const configured = (env.DSH_BIN ?? '').trim()
  if (configured !== '') {
    const expanded = expandHome(configured)
    // Checked rather than handed to spawn, so a wrong path is a sentence
    // instead of an ENOENT naming a file the reader already believed existed.
    if (!existsSync(expanded)) {
      return { kind: 'misconfigured', message: `$DSH_BIN points at ${expanded}, which does not exist` }
    }
    return {
      kind: 'found',
      launcher: {
        // A relative DSH_BIN (`./bin/dsh`) is looked up against this process's
        // working directory — that is how the wrapper's own spawn still runs
        // it. The managed subprocess seam deliberately rejects relative paths
        // because ITS resolution base is undefined, so the cwd answer found
        // here is pinned in before the seam ever sees the command.
        command: resolve(expanded),
        prefix: [],
        describe: `$DSH_BIN (${expanded})`,
        origin: 'package',
      },
    }
  }
  const checkout = (env.DSH_HARNESS ?? '').trim()
  if (checkout !== '') return fromCheckout(checkout)
  const found = onPath(HARNESS_SCRIPT, env)
  if (found !== undefined) {
    // The bare name everywhere but Windows, so Node — and the managed
    // subprocess seam — resolve it the way a shell would. On Windows the shim
    // found above is named outright: `dsh` with no extension is not a file
    // there, and a lookup that answered only yes would send a command nothing
    // can spawn.
    const command = process.platform === 'win32' ? found : HARNESS_SCRIPT
    return { kind: 'found', launcher: { command, prefix: [], describe: 'dsh on your PATH', origin: 'package' } }
  }
  return fromLauncherPackage(anchor)
}
