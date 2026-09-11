/**
 * Bounded live-region presentation of the authoritative Harness `turnOutline`.
 *
 * Two surfaces, and the split is the navigation model. The outline is one
 * bounded surface; Enter pushes a second, read-only inspection surface over it,
 * so Escape pops the top of the shared surface kernel's own stack and lands
 * back on the outline without a special "escape sometimes means back" state
 * anywhere. Neither surface writes the transcript: the native scrollback stays
 * the transcript, and `/turns` draws only the bounded index it can bound.
 *
 * Nothing here folds the log or owns turn state. Every paint re-reads the
 * current authoritative reading and resolves the selected turn by its stable
 * `turn/start` seq, so a projection update that inserts or removes a turn can
 * never silently move an action onto another one.
 * @module dshline/turns/overlay
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-turn-outline/types'
import type { Key } from '@dshline/renderer'
import { displayWidth, escapeControls, paint, truncateToWidth, wrapToWidth } from '@dshline/renderer'
import { FocusRing } from '../focus.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { createBoundedSurface } from '../surface.ts'
import type { TurnReading } from './model.ts'
import { filterTurns, neighbourSeq, turnAt, turnKey, turnLabel } from './model.ts'

/** Columns a row spends on its focus gutter, before the turn number. */
const GUTTER_COLUMNS = 2

/** Spaces between an outline row's turn number and its preview. */
const TURN_NUMBER_GAP = 2

/** Inputs the read-only outline surface needs from the presenter. */
export interface TurnsOverlaySpec {
  /** The authoritative cut, read fresh on every paint. */
  readonly reading: () => TurnReading
  /** Optional initial filter, from `/turns <text>`. */
  readonly initialQuery?: string
  /**
   * Open the read-only inspection surface for one selected turn.
   *
   * The stable `turn/start` seq is handed over, not a row index, so the
   * inspection surface tracks the turn the reader chose even if the outline
   * changes underneath it.
   * @param seq - the selected entry's `turn/start` seq.
   */
  readonly inspect: (seq: SessionSeq) => void
  /** Redraw after a keystroke that changed presentation state. */
  readonly invalidate: () => void
  /** Remove this temporary surface. */
  readonly close: () => void
}

/** The outline's own presentation state, recomputed on every paint. */
interface OutlineReading {
  /** The authoritative reading being presented. */
  readonly turn: TurnReading
  /** The retained entries after the presentation-local filter. */
  readonly visible: readonly TurnOutlineEntry[]
  /** Width of the widest turn number, so the column never jitters under a filter. */
  readonly numberWidth: number
}

/**
 * Create the bounded outline surface.
 * @param spec - authoritative reading, inspection opener, and surface controls.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createTurnsOverlay(spec: TurnsOverlaySpec): TuiOverlay {
  const focus = new FocusRing()
  const viewport = new RowViewport()
  let query = spec.initialQuery ?? ''
  let editing = false

  /**
   * Recompute the outline for the current reading and query.
   *
   * Selection is re-aligned here, on every paint, so a projection update that
   * appends a turn below never drags the cursor: the aimed identity still
   * exists and keeps its place. An aim the filter removed is replaced by its
   * neighbour, which is the only case where moving is not a surprise.
   */
  const outline = (): OutlineReading => {
    const turn = spec.reading()
    const turns = turn.kind === 'list' ? turn.turns : []
    const visible = filterTurns(turns, query)
    focus.update(visible.map(entry => turnKey(entry.seq)), true)
    const numberWidth = turns.reduce((widest, entry) => Math.max(widest, String(entry.turn).length), 1)
    return { turn, visible, numberWidth }
  }
  const aimedEntry = (): OutlineReading['visible'][number] | undefined => {
    const current = outline()
    const aimed = focus.current
    return current.visible.find(entry => turnKey(entry.seq) === aimed)
  }
  const edit = (next: string): void => {
    query = next
    viewport.first()
    spec.invalidate()
  }

  return createBoundedSurface<OutlineReading>({
    reading: outline,
    title: current => outlineTitle(current),
    body: (current, width, capacity) => {
      // A filter row plus a one-line "no match" can be two rows on a terminal
      // whose body is one; slicing to the budget keeps the frame's physical-row
      // check from turning a small terminal into the backstop.
      const rows = outlineRows(current, focus.current, viewport, query, editing, width, capacity)
      return rows.slice(0, Math.max(0, capacity))
    },
    compact: current => outlineCompact(current),
    footer: () => editing
      ? 'type to filter · ↵ done · esc close'
      : '↑↓ move · ↵ inspect · / filter · esc close',
    onKey: (key: Key) => {
      // Printable text is the filter's, and only the filter's. `/` is the one
      // printable that STARTS filtering rather than being typed into it, so the
      // advertised key is a gesture instead of a character that matches nothing.
      if (key.kind === 'text') {
        if (!editing && key.text === '/') {
          editing = true
          spec.invalidate()
          return
        }
        if (editing) edit(query + key.text)
        return
      }
      if (key.kind === 'paste') {
        if (editing) edit(query + key.text.replace(/\s+/gu, ' '))
        return
      }
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          focus.move(-1)
          spec.invalidate()
          return
        case 'down':
          focus.move(1)
          spec.invalidate()
          return
        case 'home':
        case 'ctrl-a':
          focus.first()
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          focus.last()
          spec.invalidate()
          return
        case 'enter': {
          // While the filter is being edited Enter finishes editing; elsewhere
          // it opens the aimed turn. One key, two states, both named in the
          // footer, so it never means something the reader was not told.
          if (editing) {
            editing = false
            spec.invalidate()
            return
          }
          const aimed = aimedEntry()
          if (aimed !== undefined) spec.inspect(aimed.seq)
          return
        }
        case 'backspace':
          if (query !== '') edit([...query].slice(0, -1).join(''))
          return
        case 'ctrl-u':
          if (query !== '') edit('')
          return
        case 'ctrl-w':
          edit(query.replace(/\s*\S*$/u, ''))
          return
        default:
          return
      }
    },
    close: spec.close,
  })
}

/** Inputs the read-only inspection surface needs from the presenter. */
export interface TurnInspectionSpec {
  /** The authoritative cut, read fresh on every paint. */
  readonly reading: () => TurnReading
  /** The `turn/start` seq this surface opened on, captured when it opened. */
  readonly initialSeq: SessionSeq
  /** Redraw after a keystroke that moved to another turn or scrolled. */
  readonly invalidate: () => void
  /** Remove this temporary surface. */
  readonly close: () => void
}

/** What the inspection surface can show for one addressed turn. */
type InspectionReading =
  | { readonly kind: 'projections-unavailable' | 'unregistered' | 'none' | 'missing' }
  | { readonly kind: 'entry'; readonly turn: number; readonly prompt: string; readonly response: string }

/**
 * Create the bounded read-only inspection surface.
 * @param spec - authoritative reading, the captured seq, and surface controls.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createTurnInspectionOverlay(spec: TurnInspectionSpec): TuiOverlay {
  // The TARGET is the seq captured at open, never a copy of the entry: a live
  // projection update repaints from the registry's current cut, so the surface
  // cannot show a frozen answer the authority has moved past.
  let seq = spec.initialSeq
  const viewport = new RowViewport()
  const inspect = (): InspectionReading => inspectionReading(spec.reading(), seq)
  const move = (delta: -1 | 1): void => {
    const current = spec.reading()
    if (current.kind !== 'list') return
    const next = neighbourSeq(current.turns, seq, delta)
    if (next === undefined) return
    seq = next
    viewport.first()
    spec.invalidate()
  }
  return createBoundedSurface<InspectionReading>({
    reading: inspect,
    title: current => current.kind === 'entry' ? `Turn ${String(current.turn)}` : 'Turn',
    body: (current, width, capacity) => {
      if (current.kind !== 'entry') return [absenceRow(current.kind, width)]
      const rows = detailRows(current, width)
      viewport.update(rows.length, capacity)
      return rows.slice(viewport.start, viewport.end)
    },
    compact: current => current.kind === 'entry'
      ? `Turn ${String(current.turn)}`
      : absencePhrase(current.kind),
    footer: () => '↑↓ scroll · ←→ previous/next · esc back',
    onKey: (key: Key) => {
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'left':
          move(-1)
          return
        case 'right':
          move(1)
          return
        case 'up':
          viewport.move(-1)
          spec.invalidate()
          return
        case 'down':
          viewport.move(1)
          spec.invalidate()
          return
        case 'home':
        case 'ctrl-a':
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          viewport.last()
          spec.invalidate()
          return
        default:
          return
      }
    },
    close: spec.close,
  })
}

/**
 * Resolve the addressed seq against the current authoritative cut.
 * @param reading - the current authoritative reading.
 * @param seq - the captured `turn/start` seq.
 * @returns the entry reading, or the honest absence.
 */
function inspectionReading(reading: TurnReading, seq: SessionSeq): InspectionReading {
  if (reading.kind !== 'list') return { kind: reading.kind }
  const entry = turnAt(reading.turns, seq)
  if (entry === undefined) return { kind: 'missing' }
  return { kind: 'entry', turn: entry.turn, prompt: entry.prompt, response: entry.response }
}

/**
 * The outline's frame title.
 * @param current - the current outline reading.
 * @returns a short label, without inventing a count the reading cannot prove.
 */
function outlineTitle(current: OutlineReading): string {
  if (current.turn.kind !== 'list') return 'Session outline'
  const shown = current.visible.length
  const total = current.turn.turns.length
  return shown === total ? 'Session outline' : `Session outline · ${String(shown)} of ${String(total)}`
}

/**
 * Build the outline's bounded body.
 *
 * The filter row costs one row only while it exists or is being edited, so a
 * reader who never filters spends every row on turns. The list is windowed by
 * `RowViewport`, and the focused row is pulled into the window instead of the
 * whole list being drawn — a long session is bounded by the terminal, not by
 * the reader's history.
 * @param current - the current outline reading.
 * @param focus - the aimed identity.
 * @param viewport - the window over the visible entries.
 * @param query - the current filter text.
 * @param editing - whether the filter is taking keystrokes.
 * @param width - display columns inside the frame.
 * @param capacity - body rows the geometry can show.
 * @returns the bounded body rows.
 */
function outlineRows(
  current: OutlineReading,
  focus: string | undefined,
  viewport: RowViewport,
  query: string,
  editing: boolean,
  width: number,
  capacity: number,
): string[] {
  const rows: string[] = []
  if (editing || query !== '') rows.push(filterRow(query, editing, width))
  switch (current.turn.kind) {
    case 'projections-unavailable':
      rows.push(mutedRow('Session projections are unavailable in this profile.', width))
      return rows
    case 'unregistered':
      rows.push(mutedRow('The turn outline projection is not mounted in this profile.', width))
      return rows
    case 'none':
      rows.push(mutedRow('This session has no turns yet.', width))
      return rows
    case 'list': {
      if (current.visible.length === 0) {
        rows.push(mutedRow('No turn matches that filter.', width))
        return rows
      }
      viewport.update(current.visible.length, Math.max(0, capacity - rows.length))
      const at = current.visible.findIndex(entry => turnKey(entry.seq) === focus)
      if (at >= 0) {
        if (at < viewport.start) viewport.move(at - viewport.start)
        if (at >= viewport.end) viewport.move(at - viewport.end + 1)
      }
      for (const entry of current.visible.slice(viewport.start, viewport.end)) {
        rows.push(outlineRow(entry, current.numberWidth, turnKey(entry.seq) === focus, width))
      }
      return rows
    }
  }
}

/**
 * One outline row: the turn number, then Harness's own bounded preview.
 * @param entry - the authoritative entry.
 * @param numberWidth - width of the widest turn number.
 * @param focused - whether this row holds the cursor.
 * @param width - display columns inside the frame.
 * @returns the finished row.
 */
function outlineRow(
  entry: TurnOutlineEntry,
  numberWidth: number,
  focused: boolean,
  width: number,
): string {
  const number = String(entry.turn).padStart(numberWidth)
  // The prefix is the gutter, the turn number, and the gap after it. Budgeting
  // only the gutter lets the row outgrow the frame's inner width, so even a
  // wide terminal with room to spare wraps one turn across two physical rows.
  const prefixWidth = GUTTER_COLUMNS + numberWidth + TURN_NUMBER_GAP
  // Escaped BEFORE truncation and painting: a preview is model-authored text and
  // must not add a row, operate the terminal, or consume the row's reset.
  const label = truncateToWidth(escapeControls(turnLabel(entry)), Math.max(1, width - prefixWidth))
  return focused
    ? paint(`❯ ${number}${' '.repeat(TURN_NUMBER_GAP)}${label}`, 'selection')
    : `  ${paint(`${number}${' '.repeat(TURN_NUMBER_GAP)}${label}`, 'subdued')}`
}

/**
 * The filter row, with a cursor mark while it is taking keystrokes.
 * @param query - the current filter text.
 * @param editing - whether the filter is being edited.
 * @param width - display columns inside the frame.
 * @returns the finished row.
 */
function filterRow(query: string, editing: boolean, width: number): string {
  const prompt = '⌕ '
  const room = Math.max(1, width - displayWidth(prompt))
  const shown = truncateToWidth(escapeControls(query), room)
  const typed = !editing || displayWidth(shown) >= room ? shown : `${shown}█`
  return paint(`${prompt}${typed}`, editing ? 'selection' : 'muted')
}

/**
 * The inspection surface's full detail, before windowing.
 * @param current - the addressed turn's reading.
 * @param width - display columns inside the frame.
 * @returns the detail rows.
 */
function detailRows(
  current: Extract<InspectionReading, { readonly kind: 'entry' }>,
  width: number,
): string[] {
  return [
    paint('Prompt', 'section-heading'),
    ...previewRows(current.prompt, 'This turn recorded no prompt preview.', width),
    '',
    paint('Response', 'section-heading'),
    ...previewRows(current.response, 'This turn recorded no response preview.', width),
  ]
}

/**
 * One bounded preview block, wrapped rather than truncated.
 *
 * An empty preview is a VALID state — a turn may open with no eligible prompt
 * and a completed no-text turn may have no response — so it is reported as its
 * own neutral fact and never as evidence that the turn is still open.
 * @param text - the authoritative bounded preview.
 * @param empty - the sentence to show when the preview is empty.
 * @param width - display columns inside the frame.
 * @returns the block's rows.
 */
function previewRows(text: string, empty: string, width: number): string[] {
  if (text === '') return [mutedRow(empty, width)]
  // Escaped BEFORE wrapping, like the context and tool-output surfaces:
  // `escapeControls` neutralizes the escape character while PRESERVING a line
  // feed, so splitting the escaped text on `\n` still finds the paragraph
  // breaks a future multi-line preview would carry.
  return escapeControls(text)
    .split('\n')
    .flatMap(paragraph => wrapToWidth(paragraph, Math.max(1, width)))
    .map(row => paint(row, 'subdued'))
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
 * The one-row absence message for an inspection surface.
 * @param kind - the absence the reading reported.
 * @param width - display columns inside the frame.
 * @returns the finished row.
 */
function absenceRow(kind: Exclude<InspectionReading['kind'], 'entry'>, width: number): string {
  switch (kind) {
    case 'projections-unavailable':
      return mutedRow('Session projections are unavailable in this profile.', width)
    case 'unregistered':
      return mutedRow('The turn outline projection is not mounted in this profile.', width)
    case 'none':
      return mutedRow('This session has no turns yet.', width)
    case 'missing':
      return mutedRow('That turn is no longer in this session’s outline.', width)
  }
}

/**
 * The one-row backstop phrase for an inspection surface.
 * @param kind - the absence the reading reported.
 * @returns a whole phrase, never a cut one.
 */
function absencePhrase(kind: Exclude<InspectionReading['kind'], 'entry'>): string {
  switch (kind) {
    case 'projections-unavailable':
      return 'Turns unavailable'
    case 'unregistered':
      return 'Turn outline unavailable'
    case 'none':
      return 'No turns'
    case 'missing':
      return 'Turn gone'
  }
}

/**
 * The one-row backstop phrase for the outline surface.
 * @param current - the current outline reading.
 * @returns a whole phrase, never a cut one.
 */
function outlineCompact(current: OutlineReading): string {
  switch (current.turn.kind) {
    case 'projections-unavailable':
      return 'Turns unavailable'
    case 'unregistered':
      return 'Turn outline unavailable'
    case 'none':
      return 'No turns'
    case 'list':
      return current.visible.length === current.turn.turns.length
        ? `Turns ${String(current.turn.turns.length)}`
        : `Turns ${String(current.visible.length)}/${String(current.turn.turns.length)}`
  }
}
