/**
 * `ctrl-r` on a real terminal.
 *
 * Read as plain text, an overlay one row too tall looks fine — which is exactly
 * why this is an emulator test. `Screen` climbs rows to erase the live region,
 * and rows that have scrolled off cannot be reached, so a too-tall frame leaves
 * duplicates in the terminal's own scrollback and can erase output the search
 * never owned. The assertions are therefore about what the terminal HOLDS.
 */

import { describe, expect, it } from 'vitest'
import { displayWidth, Screen, stripAnsi } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { HistorySearch } from '../src/history-search.ts'
import { createHistorySearchOverlay } from '../src/history-search-overlay.ts'
import { InputHistory } from '../src/history.ts'
import type { TuiOverlay } from '../src/slots.ts'

/** The width the framed regressions are read at. */
const COLUMNS = 80

/** More submissions than any terminal under test can show at once. */
const MANY = Array.from({ length: 200 }, (_unused, index) =>
  index === 0
    ? 'log FIRST-SENTINEL'
    : index === 199 ? 'log LAST-SENTINEL' : `log entry number ${String(index)}`)

/**
 * An {@link InputHistory} holding the given submissions, in order.
 * @param lines - the lines to record.
 * @returns the populated history.
 */
function recorded(lines: readonly string[]): InputHistory {
  const history = new InputHistory()
  for (const line of lines) history.record(line)
  return history
}

/**
 * Build an overlay over a history, with no terminal attached.
 * @param lines - the submissions to search.
 * @returns the overlay and its search model.
 */
function searching(lines: readonly string[]): { overlay: TuiOverlay; search: HistorySearch } {
  const search = new HistorySearch(recorded(lines))
  const overlay = createHistorySearchOverlay({
    search,
    settle: () => {},
    invalidate: () => {},
  })
  return { overlay, search }
}

/**
 * Mount a search over a real terminal emulator, with a transcript above it.
 * @param lines - the submissions to search.
 * @param rows - the emulator's height.
 * @param columns - the emulator's width.
 * @returns the emulator, the overlay, the screen, and a repaint.
 */
function terminal(lines: readonly string[], rows: number, columns = COLUMNS): {
  emulator: ReturnType<typeof createEmulator>
  overlay: TuiOverlay
  search: HistorySearch
  screen: Screen
  draw: () => void
} {
  const emulator = createEmulator(columns, rows)
  const screen = new Screen(emulator.target)
  screen.commit(['TRANSCRIPT above search A', 'TRANSCRIPT above search B'])
  const { overlay, search } = searching(lines)
  const draw = (): void => { screen.setLive(overlay.render(columns, rows)) }
  return { emulator, overlay, search, screen, draw }
}

/**
 * Split a styled row into its (parameters, text) runs.
 *
 * The assertion these tests need is about WHERE styling starts, and stripping
 * escapes destroys exactly that: `İA` + highlight + `UTH ` and `İ` + highlight +
 * `AUTH ` are different rows that read identically as plain text. Comparing
 * runs is what makes a misplaced highlight visible to a test.
 * @param row - a rendered row, styling included.
 * @returns the runs in order, each with the SGR parameters in force.
 */
function styledRuns(row: string): { sgr: string; text: string }[] {
  const out: { sgr: string; text: string }[] = []
  let sgr = ''
  let last = 0
  for (const match of row.matchAll(/\u001b\[([\d;]*)m/gu)) {
    const text = row.slice(last, match.index)
    if (text !== '') out.push({ sgr, text })
    sgr = match[1] ?? ''
    last = match.index + match[0].length
  }
  const tail = row.slice(last)
  if (tail !== '') out.push({ sgr, text: tail })
  return out
}

describe('history search on a real terminal', () => {
  it.each([24, 14, 8])('keeps two hundred entries inside a %i-row terminal', async rows => {
    const { emulator, overlay, draw } = terminal(MANY, rows)
    draw()
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)

    // Walk past the oldest match, far more times than there are results.
    for (let press = 0; press < 250; press += 1) {
      overlay.handleKey({ kind: 'key', name: 'ctrl-r' })
      draw()
    }
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)
    expect((await emulator.screen()).join('\n')).toContain('log FIRST-SENTINEL')
    // Still the framed search, and filling the terminal exactly. A budget that
    // forgot the query box would be caught by the frame's own backstop and
    // silently demoted to the tiny-terminal fallback, which is a bounded
    // regression rather than a safe one.
    expect(overlay.render(COLUMNS, rows)).toHaveLength(rows)
    expect(overlay.render(COLUMNS, rows).join('\n')).toContain('╭')
  })

  it('never rewrites committed scrollback, however long the search runs', async () => {
    // The invariant the whole viewport exists for: a search is a live-region
    // surface. It commits no transcript rows of its own, and the rows that were
    // committed before it opened are still there, written exactly once.
    const { emulator, overlay, screen, draw } = terminal(MANY, 14)
    draw()
    for (const character of 'entry number 12') {
      overlay.handleKey({ kind: 'text', text: character })
      draw()
    }
    for (let press = 0; press < 40; press += 1) {
      overlay.handleKey({ kind: 'key', name: 'ctrl-r' })
      draw()
    }
    screen.setLive([])

    const history = await emulator.scrollback()
    expect(history.filter(line => line.includes('TRANSCRIPT above search A'))).toHaveLength(1)
    expect(history.filter(line => line.includes('TRANSCRIPT above search B'))).toHaveLength(1)
    // Nothing the search drew survived its dismissal: no result became a
    // transcript row, and no chrome was left behind.
    expect(history.join('\n')).not.toContain('log entry number 12')
    expect(history.join('\n')).not.toContain('⌕')
  })

  it('leaves the transcript intact while an expanded multiline result scrolls', async () => {
    const lines = Array.from({ length: 40 }, (_unused, index) =>
      `log ${String(index)}\nsecond line of ${String(index)}\nthird line of ${String(index)}\nfourth line of ${String(index)}`)
    const { emulator, overlay, draw } = terminal(lines, 12)
    draw()
    for (let press = 0; press < 60; press += 1) {
      overlay.handleKey({ kind: 'key', name: 'down' })
      draw()
    }
    // The selection expands to several rows, so the budget has to account for a
    // block rather than a row. Bounding the LIST alone overflows here.
    expect((await emulator.screen()).length).toBeLessThanOrEqual(12)
    const history = await emulator.scrollback()
    expect(history.filter(line => line.includes('TRANSCRIPT above search A'))).toHaveLength(1)

    // And the block stayed together: following the selected ROW alone scrolls
    // the continuation lines off exactly when the selection reaches the bottom
    // of the window, which is when they are being read.
    const drawn = overlay.render(COLUMNS, 12).map(line => stripAnsi(line))
    const marked = drawn.findIndex(line => line.includes('❯'))
    expect(marked).toBeGreaterThanOrEqual(0)
    expect(drawn[marked + 1] ?? '').toContain('↳')
  })

  it('shows an escape sequence in a remembered prompt instead of obeying it', async () => {
    const emulator = createEmulator(COLUMNS, 24)
    const screen = new Screen(emulator.target)
    screen.commit(['TRANSCRIPT above search A'])
    // A durable session log carries whatever a paste put into a prompt.
    const { overlay } = searching(['clear the screen \u001b[2J now'])
    screen.setLive(overlay.render(COLUMNS, 24))

    const visible = (await emulator.screen()).join('\n')
    expect(visible).toContain('^[[2J')
    expect((await emulator.scrollback()).join('\n')).toContain('TRANSCRIPT above search A')
  })

  it('shows a control character in the query instead of obeying it', async () => {
    const emulator = createEmulator(COLUMNS, 24)
    const screen = new Screen(emulator.target)
    screen.commit(['TRANSCRIPT above search A'])
    const { overlay } = searching(['anything'])
    overlay.handleKey({ kind: 'paste', text: 'evil\u001b[2Jquery' })
    screen.setLive(overlay.render(COLUMNS, 24))

    expect((await emulator.screen()).join('\n')).toContain('^[[2J')
    expect((await emulator.scrollback()).join('\n')).toContain('TRANSCRIPT above search A')
  })

  it('keeps every border in one column for CJK results and a CJK query', async () => {
    const { emulator, overlay, draw } = terminal(
      ['请修复失败的测试', '解释这个函数', '再次运行测试并报告结果'],
      24,
    )
    for (const character of '测试') overlay.handleKey({ kind: 'text', text: character })
    draw()

    const rows = (await emulator.screen()).filter(row => row.includes('│') || row.includes('╭') || row.includes('╰'))
    expect(rows.length).toBeGreaterThan(2)
    // A wide character fills two cells, so the border column is a COLUMN count,
    // not a string length: measuring the latter is how CJK frames go crooked.
    const widths = new Set(rows.map(row => displayWidth(row.trimEnd())))
    expect(widths.size).toBe(1)
  })

  it('falls back to an answerable row on a terminal too small to frame', () => {
    const { overlay } = searching(['fix the auth retry', 'unrelated'])
    for (const character of 'auth') overlay.handleKey({ kind: 'text', text: character })

    // Below the same width floor the shared picker keeps: a frame this narrow
    // has no room left for a result once its borders are drawn.
    const tiny = overlay.render(16, 24).map(line => stripAnsi(line))
    // No frame, and still the one thing a reader needs to decide whether to
    // press enter: what would be recalled.
    expect(tiny.join('\n')).not.toContain('╭')
    expect(tiny[0]).toContain('❯ fix the auth')
    expect(tiny.join('\n')).toContain('⌕ auth█')
    expect(tiny.length).toBeLessThanOrEqual(24)

    const short = overlay.render(COLUMNS, 3).map(line => stripAnsi(line))
    expect(short.length).toBeLessThanOrEqual(3)
    expect(short[0]).toContain('fix the auth retry')
    expect(overlay.render(COLUMNS, 0)).toEqual([])
  })

  it('never draws more rows than the terminal has, at any height', () => {
    const { overlay } = searching(MANY)
    for (let rows = 0; rows <= 30; rows += 1) {
      const drawn = overlay.render(COLUMNS, rows)
      expect(drawn.length).toBeLessThanOrEqual(Math.max(0, rows))
      for (const line of drawn) expect(displayWidth(line)).toBeLessThanOrEqual(COLUMNS)
    }
  })
})

describe('what a result row shows', () => {
  it('orients the preview around the logical line that matched', () => {
    const { overlay } = searching([
      'please take a look at this\nthe auth token expires early\nand thanks',
    ])
    for (const character of 'token') overlay.handleKey({ kind: 'text', text: character })

    const drawn = overlay.render(COLUMNS, 24).map(line => stripAnsi(line)).join('\n')
    // Showing the first line alone would leave the reader unable to see why the
    // row is in the list at all.
    expect(drawn).toContain('❯ the auth token expires early')
    expect(drawn).toContain('↳ and thanks')
  })

  it('bounds an expanded result and says how many lines it did not show', () => {
    const { overlay } = searching([`match here${'\nfiller line'.repeat(10)}`])
    for (const character of 'match') overlay.handleKey({ kind: 'text', text: character })

    const drawn = overlay.render(COLUMNS, 24).map(line => stripAnsi(line))
    const shown = drawn.filter(line => line.includes('filler line'))
    expect(shown).toHaveLength(2)
    expect(drawn.join('\n')).toContain('8 more lines')
  })

  it('previews an unselected multiline result on one row', () => {
    const { overlay } = searching(['alpha match\nsecond line', 'beta match\nsecond line'])
    for (const character of 'match') overlay.handleKey({ kind: 'text', text: character })

    const drawn = overlay.render(COLUMNS, 24).map(line => stripAnsi(line))
    const alpha = drawn.findIndex(line => line.includes('alpha match'))
    expect(alpha).toBeGreaterThan(0)
    // The row after it is the frame's own, not a continuation: only the
    // selection expands.
    expect(drawn[alpha + 1] ?? '').not.toContain('second line')
  })

  it('windows a long line around the hit so a match is never invisible', () => {
    const { overlay } = searching([`${'padding '.repeat(30)}NEEDLE trailing text`])
    for (const character of 'NEEDLE') overlay.handleKey({ kind: 'text', text: character })

    const row = overlay.render(COLUMNS, 24).map(line => stripAnsi(line)).find(line => line.includes('❯'))
    // Cutting from the left alone would show nothing but padding, which reads as
    // a row that matched for no reason.
    expect(row).toContain('NEEDLE')
    expect(row).toContain('…')
    expect(displayWidth(row ?? '')).toBeLessThanOrEqual(COLUMNS)
  })

  it('reports the selection’s place among the matches', () => {
    const { overlay } = searching(['log a', 'log b', 'log c'])
    for (const character of 'log') overlay.handleKey({ kind: 'text', text: character })

    expect(overlay.render(COLUMNS, 24).map(line => stripAnsi(line)).join('\n')).toContain('History 1/3')
    overlay.handleKey({ kind: 'key', name: 'ctrl-r' })
    expect(overlay.render(COLUMNS, 24).map(line => stripAnsi(line)).join('\n')).toContain('History 2/3')
  })

  it('highlights the matched text on both a selected and an unselected row', () => {
    const { overlay } = searching(['older auth line', 'newer auth line'])
    for (const character of 'auth') overlay.handleKey({ kind: 'text', text: character })

    const drawn = overlay.render(COLUMNS, 24)
    const selected = drawn.find(line => stripAnsi(line).includes('❯ newer auth line')) ?? ''
    const plain = drawn.find(line => stripAnsi(line).includes('older auth line')) ?? ''
    // Styling around the hit rather than around the whole row, and never nested:
    // a reset from an inner call would close the outer styling and leak colour.
    expect(selected).toContain('auth')
    expect(selected.split('auth')[0]).toMatch(/\u001b\[[\d;]+m$/u)
    expect(plain.split('auth')[0]).toMatch(/\u001b\[[\d;]+m$/u)
  })
})

describe('locating the match inside a result', () => {
  /**
   * A candidate whose first character EXPANDS when it is lowercased: `İ` folds
   * to `i` plus a combining dot, so every offset found in the folded string is
   * one code unit ahead of the same text in the original.
   */
  const EXPANDING = 'İAUTH token'

  it('highlights the original span, not the one a folded offset points at', () => {
    const { overlay } = searching([EXPANDING])
    for (const character of 'auth') overlay.handleKey({ kind: 'text', text: character })

    const row = overlay.render(COLUMNS, 24).find(line => stripAnsi(line).includes('❯')) ?? ''
    // Slicing the original with an index found in its lowercased copy highlights
    // `UTH ` here — the right number of characters, one position late — and the
    // plain text of the row is identical either way.
    expect(styledRuns(row).map(run => run.text)).toContain('AUTH')
    expect(styledRuns(row).map(run => run.text)).not.toContain('UTH ')
    expect(stripAnsi(row)).toContain('İAUTH token')
  })

  it('highlights the original span on an unselected row too', () => {
    const { overlay } = searching([EXPANDING, 'a newer auth line'])
    for (const character of 'auth') overlay.handleKey({ kind: 'text', text: character })

    const row = overlay.render(COLUMNS, 24).find(line => stripAnsi(line).includes('İ')) ?? ''
    expect(styledRuns(row).map(run => run.text)).toContain('AUTH')
    expect(styledRuns(row).map(run => run.text)).not.toContain('UTH ')
  })

  it('gives the highlight styling of its own, distinct from the text around it', () => {
    const { overlay } = searching([EXPANDING])
    for (const character of 'auth') overlay.handleKey({ kind: 'text', text: character })

    const runs = styledRuns(overlay.render(COLUMNS, 24).find(line => stripAnsi(line).includes('❯')) ?? '')
    const hit = runs.find(run => run.text === 'AUTH')
    const before = runs.find(run => run.text === 'İ')
    expect(hit?.sgr).toBeDefined()
    expect(hit?.sgr).not.toBe('')
    expect(hit?.sgr).not.toBe(before?.sgr)
  })

  it('keeps the whole source character when the query matches half of what it folds to', () => {
    const { overlay } = searching(['İstanbul deploy'])
    overlay.handleKey({ kind: 'text', text: 'i' })

    const row = overlay.render(COLUMNS, 24).find(line => stripAnsi(line).includes('❯')) ?? ''
    // `i` matches the first of the two code units `İ` folds to. Highlighting an
    // empty span there would hide a real hit.
    expect(styledRuns(row).map(run => run.text)).toContain('İ')
    expect(stripAnsi(row)).toContain('İstanbul deploy')
  })

  /**
   * A line whose lowercasing is CONTEXT-SENSITIVE: `ΟΣ` folds to `ος`, with a
   * FINAL sigma, because the sigma ends the word. Folding it one code point at a
   * time gives `οσ` instead, which the query `ος` cannot be found in.
   */
  const CONTEXTUAL = 'first line\nΟΣ\nthird line'

  it('finds a contextually-cased match the search itself matched', () => {
    const { overlay, search } = searching([CONTEXTUAL])
    for (const character of 'ος') overlay.handleKey({ kind: 'text', text: character })

    // Membership first: the search folds whole entries, and it matches.
    expect(search.matches).toEqual([0])

    // Presentation has to agree. Per-code-point folding cannot find this, and
    // silently falls back to the first line — the exact "matched for no visible
    // reason" failure the preview orientation exists to prevent.
    const drawn = overlay.render(COLUMNS, 24).map(line => stripAnsi(line)).join('\n')
    expect(drawn).toContain('❯ ΟΣ')
    expect(drawn).not.toContain('❯ first line')
  })

  it('highlights the original span of a contextually-cased match', () => {
    const { overlay } = searching([CONTEXTUAL])
    for (const character of 'ος') overlay.handleKey({ kind: 'text', text: character })

    const row = overlay.render(COLUMNS, 24).find(line => stripAnsi(line).includes('❯')) ?? ''
    expect(styledRuns(row).map(run => run.text)).toContain('ΟΣ')
  })

  it('orients the compact fallback on a contextually-cased later line too', () => {
    const { overlay } = searching([CONTEXTUAL])
    for (const character of 'ος') overlay.handleKey({ kind: 'text', text: character })

    const rows = overlay.render(16, 3).map(line => stripAnsi(line))
    expect(rows[0]).toContain('ΟΣ')
    expect(rows[0]).not.toContain('first line')
  })

  it('still highlights CJK and astral matches on their own boundaries', () => {
    const cjk = searching(['请修复失败的测试'])
    for (const character of '测试') cjk.overlay.handleKey({ kind: 'text', text: character })
    const cjkRow = cjk.overlay.render(COLUMNS, 24).find(line => stripAnsi(line).includes('❯')) ?? ''
    expect(styledRuns(cjkRow).map(run => run.text)).toContain('测试')

    const emoji = searching(['ship it 🚀 now'])
    emoji.overlay.handleKey({ kind: 'text', text: '🚀' })
    const emojiRow = emoji.overlay.render(COLUMNS, 24).find(line => stripAnsi(line).includes('❯')) ?? ''
    expect(styledRuns(emojiRow).map(run => run.text)).toContain('🚀')
  })
})

describe('the compact fallback tells the same truth as the frame', () => {
  /** A terminal too narrow for the frame, so every case degrades. */
  const TINY = 16

  /**
   * Render a search at a size that forces the compact path.
   * @param lines - the submissions to search.
   * @param query - the query to type.
   * @returns the fallback's rows, unstyled.
   */
  function compact(lines: readonly string[], query: string): string[] {
    const search = new HistorySearch(recorded(lines))
    const overlay = createHistorySearchOverlay({
      search,
      settle: () => {},
      invalidate: () => {},
    })
    for (const character of query) overlay.handleKey({ kind: 'text', text: character })
    return overlay.render(TINY, 3).map(line => stripAnsi(line))
  }

  it('tells an empty session apart from a query that matched nothing', () => {
    // Truncated to the terminal, so the assertion is on what survives: the two
    // states still have to be told apart at sixteen columns.
    expect(compact([], '')[0]).toContain('Nothing has been')
    expect(compact(['alpha'], 'zzz')[0]).toContain('No input matches')
  })

  it('shows the logical line that matched, not the first line of the entry', () => {
    const rows = compact(['please inspect this\nthe auth token expires early\nthanks'], 'auth')

    // The framed list orients on the matching line; degrading must not bring
    // back a result that appears to have matched for no visible reason.
    expect(rows[0]).toContain('auth')
    expect(rows[0]).not.toContain('please inspect')
    expect(rows.length).toBeLessThanOrEqual(3)
  })

  it('never spends more rows than the terminal has', () => {
    for (let rows = 0; rows <= 4; rows += 1) {
      const search = new HistorySearch(recorded(['fix the auth retry\nsecond line']))
      const overlay = createHistorySearchOverlay({
        search,
        settle: () => {},
        invalidate: () => {},
      })
      expect(overlay.render(TINY, rows).length).toBeLessThanOrEqual(Math.max(0, rows))
    }
  })
})
