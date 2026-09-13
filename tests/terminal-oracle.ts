/**
 * A differential oracle for `Screen` against a real terminal emulator.
 *
 * `Screen`'s contract is about what a person sees after EVERY write, not only
 * the final frame: the live region must be erased exactly where it was drawn,
 * committed rows enter scrollback exactly once, and the cursor must land where
 * the model says. A last-frame-only test cannot see a stale row left behind two
 * frames earlier, so this oracle keeps the claimed side (the rows `Screen.wrap`
 * produces, the rows committed, the cached placement — `wrapToWidth` is
 * imported, not re-derived) beside the actual side (viewport, scrollback,
 * cursor) and asserts after every operation.
 *
 * Two invariants are reflow-invariant, because a resize makes a row-for-row
 * comparison meaningless: border markers survive reflow, and so does the
 * multiset of non-space characters on the committed side. Together they catch a
 * stale frame a post-resize redraw failed to erase.
 *
 * Deterministic and hermetic: no timers, no I/O, one `@xterm/headless` terminal.
 * @module tests/terminal-oracle
 */

import { Screen, displayWidth, stripAnsi, wrapToWidth } from '@dshline/renderer'
import type { LiveCursor } from '@dshline/renderer'
import type { CursorAt, Emulator } from './emulator.ts'
import { createEmulator } from './emulator.ts'

/** What the oracle observed on both sides at one instant. */
export interface OracleSnapshot {
  /** Every row the terminal holds, trailing blanks removed. */
  scrollback: string[]
  /** The visible viewport, trailing blanks removed. */
  screen: string[]
  /** Where the terminal put its cursor. */
  cursor: CursorAt
  /** The physical live rows the model claims. */
  live: string[]
  /** The physical committed rows the model claims. */
  committed: string[]
  /** `Screen.height`, the live region's claimed physical height. */
  height: number
}

/** Options for {@link createOracle}. */
export interface OracleOptions {
  /** Glyph counted on every frame's top border. Reflow preserves it, which is
   * what exposes a stale duplicated frame. Defaults to `╭`. */
  readonly marker?: string
  /**
   * Code points the test terminal advances two cells for while dshline's
   * `displayWidth` measures one, forwarded to {@link createEmulator}. This is
   * how a surface that lets an ambiguous-width character reach structural
   * chrome is caught: the model's `wrapToWidth` produces one row where the
   * terminal draws two.
   */
  readonly wideCodePoints?: readonly number[]
}

/** The callable oracle handed back by {@link createOracle}. */
export interface Oracle {
  /** The real renderer under test, for probing its own contract. */
  readonly screen: Screen
  /** The emulator every write is fed to. */
  readonly emulator: Emulator
  /** Current terminal width. */
  readonly columns: number
  /** Current terminal height. */
  readonly rows: number
  /** Draw a live region and assert every invariant. */
  live(lines: readonly string[], cursor?: LiveCursor): Promise<void>
  /** Commit rows and assert every invariant. */
  commit(lines: readonly string[]): Promise<void>
  /** Erase the live region and assert every invariant. */
  close(): Promise<void>
  /**
   * Resize the terminal.
   * @param columns - new width.
   * @param rows - new height.
   * @param options - `restale` calls `markStale` as the window does before its
   *   synchronous repaint; false observes a raw resize.
   */
  resize(columns: number, rows: number, options?: { restale?: boolean }): Promise<void>
  /** Read both sides. */
  snapshot(): Promise<OracleSnapshot>
  /** A readable description of the differences between two snapshots. */
  diff(before: OracleSnapshot, after: OracleSnapshot): string
  /** Release the emulator. */
  dispose(): void
}

/** Raised when an operation violates the {@link Screen} contract. */
export class TerminalOracleViolation extends Error {
  /** One readable line per invariant that failed. */
  readonly violations: readonly string[]

  /**
   * @param operation - the op that failed.
   * @param violations - readable invariant failures.
   */
  constructor(operation: string, violations: readonly string[]) {
    super(`${operation}: ${violations.join('; ')}`)
    this.name = 'TerminalOracleViolation'
    this.violations = violations
  }
}

/** Trailing blank rows removed, so both sides compare the same way. */
const trimTrailing = (rows: readonly string[]): string[] => {
  const out = [...rows]
  while (out.length > 0 && (out.at(-1) ?? '').trimEnd() === '') out.pop()
  return out
}

/** Whether `whole` ends with `suffix`, comparing right-trimmed rows. */
const endsWith = (whole: readonly string[], suffix: readonly string[]): boolean => {
  if (suffix.length > whole.length) return false
  const offset = whole.length - suffix.length
  return suffix.every((row, index) => whole[offset + index]?.trimEnd() === row.trimEnd())
}

/** Non-space visible characters, sorted; reflow preserves this multiset. */
const nonSpaceChars = (rows: readonly string[]): string =>
  [...stripAnsi(rows.join('')).replace(/\s/gu, '')].sort().join('')

/** The physical rows `Screen.wrap` produces for these logical lines. */
const wrapAll = (lines: readonly string[], columns: number): string[] =>
  lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))

/** Whether two placements are the same, `undefined` included. */
const sameCursor = (left: LiveCursor | undefined, right: LiveCursor | undefined): boolean => {
  if (left === undefined || right === undefined) return left === right
  return left.row === right.row && left.column === right.column
}

/**
 * The placement `Screen` actually caches for a request: its row is clamped into
 * the drawn region and its column floors at zero. Mirroring it exactly is what
 * lets the oracle's skip prediction agree with `Screen.setLive`, so a
 * "changed frame wrote nothing" check cannot fire on a request whose difference
 * `Screen` deliberately clamped away.
 */
const clampCursor = (
  rows: readonly string[],
  placement: LiveCursor | undefined,
): LiveCursor | undefined => {
  if (placement === undefined) return undefined
  return {
    row: Math.min(Math.max(placement.row, 0), Math.max(0, rows.length - 1)),
    column: Math.max(placement.column, 0),
  }
}

/**
 * Create an oracle over a fresh emulator.
 * @param columns - initial terminal width.
 * @param rows - initial terminal height.
 * @param options - marker glyph and any width the terminal disagrees with.
 * @returns the oracle; call {@link Oracle.dispose} when finished.
 */
export function createOracle(columns: number, rows: number, options: OracleOptions = {}): Oracle {
  const marker = options.marker ?? '\u256d'
  const emulator = createEmulator(columns, rows, { wideCodePoints: options.wideCodePoints })
  let writes = 0
  /** The most recent chunk written, so the erase path can be proven to have run. */
  let lastChunk = ''
  // Write counting lets the identical-frame skip be asserted, not just observed.
  const counted = {
    write: (chunk: string): void => { writes += 1; lastChunk = chunk; emulator.target.write(chunk) },
    columns: (): number => emulator.target.columns(),
  }
  const screen = new Screen(counted)
  let viewportRows = rows
  /** The committed rows as the TERMINAL holds them, adopted after a reflow. */
  let committed: string[] = []
  /**
   * The committed rows the operations actually asked for, never adopted from
   * the terminal. The order-insensitive comparison against this is what
   * survives a reflow where `committed` had to be resynced.
   */
  let expectedCommitted: string[] = []
  let liveRows: string[] = []
  /** The width `liveRows` was wrapped at, part of `Screen`'s skip identity. */
  let liveColumns: number | undefined
  let cursor: LiveCursor | undefined
  let current = false
  let clean = true
  /** The live rows the current frame replaced, for the stale-row invariant. */
  let previous: string[] = []

  const snapshot = async (): Promise<OracleSnapshot> => {
    await emulator.flush()
    return {
      scrollback: await emulator.scrollback(),
      screen: await emulator.screen(),
      cursor: await emulator.cursor(),
      live: [...liveRows],
      committed: [...committed],
      height: screen.height,
    }
  }

  /** Every invariant that holds for the operation that just ran. */
  const violationsFor = async (kind: 'live' | 'commit' | 'close' | 'resize'): Promise<string[]> => {
    await emulator.flush()
    const actual = await emulator.scrollback()
    const at = await emulator.cursor()
    const found: string[] = []
    // Height is a hard bound: rows that scrolled off cannot be climbed back to.
    if (liveRows.length > viewportRows) {
      found.push(`live region is ${String(liveRows.length)} physical rows on a ${String(viewportRows)}-row terminal`)
    }
    // Screen's own getter must agree with the model's row count; a disagreement
    // means `Screen.wrap` and the oracle no longer measure the same way.
    if (screen.height !== liveRows.length) {
      found.push(`Screen.height ${String(screen.height)} != model live rows ${String(liveRows.length)}`)
    }
    if (at.row < 0 || at.row >= viewportRows) found.push(`cursor row ${String(at.row)} outside 0..${String(viewportRows - 1)}`)
    // A terminal that just filled the last cell reports the cursor past it with
    // the wrap still pending, so `columns` itself is a legal column; only going
    // beyond it is drift.
    if (at.column < 0 || at.column > columns) found.push(`cursor column ${String(at.column)} outside 0..${String(columns)}`)
    // A marker is reflow-invariant. A duplicate is a frame that was never erased.
    const claimedMarkers = [...committed, ...liveRows].join('\n').split(marker).length - 1
    const actualMarkers = actual.join('\n').split(marker).length - 1
    if (claimedMarkers !== actualMarkers) {
      found.push(`${String(actualMarkers)} ${marker} borders on screen and in scrollback, model claims ${String(claimedMarkers)}`)
    }
    // The live region must be the trailing thing the terminal holds. A bare
    // resize is exempt: it reflows the region in place before the redraw.
    if (kind !== 'resize' && liveRows.length > 0 && !endsWith(actual, liveRows)) {
      found.push(`scrollback does not end with the live region: tail ${JSON.stringify(actual.slice(-liveRows.length))} vs ${JSON.stringify(liveRows)}`)
    }
    if (kind !== 'resize') {
      const prefix = liveRows.length > 0 ? actual.slice(0, Math.max(0, actual.length - liveRows.length)) : actual
      if (clean) {
        const claimed = trimTrailing([...committed, ...liveRows]).map(row => row.trimEnd())
        const seen = trimTrailing(actual).map(row => row.trimEnd())
        if (JSON.stringify(claimed) !== JSON.stringify(seen)) {
          found.push(`content drift: screen/scrollback ${JSON.stringify(seen)} vs model ${JSON.stringify(claimed)}`)
        }
        // The cursor is placed inside the region, so it is predictable from the
        // model without re-deriving the rendering.
        if (liveRows.length > 0) {
          const height = liveRows.length
          const total = committed.length + height
          const top = total <= viewportRows ? committed.length : viewportRows - height
          const expected: CursorAt = cursor === undefined
            // With no placement the cursor is left at the end of the last row,
            // which is `columns` with the wrap pending when that row is full.
            ? { row: top + height - 1, column: Math.min(displayWidth(liveRows[height - 1] ?? ''), columns) }
            : {
                row: top + Math.min(Math.max(cursor.row, 0), height - 1),
                column: Math.min(Math.max(cursor.column, 0), columns - 1),
              }
          if (at.row !== expected.row || at.column !== expected.column) {
            found.push(`cursor ${JSON.stringify(at)} != model ${JSON.stringify(expected)}`)
          }
        }
      }
      // Reflow-tolerant, and independent of the resynced `committed`: the
      // committed rows the operations asked for must still be exactly what sits
      // below the live region. Because it compares against the pure expectation
      // rather than the adopted model, a duplicated, lost, or reordered commit
      // cannot hide behind a resize resync.
      if (nonSpaceChars(prefix) !== nonSpaceChars(expectedCommitted)) {
        found.push(`committed content changed: ${JSON.stringify(prefix)} vs expected ${JSON.stringify(expectedCommitted)}`)
      }
      // A row unique to the frame being replaced must be gone; if it is here,
      // the redraw did not remove it.
      for (const row of previous) {
        const text = row.trimEnd()
        if (text === '') continue
        if (liveRows.some(next => next.trimEnd() === text)) continue
        if (expectedCommitted.some(kept => kept.trimEnd() === text)) continue
        if (actual.some(seen => seen.trimEnd() === text)) found.push(`stale frame row still on screen: ${JSON.stringify(text)}`)
      }
    }
    return found
  }

  /** Assert after every operation, and report where both sides disagree. */
  const assert = async (operation: string, kind: 'live' | 'commit' | 'close' | 'resize'): Promise<void> => {
    const violations = await violationsFor(kind)
    if (violations.length > 0) throw new TerminalOracleViolation(operation, violations)
  }

  /** Adopt the terminal's post-reflow committed rows so later ops compare again. */
  const resync = async (): Promise<void> => {
    const actual = await emulator.scrollback()
    committed = liveRows.length > 0 && endsWith(actual, liveRows)
      ? actual.slice(0, actual.length - liveRows.length)
      : actual
    clean = true
  }

  return {
    screen,
    emulator,
    get columns() { return emulator.target.columns() },
    get rows() { return viewportRows },
    live: async (lines, placement) => {
      previous = [...liveRows]
      const width = emulator.target.columns()
      // The model is compared against the emulator's plain text, so styling is
      // stripped for the comparison only; the styled `lines` are what Screen
      // draws. Stripping cannot move a wrap, because an escape is zero-width.
      const next = wrapAll(lines.map(stripAnsi), width)
      const placed = clampCursor(next, placement)
      // `Screen` treats the wrap width as part of the cached frame, so a
      // same-lines redraw after a raw resize must still write. The prediction
      // uses the CLAMPED placement, matching `Screen`'s own cache.
      const skipping = current && liveColumns === width &&
        JSON.stringify(next) === JSON.stringify(liveRows) && sameCursor(placed, cursor)
      const before = writes
      screen.setLive(lines, placement)
      liveRows = next
      liveColumns = width
      cursor = placed
      current = true
      if (skipping && writes !== before) throw new TerminalOracleViolation('setLive', ['identical frame was written instead of skipped'])
      // The other direction: a frame that changed must not have been swallowed by
      // the skip, or a later assertion could pass because nothing redrew.
      if (!skipping && writes === before) throw new TerminalOracleViolation('setLive', ['a changed frame wrote nothing'])
      // With a region already on screen, the redraw must erase it first. `Screen`
      // emits CSI 0J whenever it had a non-empty region to remove.
      if (previous.length > 0 && !lastChunk.includes('\u001b[0J')) {
        throw new TerminalOracleViolation('setLive', ['redraw did not erase the previous live region'])
      }
      await assert(`setLive(${JSON.stringify(lines)})`, 'live')
      if (!clean) await resync()
    },
    commit: async (lines) => {
      if (lines.length === 0) return
      previous = [...liveRows]
      const added = wrapAll(lines.map(stripAnsi), emulator.target.columns())
      const before = writes
      screen.commit(lines)
      committed = [...committed, ...added]
      expectedCommitted = [...expectedCommitted, ...added]
      if (writes === before) throw new TerminalOracleViolation('commit', ['commit wrote nothing'])
      if (previous.length > 0 && !lastChunk.includes('\u001b[0J')) {
        throw new TerminalOracleViolation('commit', ['commit did not erase the previous live region'])
      }
      await assert(`commit(${JSON.stringify(lines)})`, 'commit')
      if (!clean) await resync()
    },
    close: async () => {
      previous = [...liveRows]
      const before = writes
      screen.close()
      liveRows = []
      liveColumns = undefined
      cursor = undefined
      current = false
      if (writes === before) throw new TerminalOracleViolation('close', ['close wrote nothing'])
      if (previous.length > 0 && !lastChunk.includes('\u001b[0J')) {
        throw new TerminalOracleViolation('close', ['close did not erase the live region'])
      }
      // The content comparison now sees `liveRows` empty, so it verifies that
      // close left exactly the committed rows and no live remnant. A resize
      // outstanding is handled by the reflow-tolerant branch and the resync.
      await assert('close()', 'close')
      if (!clean) await resync()
    },
    resize: async (nextColumns, nextRows, resizeOptions = {}) => {
      previous = [...liveRows]
      emulator.resize(nextColumns, nextRows)
      viewportRows = nextRows
      if (resizeOptions.restale ?? true) { screen.markStale(); current = false }
      clean = false
      await assert(`resize(${String(nextColumns)}x${String(nextRows)})`, 'resize')
    },
    snapshot,
    diff: (before, after) => {
      const lines: string[] = []
      const section = (name: string, left: readonly string[], right: readonly string[]): void => {
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
          if (left[index] === right[index]) continue
          lines.push(`${name}[${String(index)}] - ${JSON.stringify(left[index] ?? null)}`)
          lines.push(`${name}[${String(index)}] + ${JSON.stringify(right[index] ?? null)}`)
        }
      }
      section('scrollback', before.scrollback, after.scrollback)
      section('screen', before.screen, after.screen)
      if (before.cursor.row !== after.cursor.row || before.cursor.column !== after.cursor.column) {
        lines.push(`cursor - ${JSON.stringify(before.cursor)}`, `cursor + ${JSON.stringify(after.cursor)}`)
      }
      if (before.height !== after.height) lines.push(`height - ${String(before.height)}`, `height + ${String(after.height)}`)
      return lines.length === 0 ? '(identical)' : lines.join('\n')
    },
    dispose: () => { emulator.dispose() },
  }
}
