/**
 * Bounded reads and rendering of one durable child's own session log.
 *
 * The inspector is a temporary live-region surface over Harness's own record,
 * not a second transcript database. It keeps a lightweight seq index plus ONE
 * bounded page of full event bodies, reads a further page only when the reader
 * asks for older history, and renders each event with Harness's
 * `extractSessionEventText` — the same presentation helper `/sessions` uses.
 * Nothing here folds the log, and nothing resumes or publishes the child.
 *
 * The page size is a real tradeoff rather than a round number: Harness caps
 * `readEvent` at 50 events per window, and a child turn is roughly six to ten
 * raw events, so 24 spans about two or three turns of conversation while
 * keeping the retained bodies small.
 * @module dshline/subagents/transcript
 */

import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEventRecord } from '@deepseek-ai/dsh-session-query'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import { escapeControls, paint, truncateToWidth, wrapToWidth } from '@dshline/renderer'
import { relativeAge } from '../sessions/model.ts'
import type { ChildSessionReads } from './seam.ts'

/**
 * Full event bodies retained by one page read.
 *
 * Deliberately below Harness's 50-event window cap so a tail read of
 * `before: TRANSCRIPT_PAGE - 1` plus its target never asks for more than the
 * engine will serve.
 */
export const TRANSCRIPT_PAGE = 24

/** Columns of indent under an event's metadata row. */
const CONTEXT_INDENT = 2

/**
 * What the conversation inspector can truthfully show.
 *
 * `stale` is only a presentation hint that a child session event arrived after
 * the window was read; the reader reloads on an explicit gesture, because
 * Harness publishes no per-child transcript subscription and polling one would
 * be a timer-backed state machine this frontend must not own.
 */
export type SubagentTranscriptReading =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
    readonly kind: 'ready'
    readonly events: readonly SessionEvent[]
    readonly hasOlder: boolean
    readonly stale: boolean
  }

/** The reader's retained state: the seq index plus one loaded window. */
export interface TranscriptState {
  /** Which reading this state resolves to. */
  readonly kind: 'unavailable' | 'loading' | 'empty' | 'failed' | 'ready'
  /** Harness's lightweight seq index for the whole child log. */
  readonly index: readonly SessionEventRecord[]
  /** The loaded window's full bodies, ascending by seq. */
  readonly events: readonly SessionEvent[]
  /** First seq of the loaded window, when one is loaded. */
  readonly startSeq?: SessionSeq
  /** Whether an older page exists before the loaded window. */
  readonly hasOlder: boolean
  /** Whether a child session event arrived since the window was read. */
  readonly stale: boolean
  /** Harness's or the transport's failure message, when the read failed. */
  readonly message?: string
}

/**
 * The state before any read has answered.
 * @param available - whether the profile mounts a session-query read surface.
 * @returns a loading state, or the honest capability absence.
 */
export function initialTranscript(available: boolean): TranscriptState {
  return {
    kind: available ? 'loading' : 'unavailable',
    index: [],
    events: [],
    hasOlder: false,
    stale: false,
  }
}

/**
 * Project the reader's state onto the small reading the overlay draws.
 * @param state - the retained reader state.
 * @returns the terminal-facing reading.
 */
export function transcriptReading(state: TranscriptState): SubagentTranscriptReading {
  switch (state.kind) {
    case 'unavailable':
    case 'loading':
    case 'empty':
      return { kind: state.kind }
    case 'failed':
      return { kind: 'failed', message: state.message ?? 'The transcript could not be read.' }
    case 'ready':
      return { kind: 'ready', events: state.events, hasOlder: state.hasOlder, stale: state.stale }
  }
}

/**
 * Read the newest page of one child's durable log.
 *
 * Two reads, both on demand: `listEvents` supplies the seq index (and the tail
 * seq a bounded window needs), and `readEvent` supplies the full bodies for the
 * newest page. No Agent is loaded, no turn is started, and the child's own
 * session log stays the only authority.
 * @param query - the bounded child-session read surface.
 * @param childId - the durable child session to read.
 * @param signal - caller cancellation, observed before the state is published.
 * @returns the newest page's state, or an honest failure state.
 */
export async function readTranscriptTail(
  query: ChildSessionReads,
  childId: SessionId,
  signal?: AbortSignal,
): Promise<TranscriptState> {
  try {
    const index = await query.listEvents(childId)
    if (index.length === 0) return { kind: 'empty', index, events: [], hasOlder: false, stale: false }
    const last = index[index.length - 1] as SessionEventRecord
    const window = await query.readEvent(
      { sessionId: childId, seq: last.seq, before: TRANSCRIPT_PAGE - 1, after: 0 },
      signal,
    )
    return {
      kind: 'ready',
      index,
      events: window.events,
      startSeq: window.startSeq,
      hasOlder: index.some(record => record.seq < window.startSeq),
      stale: false,
    }
  } catch (error: unknown) {
    return { kind: 'failed', index: [], events: [], hasOlder: false, stale: false, message: reason(error) }
  }
}

/**
 * Read one older page before the currently loaded window.
 *
 * The index from {@link readTranscriptTail} locates the record immediately
 * before the window, so paging walks the log backwards without re-reading it.
 * @param query - the bounded child-session read surface.
 * @param childId - the durable child session being inspected.
 * @param state - the currently loaded reader state.
 * @param signal - caller cancellation.
 * @returns the state with the older page prepended.
 * @throws when the read fails; the caller keeps the loaded window and reports
 *   the failure as a notice rather than discarding history it already has.
 */
export async function readTranscriptOlder(
  query: ChildSessionReads,
  childId: SessionId,
  state: TranscriptState,
  signal?: AbortSignal,
): Promise<TranscriptState> {
  const at = state.startSeq === undefined
    ? -1
    : state.index.findIndex(record => record.seq === state.startSeq)
  if (at <= 0) return { ...state, hasOlder: false }
  const previous = state.index[at - 1] as SessionEventRecord
  const window = await query.readEvent(
    { sessionId: childId, seq: previous.seq, before: TRANSCRIPT_PAGE - 1, after: 0 },
    signal,
  )
  const older = window.events.filter(event => state.events.every(loaded => loaded.seq !== event.seq))
  return {
    ...state,
    events: [...older, ...state.events],
    startSeq: window.startSeq,
    hasOlder: state.index.some(record => record.seq < window.startSeq),
    stale: false,
  }
}

/**
 * Render the loaded window as bounded terminal rows.
 *
 * An event with no semantic text — a structural boundary or an unknown
 * declaration-merged type — deliberately contributes only its metadata row,
 * exactly as `/sessions` does, rather than a stringified payload.
 * @param reading - the terminal-facing reading.
 * @param width - display columns inside the frame.
 * @returns one metadata row per event, plus wrapped body rows.
 */
export function transcriptRows(reading: SubagentTranscriptReading, width: number): string[] {
  if (reading.kind !== 'ready') return absenceRows(reading, width)
  if (reading.events.length === 0) return [mutedRow('This child has no recorded events.', width)]
  const rows: string[] = []
  const now = Date.now()
  for (const event of reading.events) {
    const meta = `${event.type} · seq ${String(event.seq)} · ${relativeAge(event.time, now)}`
    rows.push(paint(truncateToWidth(escapeControls(meta), Math.max(1, width)), 'muted'))
    const text = extractSessionEventText(event)
    if (text === '') continue
    for (const line of wrapToWidth(escapeControls(text), Math.max(1, width - CONTEXT_INDENT))) {
      rows.push(line === '' ? '' : `${' '.repeat(CONTEXT_INDENT)}${paint(line, 'subdued')}`)
    }
  }
  return rows
}

/**
 * The one truthful row for a reading with no window.
 * @param reading - an absence reading.
 * @param width - display columns inside the frame.
 * @returns the absence row.
 */
function absenceRows(reading: Exclude<SubagentTranscriptReading, { kind: 'ready' }>, width: number): string[] {
  switch (reading.kind) {
    case 'unavailable':
      return [mutedRow('Session query is not installed in this profile.', width)]
    case 'loading':
      return [mutedRow('Reading this child’s conversation…', width)]
    case 'empty':
      return [mutedRow('This child has no recorded events.', width)]
    case 'failed':
      return [paint(truncateToWidth(`Transcript failed: ${escapeControls(reading.message)}`, Math.max(1, width)), 'error')]
  }
}

/**
 * A truncated, escaped muted row.
 * @param text - untrusted or fixed message text.
 * @param width - display columns inside the frame.
 * @returns the finished row.
 */
function mutedRow(text: string, width: number): string {
  return paint(truncateToWidth(escapeControls(text), Math.max(1, width)), 'muted')
}

/**
 * A short, safe account of a read failure.
 * @param error - the thrown value.
 * @returns a message fit for a bounded row.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
