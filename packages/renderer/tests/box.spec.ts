import { describe, expect, it } from 'vitest'
import { box, boxHeight, displayWidth, fitToWidth, formatElapsed, formatTokens, frame, frameHeight, SPINNER_INTERVAL_MS, spinnerFrame, stripAnsi, style } from '../src/index.ts'
import type { FrameDivider } from '../src/index.ts'

const DIVIDER: FrameDivider = { kind: 'divider' }

describe('box()', () => {
  it('draws every row at exactly the requested width', () => {
    const lines = box(['hello'], { width: 20 })
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(displayWidth(line)).toBe(20)
  })

  it('keeps the right border aligned for CJK content', () => {
    // Measuring by string length instead of display columns is what pushes a
    // border out of true and makes a hand-rolled frame look broken.
    const lines = box(['标准模式'], { width: 20 })
    for (const line of lines) expect(displayWidth(line)).toBe(20)
    expect(lines[1]).toBe('│ 标准模式         │')
  })

  it('writes a title into the top border without changing the width', () => {
    const lines = box(['x'], { width: 24, title: 'dsh' })
    expect(stripAnsi(lines[0] ?? '')).toContain(' dsh ')
    expect(displayWidth(lines[0] ?? '')).toBe(24)
  })

  it('keeps the width exact when the title carries styling', () => {
    // Overlays style their titles; measuring the escape bytes as columns would
    // shorten the top border relative to every other framed element.
    const lines = box(['x'], { width: 40, title: style('Select a model', 'bold', 'yellow') })
    for (const line of lines) expect(displayWidth(line)).toBe(40)
  })

  it('wraps content that exceeds the inner width rather than clipping it', () => {
    const lines = box(['aaaa bbbb cccc'], { width: 12 })
    // Width 12 leaves 8 inner columns, so the text takes three rows.
    expect(lines).toHaveLength(5)
    expect(lines.map(line => displayWidth(line))).toEqual([12, 12, 12, 12, 12])
  })

  it('keeps the wide glyph after a retained word instead of clipping malformed wrapping', () => {
    const lines = box([' bbbb界'], { width: 9 })
    for (const line of lines) expect(displayWidth(line)).toBe(9)
    const body = lines.slice(1, -1).map(stripAnsi).map(row => row.slice(2, -2)).join('')
    expect(body.replaceAll(' ', '')).toBe('bbbb界')
    expect(body.match(/界/gu)).toHaveLength(1)
  })

  it('draws an empty content row rather than collapsing', () => {
    expect(box([], { width: 10 })).toHaveLength(3)
  })

  it('applies border styling only to the border', () => {
    const lines = box(['plain'], { width: 16, border: text => `<${text}>` })
    expect(lines[0]?.startsWith('<')).toBe(true)
    expect(lines[1]).toBe('<│> plain        <│>')
  })
})

describe('boxHeight()', () => {
  it('predicts the rendered height without rendering', () => {
    for (const content of [[], ['one'], ['aaaa bbbb cccc'], ['标准模式标准模式']]) {
      expect(boxHeight(content, 12)).toBe(box(content, { width: 12 }).length)
    }
  })
})

describe('frame()', () => {
  it('draws every labelled and styled row at exactly the requested width', () => {
    const cases = [
      frame(['plain'], { width: 22, title: 'anchovy' }),
      frame(['plain'], { width: 28, title: 'anchovy', rightTitle: 'sandwich' }),
      frame(['plain'], { width: 22, footer: '3 sessions' }),
      frame(['标准模式'], { width: 22, title: '会话', rightTitle: '活动' }),
      frame([style('styled body', 'green')], {
        width: 28,
        title: style('anchovy', 'bold', 'cyan'),
        rightTitle: style('sandwich', 'yellow'),
        footer: style('ready', 'dim'),
        border: text => style(text, 'gray'),
      }),
    ]
    for (const lines of cases) {
      for (const line of lines) expect(displayWidth(line)).toBe(displayWidth(lines[0] ?? ''))
    }
    expect(cases.map(lines => displayWidth(lines[0] ?? ''))).toEqual([22, 28, 22, 22, 28])
  })

  it('truncates fractional widths and treats values below five as five', () => {
    expect(frame([], { width: 4.9 }).map(displayWidth)).toEqual([5, 5, 5])
    expect(frame([], { width: 12.9 }).map(displayWidth)).toEqual([12, 12, 12])
  })

  it('keeps the left label whole while the right title truncates and then disappears', () => {
    const tops = [24, 20, 17, 16, 15, 10].map(width =>
      stripAnsi(frame([''], { width, title: 'anchovy', rightTitle: 'sandwich' })[0] ?? ''),
    )
    expect(tops).toEqual([
      '╭─ anchovy ─ sandwich ─╮',
      '╭─ anchovy ─ sand ─╮',
      '╭─ anchovy ─ s ─╮',
      '╭─ anchovy ────╮',
      '╭─ anchovy ───╮',
      '╭─ anch ─╮',
    ])
  })

  it('fits CJK header labels by display columns without straddling', () => {
    expect(stripAnsi(frame([''], { width: 17, title: '会话', rightTitle: '标准' })[0] ?? ''))
      .toBe('╭─ 会话 ─ 标准 ─╮')
    const narrow = frame([''], { width: 11, title: '标准模式', rightTitle: '会话' })[0] ?? ''
    expect(stripAnsi(narrow)).toBe('╭─ 标准 ──╮')
    expect(displayWidth(narrow)).toBe(11)
  })

  it('truncates ANSI-styled labels and closes their styling before the border resumes', () => {
    const top = frame([''], { width: 10, title: style('abcdef', 'red') })[0] ?? ''
    expect(stripAnsi(top)).toBe('╭─ abcd ─╮')
    expect(displayWidth(top)).toBe(10)
    expect(top).toContain('\u001b[31mabcd\u001b[0m')
    expect(top.indexOf('\u001b[0m')).toBeLessThan(top.lastIndexOf('─╮'))
  })

  it('flattens label line breaks without changing frame geometry', () => {
    const lines = frame(['body'], { width: 20, title: 'open\nsessions', footer: '3\nitems' })
    expect(stripAnsi(lines[0] ?? '')).toContain('open sessions')
    expect(stripAnsi(lines.at(-1) ?? '')).toContain('3 items')
    expect(lines.map(displayWidth)).toEqual([20, 20, 20])
  })

  it('integrates a footer into the bottom border without adding a row', () => {
    const plain = frame(['body'], { width: 20 })
    const footered = frame(['body'], { width: 20, footer: '3 sessions' })
    expect(footered).toHaveLength(plain.length)
    expect(frameHeight(['body'], { width: 20 })).toBe(footered.length)
    expect(stripAnsi(footered.at(-1) ?? '')).toBe('╰─ 3 sessions ─────╯')
  })

  it('renders a divider as one width-exact junction row', () => {
    const lines = frame(['above', DIVIDER, 'below'], { width: 18 })
    expect(stripAnsi(lines[2] ?? '')).toBe(`├${'─'.repeat(16)}┤`)
    expect(displayWidth(lines[2] ?? '')).toBe(18)
    expect(lines).toHaveLength(5)
  })
})

describe('frameHeight()', () => {
  it('predicts wrapped text, dividers, and an empty body independently of border labels', () => {
    const content = ['aaaa bbbb cccc', DIVIDER, '标准模式标准模式'] as const
    const options = { width: 12, title: 'anchovy', rightTitle: 'sandwich', footer: 'ready' }
    expect(frameHeight(content, options)).toBe(frame(content, options).length)
    expect(frameHeight(content, { width: 12 })).toBe(8)
    expect(frameHeight(content, { width: 12.9 })).toBe(8)
    expect(frameHeight([], { width: 12 })).toBe(3)
    expect(frameHeight([], { width: 12 })).toBe(frame([], options).length)
  })
})

describe('fitToWidth()', () => {
  it('pads short content and truncates long content by display columns', () => {
    expect(fitToWidth('ab', 5)).toBe('ab   ')
    expect(fitToWidth('abcdef', 3)).toBe('abc')
    // Two ideographs fill four of five columns and the third cannot be halved,
    // so the shortfall is padded rather than left to shift a border.
    expect(fitToWidth('标准模式', 5)).toBe('标准 ')
    expect(displayWidth(fitToWidth('标准模式', 5))).toBe(5)
  })
})

describe('spinnerFrame()', () => {
  it('turns through four quarter arcs, holding them for 2, 1, 2 and 1 ticks', () => {
    // Exactly the six-glyph spinner's timing with its two half circles removed:
    // every quarter lands on the tick it always did, and the tick a half circle
    // filled keeps the quarter before it.
    expect(Array.from({ length: 6 }, (_, tick) => spinnerFrame(tick)))
      .toEqual(['◜', '◜', '◝', '◞', '◞', '◟'])
  })

  it('draws no half circle on any tick', () => {
    for (let tick = 0; tick < 60; tick += 1) expect(['◠', '◡']).not.toContain(spinnerFrame(tick))
  })

  it('completes a revolution every six ticks, about 600 ms', () => {
    expect(6 * SPINNER_INTERVAL_MS).toBe(600)
    for (let tick = 0; tick < 6; tick += 1) {
      expect(spinnerFrame(tick + 6)).toBe(spinnerFrame(tick))
      expect(spinnerFrame(tick + 600)).toBe(spinnerFrame(tick))
    }
  })

  it('clamps a negative tick to the first frame', () => {
    expect(spinnerFrame(-5)).toBe(spinnerFrame(0))
  })

  it('keeps every frame one column wide and free of ANSI', () => {
    for (let tick = 0; tick < 6; tick += 1) {
      const spinner = spinnerFrame(tick)
      expect(displayWidth(spinner)).toBe(1)
      expect(stripAnsi(spinner)).toBe(spinner)
      expect(spinner).not.toContain('\u001b')
    }
  })
})

describe('formatElapsed()', () => {
  it('reads as seconds under a minute and minutes above', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(4200)).toBe('4s')
    expect(formatElapsed(64_000)).toBe('1m 04s')
    expect(formatElapsed(-1)).toBe('0s')
  })
})

describe('formatTokens()', () => {
  it('compacts thousands and millions', () => {
    expect(formatTokens(840)).toBe('840')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(128_000)).toBe('128k')
    expect(formatTokens(1_500_000)).toBe('1.5M')
  })
})
