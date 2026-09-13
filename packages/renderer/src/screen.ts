/**
 * Append-and-live-region screen.
 *
 * A chat transcript only ever grows, so this renderer does not own a
 * full-screen viewport: finished output is written straight into the terminal's
 * own scroll buffer and never touched again, and only a bottom LIVE REGION —
 * the streaming reply, a prompt, the composer — is redrawn in place. Native
 * scrollback, mouse selection, and copy therefore keep working, and the
 * renderer never has to model scroll position or reflow history on resize.
 *
 * The cost is the rule that makes it correct: the live region must be the last
 * thing on screen, so every write goes through this class.
 * @module @dshline/renderer/screen
 */

import { wrapToWidth } from './width.ts'

/** Cursor placement inside the live region, in rendered rows and columns. */
export interface LiveCursor {
  /** Zero-based row within the live region. */
  row: number
  /** Zero-based column within that row, in display columns. */
  column: number
}

/** The terminal facts and sink a screen needs; a test supplies fakes. */
export interface ScreenTarget {
  /** Write raw bytes, escape sequences included. */
  write(chunk: string): void
  /** Current terminal width in columns. */
  columns(): number
}

/** Control Sequence Introducer. */
const CSI = '\u001b['

/** One CSI sequence with a numeric parameter, or nothing when `count` is zero. */
function csi(count: number, final: string): string {
  return count > 0 ? `${CSI}${String(count)}${final}` : ''
}

const HIDE_CURSOR = `${CSI}?25l`
const SHOW_CURSOR = `${CSI}?25h`
const BEGIN_SYNC = `${CSI}?2026h`
const END_SYNC = `${CSI}?2026l`
const CLEAR_BELOW = `${CSI}0J`
const CLEAR_LINE = `${CSI}0K`

/**
 * Owns the boundary between committed scrollback and the redrawn live region.
 */
export class Screen {
  /** Rendered rows currently occupied by the live region, as they were drawn. */
  private liveRows: readonly string[] = []
  /**
   * The width `liveRows` was wrapped at, or undefined before the first draw.
   *
   * A resize reflows the rows the terminal already holds, so a redraw of the
   * same logical lines at a new width is not the same picture. This is what the
   * identical-frame skip reads to know that; the erase itself deliberately
   * keeps the drawn geometry, because a reflow can push the region past the
   * screen and leave the terminal's cursor somewhere this class cannot derive.
   * See {@link Screen.setLive}.
   */
  private liveColumns: number | undefined
  /** Cursor placement requested for the current live region. */
  private cursor: LiveCursor | undefined
  /**
   * Whether the terminal is believed to hold exactly the last written frame.
   * False before the first draw, and after anything moved the pixels behind
   * this class's back — which is the one thing the identical-frame skip may
   * not survive.
   */
  private current = false

  constructor(private readonly target: ScreenTarget) {}

  /** Rows the live region currently occupies, for tests and resize math. */
  get height(): number {
    return this.liveRows.length
  }

  /**
   * Record that the screen may no longer match the last written frame.
   *
   * Two things change it from outside: a resize reflows whatever the terminal
   * pleases, and a display clear wipes every pixel directly. The next redraw
   * after this writes in full — erase included — and marks the frame current
   * again. The cached geometry is deliberately KEPT rather than discarded: the
   * erase has to climb the region as it was drawn, so "stale" means the pixels
   * are doubtful, never that the model is.
   */
  markStale(): void {
    this.current = false
  }

  /**
   * Erase the live region, leaving the cursor at its first row, first column.
   * Committed scrollback above is untouched.
   * @returns the escape sequence that performs the erase.
   */
  private eraseLive(): string {
    if (this.liveRows.length === 0) return '\r'
    // The cursor sits wherever the last placement left it, so descend to the
    // BOTTOM row first and climb from there; climbing from the current row
    // would overshoot whenever a cursor was placed mid-region.
    const bottom = this.liveRows.length - 1
    const fromBottom = bottom - (this.cursor?.row ?? bottom)
    return `${csi(fromBottom, 'B')}\r${csi(bottom, 'A')}${CLEAR_BELOW}`
  }

  /**
   * The placement actually drawn for a requested one.
   *
   * `drawLive` clamps a row into the drawn region so the placement cannot leave
   * it; the erase on the NEXT redraw descends from wherever that placement left
   * the cursor, so it has to count from the same clamped row. Keeping the raw
   * request instead is what made a negative row descend `|row|` cells past the
   * bottom before climbing: the climb then started below the region's first row
   * and `CSI 0J` could not reach the top rows of the frame it was replacing.
   * The column only ever moves right from column zero, so it floors at zero.
   * @param rows - the rows about to be drawn.
   * @param cursor - the requested placement, or undefined for none.
   * @returns the placement the terminal will actually hold.
   */
  private placed(rows: readonly string[], cursor: LiveCursor | undefined): LiveCursor | undefined {
    if (cursor === undefined) return undefined
    return {
      row: Math.min(Math.max(cursor.row, 0), Math.max(0, rows.length - 1)),
      column: Math.max(cursor.column, 0),
    }
  }

  /**
   * Draw `rows` and place the cursor, assuming the live region is already erased
   * and the cursor sits at the region's first column.
   * @param rows - pre-wrapped rows to draw.
   * @param cursor - requested placement, clamped into the drawn region.
   * @returns the escape sequence that draws and positions.
   */
  private drawLive(rows: readonly string[], cursor: LiveCursor | undefined): string {
    if (rows.length === 0) return ''
    let out = rows.map(row => `${CLEAR_LINE}${row}`).join('\r\n')
    if (cursor === undefined) return out
    const row = Math.min(Math.max(cursor.row, 0), rows.length - 1)
    out += csi(rows.length - 1 - row, 'A')
    out += '\r'
    out += csi(Math.max(cursor.column, 0), 'C')
    return out
  }

  /**
   * Whether `rows` and `cursor` describe exactly what is on screen right now.
   * @param rows - wrapped rows a redraw would draw.
   * @param cursor - cursor placement that redraw would use.
   * @returns true when writing them would change nothing visible.
   */
  private showsFrame(rows: readonly string[], cursor: LiveCursor | undefined): boolean {
    if (this.liveRows.length !== rows.length) return false
    for (let index = 0; index < rows.length; index += 1) {
      if (this.liveRows[index] !== rows[index]) return false
    }
    if (this.cursor === undefined || cursor === undefined) return this.cursor === cursor
    return this.cursor.row === cursor.row && this.cursor.column === cursor.column
  }

  /**
   * Replace the live region.
   *
   * A frame identical to the one already on screen writes nothing. Bursts of
   * session events ask the screen the same question several times per tick —
   * change feeds invalidating together, a redraw after a commit that moved
   * nothing — and the live region is the most-rewritten bytes in the process.
   * The comparison runs on the WRAPPED rows, not the logical lines: wrapping is
   * part of what a reader sees, so a resize that leaves the lines alone but
   * moves their rows still redraws, and one that changes nothing costs nothing.
   *
   * The skip trusts the cache only while it is clean — {@link markStale} and
   * the first draw both start from distrust — which keeps the startup sequence
   * intact: the first composition of an empty region is where the cursor gets
   * hidden, and several empty compositions happen before any real frame exists.
   * @param lines - logical lines; each is wrapped to the terminal width so one
   *   rendered row is one array entry and the redraw arithmetic stays exact.
   * @param cursor - where to leave the terminal cursor; omitted leaves it at the
   *   end of the region and hidden.
   */
  setLive(lines: readonly string[], cursor?: LiveCursor): void {
    const columns = this.columns()
    const rows = this.wrapAt(lines, columns)
    // Clamp once, before the comparison and before the write: the erase on the
    // next redraw descends from the row this frame actually placed the cursor
    // on, so the cached placement must be the drawn one and not the request.
    const placed = this.placed(rows, cursor)
    // The width is part of the cached frame. A resize reflows the rows the
    // terminal already holds, so the same logical lines at a new width are not
    // the same picture and must not be skipped.
    if (this.current && columns === this.liveColumns && this.showsFrame(rows, placed)) return
    // The erase uses the geometry that was DRAWN, not the reflowed geometry.
    // A narrowing resize can reflow the region into more rows than the terminal
    // can hold, and the terminal's post-reflow cursor position is its own
    // decision (xterm pins it to the viewport bottom once the content has
    // scrolled). Climbing the reflowed count from that cursor can overshoot the
    // region's top and CLEAR_BELOW over the committed rows above it, which is
    // worse than the stale row it was meant to remove. Climbing only the cached
    // count can never leave the old region, so committed scrollback is safe.
    const tail = placed === undefined ? '' : SHOW_CURSOR
    this.target.write(`${BEGIN_SYNC}${HIDE_CURSOR}${this.eraseLive()}${this.drawLive(rows, placed)}${tail}${END_SYNC}`)
    this.liveRows = rows
    this.liveColumns = columns
    this.cursor = placed
    this.current = true
  }

  /**
   * Write `lines` permanently above the live region, then redraw the region
   * beneath them. Committed lines enter the terminal's scroll buffer and are
   * never rewritten, so they may exceed the screen height freely.
   * @param lines - logical lines to commit; wrapped to the terminal width.
   */
  commit(lines: readonly string[]): void {
    if (lines.length === 0) return
    const committed = this.wrap(lines).map(row => `${CLEAR_LINE}${row}`).join('\r\n')
    const live = this.liveRows
    const cursor = this.cursor
    const tail = cursor === undefined ? '' : SHOW_CURSOR
    const erase = this.eraseLive()
    // The region is gone once the erase is written, so the redraw that follows
    // must not consult `liveRows` — it is passed the saved rows instead.
    this.liveRows = []
    this.cursor = undefined
    this.target.write(`${BEGIN_SYNC}${HIDE_CURSOR}${erase}${committed}\r\n${this.drawLive(live, cursor)}${tail}${END_SYNC}`)
    this.liveRows = live
    this.cursor = cursor
  }

  /**
   * Erase the live region and restore the cursor, for teardown. Committed
   * scrollback is left in place so the session transcript survives exit.
   */
  close(): void {
    this.target.write(`${this.eraseLive()}${SHOW_CURSOR}`)
    this.liveRows = []
    this.liveColumns = undefined
    this.cursor = undefined
    this.current = false
  }

  /** The wrap width, floored at one so a zero-column terminal still progresses. */
  private columns(): number {
    return Math.max(1, this.target.columns())
  }

  /**
   * Wrap logical lines at an explicit width.
   * @param lines - logical lines.
   * @param columns - the width to wrap them at.
   * @returns one entry per rendered row.
   */
  private wrapAt(lines: readonly string[], columns: number): readonly string[] {
    return lines.flatMap(line => wrapToWidth(line, columns))
  }

  /**
   * Wrap logical lines to the terminal's current width.
   * @param lines - logical lines.
   * @returns one entry per rendered row.
   */
  private wrap(lines: readonly string[]): readonly string[] {
    return this.wrapAt(lines, this.columns())
  }
}
