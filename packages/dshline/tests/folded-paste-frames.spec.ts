/**
 * A large paste, drawn by the real composer view on a real terminal emulator.
 *
 * The renderer's own tests prove the fold rules against `layoutComposer` in
 * isolation. This file proves the thing a person actually looks at: that the
 * framed composer, the caret the emulator ends up holding, and the message that
 * leaves for Harness all agree — through `createComposerView` and a
 * `@xterm/headless` screen, not a string comparison.
 *
 * A frame is a geometry claim, so geometry is checked the only way it can be
 * believed: by reading the cells the terminal actually received.
 */

import { describe, expect, it } from 'vitest'
import { Composer, Screen, stripAnsi } from '@dshline/renderer'
import type { Key } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { InputHistory } from '../src/history.ts'
import { routeInputKey } from '../src/input.ts'
import { composerGutter, composerInner, createComposerView } from '../src/views.ts'

/** A key the decoder would have produced. @param name - the key name. */
const key = (name: string): Key => ({ kind: 'key', name } as Key)

/** A bracketed paste. @param body - the pasted text. */
const paste = (body: string): Key => ({ kind: 'paste', text: body })

/**
 * A paste of `count` numbered lines.
 * @param count - how many logical lines it holds.
 * @returns the pasted text.
 */
function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `pasted line ${String(index + 1)}`).join('\n')
}

/**
 * Type characters the way a terminal delivers them.
 * @param composer - the buffer being filled.
 * @param value - the characters to type.
 */
function type(composer: Composer, value: string): void {
  for (const char of value) composer.handle({ kind: 'text', text: char } as Key)
}

/** A completion state that never claims a key, so routing reaches the composer. */
const NO_COMPLETION = {
  active: false,
  handleKey: () => false,
  invalidate: () => {},
} as unknown as Parameters<typeof routeInputKey>[2]

/**
 * Draw a composer through its real view and read back what the terminal received.
 * @param composer - the buffer to draw.
 * @param columns - the terminal width.
 * @param terminalRows - the terminal height.
 * @returns the drawn rows, the reported caret, and the emulator's own cursor.
 */
async function drawn(
  composer: Composer,
  columns = 60,
  terminalRows = 24,
): Promise<{ rows: string[]; caret: { row: number; column: number }; emulator: ReturnType<typeof createEmulator> }> {
  const emulator = createEmulator(columns, terminalRows)
  const screen = new Screen(emulator.target)
  const view = createComposerView(composer, '/w/repo')
  const rows = view.render(columns, terminalRows)
  const caret = view.cursor?.(columns, terminalRows) ?? { row: 0, column: 0 }
  screen.setLive(rows, caret)
  return { rows, caret, emulator }
}

describe('a large paste in the framed composer', () => {
  it('draws one token and hides nothing of the label', async () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    const { rows } = await drawn(composer)
    const frame = stripAnsi(rows.join('\n'))
    expect(frame).toContain('[Pasted text #1 +11 lines]')
    expect(frame).not.toContain('pasted line 3')
  })

  it('puts the caret on a cell the frame actually drew', async () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    const { rows, caret, emulator } = await drawn(composer)
    // The cell under the caret is inside the drawn frame, and it is the cell just
    // past the label — not a position the layout invented.
    expect(caret.row).toBeGreaterThan(0)
    expect(caret.row).toBeLessThan(rows.length)
    expect(stripAnsi(rows[caret.row] ?? '')).toContain('[Pasted text #1 +11 lines]')
    const cell = await emulator.cell(caret.column, caret.row)
    expect(cell).toBeDefined()
    expect(cell).not.toBe(' ')
  })

  it('renders prefix, token, and suffix in one frame', async () => {
    const composer = new Composer()
    type(composer, 'Please inspect: ')
    composer.handle(paste(lines(11)))
    type(composer, ' Focus on the failure.')
    const { rows } = await drawn(composer, 80)
    const frame = stripAnsi(rows.join('\n'))
    expect(frame).toContain('Please inspect: [Pasted text #1 +11 lines] Focus on the failure.')
  })

  it('survives a resize in both directions without stale geometry', async () => {
    const composer = new Composer()
    type(composer, 'before ')
    composer.handle(paste(lines(11)))
    type(composer, ' after')
    const emulator = createEmulator(80, 24)
    const screen = new Screen(emulator.target)
    const view = createComposerView(composer, '/w/repo')
    // Wide, then narrow, then wide again: the label re-wraps each time, and the
    // live region must still end where it started rather than accumulating rows.
    for (const columns of [80, 24, 20, 40, 120, 80]) {
      const rows = view.render(columns, 24)
      const caret = view.cursor?.(columns, 24) ?? { row: 0, column: 0 }
      screen.setLive(rows, caret)
      for (const row of rows) {
        // No row may exceed the terminal, or `Screen` would count a physical row
        // this view never budgeted for.
        expect(stripAnsi(row).length, `row at ${String(columns)}`).toBeLessThanOrEqual(columns)
      }
    }
    expect(screen.height).toBeLessThanOrEqual(24)
  })

  it('keeps the label whole at every width a terminal might be', async () => {
    const composer = new Composer()
    type(composer, '前')
    composer.handle(paste(lines(11)))
    type(composer, '后')
    for (const columns of [20, 24, 40, 80, 120]) {
      const { rows } = await drawn(composer, columns)
      // The frame's own chrome is interleaved between the content rows, so it is
      // stripped along with the whitespace before the label is looked for.
      const frame = stripAnsi(rows.join('\n')).replace(/[\s│╭╮╰╯─]/gu, '')
      // Wrapping is a drawing decision; nothing may be cut off.
      expect(frame, `label at ${String(columns)}`).toContain('[Pastedtext#1+11lines]')
    }
  })

  it('keeps the caret exact beside wide characters at every width', async () => {
    const composer = new Composer()
    type(composer, '前缀')
    composer.handle(paste(lines(11)))
    type(composer, '后缀')
    for (const columns of [20, 24, 40, 80, 120]) {
      const { rows, caret, emulator } = await drawn(composer, columns)
      expect(caret.row, `caret row at ${String(columns)}`).toBeLessThan(rows.length)
      // The caret is on a real, non-blank cell — a column computed in code points
      // rather than display columns would land past the end of the row.
      const cell = await emulator.cell(caret.column, caret.row)
      expect(cell, `cell at ${String(columns)}`).not.toBe(' ')
    }
  })

  it('stays inside the composer row cap with a token on screen', async () => {
    const composer = new Composer()
    composer.handle(paste(lines(3000)))
    const { rows } = await drawn(composer, 60, 24)
    // A compact draft is far below the cap; the point is that the frame is still a
    // well-formed, bounded live region rather than a runaway.
    expect(rows.filter(row => row !== '').length).toBeLessThan(12)
    expect(stripAnsi(rows.join('\n'))).toContain('[Pasted text #1 +3000 lines]')
  })

  it('still bounds a tall non-pasted draft to the same cap', async () => {
    // The cap is the live region's, and it is unchanged: this is the draft shape
    // that actually needs it, since a large paste no longer does.
    const composer = new Composer()
    composer.set(lines(3000))
    const { rows } = await drawn(composer, 60, 24)
    expect(rows.filter(row => row !== '').length).toBeLessThanOrEqual(12)
    expect(stripAnsi(rows.join('\n'))).toContain('pasted line 2999')
  })
})

describe('what a folded paste does to history', () => {
  it('sends the whole body, and records that in history', () => {
    const composer = new Composer()
    const history = new InputHistory()
    const body = lines(11)
    composer.handle(paste(body))
    composer.handle(key('newline'))
    composer.handle(paste('a short follow-up'))
    const action = composer.handle(key('enter'))
    expect(action).toEqual({ kind: 'submit', text: `${body}\na short follow-up`, gesture: 'enter' })
    // The durable record is the message. Nothing about a label is written down.
    history.record(action.kind === 'submit' ? action.text : '')
    expect(history.entry(0)).toBe(`${body}\na short follow-up`)
    expect(history.entry(0)).not.toContain('[Pasted text')
  })

  it('recalls a multiline prompt as full ordinary text, not as a label', () => {
    const composer = new Composer()
    const history = new InputHistory()
    const prompt = lines(11)
    history.record(prompt)
    // `↑` walks into history, which writes through `set()`. Provenance is not
    // durable, so the recall must be the text and only the text — a label here
    // would put a false claim into a message the user did not paste.
    const routed = routeInputKey(key('up'), composer, NO_COMPLETION, history, {
      width: composerInner(60),
      gutter: (line: number) => composerGutter(line, 60),
    })
    expect(routed).toBe('history')
    expect(composer.value).toBe(prompt)
    expect(composer.display().text).toBe(prompt)
    const view = createComposerView(composer, '/w/repo')
    expect(stripAnsi(view.render(60, 24).join('\n'))).toContain('pasted line 1')
    expect(stripAnsi(view.render(60, 24).join('\n'))).not.toContain('[Pasted text')
  })

  it('keeps numbering across a recall, because recall forges no provenance', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    composer.handle(key('enter'))
    // History recall replaced the buffer; a new large paste is still the second
    // block this composer has seen.
    composer.set('some recalled prompt')
    composer.handle(paste(lines(11)))
    expect(stripAnsi(createComposerView(composer, '/w/repo').render(60, 24).join('\n'))).toContain(
      'some recalled prompt[Pasted text #2 +11 lines]',
    )
  })
})
