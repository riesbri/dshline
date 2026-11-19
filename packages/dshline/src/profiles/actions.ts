/**
 * Running one `dsh plugin --profile <name> …` invocation from the terminal.
 *
 * This is the whole mutation surface of `/profiles`, and it is deliberately a
 * forwarder rather than an implementation. Harness owns profile package
 * lifecycle in one place — `apps/cli/src/plugin.ts` — which initializes the
 * profile directory if it is new, runs pnpm inside it, and then reconciles
 * `dsh.profile.bundles` against the INSTALLED state (so a package that gained
 * its `dsh.bundle` declaration in a newer version joins the layer stack on
 * update). Reproducing any part of that here would be a second installer whose
 * idea of the bundle list drifts from the real one the moment either changes.
 *
 * There is no Harness service for profile mutation: `runPlugin` lives in the
 * CLI app, not in a mounted plugin, and nothing publishes it into a context.
 * So the operation still goes through Harness's own `dsh` executable, resolved
 * by `../launcher.ts` the same four ways `bin/dshline.mjs` resolves it. Process
 * ownership is a separate concern, though, and belongs to `ctx.subprocess`:
 * that seam owns executable lookup, environment policy, process trees, and
 * cross-platform termination for every Harness consumer. Its credential scrub
 * is narrowed here rather than undone — the child keeps what was set inside
 * the package managers' own namespaces plus the Host-resolved home, because
 * pnpm authenticates from the child's environment (`_authToken=${NPM_TOKEN}`),
 * while harness secrets stay scrubbed away from install scripts.
 *
 * Four things this module does that the CLI does not, all because a TUI owns
 * the terminal and a person is waiting:
 *
 * ```
 * stdio is PIPED, never inherited   `dsh plugin` uses stdio:'inherit'; a child
 *                                   writing pnpm progress straight into a
 *                                   screen this process is painting would
 *                                   corrupt the live region
 * output is a ROLLING tail          pnpm can emit megabytes; only the last few
 *                                   lines are ever held, so a long install
 *                                   cannot grow this process's memory with
 *                                   text nobody will read
 * the timeout SETTLES               the subprocess seam escalates termination;
 *                                   this caller still classifies its own
 *                                   deadline and stops waiting at a hard bound
 * specs are REDACTED for display    a package spec can carry a token in a URL;
 *                                   it is passed to the launcher verbatim and
 *                                   never written to the transcript as-is
 * ```
 * @module dshline/profiles/actions
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { resolveLauncher } from '../launcher.ts'
import type { Launcher } from '../launcher.ts'
import { displayArgument, shellQuote } from './model.ts'
import type { ResolvedOperation } from './model.ts'

/**
 * How long one invocation may run before it is stopped.
 *
 * Generous, because a pnpm install reaches the network and may build native
 * packages — but bounded, and the bound is enforced to completion below.
 */
const PLUGIN_TIMEOUT_MS = 600_000

/**
 * How long a stopped child is given to exit before it is killed outright.
 *
 * pnpm spawns its own children, and a SIGTERM it declines to act on must not
 * become an indefinite wait. The Harness provider applies this to the whole
 * process tree, using the platform's own termination mechanism.
 */
const KILL_GRACE_MS = 5_000

/** Lines of child output kept for the transcript. */
const KEPT_OUTPUT_LINES = 10

/** Bytes of child output held at once, before older text is dropped. */
const OUTPUT_TAIL_BYTES = 16_384

/**
 * Ambient names restored to the launcher's child, by owner rather than value.
 *
 * The subprocess seam scrubs every credential-SHAPED name (`*KEY*`, `*TOKEN*`,
 * `*SECRET*`, `*PASSWORD*`), which is right for model-driven children and
 * silently breaking here in one specific way: pnpm expands
 * `_authToken=${NPM_TOKEN}` from an `.npmrc` against the CHILD's environment,
 * so a private-registry install that authenticated under direct spawning
 * would fail under the scrub. Everything in the package managers' own
 * namespaces is restored because whoever set it set it FOR them; nothing else
 * is, because the scrub exists precisely so harness secrets —
 * `DEEPSEEK_API_KEY` above all — never reach the lifecycle scripts of what
 * gets installed.
 *
 * Custom names (`${MY_COMPANY_TOKEN}`) stay excluded on purpose, and are not
 * rescued by scanning config files for references: those files are writable
 * by anything running as this user — including a lifecycle script from an
 * earlier install — so honoring their references would let one poisoned
 * config promote an ambient harness secret into the next install. That is
 * the exfiltration shape pnpm itself closed when it stopped trusting
 * project-level auth settings entirely (pnpm 11.5.3), which is also why the
 * old advice "put it in the profile's .npmrc" is wrong twice over. Keep
 * environment delivery under a name the managers own instead: reference
 * `${NPM_TOKEN}` from USER-level config and provide it at launch
 * (`NPM_TOKEN="$MY_COMPANY_TOKEN" dshline …`) — the secret stays out of
 * files, under either spelling. Ecosystem variables such as
 * CODEARTIFACT_AUTH_TOKEN are enumerated nowhere because their tooling
 * writes literal rotating credentials into user config rather than feeding
 * the variable through raw pnpm.
 */
const PACKAGE_MANAGER_ENV = /^(?:NPM_|PNPM_|COREPACK_|NODE_AUTH_TOKEN)/iu

/** How one invocation ended, in words the transcript can carry. */
export interface ProfileActionOutcome {
  /** Whether the invocation succeeded. */
  readonly kind: 'done' | 'failed'
  /** What happened, already worded for a reader. */
  readonly message: string
  /** The tail of the child's own output, when it produced any. */
  readonly output: readonly string[]
}

/** What one child invocation answered. */
export interface ChildResult {
  /** The exit code, or a stand-in when the child never reported one. */
  readonly code: number
  /** The retained tail of its combined output. */
  readonly output: string
}

/** What {@link runProfileOperation} needs to run one invocation. */
export interface ProfileOperationSpec {
  /** The profile name the operation is addressed to. */
  readonly profile: string
  /** The resolved operation, from `model.ts`. */
  readonly resolved: ResolvedOperation
  /** Harness's process owner; absent only on an older or incomplete Host. */
  readonly subprocess?: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
  /** Resolved Harness home, explicitly restored after subprocess env scrubbing. */
  readonly dshHome?: string
  /**
   * Resolve the launcher; injected so a test drives the whole chain without a
   * launcher installed.
   */
  readonly launcher?: () => ReturnType<typeof resolveLauncher>
  /**
   * Spawn one child; injected for the same reason. Resolves with the child's
   * exit code and retained output, and never rejects.
   */
  readonly run?: (launcher: Launcher, args: readonly string[]) => Promise<ChildResult>
}

/** Bound failed scheme searches on long plain-text diagnostics as well as URLs. */
const OUTPUT_URL = /\b[a-z][a-z\d+.-]{0,31}:\/\/\S+/giu

/**
 * One line of child output, safe to commit.
 *
 * pnpm echoes the spec it was given, so a token that reached the launcher in a
 * URL reaches the transcript through the child's own output unless it is taken
 * out here. The transcript outlives the overlay and is the durable copy, which
 * is precisely why this is the place to do it.
 * @param line - one line as the child wrote it.
 * @returns the line with any embedded credential replaced.
 */
export function redactOutputLine(line: string): string {
  // Query/fragment names are not a credential vocabulary: signed downloads use
  // vendor-specific names, and a new spelling must not silently leak a key.
  // Raw angle brackets can occur in URL fields echoed before normalization;
  // treating them as markup delimiters exposes the remainder of a credential.
  return line.replace(OUTPUT_URL, url => url
    .replace(/^([a-z][a-z\d+.-]*:\/\/)[^/?#]*@/iu, '$1<redacted>@')
    .replace(/([?#]).*$/u, '$1<redacted>'))
}

/**
 * The command line a reader could run themselves, quoted so it is true.
 *
 * A package spec may hold characters a shell would act on, so an argv list
 * pasted together with spaces is not the command that ran. Each argument that
 * needs it is single-quoted, which is what makes this safe to copy rather than
 * merely readable.
 * @param profile - the profile name.
 * @param args - the arguments after `--profile <name>`.
 * @returns the command, safe to show and to paste.
 */
export function pluginCommand(profile: string, args: readonly string[]): string {
  const parts = ['dsh', 'plugin', '--profile', profile, ...args.map(displayArgument)]
  return parts.map(shellQuote).join(' ')
}

/**
 * A bounded, rolling tail of a child's output.
 *
 * Appends and forgets: nothing older than {@link OUTPUT_TAIL_BYTES} is kept, so
 * a pnpm run that prints a progress line per package cannot grow this process's
 * memory in proportion to its output.
 */
class OutputTail {
  private held = ''
  private clipped = false

  /**
   * Add a chunk, dropping whatever no longer fits.
   * @param chunk - the text just read.
   */
  push(chunk: string): void {
    if (this.held.length + chunk.length > OUTPUT_TAIL_BYTES) this.clipped = true
    this.held = this.held.length + chunk.length <= OUTPUT_TAIL_BYTES
      ? this.held + chunk
      : (this.held + chunk).slice(-OUTPUT_TAIL_BYTES)
  }

  /** The retained text. */
  text(): string {
    // Dropping a URL prefix must not turn its remaining signed suffix into
    // ordinary-looking text that the display redactor cannot recognise.
    if (!this.clipped) return this.held
    const firstCompleteLine = this.held.indexOf('\n')
    return firstCompleteLine < 0 ? '' : this.held.slice(firstCompleteLine + 1)
  }
}

/** Timings for one child, overridable so the bound itself can be tested. */
export interface ChildTimings {
  /** How long the child may run before it is stopped. */
  readonly timeoutMs?: number
  /** How long a stopped child is given to exit before it is killed outright. */
  readonly killGraceMs?: number
}

/**
 * The environment one launcher child runs with.
 *
 * The seam's scrubbed base already keeps `PATH`, `HOME`, locale, and proxy
 * settings, so ordinary installs need nothing from here; this restores only
 * what the scrub would take away that the child has a legitimate claim on:
 * {@link PACKAGE_MANAGER_ENV} namespaces and the resolved Harness home, which
 * merges last so an explicit Host answer wins over any ambient spelling.
 * @param dshHome - the Host-resolved home, when this deployment provides one.
 * @returns the explicit entries layered onto the scrubbed base.
 */
function childEnvironment(dshHome: string | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && PACKAGE_MANAGER_ENV.test(name)) env[name] = value
  }
  if (dshHome !== undefined) env.DSH_HOME = dshHome
  return env
}

/**
 * Spawn one managed child with piped stdio, returning its code and retained output.
 *
 * Harness owns executable resolution, the isolated process tree, platform
 * signalling, and TERM-to-KILL escalation. This caller owns its deadline and
 * result vocabulary: after asking the handle to terminate it still resolves
 * independently if the provider cannot prove closure, because the profile lock
 * must not become an indefinite wait.
 * @param subprocess - Harness's process capability.
 * @param launcher - how to run the launcher.
 * @param args - the arguments after the launcher's own prefix.
 * @param timings - overrides for the bound; defaults are the module constants.
 * @param dshHome - resolved Harness home to restore after managed env scrubbing.
 * @returns the exit code and retained output; never rejects.
 */
export async function spawnCaptured(
  subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>,
  launcher: Launcher,
  args: readonly string[],
  timings: ChildTimings = {},
  dshHome?: string,
): Promise<ChildResult> {
  const timeoutMs = timings.timeoutMs ?? PLUGIN_TIMEOUT_MS
  const killGraceMs = timings.killGraceMs ?? KILL_GRACE_MS
  let command: string
  try {
    command = await subprocess.resolveExecutable(launcher.command)
  } catch (error) {
    return { code: 127, output: `${error instanceof Error ? error.message : String(error)}\n` }
  }
  return new Promise(resolve => {
    const tail = new OutputTail()
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let giveUpTimer: NodeJS.Timeout | undefined
    const settle = (code: number, note?: string): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (giveUpTimer !== undefined) clearTimeout(giveUpTimer)
      if (note !== undefined) tail.push(`\n${note}\n`)
      resolve({ code, output: tail.text() })
    }
    let child: ReturnType<SubprocessRuntime['spawn']>
    try {
      child = subprocess.spawn({
        // Exact argv, never shell syntax: a user-typed package spec remains one
        // argument all the way to `dsh plugin`.
        argv: [command, ...launcher.prefix, ...args],
        cwd: launcher.cwd ?? process.cwd(),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: killGraceMs,
        // Layered onto the seam's scrub by name: package-manager namespaces
        // and the Host-resolved home. Never a wholesale passthrough — see
        // `childEnvironment` for the line this walks.
        env: childEnvironment(dshHome),
      })
    } catch (error) {
      settle(127, error instanceof Error ? error.message : String(error))
      return
    }
    const collect = (chunk: Buffer | string): void => { tail.push(chunk.toString()) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    timer = setTimeout(() => {
      tail.push(`\ndsh: no answer after ${String(Math.round(timeoutMs / 1_000))}s; stopping the child\n`)
      child.terminate()
      giveUpTimer = setTimeout(
        () => { settle(124, 'dsh: the child did not exit after being killed') },
        killGraceMs * 2,
      )
      giveUpTimer.unref()
    }, timeoutMs)
    timer.unref()
    void child.done.then(
      outcome => { settle(outcome.exitCode ?? 1) },
      (error: unknown) => { settle(127, error instanceof Error ? error.message : String(error)) },
    )
  })
}

/**
 * The last few non-empty lines of retained output.
 * @param output - the child's retained output.
 * @returns at most {@link KEPT_OUTPUT_LINES} lines.
 */
function tailLines(output: string): string[] {
  const lines = output.split('\n')
    .map(line => redactOutputLine(line.trimEnd()))
    .filter(line => line.trim() !== '')
  return lines.slice(-KEPT_OUTPUT_LINES)
}

/**
 * Lines that name a reason rather than describing progress.
 *
 * pnpm states its failure in a recognizable form — a bracketed `ERR_PNPM_*`
 * code, an `ERR_*` prefix, or git's own `fatal:` — and buries it above pages of
 * resolution progress. `dsh plugin` adds its own diagnostic on the same
 * shapes.
 */
const REASON_LINE = /\bERR_[A-Z0-9_]*[A-Z0-9]\b|^\s*(?:ERR|error|fatal|npm error)\b/u

/**
 * Lines that only warn.
 *
 * pnpm prints deprecation and peer-dependency warnings around the error, and
 * some carry an `ERR_`-shaped code of their own. Since the reason search takes
 * the LAST match — the summarizing error comes after the attempt that produced
 * it — a trailing warning would otherwise become the headline for a failure it
 * had nothing to do with.
 */
const WARNING_LINE = /^\s*(?:\[WARN\]|WARN\b|warning\b)/u

/**
 * The one line worth putting in the headline of a failure.
 *
 * "exited 1" is true and useless: a mistyped package name and an unreachable
 * git remote both exit 1, and the reader has to act differently on each. The
 * child already said which, so the headline says it too instead of making the
 * reader read the tail to find out what happened.
 * @param output - the child's retained output.
 * @returns the reason, or undefined when the child named none.
 */
export function failureReason(output: string): string | undefined {
  const lines = output.split('\n').map(line => redactOutputLine(line.trim())).filter(line => line !== '')
  // Last match wins: pnpm prints the summarizing error after the attempt that
  // produced it.
  const matched = lines.filter(line => REASON_LINE.test(line) && !WARNING_LINE.test(line))
  const reason = matched.at(-1)
  return reason === undefined ? undefined : reason.slice(0, MAX_REASON_LENGTH)
}

/** A failure headline stays one terminal line's worth of reason. */
const MAX_REASON_LENGTH = 160

/**
 * What a reader has to do about a failure, where pnpm's own error names a
 * decision rather than a mistake.
 *
 * One entry, and a table rather than a branch so it stays one. This is not a
 * pnpm advice engine: it exists because `ERR_PNPM_IGNORED_BUILDS` blocks every
 * operation on a profile until a human answers it, and the answer is a file
 * pnpm has already written placeholders into — so a reader who is told only
 * "ignored build scripts" has no way to know the operation is waiting on them
 * rather than broken. Harness's own `dsh plugin` sets the precedent, printing
 * the same kind of pointer for a git dependency's blocked prepare script.
 *
 * Allowing a build script runs arbitrary install-time code from a dependency,
 * so nothing here answers it: the decision is named, never made.
 */
const PENDING_DECISIONS: Readonly<Record<string, string>> = {
  ERR_PNPM_IGNORED_BUILDS: 'pnpm is waiting on a build decision: set each allowBuilds entry in '
    + "the profile's pnpm-workspace.yaml to true or false, then try again",
}

/**
 * The pending-decision note for a failure, when its reason names one.
 * @param reason - the failure reason, as {@link failureReason} found it.
 * @returns what the reader has to decide, or undefined.
 */
export function pendingDecision(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  for (const [code, note] of Object.entries(PENDING_DECISIONS)) {
    if (reason.includes(code)) return note
  }
  return undefined
}

/**
 * Run one `dsh plugin` invocation against one profile.
 *
 * Never throws: a launcher that is not installed, one the user pointed
 * somewhere wrong, a child that fails, and a child that never answers are all
 * facts about the machine rather than defects in this browser, and each has to
 * reach the reader as an outcome.
 * @param spec - the profile, the operation, and the injectable seams.
 * @returns what happened.
 */
export async function runProfileOperation(spec: ProfileOperationSpec): Promise<ProfileActionOutcome> {
  const { profile, resolved } = spec
  const command = pluginCommand(profile, resolved.args)
  const resolution = (spec.launcher ?? resolveLauncher)()
  if (resolution.kind === 'misconfigured') {
    return { kind: 'failed', message: `${resolution.message} — run this yourself: ${command}`, output: [] }
  }
  if (resolution.kind === 'none') {
    return {
      kind: 'failed',
      message: `the dsh launcher could not be found — run this yourself: ${command}`,
      output: [],
    }
  }
  const args = ['plugin', '--profile', profile, ...resolved.args]
  const subprocess = spec.subprocess
  const run = spec.run ?? (subprocess === undefined
    ? undefined
    : (launcher: Launcher, childArgs: readonly string[]) =>
        spawnCaptured(subprocess, launcher, childArgs, {}, spec.dshHome))
  if (run === undefined) {
    return {
      kind: 'failed',
      message: `the Harness subprocess capability is unavailable — run this yourself: ${command}`,
      output: [],
    }
  }
  const { code, output } = await run(resolution.launcher, args)
  if (code !== 0) {
    const reason = failureReason(output)
    const headline = reason === undefined
      ? `${command} exited ${String(code)}`
      : `${resolved.running} failed: ${reason}`
    const pending = pendingDecision(reason)
    return {
      kind: 'failed',
      message: pending === undefined ? headline : `${headline} — ${pending}`,
      output: tailLines(output),
    }
  }
  return { kind: 'done', message: `${profile}: ${resolved.running} — done`, output: tailLines(output) }
}
