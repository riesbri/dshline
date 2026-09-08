/**
 * A single-choice list overlay, bounded to the terminal and searchable when long.
 *
 * Approvals, `ask_user_question`, and the model picker are the same interaction
 * — read a prompt, move through choices, confirm one — so they share one
 * implementation and differ only in what they do with the result. Anything that
 * needs a different presentation registers its own overlay instead; the slot
 * registry does not privilege this one.
 *
 * Sharing that implementation is also why the list has to bound itself HERE.
 * Every caller used to decide how many choices it offered, and one of them —
 * `/model` over a gateway route — offers whatever the provider advertises,
 * which for OpenRouter or opencode is hundreds. A picker that draws a row per
 * choice then hands `Screen` a live region taller than the screen, and the rows
 * that scrolled off can no longer be reached or erased: the next redraw leaves
 * duplicates in real scrollback and can clear output the picker never owned.
 * The list is therefore a viewport over its rows, exactly as Work, Sessions,
 * and Connect are.
 *
 * A long list also has to be reachable, not merely drawable, so past
 * {@link SEARCHABLE_CHOICES} the picker grows a query box and filters as you
 * type. Below it nothing changes: a three-choice approval spends no row on a
 * search box, and typed characters stay meaningless there.
 * @module dshline/select
 */

import type { Context } from '@deepseek-ai/cordis'
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
import { RowViewport } from './scroll.ts'
import type { TuiOverlay } from './slots.ts'

/**
 * Choices past which the picker offers a query box.
 *
 * Twelve is about what the list can show on the shortest terminal anyone drives
 * without scrolling, so below it a search box would cost a row to reach rows
 * that are already on screen. Above it the list scrolls, and typing is how a
 * reader gets to the end of it without holding a key down.
 */
export const SEARCHABLE_CHOICES = 12

/** Rows outside the heading and scrolling list: the leading blank and two borders. */
const SELECT_FIXED_ROWS = 3

/** Narrowest terminal that can hold the framed list rather than the bare answer. */
const SELECT_MIN_COLUMNS = BOX_CHROME_COLUMNS + 16

/** One selectable row. */
export interface SelectChoice {
  /** The value handed back on confirmation. */
  value: string
  /** User-facing label. */
  label: string
  /** Optional second line shown under the label when selected. */
  description?: string
}

/** How a select overlay is built and what it reports. */
export interface SelectSpec {
  /** Headline shown above the list. */
  title: string
  /** Concise identity shown in the shared root chrome. */
  readonly view?: string
  /** Optional supporting text between the title and the list. */
  detail?: string
  /** The rows; an empty list is a programming error and renders as such. */
  choices: readonly SelectChoice[]
  /** Optional initially highlighted value when it remains in the offered rows. */
  initialValue?: string
  /**
   * Called once with the confirmed value, or with undefined when the user
   * cancelled. The overlay never calls this twice.
   */
  settle(value: string | undefined): void
  /** Asks the runner to redraw after a selection move. */
  invalidate(): void
}

/**
 * Normalize text for matching: case-folded, with runs of space collapsed.
 * @param value - raw text.
 * @returns the comparable form.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ')
}

/**
 * Apply a query to the choices, preserving the caller's order.
 *
 * Matched against the LABEL alone, which is the only part of a choice every row
 * shows. Matching a description that is drawn under the selection only would
 * leave a reader unable to see why a row survived — and unable to trust the ones
 * that did not.
 * @param choices - the offered choices.
 * @param query - raw query text.
 * @returns the matching choices, in their original order.
 */
export function filterChoices(
  choices: readonly SelectChoice[],
  query: string,
): readonly SelectChoice[] {
  const needle = normalize(query)
  if (needle === '') return choices
  return choices.filter(choice => normalize(choice.label).includes(needle))
}

/** Rendered rows for a list, and which row holds the selection. */
interface Rendered {
  readonly rows: readonly string[]
  readonly selectedRow: number
  /**
   * Rows the selection occupies, which is two when it carries a description.
   *
   * The viewport has to follow the whole block rather than its first row: a
   * description drawn only under the SELECTED choice is the one row that
   * appears and disappears as the cursor moves, so tracking the label alone
   * scrolls the explanation off exactly when it is being read.
   */
  readonly selectedHeight: number
}

/**
 * Build a select overlay.
 * @param spec - the prompt, choices, and settlement callback.
 * @returns the overlay to push onto the slot registry.
 */
export function createSelectOverlay(spec: SelectSpec): TuiOverlay {
  const viewport = new RowViewport()
  // Searchability is decided from the OFFER, not from what a query has left of
  // it: a box that vanished once the list got short enough would take the query
  // with it and put the rows it had hidden back.
  const searchable = spec.choices.length > SEARCHABLE_CHOICES
  let query = ''
  const initial = spec.initialValue === undefined
    ? -1
    : spec.choices.findIndex(choice => choice.value === spec.initialValue)
  let cursor = Math.max(0, initial)
  let visible: readonly SelectChoice[] = spec.choices
  let settled = false
  const settle = (value: string | undefined): void => {
    // The overlay is dismissed by whoever pushed it, and a stray keystroke can
    // arrive between the decision and the unmount, so settlement is once-only.
    if (settled) return
    settled = true
    spec.settle(value)
  }
  const move = (amount: number): void => {
    if (visible.length === 0) return
    cursor = (cursor + amount + visible.length) % visible.length
    spec.invalidate()
  }
  const edit = (next: string): void => {
    query = next
    // Key delivery can reach Enter before the invalidation schedules a render.
    // Keep confirmation on the query's current rows rather than the previous
    // frame's offer; render repeats this assignment for presentation only.
    visible = searchable ? filterChoices(spec.choices, query) : spec.choices
    cursor = 0
    viewport.first()
    spec.invalidate()
  }
  return {
    render(columns, terminalRows = 24) {
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      visible = searchable ? filterChoices(spec.choices, query) : spec.choices
      cursor = Math.min(cursor, Math.max(0, visible.length - 1))
      const heading = headingRows(spec, searchable, query, visible.length, inner)
      const capacity = terminalRows - SELECT_FIXED_ROWS - heading.length
      if (capacity <= 0 || columns < SELECT_MIN_COLUMNS) {
        return compactFallback(visible[cursor], columns, terminalRows)
      }
      const rendered = renderChoices(visible, cursor, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      // The selection's own rows are followed as a block, so a description does
      // not fall out of the window the moment its label reaches the last visible
      // row. When the window is too short to hold both, the LABEL wins: it is
      // what identifies the choice about to be confirmed, and scrolling it away
      // to show its explanation would leave the reader confirming a row they can
      // no longer see.
      const selectedEnd = rendered.selectedRow + rendered.selectedHeight
      const overshoot = selectedEnd - viewport.end
      if (overshoot > 0) viewport.move(Math.min(overshoot, rendered.selectedRow - viewport.start))
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint(escapeControls(spec.view ?? spec.title), 'overlay-title'),
          body: [...heading, ...rendered.rows.slice(viewport.start, viewport.end)],
          footer: fitFooterHelp(
            help(searchable, query, visible.length > 0, footerBudget(columns)),
            footerBudget(columns),
          ),
        }),
      ]
      // A backstop, not the primary bound: every content row above is already
      // truncated to `inner`, so nothing here should wrap. The root frame WOULD wrap a
      // row that forgot to be, and a frame one row too tall pushes a line into
      // committed scrollback — which is the corruption this whole viewport
      // exists to prevent, so it is checked rather than assumed.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(visible[cursor], columns, terminalRows)
    },
    handleKey(key: Key) {
      if (key.kind === 'text') {
        // Typed characters are meaningless in a short picker — inserting them
        // nowhere would look like a hang — and are the whole point of a long one.
        if (searchable) edit(query + key.text)
        return
      }
      if (key.kind === 'paste') {
        // A query is one line, and pasted newlines would collapse in the matcher
        // anyway, so they collapse here where the reader can see it happen.
        if (searchable) edit(query + key.text.replace(/\s+/gu, ' '))
        return
      }
      switch (key.name) {
        case 'up':
          move(-1)
          return
        case 'down':
          move(1)
          return
        case 'home':
        case 'ctrl-a':
          cursor = 0
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          cursor = Math.max(0, visible.length - 1)
          viewport.last()
          spec.invalidate()
          return
        case 'backspace':
          // Code points, not UTF-16 units: one press deletes one character, an
          // emoji or an ideograph outside the basic plane included.
          if (searchable) edit([...query].slice(0, -1).join(''))
          return
        case 'ctrl-u':
          if (searchable) edit('')
          return
        case 'ctrl-w':
          if (searchable) edit(query.replace(/\s*\S*$/u, ''))
          return
        case 'enter':
          // Nothing is confirmed while a query has left nothing to confirm.
          // Settling with undefined here would read as a cancellation the reader
          // never asked for.
          if (visible.length > 0) settle(visible[cursor]?.value)
          return
        case 'escape':
          // Two stages while there is a query, as in the Sessions and Connect
          // browsers: a typed query is what a reader most often wants to take
          // back, and spending that keystroke on the whole question costs them
          // the list as well.
          if (searchable && query !== '') {
            edit('')
            return
          }
          settle(undefined)
          return
        case 'ctrl-c':
          settle(undefined)
          return
        default:
          return
      }
    },
  }
}

/**
 * The rows above the list: the query box when there is one, then the detail.
 * @param spec - the prompt being rendered; only the headline, detail, and
 *   offered count are read, which is what the single- and multi-select share.
 * @param searchable - whether the picker offers a query box.
 * @param query - the typed query.
 * @param shown - choices the query left.
 * @param inner - the frame's inner width in columns.
 * @returns the heading rows, ending in a separator when there are any.
 */
function headingRows(
  spec: Pick<SelectSpec, 'title' | 'detail' | 'choices'>,
  searchable: boolean,
  query: string,
  shown: number,
  inner: number,
): string[] {
  const rows: string[] = [paint(truncateToWidth(escapeControls(spec.title), inner), 'overlay-title')]
  if (searchable) rows.push(queryRow(query, counter(shown, spec.choices.length), inner))
  if (spec.detail !== undefined && spec.detail !== '') {
    for (const line of escapeControls(spec.detail).split('\n')) {
      rows.push(paint(truncateToWidth(line, inner), 'subdued'))
    }
  }
  rows.push('')
  return rows
}

/**
 * The query line: a prompt, the typed text, a cursor block, and the counter.
 * @param query - the typed query.
 * @param right - the counter text.
 * @param inner - the frame's inner width.
 * @returns one row.
 */
function queryRow(query: string, right: string, inner: number): string {
  const prompt = '\u2315 '
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 4))
  const room = Math.max(1, inner - displayWidth(prompt) - rightWidth - 1)
  // The TAIL, so a long query scrolls from the left and the characters being
  // typed stay in view; one column is held back for the cursor block.
  const typed = `${tailToWidth(escapeControls(query), Math.max(1, room - 1))}\u2588`
  const gap = Math.max(1, inner - displayWidth(prompt) - displayWidth(typed) - rightWidth)
  return `${paint(prompt, 'prompt-mark')}${typed}${' '.repeat(gap)}${paint(truncateToWidth(right, rightWidth), 'muted')}`
}

/**
 * What the counter says: how many choices, and how many were offered.
 * @param shown - choices the query left.
 * @param offered - choices before the query.
 * @returns the counter text.
 */
function counter(shown: number, offered: number): string {
  if (shown === offered) return `${String(offered)} choices`
  return `${String(shown)} of ${String(offered)}`
}

/**
 * Draw the choices at a known width.
 * @param choices - the choices the query left.
 * @param cursor - the selected index among them.
 * @param inner - the frame's inner width.
 * @returns the rows and the selection's row index among them.
 */
function renderChoices(
  choices: readonly SelectChoice[],
  cursor: number,
  inner: number,
): Rendered {
  if (choices.length === 0) {
    // An empty OFFER is a programming error and an empty result is an ordinary
    // one, but a picker cannot tell them apart at this point and does not need
    // to: either way there is nothing to confirm, and saying so is the answer.
    return {
      rows: [paint(truncateToWidth('Nothing to choose from.', inner), 'muted')],
      selectedRow: 0,
      selectedHeight: 1,
    }
  }
  const rows: string[] = []
  let selectedRow = 0
  let selectedHeight = 1
  choices.forEach((choice, index) => {
    const selected = index === cursor
    if (selected) selectedRow = rows.length
    const label = truncateToWidth(escapeControls(choice.label), inner - 2)
    rows.push(selected ? paint(`\u276f ${label}`, 'selection') : `  ${label}`)
    if (selected && choice.description !== undefined && choice.description !== '') {
      rows.push(paint(`  ${truncateToWidth(escapeControls(choice.description), inner - 2)}`, 'muted'))
      selectedHeight = 2
    }
  })
  return { rows, selectedRow, selectedHeight }
}

/**
 * The help line, truthful for the current mode and query.
 *
 * Whole segments are dropped rather than the line being cut, for the reason the
 * status line gives up whole segments. The way out is named last and surrendered
 * last: it is the only thing here a reader cannot guess.
 * @param searchable - whether the picker offers a query box.
 * @param query - the typed query.
 * @param selectable - whether any row can be confirmed.
 * @param columns - room available for the line.
 * @returns the help text that fits.
 */
function help(searchable: boolean, query: string, selectable: boolean, columns: number): string {
  const leave = searchable && query !== '' ? 'esc clear' : 'esc cancel'
  const parts = [
    ...selectable ? ['\u2191\u2193 move'] : [],
    ...searchable ? ['type to filter'] : [],
    ...selectable ? ['enter confirm'] : [],
    leave,
  ]
  for (let from = 0; from < parts.length; from += 1) {
    const line = parts.slice(from).join(' \u00b7 ')
    if (displayWidth(line) <= columns) return line
  }
  return truncateToWidth(leave, columns)
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
 * An answerable picker for a terminal too small to hold the frame.
 *
 * The selected choice is kept rather than a count, because this is a QUESTION:
 * an approval or a tool's own prompt can arrive in any geometry, and a reader
 * who cannot see what they are about to confirm cannot answer it. The frame is
 * what is given up, never the decision.
 * @param choice - the selected choice, when there is one.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @returns at most `rows` lines.
 */
function compactFallback(
  choice: SelectChoice | undefined,
  columns: number,
  rows: number,
): string[] {
  if (rows <= 0) return []
  const width = Math.max(1, columns)
  const label = choice === undefined ? 'nothing to choose from' : escapeControls(choice.label)
  const lines = [paint(truncateToWidth(`\u276f ${label}`, width), 'selection')]
  if (rows > 1) {
    const hint = ['\u2191\u2193 \u00b7 enter \u00b7 esc', 'enter \u00b7 esc', 'esc']
      .find(candidate => displayWidth(candidate) <= width)
    if (hint !== undefined) lines.push(paint(hint, 'muted'))
  }
  return lines.slice(0, rows)
}

/**
 * Show a list and wait for the answer.
 *
 * The push-await-dismiss dance is the same every time — build the overlay, hold
 * the disposer the registry hands back, and make sure settling runs it before
 * the promise resolves — and it was written out at every call site. Getting the
 * order wrong leaves a picker on screen after it has been answered, which is a
 * bug each copy has to avoid separately.
 *
 * Anything whose settlement is not a straight line from the promise keeps its
 * own: the approval prompt also settles from an abort listener, and the Sessions
 * browser settles from a resume decision its owner makes rather than from the
 * chosen row.
 * @param ctx - context carrying the slot registry.
 * @param spec - the prompt and its choices; settlement is this function's. An
 *   optional `signal` takes the question down without an answer, for a caller
 *   whose question can stop being worth asking — a Harness authorization flow
 *   racing a typed code against a browser callback withdraws the loser that way.
 * @returns the confirmed value, or undefined when the user cancelled or the
 *   question was withdrawn.
 */
export async function promptSelect(
  ctx: Context,
  spec: Omit<SelectSpec, 'settle' | 'invalidate'> & { signal?: AbortSignal },
): Promise<string | undefined> {
  return new Promise<string | undefined>(resolve => {
    let dismiss = (): void => {}
    let settled = false
    // Shared by the overlay and the withdrawal listener, because either can be
    // first and the loser must not dismiss an overlay someone else has replaced.
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      dismiss()
      resolve(value)
    }
    const overlay = createSelectOverlay({
      ...spec,
      invalidate: () => { ctx.tuiSlots.invalidate() },
      settle: finish,
    })
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
    if (spec.signal?.aborted === true) finish(undefined)
    else spec.signal?.addEventListener('abort', () => { finish(undefined) }, { once: true })
  })
}

/** How a multi-select overlay is built and what it reports. */
export interface MultiSelectSpec {
  /** Headline shown above the list. */
  title: string
  /** Concise identity shown in the shared root chrome. */
  readonly view?: string
  /** Optional supporting text between the title and the list. */
  detail?: string
  /** The rows; an empty list is a programming error and renders as such. */
  choices: readonly SelectChoice[]
  /** Values checked before the first frame, preserving continuity across a return visit. */
  readonly initialChecked?: readonly string[]
  /**
   * Called once with the checked values in the offered order, or with undefined
   * when the user cancelled. Confirming an empty set is an ordinary answer.
   */
  settle(values: string[] | undefined): void
  /** Asks the runner to redraw after a move or a toggle. */
  invalidate(): void
}

/**
 * Build a multi-select overlay: the shared picker's viewport, query, and frame
 * with toggling rows instead of one confirmable row.
 *
 * It lives beside {@link createSelectOverlay} rather than inside it because the
 * two settle differently — one value against a set — and a union settlement
 * would push that fork onto every existing caller. The internals that were
 * extracted for testing (filtering, the counter, the heading, the viewport
 * arithmetic) are reused; only the row rendering and the key map differ.
 *
 * `space` toggles in BOTH modes, searchable or not, because toggling is the
 * gesture that defines the list. The cost is a multi-word query: a searchable
 * multi-select cannot type a space into its query, so the matcher matches
 * single words. Question choices are short labels, and a picker that hid its
 * defining gesture behind a mode would be worse.
 * @param spec - the prompt, choices, and settlement callback.
 * @returns the overlay to push onto the slot registry.
 */
export function createMultiSelectOverlay(spec: MultiSelectSpec): TuiOverlay {
  const viewport = new RowViewport()
  const searchable = spec.choices.length > SEARCHABLE_CHOICES
  let query = ''
  let cursor = 0
  const checked = new Set<string>(spec.initialChecked ?? [])
  let visible: readonly SelectChoice[] = spec.choices
  let settled = false
  const settle = (values: string[] | undefined): void => {
    if (settled) return
    settled = true
    spec.settle(values)
  }
  const move = (amount: number): void => {
    if (visible.length === 0) return
    cursor = (cursor + amount + visible.length) % visible.length
    spec.invalidate()
  }
  const toggle = (): void => {
    const choice = visible[cursor]
    if (choice === undefined) return
    // The set, not the row: a query change reorders `visible`, so tracking by
    // index would check and uncheck different rows as the filter moved.
    if (checked.has(choice.value)) checked.delete(choice.value)
    else checked.add(choice.value)
    spec.invalidate()
  }
  const edit = (next: string): void => {
    query = next
    visible = searchable ? filterChoices(spec.choices, query) : spec.choices
    cursor = 0
    viewport.first()
    spec.invalidate()
  }
  return {
    render(columns, terminalRows = 24) {
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      visible = searchable ? filterChoices(spec.choices, query) : spec.choices
      cursor = Math.min(cursor, Math.max(0, visible.length - 1))
      const heading = headingRows(spec, searchable, query, visible.length, inner)
      const capacity = terminalRows - SELECT_FIXED_ROWS - heading.length
      if (capacity <= 0 || columns < SELECT_MIN_COLUMNS) {
        return multiCompactFallback(visible[cursor], checked.size, columns, terminalRows)
      }
      const rendered = renderMultiChoices(visible, cursor, checked, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      const selectedEnd = rendered.selectedRow + rendered.selectedHeight
      const overshoot = selectedEnd - viewport.end
      if (overshoot > 0) viewport.move(Math.min(overshoot, rendered.selectedRow - viewport.start))
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint(escapeControls(spec.view ?? spec.title), 'overlay-title'),
          body: [...heading, ...rendered.rows.slice(viewport.start, viewport.end)],
          footer: fitFooterHelp(
            multiHelp(checked.size, searchable, query, visible.length > 0, footerBudget(columns)),
            footerBudget(columns),
          ),
        }),
      ]
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : multiCompactFallback(visible[cursor], checked.size, columns, terminalRows)
    },
    handleKey(key: Key) {
      if (key.kind === 'text') {
        // Space toggles (see the factory comment); every other character
        // filters, exactly as the single-select picker behaves.
        if (key.text === ' ') toggle()
        else if (searchable) edit(query + key.text)
        return
      }
      if (key.kind === 'paste') {
        if (searchable) edit(query + key.text.replace(/\s+/gu, ' '))
        return
      }
      switch (key.name) {
        case 'up':
          move(-1)
          return
        case 'down':
          move(1)
          return
        case 'home':
        case 'ctrl-a':
          cursor = 0
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          cursor = Math.max(0, visible.length - 1)
          viewport.last()
          spec.invalidate()
          return
        case 'backspace':
          if (searchable) edit([...query].slice(0, -1).join(''))
          return
        case 'ctrl-u':
          if (searchable) edit('')
          return
        case 'ctrl-w':
          if (searchable) edit(query.replace(/\s*\S*$/u, ''))
          return
        case 'enter':
          // The query only filters the view; the checked set is by value, so
          // confirmation never depends on what the query left visible.
          settle([...spec.choices
            .map(choice => choice.value)
            .filter(value => checked.has(value))])
          return
        case 'escape':
          if (searchable && query !== '') {
            edit('')
            return
          }
          settle(undefined)
          return
        case 'ctrl-c':
          settle(undefined)
          return
        default:
          return
      }
    },
  }
}

/**
 * Draw the multi-select choices at a known width.
 * @param choices - the choices the query left.
 * @param cursor - the highlighted index among them.
 * @param checked - values currently checked.
 * @param inner - the frame's inner width in columns.
 * @returns the rows and the highlighted row's index among them.
 */
function renderMultiChoices(
  choices: readonly SelectChoice[],
  cursor: number,
  checked: ReadonlySet<string>,
  inner: number,
): Rendered {
  if (choices.length === 0) {
    // An empty view filters nothing away from the checked set; saying the view
    // is empty is not saying the answer is empty.
    return {
      rows: [paint(truncateToWidth('Nothing matches that.', inner), 'muted')],
      selectedRow: 0,
      selectedHeight: 1,
    }
  }
  const rows: string[] = []
  let selectedRow = 0
  let selectedHeight = 1
  choices.forEach((choice, index) => {
    const active = index === cursor
    if (active) selectedRow = rows.length
    const mark = checked.has(choice.value) ? '\u25c9' : '\u25cb'
    const label = truncateToWidth(escapeControls(choice.label), inner - 4)
    rows.push(active
      ? paint(`\u276f ${mark} ${label}`, 'selection')
      : `  ${mark} ${label}`)
    if (active && choice.description !== undefined && choice.description !== '') {
      rows.push(paint(`    ${truncateToWidth(escapeControls(choice.description), inner - 4)}`, 'muted'))
      selectedHeight = 2
    }
  })
  return { rows, selectedRow, selectedHeight }
}

/**
 * The multi-select help line: the checked count leads, and whole segments drop
 * from the front as the terminal narrows — the same ladder the single-select
 * picker runs.
 * @param checked - how many values are currently checked.
 * @param searchable - whether the picker offers a query box.
 * @param query - the typed query.
 * @param selectable - whether any row can be toggled.
 * @param columns - room available for the line.
 * @returns the help text that fits.
 */
function multiHelp(
  checked: number,
  searchable: boolean,
  query: string,
  selectable: boolean,
  columns: number,
): string {
  const leave = searchable && query !== '' ? 'esc clear' : 'esc cancel'
  const parts = [
    ...checked > 0 ? [`${String(checked)} checked`] : [],
    ...selectable ? ['space toggle'] : [],
    ...searchable ? ['type to filter'] : [],
    'enter confirm',
    leave,
  ]
  for (let from = 0; from < parts.length; from += 1) {
    const line = parts.slice(from).join(' \u00b7 ')
    if (displayWidth(line) <= columns) return line
  }
  return truncateToWidth(leave, columns)
}

/**
 * An answerable multi-select fallback for a terminal too small to hold the
 * frame. The highlighted choice and the checked count are kept, because the
 * decision — which set to confirm — survives even when the list does not.
 * @param choice - the highlighted choice, when there is one.
 * @param checked - how many values are checked.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @returns at most `rows` lines.
 */
function multiCompactFallback(
  choice: SelectChoice | undefined,
  checked: number,
  columns: number,
  rows: number,
): string[] {
  if (rows <= 0) return []
  const width = Math.max(1, columns)
  const label = choice === undefined ? 'nothing matches' : escapeControls(choice.label)
  const count = checked > 0 ? ` (${String(checked)} checked)` : ''
  const lines = [paint(truncateToWidth(`\u276f ${label}${count}`, width), 'selection')]
  if (rows > 1) {
    const hint = ['space \u00b7 enter \u00b7 esc', 'enter \u00b7 esc', 'esc']
      .find(candidate => displayWidth(candidate) <= width)
    if (hint !== undefined) lines.push(paint(hint, 'muted'))
  }
  return lines.slice(0, rows)
}

/**
 * Show a multi-select list and wait for the answer.
 *
 * The push-await-dismiss dance is {@link promptSelect}'s, with the set
 * settlement a question with `multiSelect` needs.
 * @param ctx - context carrying the slot registry.
 * @param spec - the prompt and its choices; settlement is this function's. An
 *   optional `signal` takes the question down without an answer.
 * @returns the checked values in the offered order, or undefined when the user
 *   cancelled or the question was withdrawn.
 */
export async function promptMultiSelect(
  ctx: Context,
  spec: Omit<MultiSelectSpec, 'settle' | 'invalidate'> & { signal?: AbortSignal },
): Promise<string[] | undefined> {
  return new Promise<string[] | undefined>(resolve => {
    let dismiss = (): void => {}
    let settled = false
    const finish = (values: string[] | undefined): void => {
      if (settled) return
      settled = true
      dismiss()
      resolve(values)
    }
    const overlay = createMultiSelectOverlay({
      ...spec,
      invalidate: () => { ctx.tuiSlots.invalidate() },
      settle: finish,
    })
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
    if (spec.signal?.aborted === true) finish(undefined)
    else spec.signal?.addEventListener('abort', () => { finish(undefined) }, { once: true })
  })
}
