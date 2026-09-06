/** Shared-root geometry and composer integration on a real terminal. */

import { Context } from '@deepseek-ai/cordis'
import { Composer, displayWidth, Screen, stripAnsi } from '@dshline/renderer'
import { describe, expect, it } from 'vitest'
import { createEmulator } from '../../../tests/emulator.ts'
import { chromeWidth, fitFooterHelp, rootFrame } from '../src/chrome.ts'
import { createCompletion } from '../src/completion.ts'
import { InputHistory } from '../src/history.ts'
import { routeInputKey } from '../src/input.ts'
import { TuiSlots } from '../src/slots.ts'
import { composerGutter, composerInner, createComposerView } from '../src/views.ts'

/** Terminal widths that exercise the floor, ordinary widths, and the cap. */
const ROOT_WIDTHS = [20, 24, 30, 40, 80, 120] as const

/** A terminal height large enough that no composer row is surrendered. */
const ROWS = 24

/**
 * A composer holding `text`, with the cursor where typing it would leave it.
 * @param text - text to insert into the composer.
 * @returns the populated composer.
 */
function typed(text: string): Composer {
  const composer = new Composer()
  composer.handle({ kind: 'paste', text })
  return composer
}

/**
 * Draw one composer through the real Screen path.
 * @param composer - the composer to render.
 * @param columns - terminal width.
 * @param workspace - workspace whose basename labels the frame.
 * @returns the emulator and its visible rows and cursor.
 */
async function drawn(
  composer: Composer,
  columns = 40,
  workspace = '/work/repo',
): Promise<{
  readonly emulator: ReturnType<typeof createEmulator>
  readonly cursor: { column: number; row: number }
  readonly rows: string[]
}> {
  const emulator = createEmulator(columns, ROWS)
  const screen = new Screen(emulator.target)
  const view = createComposerView(composer, workspace)
  screen.setLive(view.render(columns), view.cursor?.(columns))
  return {
    emulator,
    cursor: await emulator.cursor(),
    rows: (await emulator.screen()).map(row => row.trimEnd()),
  }
}

describe('the shared visual root', () => {
  it.each(ROOT_WIDTHS)('keeps both root labels and exact row width at %i columns', columns => {
    // Three columns is the complete right-label budget at the narrowest case.
    // Using it here distinguishes width surrender from a missing context label.
    const lines = rootFrame({ columns, context: 'ctx', body: ['body'] })
    const top = stripAnsi(lines[0] ?? '')
    expect(top).toContain('dshline')
    expect(top).toContain('ctx')
    expect(lines.every(line => displayWidth(line) === chromeWidth(columns))).toBe(true)
    expect(displayWidth(lines[0] ?? '')).toBe(columns === 120 ? 100 : chromeWidth(columns))
  })

  it('surrenders a long right context before the dshline label', () => {
    const context = 'workspace-name-that-cannot-fit'
    const top = stripAnsi(rootFrame({ columns: 20, context, body: ['body'] })[0] ?? '')
    expect(top).toContain('dshline')
    expect(top).not.toContain(context)
    expect(top).toContain('wor')
    expect(displayWidth(top)).toBe(chromeWidth(20))
  })

  it('drops footer help atomically from the front', () => {
    const help = '↑↓ select · k interrupt · esc close'
    const fitted = [
      fitFooterHelp(help, 40),
      fitFooterHelp(help, 26),
      fitFooterHelp(help, 14),
      fitFooterHelp(help, 6),
    ]
    expect(fitted).toEqual([
      help,
      'k interrupt · esc close',
      'esc close',
      'esc',
    ])
    expect(fitted.every(line => !line.includes('esc clo') || line.includes('esc close'))).toBe(true)
    // Empty help stays empty; a budget too small even for `esc` stays empty too.
    expect(fitFooterHelp('', 1)).toBe('')
    expect(fitFooterHelp(help, 2)).toBe('')
  })

  it('escapes a workspace control before styling it', () => {
    const view = createComposerView(new Composer(), '/work/re\u001b[2Jpo')
    const lines = view.render(40)
    const top = stripAnsi(lines[1] ?? '')
    expect(top).toContain('re^[[2Jpo')
    expect(lines.slice(1).every(line => displayWidth(line) === chromeWidth(40))).toBe(true)
  })
})

describe('the composer inside the shared root', () => {
  it('puts the empty cursor on ask anything beneath both labels', async () => {
    const frame = await drawn(new Composer())
    const top = frame.rows[1] ?? ''
    expect(top).toContain('dshline')
    expect(top).toContain('repo')
    expect(frame.rows[frame.cursor.row]).toContain('ask anything')
    expect((await frame.emulator.cell(frame.cursor.column, frame.cursor.row))?.chars).toBe('a')
  })

  it('puts the single-line cursor immediately after typed text', async () => {
    const frame = await drawn(typed('hello'))
    const row = frame.rows.findIndex(line => line.includes('hello'))
    expect(frame.rows[1]).toContain('dshline')
    expect(frame.rows[1]).toContain('repo')
    expect(frame.cursor.row).toBe(row)
    expect(frame.cursor.column).toBe((frame.rows[row] ?? '').indexOf('hello') + 'hello'.length)
    expect((await frame.emulator.cell(frame.cursor.column - 1, frame.cursor.row))?.chars).toBe('o')
  })

  it('puts the narrow wrapped cursor after the visible tail', async () => {
    const frame = await drawn(typed('abcdefghijklmnopqrstuvwx'), 24)
    expect(frame.rows[1]).toContain('dshline')
    expect(frame.rows[1]).toContain('repo')
    expect(frame.cursor.row).toBeGreaterThan(2)
    expect((await frame.emulator.cell(frame.cursor.column - 1, frame.cursor.row))?.chars).toBe('x')
    expect((await frame.emulator.cell(frame.cursor.column, frame.cursor.row))?.chars).toBe(' ')
  })

  it.each([
    [80, 79],
    [100, 99],
    [101, 100],
    [102, 101],
    [120, 119],
    [160, 159],
  ] as const)('uses terminal-following composer width at %i columns', async (columns, expected) => {
    const wideText = typed(`界${'🙂界'.repeat(80)}`)
    for (const composer of [new Composer(), typed('hello'), wideText]) {
      const frame = await drawn(composer, columns)
      const top = frame.rows.find(row => stripAnsi(row).includes('dshline')) ?? ''
      expect(displayWidth(top), `${String(columns)} columns`).toBe(expected)
      expect(frame.rows.every(row => displayWidth(row) <= columns), `${String(columns)} columns`).toBe(true)
    }
  })

  it('keeps a wide cursor on typed text and moves it through wrapped multiline rows', async () => {
    const columns = 120
    const composer = typed(`${'a'.repeat(140)}\n${'b'.repeat(140)}\nccc`)
    const completion = createCompletion(composer, {
      commands: () => [],
      commandArguments: async () => [],
      paths: async () => [],
    }, () => {})
    const history = new InputHistory()
    const before = await drawn(composer, columns)
    expect((await before.emulator.cell(before.cursor.column - 1, before.cursor.row))?.chars).toBe('c')

    expect(routeInputKey(
      { kind: 'key', name: 'up' },
      composer,
      completion,
      history,
      { width: composerInner(columns), gutter: line => composerGutter(line, columns) },
    )).toBe('vertical')
    const after = await drawn(composer, columns)
    expect(after.rows[after.cursor.row]).toContain('b')
    expect((await after.emulator.cell(after.cursor.column, after.cursor.row))?.chars).toBe('b')
  })

  it('lets an overlay replace composer rows and cursor together', () => {
    const slots = new TuiSlots(new Context())
    slots.register('composer', createComposerView(typed('hello'), '/work/repo'))
    const close = slots.pushOverlay({
      render: () => ['overlay row'],
      handleKey: () => {},
    })

    expect(slots.compose(80, ROWS)).toEqual({ lines: ['overlay row'], cursor: undefined })
    close()
    const composer = slots.compose(80, ROWS)
    expect(composer.lines.join('\n')).toContain('dshline')
    expect(composer.lines.join('\n')).toContain('hello')
    expect(composer.cursor).toBeDefined()
  })

  it('restores the composer cursor cell exactly after an overlay closes', async () => {
    // The compose-level contract above says the cursor is absent while an
    // overlay is up; this drives the same sequence through a real emulator so
    // the PHYSICAL cursor ends exactly back on the typed text after close.
    const emulator = createEmulator(80, ROWS)
    const screen = new Screen(emulator.target)
    const slots = new TuiSlots(new Context())
    slots.register('composer', createComposerView(typed('hello'), '/work/repo'))
    const draw = (): void => {
      const composed = slots.compose(80, ROWS)
      if (composed.cursor === undefined) screen.setLive(composed.lines)
      else screen.setLive(composed.lines, composed.cursor)
    }

    draw()
    const before = await emulator.cursor()
    expect((await emulator.cell(before.column - 1, before.row))?.chars).toBe('o')

    const close = slots.pushOverlay({ render: () => ['overlay row'], handleKey: () => {} })
    draw()
    expect(slots.compose(80, ROWS).cursor).toBeUndefined()
    const underOverlay = await emulator.cursor()
    expect((await emulator.cell(underOverlay.column, underOverlay.row))?.chars).not.toBe('o')

    close()
    draw()
    const after = await emulator.cursor()
    expect(after).toEqual(before)
    expect((await emulator.cell(after.column - 1, after.row))?.chars).toBe('o')
  })
})
