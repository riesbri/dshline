/**
 * The attention notice: what earns one, how long it lives, and what a stale
 * deadline may not do.
 *
 * The derivation tests pin the boundaries that keep a notice to an APPLIED
 * state change or a live structured event: a reselected model, an unchanged
 * effort, a knob event that is only half of a permission switch, and a
 * compaction that is merely being replayed all produce nothing. The controller
 * tests are time-based and use fake timers, because the failure they exist to
 * catch — an uncancelled older timeout retiring a newer notice — is invisible
 * to any assertion that does not advance the clock in two steps.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ATTENTION_DURATION_MS,
  createAttentionController,
  liveSessionAttention,
  modelRouteAttention,
  reasoningAttention,
} from '../src/attention.ts'

/** One committed event of the given type, with no shape checking in the test. */
function event(type: string, data: unknown): SessionEvent {
  return { type, seq: 1, time: 1, data } as unknown as SessionEvent
}

/** The summary event a compaction backend appends. */
const COMPACTION = event('compaction/summary', {
  compactionId: 'c-1',
  sourceCommandId: undefined,
  summary: [{ type: 'text', text: 's' }],
  shadowedRange: { start: 0, end: 1 },
  shadowedSeqs: [0, 1],
  shadowedTokenCount: 95_000,
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
})

describe('modelRouteAttention()', () => {
  it('speaks only when the provider or model actually moved', () => {
    expect(modelRouteAttention(
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    )).toEqual({ text: 'model → deepseek-official/deepseek-v4-pro' })
    expect(modelRouteAttention(
      { provider: 'openai', model: 'gpt-x' },
      { provider: 'deepseek-official', model: 'gpt-x' },
    )).toEqual({ text: 'model → deepseek-official/gpt-x' })
  })

  it('stays quiet when the same route is selected again', () => {
    // `/model` returning `done` is a successful operation, not a transition.
    expect(modelRouteAttention(
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    )).toBeUndefined()
  })

  it('treats a first selection as a change, and a cleared one as none', () => {
    expect(modelRouteAttention(undefined, { provider: 'p', model: 'm' }))
      .toEqual({ text: 'model → p/m' })
    expect(modelRouteAttention({ provider: 'p', model: 'm' }, undefined)).toBeUndefined()
  })

  it('does not mistake a reasoning change for a route change', () => {
    expect(modelRouteAttention(
      { provider: 'p', model: 'm', reasoningEffort: 'high' },
      { provider: 'p', model: 'm', reasoningEffort: 'max' },
    )).toBeUndefined()
  })
})

describe('reasoningAttention()', () => {
  it('names the new level when the stored effort changed', () => {
    expect(reasoningAttention('high', 'max')).toEqual({ text: 'reasoning → max' })
    expect(reasoningAttention(undefined, 'max')).toEqual({ text: 'reasoning → max' })
  })

  it('names the provider default when the stored effort is cleared', () => {
    // Absence is not `off`; it restores whatever the provider does unset.
    expect(reasoningAttention('max', undefined)).toEqual({ text: 'reasoning → provider default' })
  })

  it('stays quiet when the stored effort did not move', () => {
    expect(reasoningAttention('max', 'max')).toBeUndefined()
    expect(reasoningAttention(undefined, undefined)).toBeUndefined()
  })
})

describe('liveSessionAttention()', () => {
  it('derives a compaction notice from the shared summary fact', () => {
    expect(liveSessionAttention(COMPACTION)).toEqual({ text: 'context compacted · ~95k replaced' })
  })

  it('derives a permission notice from the preset event alone', () => {
    expect(liveSessionAttention(event('permission/preset', { preset: 'review' })))
      .toEqual({ text: 'permission → review' })
  })

  it('ignores the knob events that belong to a preset switch', () => {
    // One user change gets one notice; these are the same change's writes.
    expect(liveSessionAttention(event('sandbox/mode', { mode: 'read-only' }))).toBeUndefined()
    expect(liveSessionAttention(event('approval/policy', { policy: 'ask' }))).toBeUndefined()
  })

  it('earns nothing from ordinary events', () => {
    expect(liveSessionAttention(event('turn/start', { turn: 1 }))).toBeUndefined()
    expect(liveSessionAttention(event('command/done', { commandId: 'c', kind: 'success' }))).toBeUndefined()
  })
})

describe('the attention controller', () => {
  it('shows a notice, then retires it after its lifetime with one redraw', () => {
    vi.useFakeTimers()
    try {
      let draws = 0
      const controller = createAttentionController(() => { draws += 1 })
      controller.show({ text: 'model → p/m' })
      expect(controller.current()).toEqual({ text: 'model → p/m' })
      expect(draws).toBe(1)

      vi.advanceTimersByTime(ATTENTION_DURATION_MS - 1)
      expect(controller.current()).toBeDefined()
      vi.advanceTimersByTime(1)
      expect(controller.current()).toBeUndefined()
      // Show redrew once; expiry redrew once.
      expect(draws).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the newest notice win and cannot be retired by the older deadline', () => {
    vi.useFakeTimers()
    try {
      const controller = createAttentionController(() => {})
      controller.show({ text: 'model → p/m' })
      vi.advanceTimersByTime(1_000)
      controller.show({ text: 'permission → review' })
      // Past the FIRST deadline, with a third of the second's lifetime left.
      vi.advanceTimersByTime(3_000)
      expect(controller.current()).toEqual({ text: 'permission → review' })
      // A fresh full lifetime from the second show, and not a millisecond less.
      vi.advanceTimersByTime(999)
      expect(controller.current()).toEqual({ text: 'permission → review' })
      vi.advanceTimersByTime(1)
      expect(controller.current()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an undefined show rather than clearing a live notice', () => {
    vi.useFakeTimers()
    try {
      const controller = createAttentionController(() => {})
      controller.show({ text: 'permission → review' })
      controller.show(undefined)
      expect(controller.current()).toEqual({ text: 'permission → review' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the deadline on dispose and never repaints afterwards', () => {
    vi.useFakeTimers()
    try {
      let draws = 0
      const controller = createAttentionController(() => { draws += 1 })
      controller.show({ text: 'model → p/m' })
      expect(draws).toBe(1)
      controller.dispose()
      expect(controller.current()).toBeUndefined()
      // Nothing fires on the far side of teardown, and a later show is refused.
      vi.advanceTimersByTime(ATTENTION_DURATION_MS * 10)
      controller.show({ text: 'permission → review' })
      expect(controller.current()).toBeUndefined()
      expect(draws).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
