/**
 * Per-child semantic activity for Work rows.
 *
 * A live in-process subagent exposes a real child Agent, so its activity can be
 * folded with the exact vocabulary the main status line uses: the model phase
 * from its session events and its transient assistant stream, and the tool
 * activity from its pending calls' presentations. A remote run without a local Agent exposes neither, and the
 * observer simply never attaches — the row then shows no invented activity.
 * @module dshline/work/activity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { modelPhaseAfter, modelPhaseAfterFrame, primaryActivity } from '../activity.ts'
import type { ActivityWord, ModelPhase } from '../activity.ts'
import { PendingToolCalls } from '../tool-pending.ts'

/** The live activity facts a Work row may truthfully present. */
export interface ChildActivityReading {
  /**
   * The semantic word; present only while the live child Agent is observed.
   * `waiting` is the honest reading for a resident child between turns.
   */
  readonly word?: ActivityWord
  /** The newest pending call's presentation title, when its tool declared one. */
  readonly title?: string
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
    // session appear immediately instead of being replayed event by event.
    //
    // An attempt already streaming when this attaches contributes nothing to
    // the seed, and cannot: streaming leaves no durable record until it
    // settles. The row reads `waiting` for the rest of that attempt, which is
    // narrower than the truth but never wrong about a tool.
    const currentTurn = openTurnSuffix(child.session)
    for (const event of currentTurn) this.foldEvent(event)
    this.disposers.push(ctx.on('session/event', (session, event: SessionEvent) => {
      if (session !== child.session) return
      if (this.disposed) return
      this.foldEvent(event)
      onChange()
    }))
    // The transient half of the same fold, filtered by the same exact identity.
    // Without it a streaming child would sit at `waiting` for its whole reply,
    // because the durable log no longer carries a per-delta event to fold.
    this.disposers.push(ctx.on('agent/assistant-stream', (payload) => {
      if (payload.agent !== child) return
      if (this.disposed) return
      this.phase = modelPhaseAfterFrame(this.phase, payload.frame)
      onChange()
    }))
    this.disposers.push(ctx.on('agent/status', (payload: { agent: Agent; status: AgentStatus }) => {
      if (payload.agent !== child) return
      this.status = payload.status
      if (this.disposed) return
      onChange()
    }))
    this.disposers.push(ctx.on('agent/disposed', (payload: { agent: Agent }) => {
      if (payload.agent !== child) return
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
    }
  }

  /** Stop observing; late events are contained and never repaint this epoch. */
  dispose(): void {
    this.disposed = true
    for (const dispose of this.disposers.splice(0)) dispose()
  }
}
