/**
 * The `ctrl-r` history-search surface.
 *
 * An overlay rather than a slot view, unlike completion: a search owns the
 * keyboard while it is up — every printable character is query text, and `↑`
 * and `↓` walk results rather than the composer's own rows — so the ownership
 * the registry already models is exactly right. It also means the composer
 * underneath is never written to while searching, which is what makes `esc`
 * restore the draft AND its cursor for free: there is nothing to restore,
 * because nothing was taken.
 *
 * Everything drawn here is submitted input, so it is untrusted terminal text:
 * escaped before it is measured, measured in display columns, and bounded to
 * the live region by a viewport, exactly as the shared picker is.
 * @module dshline/history-search-overlay
 */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  paint,
  tailToWidth,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from './chrome.ts'
import type { HistorySearch } from './history-search.ts'
import { RowViewport } from './scroll.ts'
import type { TuiOverlay } from './slots.ts'

/** Rows outside the query box and the scrolling result list: the blank and two borders. */
const SEARCH_FIXED_ROWS = 3

/** Rows the heading spends: the query row, and the blank separating it from the results. */
const SEARCH_HEADING_ROWS = 2

/** Narrowest terminal that can hold the framed search rather than the bare answer. */
const SEARCH_MIN_COLUMNS = BOX_CHROME_COLUMNS + 16

/** Columns each result row spends on its marker, leaving the rest for the entry. */
const ROW_MARK_COLUMNS = 2

/**
 * Logical lines of a multiline entry the SELECTED result shows.
 *
 * Enough to recognise a prompt whose first line is a greeting and whose subject
 * is on the second, and small enough that a screenful of results does not become
 * one result: the list is how a reader finds a line, not how they read it back.
 */
const SELECTED_PREVIEW_LINES = 3

/** Columns of context kept after a hit when a long line is windowed around it. */
const TRAIL_COLUMNS = 12

/** Marks the row the reader is aimed at, as every other list in this frontend does. */
const CURSOR = '❯'

/** Introduces a continuation line of the selected multiline result. */
const CONTINUATION = '↳'

/** Stands in for the part of a long line a window cut away. */
const ELLIPSIS = '…'

/** What the search overlay renders and how it reports its answer. */
export interface HistorySearchSpec {
  /** The live search model: query, matches, and selection. */
  readonly search: HistorySearch
  /**
   * Report the answer, exactly once.
   * @param index - the chosen historical position, or undefined on cancellation.
   */
  settle(index: number | undefined): void
  /** Asks the runner to redraw after a query edit or a selection move. */
  invalidate(): void
}

/** One result's preview line, split around the hit so it can be painted unnested. */
interface Excerpt {
  /** Text before the hit, already windowed to fit. */
  readonly before: string
  /** The matched text itself, empty when the query did not match this line. */
  readonly hit: string
  /** Text after the hit, already windowed to fit. */
  readonly after: string
}

/**
 * The result list's layout, measured in RESULT ROWS without formatting every
 * match.
 *
 * A result row is one unselected match, or one row of the selected block. That
 * is the unit `RowViewport` indexes, so the follow policy and the visible slice
 * are the ones the whole-array renderer used. `selectedRow` is the selected
 * match's zero-based rank because every earlier unselected match contributes
 * exactly one row, and `total` counts one row per unselected match plus the
 * selected block. The selected block is formatted once here and reused when it
 * is visible, so no entry is formatted twice.
 *
 * A result row is not promised to be one PHYSICAL row: a long line whose hit
 * fills the budget can make `excerpt` overshoot by the ellipsis column, and the
 * frame's own backstop still handles that exactly as it did before.
 */
interface ResultLayout {
  /** First result row of the selected block, which is its zero-based rank. */
  readonly selectedRow: number
  /**
   * Rows the selection occupies, which is more than one when it expanded a
   * multiline entry. Followed as a block by the viewport, for the reason
   * `select.ts` follows a selected choice and its description together: the
   * rows that appear and disappear as the cursor moves are exactly the ones
   * that must not be scrolled away while they are being read.
   */
  readonly selectedHeight: number
  /** Result rows in the whole list. */
  readonly total: number
  /** The selected block's formatted rows, in order. */
  readonly selectedBlock: readonly string[]
  /** Display columns a result row may spend after its two-column mark. */
  readonly budget: number
}

/**
 * Build the history-search overlay.
 * @param spec - the search model and how to settle.
 * @returns the overlay to push onto the slot registry.
 */
export function createHistorySearchOverlay(spec: HistorySearchSpec): TuiOverlay {
  const viewport = new RowViewport()
  let settled = false
  const settle = (index: number | undefined): void => {
    // A keystroke can arrive between the decision and the unmount, so settling
    // is once-only — the same guard the shared picker keeps.
    if (settled) return
    settled = true
    spec.settle(index)
  }

  return {
    render(columns, terminalRows = 24) {
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const capacity = terminalRows - SEARCH_FIXED_ROWS - SEARCH_HEADING_ROWS
      if (capacity <= 0 || columns < SEARCH_MIN_COLUMNS) {
        return compactFallback(spec.search, columns, terminalRows)
      }
      // The list is laid out arithmetically and the viewport follows it BEFORE
      // any off-screen match is formatted. The old whole-array renderer built
      // every result row first, so redraw cost grew with the match count while
      // only the visible slice could ever be drawn.
      const layout = layoutResults(spec.search, inner)
      viewport.update(layout.total, capacity)
      if (layout.selectedRow < viewport.start) viewport.move(layout.selectedRow - viewport.start)
      // Follow the whole selected block, but never past its own first row: on a
      // window too short to hold an expanded result, the row that IDENTIFIES it
      // wins over the rows that explain it, as the shared picker's label wins
      // over its description.
      const overshoot = layout.selectedRow + layout.selectedHeight - viewport.end
      if (overshoot > 0) viewport.move(Math.min(overshoot, layout.selectedRow - viewport.start))
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint(counter(spec.search), 'overlay-title'),
          body: [
            queryRow(spec.search.query, inner),
            '',
            ...visibleResultRows(spec.search, layout, viewport.start, viewport.end),
          ],
          footer: fitFooterHelp(help(spec.search.matches.length > 0), footerBudget(columns)),
        }),
      ]
      // A backstop rather than the bound: every row above is already truncated to
      // `inner`, and the root frame would WRAP one that forgot to be — which is
      // how a live region grows past the screen and starts rewriting committed
      // scrollback. Checked rather than assumed, exactly as `select.ts` checks it.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(spec.search, columns, terminalRows)
    },
    handleKey(key: Key) {
      const { search } = spec
      if (key.kind === 'text') {
        search.append(key.text)
        spec.invalidate()
        return
      }
      if (key.kind === 'paste') {
        // A query is one line, so line breaks become one space each. ONLY line
        // breaks: matching is literal and spaces count, so collapsing runs of
        // ordinary space here would silently search for something other than
        // what was pasted — `run  tests` would stop finding `run  tests`.
        search.append(key.text.replace(/(?:\r\n?|\n)+/gu, ' '))
        spec.invalidate()
        return
      }
      switch (key.name) {
        // `ctrl-r` again is the readline gesture for "the next older one", and
        // costs nothing: the corpus is already snapshotted and folded, so this
        // moves an index and reads no persistence.
        case 'ctrl-r':
        case 'down':
          if (search.older()) spec.invalidate()
          return
        case 'up':
          if (search.newer()) spec.invalidate()
          return
        case 'home':
        case 'ctrl-a':
          if (search.first()) spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          if (search.last()) spec.invalidate()
          return
        case 'backspace':
          search.backspace()
          spec.invalidate()
          return
        case 'ctrl-u':
          search.clear()
          spec.invalidate()
          return
        case 'ctrl-w':
          search.deleteWord()
          spec.invalidate()
          return
        case 'enter': {
          // Recall, never send. A search result is a line to edit and then
          // decide about; submitting it on the same keystroke that found it
          // would make a typo in the query an executed command.
          const chosen = search.selected
          if (chosen === undefined) return
          settle(chosen)
          return
        }
        case 'escape':
          // One stage, not the shared picker's two. A picker's query is the
          // only way back to the rows it hid, so taking it back is worth a
          // keystroke; here the rows are the whole history and `ctrl-u` already
          // clears the query, so spending `esc` on it would leave a reader who
          // wants out pressing it twice.
          settle(undefined)
          return
        case 'ctrl-c':
          // Cancels the SEARCH, not the turn underneath it. While an overlay owns
          // input, `ctrl-c` is that overlay's business — a running model turn is
          // interrupted by the press that follows, once this is gone.
          settle(undefined)
          return
        default:
          // `tab` included: there is no second mode here to switch into, and
          // `ctrl-d` never reaches an overlay — the window reads it first.
          return
      }
    },
  }
}

/**
 * The right-hand label: where the selection sits among the matches.
 * @param search - the live search.
 * @returns the label for the frame's right title.
 */
function counter(search: HistorySearch): string {
  if (search.matches.length === 0) return 'History'
  return `History ${String(search.position)}/${String(search.matches.length)}`
}

/**
 * The query line: a prompt mark, the typed text, and a cursor block.
 *
 * The cursor is drawn as a block rather than placed with the terminal's own
 * cursor, because an overlay contributes no cursor placement at all — text
 * entry belongs to the composer, which is not on screen while this is up.
 * @param query - the typed query, unescaped.
 * @param inner - the frame's inner width.
 * @returns one row, fitted to `inner`.
 */
function queryRow(query: string, inner: number): string {
  const prompt = '⌕ '
  // The TAIL, so a long query scrolls from the left and what is being typed
  // stays in view; one column is held back for the block.
  const room = Math.max(1, inner - displayWidth(prompt) - 1)
  const typed = `${tailToWidth(escapeControls(query), room)}█`
  return `${paint(prompt, 'prompt-mark')}${typed}`
}

/**
 * Measure the whole result list without formatting more than one entry.
 *
 * Every unselected match is exactly one result row and the selected match owns
 * a fixed block, so the viewport's three numbers — the selected row, its height,
 * and the list's total — follow from the selected entry alone. Only that entry
 * is decoded here; the visible unselected rows are formatted later, once the
 * viewport has said which they are.
 * @param search - the live search.
 * @param inner - the frame's inner width.
 * @returns the layout the viewport follows, and the selected block to reuse.
 */
function layoutResults(search: HistorySearch, inner: number): ResultLayout {
  const budget = Math.max(1, inner - ROW_MARK_COLUMNS)
  const matches = search.matches.length
  if (matches === 0) {
    return {
      selectedRow: 0,
      selectedHeight: 1,
      total: 1,
      selectedBlock: [paint(truncateToWidth(emptyNote(search), inner), 'muted')],
      budget,
    }
  }
  const selectedRow = search.position - 1
  const selectedBlock = selectedRows(search, budget)
  return {
    selectedRow,
    selectedHeight: selectedBlock.length,
    total: matches + selectedBlock.length - 1,
    selectedBlock,
    budget,
  }
}

/**
 * The selected result's formatted block: its anchor row, its following preview
 * lines, and the summary of the ones it did not show.
 * @param search - the live search.
 * @param budget - display columns a row may spend after its mark.
 * @returns the block's rows, in draw order.
 */
function selectedRows(search: HistorySearch, budget: number): string[] {
  const { lines, anchor } = previewLines(search.selectedText ?? '', search.query)
  const rows = [
    `${paint(`${CURSOR} `, 'selection-mark')}${paintExcerpt(excerpt(lines[anchor] ?? '', search.query, budget), true)}`,
  ]
  // Following logical lines only: a prompt is read downwards, and showing the
  // lines BEFORE the anchor would push the line that actually matched off the
  // preview the reader asked for by typing the query.
  const shown = lines.slice(anchor + 1, anchor + SELECTED_PREVIEW_LINES)
  for (const line of shown) {
    rows.push(`  ${paint(truncateToWidth(`${CONTINUATION} ${line}`, budget), 'subdued')}`)
  }
  const remaining = lines.length - (anchor + 1 + shown.length)
  if (remaining > 0) {
    rows.push(`  ${paint(truncateToWidth(`${CONTINUATION} ${ELLIPSIS} ${String(remaining)} more lines`, budget), 'muted')}`)
  }
  return rows
}

/**
 * Format only the result rows the viewport can show.
 *
 * Result rows map to matches arithmetically: a row before the selected block is
 * its own zero-based rank, and a row after it is its rank shifted down by the
 * block's extra height. Nothing walks the match list, so the work here is the
 * visible rows, not every match.
 * @param search - the live search.
 * @param layout - the measured layout.
 * @param start - the viewport's first row, inclusive.
 * @param end - the viewport's end, exclusive.
 * @returns the visible result rows, in draw order.
 */
function visibleResultRows(
  search: HistorySearch,
  layout: ResultLayout,
  start: number,
  end: number,
): string[] {
  const rows: string[] = []
  for (let row = start; row < end; row += 1) {
    const picked = resultRowAt(search, layout, row)
    if (picked !== undefined) rows.push(picked)
  }
  return rows
}

/**
 * The content of one result row.
 * @param search - the live search.
 * @param layout - the measured layout.
 * @param row - the result row's index.
 * @returns the formatted row, or undefined when the row names no result.
 */
function resultRowAt(search: HistorySearch, layout: ResultLayout, row: number): string | undefined {
  const { selectedRow, selectedHeight, selectedBlock, budget } = layout
  if (row >= selectedRow && row < selectedRow + selectedHeight) {
    return selectedBlock[row - selectedRow]
  }
  // By RANK, not by text: two non-adjacent submissions of the same line are two
  // results, and the reader is aimed at exactly one of them.
  const rank = row < selectedRow ? row : row - (selectedHeight - 1)
  const index = search.matches[rank]
  if (index === undefined) return undefined
  const { lines, anchor } = previewLines(search.entry(index) ?? '', search.query)
  return `  ${paintExcerpt(excerpt(lines[anchor] ?? '', search.query, budget), false)}`
}

/**
 * What an empty result list says.
 *
 * The two remaining cases are a session with no submitted input at all and a
 * corpus that simply has no match for the query. History is fully seeded before
 * the overlay can open, so there is no third "still arriving" state to report.
 * @param search - the live search.
 * @returns the note to draw in place of results.
 */
function emptyNote(search: HistorySearch): string {
  if (search.corpusSize === 0) return 'Nothing has been sent in this session yet.'
  return 'No input matches that.'
}

/**
 * A line case-folded for locating a hit, with each folded unit mapped back.
 *
 * Two separate requirements meet here, and getting either wrong is a real bug.
 *
 * The TEXT must be `line.toLowerCase()` — the whole string, in one call — because
 * that is what `HistorySearch` decides membership with. Folding per code point
 * instead makes `ΟΣ` fold to `οσ` rather than `ος`, so a query the search
 * correctly matched cannot be found here at all, and the preview silently
 * orients on the wrong logical line.
 *
 * The MAP must exist because lowercasing does not preserve offsets: `İ` folds to
 * `i` plus a combining dot, so an index found in the folded string is a code
 * unit ahead of the same text in the original. Slicing the ORIGINAL with a
 * folded index is how `İAUTH token` searched for `auth` came to highlight
 * `UTH ` — the right number of characters, one position late.
 */
interface Folded {
  /** `line.toLowerCase()`, which is what a needle is looked for in. */
  readonly text: string
  /**
   * For each code unit of {@link Folded.text}, the code-unit offset in the
   * original that produced it, plus a final sentinel for the end.
   *
   * Undefined when the map could not be shown to describe {@link Folded.text},
   * which is the safe answer: a caller then knows only THAT the line matches,
   * and draws it unhighlighted rather than highlighting the wrong span.
   */
  readonly origin: readonly number[] | undefined
}

/**
 * Fold one line the way membership folds it, and map the result back to it.
 *
 * The map is built from per-code-point folded LENGTHS, which is the one thing
 * that can be attributed to a single source character. Contextual casing —
 * Greek final sigma is the case in the root locale — changes which character is
 * produced but not how many code units it takes, so the lengths still describe
 * the whole-string fold.
 *
 * That is an argument, not a proof, so it is checked rather than trusted: if the
 * lengths do not add up to the real folded length, some future mapping expands
 * differently in context and the map is discarded. A missing highlight is a
 * fair price; a highlight on the wrong characters is not.
 * @param line - one logical line, already escaped.
 * @returns the folded text and its offset map, or no map when it cannot be trusted.
 */
function foldLine(line: string): Folded {
  const text = line.toLowerCase()
  const origin: number[] = []
  let at = 0
  for (const character of line) {
    // One entry per folded code unit, all pointing at the same source offset:
    // a character that expands is still one place in the original.
    const width = character.toLowerCase().length
    for (let unit = 0; unit < width; unit += 1) origin.push(at)
    at += character.length
  }
  origin.push(at)
  return { text, origin: origin.length === text.length + 1 ? origin : undefined }
}

/**
 * Whether the query occurs in one line, under the rule membership uses.
 *
 * Kept apart from {@link locate} so that anchoring a preview never depends on
 * the offset map: which line to show is answerable whenever the search itself
 * would have matched, even in the case where the span cannot be.
 * @param line - one logical line, already escaped.
 * @param needle - the query, already escaped.
 * @returns whether the line contains the query.
 */
function contains(line: string, needle: string): boolean {
  if (needle === '') return false
  return foldLine(line).text.includes(needle.toLowerCase())
}

/**
 * Where the query sits in one line, as offsets into the ORIGINAL text.
 * @param line - one logical line, already escaped.
 * @param needle - the query, already escaped.
 * @returns the hit's start and end in `line`, or undefined when it is not there
 *   or when its position cannot be established safely.
 */
function locate(line: string, needle: string): { start: number; end: number } | undefined {
  if (needle === '') return undefined
  const folded = foldLine(line)
  const sought = needle.toLowerCase()
  const at = folded.text.indexOf(sought)
  if (at < 0 || folded.origin === undefined) return undefined
  const start = folded.origin[at] ?? 0
  let end = folded.origin[at + sought.length] ?? line.length
  if (end <= start) {
    // The hit ended INSIDE one source character's expansion — `i` matching the
    // first half of what `İ` folds to. Both offsets then name the same place,
    // and highlighting nothing would hide a real match, so the whole source
    // character is taken.
    end = start + ([...line.slice(start)][0]?.length ?? 0)
  }
  return { start, end }
}

/**
 * The first logical line containing the query, or the first line when none does.
 *
 * Orienting the preview here is what keeps a long multiline prompt from looking
 * like it matched for no reason: the row a reader is shown is the row that
 * explains why the row is there at all.
 * @param lines - the entry's logical lines, already escaped.
 * @param query - the typed query.
 * @returns the index of the line to preview.
 */
function anchorLine(lines: readonly string[], query: string): number {
  if (query === '') return 0
  const needle = escapeControls(query)
  const found = lines.findIndex(line => contains(line, needle))
  return found < 0 ? 0 : found
}

/**
 * One entry's logical lines, escaped, and which of them the query matched.
 *
 * Shared by the framed list and the compact fallback so a degraded terminal
 * orients its one row on the same line the frame would have. Showing the first
 * line instead brings back exactly the problem the framed renderer exists to
 * avoid: a result that appears to have matched for no visible reason.
 * @param entry - the historical entry, raw.
 * @param query - the typed query.
 * @returns the escaped lines and the index of the one to preview.
 */
function previewLines(entry: string, query: string): { lines: string[]; anchor: number } {
  const lines = escapeControls(entry).split('\n')
  return { lines, anchor: anchorLine(lines, query) }
}

/**
 * Window one preview line around its hit, so a match is always visible.
 *
 * A line wider than the row is cut, and cutting from the left alone hides
 * exactly the text the query named when the match is late in a long line. The
 * leading context is dropped instead, marked with an ellipsis so the reader can
 * see that the row starts mid-line.
 * @param line - one logical line of an entry, already escaped.
 * @param query - the typed query.
 * @param columns - display columns the row may spend.
 * @returns the row's three paintable segments.
 */
function excerpt(line: string, query: string, columns: number): Excerpt {
  const budget = Math.max(1, columns)
  const found = locate(line, escapeControls(query))
  if (found === undefined) return { before: truncateToWidth(line, budget), hit: '', after: '' }
  // Sliced with offsets into THIS string, never with an index found in a folded
  // copy of it: the two agree only until a character expands under lowercasing.
  const head = line.slice(0, found.start)
  const hit = line.slice(found.start, found.end)
  const tail = line.slice(found.end)
  if (displayWidth(line) <= budget) return { before: head, hit, after: tail }
  const hitRoom = Math.min(displayWidth(hit), budget)
  const headRoom = Math.max(0, budget - hitRoom - Math.min(displayWidth(tail), TRAIL_COLUMNS))
  const before = displayWidth(head) <= headRoom
    ? head
    // One column for the ellipsis, and the TAIL of the head, so the context
    // kept is the context immediately before the hit.
    : `${ELLIPSIS}${tailToWidth(head, Math.max(0, headRoom - 1))}`
  const kept = displayWidth(before) + hitRoom
  return {
    before,
    hit: truncateToWidth(hit, hitRoom),
    after: truncateToWidth(tail, Math.max(0, budget - kept)),
  }
}

/**
 * Paint one preview row's segments side by side, never nested.
 *
 * Three sibling `paint` calls rather than a highlight inside a styled row:
 * nesting would have the inner reset close the outer styling and leak colour
 * into whatever is drawn next.
 * @param parts - the row's segments.
 * @param selected - whether this row is the one the reader is aimed at.
 * @returns the painted row, without its leading marker.
 */
function paintExcerpt(parts: Excerpt, selected: boolean): string {
  const plain = (text: string): string => selected ? paint(text, 'selection') : text
  const marked = (text: string): string => selected ? paint(text, 'selection', 'strong') : paint(text, 'strong')
  return [
    parts.before === '' ? '' : plain(parts.before),
    parts.hit === '' ? '' : marked(parts.hit),
    parts.after === '' ? '' : plain(parts.after),
  ].join('')
}

/**
 * The help line, naming what the keys do in the order they are given up.
 *
 * The way out is named last and surrendered last, by the rule the rest of this
 * frontend's chrome follows: it is the only thing here a reader cannot guess.
 * @param selectable - whether any result can be recalled.
 * @returns the help text, before it is fitted.
 */
function help(selectable: boolean): string {
  const parts = [
    'type to search',
    ...selectable ? ['ctrl-r/↓ older', '↑ newer', '↵ recall'] : [],
    'esc cancel',
  ]
  return parts.join(' · ')
}

/**
 * Count the physical rows Screen will draw for candidate live-region lines.
 * @param lines - the candidate logical lines.
 * @param columns - the terminal's width.
 * @returns the wrapped physical rows.
 */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * A usable search for a terminal too small to hold the frame.
 *
 * The SELECTED entry is kept rather than a count, for the reason the shared
 * picker keeps its selected choice: a reader who cannot see what `enter` would
 * recall cannot decide whether to press it.
 *
 * It also has to tell the same TRUTH the frame tells: losing the room to draw a
 * border is not a reason to report a corpus that has no match as one that was
 * never searched. So the two states the frame distinguishes survive the
 * degradation, and the one row spent on a result is oriented on the line that
 * matched, exactly as the framed list orients it.
 * @param search - the live search.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @returns at most `rows` lines.
 */
function compactFallback(
  search: HistorySearch,
  columns: number,
  rows: number,
): string[] {
  if (rows <= 0) return []
  const width = Math.max(1, columns)
  const selected = search.selectedText
  // One line only: the fallback exists because there is no room, and a multiline
  // entry must not become several rows of a budget already spent. WHICH line is
  // the shared decision — the first one containing the query.
  const preview = selected === undefined
    ? undefined
    : previewLines(selected, search.query)
  // A note is not a selection, so it carries neither the cursor mark nor the
  // selection styling — the same distinction the framed list draws.
  const lines = preview === undefined
    ? [paint(truncateToWidth(emptyNote(search), width), 'muted')]
    : [paint(truncateToWidth(`${CURSOR} ${preview.lines[preview.anchor] ?? ''}`, width), 'selection')]
  if (rows > 1) {
    const query = `⌕ ${escapeControls(search.query)}█`
    lines.push(paint(truncateToWidth(query, width), 'muted'))
  }
  if (rows > 2) {
    // `↵ recall` is offered only when there is something to recall, by the same
    // rule the framed footer follows: a key named for an action it cannot
    // perform reads as the surface having failed.
    const offers = preview === undefined
      ? ['esc cancel', 'esc']
      : ['ctrl-r older · ↵ recall · esc', '↵ recall · esc', 'esc']
    const hint = offers.find(candidate => displayWidth(candidate) <= width)
    if (hint !== undefined) lines.push(paint(hint, 'muted'))
  }
  return lines.slice(0, rows)
}
