/**
 * Bounded read-only inspector for this session's goal.
 *
 * The explicit report for the bare `/goal` gesture. It owns no authority of its
 * own: {@link GoalInspection} is derived fresh from the durable projection and
 * the live activation service on every paint, and this module only decides how
 * those facts read on a terminal. There is nothing to mutate here — pausing,
 * resuming, editing, and clearing are argument-bearing forms that go to the
 * Harness command unchanged — so the overlay offers no such gesture.
 *
 * The objective is model-authored prose and the blocker is a domain string, both
 * untrusted for terminal purposes. They are escaped before measuring and before
 * styling, and the complete objective is wrapped rather than truncated: a goal
 * that is 200 rows long is still readable by scrolling, and half a sentence
 * reads as a different goal.
 * @module dshline/goals/overlay
 */

import { escapeControls, paint, truncateToWidth, wrapToWidth } from '@dshline/renderer'
import type { GoalActivation } from '@deepseek-ai/dsh-goal'
import { createBoundedSurface } from '../surface.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import type { GoalInspection } from './model.ts'

/**
 * Widest label plus its gap, so every value starts in one column.
 *
 * Twelve is `Continuation`, the longest fact name here; one more column keeps a
 * visible gap. A narrower terminal truncates the row rather than shortening
 * anything, because `padEnd` is a minimum.
 */
const LABEL_COLUMN = 13

/** Inputs the goal inspector needs from its owner. */
export interface GoalOverlaySpec {
  /** The current reading, read fresh on every paint. */
  readonly reading: () => GoalInspection
  /** Redraw after a keystroke that scrolled. */
  readonly invalidate: () => void
  /** Remove this temporary overlay. */
  readonly close: () => void
}

/**
 * Create the bounded read-only goal inspector.
 * @param spec - the authoritative reading, redraw request, and close control.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createGoalOverlay(spec: GoalOverlaySpec): TuiOverlay {
  const viewport = new RowViewport()
  // Which goal identity the document currently describes. A replacement or a
  // clear resets the window to the top; a revision or round bump on the SAME
  // goal leaves the reader where they were. Keying on the identity rather than
  // the revision is what keeps a live edit from yanking a scrolled reader back.
  let shownGoalId: string | undefined
  return createBoundedSurface<GoalInspection>({
    reading: spec.reading,
    title: () => 'Goal',
    body: (reading, width, capacity) => {
      const rows = bodyRows(reading, width)
      const id = reading.kind === 'goal' ? reading.goal.id : undefined
      if (id !== shownGoalId) {
        shownGoalId = id
        viewport.first()
      }
      viewport.update(rows.length, capacity)
      return rows.slice(viewport.start, viewport.end)
    },
    compact: reading => compactSummary(reading),
    footer: () => '↑↓ scroll · esc close',
    onKey: key => {
      if (key.kind !== 'key') return
      if (key.name !== 'up' && key.name !== 'down') return
      if (viewport.move(key.name === 'up' ? -1 : 1)) spec.invalidate()
    },
    close: spec.close,
  })
}

/**
 * The report's complete row document at one width.
 *
 * Every row is already fitted to `width`, so `frameBounded`'s second wrap is a
 * no-op and the viewport's row arithmetic matches what is drawn.
 * @param reading - the current reading.
 * @param width - display columns available inside the frame.
 * @returns painted rows, one per physical line.
 */
function bodyRows(reading: GoalInspection, width: number): string[] {
  switch (reading.kind) {
    case 'projections-unavailable':
      return [muted('Session projections are unavailable in this profile.', width)]
    case 'unregistered':
      return [muted('The goal projection is not published in this profile.', width)]
    case 'none':
      return [muted('No goal is set for this session.', width)]
    case 'goal':
      return goalRows(reading, width)
  }
}

/**
 * The facts and prose for a current goal.
 * @param reading - a `goal` reading.
 * @param width - display columns available inside the frame.
 * @returns painted rows.
 */
function goalRows(reading: Extract<GoalInspection, { kind: 'goal' }>, width: number): string[] {
  const { goal } = reading
  const rows = [
    fact('Phase', goal.phase, width),
    // The separate row is the whole point of the split: a resumed session is
    // `active` durably and `disarmed` live, and collapsing the two would report
    // either a goal that is not continuing or one that is.
    fact('Continuation', goal.phase === 'active' ? continuationLabel(reading.activation) : 'not active', width),
    fact('Rounds', `${String(reading.roundsStarted)}/${String(goal.maxGoalRounds)}`, width),
    fact('Revision', String(goal.revision), width),
    fact('Created', timestamp(reading.createdAt), width),
    fact('Updated', timestamp(reading.updatedAt), width),
    '',
    paint('Objective', 'section-heading'),
    ...prose(goal.objective, width),
  ]
  if (goal.phase === 'blocked' && goal.blockedReason !== undefined) {
    rows.push(
      '',
      paint('Blocker', 'section-heading'),
      fact('code', goal.blockedReason.code, width),
      ...prose(goal.blockedReason.message, width),
    )
  }
  return rows
}

/**
 * How this process will continue an active goal, in one word.
 *
 * An unobtainable activation is `unavailable`, never `armed`: the durable phase
 * is still `active`, and inferring continuation from it is the claim the split
 * exists to refuse.
 * @param activation - the live activation, or undefined when it could not be read.
 * @returns the label for the `Continuation` row.
 */
function continuationLabel(activation: GoalActivation | undefined): string {
  if (activation === 'armed') return 'armed'
  if (activation === 'disarmed') return 'disarmed'
  return 'unavailable'
}

/**
 * One two-column fact row.
 *
 * The value is escaped before measuring and styling: a phase is a closed union
 * and a blocker code is a domain string, but a future widener of either is still
 * untrusted text that must not repaint the frame from inside it.
 * @param label - the fact's name.
 * @param value - its raw value.
 * @param width - display columns available inside the frame.
 * @returns the painted row.
 */
function fact(label: string, value: string, width: number): string {
  return muted(`${label.padEnd(LABEL_COLUMN)}${value}`, width)
}

/**
 * Untrusted prose as complete wrapped rows.
 *
 * Escaping happens before wrapping so an embedded control cannot add a row or
 * operate the terminal, and each row is painted on its own: a single `paint`
 * over a multi-line string would leave colour open at the end of every row but
 * the last.
 * @param text - untrusted prose; line feeds are layout and survive.
 * @param width - display columns available inside the frame.
 * @returns one painted row per physical line.
 */
function prose(text: string, width: number): string[] {
  return wrapToWidth(escapeControls(text), Math.max(1, width)).map(row => paint(row, 'muted'))
}

/**
 * One escaped and truncated muted row.
 * @param text - untrusted or composed text.
 * @param width - display columns available inside the frame.
 * @returns the painted row.
 */
function muted(text: string, width: number): string {
  return paint(truncateToWidth(escapeControls(text), Math.max(1, width)), 'muted')
}

/**
 * The largest magnitude a JavaScript `Date` can represent, in epoch
 * milliseconds. `toISOString()` raises a `RangeError` beyond it.
 */
const MAX_DATE_MS = 8.64e15

/**
 * An epoch-millisecond instant as UTC ISO text.
 *
 * The Harness goal schema accepts any non-negative safe integer, which is a
 * wider range than `Date` itself, so a finite-but-out-of-range value is named
 * rather than thrown over: `toISOString()` raises a `RangeError` on an invalid
 * date, and a malformed projection value must degrade one row, not abort the
 * repaint that draws it.
 * @param ms - epoch milliseconds.
 * @returns the ISO instant, or `unknown`.
 */
function timestamp(ms: number): string {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS
    ? new Date(ms).toISOString()
    : 'unknown'
}

/**
 * The one-row truth about the reading, using no model-authored text.
 *
 * The compact ladder adds its own close suffix, so this stays a phrase.
 * @param reading - the current reading.
 * @returns the summary phrase.
 */
function compactSummary(reading: GoalInspection): string {
  switch (reading.kind) {
    case 'projections-unavailable':
    case 'unregistered':
      return 'Goal unavailable'
    case 'none':
      return 'No goal'
    case 'goal':
      return reading.goal.phase === 'active'
        ? `goal active · ${continuationLabel(reading.activation)}`
        : `goal ${reading.goal.phase}`
  }
}
