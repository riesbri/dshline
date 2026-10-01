/**
 * Shared presentation chrome for dshline's visual root.
 * @module dshline/chrome
 */

import { BOX_CHROME_COLUMNS, displayWidth, frame, paint, type Role } from '@dshline/renderer'

/** Widest the default readable chrome draws; the composer has its own terminal-following policy. */
const MAX_COLUMNS = 100

/**
 * Narrowest terminal that still gets the normal framed chrome.
 *
 * Below this, {@link chromeWidth} would ask for a frame wider than the
 * terminal itself — safe for `frame()`, which leaves the width choice to its
 * caller, but not for a live-region view: `Screen` re-wraps an overlong
 * logical row into several physical ones, which invalidates the live-region
 * height budgeting done above it. Presentation that draws the root live
 * region (the composer, the status line) must fall back to something bounded
 * by the terminal itself below this floor, rather than asking for this width.
 * The one shared definition, so the floor is not a literal repeated at every
 * call site that needs to know it.
 */
export const CHROME_MIN_COLUMNS = BOX_CHROME_COLUMNS + 8

/** One rendering of the dshline visual root. */
export interface RootFrameOptions {
  /** The terminal's current width; the default frame width is derived from it. */
  readonly columns: number
  /**
   * Optional total width for a consumer with a different policy; it must fit the
   * terminal, and body/footer content must use its corresponding inner width.
   */
  readonly width?: number
  /** Right-hand label: already escaped and styled by the caller. It may be truncated. */
  readonly context: string
  /** Body rows: already fitted to the frame's inner width and safe. */
  readonly body: readonly string[]
  /** One-row help for the bottom border, already fitted (see fitFooterHelp). */
  readonly footer?: string
  /**
   * The semantic role the border glyphs wear.
   *
   * A role rather than a colour, so the caller says what the frame MEANS and the
   * palette still decides what that looks like — the same rule every other paint
   * call follows, and the reason this is not a free-form styling option. It
   * defaults to {@link chrome}, which is what every frame drawn as structure
   * wants, and one caller overriding it is what keeps this from being a bag:
   * there is exactly one question here, and it has one answer per theme.
   */
  readonly borderRole?: Role
}

/**
 * Default readable frame width for a terminal of `columns`, leaving a column of
 * breathing room. Overlays and document-style surfaces use this capped policy.
 * @param columns - the terminal's width.
 * @returns the default readable frame width.
 */
export function chromeWidth(columns: number): number {
  return Math.max(CHROME_MIN_COLUMNS, Math.min(columns - 1, MAX_COLUMNS))
}

/**
 * Terminal-following width for the composer's frame, leaving breathing space.
 * Unlike {@link chromeWidth}, the primary input surface intentionally has no
 * readability cap: its inner width is also used by cursor movement.
 * @param columns - the terminal's width.
 * @returns the composer's total frame width.
 */
export function composerFrameWidth(columns: number): number {
  return Math.max(CHROME_MIN_COLUMNS, columns - 1)
}

/**
 * Draw dshline's shared visual root around already-prepared content.
 * @param options - terminal width, optional total frame width, right context, body
 *   rows, optional footer help, and the border's semantic role. A supplied width
 *   must fit the terminal and the caller must fit body and footer content to it.
 * @returns the framed rows, including the integrated top and bottom borders.
 */
export function rootFrame(options: RootFrameOptions): string[] {
  // Resolved once here rather than per border run: the frame calls `border`
  // several times per row, and the role is a per-frame decision. Painting a
  // border is what it always was — SGR codes are zero-width, and `frame()`
  // measures the glyphs before they are styled, so choosing a different role
  // cannot move a column, a row, or the cursor.
  const borderRole = options.borderRole ?? 'chrome'
  return frame(options.body, {
    width: options.width ?? chromeWidth(options.columns),
    title: paint('dshline', 'banner'),
    rightTitle: options.context,
    // Help inside the bottom border stays muted, as the old external help rows
    // were; unstyled it would be the loudest text on the whole line.
    ...(options.footer === undefined ? {} : { footer: paint(options.footer, 'muted') }),
    border: text => paint(text, borderRole),
  })
}

/**
 * Display columns available to a root-frame footer label.
 * @param columns - the terminal's current width.
 * @returns the footer label budget granted by the renderer's frame geometry.
 */
export function footerBudget(columns: number): number {
  return Math.max(1, chromeWidth(columns) - 6)
}

/**
 * Fit navigation help without ever showing a misleading partial instruction.
 *
 * The budget is a DISPLAY-COLUMN width, not a terminal width: callers derive it
 * from {@link footerBudget}, so fitting here never re-derives a smaller frame
 * from an already-shrunk number.
 * @param text - help segments separated by ` · `, ordered least to most essential.
 * @param budget - columns available for the help, usually {@link footerBudget}.
 * @returns whole trailing segments, the `esc` fallback, or nothing.
 */
export function fitFooterHelp(text: string, budget: number): string {
  const width = Math.max(1, budget)
  const segments = text.split(' · ')
  while (segments.length > 1 && displayWidth(segments.join(' · ')) > width) segments.shift()

  const remainder = segments.join(' · ')
  if (displayWidth(remainder) <= width) return remainder

  const last = segments.at(-1) ?? ''
  if (displayWidth(last) <= width) return last
  if (displayWidth('esc') <= width) return 'esc'
  return ''
}
