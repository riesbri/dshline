/**
 * The `/context` inspector as a real terminal draws it.
 *
 * A frame reconstructed from the text alone reads correctly whether or not its
 * borders line up, so these go through the emulator: the box edges are checked
 * in COLUMNS, and the transcript underneath is checked in real scrollback —
 * closing the inspector must leave committed history exactly as it was.
 */

import { describe, expect, it } from 'vitest'
import { displayWidth, Screen } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { createContextOverlay } from '../src/context/overlay.ts'
import type { ContextEntry, ContextReading, ContextSurvey } from '../src/context/model.ts'

/** A metered reading with a mixed composition. */
const READING: ContextReading = {
  projections: true,
  metered: true,
  occupancy: { tokens: 184_000, capacity: 1_000_000 },
  composition: { system: 12_000, tools: 48_000, messages: 124_000, total: 184_000 },
}

/** One entry, with a wide-character tool name where a Latin one would be. */
function entry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return {
    seq: 418, position: 41, tokens: 42_000, share: 0.22, kind: 'tool-result',
    form: undefined, tool: '読み込み', turn: 31, step: 4, replaced: false, ...overrides,
  }
}

/** A survey over the given entries. */
function survey(entries: readonly ContextEntry[]): ContextSurvey {
  return { available: true, surfaceTokens: 190_000, nodes: 128, entries }
}

/** Mount one inspector over a committed transcript row, on a real emulator. */
function mount(columns: number, terminalRows: number, entries: readonly ContextEntry[]): {
  readonly emulator: ReturnType<typeof createEmulator>
  readonly draw: () => void
  readonly press: (name: 'enter' | 'escape') => void
} {
  const emulator = createEmulator(columns, terminalRows)
  const screen = new Screen(emulator.target)
  screen.commit(['committed transcript row'])
  let instance!: ReturnType<typeof createContextOverlay>
  const draw = (): void => { screen.setLive(instance.render(columns, terminalRows)) }
  instance = createContextOverlay({
    reading: () => READING,
    survey: () => survey(entries),
    preview: () => ({ text: '上下文が長い\nPASS one', truncated: false, available: true }),
    capacity: () => 1_000_000,
     canCompact: () => false,
     compact: async () => undefined,
    close: () => { screen.setLive(['composer', 'status']) },
    invalidate: () => { draw() },
  })
  return {
    emulator,
    draw,
    press: name => { instance.handleKey({ kind: 'key', name }) },
  }
}

/**
 * The COLUMNS every box border sits in, for the rows that have one.
 *
 * Measured in display columns, not string indices: the emulator's row text
 * omits the second cell of a wide character, so an index would place the right
 * border one column left of where the terminal actually drew it — which is
 * exactly the misalignment these tests exist to catch.
 * @param rows - rendered rows from the emulator.
 * @returns the distinct border columns across those rows.
 */
function borderColumns(rows: readonly string[]): Set<number> {
  const columns = new Set<number>()
  for (const row of rows) {
    let column = 0
    for (const character of row) {
      if ('│├┤'.includes(character)) columns.add(column)
      column += displayWidth(character)
    }
  }
  return columns
}

describe('the context inspector on a real terminal', () => {
  it('lines its borders up in the same columns, wide characters included', async () => {
    const view = mount(72, 24, [
      entry(),
      entry({ seq: 300, tokens: 18_000, share: 0.09, kind: 'assistant', tool: undefined }),
    ])
    view.draw()
    const rows = (await view.emulator.screen()).filter(row => row.includes('│'))
    expect(rows.length).toBeGreaterThan(4)
    // Two columns and no more: one left edge, one right edge, for every row.
    expect([...borderColumns(rows)].sort((a, b) => a - b).length).toBe(2)
  })

  it('keeps its entry detail inside the same frame', async () => {
    const view = mount(72, 24, [entry()])
    view.draw()
    view.press('enter')
    view.draw()
    const frame = await view.emulator.screen()
    expect(frame.join('\n')).toContain('Context entry')
    const rows = frame.filter(row => row.includes('│'))
    expect([...borderColumns(rows)].sort((a, b) => a - b).length).toBe(2)
  })

  it('leaves committed scrollback untouched when it closes', async () => {
    const view = mount(72, 12, [entry()])
    const before = await view.emulator.scrollback()
    view.draw()
    view.press('escape')
    const after = await view.emulator.scrollback()
    expect(after.filter(row => row.includes('committed transcript row')))
      .toEqual(before.filter(row => row.includes('committed transcript row')))
    expect(after.join('\n')).not.toContain('Composition')
  })
})
