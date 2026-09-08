import { describe, expect, it } from 'vitest'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallKind, ToolCallView } from '@deepseek-ai/dsh-tools'
import {
  modelPhaseAfter,
  modelPhaseAfterFrame,
  primaryActivity,
  toolActivity,
} from '../src/activity.ts'
import type { ModelPhase } from '../src/activity.ts'

/**
 * A minimal event for the pure reducer; only the discriminant under test matters.
 * @param type - event type to expose.
 * @param data - payload read by that event branch.
 * @returns a SessionEvent-shaped test input.
 */
function event(type: string, data: unknown = {}): SessionEvent {
  return { type, data, seq: 1, time: 1 } as unknown as SessionEvent
}

/**
 * One live chunk frame carrying the given stream chunk.
 * @param chunk - the stream chunk the frame delivers.
 * @returns a chunk frame for one attempt.
 */
function chunkFrame(chunk: unknown): AssistantStreamFrame {
  return { type: 'chunk', attemptId: 's:1', revision: 1, index: 0, time: 1, chunk } as AssistantStreamFrame
}

/**
 * One streamed assistant delta, as the live frames deliver it.
 * @param type - stream chunk type.
 * @param text - delta content.
 * @returns a chunk frame.
 */
function delta(type: string, text: string): AssistantStreamFrame {
  return chunkFrame({ type, index: 0, text })
}

describe('modelPhaseAfter()', () => {
  it('starts fresh at waiting and resets on model lifecycle boundaries', () => {
    let phase: ModelPhase = 'waiting'
    for (const type of ['turn/start', 'step/start', 'step/end', 'assistant/message', 'turn/end']) {
      phase = modelPhaseAfter('responding', event(type))
      expect(phase, type).toBe('waiting')
    }
  })

  it('returns to waiting when an attempt settles without a visible message', () => {
    // `assistant/attempt` is one settled model attempt that committed no reply.
    // Whatever it streamed is over, so leaving `responding` standing would keep
    // the status line claiming output while the loop decides whether to retry.
    expect(modelPhaseAfter('responding', event('assistant/attempt'))).toBe('waiting')
  })

  it('preserves phase across tool and command lifecycle events', () => {
    for (const type of ['tool/call', 'tool/result', 'command/run']) {
      expect(modelPhaseAfter('thinking', event(type)), type).toBe('thinking')
    }
  })

  it('preserves phase for an event type it has never seen', () => {
    expect(modelPhaseAfter('thinking', event('future/event'))).toBe('thinking')
  })
})

describe('modelPhaseAfterFrame()', () => {
  it('moves from reasoning to text and ends responding', () => {
    const thinking = modelPhaseAfterFrame('waiting', delta('reasoning-delta', 'thought'))
    expect(thinking).toBe('thinking')
    expect(modelPhaseAfterFrame(thinking, delta('text-delta', 'answer'))).toBe('responding')
  })

  it('ignores empty deltas but treats delivered whitespace as stream activity', () => {
    expect(modelPhaseAfterFrame('responding', delta('reasoning-delta', ''))).toBe('responding')
    expect(modelPhaseAfterFrame('thinking', delta('text-delta', ''))).toBe('thinking')
    expect(modelPhaseAfterFrame('waiting', delta('reasoning-delta', ' '))).toBe('thinking')
    expect(modelPhaseAfterFrame('waiting', delta('text-delta', '\n'))).toBe('responding')
  })

  it('treats a reasoning or text block start as the earliest phase signal', () => {
    // The block-opening chunk arrives before the first delta of its block, so it
    // is the earliest truthful "the model has begun thinking/responding" signal.
    expect(modelPhaseAfterFrame('waiting', chunkFrame({ type: 'block-start', index: 0, blockType: 'reasoning' }))).toBe('thinking')
    expect(modelPhaseAfterFrame('waiting', chunkFrame({ type: 'block-start', index: 0, blockType: 'text' }))).toBe('responding')
    // A later block start overrides a prior phase: the model moved on.
    expect(modelPhaseAfterFrame('thinking', chunkFrame({ type: 'block-start', index: 1, blockType: 'text' }))).toBe('responding')
  })

  it('preserves phase for non-reasoning/text block starts and other non-delta chunks', () => {
    // Tool-call blocks are tool requests, not model output; image blocks and any
    // future block type carry no phase claim.
    for (const blockType of ['tool-call', 'image', 'future-block']) {
      expect(
        modelPhaseAfterFrame('responding', chunkFrame({ type: 'block-start', index: 0, blockType })),
        blockType,
      ).toBe('responding')
    }
    for (const type of ['unknown-chunk', 'tool-call-delta', 'block-end', 'usage', 'finish']) {
      expect(modelPhaseAfterFrame('responding', delta(type, 'ignored')), type).toBe('responding')
    }
  })

  it('anchors both ends of an attempt at waiting', () => {
    // A fresh attempt has produced nothing yet, and a settled or abandoned one
    // has stopped. Without both, a retried attempt would inherit the phase its
    // failed predecessor left behind and the status line would claim output no
    // model was producing.
    const start: AssistantStreamFrame = { type: 'start', attemptId: 's:2', revision: 1, turn: 1, step: 1 } as AssistantStreamFrame
    expect(modelPhaseAfterFrame('responding', start)).toBe('waiting')
    for (const outcome of [
      { kind: 'committed', eventType: 'assistant/message', seq: 4 },
      { kind: 'committed', eventType: 'assistant/attempt', seq: 4 },
      { kind: 'abandoned' },
    ]) {
      const end = { type: 'end', attemptId: 's:2', revision: 2, index: 3, outcome } as unknown as AssistantStreamFrame
      expect(modelPhaseAfterFrame('thinking', end), JSON.stringify(outcome)).toBe('waiting')
    }
  })
})

describe('toolActivity()', () => {
  it.each<[ToolCallKind, ReturnType<typeof toolActivity>]>([
    ['read', 'reading'],
    ['search', 'searching'],
    ['fetch', 'fetching'],
    ['edit', 'editing'],
    ['delete', 'editing'],
    ['move', 'editing'],
    ['execute', 'running'],
    ['other', 'working'],
  ])('maps generic %s calls to %s', (kind, expected) => {
    expect(toolActivity({ card: 'generic', title: 'Any title', kind })).toBe(expected)
  })

  it('uses only presentation semantics, never a tool name', () => {
    expect(toolActivity({ card: 'generic', title: 'semantic_code_lookup', kind: 'search' })).toBe('searching')
  })

  it('maps terminal and diff cards before considering generic kinds', () => {
    expect(toolActivity({ card: 'terminal', title: 'npm test' })).toBe('running')
    expect(toolActivity({ card: 'diff', title: 'Edit f', diffs: [] })).toBe('editing')
  })

  it('falls back conservatively for absent and future presentation vocabulary', () => {
    expect(toolActivity(undefined)).toBe('working')
    expect(toolActivity({ card: 'generic', title: 'No kind' })).toBe('working')
    expect(toolActivity({ card: 'generic', title: 'Future', kind: 'teleport' as ToolCallKind })).toBe('working')
    expect(toolActivity({ card: 'future-card', title: 'Future' } as unknown as ToolCallView)).toBe('working')
  })
})

describe('primaryActivity()', () => {
  it('uses the model phase with no tool and lets a pending tool outrank it', () => {
    expect(primaryActivity('waiting', undefined)).toBe('waiting')
    expect(primaryActivity('thinking', 'reading')).toBe('reading')
  })
})
