import { describe, expect, it } from 'vitest'
import { Composer, displayWidth, Screen, stripAnsi, wrapToWidth } from '@dshline/renderer'
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
 *
 * Seeded with `set()` rather than pasted, and that distinction is the whole
 * point: a paste of thirty lines now folds to one `[Pasted text #N +30 lines]`
 * token, which is this feature working correctly and which would leave the draft
 * a single row tall. These tests are about live-region GEOMETRY — a frame taller
 * than its viewport — so the height has to arrive as a baseline. The compactness
 * of a genuinely large paste is asserted where it belongs, in `folded-pastes.spec.ts`.
 * @returns the composer, cursor at the end.
 */
function longDraft(): Composer {
  const composer = new Composer()
  composer.set(Array.from({ length: 30 }, (_, i) => `draft ${String(i).padStart(2, '0')}`).join('\n'))
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

/**
 * The code points a terminal in ambiguous-width mode widens while dshline
 * measures them as one column. The workspace basename is UNTRUSTED text drawn
 * inside the frame's top border, so it is the one place an arbitrary ambiguous
 * code point still reaches width-critical chrome.
 */
const AMBIGUOUS_LABEL = [0x00b1] as const

describe('the composer live region with an ambiguous workspace label', () => {
  it('leaves no stale top border when the untrusted label would widen', async () => {
    // The label is projected to width-stable characters, so the border measures
    // the same width this terminal draws. Without that projection the run of
    // `±` pushed the top border past the modeled region, and every redraw left
    // another border behind — the #202 failure mode, reached through the label
    // instead of the direction markers. The run is long enough that the
    // projection is load-bearing: an unprojected frame would overflow by many
    // columns, not by the one column the terminal's breathing room absorbs.
    const emulator = createEmulator(COLUMNS, 4, { wideCodePoints: AMBIGUOUS_LABEL })
    // Count the writes so the redraw path is proven to have run: `Screen.setLive`
    // returns without erasing for a byte-identical frame, and a stale-frame test
    // that never redrew would pass without testing anything.
    let writes = 0
    const screen = new Screen({
      write: chunk => { writes += 1; emulator.target.write(chunk) },
      columns: () => emulator.target.columns(),
    })
    const composer = longDraft()
    const view = createComposerView(composer, `/w/${'\u00b1'.repeat(18)}repo`)
    const redraw = (): void => {
      screen.setLive(view.render(COLUMNS, 4), view.cursor?.(COLUMNS, 4))
    }

    redraw()
    const before = await emulator.scrollback()
    const firstFrameWrites = writes
    for (let i = 0; i < 6; i += 1) {
      expect(step(composer, -1)).toBe(true)
      redraw()
    }
    for (let i = 0; i < 6; i += 1) {
      expect(step(composer, 1)).toBe(true)
      redraw()
    }

    const history = await emulator.scrollback()
    // Every step changed the frame, so every redraw wrote: the erase/redraw path
    // was exercised, and the assertions below are not vacuous.
    expect(writes - firstFrameWrites).toBe(12)
    // No drift: a wrapped border adds a physical row Screen never erases, so the
    // held row count would grow on every redraw.
    expect(history.length).toBe(before.length)
    // One current frame, not a previous one the erase missed.
    expect(history.filter(row => row.includes('╭─'))).toHaveLength(1)
    expect(screen.height).toBeLessThanOrEqual(4)
    emulator.dispose()
  })
})

describe('the composer frame respects its granted height', () => {
  it('never draws more physical rows than the terminal has', () => {
    // The per-view contract the composition backstop exists to protect: on a
    // terminal too short for the framed box the view falls back to its unframed
    // form rather than drawing borders that would scroll off unreachable.
    for (const draft of ['', 'hello world', Array.from({ length: 30 }, (_, i) => `d${String(i)}`).join('\n')]) {
      const composer = new Composer()
      if (draft !== '') composer.handle({ kind: 'paste', text: draft })
      const view = createComposerView(composer, '/w/repo')
      for (let rows = 1; rows <= 8; rows += 1) {
        const lines = view.render(COLUMNS, rows)
        const physical = lines.flatMap(line => wrapToWidth(line, COLUMNS))
        expect(physical.length, `draft=${JSON.stringify(draft.slice(0, 8))} rows=${String(rows)}`)
          .toBeLessThanOrEqual(rows)
        const cursor = view.cursor?.(COLUMNS, rows)
        if (cursor !== undefined) {
          expect(cursor.row).toBeGreaterThanOrEqual(0)
          expect(cursor.row).toBeLessThan(physical.length)
          expect(cursor.column).toBeLessThanOrEqual(COLUMNS)
        }
      }
    }
  })
})

/**
 * A keycap sequence (`1️⃣` = U+0031 U+FE0F U+20E3): every component measures
 * narrow or zero here, but Unicode lets the sequence advance two columns, so a
 * per-code-point model cannot see the physical width.
 */
const KEYCAP_BASE = [0x31] as const

describe('the composer live region with a keycap workspace label', () => {
  it('leaves no stale top border when the label holds a keycap sequence', async () => {
    const emulator = createEmulator(COLUMNS, 4, { wideCodePoints: KEYCAP_BASE })
    let writes = 0
    const screen = new Screen({
      write: chunk => { writes += 1; emulator.target.write(chunk) },
      columns: () => emulator.target.columns(),
    })
    const composer = longDraft()
    // The label is projected as the whole keycap sequence, so no component of it
    // reaches the border for this terminal to widen.
    const view = createComposerView(composer, '/w/1\ufe0f\u20e3repo')
    const redraw = (): void => {
      screen.setLive(view.render(COLUMNS, 4), view.cursor?.(COLUMNS, 4))
    }

    redraw()
    const before = await emulator.scrollback()
    const firstFrameWrites = writes
    for (let i = 0; i < 6; i += 1) {
      expect(step(composer, -1)).toBe(true)
      redraw()
    }
    for (let i = 0; i < 6; i += 1) {
      expect(step(composer, 1)).toBe(true)
      redraw()
    }

    const history = await emulator.scrollback()
    expect(writes - firstFrameWrites).toBe(12)
    expect(history.length).toBe(before.length)
    expect(history.filter(row => row.includes('╭─'))).toHaveLength(1)
    expect(screen.height).toBeLessThanOrEqual(4)
    emulator.dispose()
  })
})

/**
 * Code points the renderer deliberately leaves measured one because their
 * advance is disputed or sequence-dependent. The all-Cf-zero table this change
 * replaced measured them zero; a terminal that draws one wider turns that into
 * an under-measured, wrapping border, which is the failure this pins.
 */
const UNCERTAIN_FORMAT = [0x0600, 0x00ad, 0x06dd, 0x070f] as const

describe('the composer live region with a format character the terminal widens', () => {
  for (const format of UNCERTAIN_FORMAT) {
    it(`projects U+${format.toString(16).toUpperCase()} instead of trusting a zero it does not honor`, async () => {
      const emulator = createEmulator(COLUMNS, 4, { wideCodePoints: [format] })
      let writes = 0
      const screen = new Screen({
        write: chunk => { writes += 1; emulator.target.write(chunk) },
        columns: () => emulator.target.columns(),
      })
      const composer = longDraft()
      // Six of them, so an unprojected run overflows by far more than the one
      // column of breathing room the frame leaves the terminal.
      const view = createComposerView(composer, `/w/${String.fromCodePoint(format).repeat(6)}repo`)
      const redraw = (): void => {
        screen.setLive(view.render(COLUMNS, 4), view.cursor?.(COLUMNS, 4))
      }

      redraw()
      const before = await emulator.scrollback()
      const firstFrameWrites = writes
      for (let i = 0; i < 6; i += 1) {
        expect(step(composer, -1)).toBe(true)
        redraw()
      }
      for (let i = 0; i < 6; i += 1) {
        expect(step(composer, 1)).toBe(true)
        redraw()
      }

      const history = await emulator.scrollback()
      // Every step changed the frame, so the erase/redraw path ran, and a
      // wrapped border would have grown the held rows and left an extra `╭─`.
      expect(writes - firstFrameWrites).toBe(12)
      expect(history.length).toBe(before.length)
      expect(history.filter(row => row.includes('╭─'))).toHaveLength(1)
      expect(screen.height).toBeLessThanOrEqual(4)
      emulator.dispose()
    })
  }
})

/**
 * A short ASCII composer, so a test can widen an ASCII code point in the LABEL
 * without that width change also landing in the body rows and confusing the two.
 * @returns the composer.
 */
function labelComposer(): Composer {
  const composer = new Composer()
  composer.handle({ kind: 'paste', text: 'hello there' })
  return composer
}

/**
 * Draw one composer frame and read what the terminal actually shows.
 * @param workspace - the composer's workspace path, which titles the frame.
 * @param options - terminal width, height, and code points this terminal widens.
 * @returns the emulator, its screen rows, the top-border row's index and text.
 */
async function drawLabel(
  workspace: string,
  { columns = COLUMNS, rows = 24, wideCodePoints }: { columns?: number; rows?: number; wideCodePoints?: readonly number[] } = {},
): Promise<{ emulator: ReturnType<typeof createEmulator>; topRow: number; top: string }> {
  const emulator = createEmulator(columns, rows, wideCodePoints === undefined ? {} : { wideCodePoints })
  const screen = new Screen(emulator.target)
  const view = createComposerView(labelComposer(), workspace)
  screen.setLive(view.render(columns, rows), view.cursor?.(columns, rows))
  const shown = await emulator.screen()
  const topRow = shown.findIndex(row => row.includes('╭'))
  return { emulator, topRow, top: shown[topRow] ?? '' }
}

describe('the composer label across the classes a terminal draws differently', () => {
  it('draws an exact border for narrow scripts, wide scripts, and a decomposed accent', async () => {
    // Hebrew, Arabic, Indic, CJK, and a precomposed Latin accent together. Every
    // one is either unambiguously narrow or wide, or is decomposed to a stable
    // base plus a mark, so the frame measures exactly what a terminal draws and
    // the right corner lands in the frame's last column.
    const workspace = '/w/\u05e9\u05dc\u05d5\u05dd-\u0645\u0631\u062d\u0628\u0627-\u0928\u092e\u0938\u094d\u0924\u0947-caf\u00e9-\u6807\u51c6'
    const { emulator, topRow, top } = await drawLabel(workspace)
    expect(topRow).toBeGreaterThanOrEqual(0)
    // The composer frame is COLUMNS - 1 wide; a label that moved it would make
    // this a different number, or wrap the terminal row.
    expect(displayWidth(top)).toBe(COLUMNS - 1)
    expect((await emulator.cell(COLUMNS - 2, topRow))?.chars).toBe('╮')
    // The accent survived as its stable canonical decomposition, not as `?`.
    expect(top).toContain('cafe\u0301')
    emulator.dispose()
  })

  it('projects an emoji sequence so a terminal that widens it still draws one exact frame', async () => {
    // Each case is a sequence whose components measure one or two columns but
    // which a terminal may draw as one two-column picture. Projecting the whole
    // sequence keeps the border in one physical row, so the right corner stays
    // in the frame's last column even though this terminal would widen it.
    const cases: readonly { workspace: string; wideCodePoints: readonly number[] }[] = [
      { workspace: '/w/\u2764\ufe0f', wideCodePoints: [0x2764] },
      { workspace: '/w/1\ufe0f\u20e3', wideCodePoints: [0x31] },
      { workspace: '/w/1\u20e3', wideCodePoints: [0x31] },
      { workspace: '/w/\u{1F1E8}\u{1F1F3}', wideCodePoints: [0x1f1e8, 0x1f1f3] },
      { workspace: '/w/\u{1F469}\u200d\u{1F4BB}', wideCodePoints: [0x1f469, 0x1f4bb] },
      { workspace: '/w/\u{1F44B}\u{1F3FD}', wideCodePoints: [0x1f44b, 0x1f3fd] },
    ]
    for (const { workspace, wideCodePoints } of cases) {
      const { emulator, topRow, top } = await drawLabel(workspace, { wideCodePoints })
      expect(topRow, workspace).toBeGreaterThanOrEqual(0)
      expect(displayWidth(top), workspace).toBe(COLUMNS - 1)
      expect((await emulator.cell(COLUMNS - 2, topRow))?.chars, workspace).toBe('╮')
      emulator.dispose()
    }
  })

  it('keeps every label row inside the terminal at every width and class', () => {
    // The model-level guard the emulator cannot cover at every width: whatever a
    // label is made of, no rendered row may measure wider than the terminal, or
    // `Screen` would wrap it into a physical row the live-region arithmetic
    // never counted.
    const labels = [
      'plain', 'caf\u00e9', 'cafe\u0301', '\u05e9\u05dc\u05d5\u05dd',
      '\u0645\u0631\u062d\u0628\u0627', '\u0928\u092e\u0938\u094d\u0924\u0947',
      '\u6807\u51c6\u6a21\u5f0f', '\u00b1\u00b1\u00b1\u00b1',
      '\u2764\ufe0f', '1\ufe0f\u20e3', '\u{1F1E8}\u{1F1F3}',
      '\u{1F469}\u200d\u{1F4BB}', '\u{1F44B}\u{1F3FD}', '\u231a\u4dc0',
      '\u00ad', '\u0600\u0600', '\u06dd', '\u070f', '\u200b',
      '\u1112\u1161\u11ab', '\u{1F6D8}',
    ]
    const composer = labelComposer()
    for (const label of labels) {
      const view = createComposerView(composer, `/w/${label}`)
      for (const columns of [12, 20, 41, 80]) {
        const lines = view.render(columns, 24)
        for (const line of lines) {
          expect(displayWidth(line), `${JSON.stringify(label)} at ${String(columns)}`).toBeLessThanOrEqual(columns)
        }
      }
    }
  })
})
