/**
 * The `ctrl-r` overlay's windowed geometry and work bound.
 *
 * The renderer measures the result list arithmetically from the selected entry
 * and formats only the rows the viewport can show. These tests pin two things
 * the previous whole-array renderer could not promise:
 *
 * - a small terminal over a large match set reads a bounded number of entries,
 *   never every match; and
 * - the rank→row arithmetic keeps the same rows visible as the whole-array
 *   renderer, across the selected first/middle/last match, a multiline
 *   expansion, an omitted-lines summary, and resize.
 *
 * The work bound is observation, not a wall-clock threshold, following
 * `packages/renderer/tests/composer-scale.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { HistorySearch } from '../src/history-search.ts'
import { createHistorySearchOverlay } from '../src/history-search-overlay.ts'
import { InputHistory } from '../src/history.ts'
import type { TuiOverlay } from '../src/slots.ts'

/** A terminal wide enough for the framed search, per `SEARCH_MIN_COLUMNS`. */
const COLUMNS = 80

/** Rows the framed overlay spends outside the scrolling list: 3 fixed + 2 heading. */
const CHROME_ROWS = 5

/**
 * Entry reads allowed beyond the rows drawn.
 *
 * The audited counter sees the `entry()` reads for visible unselected rows; the
 * selected entry is read once through `selectedText` to measure its expansion,
 * which the counter does not observe. Six is deliberately loose: the invariant
 * under test is that reads are a function of terminal geometry, not of
 * `matches.length`. Widen it if the implementation legitimately formats a
 * look-ahead band; never remove the assertion.
 */
const WINDOW_SLACK = 6

/**
 * A search that counts corpus reads, the analogue of `AuditedComposer`.
 *
 * `entry` is the renderer's one corpus read; counting it separates "formatted
 * every match" from "formatted the window".
 */
class AuditedSearch extends HistorySearch {
  /** Corpus entries read since {@link reset}. */
  reads = 0

  /** Begin a fresh observation window. */
  reset(): void {
    this.reads = 0
  }

  override entry(index: number): string | undefined {
    this.reads += 1
    return super.entry(index)
  }
}

/**
 * The result-row budget for a terminal height.
 * @param rows - the terminal height.
 * @returns rows left for the result list.
 */
function capacity(rows: number): number {
  return rows - CHROME_ROWS
}

/**
 * An `InputHistory` holding the given submissions, oldest first.
 * @param lines - the lines to record.
 * @returns the populated history.
 */
function recorded(lines: readonly string[]): InputHistory {
  const history = new InputHistory()
  for (const line of lines) history.record(line)
  return history
}

/**
 * Mount the overlay over a corpus.
 * @param lines - the corpus, oldest first.
 * @returns the overlay and the audited search.
 */
function mount(lines: readonly string[]): { overlay: TuiOverlay; search: AuditedSearch } {
  const search = new AuditedSearch(recorded(lines))
  const overlay = createHistorySearchOverlay({ search, settle: () => {}, invalidate: () => {} })
  return { overlay, search }
}

/**
 * Feed a query one code point at a time, as typing does.
 * @param search - the search to extend.
 * @param query - the text to type.
 */
function type(search: HistorySearch, query: string): void {
  for (const character of query) search.append(character)
}

/**
 * Render the overlay with styling removed.
 * @param overlay - the overlay.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @returns the visible rows.
 */
function rowsOf(overlay: TuiOverlay, columns: number, rows: number): string[] {
  return overlay.render(columns, rows).map(line => stripAnsi(line))
}

/**
 * Single-line submissions that all contain `log`.
 * @param count - how many entries.
 * @returns the corpus, oldest first.
 */
function logEntries(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `log entry ${String(index)}`)
}

/**
 * A corpus whose six newest entries are identical no matter how many fillers
 * precede them, so two sizes show the same window.
 * @param fillers - how many older filler entries to prepend.
 * @returns the corpus, oldest first.
 */
function withNewest(fillers: number): string[] {
  return [
    ...Array.from({ length: fillers }, (_unused, index) => `log filler ${String(index)}`),
    ...Array.from({ length: 6 }, (_unused, index) => `log newest ${String(index)}`),
  ]
}

describe('windowed history-search rendering', () => {
  it('reads only the visible result rows, not every match', () => {
    const { overlay, search } = mount(logEntries(1000))
    type(search, 'log')
    expect(search.matches).toHaveLength(1000)
    search.reset()

    const rows = rowsOf(overlay, COLUMNS, 10)

    expect(search.reads).toBeGreaterThan(0)
    expect(search.reads).toBeLessThanOrEqual(capacity(10) + WINDOW_SLACK)
    expect(rows.join('\n')).toContain('log entry 999')
    expect(rows.join('\n')).toContain('log entry 995')
    expect(rows.join('\n')).not.toContain('log entry 994')
  })

  it('reads a window whose size is set by the terminal, not by the corpus', () => {
    const small = mount(withNewest(94))
    const large = mount(withNewest(1994))
    type(small.search, 'log')
    type(large.search, 'log')
    small.search.reset()
    large.search.reset()

    const smallRows = rowsOf(small.overlay, COLUMNS, 10)
    const largeRows = rowsOf(large.overlay, COLUMNS, 10)

    expect(largeRows.join('\n')).toContain('log newest 5')
    expect(largeRows.join('\n')).toContain('log newest 1')
    expect(small.search.reads).toBeLessThanOrEqual(capacity(10) + WINDOW_SLACK)
    expect(large.search.reads).toBeLessThanOrEqual(capacity(10) + WINDOW_SLACK)
    expect(Math.abs(large.search.reads - small.search.reads)).toBeLessThanOrEqual(1)
  })

  it('formats the window around a deep selection rather than the whole corpus', () => {
    const { overlay, search } = mount(logEntries(1000))
    type(search, 'log')
    for (let step = 0; step < 500; step += 1) search.older()
    search.reset()

    const rows = rowsOf(overlay, COLUMNS, 10)

    expect(rows.join('\n')).toContain('❯ log entry 499')
    expect(rows.join('\n')).not.toContain('log entry 999')
    expect(search.reads).toBeLessThanOrEqual(capacity(10) + WINDOW_SLACK)
  })

  it('reads more entries in a taller terminal and still fills each exactly', () => {
    const short = mount(logEntries(1000))
    const tall = mount(logEntries(1000))
    type(short.search, 'log')
    type(tall.search, 'log')
    short.search.reset()
    tall.search.reset()

    const shortRows = rowsOf(short.overlay, COLUMNS, 8)
    const tallRows = rowsOf(tall.overlay, COLUMNS, 24)

    expect(shortRows).toHaveLength(8)
    expect(tallRows).toHaveLength(24)
    expect(short.search.reads).toBeLessThanOrEqual(capacity(8) + WINDOW_SLACK)
    expect(tall.search.reads).toBeLessThanOrEqual(capacity(24) + WINDOW_SLACK)
    expect(short.search.reads).toBeLessThan(tall.search.reads)
  })

  it('reads at most the selected entry on the compact path', () => {
    const { overlay, search } = mount(logEntries(1000))
    type(search, 'log')
    search.reset()

    const rows = rowsOf(overlay, 16, 3)

    expect(rows[0]).toContain('❯')
    expect(search.reads).toBeLessThanOrEqual(1)
  })

  it('reads no entry when the query matched nothing', () => {
    const { overlay, search } = mount(logEntries(1000))
    type(search, 'zzz')
    search.reset()

    const rows = rowsOf(overlay, COLUMNS, 10)

    expect(rows.join('\n')).toContain('No input matches that.')
    expect(search.reads).toBe(0)
  })
})

describe('windowed history-search geometry', () => {
  it('follows the selection to the middle and the oldest, then back to the newest', () => {
    const { overlay, search } = mount(logEntries(300))
    type(search, 'log')

    expect(rowsOf(overlay, COLUMNS, 12).join('\n')).toContain('❯ log entry 299')
    expect(rowsOf(overlay, COLUMNS, 12).join('\n')).toContain('History 1/300')

    for (let step = 0; step < 150; step += 1) search.older()
    const middle = rowsOf(overlay, COLUMNS, 12).join('\n')
    expect(middle).toContain('❯ log entry 149')
    expect(middle).not.toContain('❯ log entry 299')

    search.last()
    const oldest = rowsOf(overlay, COLUMNS, 12).join('\n')
    expect(oldest).toContain('❯ log entry 0')
    expect(oldest).toContain('History 300/300')

    search.first()
    expect(rowsOf(overlay, COLUMNS, 12).join('\n')).toContain('❯ log entry 299')
  })

  it('keeps the selected multiline block and its anchor visible deep in the list', () => {
    const corpus = Array.from({ length: 400 }, (_unused, index) =>
      `log ${String(index)}\nsecond of ${String(index)}\nthird of ${String(index)}\nfourth of ${String(index)}`)
    const { overlay, search } = mount(corpus)
    type(search, 'log')
    for (let step = 0; step < 200; step += 1) search.older()
    search.reset()

    const drawn = rowsOf(overlay, COLUMNS, 12)
    const marked = drawn.findIndex(row => row.includes('❯'))
    expect(marked).toBeGreaterThanOrEqual(0)
    expect(drawn[marked]).toContain('log 199')
    expect(drawn[marked + 1] ?? '').toContain('↳ second of 199')
    expect(search.reads).toBeLessThanOrEqual(capacity(12) + WINDOW_SLACK)
  })

  it('reports how many selected lines it did not show, deep in the list', () => {
    const corpus = Array.from({ length: 300 }, (_unused, index) => index === 150
      ? `match ${String(index)}\n${Array.from({ length: 9 }, (_x, line) => `filler line ${String(line)}`).join('\n')}\ntail`
      : `match ${String(index)}`)
    const { overlay, search } = mount(corpus)
    type(search, 'match')
    for (let step = 0; step < 149; step += 1) search.older()
    search.reset()

    const rows = rowsOf(overlay, COLUMNS, 12)

    expect(rows.join('\n')).toMatch(/\d+ more lines/u)
    expect(search.reads).toBeLessThanOrEqual(capacity(12) + WINDOW_SLACK)
  })

  it('shows the identifying row when the window cannot hold the expansion', () => {
    const { overlay, search } = mount(['log a\nb\nc\nd', 'log x', 'log y'])
    type(search, 'log')
    // The newest match is the single-line 'log y'; aim at the multiline entry so
    // the selected block is taller than the one-row window.
    search.last()

    const drawn = rowsOf(overlay, COLUMNS, 6)

    expect(drawn).toHaveLength(6)
    const marked = drawn.findIndex(row => row.includes('❯'))
    expect(marked).toBeGreaterThanOrEqual(0)
    expect(drawn[marked]).toContain('log a')
    expect(drawn.join('\n')).not.toContain('↳')
  })

  it('shifts the ranks after an expanded selected block', () => {
    const corpus = ['m 0', 'm 1', 'm 2', 'm 3', 'm 4\nx\ny\nz', 'm 5', 'm 6', 'm 7', 'm 8', 'm 9']
    const { overlay, search } = mount(corpus)
    type(search, 'm')
    // Rank 5 is the multiline entry, so the ranks after it are shifted down by
    // the block's extra height.
    for (let step = 0; step < 5; step += 1) search.older()

    const drawn = rowsOf(overlay, COLUMNS, 24)
    const marked = drawn.findIndex(row => row.includes('❯'))

    expect(drawn[marked]).toContain('m 4')
    expect(drawn[marked + 1]).toContain('↳ x')
    expect(drawn[marked + 4]).toContain('m 3')
  })

  it('re-windows the same selection across resizes', () => {
    const { overlay, search } = mount(logEntries(500))
    type(search, 'log')
    for (let step = 0; step < 250; step += 1) search.older()

    for (const [columns, rows] of [[120, 24], [40, 24], [120, 8], [120, 40]] as const) {
      const drawn = rowsOf(overlay, columns, rows)
      expect(drawn.join('\n'), `${String(columns)}x${String(rows)}`).toContain(`❯ ${search.selectedText ?? ''}`)
      expect(drawn).toHaveLength(rows)
      for (const row of drawn) expect(displayWidth(row)).toBeLessThanOrEqual(columns)
    }
  })

  it('keeps two identical entries as two rows and marks the selected one', () => {
    const { overlay, search } = mount(['log dup', 'log other', 'log dup'])
    type(search, 'log dup')
    expect(search.matches).toEqual([2, 0])
    search.older()

    const drawn = rowsOf(overlay, COLUMNS, 24)

    // The query row echoes the same text, so only the result rows are counted.
    expect(drawn.filter(row => row.includes('log dup') && !row.includes('⌕'))).toHaveLength(2)
    expect(drawn.find(row => row.includes('❯'))).toContain('log dup')
    expect(drawn.join('\n')).toContain('History 2/2')
  })

  it('windows a late hit into view on an unselected row too', () => {
    const { overlay, search } = mount([`${'padding '.repeat(30)}NEEDLE trailing text`, 'a newer NEEDLE line'])
    type(search, 'NEEDLE')

    const drawn = rowsOf(overlay, COLUMNS, 24)
    // The query row echoes the needle too; the unselected result row is the one
    // without the cursor mark.
    const unselected = drawn.find(row => row.includes('NEEDLE') && !row.includes('❯') && !row.includes('⌕'))

    expect(unselected).toBeDefined()
    expect(unselected).toContain('…')
    expect(displayWidth(unselected ?? '')).toBeLessThanOrEqual(COLUMNS)
  })

  it('follows the selection in the compact fallback', () => {
    const { overlay, search } = mount(['log a', 'log b', 'log c'])
    type(search, 'log')
    search.older()

    const rows = rowsOf(overlay, 16, 3)

    expect(rows[0]).toContain('log b')
  })
})
