/**
 * A multiple-choice list overlay, bounded to the terminal.
 *
 * Harness's question contract lets one question carry several answers
 * (`multiSelect`), which the single-choice picker in `./select.ts` cannot
 * express: its confirm is whichever row the cursor rests on. This overlay is
 * that picker with the confirm decoupled from the cursor — space flips the row
 * under it, and enter submits every flipped row at once. The Other… route is
 * the one row Enter reads by its state: while its answer is unwritten, Enter
 * opens the editor; once committed, the row is the finished answer and Enter
 * confirms in place, with tab back into the text. Movement, bounding,
 * framing, and the once-only settlement discipline are the same, and anything
 * beyond the offered rows (an `Other…` route, the editor behind it) is composed
 * by the caller: the overlay draws the row and hands back what was committed,
 * the way the picker hands back a value it does not interpret.
 *
 * The list is a viewport over its rows for the reason `./select.ts` is: a
 * picker that draws a row per choice hands `Screen` a live region taller than
 * the screen, and the rows that scrolled off can no longer be reached or
 * erased. There is deliberately no query box: a question's options are one
 * model turn's worth, not a provider's route catalogue, and the viewport keeps
 * a long list reachable without spending a row on search.
 * @module dshline/multiselect
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
import type { SelectChoice } from './select.ts'
import type { TuiOverlay } from './slots.ts'

/** Rows outside the heading and scrolling list: the leading blank and two borders. */
const MULTI_FIXED_ROWS = 3

/** Narrowest terminal that can hold the framed list rather than the bare answer. */
const MULTI_MIN_COLUMNS = BOX_CHROME_COLUMNS + 16

/**
 * Display columns a checkbox row spends before its label: the pointer gutter,
 * the box, and the space between box and label. Labels, descriptions, and the
 * Other… row budget against this so no row can push the frame into wrapping.
 */
const ROW_PREFIX_COLUMNS = 6

/** The row appended after the offered choices, opening the free-text answer. */
const OTHER_LABEL = 'Other…'

/**
 * The route's display text when an offered option already claims `Other…`.
 * The Harness contract reserves no label and requires none to be unique, so
 * the route names itself out of the way rather than presenting two rows a
 * reader cannot tell apart.
 */
const OTHER_DISAMBIGUATED = 'Other… (free text)'

/** Navigation help over the offered rows, surrendered whole segments at a time. */
const CHOICE_HELP = '↑↓ move · space toggle · enter confirm · esc cancel'

/** The route row before anything is committed: Enter opens the editor there. */
const ROUTE_EMPTY_HELP = '↑↓ move · enter edit · esc cancel'

/**
 * The route row once an answer is committed: the receipt IS the finished
 * answer, so Enter confirms in place and tab is the way back into the text.
 */
const ROUTE_EDITED_HELP = '↑↓ move · tab edit · enter confirm · esc cancel'

/**
 * The Other… row's display text for one question's offer.
 * @param offered - every label the question itself offers.
 * @returns a display text no offered option shares, so the custom route can
 *   always be told apart from the choices around it. The routing value stays
 *   the caller's private sentinel; only what is drawn adapts.
 */
export function otherDisplay(offered: readonly string[]): string {
  if (!offered.includes(OTHER_LABEL)) return OTHER_LABEL
  if (!offered.includes(OTHER_DISAMBIGUATED)) return OTHER_DISAMBIGUATED
  let suffix = 2
  while (offered.includes(`${OTHER_DISAMBIGUATED} (${String(suffix)})`)) suffix += 1
  return `${OTHER_DISAMBIGUATED} (${String(suffix)})`
}

/** What a confirmed multi-select carries, ready for the Harness answer item. */
export interface MultiSelectAnswer {
  /** Labels of the checked rows, in the order they were offered. */
  readonly selected: readonly string[]
  /** The free-text answer committed through `Other…`, when one is present. */
  readonly custom?: string
}

/** How a multi-select overlay is built and what it reports. */
export interface MultiSelectSpec {
  /** Headline shown above the list. */
  title: string
  /** Concise identity shown in the shared root chrome. */
  readonly view?: string
  /** Optional supporting text between the title and the list. */
  detail?: string
  /** The offered rows; an empty list is a programming error and renders as such. */
  choices: readonly SelectChoice[]
  /**
   * Opens the editor behind the `Other…` row, which exists only when this is
   * given. Resolves with the committed text — an empty string clears an
   * existing supplement — or with undefined when the reader backed out, which
   * keeps what was there.
   */
  editCustom?(current: string): Promise<string | undefined>
  /**
   * Called once with the confirmed answer, or with undefined when the user
   * cancelled. The overlay never calls this twice.
   */
  settle(answer: MultiSelectAnswer | undefined): void
  /** Asks the runner to redraw after a move, a toggle, or a committed edit. */
  invalidate(): void
}

/** Rendered rows for the list, and which row holds the cursor. */
interface Rendered {
  readonly rows: readonly string[]
  readonly cursorRow: number
  /**
   * Rows the cursor occupies, which is two when the highlighted choice carries
   * a description. The viewport follows the whole block, exactly as the
   * single-choice picker follows its selection's description.
   */
  readonly cursorHeight: number
}

/**
 * Build a multi-select overlay.
 * @param spec - the prompt, the offered rows, and the settlement callback.
 * @returns the overlay to push onto the slot registry.
 */
export function createMultiSelectOverlay(spec: MultiSelectSpec): TuiOverlay {
  const viewport = new RowViewport()
  // Checked state is per INDEX, not per label: two options may share a label,
  // and flipping one must not flip the other. Offer order is preserved by
  // construction, which is the order the answer reports.
  const checked = spec.choices.map(() => false)
  // The Other… row sits at index `choices.length`; without an editor behind it
  // there is nothing for it to open, so it is not offered at all.
  const lastRow = spec.editCustom === undefined ? spec.choices.length - 1 : spec.choices.length
  let custom = ''
  let cursor = 0
  let settled = false
  const settle = (answer: MultiSelectAnswer | undefined): void => {
    // Once-only for the reason the select overlay's is: the registry can deliver
    // one more keystroke between the decision and the unmount.
    if (settled) return
    settled = true
    spec.settle(answer)
  }
  const move = (amount: number): void => {
    const rowCount = lastRow + 1
    if (rowCount === 0) return
    cursor = (cursor + amount + rowCount) % rowCount
    spec.invalidate()
  }
  const toggle = (): void => {
    // Space over the Other… row flips nothing: it is an action, not a checkbox.
    if (cursor >= spec.choices.length) return
    checked[cursor] = !checked[cursor]
    spec.invalidate()
  }
  const openEditor = (): void => {
    if (settled || spec.editCustom === undefined) return
    const current = custom
    // The editor mounts above this overlay while this one waits underneath, so
    // only the topmost surface ever takes a keystroke. The result applies
    // whenever it resolves: an abort that dismisses this overlay in the
    // meantime leaves the write on state nothing reads again.
    void spec.editCustom(current).then(answer => {
      if (answer !== undefined) custom = answer
      spec.invalidate()
    })
  }
  /** The answer as it stands: flipped labels in offer order, plus any committed text. */
  const answer = (): MultiSelectAnswer => ({
    // Offer order, whatever order the boxes were flipped in: the answer quotes
    // the question's own list, it does not record the reader's path through it.
    selected: spec.choices.flatMap((choice, index) => (checked[index] ? [choice.label] : [])),
    ...custom === '' ? {} : { custom },
  })
  const confirm = (): void => {
    // On the route row Enter reads the row's state: an unanswered Other…
    // opens its editor, while a committed receipt IS the finished answer — a
    // custom-only submission must not need a detour onto an unrelated option.
    // Tab is the way back into the text either way.
    if (cursor >= spec.choices.length && custom === '') {
      openEditor()
      return
    }
    settle(answer())
  }
  return {
    render(columns, terminalRows = 24) {
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const heading = headingRows(spec, inner)
      const capacity = terminalRows - MULTI_FIXED_ROWS - heading.length
      if (capacity <= 0 || columns < MULTI_MIN_COLUMNS) {
        return compactFallback(spec, checked, cursor, custom, columns, terminalRows)
      }
      const rendered = renderRows(spec, checked, cursor, custom, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.cursorRow < viewport.start) viewport.move(rendered.cursorRow - viewport.start)
      const cursorEnd = rendered.cursorRow + rendered.cursorHeight
      const overshoot = cursorEnd - viewport.end
      if (overshoot > 0) viewport.move(Math.min(overshoot, rendered.cursorRow - viewport.start))
      // The footer states what Enter does on the ACTIVE row, which is the
      // whole point of a help line: on the route row it differs, and space
      // toggles nothing there at all.
      const helpText = cursor >= spec.choices.length
        ? custom === '' ? ROUTE_EMPTY_HELP : ROUTE_EDITED_HELP
        : CHOICE_HELP
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint(escapeControls(spec.view ?? spec.title), 'overlay-title'),
          body: [...heading, ...rendered.rows.slice(viewport.start, viewport.end)],
          footer: fitFooterHelp(helpText, footerBudget(columns)),
        }),
      ]
      // A backstop, not the primary bound: every content row above is already
      // truncated to `inner`, so nothing here should wrap. The root frame WOULD
      // wrap a row that forgot to be, and a frame one row too tall pushes a line
      // into committed scrollback — which is the corruption this whole viewport
      // exists to prevent, so it is checked rather than assumed.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(spec, checked, cursor, custom, columns, terminalRows)
    },
    handleKey(key: Key) {
      if (key.kind === 'paste') return
      if (key.kind === 'text') {
        // The spacebar decodes as text in every keyboard encoding this renderer
        // asks for, and it is the one printable key this overlay means something
        // by: it flips the row under the cursor. Any other typed text has no job
        // in a list without a query box, so it is dropped rather than inserted
        // nowhere, which would read as a hang.
        if (key.text === ' ') toggle()
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
          cursor = Math.max(0, lastRow)
          viewport.last()
          spec.invalidate()
          return
        case 'tab':
          // The editor is a row-level action, offered on the route row — the
          // one row where space toggles nothing. Elsewhere tab does nothing,
          // and the footer never advertises it.
          if (cursor >= spec.choices.length) openEditor()
          return
        case 'enter':
          confirm()
          return
        case 'escape':
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
 * The rows above the list: the title, then the detail.
 * @param spec - the prompt being rendered.
 * @param inner - the frame's inner width in columns.
 * @returns the heading rows, ending in a separator.
 */
function headingRows(spec: MultiSelectSpec, inner: number): string[] {
  const rows = [paint(truncateToWidth(escapeControls(spec.title), inner), 'overlay-title')]
  if (spec.detail !== undefined && spec.detail !== '') {
    for (const line of escapeControls(spec.detail).split('\n')) {
      rows.push(paint(truncateToWidth(line, inner), 'subdued'))
    }
  }
  rows.push('')
  return rows
}

/**
 * Draw the list at a known width.
 * @param spec - the prompt whose choices and Other… row are drawn.
 * @param checked - which rows are flipped.
 * @param cursor - the highlighted row index.
 * @param custom - the committed free-text supplement, if any.
 * @param inner - the frame's inner width in columns.
 * @returns the rows and the cursor's row index among them.
 */
function renderRows(
  spec: MultiSelectSpec,
  checked: readonly boolean[],
  cursor: number,
  custom: string,
  inner: number,
): Rendered {
  if (spec.choices.length === 0) {
    // An empty OFFER is a programming error — the answerer routes option-less
    // questions to free text — and saying so is the answer a stray direct call
    // gets, exactly as the single-choice picker renders one.
    return {
      rows: [paint(truncateToWidth('Nothing to choose from.', inner), 'muted')],
      cursorRow: 0,
      cursorHeight: 1,
    }
  }
  const budget = Math.max(1, inner - ROW_PREFIX_COLUMNS)
  const rows: string[] = []
  let cursorRow = 0
  let cursorHeight = 1
  spec.choices.forEach((choice, index) => {
    const active = index === cursor
    if (active) cursorRow = rows.length
    // State and cursor are painted as separate segments, never one colour over
    // the whole row: an outer paint would be closed by the checkbox's own reset
    // and leave the rest of the row repainted by whatever is drawn beside it.
    const pointer = active ? paint('❯ ', 'selection-mark') : '  '
    const box = paint(checked[index] ? '[x]' : '[ ]', checked[index] ? 'success' : 'muted')
    const label = truncateToWidth(escapeControls(choice.label), budget)
    rows.push(`${pointer}${box} ${active ? paint(label, 'selection') : label}`)
    if (active && choice.description !== undefined && choice.description !== '') {
      const detail = truncateToWidth(escapeControls(choice.description), budget)
      rows.push(paint(`${' '.repeat(ROW_PREFIX_COLUMNS)}${detail}`, 'muted'))
      cursorHeight = 2
    }
  })
  if (spec.editCustom !== undefined) {
    if (cursor >= spec.choices.length) cursorRow = rows.length
    const active = cursor >= spec.choices.length
    // The route names itself out of the way of any offered label (see
    // otherDisplay), and the committed supplement is shown on the row itself,
    // tail first, so what will actually be submitted stays visible however
    // long it has grown.
    const routeLabel = otherDisplay(spec.choices.map(choice => choice.label))
    const prefix = `${routeLabel}: `
    const text = custom === ''
      ? routeLabel
      : prefix + tailToWidth(escapeControls(custom), Math.max(1, budget - displayWidth(prefix)))
    const label = truncateToWidth(text, budget)
    const pointer = active ? paint('❯ ', 'selection-mark') : '  '
    rows.push(`${pointer}${active ? paint(label, 'selection') : label}`)
  }
  return { rows, cursorRow, cursorHeight }
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
 * Only the row under the cursor is drawn, its checkbox state with it — the
 * frame is what is given up, never the decision, and space, enter, and escape
 * keep working on exactly what is shown.
 * @param spec - the prompt whose cursor row is drawn.
 * @param checked - which rows are flipped.
 * @param cursor - the highlighted row index.
 * @param custom - the committed free-text supplement, if any.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @returns at most `rows` lines.
 */
function compactFallback(
  spec: MultiSelectSpec,
  checked: readonly boolean[],
  cursor: number,
  custom: string,
  columns: number,
  rows: number,
): string[] {
  if (rows <= 0) return []
  const width = Math.max(1, columns)
  const rendered = renderRows(spec, checked, cursor, custom, Math.max(1, width - ROW_PREFIX_COLUMNS))
  const lines = [rendered.rows[rendered.cursorRow] ?? '']
  if (rows > 1) {
    // The same row-truth as the framed footer: space toggles nothing on the
    // route row, so the compact hint drops it there.
    const candidates = cursor >= spec.choices.length
      ? ['enter · esc', 'esc']
      : ['space · enter · esc', 'enter · esc', 'esc']
    const hint = candidates.find(candidate => displayWidth(candidate) <= width)
    if (hint !== undefined) lines.push(paint(hint, 'muted'))
  }
  return lines.slice(0, rows)
}

/**
 * Show a multi-select list and wait for the answer.
 *
 * The twin of `promptSelect` in `./select.ts`: same push-await-dismiss dance,
 * same once-only settlement, so a caller alternating between picking one and
 * picking many writes the same three lines for both. The optional `signal`
 * takes the question down without an answer, for a caller whose request can
 * stop being worth asking.
 * @param ctx - context carrying the slot registry.
 * @param spec - the prompt and its choices; settlement is this function's.
 * @returns the confirmed answer, or undefined when the user cancelled or the
 *   question was withdrawn.
 */
export async function promptMultiSelect(
  ctx: Context,
  spec: Omit<MultiSelectSpec, 'settle' | 'invalidate'> & { signal?: AbortSignal },
): Promise<MultiSelectAnswer | undefined> {
  return new Promise<MultiSelectAnswer | undefined>(resolve => {
    let dismiss = (): void => {}
    let settled = false
    // Shared by the overlay and the withdrawal listener, because either can be
    // first and the loser must not dismiss an overlay someone else has replaced.
    const finish = (value: MultiSelectAnswer | undefined): void => {
      if (settled) return
      settled = true
      dismiss()
      resolve(value)
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
