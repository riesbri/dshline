import { describe, expect, it } from 'vitest'
import { box, Composer, displayWidth, escapeControls, frame, paint, renderMarkdown, Screen, style, wrapToWidth } from '../src/index.ts'
import { createEmulator } from '../../../tests/emulator.ts'

/**
 * These assert what a terminal shows, not what the renderer wrote. The unit tests
 * beside them cover the arithmetic; this file is the only place that can catch a
 * frame that computes correctly and still looks wrong.
 */
describe('rendered output', () => {
  it('draws a live region and nothing more', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.setLive(['first', 'second'])
    expect(await emulator.screen()).toEqual(['first', 'second'])
    emulator.dispose()
  })

  it('replaces a taller region without leaving its tail behind', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.setLive(['one', 'two', 'three'])
    screen.setLive(['only'])
    // A short redraw over a tall region must erase the rows it no longer uses;
    // leftover rows are the classic symptom of miscounted cursor movement.
    expect(await emulator.screen()).toEqual(['only'])
    emulator.dispose()
  })

  it('leaves screen and cursor untouched when a redraw repeats the frame', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.setLive(['alpha', 'beta'], { row: 0, column: 2 })
    const before = await emulator.cursor()
    // The redundant frames a burst of invalidations produces must change
    // nothing a reader could see — including where the hardware cursor sits,
    // which plain text output cannot show.
    screen.setLive(['alpha', 'beta'], { row: 0, column: 2 })
    screen.setLive(['alpha', 'beta'], { row: 0, column: 2 })
    expect(await emulator.screen()).toEqual(['alpha', 'beta'])
    expect(await emulator.cursor()).toEqual(before)
    emulator.dispose()
  })

  it('redraws into a screen something else wiped, once markStale says to', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.setLive(['alpha', 'beta'])
    // ctrl-l clears the display directly and the window marks the screen
    // stale before asking for the repaint. Without the mark, the identical-
    // frame skip would answer the redraw with silence over a blank display.
    emulator.target.write('\u001b[2J\u001b[H')
    screen.markStale()
    screen.setLive(['alpha', 'beta'])
    expect(await emulator.screen()).toEqual(['alpha', 'beta'])
    emulator.dispose()
  })

  it('keeps committed output above the live region, in order', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.setLive(['composer'])
    screen.commit(['first committed'])
    screen.commit(['second committed'])
    expect(await emulator.screen()).toEqual(['first committed', 'second committed', 'composer'])
    emulator.dispose()
  })

  it('redraws the region correctly after a commit', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.setLive(['a', 'b'])
    screen.commit(['committed'])
    screen.setLive(['replaced'])
    expect(await emulator.screen()).toEqual(['committed', 'replaced'])
    emulator.dispose()
  })

  it('leaves committed scrollback in place when it closes', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.commit(['a transcript line'])
    screen.setLive(['composer'])
    screen.close()
    expect(await emulator.screen()).toEqual(['a transcript line'])
    emulator.dispose()
  })

  it('draws a styled box with its borders in one column', async () => {
    const emulator = createEmulator(30)
    const screen = new Screen(emulator.target)
    screen.setLive(box(['hello'], { width: 24, border: text => style(text, 'gray') }))
    const rows = await emulator.screen()
    // Every rendered row ends at the same column, which is what a misjudged
    // escape-sequence width breaks first.
    expect(rows.map(row => displayWidth(row))).toEqual([24, 24, 24])
    expect(rows[1]).toBe('│ hello                │')
    emulator.dispose()
  })

  it('keeps a CJK box aligned', async () => {
    const emulator = createEmulator(30)
    const screen = new Screen(emulator.target)
    screen.setLive(box(['标准模式'], { width: 24 }))
    const rows = await emulator.screen()
    // Measured in COLUMNS, not string length: the emulator stores a wide
    // character as two cells and `translateToString` skips the second, so four
    // ideographs come back as four characters occupying eight columns.
    expect(rows.map(row => displayWidth(row))).toEqual([24, 24, 24])
    expect(rows[1]).toBe('│ 标准模式             │')
    emulator.dispose()
  })

  it('aligns dual-labelled Latin and East Asian frames to the same terminal columns', async () => {
    const emulator = createEmulator(30)
    const screen = new Screen(emulator.target)
    screen.setLive([
      ...frame(['hello'], { width: 24, title: 'anchovy', rightTitle: 'sandwich' }),
      ...frame(['标准模式'], { width: 24, title: '标准', rightTitle: '会话' }),
    ])
    expect(await emulator.screen()).toEqual([
      '╭─ anchovy ─ sandwich ─╮',
      '│ hello                │',
      '╰──────────────────────╯',
      '╭─ 标准 ──────── 会话 ─╮',
      '│ 标准模式             │',
      '╰──────────────────────╯',
    ])
    for (const row of [0, 1, 2, 3, 4, 5]) {
      expect((await emulator.cell(0, row))?.chars).toMatch(/[╭│╰]/u)
      expect((await emulator.cell(23, row))?.chars).toMatch(/[╮│╯]/u)
    }
    emulator.dispose()
  })

  it('keeps border colour on both sides of separately styled header labels', async () => {
    const emulator = createEmulator(30)
    const screen = new Screen(emulator.target)
    screen.setLive(frame(['body'], {
      width: 28,
      title: paint('anchovy', 'heading-1'),
      rightTitle: paint('sandwich', 'code'),
      border: text => paint(text, 'rule'),
    }))
    expect(await emulator.screen()).toEqual([
      '╭─ anchovy ───── sandwich ─╮',
      '│ body                     │',
      '╰──────────────────────────╯',
    ])
    expect(await emulator.cell(0, 0)).toEqual({ chars: '╭', fg: 8, bold: false })
    expect(await emulator.cell(3, 0)).toEqual({ chars: 'a', fg: 6, bold: true })
    expect(await emulator.cell(10, 0)).toEqual({ chars: ' ', fg: 8, bold: false })
    expect(await emulator.cell(17, 0)).toEqual({ chars: 's', fg: 6, bold: false })
    expect(await emulator.cell(25, 0)).toEqual({ chars: ' ', fg: 8, bold: false })
    expect(await emulator.cell(27, 0)).toEqual({ chars: '╮', fg: 8, bold: false })
    emulator.dispose()
  })

  it('places divider junctions in the same terminal columns as outer borders', async () => {
    const emulator = createEmulator(24)
    const screen = new Screen(emulator.target)
    screen.setLive(frame(['above', { kind: 'divider' }, 'below'], { width: 18 }))
    expect(await emulator.screen()).toEqual([
      '╭────────────────╮',
      '│ above          │',
      '├────────────────┤',
      '│ below          │',
      '╰────────────────╯',
    ])
    expect(await emulator.cell(0, 2)).toEqual({ chars: '├', fg: undefined, bold: false })
    expect(await emulator.cell(17, 2)).toEqual({ chars: '┤', fg: undefined, bold: false })
    emulator.dispose()
  })

  it('integrates a footer without creating another physical terminal row', async () => {
    const emulator = createEmulator(24)
    const screen = new Screen(emulator.target)
    screen.setLive(frame(['body'], { width: 20, footer: '3 sessions' }))
    expect(await emulator.screen()).toEqual([
      '╭──────────────────╮',
      '│ body             │',
      '╰─ 3 sessions ─────╯',
    ])
    expect((await emulator.cell(19, 2))?.chars).toBe('╯')
    expect((await emulator.cell(0, 3))?.chars).toBe('')
    emulator.dispose()
  })

  it('wraps a long line to real rows rather than overflowing', async () => {
    const emulator = createEmulator(12)
    const screen = new Screen(emulator.target)
    screen.setLive(['aaaa bbbb cccc dddd'])
    expect(await emulator.screen()).toEqual(['aaaa bbbb', 'cccc dddd'])
    emulator.dispose()
  })

  it('does not wrap a styled line early', async () => {
    const emulator = createEmulator(20)
    const screen = new Screen(emulator.target)
    // Twenty visible columns of styled text fit exactly one row; counting the
    // escape bytes as columns would split it.
    screen.setLive([style('12345678901234567890', 'red')])
    expect(await emulator.screen()).toEqual(['12345678901234567890'])
    emulator.dispose()
  })

  it('keeps styling on a wrapped continuation row', async () => {
    const emulator = createEmulator(6)
    const screen = new Screen(emulator.target)
    screen.setLive([style('aaaa bbbb', 'red')])
    expect(await emulator.screen()).toEqual(['aaaa', 'bbbb'])
    // Read from cell attributes, not text: translateToString carries no styling,
    // so a continuation row that lost its colour would look identical.
    expect(await emulator.cell(0, 0)).toEqual({ chars: 'a', fg: 1, bold: false })
    expect(await emulator.cell(0, 1)).toEqual({ chars: 'b', fg: 1, bold: false })
    emulator.dispose()
  })

  it('preserves an indented wide glyph when a five-column box body wraps', async () => {
    const emulator = createEmulator(20)
    try {
      // Write the box directly: Screen must not get a second chance to wrap a
      // row after fitToWidth has already discarded a character from its body.
      emulator.target.write(box([' bbbb界'], { width: 9 }).join('\r\n'))
      const rows = await emulator.screen()
      expect(rows.map(row => row.replace(/[╭╮╰╯│─\s]/gu, '')).join('')).toBe('bbbb界')
      for (let row = 0; row < rows.length; row += 1) {
        expect(displayWidth(rows[row] ?? '')).toBe(9)
        expect((await emulator.cell(0, row))?.chars).toMatch(/[╭│╰]/u)
        expect((await emulator.cell(8, row))?.chars).toMatch(/[╮│╯]/u)
      }
    } finally {
      emulator.dispose()
    }
  })

  it('preserves mixed bold through a box whose borders reset styling', async () => {
    const emulator = createEmulator(20)
    try {
      emulator.target.write(box([`${style('aa bb', 'bold')}cc`], {
        width: 9,
        border: text => style(text, 'gray'),
      }).join('\r\n'))
      const rows = await emulator.screen()
      const letters = []
      for (let row = 0; row < rows.length; row += 1) {
        expect(displayWidth(rows[row] ?? '')).toBe(9)
        for (let column = 0; column < 9; column += 1) {
          const cell = await emulator.cell(column, row)
          if (cell !== undefined && /^[abc界]$/u.test(cell.chars)) letters.push(cell)
        }
      }
      expect(letters).toEqual([
        ...['a', 'a', 'b', 'b'].map(chars => ({ chars, fg: undefined, bold: true })),
        ...['c', 'c'].map(chars => ({ chars, fg: undefined, bold: false })),
      ])
    } finally {
      emulator.dispose()
    }
  })

  it.each([
    ['a bold reset inside the retained suffix', `${style('aa bb', 'bold')}cc`],
    ['a foreground reset and reopen inside the retained suffix', '\u001b[31maa b\u001b[39mb\u001b[32mc\u001b[0mc'],
    ['bold and colour transitions inside the retained suffix', '\u001b[1m\u001b[31maa b\u001b[0m\u001b[32mb\u001b[1mc\u001b[0mc'],
    ['mixed styling through a second capacity break', `${style(' bb', 'bold')}${style('bb界', 'red')}`],
  ])('matches original terminal cells after wrapping %s', async (_name, source) => {
    const original = createEmulator(30)
    const wrapped = createEmulator(30)
    try {
      original.target.write(source)
      const expected = []
      for (let column = 0; column < 30; column += 1) {
        const cell = await original.cell(column, 0)
        if (cell !== undefined && /^[abc界]$/u.test(cell.chars)) expected.push(cell)
      }
      // Reset-bearing borders expose a missing continuation opener. The ! is
      // deliberately unstyled BEFORE the closing border: a missing row reset
      // must not be hidden by that border's own reset.
      const rows = wrapToWidth(source, 5)
      const border = style('│', 'gray')
      wrapped.target.write(rows.map(row => `${border}${row}!${border}`).join('\r\n'))
      const actual = []
      const shown = await wrapped.screen()
      for (let row = 0; row < shown.length; row += 1) {
        expect(displayWidth(shown[row] ?? '')).toBeLessThanOrEqual(8)
        const text = shown[row] ?? ''
        const sentinelIndex = text.indexOf('!')
        expect(sentinelIndex).toBeGreaterThanOrEqual(1)
        // A wide glyph occupies two terminal cells but one string character.
        const sentinel = displayWidth(text.slice(0, sentinelIndex))
        expect(await wrapped.cell(sentinel, row)).toEqual({ chars: '!', fg: undefined, bold: false })
        for (let column = 1; column < sentinel; column += 1) {
          const cell = await wrapped.cell(column, row)
          if (cell !== undefined && /^[abc界]$/u.test(cell.chars)) actual.push(cell)
        }
      }
      expect(actual).toEqual(expected)
    } finally {
      original.dispose()
      wrapped.dispose()
    }
  })

  it('leaves an unstyled row with no colour of its own', async () => {
    const emulator = createEmulator(10)
    const screen = new Screen(emulator.target)
    screen.setLive(['plain'])
    // The companion to the assertion above: without this, a helper that reported
    // red for every cell would satisfy both.
    expect(await emulator.cell(0, 0)).toEqual({ chars: 'p', fg: undefined, bold: false })
    emulator.dispose()
  })

  it('places the terminal cursor over CJK by columns, not characters', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    const composer = new Composer()
    composer.set('标准模式')
    composer.handle({ kind: 'key', name: 'left' })
    // Three ideographs precede the cursor, so six columns, plus a two-column
    // prompt: the terminal cursor must land at column 8, not at 5 characters.
    expect(composer.cursorColumn).toBe(6)
    screen.setLive([`› ${composer.value}`], { row: 0, column: 2 + composer.cursorColumn })
    expect(await emulator.screen()).toEqual(['› 标准模式'])
    expect(await emulator.cursor()).toEqual({ column: 8, row: 0 })
    emulator.dispose()
  })

  it('places the cursor on the row the caller asked for', async () => {
    const emulator = createEmulator(20)
    const screen = new Screen(emulator.target)
    screen.setLive(['first', 'second', 'third'], { row: 1, column: 3 })
    expect(await emulator.cursor()).toEqual({ column: 3, row: 1 })
    emulator.dispose()
  })

  it('leaves the cursor clear of the region when none is requested', async () => {
    const emulator = createEmulator(20)
    const screen = new Screen(emulator.target)
    screen.setLive(['one', 'two'])
    // No placement means the cursor ends where drawing stopped, on the last row.
    expect(await emulator.cursor()).toEqual({ column: 3, row: 1 })
    emulator.dispose()
  })

  it('draws a pasted block as its own lines, aligned under the prompt', async () => {
    const emulator = createEmulator(30)
    const screen = new Screen(emulator.target)
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'first\nsecond' })
    const lines = composer.lines.map((line, index) => `${index === 0 ? '\u203a ' : '  '}${line}`)
    screen.setLive(box(lines, { width: 24 }))
    expect(await emulator.screen()).toEqual([
      '\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e',
      '\u2502 \u203a first              \u2502',
      '\u2502   second             \u2502',
      '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f',
    ])
    emulator.dispose()
  })

  it('shows an escape sequence from tool output instead of obeying it', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.commit(['before'])
    // A REAL clear-screen sequence, run through the production sanitizer, so the
    // test fails if that sanitizing is ever removed. Writing the caret form
    // directly would assert nothing.
    const hostile = '\u001b[2J after'
    screen.setLive([escapeControls(hostile)])
    const rows = await emulator.screen()
    expect(rows[0]).toBe('before')
    expect(rows[1]).toBe('^[[2J after')
    emulator.dispose()
  })

  it('would lose earlier rows if that sanitizing were skipped', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.commit(['before'])
    // The counter-case that gives the assertion above its meaning: the same bytes
    // unsanitized do reach the terminal and do clear it.
    screen.setLive(['\u001b[2J after'])
    expect(await emulator.screen()).not.toContain('before')
    emulator.dispose()
  })

  it('renders a multi-line markdown reply with styling that survives the terminal', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    const reply = ['# Setup', '', 'Run **build** then `test`.', '', '- first', '- second'].join('\n')
    screen.commit(renderMarkdown(reply))
    expect(await emulator.screen()).toEqual([
      'Setup',
      '',
      'Run build then test.',
      '',
      '• first',
      '• second',
    ])
    // Structure alone would pass with every attribute lost, so the heading's
    // weight and the bullet glyph's colour are read from the cells.
    expect(await emulator.cell(0, 0)).toEqual({ chars: 'S', fg: 6, bold: true })
    expect((await emulator.cell(4, 2))?.bold).toBe(true)
    expect((await emulator.cell(0, 4))?.fg).toBe(8)
    // And prose between them carries no styling of its own.
    expect(await emulator.cell(0, 2)).toEqual({ chars: 'R', fg: undefined, bold: false })
    emulator.dispose()
  })

  it('keeps an identifier in a reply intact through the terminal', async () => {
    const emulator = createEmulator(40)
    const screen = new Screen(emulator.target)
    screen.commit(renderMarkdown('Edit snake_case_name in file_name.ts'))
    // The end-to-end form of the flanking rule: what the user can read and copy.
    expect(await emulator.screen()).toEqual(['Edit snake_case_name in file_name.ts'])
    emulator.dispose()
  })

  it('renders a full frame of chrome the way a person reads it', async () => {
    const emulator = createEmulator(34)
    const screen = new Screen(emulator.target)
    screen.commit(['› a question', '', '● an answer'])
    screen.setLive([
      '',
      ...box(['› ask anything'], { width: 32 }),
      '  ● ready',
    ])
    expect(await emulator.screen()).toEqual([
      '› a question',
      '',
      '● an answer',
      '',
      '╭──────────────────────────────╮',
      '│ › ask anything               │',
      '╰──────────────────────────────╯',
      '  ● ready',
    ])
    emulator.dispose()
  })
})
