/** Human shell gestures execute through Harness, never through a model tool. */
import type { Session } from '@deepseek-ai/dsh-session'
import type { ShellExecutor, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Composer } from '@dshline/renderer'
import { escapeControls, paint } from '@dshline/renderer'
import type { ShellOutput } from './shell-output.ts'

/** UI polling trades bounded redraw latency for not requiring an upstream feed. */
const POLL_MS = 50
/** Bound stdout capture/re-read work; stderr retains the executor's own cap. */
const STDOUT_MAX_BYTES = 64_000
/** Status/error details are diagnostic, not an unbounded second output stream. */
const ERROR_CODE_UNITS = 4096

/** The character that makes a line a human shell gesture rather than a prompt. */
const BANG = '!'

/**
 * Detect a leading meaningful ! without trimming shell source or trailing spaces.
 * @param text - original composer buffer.
 * @returns source after only !, including blank source, or undefined for prose.
 */
export function parseShellCommand(text: string): string | undefined {
  const meaningful = text.trimStart()
  return meaningful.startsWith(BANG) ? meaningful.slice(1) : undefined
}

/**
 * Whether a composer's CURRENT DRAFT is a human shell gesture.
 *
 * The same question {@link parseShellCommand} answers, asked of the live buffer
 * rather than of a submitted line, so the composer can SHOW the mode that
 * pressing enter is about to select. Routing and presentation cannot disagree
 * about what a `!` means, because both ask for the buffer's first non-whitespace
 * character and `trimStart()` is what strips that run: the answer here is
 * character-for-character what `parseShellCommand(composer.value)` would say
 * about the same buffer.
 *
 * It reads that one character instead of the whole draft, which is what keeps
 * the frame free on a keystroke: {@link Composer.leadingNonWhitespaceChar} stops
 * at the first character that is not whitespace, so a buffer holding a folded paste
 * of a hundred thousand characters costs the same as an empty one.
 * @param composer - the buffer being edited.
 * @returns whether submitting this draft would execute a local shell command.
 */
export function isShellDraft(composer: Composer): boolean {
  return composer.leadingNonWhitespaceChar === BANG
}

function errorRows(error: unknown): string[] {
  let detail = 'unprintable failure'
  try { detail = String(error) } catch { /* A rejection value must not break cleanup. */ }
  let end = Math.min(detail.length, ERROR_CODE_UNITS)
  const last = detail.charCodeAt(end - 1)
  if (end < detail.length && last >= 0xd800 && last <= 0xdbff) end -= 1
  return detail.slice(0, end).split('\n').map(line => paint(`✗ shell: ${escapeControls(line)}`, 'error'))
}

function statusRows(result: ShellRunResult, handle: ShellExecution, signal: AbortSignal): string[] {
  // A requested interrupt remains truthful even if direct exit won the race.
  if (signal.aborted || result.aborted) return [paint('[shell interrupted]', 'warning')]
  if (result.sandbox?.runnerFailed || handle.sandbox?.runnerFailed) return [paint('✗ shell sandbox runner failed', 'error')]
  if (result.sandbox?.denied || handle.sandbox?.denied) return [paint('✗ shell sandbox denied the operation', 'error')]
  if (result.timedOut) return [paint('[shell timed out]', 'warning')]
  if (result.signal !== null) return [paint(`[shell terminated by ${escapeControls(result.signal)}]`, 'warning')]
  if (handle.status === 'killed') return [paint('[shell killed]', 'warning')]
  if (result.exitCode === 0) return [paint('[shell exit 0]', 'success')]
  return [paint(`✗ shell exit ${result.exitCode === null ? 'unknown' : String(result.exitCode)}`, 'error')]
}

/**
 * Execute one foreground, non-PTY command under the attached Session's policy.
 * The caller echoes source, owns cancellation and Session lifetime, and finally
 * aborts its per-run signal to request cleanup of any retained managed range.
 * @param options - execution authority, original shell source and UI callbacks.
 * @returns terminal-safe status/error logical rows only, never collected output.
 */
export async function runShellCommand(options: {
  command: string
  shell: Pick<ShellExecutor, 'sandboxMode' | 'resolve' | 'execute'> | undefined
  sandboxPolicy: Pick<SandboxPolicyService, 'resolve'> | undefined
  session: Session
  workdir: string
  signal: AbortSignal
  output: ShellOutput
  changed: () => void
}): Promise<string[]> {
  const { command, shell, sandboxPolicy, session, workdir, signal, output, changed } = options
  if (shell === undefined) return [paint('✗ shell capability is unavailable', 'error')]
  if (shell.sandboxMode !== undefined && sandboxPolicy === undefined) {
    return [paint('✗ shell sandbox policy is unavailable; command not run', 'error')]
  }
  let handle: ShellExecution | undefined
  let result: Promise<{ value: ShellRunResult } | { error: unknown }> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    signal.throwIfAborted()
    const policy = sandboxPolicy?.resolve({ session })
    const spec = shell.resolve({ command, workdir, signal, onExpiry: 'none', stdoutMaxBytes: STDOUT_MAX_BYTES, sandboxPolicy: policy })
    signal.throwIfAborted()
    handle = await shell.execute(spec)
    // Request and contain result immediately: classification is captured now,
    // not after a later caller abort changes the executor's first-cause facts.
    result = handle.result().then(value => ({ value }), (error: unknown) => ({ error }))
    let ended = false
    const done = handle.done.then(() => { ended = true })
    output.poll(handle.observed)
    changed()
    while (!ended) {
      await Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, POLL_MS) })])
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (!ended) {
        output.poll(handle.observed)
        changed()
      }
    }
    output.poll(handle.observed, true)
    output.flush()
    changed()
    const settled = await result
    if ('error' in settled) {
      if (signal.aborted) return [paint('[shell interrupted]', 'warning')]
      // The sandbox executor rejects its result projection for runner failures,
      // but publishes the classification on the handle before done settles.
      const failure = errorRows(settled.error)
      return handle.sandbox?.runnerFailed === true
        ? [paint('✗ shell sandbox runner failed', 'error'), ...failure]
        : failure
    }
    return statusRows(settled.value, handle, signal)
  } catch (error) {
    // A failed reader/Screen callback cannot leave a live handle unowned.
    if (handle !== undefined) {
      try { handle.kill() } catch { /* Preserve the original UI/provider failure. */ }
      await handle.done
      if (result !== undefined) await result
    }
    return signal.aborted ? [paint('[shell interrupted]', 'warning')] : errorRows(error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
