/**
 * Resolving "which session" into an attached Agent, including when it fails.
 *
 * The failure is the reason this is its own module. Reopening happens AFTER the
 * previous agent has been retired, so a rejected `ctx.agents.resume` leaves the
 * window holding a terminal and no session. Two answers were plausible and one
 * is wrong: substituting a fresh empty session is *quiet*, but the reader asked
 * to reopen a conversation, and a new session in the launch directory is not a
 * smaller version of that — it is a different thing wearing its place. So the
 * reason is committed and the browser is opened again, which is the same
 * question the launch path asks and leaves the reader in control. Dismissing it
 * is how they choose a new session, deliberately.
 *
 * A failed launch-time `create` is deliberately NOT caught. There is nothing to
 * fall back to and nothing to ask; it belongs on the runner's boot-failure path.
 * An in-window `/new` is different: its target carries the attachment's current
 * workspace, so failure is reported and the same browser asks what to do next.
 *
 * Narrowed to two calls and two callbacks so the policy is testable without a
 * plugin tree or a terminal.
 * @module dshline/sessions/reopen
 */

import type { AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { escapeControls, paint } from '@dshline/renderer'

/** Which session the next attachment drives. */
export type AttachTarget =
  /**
   * Open a fresh session. `afterDismissal` marks the one case worth a note: the
   * window asked which session to open and the reader chose none, where silence
   * would read as the request having been ignored. `cwd` is present on a live
   * attachment's `/new` transition and any fresh retry after it: it preserves
   * that attachment's workspace and distinguishes recoverable creation from boot.
   * `clearDisplay` is the same recovery applied to PRESENTATION: an in-window
   * `/clear` carries the intent to begin this fresh session on an emptied
   * visible display, and the next attachment wipes only after create succeeded.
   *
   * A `/worktrees` transition is one of these and carries nothing extra: the
   * directory IS the whole request, because Harness stamps it into the new
   * session's immutable header and that header is what any later grouping
   * reads. There is no membership to record and no domain identity for this
   * module to carry.
   */
  | {
    readonly kind: 'new'
    readonly afterDismissal?: boolean
    readonly cwd?: string
    readonly clearDisplay?: boolean
  }
  /** Reopen this persisted session. */
  | { readonly kind: 'resume'; readonly id: SessionId }

/**
 * Whether attaching to this target begins on an emptied visible display.
 *
 * True only for a fresh transition that carried `/clear`'s presentation
 * intent. A resumed session replays its own transcript, and a plain `/new`
 * stays indistinguishable from today's target. The wipe itself is performed
 * by the new attachment once create has succeeded — never by the attachment
 * being left — so a failed or resumed transition cannot destroy context it
 * never earned.
 * @param target - the transition the next attachment will drive.
 * @returns true when the fresh session's banner opens on a cleared display.
 */
export function shouldClearDisplay(target: AttachTarget): boolean {
  return target.kind === 'new' && target.clearDisplay === true
}

/** The exact `ctx.agents` factory surface a window uses to attach. */
export interface AgentOpener {
  /** Create a new agent on a caller-supplied session id. */
  create(options: CreateAgentOptions): Promise<AgentHandle>
  /** Load a persisted session and resume an agent on it. */
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}

/** The agent a window ended up attached to. */
export interface Attached {
  /**
   * The owned handle.
   *
   * Kept, not discarded: its disposer is the capability that makes reopening a
   * session possible at all, and this runner used to throw it away.
   */
  readonly handle: AgentHandle
  /** Whether a persisted session was reopened, so its transcript should replay. */
  readonly reopened: boolean
}

/** What resolving a target needs from the window. */
export interface AttachSpec {
  /** The `ctx.agents` factory surface. */
  readonly agents: AgentOpener
  /** Mint the id for a new session; called only when one is created. */
  readonly newSessionId: () => SessionId
  /** Startup workspace for a new target that does not carry one of its own. */
  readonly cwd: string
  /**
   * The preset a new session's header records at creation, when a preset
   * roster is mounted; called only when one is created. A resumed session
   * needs no equivalent — its header already carries whatever it was created
   * with, and Harness's `agentPreset` Session projection folds that with any
   * later `agent-preset/selected` event, read inside `setup(agentCtx)`, not
   * here.
   */
  readonly newSessionPreset: () => string | undefined
  /** Route and setup shared by both paths, read at attach time. */
  readonly options: Omit<ResumeAgentOptions, 'resumeSessionId'>
  /** Say which attachment operation failed, in the transcript, before asking again. */
  readonly report: (kind: 'new' | 'resume', reason: string) => void
  /** Ask which session to open; dismissal answers `{ kind: 'new' }`. */
  readonly ask: () => Promise<AttachTarget>
}

/** The attached agent and the target it actually came from. */
export interface AttachOutcome {
  /** The target that succeeded, which may not be the one first requested. */
  readonly target: AttachTarget
  /** The agent now attached. */
  readonly attached: Attached
}

/**
 * The lines a failed reopen commits before the browser is asked again.
 *
 * Red, and named as the frontend's own report rather than a transcript event:
 * the reader asked for one session and is about to be asked to choose again, and
 * "no session appeared" with no reason is the failure mode this avoids.
 * @param reason - Harness's own message; untrusted, so it is escaped here.
 * @returns lines to write into scrollback.
 */
export function reopenFailureLines(reason: string): string[] {
  return [
    paint(`✗ could not reopen that session: ${escapeControls(reason)}`, 'error'),
    paint('· choose another, or press esc for a new session', 'muted'),
  ]
}

/**
 * The lines a failed in-window `/new` commits before the browser is asked again.
 * @param reason - Harness's own message; untrusted, so it is escaped here.
 * @returns lines to write into scrollback.
 */
export function newSessionFailureLines(reason: string): string[] {
  return [
    paint(`✗ could not start a new session: ${escapeControls(reason)}`, 'error'),
    paint('· choose a session, or press esc to try fresh again', 'muted'),
  ]
}

/** A fresh target and the recovery fields a failed transition keeps alive. */
interface FreshRecovery {
  /** The workspace the retired attachment was rooted in. */
  readonly cwd: string
  /** `/clear`'s presentation intent, when the first target carried it. */
  readonly clearDisplay: boolean | undefined
}

/**
 * Fold the recovery fields into a fresh target.
 *
 * One place rather than three. The direct path, the retry after a failed
 * create, and the retry after a failed resume all mean the same thing, and
 * three inline spreads of the same field list is how one of them silently
 * stops carrying a field the other two do. Both fields belong to the ORIGINAL
 * request rather than to the browser dismissal that followed it, which is why
 * the recovery wins over whatever the chosen fresh target carried.
 * @param fresh - the fresh target being attached or retried.
 * @param recovery - the fields the failed transition kept alive.
 * @returns the target to attach, or record as attached.
 */
function withRecovery(
  fresh: Extract<AttachTarget, { readonly kind: 'new' }>,
  recovery: FreshRecovery,
): AttachTarget {
  return {
    ...fresh,
    cwd: recovery.cwd,
    ...(recovery.clearDisplay === undefined ? {} : { clearDisplay: recovery.clearDisplay }),
  }
}

/**
 * Resolve a target into an attached agent, asking again while reopening fails.
 *
 * Loops on the reader's answer, not on its own: every failure is reported and
 * re-asked, and dismissing the browser ends it by creating a new session. A
 * deployment whose persistence is broken therefore reaches a usable window in
 * one keystroke instead of either spinning or dying.
 * @param spec - the factory surface and the window's report/ask callbacks.
 * @param first - the target to try before asking anything.
 * @returns the attached agent and the target it came from.
 */
export async function attachTarget(spec: AttachSpec, first: AttachTarget): Promise<AttachOutcome> {
  let target = first
  // Kept across reader choices after a failed `/new`: choosing a broken resume
  // and then trying fresh must not quietly fall back to the launch directory.
  const recoveryCwd = first.kind === 'new' ? first.cwd : undefined
  // `/clear`'s presentation intent survives the same recovery as the
  // workspace: a failed create whose reader retries fresh is still the same
  // request, and the retried fresh session should still open on a cleared
  // display. A resume choice drops it, which is why it is folded into a
  // fresh target only.
  const recoveryClear = first.kind === 'new' ? first.clearDisplay : undefined
  const recovery = (cwd: string): FreshRecovery => ({ cwd, clearDisplay: recoveryClear })
  for (;;) {
    if (target.kind === 'new') {
      const preset = spec.newSessionPreset()
      const cwd = target.cwd ?? recoveryCwd ?? spec.cwd
      try {
        const handle = await spec.agents.create({
          sessionId: spec.newSessionId(),
          meta: { cwd, ...preset === undefined ? {} : { agentPreset: preset } },
          ...spec.options,
        })
        // A retried fresh target was already merged with the recovery fields at
        // the catch below; this merge covers the direct path where the first
        // attempt succeeded after a target reassignment. Session metadata is
        // deliberately untouched: `clearDisplay` is presentation, and must not
        // leak into the session record.
        const attachedTarget = target.cwd === undefined && recoveryCwd !== undefined
          ? withRecovery(target, recovery(recoveryCwd))
          : target
        return { target: attachedTarget, attached: { handle, reopened: false } }
      } catch (error: unknown) {
        // No cwd means application boot or a normal browser dismissal. Those
        // failures still belong to the runner's boot-failure path; only `/new`
        // has already retired a healthy attachment and has somewhere to return.
        if (recoveryCwd === undefined) throw error
        spec.report('new', error instanceof Error ? error.message : String(error))
        const chosen = await spec.ask()
        target = chosen.kind === 'new' ? withRecovery(chosen, recovery(recoveryCwd)) : chosen
        continue
      }
    }
    try {
      const handle = await spec.agents.resume({ resumeSessionId: target.id, ...spec.options })
      return { target, attached: { handle, reopened: true } }
    } catch (error: unknown) {
      // Deliberately not narrowed to one error class. Reopening can fail because
      // persistence is unmounted, because the log fails replay validation, or
      // because a header is from an incompatible format version, and the reader's
      // next move is the same for all of them.
      spec.report('resume', error instanceof Error ? error.message : String(error))
      const chosen = await spec.ask()
      target = chosen.kind === 'new' && recoveryCwd !== undefined
        ? withRecovery(chosen, recovery(recoveryCwd))
        : chosen
    }
  }
}
