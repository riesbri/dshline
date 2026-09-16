/**
 * Attempt-identity gate for one Agent's live `agent/assistant-stream` frames.
 *
 * The frames are process-local and transient. The contract orders
 * `start`/`chunk`/`end` WITHIN one attempt and promises settlement before that
 * attempt's `end`, but it does not promise that attempt N's frames all arrive
 * before attempt N+1 starts — that holds only because the loop is a single
 * sequential iteration. A late `end` from a settled attempt would otherwise
 * reset the next attempt's buffer, live or bounded, and let a durable
 * settlement re-emit a reply the reader already saw.
 *
 * Two folds consume these frames: the attached transcript's live buffer and a
 * Work child's bounded output tail. They must agree on "is this frame current,
 * and did a new attempt begin", so that one state machine lives here rather
 * than being inlined twice.
 *
 * Two different states both mean "no tracked attempt", and confusing them is
 * how a settled attempt gets resurrected:
 *
 * - NO attempt has ever been adopted. The listener attached mid-stream, so the
 *   first frame it sees — even a `chunk` with no `start` before it — is the
 *   current attempt and must be folded.
 * - An attempt WAS adopted and has since ended. Only a later `start` may
 *   establish another; every other frame is late and must be ignored. Treating
 *   this like the first state would adopt a stale chunk or a stale `end`, and
 *   once a buffer took the stale text no later reset can remove what was
 *   already committed.
 *
 * This class therefore tracks the adoption fact separately from the tracked
 * attempt id, and {@link AssistantStreamAttempt.end} clears only the latter.
 * It owns nothing else: no buffer, no reset, no presentation.
 * @module dshline/assistant-attempt
 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'

/** Whether one stream frame continues the tracked attempt, and whether a new attempt began. */
export interface AssistantStreamDecision {
  /** Whether the frame belongs to the tracked attempt and must be folded. */
  readonly current: boolean
  /** Whether a NEW attempt began, so the caller must discard whatever its buffer held. */
  readonly reset: boolean
}

/**
 * The pure attempt-identity state machine for one Agent's assistant stream.
 *
 * Presentation-agnostic on purpose: a caller folds, clears, or buffers exactly
 * what its own surface owns, while the decision about which frames are current
 * is made once here.
 */
export class AssistantStreamAttempt {
  /** The adopted attempt's id, or undefined before one exists and after {@link end}. */
  private attempt: AssistantStreamFrame['attemptId'] | undefined
  /** Whether this gate has EVER adopted an attempt; never cleared by {@link end}. */
  private adopted = false

  /**
   * Classify one frame against the tracked attempt.
   * @param frame - one ordered `agent/assistant-stream` frame.
   * @returns whether the frame is current and must be folded, and whether a new attempt began.
   */
  accept(frame: AssistantStreamFrame): AssistantStreamDecision {
    if (frame.type === 'start') {
      this.adopted = true
      if (this.attempt === frame.attemptId) return { current: true, reset: false }
      this.attempt = frame.attemptId
      return { current: true, reset: true }
    }
    if (this.attempt === undefined) {
      // An attempt already adopted and since ended: only a later `start` may
      // establish another. See the module note on the two "no attempt" states.
      if (this.adopted) return { current: false, reset: false }
      // Attached mid-stream: the first frame establishes the current attempt.
      this.attempt = frame.attemptId
      this.adopted = true
      return { current: true, reset: false }
    }
    if (this.attempt !== frame.attemptId) return { current: false, reset: false }
    return { current: true, reset: false }
  }

  /**
   * Mark the tracked attempt ended.
   *
   * Clears the id but NOT the adoption fact, so after an `end` only a later
   * `start` may adopt another attempt; a late `chunk` can never look like a
   * fresh mid-stream attachment.
   */
  end(): void {
    this.attempt = undefined
  }
}
