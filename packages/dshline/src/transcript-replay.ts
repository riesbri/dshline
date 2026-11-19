/** Cooperative transcript presentation over the Session's authoritative snapshots. */
import { setImmediate as yieldToInput } from 'node:timers/promises'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Structural events must yield too, even when they produce no terminal rows. */
const EVENT_BATCH = 32
/** Bound one Screen commit without returning to event-by-event chrome repaint. */
const ROW_BATCH = 128
/** A second bound for unusually long styled rows; measured in UTF-16 units. */
const TEXT_BATCH = 32 * 1024

/** One attachment's replay operation, never a second log or event queue. */
export interface TranscriptReplaySpec {
  /** Read the immutable append-only log from the already-owned Session. */
  readonly snapshot: () => readonly SessionEvent[]
  /** Historical and newly appended events share presentation but not live alerts. */
  readonly project: (event: SessionEvent, historical: boolean) => readonly string[]
  /** Commit already-safe rows through the window's Screen owner. */
  readonly commit: (rows: readonly string[]) => void
  /** Attachment retirement cancels before another projection or write. */
  readonly signal: AbortSignal
  /** Called after every initial-history row is committed, before live catch-up. */
  readonly historicalEnd: () => void
  /** Open the live feed synchronously at the caught-up snapshot boundary. */
  readonly ready: () => void
}

/**
 * Project a stable prefix in bounded output batches, then catch up from its owner.
 *
 * The caller fences live presentation until `ready`, so appends across a yield
 * are read from Session instead of copied into an unbounded frontend queue.
 * A single event's presenter remains synchronous; this bounds work BETWEEN
 * events and output batches, not the cost of an arbitrary presenter itself.
 * @param spec - source authority, row sink and attachment lifetime.
 * @returns true when caught up, false when the attachment retired.
 */
export async function replayTranscript(spec: TranscriptReplaySpec): Promise<boolean> {
  if (spec.signal.aborted) return false
  let snapshot = spec.snapshot()
  const historicalEnd = snapshot.length
  let consumed = 0
  let rows: string[] = []
  let text = 0
  let events = 0
  let historyFinished = false
  const flush = (): void => {
    if (rows.length === 0 || spec.signal.aborted) return
    spec.commit(rows)
    rows = []
    text = 0
  }
  const pause = async (): Promise<boolean> => {
    flush()
    events = 0
    await yieldToInput()
    return !spec.signal.aborted
  }
  for (;;) {
    // Capture the end even for a test backend that reuses a mutable array.
    const end = snapshot.length
    while (consumed < end) {
      if (spec.signal.aborted) return false
      const event = snapshot[consumed]
      if (event === undefined) throw new Error('Session replay lost its append-only prefix')
      const projected = spec.project(event, consumed < historicalEnd)
      for (const row of projected) {
        if (rows.length > 0 && (rows.length >= ROW_BATCH || text + row.length > TEXT_BATCH)) {
          if (!await pause()) return false
        }
        if (spec.signal.aborted) return false
        rows.push(row)
        text += row.length
      }
      consumed += 1
      events += 1
      if (events >= EVENT_BATCH && !await pause()) return false
    }
    flush()
    if (spec.signal.aborted) return false
    if (!historyFinished) {
      historyFinished = true
      spec.historicalEnd()
    }
    if (spec.signal.aborted) return false
    const next = spec.snapshot()
    if (next.length < consumed) throw new Error('Session replay lost its append-only prefix')
    if (next.length === consumed) {
      // No await may separate this observation from opening the live listener:
      // an append in a promise continuation must already take the ordinary path.
      spec.ready()
      return true
    }
    snapshot = next
  }
}
