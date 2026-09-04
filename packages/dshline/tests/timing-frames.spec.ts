/** Real-terminal frames for the persistent timing panel. */

import { Context } from '@deepseek-ai/cordis'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Composer, displayWidth, Screen } from '@dshline/renderer'
import { describe, expect, it, vi } from 'vitest'
import { createEmulator } from '../../../tests/emulator.ts'
import { createCompletion } from '../src/completion.ts'
import { TuiSlots } from '../src/slots.ts'
import { createTimingView, TurnTimer } from '../src/timing.ts'
import { createComposerView, createStatusView } from '../src/views.ts'

/** Standard frame width, narrow enough that bars have to make real trade-offs. */
const COLUMNS = 40

/** Standard frame height, small enough to exercise the panel's row budget. */
const ROWS = 12

/** One log event, with only the fields the timer reads. */
function event(time: number, type: string, data: unknown): SessionEvent {
  return { time, type, data } as unknown as SessionEvent
}

/** A streamed delta of one kind, at one moment, on the transient stream feed. */
function delta(time: number, type: 'reasoning-delta' | 'text-delta'): AssistantStreamFrame {
  return {
    type: 'chunk', attemptId: 's:0', revision: 1, index: 0, time, chunk: { type, text: 'x' },
  } as unknown as AssistantStreamFrame
}

/** Start one tool call. */
function call(time: number, callId: string, name: string): SessionEvent {
  return event(time, 'tool/call', { turn: 1, step: 0, callId, name, arguments: '{}' })
}

/** Finish one tool call. */
function result(time: number, callId: string): SessionEvent {
  return event(time, 'tool/result', {
    turn: 1,
    step: 0,
    message: { content: [{ toolCallId: callId }] },
  })
}

/** The plain non-empty rows a person currently sees. */
async function visible(emulator: ReturnType<typeof createEmulator>): Promise<string[]> {
  return (await emulator.screen()).map(row => row.trimEnd()).filter(row => row !== '')
}

/** Occurrences of one glyph across the given rows; only the timing chart draws ━. */
function countGlyph(rows: readonly string[], glyph: string): number {
  return rows.reduce((total, row) => total + row.split(glyph).length - 1, 0)
}

/**
 * Mount the real slot composition and Screen redraw path.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @param typed - optional multi-line composer content.
 * @returns state controls, the slot registry, and a draw function that places
 *   the hardware cursor exactly as the window does.
 */
function terminal(columns = COLUMNS, rows = ROWS, typed = '', hint?: { busy: boolean; busyEnter: 'queue' | 'steer' }): {
  readonly emulator: ReturnType<typeof createEmulator>
  readonly screen: Screen
  readonly timer: TurnTimer
  readonly enabled: { value: boolean }
  readonly slots: TuiSlots
  readonly composer: Composer
  /** One working-heartbeat tick, the only thing reveal progress follows. */
  readonly beat: () => void
  readonly draw: () => void
} {
  const emulator = createEmulator(columns, rows)
  const screen = new Screen(emulator.target)
  const timer = new TurnTimer()
  const enabled = { value: true }
  const slots = new TuiSlots(new Context())
  let heartbeat = 0
  const below = (): number => enabled.value ? 2 : 1
  const composer = new Composer()
  if (typed !== '') composer.handle({ kind: 'text', text: typed })
  slots.register('composer', createComposerView(
    composer,
    '/work',
    below,
    ...hint === undefined ? [] : [() => hint],
  ))
  slots.register('timing', createTimingView(timer, () => enabled.value, () => heartbeat))
  slots.register('status', createStatusView(() => ({
    busy: false,
    tick: 0,
    elapsedMs: undefined,
    activityWord: 'waiting',
    activity: undefined,
    model: undefined,
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
    goal: undefined,
  })))
  return {
    emulator,
    screen,
    timer,
    enabled,
    slots,
    composer,
    beat: () => {
      heartbeat += 1
    },
    draw: () => {
      // The window's own two-step: compose returns the cursor, and Screen is
      // what turns it into a hardware position. Drawing lines alone would make
      // every cursor assertion below vacuously pass.
      const { lines, cursor } = slots.compose(columns, rows)
      screen.setLive(lines, cursor)
    },
  }
}

describe('the timing live panel on a real terminal', () => {
  it('is present while on and leaves no row at all while off', async () => {
    const frame = terminal()
    frame.draw()
    expect((await visible(frame.emulator)).join('\n')).toContain('timing · no turn measured yet')

    frame.enabled.value = false
    frame.draw()
    const off = (await visible(frame.emulator)).join('\n')
    expect(off).not.toContain('timing')
    expect(off).toContain('ask anything')
    expect(off).toContain('ready')
  })

  it('grows open measurements between event batches and stops finished tools', async () => {
    let now = 5_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const frame = terminal()
    frame.timer.observe(event(1_000, 'turn/start', { turn: 1 }))
    frame.timer.observeFrame(delta(2_000, 'reasoning-delta'))
    frame.timer.observeFrame(delta(4_000, 'reasoning-delta'))
    frame.timer.observe(call(4_500, 'a', 'bash'))
    frame.draw()
    const first = (await visible(frame.emulator)).join('\n')
    expect(first).toContain('turn 1 · 4.0s · live')
    expect(first).toContain('0.5s')

    now = 8_000
    frame.timer.observe(result(7_000, 'a'))
    frame.draw()
    const second = (await visible(frame.emulator)).join('\n')
    expect(second).toContain('turn 1 · 7.0s · live')
    expect(second).toContain('2.5s')

    now = 20_000
    frame.draw()
    const third = (await visible(frame.emulator)).join('\n')
    expect(third).toContain('turn 1 · 19.0s · live')
    expect(third).toContain('2.5s')
    clock.mockRestore()
  })

  it('caps tool-heavy turns and keeps the whole live region on screen', async () => {
    const frame = terminal()
    frame.timer.observe(event(0, 'turn/start', { turn: 1 }))
    for (let index = 0; index < 12; index += 1) {
      const id = String(index)
      frame.timer.observe(call(index * 10, id, `tool-${id}`))
      frame.timer.observe(result(2_000 + index, id))
    }
    frame.timer.observe(event(3_000, 'turn/end', { turn: 1, reason: 'complete' }))
    frame.draw()
    const shown = await visible(frame.emulator)
    expect(shown.join('\n')).toContain('+8 more')
    expect(frame.screen.height).toBe(11)
    expect(frame.screen.height).toBeLessThanOrEqual(ROWS)
    expect((await frame.emulator.scrollback()).filter(row => row.includes('timing'))).toHaveLength(1)
  })

  it('keeps its header present when a tall composer spends the rest of the screen', async () => {
    const rows = 16
    const typed = Array.from({ length: 20 }, (_unused, index) => `line ${String(index)}`).join('\n')
    const frame = terminal(COLUMNS, rows, typed)
    frame.timer.observe(event(0, 'turn/start', { turn: 1 }))
    frame.draw()
    const shown = (await visible(frame.emulator)).join('\n')
    expect(frame.screen.height).toBeLessThanOrEqual(rows)
    expect(shown).toContain('line 19')
    expect(shown).toContain('timing · turn 1')
    expect(shown).toContain('ready')
  })

  it('fits every logical panel row without wrapping on a narrow terminal', async () => {
    const columns = 14
    const frame = terminal(columns, ROWS)
    frame.timer.observe(event(0, 'turn/start', { turn: 88 }))
    frame.timer.observe(call(0, 'a', '工具\u001b[2J-name'))
    frame.timer.observe(result(12_345, 'a'))
    frame.timer.observe(event(12_345, 'turn/end', { turn: 88, reason: 'complete' }))
    frame.draw()
    const shown = await visible(frame.emulator)
    expect(shown.every(row => displayWidth(row) <= columns)).toBe(true)
    expect(shown.join('\n')).toContain('timing')
    expect((await frame.emulator.scrollback()).filter(row => row.includes('╭─ dshline'))).toHaveLength(1)
  })

  it('shows a placeholder after resume instead of fabricating timing history', async () => {
    // A resumed attachment deliberately has a fresh live-only fold. Its replay
    // omits streamed chunks, so reconstructing a historical chart would be false.
    const resumed = terminal()
    resumed.screen.commit(['● reply restored from the session log'])
    resumed.draw()
    const shown = (await visible(resumed.emulator)).join('\n')
    expect(shown).toContain('reply restored from the session log')
    expect(shown).toContain('timing · no turn measured yet')
    expect(shown).not.toContain('turn 1')
  })

  it('does not commit a finished timing panel beneath the reply', async () => {
    const frame = terminal()
    frame.timer.observe(event(0, 'turn/start', { turn: 1 }))
    frame.timer.observeFrame(delta(1_000, 'text-delta'))
    frame.timer.observeFrame(delta(2_000, 'text-delta'))
    frame.timer.observe(event(3_000, 'turn/end', { turn: 1, reason: 'complete' }))
    frame.screen.commit(['● finished reply'])
    frame.draw()
    const history = await frame.emulator.scrollback()
    expect(history.filter(row => row.includes('finished reply'))).toHaveLength(1)
    expect(history.filter(row => row.includes('timing'))).toHaveLength(1)
  })

  it('puts the cursor on the visible tail of a scrolled composer, never on the chrome below', async () => {
    // Ten rows is short enough that the panel's reservation scrolls the buffer:
    // the composer may draw five of fifteen wrapped rows, so its window is
    // exactly where render and cursor must agree.
    const typed = Array.from({ length: 15 }, (_unused, index) => `row ${String(index)}`).join('\n')
    const frame = terminal(COLUMNS, 10, typed)
    frame.draw()
    const place = await frame.emulator.cursor()
    // Asserted against what a person sees: the hardware cursor must sit ON the
    // visible tail row. A frame that looks right while the cursor points into
    // the timing or status row beneath it is precisely the old fault.
    const shown = await frame.emulator.screen()
    const tailRow = shown.findIndex(row => row.includes('row 14'))
    expect(tailRow).toBeGreaterThan(-1)
    expect(place.row).toBe(tailRow)
    expect((await frame.emulator.cell(place.column, place.row))?.chars).not.toBe('')
  })

  it('sheds the empty frame\'s separator before the panel\'s header on a small terminal', () => {
    // Five rows cannot hold the four-row frame beside the reservation, so the
    // decorative blank goes while every promise stays: input, header, status.
    const frame = terminal(COLUMNS, 5)
    const { lines } = frame.slots.compose(COLUMNS, 5)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain('╭')
    const joined = lines.join('\n')
    expect(joined).toContain('ask anything')
    expect(joined).toContain('timing · no turn measured yet')
    expect(joined).toContain('ready')
    // One row more of room restores the decoration first, pinning the ladder.
    const roomier = frame.slots.compose(COLUMNS, 6).lines
    expect(roomier[0]).toBe('')
    expect(roomier).toHaveLength(6)
  })

  it('moves the empty-frame cursor up with the shed separator', () => {
    const frame = terminal()
    expect(frame.slots.compose(COLUMNS, ROWS).cursor?.row).toBe(2)
    expect(frame.slots.compose(COLUMNS, 5).cursor?.row).toBe(1)
  })

  it('keeps input usable when even the reservation cannot hold, and yields the panel', async () => {
    // Four rows: below the ladder's floor. Usability outranks the reservation
    // there — the same priority that lets the panel give up body rows ahead of
    // its header — so the panel goes whole rather than the input box.
    const frame = terminal(COLUMNS, 4)
    frame.draw()
    expect(frame.screen.height).toBeLessThanOrEqual(4)
    const joined = (await visible(frame.emulator)).join('\n')
    expect(joined).toContain('ask anything')
    expect(joined).toContain('ready')
    expect(joined).not.toContain('timing')
  })

  it('sheds the separator on a filled frame too, so a paste still fits a five-row terminal', async () => {
    const typed = Array.from({ length: 30 }, (_unused, index) => `pasted ${String(index)}`).join('\n')
    const frame = terminal(COLUMNS, 5, typed)
    frame.draw()
    expect(frame.screen.height).toBeLessThanOrEqual(5)
    const joined = (await visible(frame.emulator)).join('\n')
    // Scrolled, not lost: the elision count says what the window gave up.
    expect(joined).toContain('+29 rows')
    expect(joined).toContain('no turn measured yet')
    expect(joined).toContain('ready')
  })

  it('holds composer, completion, timing, and status together on a short terminal', async () => {
    // The whole ordinary composition at once: a slash command mid-word opens the
    // suggestion list while the panel is live, and every reservation has to hold.
    const frame = terminal(COLUMNS, 14, '/tim')
    const completion = createCompletion(frame.composer, {
      commands: () => [
        { name: 'timing', description: 'live turn panel' },
        { name: 'todos', description: 'todo list' },
        { name: 'tool-output', description: 'inspector' },
        { name: 'profiles', description: 'profile browser' },
        { name: 'plugins', description: 'plugin list' },
        { name: 'sessions', description: 'session browser' },
        { name: 'usage', description: 'cost reading' },
      ],
      commandArguments: async () => [],
      paths: async () => [],
    }, () => {}, () => 2)
    await completion.refresh()
    expect(completion.active).toBe(true)
    frame.slots.register('completion', completion.view)
    // A start near the real clock, because an OPEN turn reads its total
    // provisionally against Date.now(): starting at zero would chart the age of
    // the epoch and push the `live` mark onto a narrower heading.
    frame.timer.observe(event(Date.now() - 4_000, 'turn/start', { turn: 1 }))
    frame.draw()
    expect(frame.screen.height).toBeLessThanOrEqual(14)
    const shown = await visible(frame.emulator)
    const joined = shown.join('\n')
    expect(joined).toContain('timing · turn 1')
    expect(joined).toContain('· live')
    expect(joined).toContain('ready')
    // The cursor belongs to the text being completed, with the list open above
    // the panel — not to whatever chrome the shrinking budgets left below.
    // Indexed against the RAW screen: `visible()` drops blank rows, and the
    // separator blank is exactly what shifts positional indices here.
    const place = await frame.emulator.cursor()
    expect((await frame.emulator.screen())[place.row] ?? '').toContain('/tim')
  })

  it('eases a new live bar in across heartbeats while event renders cannot spend it', async () => {
    let now = 5_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const frame = terminal()
      // The placeholder render establishes the live panel, so the first span
      // arrives into something already on screen.
      frame.timer.observe(event(1_000, 'turn/start', { turn: 1 }))
      frame.draw()
      frame.timer.observeFrame(delta(2_000, 'reasoning-delta'))
      frame.timer.observeFrame(delta(4_000, 'reasoning-delta'))
      frame.draw()
      const rows = await visible(frame.emulator)
      // The measured duration is real from the very first frame: only the
      // bar's width eases toward its target, never the number beside it.
      expect(rows.join('\n')).toContain('2.0s')
      const partial = countGlyph(rows, '━')
      expect(partial).toBeGreaterThan(0)
      expect(partial).toBeLessThan(20)
      // Streamed chunks redraw the panel many times inside one heartbeat; not
      // one of those renders may spend reveal progress.
      frame.draw()
      frame.draw()
      expect(countGlyph(await visible(frame.emulator), '━')).toBe(partial)
      // Heartbeats are what age the bar toward its mathematically correct
      // width: twenty cells for the longest row, track gone when it lands.
      frame.beat()
      frame.draw()
      expect(countGlyph(await visible(frame.emulator), '━')).toBeGreaterThan(partial)
      frame.beat()
      frame.beat()
      frame.draw()
      expect(countGlyph(await visible(frame.emulator), '━')).toBe(20)
    } finally {
      clock.mockRestore()
    }
  })

  it('finishes a mid-reveal bar the moment the turn ends', async () => {
    let now = 5_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const frame = terminal()
      frame.timer.observe(event(1_000, 'turn/start', { turn: 1 }))
      frame.draw()
      frame.timer.observeFrame(delta(2_000, 'reasoning-delta'))
      frame.timer.observeFrame(delta(4_000, 'reasoning-delta'))
      frame.draw()
      const partial = countGlyph(await visible(frame.emulator), '━')
      expect(partial).toBeGreaterThan(0)
      expect(partial).toBeLessThan(20)
      // The turn closes before a single heartbeat passes: the working spinner
      // stops with it, so the retained panel must draw the real width at once
      // rather than freeze mid-reveal forever.
      frame.timer.observe(event(5_000, 'turn/end', { turn: 1 }))
      frame.draw()
      const finishedRows = await visible(frame.emulator)
      expect(finishedRows.join('\n')).toContain('2.0s')
      expect(countGlyph(finishedRows, '━')).toBe(20)
      // Additional idle renders stay final; no ticks are spent on decoration.
      frame.draw()
      frame.draw()
      expect(countGlyph(await visible(frame.emulator), '━')).toBe(20)
    } finally {
      clock.mockRestore()
    }
  })

  it('shows a toggled-on panel at full width immediately', async () => {
    let now = 5_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const frame = terminal()
      frame.enabled.value = false
      frame.timer.observe(event(1_000, 'turn/start', { turn: 1 }))
      frame.timer.observeFrame(delta(2_000, 'reasoning-delta'))
      frame.timer.observeFrame(delta(4_000, 'reasoning-delta'))
      frame.enabled.value = true
      frame.draw()
      const row = (await visible(frame.emulator)).find(candidate => candidate.includes('reasoning')) ?? ''
      // Spans folded before the panel appeared are history, not arrivals:
      // the longest row is the full scale, twenty cells with no track.
      expect(row.split('━').length - 1).toBe(20)
      expect(row).not.toContain('─')
    } finally {
      clock.mockRestore()
    }
  })
})

describe("the empty composer's hint beside the rest of the live region", () => {
  it('never pushes the region past the physical screen, however small', async () => {
    // The whole live region at once — composer, timing panel, status — on
    // terminals small enough that a wrapped hint used to overflow. Through an
    // emulator rather than by counting the composed array, because three wrap
    // passes run over this text and only the terminal reports what a person
    // ends up looking at.
    for (const columns of [12, 16, 18, 19, 20, 28, 40]) {
      for (const height of [4, 5, 6, 8, 12]) {
        for (const state of [
          { busy: false, busyEnter: 'queue' } as const,
          { busy: true, busyEnter: 'steer' } as const,
        ]) {
          const frame = terminal(columns, height, '', state)
          frame.draw()
          const shown = await visible(frame.emulator)
          const where = `${String(columns)}x${String(height)} ${state.busy ? 'busy' : 'idle'}`
          expect(shown.length, where).toBeLessThanOrEqual(height)
          for (const row of shown) expect(displayWidth(row), where).toBeLessThanOrEqual(columns)
        }
      }
    }
  })

  it('occupies the same rows at every width, so narrowing never shrinks the region', async () => {
    // The invariant that makes the region's shrink path irrelevant here: a hint
    // that changed row count across widths would shrink the composer, and a
    // region that shrinks has to erase what it vacated or it leaves duplicate
    // composer rows in the reader's real scrollback. One row at every width
    // means there is nothing to vacate.
    const heights: number[] = []
    for (const columns of [16, 20, 28, 40, 80]) {
      const frame = terminal(columns, 10, '', { busy: false, busyEnter: 'queue' })
      frame.draw()
      const shown = await visible(frame.emulator)
      heights.push(shown.length)
      // And exactly one row carries the prompt, at whichever rung the width
      // allows — the glyph is the composer's alone, so a second occurrence would
      // be a wrapped or duplicated body row.
      const carrying = shown.filter(row => row.includes('\u203a'))
      expect(carrying, `${String(columns)} columns`).toHaveLength(1)
    }
    expect(new Set(heights).size, `row counts were ${heights.join(',')}`).toBe(1)
  })

  it('replaces the idle hint with the busy one, and never shows both', async () => {
    const idle = terminal(40, 10, '', { busy: false, busyEnter: 'queue' })
    idle.draw()
    const idleRows = (await visible(idle.emulator)).join('\n')
    expect(idleRows).toContain('ask anything')
    expect(idleRows).not.toContain('type to')

    const busy = terminal(40, 10, '', { busy: true, busyEnter: 'queue' })
    busy.draw()
    const busyRows = (await visible(busy.emulator)).join('\n')
    expect(busyRows).toContain('type to queue')
    expect(busyRows).not.toContain('ask anything')
  })
})
