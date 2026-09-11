/**
 * The visual layout of a composer's wrapped buffer.
 *
 * The cursor is drawn AND moved through the same rows, so the two must agree on
 * what a visual row is. Keeping the layout here — rather than letting the TUI
 * re-derive it — is what makes `↑`/`↓` land where the cursor was drawn: the one
 * code that decides placement is the one code that decides movement. Text wraps
 * by display width, not by word boundary, which is the same chunking the
 * composer's rendering uses and the property that lets a prefix be located.
 * @module @dshline/renderer/composer-layout
 */

import type { Composer } from './composer.ts'
import { codePointWidth, displayWidth } from './width.ts'

/**
 * One visual row, kept with what a caller needs to map a placement back to a
 * buffer offset.
 *
 * `text` is the row WITHOUT its gutter, because a row's own text is what the
 * offset arithmetic is measured against; the gutter is prepended when the row is
 * drawn. Keeping the two apart is what lets one forward pass build both the
 * drawn row and its mapping.
 */
interface RowChunk {
  /** The row's own characters, gutter excluded. */
  readonly text: string
  /** Buffer offset (code points) of this row's first text character. */
  readonly start: number
  /** Display columns this row's gutter spends before its text begins. */
  readonly gutterWidth: number
}

/**
 * The laid-out composer: its rows, the cursor's row and column, and a way to
 * turn a row/column placement into a buffer offset.
 */
export interface ComposerLayout {
  /** Every visual row with its gutter, in draw order. */
  readonly rows: readonly string[]
  /** The visual row the cursor sits on. */
  readonly cursorRow: number
  /**
   * The cursor's display column on the DRAWN line, its gutter included. The
   * renderer adds only the frame's own border cells when it places the terminal
   * cursor, because the gutter is part of the line's text area.
   */
  readonly cursorColumn: number
  /**
   * Absolute buffer offset (code points) for a placement on a visual `row` near
   * a display `column`. The row is clamped to the layout; moving to the end of a
   * row yields the start of the next row's text, and an out-of-range column
   * yields the row's own end.
   *
   * `column` is measured exactly as {@link ComposerLayout.cursorColumn} is — on
   * the DRAWN line, gutter included — so the two are exact inverses and the
   * column a vertical move LEAVES is the column it arrives at. A gutter's own
   * cells are not navigable, so aiming inside it lands at the text's start.
   * @param row - the target visual row, clamped to a real row.
   * @param column - the display column to aim at, measured as {@link cursorColumn} is.
   * @returns the buffer offset to set the cursor to.
   */
  positionAt(row: number, column: number): number
}

/**
 * Lay out a composer's buffer into visual rows.
 *
 * ONE forward pass over a single snapshot of the buffer produces every row, the
 * cursor's placement, and each row's buffer offset together. That is a
 * correctness property as much as a performance one: the earlier shape asked the
 * composer for whole-buffer derived forms (`lines`, `cursorLine`,
 * `lineBeforeCursor`, `value`) from inside a per-line loop, so a draft of L lines
 * and N code points cost O(N·L) — thousands of full joins and rescans for one
 * `↑` press. Each row here is built from the characters as they arrive and the
 * cursor is placed from the count accumulated at its own character, so nothing is
 * re-derived and the cost is O(N) whatever the line structure.
 * @param composer - the buffer being edited.
 * @param width - display-column budget per visual row, including the gutter.
 * @param gutter - the gutter for a logical line, styled by which line it is.
 * @returns the layout, ready to draw or to move through.
 */
export function layoutComposer(
  composer: Composer,
  width: number,
  gutter: (line: number) => string,
): ComposerLayout {
  const budget = Math.max(1, width)
  // ONE reading of the buffer: the value is joined once and split into code
  // points once, and every later decision reads this array rather than asking the
  // composer again.
  const chars = [...composer.value]
  const cursor = composer.position
  const chunks: RowChunk[] = []
  /** The drawn rows, built in step with `chunks` so neither is derived twice. */
  const rows: string[] = []
  /** Index of the row currently being built. */
  let rowIndex = 0
  let cursorRow = 0
  let cursorColumn = 0
  /** Whether the loop placed the cursor at its own character. */
  let cursorPlaced = false
  /** The gutter width of the row most recently flushed, for the end cursor. */
  let lastGutterWidth = 0
  let lineIndex = 0
  let gutterText = gutter(0)
  let gutterWidth = displayWidth(gutterText)

  /** The current row's characters, gutter excluded. */
  let text = ''
  /** Display columns the current row's TEXT occupies. */
  let used = 0
  /** Buffer offset (code points) where the current row's text begins. */
  let textStart = 0
  // The gutter is spent FIRST, so it is reserved out of the row's width before
  // the first character is placed. Wrapping the text against the whole width
  // instead lets the prompt's two columns ride on top of a full row, which is
  // exactly how a `› ` line came out two columns too long. A gutter as wide as
  // the row leaves ZERO for text, which is why this floors at zero and not one:
  // flooring at one emitted the gutter plus a character past the terminal's edge.
  let textBudget = Math.max(0, budget - gutterWidth)

  /**
   * Finish the row under construction.
   *
   * A wrapped continuation row carries no gutter, so it gets the WHOLE width — a
   * reset to `budget`, not to the first row's gutter-reduced budget. Getting that
   * wrong shrank every row but the first by the prompt's width, which is the kind
   * of bug a single-row screenshot never shows. The caller resets the budget again
   * when the break was a newline and a fresh logical line's gutter applies.
   */
  const breakRow = (): void => {
    rows.push(`${gutterText}${text}`)
    chunks.push({ text, start: textStart, gutterWidth })
    lastGutterWidth = gutterWidth
    rowIndex += 1
    gutterText = ''
    gutterWidth = 0
    text = ''
    used = 0
    textStart = 0
    textBudget = budget
  }

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? ''
    if (char === '\n') {
      breakRow()
      lineIndex += 1
      gutterText = gutter(lineIndex)
      gutterWidth = displayWidth(gutterText)
      textBudget = Math.max(0, budget - gutterWidth)
      textStart = index + 1
      // A cursor resting AT a line start has no character of its own to trigger
      // the placement below: the newline it follows is not part of the next row,
      // and the loop moves on. Without this it stayed unplaced and the buffer-end
      // fallback put it on the LAST row — the caret was drawn on the wrong line,
      // and `↑` from it stepped into the wrong one.
      if (index + 1 === cursor) {
        cursorPlaced = true
        cursorRow = rowIndex
        cursorColumn = gutterWidth
      }
      continue
    }
    const charWidth = codePointWidth(char.codePointAt(0) ?? 0)
    if (used + charWidth > textBudget) {
      if (text.length > 0) {
        // The row is full: wrap the text onto the next row.
        breakRow()
        textStart = index
      } else if (gutterText !== '') {
        // The gutter alone fills the width, so there is no room for any text
        // beside it. Retire the gutter's own row and retry this character at the
        // full width, which is what keeps a one-column terminal to one column.
        breakRow()
        textStart = index
      }
      // Otherwise the row is empty and the character is simply wider than the
      // terminal: it is emitted alone, which is the only way a two-column glyph
      // can appear at all in a one-column space.
    }
    text += char
    used += charWidth
    if (index + 1 !== cursor) continue
    // The cursor sits just past this character, and its column is the width
    // accumulated AT it — never the finished row's width. Those differ wherever
    // the cursor is before the row's end, and using the row's width is what put a
    // cursor at the buffer's start onto the row after the one it belonged to.
    // The gutter counts, because the column is a cell on the DRAWN line.
    cursorPlaced = true
    cursorRow = rowIndex
    cursorColumn = gutterWidth + used
    // A row that filled its budget exactly rolls the cursor on to the next row at
    // column zero. Position zero never reaches here (no character places it), so
    // conflating "row is full" with "buffer end" cannot move the start cursor.
    // At the buffer's end the next row is not built yet, so the insertion row
    // added below is what makes the rolled position addressable.
    if (cursorColumn >= budget) {
      cursorRow += 1
      cursorColumn = 0
    }
  }

  // Position zero has no character of its own to place it during the loop, and it
  // is emphatically not the buffer's end: on a full first row the two are the
  // same column, and conflating them put the start cursor on the end's row.
  if (!cursorPlaced && cursor === 0) {
    cursorPlaced = true
    cursorRow = 0
    cursorColumn = gutterWidth
  }

  // The final line is flushed even when it is empty, so a buffer that ends in a
  // newline keeps the blank row it drew for it. Whether it filled its budget is
  // captured first: `breakRow` resets the counters the check needs.
  const finalRowFull = used >= textBudget && text.length > 0
  breakRow()

  // A cursor still unplaced sits at the buffer's very end — an empty buffer, or
  // one ending in a newline whose last row is the blank one. Its column is the
  // text it has passed on that row, which for both cases is zero; the column is
  // a cell on the drawn line, so the row's own gutter is the base.
  if (!cursorPlaced && cursor >= chars.length) {
    cursorRow = rowIndex - 1
    cursorColumn = lastGutterWidth + (cursor - textStart)
    // The buffer's end on a row that is exactly full is the one position the row
    // cannot represent apart from the next row's start, so the end cursor rolls
    // onto the insertion row the flush added below.
    if (cursorColumn >= budget) {
      cursorRow += 1
      cursorColumn = 0
    }
  }

  // A final row that filled its budget exactly leaves the buffer's end on a
  // boundary the row cannot distinguish from the next row's start. One empty
  // insertion row makes that position addressable from both directions, so `↑`
  // from it lands on the last real row and `↓` returns. It must be present
  // however the cursor moved: adding it only while the cursor sat at the end is
  // what made `↑` remove the row and strand the cursor with no way back down.
  // Only the buffer's end gets it — after an explicit newline the final row is
  // already the blank one.
  if (finalRowFull) {
    chunks.push({ text: '', start: chars.length, gutterWidth: 0 })
    rows.push('')
  }
  // A layout with no row at all has nothing for placement arithmetic to clamp to.
  if (rows.length === 0) {
    rows.push('')
    chunks.push({ text: '', start: cursor, gutterWidth: 0 })
  }

  return {
    rows,
    cursorRow,
    cursorColumn,
    positionAt(row, column) {
      const targetRow = Math.max(0, Math.min(row, chunks.length - 1))
      const chunk = chunks[targetRow] ?? { text: '', start: cursor, gutterWidth: 0 }
      // The column is a cell on the DRAWN line, so the row's gutter is spent
      // before the text begins: a column inside the gutter aims at the text's
      // start, and a column past the text clamps to the row's own end.
      const textColumn = Math.max(0, column - chunk.gutterWidth)
      let usedColumn = 0
      let index = 0
      for (const char of chunk.text) {
        const charWidth = codePointWidth(char.codePointAt(0) ?? 0)
        if (usedColumn + charWidth > textColumn) break
        usedColumn += charWidth
        index += 1
      }
      return chunk.start + index
    },
  }
}
