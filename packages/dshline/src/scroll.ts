/**
 * A bounded window over physical rendered rows.
 *
 * Rendering owns what a row means; this module owns only which contiguous rows
 * are visible. Keeping those concerns apart lets modal documents, lists, and
 * future views share the same resize-safe position rules.
 * @module dshline/scroll
 */

/** One cursor-following window over rendered rows. */
export interface RowWindow {
  /** The visible rows, at most the effective capacity. */
  readonly rows: readonly string[]
  /** How many rendered rows were scrolled past above the window. */
  readonly offset: number
  /** How many rendered rows remain below the window. */
  readonly below: number
}

/**
 * Window rendered rows so the cursor's row stays visible.
 *
 * This is ONE policy shared by the primary composer and the bounded subagent
 * message overlay. It keeps the cursor's row in view and prefers to show what
 * follows it, because a person typing or pasting works at the end: the window
 * is pinned to the bottom until the cursor rises into it, then follows the
 * cursor upward. Keeping it here is what makes the two editors agree without
 * the renderer learning what a cursor is.
 *
 * `maximum` is the budget the current geometry grants and `cap` is the caller's
 * own absolute ceiling; the effective window is the smaller of the two. A
 * caller with only a geometry budget passes no `cap`. A capacity of zero still
 * yields one row when there are rows to show, so a short terminal degrades to a
 * single line rather than an empty body; callers that must draw nothing at a
 * zero budget slice the result themselves.
 * @param rows - every rendered row, in draw order.
 * @param cursorRow - the cursor's row index within `rows`.
 * @param maximum - most rows the current geometry can draw.
 * @param cap - the caller's own absolute limit, or unlimited when omitted.
 * @returns the visible slice and the counts scrolled past above and below it.
 */
export function cursorWindow(
  rows: readonly string[],
  cursorRow: number,
  maximum: number,
  cap: number = Number.POSITIVE_INFINITY,
): RowWindow {
  const visible = Math.max(1, Math.min(cap, maximum, rows.length))
  if (rows.length <= visible) return { rows, offset: 0, below: 0 }
  const offset = Math.min(rows.length - visible, Math.max(0, cursorRow - visible + 1))
  return { rows: rows.slice(offset, offset + visible), offset, below: rows.length - offset - visible }
}

/** A scroll position over a sequence of rendered rows. */
export class RowViewport {
  private offset = 0
  private total = 0
  private visible = 1

  /**
   * Update the document and window sizes, retaining the current position where
   * it remains valid.
   * @param total - rendered rows in the complete document.
   * @param visible - rows the current layout can show, possibly zero.
   * @returns whether a smaller document or wider window moved the viewport.
   */
  update(total: number, visible: number): boolean {
    this.total = Math.max(0, total)
    this.visible = Math.max(0, visible)
    const next = Math.min(this.offset, this.maxOffset)
    if (next === this.offset) return false
    this.offset = next
    return true
  }

  /**
   * Move by physical rendered rows, clamped to the document's bounds.
   * @param amount - positive moves down; negative moves up.
   * @returns whether the position changed.
   */
  move(amount: number): boolean {
    const next = Math.min(Math.max(this.offset + amount, 0), this.maxOffset)
    if (next === this.offset) return false
    this.offset = next
    return true
  }

  /**
   * Page through the document by about one visible window.
   *
   * A line-by-line hop would need dozens of presses on a long document, so this
   * advances by the whole visible window minus one row: the overlap keeps the
   * last row of the previous page in view, which anchors the reader's eye as
   * the document shifts. A window of one still pages by one.
   * @param direction - +1 pages down, -1 pages up.
   * @returns whether the position changed.
   */
  page(direction: 1 | -1): boolean {
    return this.move(direction * Math.max(1, this.visible - 1))
  }

  /**
   * Jump to the document's first row.
   * @returns whether the position changed.
   */
  first(): boolean {
    if (this.offset === 0) return false
    this.offset = 0
    return true
  }

  /**
   * Jump to the last valid top row.
   * @returns whether the position changed.
   */
  last(): boolean {
    if (this.offset === this.maxOffset) return false
    this.offset = this.maxOffset
    return true
  }

  /** The first visible row, zero-based. */
  get start(): number {
    return this.offset
  }

  /** The exclusive end of the visible window. */
  get end(): number {
    return Math.min(this.offset + this.visible, this.total)
  }

  /** The greatest valid first visible row. */
  get maxOffset(): number {
    return Math.max(0, this.total - this.visible)
  }
}
