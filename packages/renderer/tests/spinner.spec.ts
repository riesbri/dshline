/**
 * The two activity forms: the turning arc, in one cell and in two, and the
 * glint that crosses a word.
 *
 * Most claims here are about what does NOT change as much as what does — the
 * width, the characters, the boundaries between characters, and the styling
 * left open afterwards — so most tests walk a whole cycle and hold every frame
 * to the same invariant, and the emulator checks the cells a person sees.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  codePointWidth,
  displayWidth,
  GLINT_PERIOD_TICKS,
  MARKDOWN_ROLES,
  paint,
  paintGlint,
  Screen,
  setPalette,
  SPINNER_INTERVAL_MS,
  SPINNER_MARK_COLUMNS,
  spinnerFrame,
  spinnerFrameOrbit,
  spinnerMark,
  stripAnsi,
  truncateToWidth,
} from '../src/index.ts'
import { GLINT_BAND_COLUMNS, glintBand, SPINNER_REVOLUTION_TICKS } from '../src/spinner.ts'
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

/** One revolution of each presentation, as literal frames rather than a property. */
const COMPACT_CYCLE = ['\u25dc', '\u25dc', '\u25dd', '\u25de', '\u25de', '\u25df']
const ORBIT_CYCLE = ['\u25dc ', ' \u25e0', ' \u25dd', ' \u25de', '\u25e1 ', '\u25df ']

describe('spinnerFrame()', () => {
  it('turns through the compact arc, held for 2, 1, 2 and 1 ticks', () => {
    expect(Array.from({ length: SPINNER_REVOLUTION_TICKS }, (_u, tick) => spinnerFrame(tick))).toEqual(COMPACT_CYCLE)
    expect(new Set(COMPACT_CYCLE).size).toBe(4)
  })

  it('gives the compact mark exactly one column on EVERY frame', () => {
    for (let tick = 0; tick < SPINNER_REVOLUTION_TICKS; tick += 1) {
      expect(displayWidth(spinnerFrame(tick)), `compact @${String(tick)}`).toBe(1)
    }
  })
})

describe('spinnerFrameOrbit()', () => {
  it('walks the six original shapes in order, one glyph a tick, one cell a time', () => {
    // The original six-shape vocabulary, restored: upper-left, top, upper-right,
    // lower-right, bottom, lower-left — one step clockwise round the circle.
    expect(Array.from({ length: SPINNER_REVOLUTION_TICKS }, (_u, tick) => spinnerFrameOrbit(tick)))
      .toEqual(ORBIT_CYCLE)
    // One frame per tick, with nothing held: the irregular 2, 1, 2, 1 hold
    // existed only to make four arcs fill six ticks.
    expect(new Set(ORBIT_CYCLE).size).toBe(SPINNER_REVOLUTION_TICKS)
  })

  it('moves the glyph between the two cells rather than pairing two of them', () => {
    // The rule the whole table exists for: a frame is ONE glyph and ONE space.
    // Two glyphs in a frame is the paired form that read as a terminal drawing
    // a combination instead of one mark with presence.
    for (let tick = 0; tick < SPINNER_REVOLUTION_TICKS; tick += 1) {
      const frame = spinnerFrameOrbit(tick)
      expect(frame.trim(), `orbit @${String(tick)}`).toHaveLength(1)
      expect([...frame].filter(char => char !== ' '), `orbit @${String(tick)}`).toHaveLength(1)
    }
  })

  it('gives every frame exactly two columns, glyph and space together', () => {
    // The width contract, per frame: a frame that measured differently would
    // move every column to its right, and a `/work` row body would jump.
    for (let tick = 0; tick < SPINNER_REVOLUTION_TICKS * 2; tick += 1) {
      expect(displayWidth(spinnerFrameOrbit(tick)), `orbit @${String(tick)}`).toBe(SPINNER_MARK_COLUMNS)
    }
    expect(SPINNER_MARK_COLUMNS).toBe(2)
  })

  it('spends three of its six steps in each cell, so the box is crossed evenly', () => {
    // Read off the shapes: the mark is on the right of the circle for the top,
    // upper-right and lower-right steps, and on the left for the other three.
    const left = ORBIT_CYCLE.filter(frame => !frame.startsWith(' ')).length
    expect(left).toBe(3)
    // And the cells come in one run each, so the mark crosses the box once per
    // half turn instead of vibrating between the cells on every tick.
    const sides = ORBIT_CYCLE.map(frame => (frame.startsWith(' ') ? 'r' : 'l')).join('')
    expect([...new Set(sides.match(/.{1,3}/gu) ?? [])]).toHaveLength(2)
  })

  it('revolves in 600 ms on the caller\u2019s 100 ms heartbeat, with no duplicated frame', () => {
    expect(SPINNER_INTERVAL_MS).toBe(100)
    expect(SPINNER_REVOLUTION_TICKS * SPINNER_INTERVAL_MS).toBe(600)
    // Six frames, six ticks: nothing held, nothing skipped.
    for (let tick = 1; tick < SPINNER_REVOLUTION_TICKS; tick += 1) {
      expect(spinnerFrameOrbit(tick), `orbit @${String(tick)}`).not.toBe(spinnerFrameOrbit(tick - 1))
    }
  })

  it('uses the original six-shape vocabulary, and no glyph outside it', () => {
    const vocabulary = new Set(ORBIT_CYCLE.map(frame => frame.trim()))
    expect(vocabulary).toEqual(new Set(['\u25dc', '\u25e0', '\u25dd', '\u25de', '\u25e1', '\u25df']))
    for (let tick = 0; tick < SPINNER_REVOLUTION_TICKS; tick += 1) {
      expect(vocabulary.has(spinnerFrameOrbit(tick).trim())).toBe(true)
    }
  })

  it('draws every orbit glyph in one cell that no terminal widens', () => {
    // The quadrant arcs and both half circles are East Asian NEUTRAL, so a
    // terminal in ambiguous-width mode still advances one cell and the
    // two-column contract never depends on a terminal setting. `\u25cf` and
    // `\u25d0` are the ambiguous ones this table deliberately avoids.
    for (const glyph of ORBIT_CYCLE.map(frame => frame.trim())) {
      expect(codePointWidth(glyph.codePointAt(0) ?? 0), glyph).toBe(1)
    }
  })

  it('repeats every cycle, and clamps negative ticks to the first frame', () => {
    for (let tick = 0; tick < SPINNER_REVOLUTION_TICKS; tick += 1) {
      expect(spinnerFrameOrbit(tick + SPINNER_REVOLUTION_TICKS)).toBe(spinnerFrameOrbit(tick))
    }
    expect(spinnerFrameOrbit(-1)).toBe(spinnerFrameOrbit(0))
    expect(spinnerFrameOrbit(-7)).toBe(spinnerFrameOrbit(0))
  })
})

describe('spinnerMark()', () => {
  it('pads a settling mark to the orbit\u2019s box, so a row body never moves', () => {
    // The whole point of a stable gutter: a worker finishing must not push its
    // own text a column right.
    for (const mark of ['\u25cf', '\u2022', '\u25d0', '\u2713', '\u2717', '\u2298']) {
      const padded = spinnerMark(mark)
      expect(displayWidth(padded), mark).toBe(SPINNER_MARK_COLUMNS)
      expect(padded.startsWith(mark), mark).toBe(true)
      expect(padded, mark).toBe(spinnerFrameOrbit(0).replace('\u25dc', mark))
    }
  })
})

describe('glintBand()', () => {
  it('crosses an eight-column word left to right, three columns wide, then rests briefly', () => {
    // The root line's only liveness signal, so the pause is a pause and not a
    // silence: ten of sixteen ticks are lit, and the band widens to three
    // columns before narrowing again, which is what makes it read as light
    // entering the word and leaving it.
    expect(frames(8)).toEqual([
      '\u2588\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7',
      '\u2588\u2588\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7',
      '\u2588\u2588\u2588\u00b7\u00b7\u00b7\u00b7\u00b7',
      '\u00b7\u2588\u2588\u2588\u00b7\u00b7\u00b7\u00b7',
      '\u00b7\u00b7\u2588\u2588\u2588\u00b7\u00b7\u00b7',
      '\u00b7\u00b7\u00b7\u2588\u2588\u2588\u00b7\u00b7',
      '\u00b7\u00b7\u00b7\u00b7\u2588\u2588\u2588\u00b7',
      '\u00b7\u00b7\u00b7\u00b7\u00b7\u2588\u2588\u2588',
      '\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u2588\u2588',
      '\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u2588',
      ...Array.from({ length: 6 }, () => '\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7'),
    ])
    // Over three fifths of the cycle is lit, against well under half for
    // the 2.4 s version this replaced.
    const lit = Array.from({ length: GLINT_PERIOD_TICKS }, (_u, tick) => glintBand(8, tick) !== undefined)
      .filter(Boolean).length
    expect(lit / GLINT_PERIOD_TICKS).toBeGreaterThan(0.6)
  })

  it('keeps the minimum rest for text longer than the cycle could cross one column a tick', () => {
    // 30 columns would need 34 ticks at one column a tick, so the pass is
    // compressed rather than allowed to eat the rest entirely.
    const lit = frames(30).map(row => row.includes('█'))
    const rest = lit.length - lit.lastIndexOf(true) - 1
    expect(rest).toBeGreaterThanOrEqual(2)
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
    // Six, and not the two the rest floor asks for: the band's last step leaves
    // it wholly past the right edge, so the word is already whole again on a
    // tick that is still part of the sweep.
    expect(resting.length).toBe(6)
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
