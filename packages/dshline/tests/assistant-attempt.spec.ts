/**
 * The attempt-identity gate behind both live assistant folds.
 *
 * The state machine is small but it has two distinct "no attempt" states, and
 * confusing them resurrects a settled attempt. These cases pin each transition
 * explicitly: start-new resets, start-same does not, a first mid-stream frame
 * adopts, a foreign attempt is ignored, and after `end` only a new `start` may
 * adopt another.
 * @module dshline/tests/assistant-attempt
 */

import { describe, expect, it } from 'vitest'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { AssistantStreamAttempt } from '../src/assistant-attempt.ts'

/** The opening marker of one attempt. */
function start(attemptId: string): AssistantStreamFrame {
  return { type: 'start', attemptId, revision: 1, turn: 1, step: 1 } as AssistantStreamFrame
}

/** One text chunk of one attempt. */
function text(attemptId: string, value = 'x'): AssistantStreamFrame {
  return {
    type: 'chunk', attemptId, revision: 1, index: 0, time: 0,
    chunk: { type: 'text-delta', index: 0, text: value },
  } as AssistantStreamFrame
}

/** A reasoning chunk of one attempt. */
function reasoning(attemptId: string): AssistantStreamFrame {
  return {
    type: 'chunk', attemptId, revision: 1, index: 0, time: 0,
    chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
  } as AssistantStreamFrame
}

/** The terminal marker of one attempt. */
function end(attemptId: string): AssistantStreamFrame {
  return {
    type: 'end', attemptId, revision: 2, index: 1, outcome: { kind: 'abandoned' },
  } as AssistantStreamFrame
}

describe('AssistantStreamAttempt', () => {
  it('adopts a first start and resets only when the attempt id changes', () => {
    const attempt = new AssistantStreamAttempt()
    expect(attempt.accept(start('a1'))).toEqual({ current: true, reset: true })
    // The same attempt re-announced is not a new one.
    expect(attempt.accept(start('a1'))).toEqual({ current: true, reset: false })
    // A genuinely different attempt begins.
    expect(attempt.accept(start('a2'))).toEqual({ current: true, reset: true })
  })

  it('adopts the tracked attempt on a first frame that is not a start', () => {
    // The listener attached mid-stream: no `start` was ever seen, so the first
    // chunk establishes the current attempt instead of resetting it.
    const attempt = new AssistantStreamAttempt()
    expect(attempt.accept(text('a1', 'hello'))).toEqual({ current: true, reset: false })
    expect(attempt.accept(reasoning('a1'))).toEqual({ current: true, reset: false })
    // Even a first terminal frame is current: it belongs to the attempt this
    // gate just adopted, and the caller must process the end.
    const fresh = new AssistantStreamAttempt()
    expect(fresh.accept(end('a9'))).toEqual({ current: true, reset: false })
  })

  it('ignores a frame from a different attempt while one is tracked', () => {
    const attempt = new AssistantStreamAttempt()
    attempt.accept(start('a1'))
    expect(attempt.accept(text('a2', 'STALE'))).toEqual({ current: false, reset: false })
    expect(attempt.accept(end('a2'))).toEqual({ current: false, reset: false })
    // The tracked attempt still folds.
    expect(attempt.accept(text('a1'))).toEqual({ current: true, reset: false })
  })

  it('after end accepts only a new start, never the ended attempt or a stray frame', () => {
    const attempt = new AssistantStreamAttempt()
    attempt.accept(start('a1'))
    attempt.end()
    // The ended attempt is gone; a late chunk is not a mid-stream adoption.
    expect(attempt.accept(text('a1'))).toEqual({ current: false, reset: false })
    expect(attempt.accept(reasoning('a1'))).toEqual({ current: false, reset: false })
    // A foreign attempt without a start is equally late.
    expect(attempt.accept(text('a2'))).toEqual({ current: false, reset: false })
    // Only a new `start` may adopt another attempt.
    expect(attempt.accept(start('a2'))).toEqual({ current: true, reset: true })
  })

  it('clears the tracked attempt on end so a same-id start is a new attempt', () => {
    const attempt = new AssistantStreamAttempt()
    attempt.accept(start('a1'))
    attempt.end()
    // The id was cleared, so the identical id is re-adopted as a new attempt
    // and the caller is told to discard whatever its buffer held.
    expect(attempt.accept(start('a1'))).toEqual({ current: true, reset: true })
  })
})
