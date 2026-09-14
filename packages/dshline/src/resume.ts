/**
 * Rebuilding a past session's transcript from the live Session it was resumed on.
 *
 * Two halves that are easy to conflate. Resuming the AGENT is one harness call —
 * `ctx.agents.resume` opens the persisted log, repairs an interrupted final turn,
 * constructs the live Session, publishes it, and hands back the owned
 * `AgentHandle` — and choosing WHICH session belongs to `./sessions`. Rebuilding
 * the transcript is this module's whole job, and it reads that owned Session
 * rather than asking a second service to reload the same history: the handle's
 * `agent.session` already holds the repaired log, so one stable
 * `snapshotEvents()` is the authority for what this attachment last did, and a
 * later append belongs to the attachment's live event listener instead.
 *
 * `ctx.sessionQuery` remains the authority for the logical corpus — the sessions
 * browser, worktrees, subagent inspection, search, and lineage — where there is
 * no owned AgentHandle to read. It is deliberately NOT consulted here.
 *
 * NOT the model-visible surface. `foldSurface` deliberately shadows ranges that a
 * compaction replaced, so folding it would erase conversation the user already
 * read — the reply is gone from the model's history but it was still said. The
 * durable source for a human transcript is append-origin events, which is what
 * `isAppendSurfaceEvent` narrows to.
 *
 * That narrowing covers only the surface types, so tool CALLS would be dropped
 * with it — and a result card needs its call's arguments to render. The rule is
 * therefore stated the other way round: a surface-eligible event replays only
 * when it was an append, and everything else replays as it is.
 *
 * There is exactly one rule, and no Assistant special case inside it. The log's
 * Assistant records are settlements: `assistant/message` is the reply, and it is
 * a surface event this rule already governs. An `assistant/attempt` is log-only
 * — one model attempt that committed no reply — so it replays like any other
 * log-only event and the projection gives it no lines, which is where that fact
 * is written down.
 *
 * `system/message` is the fourth surface type and is governed by exactly the
 * same rule, deliberately and with no exception added for it. Session format V3
 * made the rendered system prompt durable conversation history — surface node 0,
 * plus any in-history change, plus the logged replacements that normalize them —
 * so the appends pass this gate and the replacements do not. Neither reaches the
 * terminal, because `projectEvent` gives a system prompt no lines: it is the
 * deployment's standing instructions, not something anybody said in this
 * conversation, and printing it would open every resumed transcript with a wall
 * of prompt the reader never wrote. `/context` is where it is inspectable, named
 * as the surface node it now is.
 * @module dshline/resume
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import { paint } from '@dshline/renderer'

/**
 * Whether an event belongs in a human transcript.
 *
 * A replacement copy is model-only: it exists so a compacted history still reads
 * correctly to the model — or, for a `system/message`, so a normalized prompt
 * still reads correctly to it — and replaying one would show the user a summary
 * in place of the exchange it summarised. Everything that is not
 * surface-eligible — a tool call, a turn ending — has no replacement semantics
 * and simply replays.
 * @param event - one raw log event.
 * @returns whether to project it.
 */
export function isTranscriptEvent(event: SessionEvent): boolean {
  if (!isSurfaceEvent(event)) return true
  return isAppendSurfaceEvent(event)
}

/**
 * Read a resumed attachment's history from the Session its Agent owns.
 *
 * One stable whole-log snapshot, filtered by {@link isTranscriptEvent}. Taking
 * the snapshot once fixes the historical prefix: an event appended after it is
 * the attachment's live `session/event` listener's to present, never a moving
 * replay scan's. `snapshotEvents()` is synchronous and frozen, so no await
 * separates the listener's registration from this read and nothing can be both
 * replayed and delivered live.
 * @param session - the live Session held by the attached AgentHandle.
 * @returns the events a human transcript replays.
 */
export function transcriptEvents(session: Session): readonly SessionEvent[] {
  return session.snapshotEvents().filter(isTranscriptEvent)
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
