/**
 * The root live region below the shared chrome floor.
 *
 * `chromeWidth` never draws a frame narrower than `CHROME_MIN_COLUMNS`, so at a
 * terminal below that floor a framed row is wider than the terminal itself.
 * `Screen` re-wraps that AFTER the live region has already been budgeted in
 * logical rows, which is exactly what invalidates the budget. These tests prove
 * the presentation fallback keeps every logical row inside the real terminal at
 * pathological widths, while leaving ordinary widths untouched.
 */

import { Context } from '@deepseek-ai/cordis'
import { Composer, displayWidth, Screen, stripAnsi } from '@dshline/renderer'
import { describe, expect, it } from 'vitest'
import { createEmulator } from '../../../tests/emulator.ts'
import { createCompletion } from '../src/completion.ts'
import { CHROME_MIN_COLUMNS } from '../src/chrome.ts'
import { InputHistory } from '../src/history.ts'
import { routeInputKey } from '../src/input.ts'
import { TuiSlots } from '../src/slots.ts'
import type { StatusState } from '../src/views.ts'
import { composerGutter, composerInner, createComposerView, createStatusView } from '../src/views.ts'

const ROWS = 24

/** A busy, richly-populated status, which is the widest thing this view ever draws. */
const BUSY: StatusState = {
  busy: true,
  tick: 0,
  elapsedMs: 4_000,
  activityWord: 'thinking',
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
}

/**
 * A composer holding `text`, cursor at the end, as typing it would leave it.
 * @param text - the content to type.
 * @returns the composer.
 */
function typed(text: string): Composer {
  const composer = new Composer()
  composer.handle({ kind: 'paste', text })
  return composer
}

/**
 * Compose the root live region — composer and status together, the runner's
 * own registration order — and draw it through a real `Screen` and terminal.
 * @param composer - the composer to draw.
 * @param columns - the terminal width.
 * @returns the visible rows and where the terminal actually left the cursor.
 */
async function drawnRoot(composer: Composer, columns: number): Promise<{
  rows: string[]
  cursor: { column: number; row: number }
}> {
  const slots = new TuiSlots(new Context())
  slots.register('composer', createComposerView(composer, '/work/repo'))
  slots.register('status', createStatusView(() => BUSY))
  const composed = slots.compose(columns, ROWS)
  const emulator = createEmulator(columns, ROWS)
  const screen = new Screen(emulator.target)
  screen.setLive(composed.lines, composed.cursor)
  return { rows: (await emulator.screen()).map(row => row.trimEnd()), cursor: await emulator.cursor() }
}

describe('the root live region below the chrome floor', () => {
  it('never emits a logical row wider than the terminal, at every width below the floor', () => {
    // The fundamental invariant: cheap enough (no terminal, no emulator) to
    // prove exhaustively rather than sample. Both an empty and a populated
    // composer, since the two take different code paths through the view.
    for (let columns = 1; columns < CHROME_MIN_COLUMNS; columns += 1) {
      for (const composer of [new Composer(), typed('hello world')]) {
        const slots = new TuiSlots(new Context())
        slots.register('composer', createComposerView(composer, '/work/repo'))
        slots.register('status', createStatusView(() => BUSY))
        const { lines } = slots.compose(columns, ROWS)
        for (const line of lines) {
          expect(displayWidth(line), `${String(columns)} columns: ${JSON.stringify(line)}`)
            .toBeLessThanOrEqual(columns)
        }
      }
    }
  })

  it('stays editable with the cursor immediately after typed text, below six columns', async () => {
    // No exact-fill roll-over at this width and length: `› ab` is four display
    // columns inside a five-column budget, so the cursor stays on the same row
    // as the text rather than moving to the fresh row a filled one gets.
    const { rows, cursor } = await drawnRoot(typed('ab'), 5)
    const row = rows[cursor.row] ?? ''
    expect(row).toContain('ab')
    expect(cursor.column).toBeLessThanOrEqual(5)
    expect(row.slice(0, cursor.column).endsWith('ab')).toBe(true)
  })

  it('stays editable with the cursor immediately after typed text, in the eight-to-eleven range', async () => {
    for (const columns of [8, 9, 11]) {
      const { rows, cursor } = await drawnRoot(typed('hello'), columns)
      const row = rows[cursor.row] ?? ''
      expect(cursor.column).toBeLessThanOrEqual(columns)
      expect(row.slice(0, cursor.column).endsWith('hello')).toBe(true)
    }
  })

  it('keeps a valid cursor at the narrowest possible terminal, one column wide', async () => {
    // `› ` cannot fit at all here, and neither can the exact-fill prompt glyph
    // alongside a typed character, so this is the case that forces the
    // roll-to-a-fresh-row behaviour every row in this view has to honour.
    const { rows, cursor } = await drawnRoot(typed('x'), 1)
    expect(displayWidth(rows[cursor.row] ?? ''), 'row under the cursor').toBeLessThanOrEqual(1)
    // The character just typed is the row above the fresh cursor row.
    const above = rows[cursor.row - 1] ?? ''
    expect(above).toContain('x')
    expect(cursor.column).toBe(0)
  })

  it('keeps the empty composer editable with a valid cursor down to one column', async () => {
    for (const columns of [1, 3, 5, 8, 11]) {
      const { rows, cursor } = await drawnRoot(new Composer(), columns)
      expect(cursor.row).toBeGreaterThanOrEqual(0)
      expect(cursor.column).toBeLessThanOrEqual(columns)
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(columns)
    }
  })

  it('uses the unframed width and gutter for narrow vertical movement', async () => {
    const columns = 5
    const composer = typed('abcdefghij')
    const completion = createCompletion(composer, {
      commands: () => [],
      commandArguments: async () => [],
      paths: async () => [],
    }, () => {})
    const history = new InputHistory()

    expect(routeInputKey(
      { kind: 'key', name: 'up' },
      composer,
      completion,
      history,
      { width: composerInner(columns), gutter: line => composerGutter(line, columns) },
    )).toBe('vertical')
    const { rows, cursor } = await drawnRoot(composer, columns)
    expect(rows[cursor.row]).toContain('defgh')
    expect((rows[cursor.row] ?? '').slice(0, cursor.column)).toBe('de')
  })

  it("the status view cannot independently exceed the terminal's width, and may surrender entirely", () => {
    for (const columns of [1, 2, 3, 5, 8, 11]) {
      const lines = createStatusView(() => BUSY).render(columns)
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
    }
    // At the narrowest widths there is no room even for the indent, so the
    // status line gives up entirely rather than drawing a fragment.
    expect(createStatusView(() => BUSY).render(1)).toEqual([])
    expect(createStatusView(() => BUSY).render(2)).toEqual([])
  })
})

describe('the root live region at and above the chrome floor', () => {
  it(`keeps the normal framed chrome at width ${String(CHROME_MIN_COLUMNS)} and ordinary widths`, () => {
    // At the floor itself the label is already tight enough to truncate — that
    // is unchanged pre-existing behaviour, not this fix — so only the frame's
    // presence is asserted there; the full label is asserted where it fits.
    for (const columns of [CHROME_MIN_COLUMNS, 20, 40, 80]) {
      const lines = createComposerView(new Composer(), '/work/repo').render(columns)
      expect(lines.some(line => stripAnsi(line).includes('╭')), `${String(columns)} columns`).toBe(true)
    }
    for (const columns of [20, 40, 80]) {
      const lines = createComposerView(new Composer(), '/work/repo').render(columns)
      expect(stripAnsi(lines.join('\n')), `${String(columns)} columns`).toContain('dshline')
    }
  })

  it(`keeps the status line's ordinary budget unchanged at width ${String(CHROME_MIN_COLUMNS)} and above`, () => {
    // The old floor was `Math.max(10, columns - 2)`; at these widths
    // `columns - 2` already reaches 10 or more, so the fix changes nothing here.
    // At the floor itself the word is already tight enough to truncate — that
    // is unchanged pre-existing behaviour — so the full word is asserted only
    // where it comfortably fits.
    for (const columns of [CHROME_MIN_COLUMNS, 20, 40, 80]) {
      const line = createStatusView(() => BUSY).render(columns)[0] ?? ''
      expect(displayWidth(line)).toBeLessThanOrEqual(columns)
    }
    for (const columns of [20, 40, 80]) {
      const line = createStatusView(() => BUSY).render(columns)[0] ?? ''
      expect(stripAnsi(line)).toContain('thinking')
    }
  })
})
