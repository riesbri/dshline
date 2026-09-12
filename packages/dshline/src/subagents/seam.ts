/**
 * The narrow Harness surfaces the subagent-conversation presenter consumes.
 *
 * This module exists to make the authority boundary a TYPE rather than a
 * convention. `ctx.subagents` is a `SubagentRuntime`, which also publishes
 * `sendMessage(sender: Agent, …)` — model-authored adjacent-Agent messaging,
 * not a human path. Picking only the two operations a human terminal may call
 * means a future edit that reaches for `sendMessage` fails `pnpm typecheck`
 * instead of silently impersonating the parent Agent.
 *
 * It is deliberately not a `Pick` of the whole runtime: `listDescendants` is
 * absent because this PR browses direct children only, and `interrupt` is
 * absent because the durable view must not offer it — `listChildren().activity`
 * is session-store residency, not proof a turn is executing, so a durable
 * inspector cannot tell a real cancellation from Harness's accepted no-op.
 * Interrupt stays on `/work`, where an open lifecycle epoch is the premise.
 *
 * The child-session read surface is likewise structural: only the two bounded
 * reads the inspector uses, never `readSession` (a whole-log read) and never a
 * provider API.
 * @module dshline/subagents/seam
 */

import type { SessionEventRecord } from '@deepseek-ai/dsh-session-query'
import type { SessionEventReadRequest, SessionEventWindow } from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

/**
 * The human-authoritative subset of `ctx.subagents` a terminal may call.
 *
 * `listChildren` is the durable direct-child discovery; `prompt` is Harness's
 * browser/human control operation, which owns direct-parent authorization,
 * continuable-child validation, Queue versus Steer scheduling, human
 * provenance, cold materialization, and the accepted `MessageId` receipt.
 */
export type HumanSubagentSeam = Pick<SubagentRuntime, 'listChildren' | 'prompt'>

/**
 * The bounded session reads the conversation inspector performs.
 *
 * `listEvents` supplies the lightweight seq index that locates the tail page;
 * `readEvent` supplies one bounded window of full event bodies around a target
 * seq. Neither publishes an Agent or resumes the child.
 */
export interface ChildSessionReads {
  /**
   * List lightweight records for one session, in ascending seq order.
   * @param sessionId - the durable child session to index.
   * @returns the event metadata, without bodies.
   */
  listEvents(sessionId: SessionId): Promise<SessionEventRecord[]>
  /**
   * Read one target event plus a bounded raw-log window around it.
   * @param request - the session, target seq, and window bounds.
   * @param signal - optional cancellation.
   * @returns the bounded window of full event bodies.
   */
  readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow>
}
