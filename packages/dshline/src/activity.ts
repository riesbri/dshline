/**
 * Semantic activity derived from Harness-native model and tool presentation.
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
 * Fold one live session event into the model's current semantic phase.
 *
 * The durable log carries only settled events: what the model is doing WHILE it
 * streams arrives on `agent/assistant-stream` instead, and belongs to
 * {@link modelPhaseAfterFrame}. Every branch here is therefore a boundary that
 * ends production, which is why they all answer `waiting`.
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
    // An attempt that settled without a surface message — a failed, retried, or
    // cancelled model call. It ends production exactly as a committed message
    // does, and omitting it would leave `responding` on screen for a reply
    // nobody is going to receive.
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
 * Fold one live assistant-stream frame into the model's current semantic phase.
 *
 * The transient half of the same fold. `start` says a request left, which is
 * still `waiting` until the model opens a block; `end` closes the attempt
 * whether or not a durable event followed it, so an abandoned attempt clears
 * the phase on its own rather than waiting for `turn/end`.
 * @param phase - the phase before this frame.
 * @param frame - one ordered frame from the agent's assistant stream.
 * @returns the phase after the frame, preserving it for chunks it cannot read.
 */
export function modelPhaseAfterFrame(phase: ModelPhase, frame: AssistantStreamFrame): ModelPhase {
  if (frame.type === 'end') return 'waiting'
  if (frame.type !== 'chunk') return phase
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
