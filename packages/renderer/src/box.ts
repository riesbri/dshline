/**
 * Box drawing and content fitting.
 *
 * Every edge here is measured in display columns rather than string length, so a
 * CJK or emoji line inside a frame does not push its right border out of
 * alignment — the failure that makes a hand-rolled terminal UI look broken.
 * @module @dshline/renderer/box
 */

import { displayWidth, truncateToWidth, wrapToWidth } from './native-primitives.ts'

/** Rounded single-line box characters. */
const GLYPH = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  leftJunction: '├',
  rightJunction: '┤',
  horizontal: '─',
  vertical: '│',
} as const

/** Columns consumed by the left and right border plus one space of padding each. */
export const BOX_CHROME_COLUMNS = 4

/** The narrowest frame with a useful one-column content area. */
const MIN_FRAME_WIDTH = BOX_CHROME_COLUMNS + 1

/** Corners, spaces, and fixed rule beside one label, before its flexible rule run. */
const SINGLE_LABEL_FIXED_COLUMNS = 5

/** Corners, spaces, and fixed rules around two labels, before their flexible gap. */
const DUAL_LABEL_FIXED_COLUMNS = 8

/** The rule separating labels is never surrendered while both remain visible. */
const MINIMUM_LABEL_GAP_COLUMNS = 1

/** Columns unavailable to a single label, including its minimum trailing rule. */
const SINGLE_LABEL_CHROME_COLUMNS = SINGLE_LABEL_FIXED_COLUMNS + MINIMUM_LABEL_GAP_COLUMNS

/** Columns unavailable to two labels, including their minimum separating rule. */
const DUAL_LABEL_CHROME_COLUMNS = DUAL_LABEL_FIXED_COLUMNS + MINIMUM_LABEL_GAP_COLUMNS

/** A physical rule row separating two groups of frame content. */
export interface FrameDivider {
  /** Identifies this row as a divider rather than text content. */
  readonly kind: 'divider'
}

/** One logical row accepted by {@link frame}. */
export type FrameRow = string | FrameDivider

/** How a richer generic frame is drawn. */
export interface FrameOptions {
  /** Total width including borders; values below five are treated as five. */
  width: number
  /** Left-anchored label in the top border. May carry styling; line breaks render as spaces. */
  title?: string
  /** Right-anchored label in the top border. Yields before title. May carry styling. */
  rightTitle?: string
  /** Left-anchored footer in the bottom border; it adds no row. May carry styling. */
  footer?: string
  /**
   * Applied to border glyphs and runs. It may be called several times per row
   * so a styled label's reset cannot cancel the border after it; it must
   * preserve the input's display width.
   */
  border?: (text: string) => string
}

/** How a box is drawn. */
export interface BoxOptions {
  /** Total width including borders. */
  width: number
  /** Label written into the top border, omitted for a plain frame. */
  title?: string
  /** Applied to the border characters; identity when omitted. */
  border?: (text: string) => string
}

/**
 * Pad or truncate one line to exactly `columns` display columns.
 * @param line - the content, which may carry styling.
 * @param columns - the exact target width.
 * @returns the fitted line.
 */
export function fitToWidth(line: string, columns: number): string {
  const width = displayWidth(line)
  if (width === columns) return line
  if (width < columns) return line + ' '.repeat(columns - width)
  // truncateToWidth preserves whole escape sequences and closes styling when a
  // cut discards its reset, so styled content is safe in a fixed-width slot.
  const cut = truncateToWidth(line, columns)
  // A two-column character straddling the boundary is dropped whole, leaving the
  // result a column short — pad it back, or every box holding CJK draws its right
  // border one column left of the others.
  return cut + ' '.repeat(Math.max(0, columns - displayWidth(cut)))
}

/**
 * Frame `content` in a rounded box.
 *
 * Content longer than the inner width wraps rather than being clipped, because
 * the composer is the main consumer and losing typed text off the right edge is
 * worse than growing the box by a row.
 * @param content - logical content lines.
 * @param options - width, optional title, optional border styling.
 * @returns the box as rendered lines, borders included.
 */
export function box(content: readonly string[], options: BoxOptions): string[] {
  const width = Math.max(BOX_CHROME_COLUMNS + 1, options.width)
  const inner = width - BOX_CHROME_COLUMNS
  const paint = options.border ?? ((text: string) => text)
  const title = options.title === undefined || options.title === ''
    ? ''
    : ` ${truncateToWidth(options.title, Math.max(0, inner - 2))} `
  const topFill = Math.max(0, width - 2 - displayWidth(title))
  const lines = [paint(`${GLYPH.topLeft}${GLYPH.horizontal}${title}${GLYPH.horizontal.repeat(Math.max(0, topFill - 1))}${GLYPH.topRight}`)]
  const rows = content.length === 0 ? [''] : content.flatMap(line => wrapToWidth(line, inner))
  for (const row of rows) {
    lines.push(`${paint(GLYPH.vertical)} ${fitToWidth(row, inner)} ${paint(GLYPH.vertical)}`)
  }
  lines.push(paint(`${GLYPH.bottomLeft}${GLYPH.horizontal.repeat(width - 2)}${GLYPH.bottomRight}`))
  return lines
}

/**
 * Rows a box will occupy for `content`, without rendering it. The runner needs
 * this to place the cursor before the frame exists.
 * @param content - logical content lines.
 * @param width - total box width including borders.
 * @returns the row count, borders included.
 */
export function boxHeight(content: readonly string[], width: number): number {
  const inner = Math.max(1, width - BOX_CHROME_COLUMNS)
  const rows = content.length === 0 ? 1 : content.reduce((total, line) => total + wrapToWidth(line, inner).length, 0)
  return rows + 2
}

/** Replace logical line breaks inside a border label with visible spaces. */
function flattenLabel(label: string | undefined): string {
  return label?.replace(/\r\n?|\n/gu, ' ') ?? ''
}

/** Draw one plain horizontal border. */
function plainBorder(left: string, right: string, width: number, border: (text: string) => string): string {
  return border(`${left}${GLYPH.horizontal.repeat(width - 2)}${right}`)
}

/** Draw a left-anchored label in a horizontal border. */
function leftLabelBorder(
  left: string,
  right: string,
  label: string,
  width: number,
  border: (text: string) => string,
): string {
  const fitted = truncateToWidth(label, width - SINGLE_LABEL_CHROME_COLUMNS)
  if (displayWidth(fitted) < 1) return plainBorder(left, right, width, border)
  const rules = width - displayWidth(fitted) - SINGLE_LABEL_FIXED_COLUMNS
  return `${border(`${left}${GLYPH.horizontal} `)}${fitted}${border(` ${GLYPH.horizontal.repeat(rules)}${right}`)}`
}

/** Draw a right-anchored label in a horizontal border. */
function rightLabelBorder(
  left: string,
  right: string,
  label: string,
  width: number,
  border: (text: string) => string,
): string {
  const fitted = truncateToWidth(label, width - SINGLE_LABEL_CHROME_COLUMNS)
  if (displayWidth(fitted) < 1) return plainBorder(left, right, width, border)
  const rules = width - displayWidth(fitted) - SINGLE_LABEL_FIXED_COLUMNS
  return `${border(`${left}${GLYPH.horizontal.repeat(rules)} `)}${fitted}${border(` ${GLYPH.horizontal}${right}`)}`
}

/** Draw the top border under the frame's label surrender policy. */
function topBorder(options: FrameOptions, width: number, border: (text: string) => string): string {
  const title = flattenLabel(options.title)
  const rightTitle = flattenLabel(options.rightTitle)
  const titleWidth = displayWidth(title)
  const rightWidth = displayWidth(rightTitle)

  if (titleWidth < 1) {
    return rightWidth < 1
      ? plainBorder(GLYPH.topLeft, GLYPH.topRight, width, border)
      : rightLabelBorder(GLYPH.topLeft, GLYPH.topRight, rightTitle, width, border)
  }
  if (rightWidth < 1 || titleWidth > width - SINGLE_LABEL_CHROME_COLUMNS) {
    return leftLabelBorder(GLYPH.topLeft, GLYPH.topRight, title, width, border)
  }

  const rightBudget = width - DUAL_LABEL_CHROME_COLUMNS - titleWidth
  const fittedRight = truncateToWidth(rightTitle, rightBudget)
  const fittedRightWidth = displayWidth(fittedRight)
  if (rightBudget < 1 || fittedRightWidth < 1) {
    return leftLabelBorder(GLYPH.topLeft, GLYPH.topRight, title, width, border)
  }

  const rules = width - titleWidth - fittedRightWidth - DUAL_LABEL_FIXED_COLUMNS
  return `${border(`${GLYPH.topLeft}${GLYPH.horizontal} `)}${title}${border(` ${GLYPH.horizontal.repeat(rules)} `)}${fittedRight}${border(` ${GLYPH.horizontal}${GLYPH.topRight}`)}`
}

/**
 * Frame `content` with optional labels, footer, and divider rows.
 *
 * All geometry is measured in display columns. The caller must still choose a
 * width no greater than the terminal: this primitive measures and draws the
 * requested frame, while the frontend owns the available layout budget.
 *
 * The left title is kept whole whenever it fits its left-only budget. Space is
 * surrendered in this order: the right title is truncated, then omitted, and
 * only then is an overlong left title truncated. Border styling is applied to
 * separate runs around labels, so the callback may be invoked several times on
 * one row and a reset inside a styled label cannot cancel the following border.
 * @param content - logical text rows and physical dividers.
 * @param options - width, optional labels and footer, and optional border styling.
 * @returns the frame as rendered rows, borders included.
 */
export function frame(content: readonly FrameRow[], options: FrameOptions): string[] {
  const width = Math.max(MIN_FRAME_WIDTH, Math.trunc(options.width))
  const inner = width - BOX_CHROME_COLUMNS
  const border = options.border ?? ((text: string) => text)
  const lines = [topBorder(options, width, border)]
  const rows: readonly FrameRow[] = content.length === 0 ? [''] : content

  for (const row of rows) {
    if (typeof row !== 'string') {
      lines.push(plainBorder(GLYPH.leftJunction, GLYPH.rightJunction, width, border))
      continue
    }
    for (const wrapped of wrapToWidth(row, inner)) {
      lines.push(`${border(GLYPH.vertical)} ${fitToWidth(wrapped, inner)} ${border(GLYPH.vertical)}`)
    }
  }

  const footer = flattenLabel(options.footer)
  lines.push(displayWidth(footer) < 1
    ? plainBorder(GLYPH.bottomLeft, GLYPH.bottomRight, width, border)
    : leftLabelBorder(GLYPH.bottomLeft, GLYPH.bottomRight, footer, width, border))
  return lines
}

/**
 * Rows a frame will occupy without rendering it.
 *
 * Titles and the footer are integrated into the two border rows and never add
 * height. The caller is responsible for keeping `width` within the terminal.
 * @param content - logical text rows and physical dividers.
 * @param options - the total frame width including borders.
 * @returns the row count, including both borders.
 */
export function frameHeight(content: readonly FrameRow[], options: { width: number }): number {
  const width = Math.max(MIN_FRAME_WIDTH, Math.trunc(options.width))
  const inner = width - BOX_CHROME_COLUMNS
  const rows = content.length === 0
    ? 1
    : content.reduce(
      (total, row) => total + (typeof row === 'string' ? wrapToWidth(row, inner).length : 1),
      0,
    )
  return rows + 2
}
