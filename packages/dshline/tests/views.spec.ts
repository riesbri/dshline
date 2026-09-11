import { describe, expect, it } from 'vitest'
import { Composer, displayWidth, Screen, stripAnsi } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import type { ComposerHint, StatusState } from '../src/views.ts'
import { composerGutter, composerHintRow, composerInner, createComposerView, createStatusView } from '../src/views.ts'

/** A terminal width whose inner content area is a round number of columns. */
const COLUMNS = 40

/** Content rows plus two borders: the ceiling the composer draws within. */
const COMPOSER_FRAME_ROWS = 12

/** Every glyph the frame is drawn from, none of which may sit under the cursor. */
const BORDER_GLYPHS = ['\u256d', '\u256e', '\u2570', '\u256f', '\u2502', '\u2500']

/**
 * A composer holding `text`, with the cursor left where typing it would leave it.
 * @param text - the content to type, newlines included.
 * @returns the composer.
 */
function typed(text: string): Composer {
  const composer = new Composer()
  composer.handle({ kind: 'paste', text })
  return composer
}

/**
 * Where the terminal actually puts its cursor after drawing the composer.
 *
 * Asserted through an emulator rather than against the returned LiveCursor,
 * because the placement is only correct if it agrees with the rows that were
 * drawn — and those are two separate calculations that can disagree.
 * @param composer - the composer to draw.
 * @param columns - the terminal width.
 * @returns the cursor position and the visible rows.
 */
async function drawn(composer: Composer, columns = COLUMNS, hint?: ComposerHint): Promise<{
  cursor: { column: number; row: number }
  rows: string[]
}> {
  const emulator = createEmulator(columns, 24)
  const screen = new Screen(emulator.target)
  const view = hint === undefined
    ? createComposerView(composer, '/w/repo')
    : createComposerView(composer, '/w/repo', () => 1, () => hint)
  const lines = view.render(columns)
  screen.setLive(lines, view.cursor?.(columns))
  // Rows are NOT filtered: an index into this array is a terminal row, which is
  // what the cursor's row is measured in.
  return { cursor: await emulator.cursor(), rows: (await emulator.screen()).map(row => row.trimEnd()) }
}

/**
 * The character the terminal would overwrite if the next keystroke were typed.
 * @param composer - the composer being drawn.
 * @param at - where the terminal put its cursor.
 * @param columns - the terminal width to draw at.
 * @returns the cell's character, or a space for an empty cell.
 */
async function cellUnder(
  composer: Composer,
  at: { column: number; row: number },
  columns = COLUMNS,
): Promise<string> {
  const emulator = createEmulator(columns, 24)
  const screen = new Screen(emulator.target)
  const view = createComposerView(composer, '/w/repo')
  screen.setLive(view.render(columns), view.cursor?.(columns))
  const cell = await emulator.cell(at.column, at.row)
  return cell?.chars === '' ? ' ' : cell?.chars ?? ' '
}

describe('the composer view', () => {
  it('puts the cursor after the text that was typed', async () => {
    const { cursor, rows } = await drawn(typed('hello'))
    const row = rows.find(line => line.includes('hello')) ?? ''
    expect(row.indexOf('hello') + 'hello'.length).toBe(cursor.column)
  })

  it('places the cursor correctly on a line that spans several rows', async () => {
    const composer = typed('aaaa bbbb cccc dddd eeee ffff gggg hhhh')
    const { cursor, rows } = await drawn(composer)
    const lastRow = rows.filter(row => row.includes('hhhh')).at(-1) ?? ''
    expect(lastRow.indexOf('hhhh') + 'hhhh'.length).toBe(cursor.column)
  })

  it('agrees with the drawn rows when a word would move under word wrapping', async () => {
    // The case a prefix-based calculation gets wrong under word wrapping: appending
    // to a word pulls the WHOLE word onto the next row, moving a break that is
    // before the cursor, so a prefix laid out alone disagrees with the same prefix
    // inside the finished line. Chunking is prefix-consistent, which is why the
    // composer chunks.
    //
    // Only visible at a width where the line actually spans rows, which is why the
    // narrow columns are the point of this case.
    for (const columns of [16, 20, 24]) {
      for (const text of ['aaaa bbbbbbbbb', 'aa bbbbbbbbbb', 'a bbbbbbbbbbbb', 'aa bb cc dddddddddddd']) {
        for (const back of [0, 1, 3]) {
          const composer = typed(text)
          for (let index = 0; index < back; index += 1) composer.handle({ kind: 'key', name: 'left' })
          const { cursor } = await drawn(composer, columns)
          // The cell under the cursor is the character the next keystroke overwrites,
          // which is the one at the cursor's offset in the buffer.
          const cell = await cellUnder(composer, cursor, columns)
          const label = `${String(columns)} columns, ${JSON.stringify(text)}, back ${String(back)}`
          expect(cell, label).toBe(text[text.length - back] ?? ' ')
        }
      }
    }
  })

  it('places the cursor on the second row of a two-line buffer', async () => {
    const composer = typed('first\nsecond')
    const { cursor, rows } = await drawn(composer)
    const row = rows.findIndex(line => line.includes('second'))
    expect(cursor.row).toBe(row)
    expect((rows[row] ?? '').indexOf('second') + 'second'.length).toBe(cursor.column)
  })

  it('keeps the cursor inside the frame, never on its border', async () => {
    // A prefix that exactly fills its row leaves the cursor one column past the
    // last content cell, which is exactly where the right-hand border is drawn. The
    // inner width at 40 columns is 36 and the prompt takes 2, so 34 characters is
    // the exact fill and the sweep straddles it.
    //
    // Asserted on the CELL under the cursor rather than on its column, because the
    // screen does not clamp a column and a number can look plausible while landing
    // on the frame.
    for (const length of [32, 33, 34, 35, 36, 68, 69, 70, 71, 72]) {
      const composer = typed('x'.repeat(length))
      const emulator = createEmulator(COLUMNS, 24)
      const screen = new Screen(emulator.target)
      const view = createComposerView(composer, '/w/repo')
      screen.setLive(view.render(COLUMNS), view.cursor?.(COLUMNS))
      const at = await emulator.cursor()
      const rows = (await emulator.screen()).map(row => row.trimEnd())
      const frame = displayWidth(rows[1] ?? '')
      // Content occupies the columns between the border and its padding, so the
      // cursor belongs in [2, frame - 3]. Anything outside is on the padding or the
      // border, which is what a missing roll-over produces.
      expect(at.column, `${String(length)} characters`).toBeGreaterThanOrEqual(2)
      expect(at.column, `${String(length)} characters`).toBeLessThanOrEqual(frame - 3)
      // Not on ANY part of the frame: a cursor clamped onto the bottom border sits
      // on a horizontal rule rather than a vertical one, so checking one glyph is
      // not enough.
      const cell = await emulator.cell(at.column, at.row)
      expect(BORDER_GLYPHS, `${String(length)} characters on ${JSON.stringify(cell?.chars)}`)
        .not.toContain(cell?.chars ?? '')
    }
  })
})

describe('a composer taller than the terminal', () => {
  it('draws no more rows than it can redraw', async () => {
    // The live region is redrawn by climbing rows, so rows that scrolled off cannot
    // be reached or erased: an uncapped composer left duplicate rows in scrollback
    // and could clear unrelated output. Pasting twenty short lines is enough.
    const composer = typed(Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n'))
    const { rows } = await drawn(composer)
    expect(rows.filter(row => row !== '')).toHaveLength(COMPOSER_FRAME_ROWS)
  })

  it('scrolls to keep the cursor visible, and says how much is hidden', async () => {
    const composer = typed(Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n'))
    const { cursor, rows } = await drawn(composer)
    // The cursor is at the end, so the end is what is shown, and the title names
    // the DIRECTION of what is hidden rather than a bare count: a reader can tell
    // they are at the bottom and that `↑` reaches the rest.
    expect(rows.join('\n')).toContain('line 39')
    expect(rows.join('\n')).not.toContain('line 0 ')
    expect(rows[1]).toContain('↑ 30')
    expect(rows[1]).not.toContain('↓')
    expect(cursor.row).toBeGreaterThan(0)
    expect(cursor.row).toBeLessThan(rows.length)
  })

  it('does not serve a stale layout after the draft is edited', async () => {
    // The view memoizes one layout between render() and cursor(). A `set()` that
    // changes the text while leaving the cursor at the SAME offset is the case a
    // key that forgot the text would get wrong: the cursor offset alone would not
    // invalidate the entry, so the next frame would draw the previous draft.
    const composer = typed('short')
    const view = createComposerView(composer, '/w/repo')
    expect(stripAnsi(view.render(40, 24).join('\n'))).toContain('short')
    composer.set('other')
    expect(composer.position).toBe(5)
    const after = stripAnsi(view.render(40, 24).join('\n'))
    expect(after).toContain('other')
    expect(after).not.toContain('short')
  })

  it('does not serve a stale layout after the width changes', async () => {
    // The cursor offset is identical at both widths, so only the width key can
    // invalidate the entry. At 12 columns the 26-character draft wraps to seven
    // rows and the cursor lands on row 5 at drawn column 6; the wide layout's own
    // placement (row 2, column 30) is what a memo that ignored the width returns,
    // and column 30 is not even a cell the narrow frame has.
    const composer = typed('abcdefghijklmnopqrstuvwxyz')
    const view = createComposerView(composer, '/w/repo')
    view.render(40, 24)
    const narrow = view.render(12, 24)
    expect(narrow.filter(row => row !== '')).toHaveLength(6)
    expect(view.cursor?.(12, 24)).toEqual({ row: 5, column: 6 })
  })

  it('reports the cursor relative to the visible window', async () => {
    const composer = typed(Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n'))
    const { cursor, rows } = await drawn(composer)
    const onCursorRow = stripAnsi(rows[cursor.row] ?? '')
    expect(onCursorRow).toContain('line 39')
  })

  it('shows the whole buffer while it still fits', async () => {
    const composer = typed('one\ntwo\nthree')
    const { rows } = await drawn(composer)
    expect(rows.join('\n')).toContain('one')
    expect(rows.join('\n')).toContain('three')
    // Nothing is hidden, so there is no direction to report.
    expect(rows[1]).not.toContain('↑')
    expect(rows[1]).not.toContain('↓')
  })
})

describe("the empty composer's hint", () => {
  /**
   * The hint as a person reads it, without escapes.
   * @param hint - what the composer should say about right now.
   * @param columns - the terminal width.
   * @returns the visible row, prompt included.
   */
  const hint = (hint: ComposerHint, columns = 120): string =>
    stripAnsi(composerHintRow(hint, Math.max(8, composerInner(columns))))

  const idle: ComposerHint = { busy: false, busyEnter: 'queue' }

  it('teaches the two things an idle composer can answer', () => {
    // Can I type here, and how do I find everything else. `menu` rather than
    // `commands` because that surface carries local commands, the agent's own,
    // and user-invocable skills — and a skill is not a command.
    expect(hint(idle)).toBe('\u203a ask anything \u00b7 / menu')
  })

  it('says what ordinary typing currently means while a turn runs', () => {
    expect(hint({ busy: true, busyEnter: 'queue' })).toBe('\u203a type to queue')
    expect(hint({ busy: true, busyEnter: 'steer' })).toBe('\u203a type to steer')
  })

  it('keeps staged image truth while optional help sheds around it', () => {
    const staged: ComposerHint = { busy: false, busyEnter: 'queue', images: 2 }
    expect(hint(staged)).toBe('\u203a 2 images \u00b7 ask anything \u00b7 / menu')
    expect(hint(staged, 35)).toBe('\u203a 2 images \u00b7 ask anything')
    expect(hint(staged, 20)).toBe('\u203a 2 images')
    expect(hint(staged, 14)).toBe('\u203a ')
    expect(hint({ busy: true, busyEnter: 'steer', images: 1 })).toBe('\u203a 1 image \u00b7 type to steer')
  })

  it('advertises no key it cannot be sure the terminal sends', () => {
    // `ctrl-enter` is decodable only under an enhanced encoding and is
    // byte-identical to enter everywhere else, with nothing to probe. Naming it
    // here would tell most readers to press a key that quietly does the other
    // thing, so `/enter` and the docs teach it instead.
    for (const busyEnter of ['queue', 'steer'] as const) {
      expect(hint({ busy: true, busyEnter })).not.toContain('ctrl')
    }
    expect(hint(idle)).not.toContain('ctrl')
  })

  it('sheds whole segments, and never half of one', () => {
    // The idle ladder, at the widths either side of each rung. `ask anything`
    // is the field's identity and outlives the affordance beside it.
    expect(hint(idle, 28)).toBe('\u203a ask anything \u00b7 / menu')
    expect(hint(idle, 27)).toBe('\u203a ask anything')
    expect(hint(idle, 19)).toBe('\u203a ask anything')
    expect(hint(idle, 18)).toBe('\u203a ')
    // And the busy ladder, which has one segment and therefore one step.
    expect(hint({ busy: true, busyEnter: 'queue' }, 20)).toBe('\u203a type to queue')
    expect(hint({ busy: true, busyEnter: 'queue' }, 19)).toBe('\u203a ')
  })

  it('renders one of its rungs exactly, at every width', () => {
    // The failure this ladder exists to prevent: `\u203a ask anything \u00b7 / me` reads as
    // a rendering fault rather than as help, exactly as `ctrl-d qui` does on the
    // status line. Asserted as an exact match against the whole ladder rather
    // than by hunting for prefixes, because any partial segment produces a row
    // that is on nobody's list.
    const ladders = [
      { state: idle, rungs: ['\u203a ask anything \u00b7 / menu', '\u203a ask anything', '\u203a '] },
      { state: { busy: true, busyEnter: 'steer' } as const, rungs: ['\u203a type to steer', '\u203a '] },
      { state: { busy: true, busyEnter: 'queue' } as const, rungs: ['\u203a type to queue', '\u203a '] },
      {
        state: { busy: false, busyEnter: 'queue', images: 2 } as const,
        rungs: ['\u203a 2 images \u00b7 ask anything \u00b7 / menu', '\u203a 2 images \u00b7 ask anything', '\u203a 2 images', '\u203a '],
      },
    ]
    for (const { state, rungs } of ladders) {
      for (let columns = 1; columns <= 130; columns += 1) {
        expect(rungs, `${String(columns)} columns`).toContain(hint(state, columns))
      }
    }
  })

  it('descends its rungs monotonically, so no width skips to a richer one', () => {
    // Widening never takes something away and narrowing never adds something:
    // the ladder is ordered, and a reader resizing a pane sees segments leave in
    // one direction only.
    let seen = 0
    for (let columns = 1; columns <= 130; columns += 1) {
      const width = displayWidth(hint(idle, columns))
      expect(width, `${String(columns)} columns`).toBeGreaterThanOrEqual(seen)
      seen = width
    }
  })

  it('keeps the prompt at every width, because it is the affordance', () => {
    for (let columns = 1; columns <= 130; columns += 1) {
      expect(hint(idle, columns).startsWith('\u203a'), `${String(columns)} columns`).toBe(true)
    }
  })

  it('is one row at every width, whatever it says', () => {
    // The regression that matters. This text used to be fitted with
    // `chunkToWidth`, which WRAPS — below nineteen columns the empty composer
    // drew a fifth row, and the empty branch is the one view in the live region
    // that spends none of its own budget, so on a short terminal that pushed the
    // region past the screen where rows can no longer be erased.
    for (const state of [idle, { busy: true, busyEnter: 'steer' } as const]) {
      for (let columns = 1; columns <= 130; columns += 1) {
        // The narrow live-region fallback does not render a hint or frame; keep
        // this standalone hint test's framed minimum independent of its width.
        const inner = Math.max(8, composerInner(columns))
        expect(
          composerHintRow(state, inner).split('\n'),
          `${String(columns)} columns`,
        ).toHaveLength(1)
        expect(
          displayWidth(composerHintRow(state, inner)),
          `${String(columns)} columns`,
        ).toBeLessThanOrEqual(inner)
      }
    }
  })

  it('draws the same four terminal rows however narrow the terminal gets', async () => {
    // Through a real emulator, because three separate wrap passes run over this
    // string — the ladder, the frame's inner width, and the screen's own — and
    // only the terminal reports how many physical rows the reader ends up with.
    for (const columns of [12, 14, 18, 19, 20, 27, 28, 40, 80]) {
      const { rows } = await drawn(new Composer(), columns, idle)
      const drawnRows = rows.filter(row => row !== '')
      expect(drawnRows, `${String(columns)} columns`).toHaveLength(3)
      for (const row of drawnRows) {
        expect(displayWidth(row), `${String(columns)} columns`).toBeLessThanOrEqual(columns)
      }
    }
  })

  it('puts the cursor just past the prompt at every rung, never on the frame', async () => {
    for (const columns of [12, 18, 19, 27, 28, 80]) {
      const { cursor } = await drawn(new Composer(), columns, idle)
      const cell = await cellUnder(new Composer(), cursor, columns)
      expect(BORDER_GLYPHS, `${String(columns)} columns`).not.toContain(cell)
    }
  })

  it('reflects the preference the moment it changes, with no redraw of its own', async () => {
    // Read per paint rather than captured, so `/enter` needs to do nothing but
    // move the pref: the next frame already says the other word.
    let busyEnter: 'queue' | 'steer' = 'queue'
    const composer = new Composer()
    const view = createComposerView(composer, '/w/repo', () => 1, () => ({ busy: true, busyEnter }))
    expect(stripAnsi(view.render(120).join('\n'))).toContain('type to queue')
    busyEnter = 'steer'
    expect(stripAnsi(view.render(120).join('\n'))).toContain('type to steer')
  })

  it('is presentation only: it is not the buffer, and it cannot be submitted', () => {
    // Structural, not incidental. The branch that draws it is gated on
    // `isEmpty`, writes nothing into the buffer, and an empty buffer never
    // reaches a submit at all.
    const composer = new Composer()
    const view = createComposerView(composer, '/w/repo', () => 1, () => ({ busy: false, busyEnter: 'queue' }))
    expect(stripAnsi(view.render(120).join('\n'))).toContain('ask anything')
    expect(composer.value).toBe('')
    expect(composer.isEmpty).toBe(true)
    expect(composer.handle({ kind: 'key', name: 'enter' })).toStrictEqual({
      kind: 'ignored',
      key: { kind: 'key', name: 'enter' },
    })
    // Nor is it in the undo history: there was no edit to walk back through.
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('')
  })

  it('is gone the moment one character is typed', async () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'a' })
    const { rows } = await drawn(composer, 80, { busy: false, busyEnter: 'queue' })
    const body = rows.join('\n')
    expect(body).not.toContain('ask anything')
    expect(body).not.toContain('/ menu')
    expect(body).toContain('a')
  })

  it('is gone while busy too, so no hint sits beside real text', async () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'x' })
    const { rows } = await drawn(composer, 80, { busy: true, busyEnter: 'steer' })
    expect(rows.join('\n')).not.toContain('type to steer')
  })
})

describe('the status line', () => {
  /**
   * Render the status line and strip its styling.
   * @param overrides - values to override on the default state.
   * @param columns - the terminal width.
   * @returns the line a person would see.
   */
  function status(overrides: Partial<StatusState> = {}, columns = 120): string {
    const view = createStatusView(() => ({
      busy: false,
      tick: 0,
      elapsedMs: undefined,
      activityWord: 'waiting',
      activity: undefined,
      model: 'deepseek-v4-flash',
      effort: undefined,
      usage: undefined,
      cacheRead: undefined,
      tokens: undefined,
      contextWindow: undefined,
      detail: 'compact',
      work: undefined,
      pending: undefined,
      todo: undefined,
      plan: false,
      replay: undefined,
      goal: undefined,
      ...overrides,
    }))
    return stripAnsi(view.render(columns)[0] ?? '')
  }

  it('draws a bar beside the reading', () => {
    expect(status({ tokens: 6_200, contextWindow: 8_000 })).toContain('\u2588\u2588\u2588\u2588\u2588\u2588\u258f\u2591 6.2k/8.0k')
  })

  it('draws a visible bar on a million-token window, where whole cells could not', () => {
    // The failure this replaces: in whole cells the first one fills at 12.5%, so on
    // a DeepSeek window the bar stayed invisible through every session anyone really
    // has — 45k is 4.5%, which was no cells at all. A feature nobody ever sees is
    // indistinguishable from one that is broken, so the bar resolves in eighths.
    expect(status({ tokens: 45_000, contextWindow: 1_000_000 })).toContain('\u258e\u2591\u2591\u2591\u2591\u2591\u2591\u2591')
    expect(status({ tokens: 45_000, contextWindow: 1_000_000 })).toContain('45k/1.0M')
  })

  it('rounds any use at all up to the first visible mark', () => {
    // 0.1% of the window is a fortieth of one eighth. Rounding it down would draw an
    // empty bar while the window is in use, which is the case this exists to avoid.
    expect(status({ tokens: 1_000, contextWindow: 1_000_000 })).toContain('\u258f\u2591\u2591\u2591\u2591\u2591\u2591\u2591')
  })

  it('draws nothing before the first token, when there is nothing to see', () => {
    expect(status({ tokens: 0, contextWindow: 1_000_000 })).not.toContain('\u2591')
    expect(status({ tokens: 0, contextWindow: 1_000_000 })).toContain('0/1.0M')
  })

  it('fills whole cells as the window fills', () => {
    expect(status({ tokens: 125_000, contextWindow: 1_000_000 })).toContain('\u2588\u2591\u2591\u2591\u2591\u2591\u2591\u2591')
    expect(status({ tokens: 500_000, contextWindow: 1_000_000 })).toContain('\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591')
  })

  it('floors the fill rather than rounding it', () => {
    // A bar reading full at 94% overstates the one thing it exists to report.
    expect(status({ tokens: 940_000, contextWindow: 1_000_000 })).toContain('\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u258c')
    expect(status({ tokens: 1_000_000, contextWindow: 1_000_000 })).toContain('\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588')
  })

  it('draws no bar when the window is unknown', () => {
    expect(status({ tokens: 45_000 })).toContain('45k')
    expect(status({ tokens: 45_000 })).not.toContain('\u2591')
  })

  it('gives up the bar before the reading when the width runs out', () => {
    // The bar is a picture of the numbers beside it, so it is the only part whose
    // loss costs no information. The reading is never given up, and never cut.
    const wide = status({ tokens: 14_000, contextWindow: 1_000_000 }, 76)
    expect(wide).toContain('\u258f\u2591\u2591\u2591\u2591\u2591\u2591\u2591')
    expect(wide).toContain('deepseek-v4-flash')

    const narrow = status({ tokens: 14_000, contextWindow: 1_000_000 }, 64)
    expect(narrow).not.toContain('\u2591')
    expect(narrow).toContain('deepseek-v4-flash')
    expect(narrow).toContain('14k/1.0M')

    const narrowest = status({ tokens: 14_000, contextWindow: 1_000_000 }, 24)
    expect(narrowest).not.toContain('\u2591')
    expect(narrowest).not.toContain('deepseek-v4-flash')
    expect(narrowest).toContain('14k/1.0M')
  })

  it('never exceeds the terminal, at any width', () => {
    for (const columns of [20, 30, 40, 60, 80, 96, 120, 200]) {
      const line = status({ tokens: 130_000, contextWindow: 1_000_000 }, columns)
      expect(line.length, `${String(columns)} columns`).toBeLessThanOrEqual(columns)
    }
  })

  it('drops a hint whole rather than cutting one in half', () => {
    // Truncating the joined line produced `ctrl-d qui`, which reads as a rendering
    // fault rather than as a hint.
    const hints = ['alt-enter newline', 'ctrl-d quit']
    for (const columns of [20, 30, 40, 60, 80, 96, 120]) {
      const line = status({ tokens: 130_000, contextWindow: 1_000_000 }, columns)
      // The last segment is where a cut would land, and it must be a whole hint or
      // not a hint at all — never the beginning of one.
      const last = line.split(' · ').at(-1) ?? ''
      const partial = hints.find(hint => hint.startsWith(last) && hint !== last)
      expect(partial, `${String(columns)} columns ended on ${JSON.stringify(last)}`).toBeUndefined()
    }
  })

  it('keeps the pressure reading on a narrow terminal by dropping the model', () => {
    // The model does not change during a session; the reading does.
    const narrow = status({ tokens: 130_000, contextWindow: 1_000_000 }, 30)
    expect(narrow).toContain('130k/1.0M')
    expect(narrow).not.toContain('deepseek-v4-flash')
  })

  it('reports usage between the model and the pressure reading', () => {
    const line = status({ usage: '\u21918.8k \u21931.6k $0.018', tokens: 14_000, contextWindow: 1_000_000 })
    expect(line).toContain('\u21918.8k \u21931.6k $0.018')
    expect(line.indexOf('deepseek-v4-flash')).toBeLessThan(line.indexOf('\u21918.8k'))
    expect(line.indexOf('\u21918.8k')).toBeLessThan(line.indexOf('14k/1.0M'))
  })

  it('gives up the bar, then the model, then usage \u2014 and never the reading', () => {
    // The order is the same argument the model/reading pair already settles,
    // carried one step further: the bar is a picture of numbers printed beside
    // it, the model does not change during a session, and usage is an accounting
    // of the whole session where the reading governs whether it still works.
    const usage = '\u21918.8k \u21931.6k $0.018'
    const wide = status({ usage, tokens: 14_000, contextWindow: 1_000_000 }, 96)
    expect(wide).toContain('\u2591')
    expect(wide).toContain('deepseek-v4-flash')
    expect(wide).toContain(usage)

    const noBar = status({ usage, tokens: 14_000, contextWindow: 1_000_000 }, 88)
    expect(noBar).not.toContain('\u2591')
    expect(noBar).toContain('deepseek-v4-flash')
    expect(noBar).toContain(usage)

    const noModel = status({ usage, tokens: 14_000, contextWindow: 1_000_000 }, 76)
    expect(noModel).not.toContain('deepseek-v4-flash')
    expect(noModel).toContain(usage)
    expect(noModel).toContain('14k/1.0M')

    const noUsage = status({ usage, tokens: 14_000, contextWindow: 1_000_000 }, 44)
    expect(noUsage).not.toContain('\u21918.8k')
    expect(noUsage).toContain('14k/1.0M')
  })

  it('reports the cache-read share beside the totals, and gives it up before the bar', () => {
    // Convenience information: how much of the prompt came from cache says
    // nothing about whether the session is working or what it has spent — what a
    // cache read costs is a route's own pricing question — so it is the first
    // segment the body surrenders, before even the picture of the reading, which
    // is the cheapest loss among the facts.
    const state = {
      usage: '\u2191130k \u219312.4k $1.24',
      cacheRead: 'CR 99.8%',
      tokens: 130_000,
      contextWindow: 1_000_000,
    }
    const wide = status(state, 110)
    expect(wide).toContain('CR 99.8%')
    expect(wide.indexOf('$1.24')).toBeLessThan(wide.indexOf('CR 99.8%'))
    expect(wide.indexOf('CR 99.8%')).toBeLessThan(wide.indexOf('130k/1.0M'))

    const shed = status(state, 100)
    expect(shed).not.toContain('CR')
    // Everything it was given up for is still there, the bar included.
    expect(shed).toContain('\u2591')
    expect(shed).toContain('deepseek-v4-flash')
    expect(shed).toContain('$1.24')
    expect(shed).toContain('130k/1.0M')
  })

  it('gives up the cache-read share before what a turn is doing', () => {
    const busy = {
      busy: true,
      elapsedMs: 866_000,
      activityWord: 'running' as const,
      activity: { title: 'run_shell_command', others: 2 },
      usage: '\u2191130k \u219312.4k $1.24',
      cacheRead: 'CR 99.8%',
      tokens: 130_000,
      contextWindow: 1_000_000,
    }
    const roomy = status(busy, 160)
    expect(roomy).toContain('run_shell_command +2 calls')
    expect(roomy).toContain('CR 99.8%')

    const tighter = status(busy, 140)
    expect(tighter).toContain('run_shell_command +2 calls')
    expect(tighter).not.toContain('CR')
  })

  it('never leaves half a cache-read share on the line, in any of its forms', () => {
    // `CR 99` is not a smaller truth than `CR 99.8%`, it is a different one —
    // the same rule the modes and the pressure reading follow. The bounded forms
    // are the ones a cut would mangle worst: `CR >99` would read as a value.
    for (const cacheRead of ['CR 99.8%', 'CR >99.9%', 'CR <0.1%', 'CR 100%']) {
      for (const columns of [20, 30, 40, 50, 60, 70, 80, 88, 96, 100, 104, 110, 120, 140, 160]) {
        const line = status({
          usage: '\u2191130k \u219312.4k $1.24',
          cacheRead,
          tokens: 130_000,
          contextWindow: 1_000_000,
        }, columns)
        const whole = line.includes(cacheRead)
        expect(
          line.includes('CR') ? whole : true,
          `${cacheRead} at ${String(columns)} columns: ${JSON.stringify(line)}`,
        ).toBe(true)
        expect(line.length, `${String(columns)} columns`).toBeLessThanOrEqual(columns)
      }
    }
  })

  it('keeps the documented order once the cache-read share is reported too', () => {
    // The existing ladder, unchanged, with one more segment above it: bar, then
    // the model, then the totals, and never the reading.
    const state = {
      usage: '\u2191130k \u219312.4k $1.24',
      cacheRead: 'CR 99.8%',
      tokens: 130_000,
      contextWindow: 1_000_000,
    }
    const noBar = status(state, 88)
    expect(noBar).not.toContain('\u2591')
    expect(noBar).toContain('deepseek-v4-flash')
    expect(noBar).toContain('$1.24')

    const noModel = status(state, 76)
    expect(noModel).not.toContain('deepseek-v4-flash')
    expect(noModel).toContain('$1.24')
    expect(noModel).toContain('130k/1.0M')

    const noUsage = status(state, 44)
    expect(noUsage).not.toContain('\u2191130k')
    expect(noUsage).toContain('130k/1.0M')
  })

  it('never exceeds the terminal with the cache-read share reported too', () => {
    for (const columns of [20, 30, 40, 44, 60, 62, 80, 96, 100, 104, 110, 120, 160, 200]) {
      const line = status({
        usage: '\u2191130k \u219312.4k $1.24',
        cacheRead: 'CR 99.8%',
        tokens: 130_000,
        contextWindow: 1_000_000,
      }, columns)
      expect(line.length, `${String(columns)} columns`).toBeLessThanOrEqual(columns)
    }
  })

  it('never exceeds the terminal once usage is reported too', () => {
    for (const columns of [20, 30, 40, 44, 60, 62, 80, 96, 120, 200]) {
      const line = status(
        { usage: '\u2191130k \u219312.4k $1.24', tokens: 130_000, contextWindow: 1_000_000 },
        columns,
      )
      expect(line.length, `${String(columns)} columns`).toBeLessThanOrEqual(columns)
    }
  })

  it('never spends the last hint on a richer reading', () => {
    // The hints are the only place this interface says how to leave it. At eighty
    // columns — the width most terminals open at — a reading rich enough to fill
    // the line left room for no help at all, so the rung is chosen with room for
    // one hint already held back.
    const hints = ['alt-enter newline', 'ctrl-d quit']
    for (const columns of [60, 70, 80, 90, 100, 120]) {
      const line = status(
        { usage: '\u2191130k \u219312.4k $1.24', tokens: 130_000, contextWindow: 1_000_000 },
        columns,
      )
      expect(hints.some(hint => line.includes(hint)), `${String(columns)} columns: ${line}`).toBe(true)
    }
  })

  it('keeps stop and quit controls, however rich the reading', () => {
    const line = status({
      busy: true,
      elapsedMs: 42_800,
      usage: '\u2191130k \u219312.4k $1.24',
      tokens: 130_000,
      contextWindow: 1_000_000,
    }, 120)
    expect(line).toContain('ctrl-c stop')
    expect(line).toContain('ctrl-d quit')
    expect(line).not.toContain('ctrl-o output')
  })

  it('names a reasoning level beside the model, and drops it with the model', () => {
    // The level qualifies the model's name. Left behind after the name it applied
    // to was dropped, it would read as belonging to whatever came next.
    expect(status({ effort: 'max' })).toContain('deepseek-v4-flash (max)')
    const narrow = status({ effort: 'max', tokens: 130_000, contextWindow: 1_000_000 }, 30)
    expect(narrow).not.toContain('(max)')
  })

  it('stays quiet about the reasoning level when none is set', () => {
    expect(status()).toContain('deepseek-v4-flash')
    expect(status()).not.toContain('(')
  })

  it('says when plan mode is in force, and stays quiet otherwise', () => {
    // A session quietly refusing to edit files looks exactly like one that will,
    // and the command that set it has long scrolled away.
    expect(status({ plan: true })).toContain('plan')
    expect(status()).not.toContain('plan')
  })

  it('says when a goal is taking rounds on its own', () => {
    expect(status({ goal: { label: 'goal 3/256', running: true } })).toContain('goal 3/256')
    expect(status()).not.toContain('goal')
  })

  it('keeps both modes at a width where the model and the totals are given up', () => {
    // Neither is dropped for width: what a turn will DO outranks what it costs
    // and which model it is on, and both are absent in the ordinary case anyway.
    const line = status({
      plan: true,
      goal: { label: 'goal 3/256', running: true },
      usage: '\u2191130k \u219312.4k $1.24',
      tokens: 130_000,
      contextWindow: 1_000_000,
    }, 44)
    expect(line).toContain('plan')
    expect(line).toContain('goal 3/256')
    expect(line).toContain('130k/1.0M')
    expect(line).not.toContain('deepseek-v4-flash')
  })

  it('keeps a running goal in preference to a hint', () => {
    // The hint reservation exists so a richer READING cannot crowd out help. It
    // must not outrank what the session is about to do on its own.
    const line = status({ goal: { label: 'goal 12/256', running: true }, tokens: 14_000 }, 40)
    expect(line).toContain('goal 12/256')
    expect(line).not.toContain('alt-enter')
  })

  it('gives up a mode whole rather than cutting one, at every width', () => {
    // `goal 12/25` is not a smaller truth than `goal 12/256`, it is a different
    // one — the same reason a hint is dropped rather than shortened.
    for (const columns of [20, 24, 30, 36, 40, 44, 50, 60, 70, 80, 100]) {
      const line = status({
        plan: true,
        goal: { label: 'goal 12/256', running: true },
        usage: '\u2191130k \u219312.4k $1.24',
        tokens: 130_000,
        contextWindow: 1_000_000,
      }, columns)
      const cut = /goal (?!12\/256)\S*$|pla$|pl$|p$/u.test(line)
      expect(cut, `${String(columns)} columns ended on ${JSON.stringify(line)}`).toBe(false)
    }
  })

  it('keeps the goal state visible without putting its objective in the footer', () => {
    const state = {
      plan: true,
      goal: { label: 'goal 3/256', running: true },
      tokens: 130_000,
      contextWindow: 1_000_000,
    }
    for (const columns of [52, 80, 100, 120]) {
      const line = status(state, columns)
      expect(line).toContain('goal 3/256')
      expect(line).not.toContain('ship the release')
    }
  })

  it('names the tool a long turn is waiting on', () => {
    // `working 14m 26s` alone reads the same whether a command is running or the
    // session has hung.
    const busy = status({ busy: true, elapsedMs: 866_000, activityWord: 'running', activity: { title: 'run_shell_command', others: 0 } })
    expect(busy).toContain('running')
    expect(busy).toContain('run_shell_command')
    // Its own segment, not glued to the timer: the elapsed time is the TURN's,
    // and the harness publishes no duration for one call.
    expect(busy).toContain('running · turn 14m 26s \u00b7 run_shell_command')
    // Idle has nothing outstanding to name, whatever the last call was.
    expect(status({ activity: { title: 'run_shell_command', others: 0 } })).not.toContain('run_shell_command')
    // And it is the first fact given up: a convenience reading, like todo and work.
    const narrow = status({
      busy: true,
      elapsedMs: 866_000,
      activityWord: 'running',
      activity: { title: 'run_shell_command', others: 0 },
      tokens: 130_000,
      contextWindow: 1_000_000,
    }, 50)
    expect(narrow).not.toContain('run_shell_command')
    expect(narrow).toContain('130k/1.0M')
  })

  it('counts the tools running in parallel beside the one it names', () => {
    // The harness dispatches concurrency-safe calls together. `grep` alone would
    // report one tool running where three are.
    expect(status({ busy: true, elapsedMs: 4_000, activity: { title: 'grep', others: 2 } }))
      .toContain('grep +2 calls')
    expect(status({ busy: true, elapsedMs: 4_000, activity: { title: 'grep', others: 1 } }))
      .toContain('grep +1 call')
    // One call is the common case and carries no count at all.
    expect(status({ busy: true, elapsedMs: 4_000, activity: { title: 'grep', others: 0 } }))
      .not.toContain('grep +')
  })

  it('shows an escape sequence in a tool name instead of obeying it', () => {
    // A tool name comes from the harness registry, which a plugin writes.
    expect(status({ busy: true, elapsedMs: 4_000, activity: { title: 'evil\u001b[2Jtool', others: 2 } }))
      .toContain('evil^[[2Jtool +2 calls')
  })

  it('drops a display preference before a mode that changes behaviour', () => {
    // At 56 columns all three fit; at 50 the display preference is the one that
    // goes, and both behaviour modes stay.
    const state = {
      plan: true,
      goal: { label: 'goal 12/256', running: true },
      detail: 'full' as const,
      tokens: 130_000,
      contextWindow: 1_000_000,
    }
    expect(status(state, 56)).toContain('tools full')
    const line = status(state, 50)
    expect(line).toContain('plan')
    expect(line).toContain('goal 12/256')
    expect(line).not.toContain('tools full')
  })

  it('never exceeds the terminal with every mode reporting at once', () => {
    for (const columns of [20, 30, 40, 60, 80, 96, 120, 200]) {
      const line = status({
        plan: true,
        goal: { label: 'goal 128/256 idle', running: false },
        detail: 'full',
        effort: 'max',
        usage: '\u2191130k \u219312.4k $1.24',
        tokens: 130_000,
        contextWindow: 1_000_000,
      }, columns)
      expect(line.length, `${String(columns)} columns`).toBeLessThanOrEqual(columns)
    }
  })

  it('says a turn is running, and offers stop and quit', () => {
    const busy = status({ busy: true, elapsedMs: 4_000 })
    expect(busy).toContain('waiting')
    expect(busy).toContain('ctrl-c stop')
    expect(busy).toContain('ctrl-d quit')
  })

  it('keeps the turn elapsed labeled, so a specific word cannot read as its own duration', () => {
    const busy = status({ busy: true, elapsedMs: 866_000, activityWord: 'reading' })
    expect(busy).toContain('reading · turn 14m 26s')
    // The number is the TURN's, never the tool's: the label is what stops
    // `reading 14m 26s` from reading as a fourteen-minute read.
    expect(busy).toContain('· turn 14m 26s')
    expect(busy).not.toContain('reading 14m')
  })

  it('separates the spinner from the word with exactly two ordinary ASCII spaces', () => {
    const busy = status({ busy: true, elapsedMs: 4_000, activityWord: 'thinking' })
    expect(busy).toMatch(/◜ {2}thinking/u)
    expect(busy).not.toMatch(/◜ {1,2}·/u)
    // A thin, non-breaking, or other wide space would not match the ASCII pair.
    expect(busy).not.toContain('\u2009')
    expect(busy).not.toContain('\u00a0')
  })

  it.each([
    ['waiting', 'waiting'],
    ['thinking', 'thinking'],
    ['responding', 'responding'],
    ['reading', 'reading'],
    ['searching', 'searching'],
    ['fetching', 'fetching'],
    ['editing', 'editing'],
    ['running', 'running'],
    ['working', 'working'],
  ] as const)('renders the %s activity word whole', (word) => {
    // At this width the busiest word fits beside the elapsed, so the whole word
    // appears and the base is not truncated.
    expect(status({ busy: true, elapsedMs: 4_000, activityWord: word }, 40)).toContain(word)
    expect(status({ busy: true, elapsedMs: 4_000, activityWord: word }, 40)).not.toContain('…')
  })

  it('does not advertise tool inspection in the status footer', () => {
    const busy = status({ busy: true, elapsedMs: 4_000 })
    const idle = status()
    expect(busy).not.toContain('ctrl-o output')
    expect(idle).not.toContain('ctrl-o output')
    expect(idle).toContain('ctrl-d quit')
  })

  it('names optional generic work without creating another status row', () => {
    expect(status({ work: '2 subagents · 1 job' })).toContain('2 subagents · 1 job')
    expect(status()).not.toContain('subagents')
  })

  it('drops Todo before Work and behavior-changing modes, without cutting it', () => {
    const state = {
      todo: 'todo 2/5',
      work: '2 subagents · 1 job',
      plan: true,
      goal: { label: 'goal 12/256', running: true },
      tokens: 130_000,
      contextWindow: 1_000_000,
    }
    expect(status(state, 100)).toContain('todo 2/5')
    const line = status(state, 68)
    expect(line).not.toContain('todo 2/5')
    expect(line).toContain('2 subagents · 1 job')
    expect(line).toContain('plan')
    expect(line).toContain('goal 12/256')
    for (const columns of [20, 30, 40, 50, 60, 80]) {
      const rendered = status(state, columns)
      expect(rendered.includes('todo 2') && !rendered.includes('todo 2/5')).toBe(false)
      expect(displayWidth(rendered)).toBeLessThanOrEqual(columns)
    }
  })

  it('drops optional work before a mode that changes behavior', () => {
    const state = {
      work: '2 subagents · 1 job',
      plan: true,
      goal: { label: 'goal 12/256', running: true },
      tokens: 130_000,
      contextWindow: 1_000_000,
    }
    const line = status(state, 50)
    expect(line).toContain('plan')
    expect(line).toContain('goal 12/256')
    expect(line).not.toContain('2 subagents · 1 job')
  })

  it('drops the optional work summary whole on narrow terminals', () => {
    for (const columns of [20, 30, 40, 60, 80, 120]) {
      const line = status({
        work: '2 subagents · 1 job',
        plan: true,
        goal: { label: 'goal 12/256', running: true },
        tokens: 130_000,
        contextWindow: 1_000_000,
      }, columns)
      expect(displayWidth(line), `${String(columns)} columns`).toBeLessThanOrEqual(columns)
      expect(line.includes('2 subagents') && !line.includes('2 subagents · 1 job')).toBe(false)
      expect(line.includes('1 job') && !line.includes('2 subagents · 1 job')).toBe(false)
    }
  })

  it('names the list pending input is parked on, and reports nothing once it is taken', () => {
    // One segment, three words. Which one is true depends on which of Harness's
    // two boundary lists the reader's input is sitting on, and a mixture is
    // neither — see the ladder in views.ts for why that is one word and not two
    // segments.
    expect(status({ pending: { queued: 2, steering: 0 } })).toContain('2 queued')
    expect(status({ pending: { queued: 0, steering: 2 } })).toContain('2 steering')
    expect(status({ pending: { queued: 1, steering: 1 } })).toContain('2 pending')
    // Zero and absent mean the same thing on this segment: the agent has taken
    // everything, and a permanent `0 queued` would spend columns saying so.
    expect(status({ pending: { queued: 0, steering: 0 } })).not.toContain('queued')
    expect(status({})).not.toContain('queued')
    expect(status({})).not.toContain('pending')
  })

  it('keeps the pending count longer than older observations, and never cuts it', () => {
    const state = { pending: { queued: 2, steering: 0 }, todo: 'todo 2/5', work: '1 job' }
    // Rungs are monotone in width — once the line has descended past a
    // segment's rung, widening back never brings it mid-sweep — so sweeping
    // DOWN from a wide terminal, the first width at which a segment is already
    // gone is exactly where its surrender began.
    const firstWidelyAbsent = (needle: string): number | undefined => {
      for (let columns = 120; columns >= 4; columns -= 1) {
        if (!status(state, columns).includes(needle)) return columns
      }
      return undefined
    }
    const todo = firstWidelyAbsent('todo 2/5')
    const work = firstWidelyAbsent('1 job')
    const queued = firstWidelyAbsent('2 queued')
    // The queued count exists because of what the reader just did, so it
    // outlives todo and work when width runs out.
    expect(todo).toBeDefined()
    expect(work).toBeDefined()
    expect(queued).toBeDefined()
    expect(queued ?? 201).toBeLessThanOrEqual(work ?? 201)
    expect(work ?? 201).toBeLessThanOrEqual(todo ?? 201)
    // And it yields to behavior-changing modes like every observation does:
    // somewhere in the sweep there is a width that has already given the count
    // up while still holding plan and a running goal.
    const crowded = { ...state, plan: true, goal: { label: 'goal 12/256', running: true } }
    const yieldsToModes = (() => {
      for (let columns = 24; columns <= 200; columns += 1) {
        const line = status(crowded, columns)
        if (!line.includes('queued') && line.includes('plan') && line.includes('goal 12/256')) return true
      }
      return false
    })()
    expect(yieldsToModes).toBe(true)
    // Dropped whole at every width, never truncated mid-segment.
    for (let columns = 24; columns <= 120; columns += 2) {
      const line = status(state, columns)
      expect(line.includes('queued') && !line.includes('2 queued')).toBe(false)
      expect(displayWidth(line)).toBeLessThanOrEqual(columns)
    }
  })

  it('names a non-default card level and stays quiet about the default', () => {
    expect(status({ detail: 'full' })).toContain('tools full')
    expect(status({ detail: 'hidden' })).toContain('tools hidden')
    expect(status()).not.toContain('tools')
  })

  it('reports an in-flight compaction instead of ready', () => {
    const line = status({ compacting: true })
    expect(line).toContain('compacting')
    expect(line).not.toContain('ready')
  })

  it('lets a running turn outrank the compaction reading', () => {
    // Compaction runs while the agent is idle; if the agent is busy too, the
    // turn's activity is the more urgent fact and the spinner already speaks.
    const line = status({ busy: true, elapsedMs: 4_000, activityWord: 'thinking', compacting: true })
    expect(line).toContain('thinking')
    expect(line).not.toContain('compacting')
  })

  it('keeps the compaction word on a narrow line, like any other bare word', () => {
    const line = status({ compacting: true }, 16)
    expect(line).toContain('compacting')
    expect(displayWidth(line)).toBeLessThanOrEqual(16)
  })
})

describe('the composer viewport follows the cursor both ways', () => {
  it('scrolls the window upward as the cursor climbs', async () => {
    const composer = typed(Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n'))
    const view = createComposerView(composer, '/w/repo')
    const top = () => view.render(40, 24).join('\n')
    expect(top()).toContain('line 39')
    // Climb most of the way up; the window must show earlier lines, not stay put.
    for (let i = 0; i < 35; i += 1) composer.moveUp(composerInner(40), (line: number) => composerGutter(line, 40))
    const after = top()
    expect(after).toContain('line 4')
    expect(after).not.toContain('line 39')
    // And the cursor's own row is inside the drawn window.
    const placement = view.cursor?.(40, 24)
    expect(placement?.row).toBeGreaterThan(0)
    expect(placement?.row).toBeLessThan(view.render(40, 24).length)
  })
})

describe('a very large pasted prompt', () => {
  it('stays a bounded viewport and keeps the cursor on the drawn text', async () => {
    // The pathological case this change is about: thousands of lines pasted at
    // once. The live region must stay capped, and the cursor must still land on
    // the character a person sees.
    const composer = typed(Array.from({ length: 3000 }, (_, i) => `pasted line ${String(i)}`).join('\n'))
    const emulator = createEmulator(COLUMNS, 24)
    const screen = new Screen(emulator.target)
    const view = createComposerView(composer, '/w/repo')
    const rows = view.render(COLUMNS, 24)
    const placement = view.cursor?.(COLUMNS, 24)
    expect(rows.filter(row => row !== '')).toHaveLength(COMPOSER_FRAME_ROWS)
    expect(rows.join('\n')).toContain('pasted line 2999')
    const cell = await emulator.cell(placement?.column ?? 0, placement?.row ?? 0)
    screen.setLive(rows, placement)
    expect(screen.height).toBeLessThanOrEqual(24)
    // The cursor sits on the line it would overwrite next, which is the end of
    // the buffer — a cell that is part of the final line's text region.
    expect(stripAnsi(rows[placement?.row ?? 0] ?? '')).toContain('pasted line 2999')
    expect(cell).toBeDefined()
  })
})
