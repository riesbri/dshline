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
 * cancels the opening; it is not permission to create a replacement session.
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
   * Open a fresh session only on normal-launch or explicit new-session intent.
   * `cwd` is present on a live attachment's `/new` transition: it preserves
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
   * later `agent-preset/selected` event, read inside `setup(agentCtx, agent)`, not
   * here.
   */
  readonly newSessionPreset: () => string | undefined
  /** Route and setup shared by both paths, read at attach time. */
  readonly options: Omit<ResumeAgentOptions, 'resumeSessionId'>
  /** Say which attachment operation failed, in the transcript, before asking again. */
  readonly report: (kind: 'new' | 'resume', reason: string) => void
  /** Ask which persisted session to open; dismissal cancels the opening. */
  readonly ask: () => Promise<Extract<AttachTarget, { kind: 'resume' }> | undefined>
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
    paint('· choose another session, or close the browser to exit', 'muted'),
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
    paint('· choose a session, or close the browser to exit', 'muted'),
  ]
}

/**
 * Resolve a target into an attached agent, asking again while reopening fails.
 *
 * Every retry requires another selected session. Cancelling the browser leaves
 * the window unattached; the loop owns exiting, not a fallback creation here.
 * @param spec - the factory surface and the window's report/ask callbacks.
 * @param first - the target to try before asking anything.
 * @returns the attached agent and target, or undefined when opening was cancelled.
 */
export async function attachTarget(spec: AttachSpec, first: AttachTarget): Promise<AttachOutcome | undefined> {
  let target: AttachTarget | undefined = first
  while (target !== undefined) {
    if (target.kind === 'new') {
      const preset = spec.newSessionPreset()
      const cwd = target.cwd ?? spec.cwd
      try {
        const handle = await spec.agents.create({
          sessionId: spec.newSessionId(),
          meta: { cwd, ...preset === undefined ? {} : { agentPreset: preset } },
          ...spec.options,
        })
        return { target, attached: { handle, reopened: false } }
      } catch (error: unknown) {
        // Normal launch has no previous attachment; its creation failure still
        // belongs to the runner's boot-failure path.
        if (target.cwd === undefined) throw error
        spec.report('new', error instanceof Error ? error.message : String(error))
        target = await spec.ask()
        continue
      }
    }
    try {
      const handle = await spec.agents.resume({ resumeSessionId: target.id, ...spec.options })
      return { target, attached: { handle, reopened: true } }
    } catch (error: unknown) {
      // Persistence, replay validation, and setup failures all belong to Harness;
      // report its reason rather than pretending a fresh Session repairs it.
      spec.report('resume', error instanceof Error ? error.message : String(error))
      target = await spec.ask()
    }
  }
  return undefined
}
