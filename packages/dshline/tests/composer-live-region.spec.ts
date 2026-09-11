import { describe, expect, it } from 'vitest'
import { Composer, Screen, stripAnsi } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { composerGutter, composerInner, createComposerView } from '../src/views.ts'

/**
 * Regression coverage for PR #201's live-region geometry.
 *
 * The composer's dynamic frame title is CHROME: it is drawn and erased inside
 * the bounded live region, so its physical width must equal the width the
 * renderer measured. A glyph the terminal advances more cells for than
 * `displayWidth` does makes the top border wrap, and a wrapped row before the
 * cursor shifts every row below it — so `Screen.eraseLive` no longer reaches
 * the row it drew and the PREVIOUS frame survives. These tests run a real
 * `Screen` against a real `@xterm/headless` terminal whose width provider
 * deliberately widens the markers, which is the only way a headless test can
 * see that class of bug at all.
 */

/** Width wide enough for a normal composer and its title. */
const COLUMNS = 40

/**
 * The code points a terminal in ambiguous-width mode might widen. Dshline
 * measures both as one column, so a frame that uses them is only safe where
 * the terminal agrees.
 */
const DIRECTIONAL_ARROWS = [0x2191, 0x2193] as const

/**
 * A draft long enough that the composer viewport scrolls: 30 logical lines
 * against a ten-row viewport, so a moved cursor hides rows on both sides.
 * @returns the composer, cursor at the end.
 */
function longDraft(): Composer {
  const composer = new Composer()
  composer.handle({ kind: 'paste', text: Array.from({ length: 30 }, (_, i) => `draft ${String(i).padStart(2, '0')}`).join('\n') })
  return composer
}

/**
 * Move the cursor one visual row, exactly as the input router does.
 * @param composer - the draft to move within.
 * @param direction - -1 for `↑`, +1 for `↓`.
 * @returns whether the composer moved.
 */
function step(composer: Composer, direction: 1 | -1): boolean {
  const width = composerInner(COLUMNS)
  const gutter = (line: number): string => composerGutter(line, COLUMNS)
  return direction < 0 ? composer.moveUp(width, gutter) : composer.moveDown(width, gutter)
}

describe('the composer live region on a terminal that widens the title markers', () => {
  it('leaves no stale top border when the frame is the whole region', async () => {
    // Four rows is below the separator's reservation, so the frame's own top
    // border is the first row the region draws — the case where a wrapped
    // border is left behind instead of a blank separator, exactly the
    // accumulated `╭─ dshline …` rows the regression reported.
    const emulator = createEmulator(COLUMNS, 4, { wideCodePoints: DIRECTIONAL_ARROWS })
    const screen = new Screen(emulator.target)
    const composer = longDraft()
    const view = createComposerView(composer, '/w/repo')
    const redraw = (): void => {
      screen.setLive(view.render(COLUMNS, 4), view.cursor?.(COLUMNS, 4))
    }

    redraw()
    for (let i = 0; i < 6; i += 1) {
      expect(step(composer, -1)).toBe(true)
      redraw()
    }
    for (let i = 0; i < 6; i += 1) {
      expect(step(composer, 1)).toBe(true)
      redraw()
    }

    const history = await emulator.scrollback()
    // One current frame. A second `╭─` row is a previous frame the erase
    // missed, which is the failure this test exists for.
    expect(history.filter(row => row.includes('╭─'))).toHaveLength(1)
    // The bounded live region was not exceeded by the redraws.
    expect(screen.height).toBeLessThanOrEqual(4)
    emulator.dispose()
  })

  it('does not drift the live region down one row per redraw', async () => {
    // On a full-height terminal the separator absorbs the first wrapped row
    // instead of the border, but the region still walks down a row per redraw
    // and eventually scrolls committed output. Redrawing the same composer
    // states must therefore return the buffer to exactly where it started.
    const emulator = createEmulator(COLUMNS, 24, { wideCodePoints: DIRECTIONAL_ARROWS })
    const screen = new Screen(emulator.target)
    const composer = longDraft()
    const view = createComposerView(composer, '/w/repo')
    const redraw = (): void => {
      screen.setLive(view.render(COLUMNS, 24), view.cursor?.(COLUMNS, 24))
    }

    redraw()
    const before = await emulator.scrollback()
    for (let i = 0; i < 6; i += 1) {
      expect(step(composer, -1)).toBe(true)
      redraw()
    }
    for (let i = 0; i < 6; i += 1) {
      expect(step(composer, 1)).toBe(true)
      redraw()
    }
    const after = await emulator.scrollback()
    expect(after).toEqual(before)
    expect(after.filter(row => row.includes('╭─'))).toHaveLength(1)
    emulator.dispose()
  })

  it('names both hidden directions with width-stable ASCII markers', () => {
    // A focused policy check beside the end-to-end one: the dynamic chrome may
    // use any glyph whose width Dshline and the terminal agree on, and for the
    // direction markers that means ASCII. `stripAnsi` leaves only the visible
    // title, so this fails by name if the Unicode arrows come back.
    const composer = longDraft()
    for (let i = 0; i < 10; i += 1) expect(step(composer, -1)).toBe(true)
    const view = createComposerView(composer, '/w/repo')
    const top = stripAnsi(view.render(COLUMNS, 24)[1] ?? '')
    expect(top).toMatch(/\^ \d+/)
    expect(top).toMatch(/v \d+/)
    // The whole arrow block is ambiguous width; none of it belongs in chrome
    // whose row accounting must be exact.
    expect(top).not.toMatch(/[\u2190-\u21ff]/u)
  })
})
