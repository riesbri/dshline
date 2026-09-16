/**
 * A long suggestion list on a real terminal.
 *
 * Completion is not an overlay: it shares the live region with the composer and
 * the status line, and `Screen` erases that region by climbing rows. A list that
 * renders more rows than the terminal has therefore pushes the composer off the
 * top, where the next redraw can no longer reach it — and the transcript above
 * gains a duplicate copy of the chrome. Read as plain text every one of those
 * frames looks correct, so the assertions here are about what the terminal HOLDS.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Composer, Screen } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { createCompletion } from '../src/completion.ts'
import { TuiSlots } from '../src/slots.ts'
import { createComposerView, createStatusView } from '../src/views.ts'

/** The width used by the real-terminal regression frames. */
const COLUMNS = 80

/** More commands than a short terminal can show at once. */
const COMMANDS = Array.from({ length: 15 }, (_unused, index) => ({
  name: index === 14 ? 'command-last-sentinel' : `command-${String(index).padStart(2, '0')}`,
  description: 'what this one does',
}))

/**
 * Mount the whole live region — composer, completion, status — over an emulator.
 *
 * Composed through the REAL `TuiSlots`, not a hand-rolled concatenation. The
 * budget under test is the one `compose()` hands each view, so a test that did
 * that arithmetic itself would pass with the arithmetic removed from the source.
 * @param rows - the emulator's height.
 * @param typed - what is in the composer, which decides how tall it is.
 * @returns the emulator, the completion, and a repaint of the live region.
 */
async function terminal(rows: number, typed = '/command'): Promise<{
  emulator: ReturnType<typeof createEmulator>
  completion: ReturnType<typeof createCompletion>
  draw: () => void
}> {
  const emulator = createEmulator(COLUMNS, rows)
  const screen = new Screen(emulator.target)
  screen.commit(['TRANSCRIPT above list A', 'TRANSCRIPT above list B'])
  const composer = new Composer()
  composer.handle({ kind: 'text', text: typed })
  const composerView = createComposerView(composer, '/work')
  const status = createStatusView(() => ({
    busy: false,
    tick: 0,
    elapsedMs: undefined,
    activityWord: 'waiting',
    activity: undefined,
    model: 'deepseek-v4-flash',
    effort: undefined,
    usage: undefined,
    tokens: undefined,
    contextWindow: undefined,
    detail: 'compact',
    work: undefined,
    pending: undefined,
    todo: undefined,
    plan: false,
    goal: undefined,
  }))
  const completion = createCompletion(composer, {
    commands: () => COMMANDS,
    commandArguments: async () => [],
    paths: async () => [],
  }, () => {})
  await completion.refresh()
  const slots = new TuiSlots(new Context())
  slots.register('composer', composerView)
  slots.register('completion', completion.view)
  slots.register('status', status)
  const draw = (): void => { screen.setLive(slots.compose(COLUMNS, rows).lines) }
  return { emulator, completion, draw }
}

describe('the suggestion list on a real terminal', () => {
  it.each([24, 14, 10, 8])('keeps the composer on screen in a %i-row terminal', async rows => {
    const { emulator, completion, draw } = await terminal(rows)
    draw()
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)
    // The prompt the list is completing must never be the thing scrolled away:
    // it is where the keystrokes are going.
    expect((await emulator.screen()).join('\n')).toContain('/command')

    // Walk the whole list, twice over the wrap-around.
    for (let press = 0; press < 32; press += 1) {
      completion.handleKey({ kind: 'key', name: 'down' })
      draw()
    }
    expect((await emulator.screen()).length).toBeLessThanOrEqual(rows)
    const history = await emulator.scrollback()
    expect(history.filter(line => line.includes('TRANSCRIPT above list A'))).toHaveLength(1)
    expect(history.filter(line => line.includes('TRANSCRIPT above list B'))).toHaveLength(1)
    // The composer's frame appears once, wherever the live region currently sits.
    // A list taller than the screen scrolls that top border out of reach, and the
    // next redraw climbs too few rows and writes a SECOND copy below the first —
    // which is what a reader on a short terminal actually sees go wrong.
    expect(history.filter(line => line.includes('\u256d\u2500 dshline'))).toHaveLength(1)
  })

  it.each([24, 20, 18, 16, 14])('yields to a full-height composer in a %i-row terminal', async rows => {
    // The composer is allowed ten content rows plus its frame and separating
    // blank — thirteen — and the status line takes another. A list that budgets
    // against the terminal's own height instead of what is left of it fits none
    // of that, and the live region grows past the screen.
    const tall = `${Array.from({ length: 14 }, (_unused, i) => `line ${String(i)}`).join('\n')}\n/command`
    const { emulator, completion, draw } = await terminal(rows, tall)
    draw()
    const screen = await emulator.screen()
    expect(screen.length, `${String(rows)} rows`).toBeLessThanOrEqual(rows)
    // The prompt is where the keystrokes are going. It is never the thing that
    // gets pushed off to make room for a list about it.
    expect(screen.join('\n')).toContain('/command')
    for (let press = 0; press < 20; press += 1) {
      completion.handleKey({ kind: 'key', name: 'down' })
      draw()
    }
    expect((await emulator.screen()).length, `${String(rows)} rows after scrolling`).toBeLessThanOrEqual(rows)
    const history = await emulator.scrollback()
    expect(history.filter(line => line.includes('╭─ dshline'))).toHaveLength(1)
    expect(history.filter(line => line.includes('TRANSCRIPT above list A'))).toHaveLength(1)
  })

  it('gives up entirely rather than crowd a composer that fills the screen', async () => {
    // Two rows of chrome and no candidate is not a smaller list, it is a claim
    // that completions exist with every one of them hidden. Typing one more
    // character narrows the candidates; that is how it comes back.
    const tall = `${Array.from({ length: 14 }, (_unused, i) => `line ${String(i)}`).join('\n')}\n/command`
    const { emulator, draw } = await terminal(15, tall)
    draw()
    const screen = (await emulator.screen()).join('\n')
    expect(screen).not.toContain('complete · esc dismiss')
    expect(screen).toContain('/command')
    expect((await emulator.screen()).length).toBeLessThanOrEqual(15)
  })

  it('empties its count as the highlight reaches the end', async () => {
    const { emulator, completion, draw } = await terminal(24)
    draw()
    expect((await emulator.screen()).join('\n')).toContain('9 more')
    for (let press = 0; press < 14; press += 1) completion.handleKey({ kind: 'key', name: 'down' })
    draw()
    const screen = (await emulator.screen()).join('\n')
    expect(screen).toContain('command-last-sentinel')
    expect(screen).toContain('15/15')
    expect(screen).not.toContain('more')
  })
})

describe('the hint and the completion list', () => {
  it('gives the hint up to the first character typed, list and all', async () => {
    // An empty composer carries the hint; a `/` carries a completion list. The
    // two never coexist, because the branch that draws the hint is gated on the
    // buffer being empty — so a list can open over real text without the hint
    // sitting beside what the reader is completing.
    const empty = await terminal(24, '')
    empty.draw()
    const idle = (await empty.emulator.screen()).map(row => row.trimEnd()).join('\n')
    expect(idle).toContain('ask anything')

    const typing = await terminal(24, '/comm')
    typing.draw()
    const listed = (await typing.emulator.screen()).map(row => row.trimEnd()).join('\n')
    expect(listed).not.toContain('ask anything')
    expect(listed).not.toContain('/ menu')
    expect(listed).toContain('/comm')
  })

  it('leaves the hint out of what a completion is computed from', async () => {
    // The hint is not in the buffer, so it is invisible to completion: the token
    // under the cursor comes from `lineBeforeCursor`, which is derived from the
    // characters the reader actually typed.
    const frame = await terminal(24, '')
    expect(frame.completion.active).toBe(false)
  })
})
