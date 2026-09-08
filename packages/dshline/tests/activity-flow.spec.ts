/**
 * The live listener's activity orchestration, driven through the real modules.
 *
 * `attachSession` itself needs a plugin context, an agent, and a terminal, so
 * the coordination it performs — the 0→1 pending check before the phase
 * reducer, then the card projection — is exercised here with the exact same
 * order and the real `ToolCards`, `modelPhaseAfter`, `modelPhaseAfterFrame`,
 * and `primaryActivity`. The point is to catch bugs in how those parts agree,
 * not to re-test any of them alone.
 *
 * Two feeds, exactly as the attachment has: committed events carry the
 * lifecycle and the tool cards, and live `agent/assistant-stream` frames carry
 * the model's own output. Tool precedence has to hold across both.
 * @module dshline/tests/activity-flow
 */

import { describe, expect, it } from 'vitest'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { modelPhaseAfter, modelPhaseAfterFrame, primaryActivity } from '../src/activity.ts'
import type { ActivityWord, ModelPhase } from '../src/activity.ts'
import { ToolCards } from '../src/cards.ts'

/** Wide enough that nothing a card draws wraps. */
const COLUMNS = 90

/**
 * The attachment's live activity state: the latent model phase and the card
 * tracker that owns pending tool invocations.
 */
interface Flow {
  readonly cards: ToolCards
  phase: ModelPhase
}

/**
 * A tool lookup that resolves generic views by the NAME in the test, proving
 * classification rides the resolved definition, never the name itself.
 * @param views - the `ToolCallView` to resolve per tool name.
 * @returns a lookup for ToolCards.
 */
function lookup(views: Record<string, ToolCallView>): (name: string) => ToolDefinition | undefined {
  return name => {
    const view = views[name]
    return view === undefined ? undefined : { presentCall: () => view } as unknown as ToolDefinition
  }
}

/**
 * Fold one live frame the way attachment.ts's `agent/assistant-stream`
 * listener does: the model phase alone, with the cards untouched.
 * @param flow - the live activity state.
 * @param frame - one live assistant-stream frame.
 */
function foldFrame(flow: Flow, frame: AssistantStreamFrame): void {
  flow.phase = modelPhaseAfterFrame(flow.phase, frame)
}

/**
 * Fold one committed event the way attachment.ts's `session/event` listener
 * does: the 0→1 pending check runs BEFORE the call is projected, then the
 * phase reducer, then the card projection pairs the call and its result by id.
 * @param flow - the live activity state.
 * @param event - one live session event.
 */
function fold(flow: Flow, event: SessionEvent): void {
  if (event.type === 'tool/call' && flow.cards.inFlight() === undefined) flow.phase = 'waiting'
  flow.phase = modelPhaseAfter(flow.phase, event)
  if (event.type === 'tool/call') flow.cards.call(event.data, COLUMNS)
  if (event.type === 'tool/result') {
    const block = (event.data.message.content[0] ?? {}) as {
      toolCallId?: string
      content?: readonly ContentBlock[]
      isError?: boolean
    }
    flow.cards.result({
      callId: block.toolCallId ?? '',
      content: block.content ?? [],
      isError: block.isError === true,
    }, COLUMNS)
  }
}

/** The word the status line would show for this state. */
function word(flow: Flow): ActivityWord {
  return primaryActivity(flow.phase, flow.cards.semanticActivity())
}

/** A fresh flow with the given per-name views resolved as tool definitions. */
function fresh(views: Record<string, ToolCallView>): Flow {
  return { cards: new ToolCards(lookup(views), '/w'), phase: 'waiting' }
}

/** A minimal typed event builder for the lifecycle events the fold reads. */
function ev(type: string, data: unknown = {}): SessionEvent {
  return { type, data, seq: 0, time: 0 } as unknown as SessionEvent
}

/** A tool call by id, resolved through the flow's lookup by the given name. */
function call(id: string, name: string): SessionEvent {
  return ev('tool/call', { turn: 1, step: 1, callId: id, name, arguments: '{}' })
}

/** A tool result settling one exact call id. */
function result(id: string): SessionEvent {
  return ev('tool/result', {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'tool', toolCallId: id, content: [] }] },
  })
}

/** One live chunk frame carrying the given stream chunk. */
function frame(chunk: unknown): AssistantStreamFrame {
  return { type: 'chunk', attemptId: 's:1', revision: 1, index: 0, time: 0, chunk } as AssistantStreamFrame
}

/** A reasoning delta frame. */
function reasoning(text = 'thinking…'): AssistantStreamFrame {
  return frame({ type: 'reasoning-delta', index: 0, text })
}

/** A reasoning block-start frame. */
function reasoningBlockStart(): AssistantStreamFrame {
  return frame({ type: 'block-start', index: 0, blockType: 'reasoning' })
}

/** A text delta frame. */
function text(): AssistantStreamFrame {
  return frame({ type: 'text-delta', index: 0, text: 'answer' })
}

describe('the live activity fold, end to end', () => {
  it('keeps a pending tool on top while stream activity updates the latent phase', () => {
    const flow = fresh({ read: { card: 'generic', title: 'Read f', kind: 'read' } })
    fold(flow, ev('turn/start', { turn: 1 }))
    expect(word(flow)).toBe('waiting')
    foldFrame(flow, reasoning())
    expect(word(flow)).toBe('thinking')
    fold(flow, call('c1', 'read'))
    expect(word(flow)).toBe('reading')
    // A reasoning block opens while the read is still outstanding: the primary
    // word stays on the tool; the latent phase moves to thinking underneath.
    foldFrame(flow, reasoningBlockStart())
    expect(word(flow)).toBe('reading')
    fold(flow, result('c1'))
    expect(word(flow)).toBe('thinking')
  })

  it('collapses a mixed set and recomputes as exact call ids drain', () => {
    const flow = fresh({
      read: { card: 'generic', title: 'Read f', kind: 'read' },
      search: { card: 'generic', title: 'Look up', kind: 'search' },
    })
    fold(flow, ev('turn/start', { turn: 1 }))
    foldFrame(flow, text())
    expect(word(flow)).toBe('responding')
    fold(flow, call('c1', 'read'))
    fold(flow, call('c2', 'search'))
    expect(word(flow)).toBe('working')
    // The search settles first: pairing is by call id, so the remaining read
    // category surfaces, not the newest-started call's.
    fold(flow, result('c2'))
    expect(word(flow)).toBe('reading')
    fold(flow, result('c1'))
    // Nothing is outstanding now; the latent phase had been reset to `waiting`
    // when the first call started and no stream activity arrived while it ran.
    expect(word(flow)).toBe('waiting')
  })

  it('does not resurrect a stale pre-tool phase after the tool drains', () => {
    const flow = fresh({ read: { card: 'generic', title: 'Read f', kind: 'read' } })
    foldFrame(flow, reasoning())
    expect(word(flow)).toBe('thinking')
    fold(flow, call('c1', 'read'))
    fold(flow, result('c1'))
    // The pre-tool `thinking` was stale the moment the call began executing.
    expect(word(flow)).toBe('waiting')
  })

  it('drops a failed attempt\'s phase without disturbing a pending tool', () => {
    const flow = fresh({ read: { card: 'generic', title: 'Read f', kind: 'read' } })
    fold(flow, ev('turn/start', { turn: 1 }))
    fold(flow, call('c1', 'read'))
    foldFrame(flow, reasoning())
    // The tool still outranks the model while it runs.
    expect(word(flow)).toBe('reading')
    // The attempt settles with no visible message: the model produced nothing,
    // so once the read drains the honest word is `waiting`, not `thinking`.
    fold(flow, ev('assistant/attempt', { turn: 1, step: 1, stream: [] }))
    fold(flow, result('c1'))
    expect(word(flow)).toBe('waiting')
  })

  it('lets stream activity that arrived during the tool win over the reset', () => {
    const flow = fresh({ read: { card: 'generic', title: 'Read f', kind: 'read' } })
    foldFrame(flow, reasoning())
    fold(flow, call('c1', 'read'))
    // A new reasoning block began while the read was outstanding.
    foldFrame(flow, reasoningBlockStart())
    fold(flow, result('c1'))
    expect(word(flow)).toBe('thinking')
  })
})