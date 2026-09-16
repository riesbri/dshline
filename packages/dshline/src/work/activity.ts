/**
 * Per-child semantic activity for Work rows.
 *
 * A live in-process subagent exposes a real child Agent, so its activity can be
 * folded with the exact vocabulary the main status line uses: the lifecycle
 * phase from its session events, live model output from its own
 * `agent/assistant-stream` frames, and the tool activity from its pending
 * calls' presentations. A remote run without a local Agent exposes none of
 * those, and the observer simply never attaches — the row then shows no
 * invented activity.
 *
 * From those same frames the observer also keeps a strictly bounded,
 * transient tail of the newest assistant TEXT, for the detail stage to show
 * that the child is answering rather than merely running. It is never a
 * transcript, is cleared on every attempt and turn boundary, and is dropped
 * with the observer.
 * @module dshline/work/activity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { modelPhaseAfter, modelPhaseAfterFrame, primaryActivity } from '../activity.ts'
import type { ActivityWord, ModelPhase } from '../activity.ts'
import { AssistantStreamAttemptGate } from '../assistant-attempt-gate.ts'
import { PendingToolCalls } from '../tool-pending.ts'

/**
 * How many UTF-16 code units of the newest assistant text a Work row keeps.
 *
 * A Work detail fact is one physical row and the widest Work frame is 100
 * columns, so its content budget is under ~98 display columns. A CJK code
 * point is one UTF-16 code unit and two columns, and an astral code point is
 * two code units and two columns, so 256 code units is safely more than any one
 * row can display. Retention is capped at that many code units regardless of
 * total answer length: enough recent text for the row, bounded independently of
 * the response, and deliberately not a durable transcript.
 */
export const OUTPUT_TAIL_LIMIT = 256

/**
 * Reduce `text` to its newest `limit` UTF-16 code units, repairing the front boundary.
 *
 * A plain `slice(-limit)` can cut between the high and low surrogate of one
 * astral code point, leaving the retained string beginning with an orphaned low
 * surrogate. A delta at the exact cap can begin that way too, when the high half
 * arrived in text already discarded. So the front boundary is checked even when
 * no length cut is otherwise required, and a leading low surrogate is dropped.
 * Only that boundary is repaired: the rest is copied verbatim, so this is not a
 * guarantee that arbitrary provider input is well-formed UTF-16 throughout.
 * @param text - the text to reduce to its newest suffix.
 * @param limit - the retention cap in UTF-16 code units.
 * @returns the newest suffix, at most `limit` units and never beginning with a low surrogate.
 */
function newestWithin(text: string, limit: number): string {
  if (limit <= 0) return ''
  let start = Math.max(0, text.length - limit)
  const first = text.charCodeAt(start)
  // Drop the orphaned low half of a code point split by retention or by discard.
  if (first >= 0xdc00 && first <= 0xdfff) start += 1
  return text.slice(start)
}

/**
 * Append one streamed text delta to a bounded Work output tail.
 *
 * Retention stays capped at `limit` UTF-16 code units regardless of answer
 * length, and the newest text always wins. A delta at least as long as the cap
 * is reduced to its OWN newest suffix before the prior tail is considered, so a
 * single huge provider delta never has the old tail concatenated onto it. A
 * smaller delta is joined to the prior tail, and that intermediate is under
 * twice the cap because the prior tail is already bounded. The retained front
 * boundary is surrogate-safe, so retention cannot leave half an astral code
 * point. This stores recent text only; display-width truncation stays in the
 * renderer.
 * @param current - the currently retained tail.
 * @param delta - the newest streamed text fragment.
 * @param limit - the retention cap in UTF-16 code units.
 * @returns the new retained tail, at most `limit` units.
 */
export function appendOutputTail(current: string, delta: string, limit = OUTPUT_TAIL_LIMIT): string {
  if (limit <= 0) return ''
  // Only the delta's own suffix can survive a delta this long, so the prior
  // tail is discarded WITHOUT being concatenated to the whole incoming delta.
  if (delta.length >= limit) return newestWithin(delta, limit)
  return newestWithin(current + delta, limit)
}

/** The live activity facts a Work row may truthfully present. */
export interface ChildActivityReading {
  /**
   * The semantic word; present only while the live child Agent is observed.
   * `waiting` is the honest reading for a resident child between turns.
   */
  readonly word?: ActivityWord
  /** The newest pending call's presentation title, when its tool declared one. */
  readonly title?: string
  /**
   * The newest streamed assistant text of the current attempt; absent when
   * there is none. Never a durable transcript, and cleared at every attempt,
   * turn, and observer boundary.
   */
  readonly outputTail?: string
  /** Whether the live Agent is running, which drives the row's spinner. */
  readonly busy: boolean
  /** The live Agent's published status, for the detail stage. */
  readonly status?: AgentStatus
}

/**
 * The events of the child's CURRENT open turn, or nothing.
 *
 * A child session may already hold history when the observer attaches: a
 * cold-resumed child opens with its whole persisted log, and a forked or
 * subagent child opens with a parent-log prefix in front of its own work.
 * Only the events after the LAST turn boundary can be current activity — a
 * `turn/end` closes the previous turn even when it ended in an abort or an
 * error, so this suffix is authoritative even directly after an interrupted
 * pre-resume turn.
 *
 * Two facts about the adopted Session model shape how it is read.
 *
 * The floor is {@link Session.inheritedEventCount}, the DURABLE fork-lineage
 * cut, and deliberately NOT `firstLiveSeq` — the two answer different
 * questions. `firstLiveSeq` is the length of the constructor seed, so for a
 * cold-resumed child it covers that child's whole stored log, own work
 * included: using it as the floor would hide exactly the turn `/work` exists
 * to describe. `inheritedEventCount` keeps the original fork value across that
 * resume, which is the boundary that actually separates the parent's history
 * from the child's. Everything above it is the child's, its own setup writes
 * (delegated policy overrides, its descriptor) included; nothing below it is.
 * Harness refuses to fork inside an open turn, so a child's open turn can
 * never begin in inherited history and this floor can never truncate a real
 * one.
 *
 * The read is a bounded backward scan of point reads rather than
 * `snapshotEvents()`: the open-turn suffix is short even when the child's log
 * is long, and materializing the whole log to slice a tail off it would make
 * attaching an observer cost the child's entire history.
 * @param session - the child's live session.
 * @returns the open-turn suffix in log order, or an empty list when no turn is underway.
 */
function openTurnSuffix(session: Session): readonly SessionEvent[] {
  const suffix: SessionEvent[] = []
  for (let seq = session.seq - 1; seq >= session.inheritedEventCount; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) break
    if (event.type === 'turn/start' || event.type === 'turn/end') break
    suffix.push(event)
  }
  return suffix.reverse()
}

/**
 * Observe one child Agent's semantic activity until its run epoch ends.
 *
 * Subscribed on the runner's own agent context with exact identity filters —
 * the same listener surface the main status uses, where scope admission already
 * reaches descendant sessions and agents. Everything is event-driven: no timer
 * exists here, and disposal is synchronous, so a replaced Agent under the same
 * durable id can never mutate this epoch's state.
 */
export class ChildActivityObserver {
  private phase: ModelPhase = 'waiting'
  /**
   * The newest assistant text of the current attempt, bounded to
   * {@link OUTPUT_TAIL_LIMIT} code units. Transient presentation only.
   */
  private output = ''
  /** The shared attempt-identity gate, so a stale frame is never folded. */
  private readonly attempt = new AssistantStreamAttemptGate()
  private readonly pending: PendingToolCalls
  private readonly disposers: (() => void)[] = []
  private disposed = false
  private status: AgentStatus | undefined

  /**
   * @param ctx - the context to subscribe on (the Work runner's agent context).
   * @param child - the exact live child Agent this epoch observes.
   * @param resolveTool - resolves a tool definition as the child sees it.
   * @param onChange - redraw request after any folded event.
   */
  constructor(
    ctx: Context,
    private readonly child: Agent,
    resolveTool: (name: string) => ToolDefinition | undefined,
    private readonly onChange: () => void,
  ) {
    this.pending = new PendingToolCalls(resolveTool)
    // SEED from the live Agent, never from a later transition: the provider may
    // have already started the child before its `subagent/start` edge reaches
    // this UI, so waiting for an `agent/status` that already happened would miss
    // a running child entirely.
    this.status = child.status
    // Establish one correct starting snapshot from the CURRENT turn only, then
    // switch to live folding. One redraw covers the whole reconstruction; no
    // historical event gets its own callback, so tool calls already in the
    // session appear immediately instead of being replayed one at a time.
    //
    // The seed reconstructs lifecycle and pending calls, never `thinking` or
    // `responding`: those come from live frames a stored log does not carry, so
    // a child attached mid-reply reads `waiting` until its next frame arrives.
    // Claiming otherwise would need the child's compacted streams expanded, and
    // a row's activity word is not worth a walk over its history.
    const currentTurn = openTurnSuffix(child.session)
    for (const event of currentTurn) this.foldEvent(event)
    this.disposers.push(ctx.on('session/event', (session, event: SessionEvent) => {
      if (session !== child.session) return
      if (this.disposed) return
      this.foldEvent(event)
      onChange()
    }))
    // The child's own live model activity, from the same agent-scoped frames the
    // main status line reads for the attached Agent — but subscribed on the
    // CHILD's context, not the runner's.
    //
    // `dsh-scope` admits events UP the scope chain: a listener tagged with an
    // ancestor receives what a descendant dispatched. That is why the
    // `session/event` listener above sees a child session from the runner's own
    // context. It does not hold for these frames, because a subagent's AGENT
    // scope is not linked under the parent agent's — verified against a live
    // background and foreground subagent, whose frames were published in-process
    // and reached a root listener while the runner's context saw none. The row
    // would then animate and tick its duration while its activity word stayed
    // `waiting` for the whole reply.
    //
    // `child.ctx` is the scope those frames are actually dispatched to, so it
    // needs no assumption about how the two scopes are related. Registration is
    // rejected once that context has unwound, which is a child that disposed
    // between this observer's construction and here: there is no live activity
    // left to report, and the row falls back to lifecycle and tool facts.
    try {
      this.disposers.push(child.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent !== child) return
        if (this.disposed) return
        // A stale or foreign frame is dropped before it can fold phase, clear
        // the tail, or repaint — the same gate the main attachment uses.
        const decision = this.attempt.accept(frame)
        if (!decision.current) return
        if (decision.reset) this.output = ''
        if (frame.type === 'end') {
          // A settled or abandoned attempt leaves no live text. Only its own
          // `start` may establish another attempt's tail.
          this.output = ''
          this.attempt.end()
        } else if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
          // Newest text wins. Retention is capped and the front boundary stays
          // surrogate-clean even for one very large provider delta.
          this.output = appendOutputTail(this.output, frame.chunk.text)
        }
        this.phase = modelPhaseAfterFrame(this.phase, frame)
        onChange()
      }))
    } catch {
      this.phase = 'waiting'
    }
    this.disposers.push(ctx.on('agent/status', (payload: { agent: Agent; status: AgentStatus }) => {
      if (payload.agent !== child) return
      this.status = payload.status
      if (this.disposed) return
      onChange()
    }))
    this.disposers.push(ctx.on('agent/disposed', (payload: { agent: Agent }) => {
      if (payload.agent !== child) return
      // The tail is about a live Agent; a disposed one has no current attempt.
      this.output = ''
      this.attempt.end()
      this.disposed = true
      onChange()
    }))
    if (currentTurn.length > 0) onChange()
  }

  /** Fold one child session event with the shared status vocabulary. */
  private foldEvent(event: SessionEvent): void {
    if (this.disposed) return
    if (event.type === 'tool/call') {
      // A tool call starts executing the moment the model's request settles, so a
      // phase captured before the first pending invocation is stale: when that
      // call drains, `waiting` is the truth unless stream activity arrived while
      // it ran. Mirrors the main status fold exactly.
      if (this.pending.count() === 0) this.phase = 'waiting'
      this.pending.handleCall({
        callId: String(event.data.callId),
        name: event.data.name,
        arguments: event.data.arguments,
      })
    } else if (event.type === 'tool/result') {
      // The session event carries no call id; the pairing lives on the first
      // content block, exactly as the transcript projection reads it.
      const toolCallId = event.data.message.content[0]?.toolCallId
      if (toolCallId !== undefined) this.pending.handleResult(String(toolCallId))
    } else if (event.type === 'turn/end') {
      // An aborted or failed turn can close without results for its calls. The
      // main status clears its cards here; the Work fold must not keep showing
      // a `reading`/`editing`/`running` claim for calls a dead turn will never
      // answer.
      this.pending.reset()
      // The turn boundary also ends the live attempt: its tail is not part of
      // the next turn's answer.
      this.output = ''
      this.attempt.end()
    }
    this.phase = modelPhaseAfter(this.phase, event)
  }

  /**
   * Read the current semantic activity.
   * @returns the word, optional operation title, and animation truth for this child.
   */
  reading(): ChildActivityReading {
    if (this.disposed) return { busy: false }
    const pending = this.pending.semanticActivity()
    const word = primaryActivity(this.phase, pending)
    const title = this.pending.latestTitle()
    return {
      word,
      busy: this.status === 'running',
      ...this.status === undefined ? {} : { status: this.status },
      ...title === undefined ? {} : { title },
      // Absence stays distinct from an empty answer: an attempt that streamed
      // nothing yet is not an attempt that streamed "".
      ...this.output === '' ? {} : { outputTail: this.output },
    }
  }

  /** Stop observing; late events are contained and never repaint this epoch. */
  dispose(): void {
    this.disposed = true
    this.output = ''
    for (const dispose of this.disposers.splice(0)) dispose()
  }
}
