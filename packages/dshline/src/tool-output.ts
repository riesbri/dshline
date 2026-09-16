/**
 * The expanded tool-card inspector overlay.
 *
 * A compact card elides rows that are already committed into scrollback and so
 * cannot be recovered — a completed result's, or a still-pending call's own
 * presented content. This overlay renders the SAME semantic presentation the
 * card used, but at full detail, inside the live region — it is dismissed and
 * disappears, leaving the committed transcript untouched and native scrollback
 * intact.
 * @module dshline/tool-output
 */

import type { Key } from '@dshline/renderer'
import { BOX_CHROME_COLUMNS, escapeControls, paint, truncateToWidth } from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from './chrome.ts'
import { RowViewport } from './scroll.ts'
import type { TuiOverlay } from './slots.ts'
import { compactRows } from './surface.ts'

/**
 * Rows outside the inspected body: the leading blank, the two frame borders,
 * the counter, and the blank before and after the body. The body budget is
 * `terminalRows - this`, so the frame fills
 * the terminal exactly and never overflows it.
 */
const TOOL_OUTPUT_FIXED_ROWS = 6

/**
 * Narrowest inner frame that can hold a ToolCards row without re-wrapping it.
 * Card frames retain a twelve-column readability floor plus the two-column body
 * indent, so anything smaller needs the unboxed escape hatch.
 */
const TOOL_OUTPUT_MIN_INNER_COLUMNS = BOX_CHROME_COLUMNS + 10

/** Everything the inspector needs to render and dismiss itself. */
export interface ToolOutputSpec {
  /** The box title, describing what is being inspected. */
  readonly title: string
  /**
   * The title for the card currently on screen, when it can differ from
   * {@link title} by card. Read fresh on every render, exactly like
   * {@link position} — a history that mixes shapes (e.g. a still-pending
   * call's own content beside a completed result) needs the label to follow
   * whichever one is showing rather than freezing at whatever was true when
   * the overlay opened. Omit when every card in the owner's history shares
   * one title.
   * @returns the title for the card on screen right now.
   */
  label?(): string
  /**
   * Produce the expanded presentation at the current width, plus whether the
   * hard budget cut further source material.
   *
   * A PURE function of `columns`: the inspected card — a completed result's
   * presentation, or a still-pending call's own — cannot change while the
   * overlay is up, so the same width always yields the same rows. The overlay
   * relies on that to render once per width rather than once per keystroke.
   * @param columns - the terminal's current width.
   */
  render(columns: number): { rows: string[]; truncated: boolean }
  /**
   * Step to the next older retained card, if there is one.
   *
   * The overlay owns input while it is mounted, so the gesture that reaches an
   * older card has to be handled here — the runner never sees a keystroke while
   * this is on screen.
   * @returns whether it moved.
   */
  older?(): boolean
  /**
   * Step to the next newer retained card, if there is one.
   * @returns whether it moved.
   */
  newer?(): boolean
  /** Where the card on screen sits in the retained history, for the title. */
  position?(): { position: number; total: number } | undefined
  /** Called once when the user closes the overlay. */
  close(): void
  /** Asks the runner to redraw after scrolling or on resize. */
  invalidate(): void
}

/**
 * Build the tool-card inspector overlay.
 * @param spec - what to render and how to dismiss.
 * @returns the overlay to push onto the slot registry.
 */
export function createToolOutputOverlay(spec: ToolOutputSpec): TuiOverlay {
  const viewport = new RowViewport()
  let closed = false
  /** The last presentation produced, kept against the width that produced it. */
  let cached: { columns: number; rows: string[]; truncated: boolean } | undefined
  /**
   * The presentation at one width, rendering only when the width has changed.
   *
   * Scrolling redraws the whole live region on every arrow key, and the budget
   * an inspector renders at is thousands of rows — re-running the presenter,
   * re-escaping and re-wrapping all of them to move the window down by one is
   * work with no output. The inspected card is immutable, so width is the only
   * input: a resize invalidates this and nothing else can.
   * @param columns - the frame's inner width.
   * @returns the rows and whether the budget hid further source material.
   */
  const presentation = (columns: number): { rows: string[]; truncated: boolean } => {
    if (cached?.columns !== columns) cached = { columns, ...spec.render(columns) }
    return cached
  }
  /**
   * The title, carrying the position when a history exists.
   *
   * A bare `Tool output` on every card would make stepping look like a redraw:
   * two calls to the same tool can present almost identically.
   * @returns the box title.
   */
  const title = (): string => {
    const base = spec.label?.() ?? spec.title
    const rank = spec.position?.()
    return rank === undefined || rank.total <= 1
      ? base
      : `${base} ${String(rank.position)}/${String(rank.total)}`
  }
  /**
   * Move one card in the retained history, resetting what was measured against it.
   *
   * The width cache and the viewport both describe the card being replaced, so
   * both are dropped: keeping the scroll offset would open either destination
   * partway down a body the reader has not seen from the top.
   * @param direction - which neighbouring card to ask the owner for.
   * @returns whether it moved.
   */
  const step = (direction: 'older' | 'newer'): boolean => {
    if (spec[direction]?.() !== true) return false
    cached = undefined
    viewport.first()
    return true
  }
  /**
   * The key hints, advertising card switching only when a history exists.
   *
   * With one card both arrows do nothing, and advertising them would read as the
   * overlay having failed rather than as there being no history to switch.
   * @returns the hint row's text.
   */
  const hint = (): string => {
    const rank = spec.position?.()
    return rank !== undefined && rank.total > 1
      ? '↑↓ scroll · ←→ switch card · home/end jump · esc close'
      : '↑↓ scroll · home/end jump · esc close'
  }
  const close = (): void => {
    // Dismissal is once-only, as a stray keystroke can arrive during unmount.
    if (closed) return
    closed = true
    spec.close()
  }
  return {
    render(columns, terminalRows = 24) {
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      // A terminal too short for the frame still needs the escape hatch, and the
      // live region must never exceed the screen: clipped and closable beats a
      // box that overflows into scrollback.
      if (terminalRows <= TOOL_OUTPUT_FIXED_ROWS || inner < TOOL_OUTPUT_MIN_INNER_COLUMNS) {
        if (terminalRows <= 0) return []
        // One whole phrase or none of it, through the shared ladder. The copy
        // this replaced cut the summary and `esc close` to the terminal's width,
        // so a five-column terminal read `esc c`, and at one row the escape
        // hatch was not drawn at all because the truncated summary was the only
        // line — a closable surface with no visible way out.
        return compactRows(`Tool output · ${title()} · resize to inspect`, columns)
      }
      // Render the inspected card at the root frame's inner width, not the whole
      // terminal width. The root frame wraps any content row wider than its inner width
      // into another physical row (it must not truncate the composer's text), so
      // a card laid out at the full terminal width—a terminal frame plus its
      // indent, or a read/search row—would become two rows inside the overlay and
      // overflow the height budget. Laid out at `inner`, every card row is at
      // most one physical row, keeping `render(...).length <= terminalRows` true
      // for real `ToolCards.renderInspect()` output.
      const { rows, truncated } = presentation(inner)
      // Body rows share the terminal with the fixed chrome exactly, so the whole
      // live region fills the screen without spilling past it.
      const visible = terminalRows - TOOL_OUTPUT_FIXED_ROWS
      viewport.update(rows.length, visible)
      // Counter and viewport are both in presentation-row space: `rows` are the
      // scrollable rows (framing and headers included), so a scrolled-to End can
      // never read past the denominator. `+` is added only when the hard cap hid
      // further source material.
      const counter = `rows ${String(viewport.start + 1)}–${String(viewport.end)} of ${String(rows.length)}${truncated ? '+' : ''}`
      const rank = spec.position?.()
      const bodyCounter = rank !== undefined && rank.total > 1
        ? `card ${String(rank.position)}/${String(rank.total)} · ${counter}`
        : counter
      return [
        '',
        ...rootFrame({
          columns,
          context: paint(escapeControls(title()), 'overlay-title'),
          body: [
            paint(truncateToWidth(bodyCounter, inner), 'muted'),
            '',
            ...rows.slice(viewport.start, viewport.end),
            '',
          ],
          footer: fitFooterHelp(hint(), footerBudget(columns)),
        }),
      ]
    },
    handleKey(key: Key) {
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          if (viewport.move(-1)) spec.invalidate()
          return
        case 'down':
          if (viewport.move(1)) spec.invalidate()
          return
        case 'home':
        case 'ctrl-a':
          if (viewport.first()) spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          if (viewport.last()) spec.invalidate()
          return
        case 'left':
          // At either end this does nothing rather than closing or wrapping:
          // reaching a boundary must not silently move the reader elsewhere.
          if (step('older')) spec.invalidate()
          return
        case 'right':
          if (step('newer')) spec.invalidate()
          return
        case 'ctrl-o':
          // Keep the original older-card gesture working for readers who learned
          // it before the arrows became the inspector's advertised navigation.
          if (step('older')) spec.invalidate()
          return
        case 'escape':
        case 'ctrl-c':
          close()
          return
        default:
          return
      }
    },
  }
}
