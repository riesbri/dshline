/**
 * Rebuilding a past session's transcript.
 *
 * Two halves that are easy to conflate. Resuming the AGENT is one harness call —
 * `ctx.agents.resume` needs only the session id, and takes the workspace from the
 * persisted header; choosing WHICH session belongs to `./sessions`. Rebuilding
 * the transcript is this module's whole job, and the rule that matters is which
 * events it replays.
 *
 * NOT the model-visible surface. `foldSurface` deliberately shadows ranges that a
 * compaction replaced, so folding it would erase conversation the user already
 * read — the reply is gone from the model's history but it was still said. The
 * durable source for a human transcript is append-origin events, which is what
 * `isAppendSurfaceEvent` narrows to.
 *
 * That narrowing covers only the three surface types, so tool CALLS would be
 * dropped with it — and a result card needs its call's arguments to render. The
 * rule is therefore stated the other way round: a surface-eligible event replays
 * only when it was an append, and everything else replays as it is.
 * @module dshline/resume
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { paint } from '@dshline/renderer'

/**
 * Whether an event belongs in a human transcript.
 *
 * A replacement copy is model-only: it exists so a compacted history still reads
 * correctly to the model, and replaying it would show the user a summary in place
 * of the exchange it summarised. Everything that is not surface-eligible — a tool
 * call, a turn ending — has no replacement semantics and simply replays.
 * @param event - one raw log event.
 * @returns whether to project it.
 */
export function isTranscriptEvent(event: SessionEvent): boolean {
  if (!isSurfaceEvent(event)) return true
  return isAppendSurfaceEvent(event)
}

/**
 * Read a past session's log.
 * @param ctx - context carrying the session query engine.
 * @param sessionId - the session to read.
 * @returns its raw events, or an empty list when the log cannot be read.
 */
export async function readTranscript(ctx: Context, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return []
  const snapshot = await query.readSession(sessionId)
  return snapshot.events
}

/**
 * The banner shown above a replayed transcript.
 * @param count - how many events were replayed.
 * @returns lines to commit before the transcript.
 */
export function resumeBanner(count: number): string[] {
  return count === 0
    ? ['', paint('· resumed an empty session', 'muted')]
    : ['', paint(`· resumed — ${String(count)} earlier events`, 'muted')]
}
