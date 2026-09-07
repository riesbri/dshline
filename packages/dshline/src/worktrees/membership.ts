/**
 * Recording a fresh session's Workspace membership, after it exists.
 *
 * Its own module for one reason: the runner's loop needs it on the boot path,
 * and `./index.ts` pulls in the picker's whole module graph — catalog,
 * overlay, model — which is one command's UI and is imported on demand like
 * `/plugins` and `/sessions` are. So the seam call and the two lines it may
 * commit live here, where a boot that never opens `/worktrees` pays for
 * nothing but a type-only Harness import.
 *
 * The ordering it enforces is Harness's own session controller's: resolve the
 * Workspace, create the Session with `cwd = workspace.path`, and only then
 * attach. Membership is never written before a successful creation, and a
 * failed attach never unwinds a successful creation.
 * @module dshline/worktrees/membership
 */

import type { Context } from '@deepseek-ai/cordis'
import { escapeControls, paint } from '@dshline/renderer'
import type { AttachOutcome } from '../sessions/reopen.ts'
import { recordWorkspaceMembership } from './harness.ts'

/**
 * The lines a Workspace membership write commits when it did not land.
 *
 * Reported rather than repaired, and never by destroying the session: the
 * reader asked for a conversation in a directory and got exactly that, so
 * deleting it to make the frontend's bookkeeping look atomic would throw away
 * the only thing that succeeded. Harness's own session controller makes the
 * same choice — it raises `session/workspace-attach-failed` naming both ids
 * and keeps the session — and the consequence is stated plainly, because a
 * session missing from a workspace's account is exactly the row a reader will
 * look for here next time.
 * @param reason - Harness's own message; untrusted, so it is escaped here.
 * @returns lines to write into scrollback.
 */
export function membershipFailureLines(reason: string): string[] {
  return [
    paint(`✗ the session started, but Harness did not record it under that worktree: ${escapeControls(reason)}`, 'error'),
    paint('· the conversation is fine; it may not be listed under that worktree in /worktrees', 'muted'),
  ]
}

/**
 * Record a fresh attachment's Workspace membership, once creation succeeded.
 *
 * Every no-op case is silent on purpose. A target with no `workspaceId` did
 * not come from `/worktrees`; a resumed session already carries whatever
 * membership Harness recorded for it and must never be re-rooted; and a
 * profile with no registry has nothing to record. Only a real refusal is
 * reported.
 * @param ctx - context that may carry the Workspace registry.
 * @param outcome - the target that actually succeeded, and its agent.
 * @param commit - write finished rows into the terminal's scrollback.
 * @returns when the write has settled, or immediately when there is none.
 */
export async function recordAttachmentMembership(
  ctx: Context,
  outcome: AttachOutcome,
  commit: (lines: readonly string[]) => void,
): Promise<void> {
  const { target } = outcome
  if (target.kind !== 'new' || target.workspaceId === undefined) return
  const result = await recordWorkspaceMembership(
    ctx,
    target.workspaceId,
    outcome.attached.handle.agent.session.id,
  )
  if (result.kind === 'failed') commit(membershipFailureLines(result.message))
  // A workspace that left the registry between the choice and the creation is
  // a refusal too, and one a reader would otherwise never hear about.
  else if (result.kind === 'unknown') {
    commit(membershipFailureLines('that workspace is no longer in the Harness registry'))
  }
}
