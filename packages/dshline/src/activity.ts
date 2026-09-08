/**
 * Semantic activity derived from Harness-native model and tool presentation.
 *
 * Two authorities, because Harness publishes two. Durable `SessionEvent`s own
 * the turn/step lifecycle, so they are what returns the model to `waiting`; the
 * agent-scoped `agent/assistant-stream` frames are the only place live model
 * output exists, so they are what says `thinking` or `responding`. Folding both
 * through one reducer would need a union of a durable log event and a transient
 * frame, and the caller already knows which of the two it is holding.
 * @module dshline/activity
 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'

/** The model-side phase visible while no pending tool invocation outranks it. */
export type ModelPhase = 'waiting' | 'thinking' | 'responding'

/** The conservative activity vocabulary derived from a pending tool's view. */
export type ToolActivity = 'reading' | 'searching' | 'fetching' | 'editing' | 'running' | 'working'

/** One presentation word for the status line's current activity. */
export type ActivityWord = ModelPhase | ToolActivity

/**
 * Fold one committed session event into the model's lifecycle phase.
 *
 * Only boundaries appear here. A durable log event never says the model is
 * producing output — under session format v2 the log's Assistant records are
 * settlements, not deltas — so every branch of this reducer returns the model
 * to `waiting` or preserves what the live frames established.
 * @param phase - the phase before this event.
 * @param event - one event from the live session feed.
 * @returns the phase after the event, preserving it for unknown future events.
 */
export function modelPhaseAfter(phase: ModelPhase, event: SessionEvent): ModelPhase {
  switch (event.type) {
    case 'turn/start':
    case 'step/start':
    case 'step/end':
    case 'assistant/message':
    // A settled attempt that committed no visible message is still a settled
    // attempt: whatever it streamed is over, and the retry (or the failure)
    // that follows has produced nothing yet.
    case 'assistant/attempt':
    // A closed turn is no longer producing anything: `turn/end` may arrive
    // while the agent still drains, and the finished phase would be stale
    // for that stretch. The next turn opens at `waiting` anyway.
    case 'turn/end':
      return 'waiting'
    default:
      return phase
  }
}

/**
 * Fold one live assistant-stream frame into the model's current phase.
 *
 * This is process-local presentation, not history: the frames exist so a reader
 * can see the model working, and they are the only authority that can say which
 * kind of output is arriving right now.
 * @param phase - the phase before this frame.
 * @param frame - one ordered frame for the attached agent's current attempt.
 * @returns the phase after the frame.
 */
export function modelPhaseAfterFrame(phase: ModelPhase, frame: AssistantStreamFrame): ModelPhase {
  // An attempt's opening and terminal markers both mean "nothing is arriving":
  // a fresh attempt has streamed nothing yet, and a settled or abandoned one is
  // over. Anchoring both ends here is what keeps a retried attempt from
  // inheriting the phase its predecessor left behind.
  if (frame.type !== 'chunk') return 'waiting'
  const { chunk } = frame
  // A block opening is the earliest truthful signal that a model block has
  // begun: reasoning/text phase before its first delta arrives. Tool-call
  // and other current or future block types preserve the last phase.
  if (chunk.type === 'block-start') {
    if (chunk.blockType === 'reasoning') return 'thinking'
    if (chunk.blockType === 'text') return 'responding'
    return phase
  }
  if (chunk.type === 'reasoning-delta' && chunk.text !== '') return 'thinking'
  if (chunk.type === 'text-delta' && chunk.text !== '') return 'responding'
  return phase
}

/**
 * Classify one resolved call presentation without interpreting its tool name or text.
 * @param view - the call view returned by the definition that actually ran.
 * @returns the semantic tool activity, conservatively falling back to `working`.
 */
export function toolActivity(view: ToolCallView | undefined): ToolActivity {
  if (view === undefined) return 'working'
  if (view.card === 'terminal') return 'running'
  if (view.card === 'diff') return 'editing'
  if (view.card !== 'generic') return 'working'
  switch (view.kind) {
    case 'read':
      return 'reading'
    case 'search':
      return 'searching'
    case 'fetch':
      return 'fetching'
    case 'edit':
    case 'delete':
    case 'move':
      return 'editing'
    case 'execute':
      return 'running'
    case 'other':
    case undefined:
    default:
      return 'working'
  }
}

/**
 * Choose the status word, letting an outstanding tool invocation outrank the model.
 * @param phase - the latest model-side phase.
 * @param pending - the aggregate activity of pending tool invocations.
 * @returns the tool activity when present, otherwise the model phase.
 */
export function primaryActivity(phase: ModelPhase, pending: ToolActivity | undefined): ActivityWord {
  return pending === undefined ? phase : pending
}
