/**
 * What the status line actually says as a terminal narrows.
 *
 * The composition rules are three nested preferences deep, and a string
 * assertion at one width proves nothing about the width either side of it. The
 * failure worth catching is a segment that survives in HALF — a cut round count
 * or a cut goal state reads as a different fact, not as a smaller one — so this
 * resizes across the range a real window is dragged through and reads the cells.
 */

import { describe, expect, it } from 'vitest'
import { displayWidth, Screen } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import type { StatusState } from '../src/views.ts'
import { createStatusView } from '../src/views.ts'

/** A session with every mode reporting at once, which is the crowded case. */
const CROWDED: StatusState = {
  busy: true,
  tick: 0,
  elapsedMs: 866_000,
  activityWord: 'responding',
  activity: { title: 'run_shell_command', others: 2 },
  model: 'x-preview-f-free',
  effort: undefined,
  usage: '↑2.3M ↓21k',
  cacheRead: 'CR 99.8%',
  tokens: 68_000,
  contextWindow: 1_000_000,
  detail: 'compact',
  work: undefined,
  todo: 'todo 5/11',
  plan: false,
  replay: undefined,
  goal: { label: 'goal armed', running: true },
}

/**
 * Draw the status line on a real terminal and read the row back.
 * @param columns - the terminal width.
 * @returns the visible status row.
 */
async function row(columns: number): Promise<string> {
  const emulator = createEmulator(columns, 24)
  new Screen(emulator.target).setLive(createStatusView(() => CROWDED).render(columns))
  return (await emulator.screen()).map(line => line.trimEnd()).find(line => line !== '') ?? ''
}

describe('the status line on a real terminal', () => {
  it('never wraps onto a second row, at any width', async () => {
    for (const columns of [20, 30, 40, 50, 60, 72, 80, 100, 120, 160]) {
      const emulator = createEmulator(columns, 24)
      new Screen(emulator.target).setLive(createStatusView(() => CROWDED).render(columns))
      const drawn = (await emulator.screen()).map(line => line.trimEnd()).filter(line => line !== '')
      expect(drawn.length, `${String(columns)} columns: ${JSON.stringify(drawn)}`).toBe(1)
    }
  })

  it('keeps the permission on one row, inside the terminal, and never in half', async () => {
    // The permission is a body segment like any other, so the real terminal is
    // the only honest measure of whether it wrapped or was cut.
    const state: StatusState = { ...CROWDED, permission: 'danger-full-access' }
    for (const columns of [20, 26, 30, 40, 50, 60, 72, 80, 100, 120]) {
      const emulator = createEmulator(columns, 24)
      new Screen(emulator.target).setLive(createStatusView(() => state).render(columns))
      const drawn = (await emulator.screen()).map(line => line.trimEnd()).filter(line => line !== '')
      expect(drawn.length, `${String(columns)} columns: ${JSON.stringify(drawn)}`).toBe(1)
      const line = drawn[0] ?? ''
      for (const row of drawn) {
        expect(displayWidth(row), `${String(columns)} columns: ${JSON.stringify(row)}`).toBeLessThanOrEqual(columns)
      }
      // A leading fragment means a cut; the whole id or nothing is the rule.
      expect(
        line.includes('danger') ? line.includes('danger-full-access') : true,
        `${String(columns)} columns: ${JSON.stringify(line)}`,
      ).toBe(true)
    }
  })

  it('never leaves half a mode on the line', async () => {
    for (const columns of [20, 26, 30, 34, 40, 46, 52, 58, 64, 72, 80, 100, 120]) {
      const line = await row(columns)
      // The status carries the whole goal state and Todo count, never a cut segment.
      const halfGoal = /goal(?! armed)\S*\s*$/u.test(line)
      const halfTodo = line.includes('todo') && !line.includes('todo 5/11')
      expect(halfGoal || halfTodo, `${String(columns)} columns: ${JSON.stringify(line)}`)
        .toBe(false)
    }
  })

  it('keeps the goal state while giving up other status details', async () => {
    for (const columns of [120, 60, 58]) {
      const line = await row(columns)
      expect(line).toContain('goal armed')
      expect(line).not.toContain('ship the release')
    }
    const narrow = await row(58)
    expect(narrow).not.toContain('x-preview-f-free')
    expect(narrow).not.toContain('2.3M')
  })

  it('leads with the whole activity word and no mark, at every width', async () => {
    for (const columns of [20, 30, 40, 50, 60, 80, 120]) {
      const line = await row(columns)
      // The word is the indicator and opens the row in full at every width, with
      // nothing turning beside it to compete for the eye.
      expect(line, `${String(columns)} columns`).toMatch(/^ {2}responding/u)
    }
  })

  it('drops the turn elapsed as a whole fact before the word is ever cut', async () => {
    const roomy = await row(60)
    expect(roomy).toContain('· turn 14m 26s')
    // Narrower than the full status with the reading: the whole ` · turn`
    // segment yields, never a partial `· turn 14m 4`.
    const narrow = await row(20)
    expect(narrow).not.toContain('turn 14m')
    expect(narrow).toContain('responding')
    expect(narrow).not.toContain('…')
  })

  it('keeps the context reading on the rung where the elapsed alone yields', async () => {
    // A busy state with nothing but the word, the elapsed, and a pressure
    // reading: no modes, so the body ladder reaches its fallback cleanly.
    const state: StatusState = {
      busy: true,
      tick: 0,
      elapsedMs: 866_000,
      activityWord: 'responding',
      activity: undefined,
      model: undefined,
      effort: undefined,
      usage: undefined,
      cacheRead: undefined,
      tokens: 68_000,
      contextWindow: 1_000_000,
      detail: 'compact',
      work: undefined,
      queued: undefined,
      todo: undefined,
      plan: false,
      replay: undefined,
      goal: undefined,
    }
    const lineAt = async (columns: number): Promise<string> => {
      const emulator = createEmulator(columns, 24)
      new Screen(emulator.target).setLive(createStatusView(() => state).render(columns))
      return (await emulator.screen()).map(line => line.trimEnd()).find(line => line !== '') ?? ''
    }

    // Full: word + elapsed + reading all fit.
    const wide = await lineAt(120)
    expect(wide).toContain('responding · turn 14m 26s')
    expect(wide).toContain('68k/1.0M')
    // Middle: the elapsed yields first; the reading and the word stay whole.
    // This is the rung a spread of the styled `bareStatus` string used to skip.
    const middle = await lineAt(30)
    expect(middle).toContain('responding · 68k/1.0M')
    expect(middle).not.toContain('· turn')
    expect(middle).not.toContain('…')
    // Narrowest: the reading yields before the word is ever cut.
    const narrow = await lineAt(20)
    expect(narrow).toContain('responding')
    expect(narrow).not.toContain('68k/1.0M')
    expect(narrow).not.toContain('…')
  })

  it('lights whole cells of the activity word and nothing outside it, on a terminal', async () => {
    const emulator = createEmulator(80, 24)
    const screen = new Screen(emulator.target)
    const at = async (tick: number): Promise<{ text: string; cells: Array<{ fg: number | undefined; bold: boolean }> }> => {
      screen.setLive(createStatusView(() => ({ ...CROWDED, tick })).render(80))
      const rows = (await emulator.screen()).map(line => line.trimEnd())
      const index = rows.findIndex(line => line.includes('responding'))
      const cells: Array<{ fg: number | undefined; bold: boolean }> = []
      for (let column = 0; column < 32; column += 1) {
        const cell = await emulator.cell(column, index)
        cells.push({ fg: cell?.fg, bold: cell?.bold ?? false })
      }
      return { text: rows[index] ?? '', cells }
    }
    // Columns 0-1 are the gutter and 2-11 the ten columns of `responding`.
    const WORD = Array.from({ length: 10 }, (_unused, at) => 2 + at)
    const lit = await at(5)
    expect(lit.text).toContain('responding · turn 14m 26s')
    // The band is bold in the terminal's own foreground, over the busy accent,
    // and it never leaves the word: nothing after column 11 is lit.
    const bold = lit.cells.map(cell => cell.bold)
    const inWord = WORD.filter(column => bold[column] === true)
    expect(inWord.length).toBeGreaterThan(0)
    expect(inWord.length).toBeLessThanOrEqual(4)
    for (const column of inWord) expect(lit.cells[column]?.fg, `column ${String(column)}`).toBeUndefined()
    for (const column of WORD) {
      if (bold[column] !== true) expect(lit.cells[column]?.fg, `column ${String(column)}`).toBe(3)
    }
    expect(bold.slice(12).some(Boolean)).toBe(false)
    // The rest of the line is identical on every tick, styling included.
    const rest = await at(9)
    expect(rest.text).toBe(lit.text)
    expect(rest.cells.slice(12)).toEqual(lit.cells.slice(12))
    // And at rest the word is the busy accent end to end.
    const still = await at(15)
    expect(still.cells.filter((_cell, column) => WORD.includes(column)).every(cell => cell.fg === 3 && !cell.bold)).toBe(true)
    emulator.dispose()
  })

})

describe('the status line while a resumed session replays', () => {
  /** A resumed session mid-replay: agent idle, transcript still flooding in. */
  const REPLAYING: StatusState = {
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
    queued: undefined,
    todo: undefined,
    plan: false,
    goal: undefined,
    replay: 'replaying 12,431 events…',
  }

  /**
   * The status row at one width.
   * @param columns - the terminal width.
   * @returns the visible status row.
   */
  async function replayed(columns: number): Promise<string> {
    const emulator = createEmulator(columns, 24)
    new Screen(emulator.target).setLive(createStatusView(() => REPLAYING).render(columns))
    return (await emulator.screen()).map(line => line.trimEnd()).find(line => line !== '') ?? ''
  }

  it('never claims ready, and stays one row', async () => {
    for (const columns of [40, 60, 80, 120]) {
      const emulator = createEmulator(columns, 24)
      new Screen(emulator.target).setLive(createStatusView(() => REPLAYING).render(columns))
      const drawn = (await emulator.screen()).map(line => line.trimEnd()).filter(line => line !== '')
      expect(drawn.length, `${String(columns)} columns: ${JSON.stringify(drawn)}`).toBe(1)
      const line = drawn[0] ?? ''
      expect(line, `${String(columns)} columns`).toContain('replaying 12,431 events')
      expect(line, `${String(columns)} columns`).not.toContain('ready')
    }
  })

  it('shows the count whole across the widths a resize passes through', async () => {
    // A half count — `replaying 12,43` instead of `replaying 12,431` — would
    // be a different truth, not a smaller one. The fact is the status's first
    // segment, so it yields to nothing before an impossibly narrow terminal
    // truncates the bare segment exactly as it truncates a busy word.
    for (const columns of [30, 40, 60, 80, 120]) {
      const line = await replayed(columns)
      expect(line, `${String(columns)} columns`).toContain('replaying 12,431 events')
    }
  })

  it('yields to a running turn when both are true', async () => {
    const both: StatusState = { ...REPLAYING, busy: true, tick: 1, elapsedMs: 5000, activityWord: 'responding' }
    const emulator = createEmulator(80, 24)
    new Screen(emulator.target).setLive(createStatusView(() => both).render(80))
    const line = (await emulator.screen()).map(r => r.trimEnd()).find(r => r !== '') ?? ''
    expect(line).toContain('responding')
    // The turn is the more urgent fact; the replay notice waits behind it.
    expect(line).not.toContain('replaying 12,431')
  })
})
