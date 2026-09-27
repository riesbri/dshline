/**
 * Bounded live-region presentation of the authoritative Harness `turnOutline`.
 *
 * THREE surfaces, and the count is the navigation model. The outline is one
 * bounded surface; Enter pushes a read-only inspection surface over it, and that
 * surface's Enter pushes a changed-file list over itself, which in turn pushes a
 * per-file comparison. Every level is its own surface in the shared overlay
 * stack, so Escape pops exactly the top one and lands back on the level beneath
 * without a special "escape sometimes means back" state anywhere. None of them
 * writes the transcript: the native scrollback stays the transcript, and `/turns`
 * draws only the bounded index it can bound.
 *
 * Nothing here folds the log or owns turn state. Every paint re-reads the
 * current authoritative reading and resolves the selected turn by its stable
 * `turn/start` seq, so a projection update that inserts or removes a turn can
 * never silently move an action onto another one. The changed-file column is
 * read the same way — Harness publishes it, this module decides only how many
 * columns of it fit.
 * @module dshline/turns/overlay
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-turn-outline/types'
// Type-only, through the host-safe subpath: `WorkspaceChangesSummary` is the
// shape of the object Harness keeps on its own Host, and a summary this frontend
// displays must be typed as that object rather than as a look-alike.
import type { WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes/types'
import type { Key } from '@dshline/renderer'
import { displayWidth, escapeControls, paint, truncateToWidth, wrapToWidth } from '@dshline/renderer'
import { FocusRing } from '../focus.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { createBoundedSurface } from '../surface.ts'
import type { ChangedFileRow, TurnChangesReading } from './changes.ts'
import { changedFileRow } from './changes.ts'
import type { TurnReading } from './model.ts'
import { filterTurns, neighbourSeq, turnAt, turnChangesMark, turnKey, turnLabel } from './model.ts'

/** Columns a row spends on its focus gutter, before the turn number. */
const GUTTER_COLUMNS = 2

/** Spaces between an outline row's turn number and its preview. */
const TURN_NUMBER_GAP = 2

/** Spaces between an outline row's preview and its changed-file mark. */
const CHANGES_GAP = 2

/**
 * Preview columns an outline row must keep for its turn to stay identifiable.
 *
 * Below this the row drops its changed-file mark rather than its preview: the
 * mark is a summary of something else, while the preview is the only text that
 * says WHICH turn this is, and a terminal too narrow for both should say less
 * about the change than about the turn.
 */
const MIN_PREVIEW_COLUMNS = 12

/** Spaces between a changed file's display path and its counts. */
const FILE_COUNTS_GAP = 2

/** Inputs the read-only outline surface needs from the presenter. */
export interface TurnsOverlaySpec {
  /** The authoritative cut, read fresh on every paint. */
  readonly reading: () => TurnReading
  /**
   * The changed-file reading of one turn, or undefined when this composition
   * mounts no workspace-change capability.
   *
   * Asked only for the rows the terminal actually draws: the list is windowed to
   * the frame's capacity before its rows are built, so a 500-turn session costs
   * one in-memory summary lookup per VISIBLE row per paint and never one for a
   * turn the reader cannot see.
   */
  readonly changes?: (turn: number) => TurnChangesReading
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
      const rows = outlineRows(current, focus.current, viewport, query, editing, spec.changes, width, capacity)
      return rows.slice(0, Math.max(0, capacity))
    },
    compact: current => outlineCompact(current),
    // `↵ inspect` belongs to the footer only while there is a turn under the
    // cursor. On an empty outline — an empty session or a filter that matched
    // nothing — Enter opens nothing, so naming it would describe a key that
    // does the opposite of what the row says.
    footer: current => editing
      ? 'type to filter · ↵ done · esc close'
      : `↑↓ move${current.visible.length === 0 ? '' : ' · ↵ inspect'} · / filter · esc close`,
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
  /**
   * The changed-file reading of one turn, or undefined without the capability.
   * @param turn - the addressed turn's Harness-assigned number.
   * @returns what may truthfully be presented for it.
   */
  readonly changes?: (turn: number) => TurnChangesReading
  /**
   * Open the changed-file list for the addressed turn.
   *
   * The reader's Enter is the DISCLOSURE: it is the first moment anyone asks for
   * this turn's changed files, and it is what may start the one historical log
   * read. No other path from this surface reaches the file list.
   * @param turn - the addressed turn's Harness-assigned number.
   */
  readonly openChanges: (turn: number) => void
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
  /**
   * The addressed turn's number, or undefined when the current reading has none.
   * @returns the turn whose changed files Enter would open.
   */
  const addressed = (): number | undefined => {
    const current = spec.reading()
    if (current.kind !== 'list') return undefined
    return turnAt(current.turns, seq)?.turn
  }
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
    // `↵ changed files` is named only when Enter would actually open
    // something. On a turn with no workspace-change record it opens nothing, and
    // a footer promising a view the reader cannot get is worse than a footer
    // that stays quiet.
    footer: current => inspectionFooter(current, spec.changes),
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
        case 'enter': {
          const turn = addressed()
          if (turn === undefined || spec.changes === undefined) return
          // The same predicate the footer used, so a key can never open a view
          // the reader was not told about — nor fail to open one they were.
          if (!openableChanges(spec.changes(turn))) return
          spec.openChanges(turn)
          return
        }
        default:
          return
      }
    },
    close: spec.close,
  })
}

/**
 * The inspection surface's footer, naming Enter only where it opens something.
 * @param current - the addressed turn's reading.
 * @param changes - the changed-file reader, or undefined without the capability.
 * @returns the footer help.
 */
function inspectionFooter(
  current: InspectionReading,
  changes: ((turn: number) => TurnChangesReading) | undefined,
): string {
  const parts = ['↑↓ scroll', '←→ previous/next']
  // Read ONCE: this is a summary lookup, and calling it twice for one row would
  // be a second answer the footer could disagree with its own body.
  const reading = current.kind === 'entry' && changes !== undefined
    ? changes(current.turn)
    : undefined
  if (reading !== undefined && openableChanges(reading)) parts.push('↵ changed files')
  parts.push('esc back')
  return parts.join(' · ')
}

/**
 * Whether Enter on a turn's inspection surface should open its file list.
 *
 * The footer and the key handler both ask THIS, so a key can never mean
 * something the footer did not advertise — and a key that opened a view the
 * footer never offered is as wrong as one that fails to open a view it did.
 * @param reading - the turn's changed-file reading.
 * @returns whether the file list is worth opening.
 */
function openableChanges(reading: TurnChangesReading): boolean {
  return reading.kind !== 'none' && reading.kind !== 'unmounted'
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
 * @param changes - the changed-file reading of a turn, or undefined when this
 *   composition mounts no workspace-change capability.
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
  changes: ((turn: number) => TurnChangesReading) | undefined,
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
        rows.push(outlineRow(
          entry,
          current.numberWidth,
          turnKey(entry.seq) === focus,
          changes === undefined ? undefined : turnChangesMark(changes(entry.turn)),
          width,
        ))
      }
      return rows
    }
  }
}

/**
 * One outline row: the turn number, Harness's own bounded preview, and the
 * changed-file mark when Harness published one.
 * @param entry - the authoritative entry.
 * @param numberWidth - width of the widest turn number.
 * @param focused - whether this row holds the cursor.
 * @param mark - the row's changed-file mark, or undefined when it carries none.
 * @param width - display columns inside the frame.
 * @returns the finished row.
 */
function outlineRow(
  entry: TurnOutlineEntry,
  numberWidth: number,
  focused: boolean,
  mark: string | undefined,
  width: number,
): string {
  const number = String(entry.turn).padStart(numberWidth)
  // The prefix is the gutter, the turn number, and the gap after it. Budgeting
  // only the gutter lets the row outgrow the frame's inner width, so even a
  // wide terminal with room to spare wraps one turn across two physical rows.
  const prefixWidth = GUTTER_COLUMNS + numberWidth + TURN_NUMBER_GAP
  // The mark is a COLUMN, and it is the preview that yields when the terminal is
  // too narrow for both. A dropped mark costs a reader one glance at the list; a
  // dropped or wrapped preview costs the turn's entire identity, and a row that
  // outgrows the frame wraps into a physical row the frame never budgeted.
  const markRoom = mark === undefined || mark === ''
    ? 0
    : displayWidth(mark) + CHANGES_GAP
  const room = width - prefixWidth
  const keepMark = markRoom > 0 && room - markRoom >= MIN_PREVIEW_COLUMNS
  const label = truncateToWidth(escapeControls(turnLabel(entry)), Math.max(1, room - (keepMark ? markRoom : 0)))
  const suffix = keepMark && mark !== undefined ? ' '.repeat(CHANGES_GAP) + mark : ''
  return focused
    ? paint(`❯ ${number}${' '.repeat(TURN_NUMBER_GAP)}${label}${suffix}`, 'selection')
    : `  ${paint(`${number}${' '.repeat(TURN_NUMBER_GAP)}${label}${suffix}`, 'subdued')}`
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

/** Inputs the changed-file list needs from the presenter. */
export interface TurnFilesSpec {
  /**
   * The turn's changed-file reading, read fresh on every paint.
   *
   * Re-read rather than captured, because the historical read settles after this
   * surface may already be open: a list that froze its first answer would keep
   * saying "checking" over an answer that has since arrived.
   */
  readonly reading: () => TurnChangesReading
  /**
   * Disclose one listed file: ask Harness for that ONE comparison and open the
   * inspector over this list.
   *
   * The only caller of `workspaceChanges.diff` in dshline, and the only path to
   * it: moving the cursor cannot reach here, so a 500-file list costs one
   * comparison in total and only the one the reader opened.
   * @param file - the disclosed file row.
   * @param seq - the announcing event's sequence number.
   */
  readonly open: (file: ChangedFileRow, seq: number) => void
  /** Redraw after a keystroke or a settling read. */
  readonly invalidate: () => void
  /** Remove this temporary surface. */
  readonly close: () => void
}

/**
 * Create the bounded changed-file list.
 *
 * A third bounded level rather than a section of the turn inspection surface:
 * the inspection surface already spends the vertical arrows on scrolling and
 * `←`/`→` on turn navigation, so a file cursor there would make one key mean two
 * things depending on what the reader last believed. Push it instead, and let
 * Escape pop exactly one level — the kernel's own contract.
 * @param spec - the reading, the disclosure action, and the surface controls.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createTurnFilesOverlay(spec: TurnFilesSpec): TuiOverlay {
  const focus = new FocusRing()
  const viewport = new RowViewport()

  /**
   * The listed files of the current reading, in Harness's own `display` order,
   * with the focus ring aligned to them.
   *
   * Rebuilt per paint and never cached: the summary is Harness's object, its
   * order is Harness's, and a copy here would be the second list this feature is
   * forbidden from having. `focus.update` runs HERE and not only in `aimed`,
   * because a ring aligned only when Enter asks it is a ring whose cursor never
   * moved: the reader walks forty rows and opens the first one.
   */
  const listed = (): readonly ChangedFileRow[] => {
    const reading = spec.reading()
    const files = reading.kind === 'summary'
      ? reading.summary.files.map((file, index) => changedFileRow(index, file))
      : []
    focus.update(files.map(file => String(file.index)), true)
    return files
  }
  /** The file the cursor holds, or undefined when there is nothing to aim at. */
  const aimed = (): { readonly file: ChangedFileRow; readonly seq: number } | undefined => {
    const reading = spec.reading()
    if (reading.kind !== 'summary') return undefined
    const files = listed()
    const key = focus.current
    if (key === undefined) return undefined
    const file = files.find(candidate => String(candidate.index) === key)
    return file === undefined ? undefined : { file, seq: reading.seq }
  }

  return createBoundedSurface<TurnChangesReading>({
    reading: spec.reading,
    title: current => filesTitle(current),
    body: (current, width, capacity) => {
      const files = listed()
      const rows = fileRows(current, files, focus.current, viewport, width, capacity)
      return rows.slice(0, Math.max(0, capacity))
    },
    compact: current => filesCompact(current),
    footer: current => {
      const files = listed()
      // Same rule as the outline: Enter is named only while there is a file under
      // the cursor, because on an empty or unavailable list it opens nothing.
      return `↑↓ move${files.length === 0 ? '' : ' · ↵ inspect'} · esc back`
    },
    onKey: (key: Key) => {
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
          const target = aimed()
          if (target !== undefined) spec.open(target.file, target.seq)
          return
        }
        default:
          return
      }
    },
    close: spec.close,
  })
}

/**
 * The list's frame title, naming the turn it describes.
 * @param current - the turn's changed-file reading.
 * @returns a short label, without a count the reading cannot prove.
 */
function filesTitle(current: TurnChangesReading): string {
  return current.kind === 'summary' ? `Changed files · turn ${String(current.summary.turn)}` : 'Changed files'
}

/**
 * The list's whole-phrase backstop for a terminal too small to frame.
 * @param current - the turn's changed-file reading.
 * @returns a whole phrase, never a cut one.
 */
function filesCompact(current: TurnChangesReading): string {
  switch (current.kind) {
    case 'unmounted':
      return 'No change records'
    case 'none':
      return 'No changes'
    case 'unserved':
      return 'Changes unavailable'
    case 'summary':
      return current.summary.total === 0
        ? 'No changed files'
        : `Changed files ${String(current.summary.files.length)}`
  }
}

/**
 * Build the changed-file list's bounded body.
 *
 * The states that are not a list are given their own words rather than an empty
 * frame, because each of them is a different fact: no capability mounted, a read
 * in flight, a read that failed, no announcement, an announcement this Host can
 * no longer serve, and — the one a list must not blur into any of the others — a
 * summary Harness returned with zero files in it.
 * @param current - the turn's changed-file reading.
 * @param files - the listed files, in Harness order.
 * @param focus - the aimed file index, as a key.
 * @param viewport - the window over the listed files.
 * @param width - display columns inside the frame.
 * @param capacity - body rows the geometry can show.
 * @returns the bounded body rows.
 */
function fileRows(
  current: TurnChangesReading,
  files: readonly ChangedFileRow[],
  focus: string | undefined,
  viewport: RowViewport,
  width: number,
  capacity: number,
): string[] {
  switch (current.kind) {
    case 'unmounted':
      return [mutedRow('This profile mounts no workspace-change records.', width)]
    case 'none':
      return [mutedRow('Harness announced no workspace changes for this turn.', width)]
    case 'unserved':
      return [
        mutedRow('Changed-file comparison unavailable in this Host.', width),
        '',
        mutedRow('Harness announced this turn’s changes durably, but the summary', width),
        mutedRow('it recorded stays in the process that recorded it. dshline does', width),
        mutedRow('not reconstruct it from the current files.', width),
      ]
    case 'summary': {
      const { summary } = current
      if (summary.total === 0) {
        return [
          mutedRow('Harness recorded this turn as changing no files.', width),
          '',
          mutedRow('That is an upstream measurement, not an absence of one.', width),
        ]
      }
      const rows: string[] = [paint(escapeControls(summaryTotals(summary)), 'section-heading')]
      if (summary.files.length < summary.total) {
        // Truncation is Harness's own `maxFiles` cap, and `total` counts what the
        // cap dropped. Saying "N files" here would understate the real change.
        rows.push(mutedRow(
          `Harness caps a summary at ${String(summary.files.length)} files; ${String(summary.total)} changed.`,
          width,
        ))
        rows.push('')
      }
      viewport.update(files.length, Math.max(0, capacity - rows.length))
      const at = files.findIndex(file => String(file.index) === focus)
      if (at >= 0) {
        if (at < viewport.start) viewport.move(at - viewport.start)
        if (at >= viewport.end) viewport.move(at - viewport.end + 1)
      }
      for (const file of files.slice(viewport.start, viewport.end)) {
        rows.push(fileRow(file, String(file.index) === focus, width))
      }
      return rows
    }
  }
}

/**
 * One changed-file row: Harness's display path, then the counts it reported.
 *
 * `display` is Harness's own label AND its sort key, and it is file-derived text:
 * a repository can hold a file whose name carries an escape, a control character,
 * or a combining mark. It is escaped before it is measured and again before it is
 * painted, and the counts are given their space BEFORE the path is cut, because a
 * truncated count is a number the reader cannot trust.
 * @param file - the authoritative row.
 * @param focused - whether this row holds the cursor.
 * @param width - display columns inside the frame.
 * @returns the finished row.
 */
function fileRow(file: ChangedFileRow, focused: boolean, width: number): string {
  const counts = fileCounts(file)
  const room = Math.max(1, width - GUTTER_COLUMNS - displayWidth(counts) - FILE_COUNTS_GAP)
  const label = truncateToWidth(escapeControls(file.display), room)
  const body = `${label}${' '.repeat(FILE_COUNTS_GAP)}${counts}`
  return focused ? paint(`❯ ${body}`, 'selection') : `  ${paint(body, 'subdued')}`
}

/**
 * The count or refusal text Harness's own record carries for one file.
 * @param file - the authoritative row.
 * @returns the trailing column.
 */
function fileCounts(file: ChangedFileRow): string {
  if (file.oversized) return 'oversized'
  if (file.binary) return 'binary'
  return `+${String(file.added)} -${String(file.deleted)}`
}

/**
 * The heading row of a served summary: Harness's own totals over EVERY changed
 * file, not just the listed ones.
 * @param summary - the authoritative summary.
 * @returns the heading text, escaped and cut by the caller that paints it.
 */
function summaryTotals(summary: WorkspaceChangesSummary): string {
  const noun = summary.total === 1 ? 'file' : 'files'
  return `${String(summary.total)} ${noun} · +${String(summary.added)} -${String(summary.deleted)}`
}
