/**
 * The glint: a band of emphasis that crosses a word, then rests.
 *
 * Its claims are about what does NOT change as much as what does — the
 * characters, the width, the boundaries between characters, and the styling
 * left open afterwards — so most of these walk a whole cycle and hold every
 * frame to the same invariant, and the emulator checks the cells a person sees.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  displayWidth,
  GLINT_PERIOD_TICKS,
  MARKDOWN_ROLES,
  paint,
  paintGlint,
  Screen,
  setPalette,
  stripAnsi,
  truncateToWidth,
} from '../src/index.ts'
import { GLINT_BAND_COLUMNS, glintBand } from '../src/spinner.ts'
import { splitAtColumns } from '../src/width.ts'
import { createEmulator } from '../../../tests/emulator.ts'

/** SGR palette indices the fixture paints with, as the emulator reports them. */
const BASE_FG = 3
const LIT_FG = 11

let restore: (() => void) | undefined

/**
 * Install a palette where the two roles the glint is called with differ in
 * both colour and weight, so each cell says which one it was painted in. The
 * renderer's own roles stand in for a frontend's `busy` and its lit role.
 */
function install(): void {
  restore = setPalette({
    id: 'glint',
    name: 'Glint',
    description: 'Fixture: base amber, lit bright amber',
    depth: 4,
    roles: { ...MARKDOWN_ROLES, muted: { ansi: [33] }, strong: { ansi: [1, 93] } },
  }, 4)
}

afterEach(() => {
  restore?.()
  restore = undefined
})

/** The glint as a frontend calls it, with the fixture's two roles. */
const glint = (text: string, tick: number): string => paintGlint(text, tick, 'muted', 'strong')

/** Draw the lit columns of one cycle as `█`, for a reviewable frame table. */
function frames(width: number): string[] {
  return Array.from({ length: GLINT_PERIOD_TICKS }, (_, tick) => {
    const band = glintBand(width, tick)
    return Array.from({ length: width }, (_unused, column) =>
      band !== undefined && column >= band.from && column < band.to ? '█' : '·').join('')
  })
}

/**
 * Text that exercises every way a character can be more than one code unit
 * or one column. Each is a case the boundary rule has to respect.
 */
const UNICODE = {
  ascii: 'thinking',
  cjk: '思考中',
  combining: 'édition',
  zwj: '\u{1f469}‍\u{1f4bb} build',
  flags: '\u{1f1ea}\u{1f1f8}\u{1f1eb}\u{1f1f7} flags',
  selector: '✔️ ok',
  zeroWidth: 'a​b',
  supplementary: '\u{1d400}\u{1d401}\u{1d402}',
  mixed: '读 reading 文件',
} as const

describe('glintBand()', () => {
  it('crosses an eight-column word left to right, three columns wide, then rests', () => {
    expect(frames(8)).toEqual([
      '█·······',
      '██······',
      '███·····',
      '·███····',
      '··███···',
      '···███··',
      '····███·',
      '·····███',
      '······██',
      '·······█',
      ...Array.from({ length: 14 }, () => '········'),
    ])
  })

  it('keeps the minimum rest for text longer than the cycle could cross one column a tick', () => {
    // 30 columns would need 33 ticks at one column a tick; the pass is
    // compressed rather than allowed to eat the rest.
    const lit = frames(30).map(row => row.includes('█'))
    const rest = lit.length - lit.lastIndexOf(true) - 1
    expect(rest).toBeGreaterThanOrEqual(8)
    // And the band still visits every column on the way across.
    const visited = new Set<number>()
    for (let tick = 0; tick < GLINT_PERIOD_TICKS; tick += 1) {
      const band = glintBand(30, tick)
      for (let column = band?.from ?? 0; column < (band?.to ?? 0); column += 1) visited.add(column)
    }
    expect(visited.size).toBe(30)
  })

  it('never lights more than the band, and lights a one-column text', () => {
    for (let tick = 0; tick < GLINT_PERIOD_TICKS; tick += 1) {
      const band = glintBand(8, tick)
      if (band !== undefined) expect(band.to - band.from).toBeLessThanOrEqual(GLINT_BAND_COLUMNS)
    }
    expect(frames(1).filter(row => row === '█').length).toBeGreaterThan(0)
  })

  it('repeats every cycle, clamps negative ticks, and has nothing to light in nothing', () => {
    for (let tick = 0; tick < GLINT_PERIOD_TICKS; tick += 1) {
      expect(glintBand(8, tick + GLINT_PERIOD_TICKS)).toEqual(glintBand(8, tick))
    }
    expect(glintBand(8, -7)).toEqual(glintBand(8, 0))
    expect(glintBand(0, 0)).toBeUndefined()
  })
})

describe('splitAtColumns()', () => {
  it('splits ASCII exactly at the columns asked for', () => {
    expect(splitAtColumns('thinking', 2, 5)).toEqual(['th', 'ink', 'ing'])
    expect(splitAtColumns('thinking', 0, 3)).toEqual(['', 'thi', 'nking'])
    expect(splitAtColumns('thinking', 6, 8)).toEqual(['thinki', 'ng', ''])
  })

  it('takes a wide character whole when the range touches either of its cells', () => {
    // Columns 1–3 touch both halves of 考 and the first half of 中.
    expect(splitAtColumns('思考中', 3, 4)).toEqual(['思', '考', '中'])
    expect(splitAtColumns('思考中', 1, 3)).toEqual(['', '思考', '中'])
  })

  it('keeps zero-width characters with the character they belong to', () => {
    expect(splitAtColumns(UNICODE.combining, 0, 1)).toEqual(['', 'é', 'dition'])
    expect(splitAtColumns(UNICODE.selector, 0, 1)).toEqual(['', '✔️', ' ok'])
  })

  it('never separates a ZWJ sequence or the two halves of a flag', () => {
    // The renderer measures 👩‍💻 as its two emoji, four columns; asking for the
    // second one alone still takes the sequence whole.
    expect(splitAtColumns(UNICODE.zwj, 2, 4)).toEqual(['', '\u{1f469}‍\u{1f4bb}', ' build'])
    // Each regional indicator is one column; column 1 is the second half of 🇪🇸
    // and column 2 the first half of 🇫🇷.
    expect(splitAtColumns(UNICODE.flags, 1, 3)).toEqual(['', '\u{1f1ea}\u{1f1f8}\u{1f1eb}\u{1f1f7}', ' flags'])
    expect(splitAtColumns(UNICODE.flags, 2, 4)).toEqual(['\u{1f1ea}\u{1f1f8}', '\u{1f1eb}\u{1f1f7}', ' flags'])
  })

  it('never splits a surrogate pair', () => {
    expect(splitAtColumns(UNICODE.supplementary, 1, 2)).toEqual(['\u{1d400}', '\u{1d401}', '\u{1d402}'])
  })

  it('reads only as far as the end of the range', () => {
    // The tail is an unterminated escape, which a full scan would have to walk
    // to the end of the string to measure. A bounded scan never reaches it.
    const tail = `\u001b[${'1;'.repeat(50_000)}`
    const [before, inside, after] = splitAtColumns(`thinking${tail}`, 0, 3)
    expect([before, inside]).toEqual(['', 'thi'])
    expect(after.startsWith('nking')).toBe(true)
  })
})

describe('paintGlint()', () => {
  it('changes only styling: every frame holds the same characters at the same width', () => {
    install()
    for (const [name, text] of Object.entries(UNICODE)) {
      for (let tick = 0; tick < GLINT_PERIOD_TICKS; tick += 1) {
        const out = glint(text, tick)
        expect(stripAnsi(out), `${name} @${String(tick)}`).toBe(text)
        expect(displayWidth(out), `${name} @${String(tick)}`).toBe(displayWidth(text))
      }
    }
  })

  it('paints each span on its own and closes every one with the full reset', () => {
    install()
    for (let tick = 0; tick < GLINT_PERIOD_TICKS; tick += 1) {
      const out = glint('thinking', tick)
      expect(out.endsWith('\u001b[0m')).toBe(true)
      // Never nested: each opener is followed by its own closer before the next.
      expect(out).toMatch(/^(?:\u001b\[[0-9;]+m[^\u001b]+\u001b\[0m){1,3}$/u)
    }
  })

  it('draws exactly the base role at rest', () => {
    install()
    const resting = Array.from({ length: GLINT_PERIOD_TICKS }, (_, tick) => glint('thinking', tick))
      .filter(frame => frame === paint('thinking', 'muted'))
    expect(resting.length).toBe(14)
  })

  it('paints already-styled text whole instead of splitting its escapes', () => {
    install()
    const styled = paint('think', 'code')
    for (let tick = 0; tick < GLINT_PERIOD_TICKS; tick += 1) {
      expect(glint(styled, tick)).toBe(paint(styled, 'muted'))
    }
  })

  it('returns the text untouched with no colour to paint in', () => {
    restore = setPalette({ id: 'none', name: 'None', description: '', depth: 4, roles: MARKDOWN_ROLES }, 0)
    for (let tick = 0; tick < GLINT_PERIOD_TICKS; tick += 1) expect(glint('thinking', tick)).toBe('thinking')
  })

  it('survives a cut at every width on every frame without leaving styling open', () => {
    install()
    for (let tick = 0; tick < GLINT_PERIOD_TICKS; tick += 1) {
      for (let columns = 0; columns <= 9; columns += 1) {
        const cut = truncateToWidth(glint('thinking', tick), columns)
        expect(displayWidth(cut)).toBe(Math.min(columns, 8))
        expect(stripAnsi(cut)).toBe('thinking'.slice(0, columns))
        if (cut !== '') expect(cut.endsWith('\u001b[0m')).toBe(true)
      }
    }
  })

  it('costs a bounded handful of microseconds a frame', () => {
    install()
    // A regression guard, not a benchmark: it catches a scan gone quadratic or
    // an allocation per character, which would be orders of magnitude off.
    const started = performance.now()
    for (let tick = 0; tick < 20_000; tick += 1) glint(UNICODE.mixed, tick)
    expect((performance.now() - started) / 20_000).toBeLessThan(0.1)
  })
})

describe('paintGlint() on a terminal', () => {
  it('lights whole cells, Latin and wide alike, and leaks nothing past the text', async () => {
    install()
    for (const text of ['thinking', UNICODE.cjk, UNICODE.mixed]) {
      const width = displayWidth(text)
      const emulator = createEmulator(40)
      const screen = new Screen(emulator.target)
      for (let tick = 0; tick < GLINT_PERIOD_TICKS; tick += 1) {
        screen.setLive([`${glint(text, tick)}|`])
        // The visible characters never move: the bar after the text stays put.
        const bar = await emulator.cell(width, 0)
        expect(bar?.chars, `${text} @${String(tick)}`).toBe('|')
        expect(bar?.fg, `${text} @${String(tick)}`).toBeUndefined()
        expect(bar?.bold).toBe(false)
        const band = glintBand(width, tick)
        for (let column = 0; column < width; column += 1) {
          const cell = await emulator.cell(column, 0)
          // A wide character's second cell carries the same attributes as the
          // first, so both halves are checked the same way.
          const lit = band !== undefined && column >= band.from && column < band.to
          if (lit) {
            expect(cell?.fg, `${text} @${String(tick)} col ${String(column)}`).toBe(LIT_FG)
            expect(cell?.bold).toBe(true)
          } else if (band === undefined) {
            expect(cell?.fg, `${text} @${String(tick)} col ${String(column)}`).toBe(BASE_FG)
          }
        }
      }
      emulator.dispose()
    }
  })
})
