import { describe, expect, it, vi } from 'vitest'
import * as widths from '../src/width.ts'
import type { ScreenTarget } from '../src/index.ts'
import { Screen } from '../src/index.ts'
import { createEmulator } from '../../../tests/emulator.ts'

/**
 * A screen target that records writes and models the one thing the redraw
 * arithmetic depends on: how many rows the cursor is asked to move.
 */
function fakeTarget(columns = 20): ScreenTarget & {
  readonly writes: string[]
  all: () => string
  resize: (columns: number) => void
} {
  const writes: string[] = []
  let width = columns
  return {
    writes,
    all: () => writes.join(''),
    write: chunk => { writes.push(chunk) },
    columns: () => width,
    resize: next => { width = next },
  }
}

/** Cursor-up counts in order, so a redraw's row math is directly assertable. */
function cursorUps(text: string): number[] {
  return [...text.matchAll(/\u001b\[(\d+)A/gu)].map(match => Number(match[1]))
}

describe('Screen', () => {
  it('draws a first live region without moving the cursor up', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two'])
    expect(cursorUps(target.all())).toEqual([])
    expect(screen.height).toBe(2)
  })

  it('climbs exactly the rows it drew when replacing the region', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two', 'three'])
    target.writes.length = 0
    screen.setLive(['only'])
    // Three rows drawn means two climbs from the bottom row to the first.
    expect(cursorUps(target.all())).toEqual([2])
    expect(screen.height).toBe(1)
  })

  it('counts wrapped rows, not logical lines', () => {
    const target = fakeTarget(10)
    const screen = new Screen(target)
    // Twenty-four columns of text at width ten occupies three rows.
    screen.setLive(['aaaa bbbb cccc dddd eeee'])
    expect(screen.height).toBe(3)
    target.writes.length = 0
    screen.setLive(['short'])
    expect(cursorUps(target.all())).toEqual([2])
  })

  it('counts a CJK line by display columns', () => {
    const target = fakeTarget(8)
    const screen = new Screen(target)
    // Eight ideographs are sixteen columns: two rows at width eight.
    screen.setLive(['标准模式标准模式'])
    expect(screen.height).toBe(2)
  })

  it('descends from a placed cursor before climbing, so the erase starts at the top', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two', 'three'], { row: 0, column: 0 })
    target.writes.length = 0
    screen.setLive(['next'])
    const frame = target.all()
    // The cursor was left on row 0, so the erase must first descend two rows to
    // the bottom, then climb two back to the top.
    expect([...frame.matchAll(/\u001b\[(\d+)B/gu)].map(m => Number(m[1]))).toEqual([2])
    expect(cursorUps(frame)).toEqual([2])
  })

  it('keeps the live region below committed output', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['composer'])
    target.writes.length = 0
    screen.commit(['a committed line'])
    const frame = target.all()
    expect(frame.indexOf('a committed line')).toBeLessThan(frame.indexOf('composer'))
    // The region is still one row tall afterwards, so the next redraw climbs it.
    expect(screen.height).toBe(1)
  })

  it('redraws the region after committing so later erases stay aligned', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two'])
    screen.commit(['committed'])
    target.writes.length = 0
    screen.setLive(['replaced'])
    expect(cursorUps(target.all())).toEqual([1])
  })

  it('ignores an empty commit rather than emitting a stray newline', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['live'])
    target.writes.length = 0
    screen.commit([])
    expect(target.writes).toEqual([])
  })

  it('places the cursor by display columns, not code units', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['> 标准'], { row: 0, column: 6 })
    expect(target.all()).toContain('\u001b[6C')
  })

  it('forgets teardown geometry even when the cursor restoration write fails', () => {
    const failure = new Error('screen shutdown write failed')
    let fail = false
    const writes: string[] = []
    const screen = new Screen({
      columns: () => 20,
      write: chunk => { if (fail) throw failure; writes.push(chunk) },
    })
    screen.setLive(['one', 'two', 'three'], { row: 0, column: 2 })
    fail = true
    expect(() => screen.close()).toThrow(failure)
    expect(screen.height).toBe(0)
    fail = false
    writes.length = 0
    screen.close()
    // No second climb over geometry a failed write may already have erased.
    expect(cursorUps(writes.join(''))).toEqual([])
    expect(writes.join('')).toContain('\u001b[?25h')
  })

  it('restores the cursor on close and forgets the region', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two'])
    target.writes.length = 0
    screen.close()
    expect(target.all()).toContain('\u001b[?25h')
    expect(screen.height).toBe(0)
    target.writes.length = 0
    screen.setLive(['fresh'])
    expect(cursorUps(target.all())).toEqual([])
  })

  it('still writes the first draw of an empty region, hiding the cursor', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    // Startup composes empty regions several times before the first real
    // frame; those draws are where the cursor gets hidden, not repeats.
    screen.setLive([])
    expect(target.all()).toContain('\u001b[?25l')
  })

  it('writes nothing when the drawn rows and cursor are unchanged', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two'], { row: 1, column: 2 })
    expect(screen.height).toBe(2)
    target.writes.length = 0
    screen.setLive(['one', 'two'], { row: 1, column: 2 })
    expect(target.writes).toEqual([])
    expect(screen.height).toBe(2)
  })

  it('still writes when only the cursor moves within unchanged rows', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two'], { row: 1, column: 2 })
    target.writes.length = 0
    screen.setLive(['one', 'two'], { row: 1, column: 4 })
    expect(target.all()).toContain('\u001b[4C')
  })

  it('still writes when the cursor appears or disappears over unchanged rows', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two'], { row: 0, column: 0 })
    target.writes.length = 0
    screen.setLive(['one', 'two'])
    expect(target.all()).not.toBe('')
    // And the way back: a redraw that places a cursor over the same rows must
    // not be swallowed by the skip either.
    target.writes.length = 0
    screen.setLive(['one', 'two'], { row: 0, column: 1 })
    expect(target.all()).not.toBe('')
  })

  it('keeps erase arithmetic exact across skipped redraws', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two'])
    // Two frames that skip leave the region exactly as the first draw built it.
    screen.setLive(['one', 'two'])
    screen.setLive(['one', 'two'])
    target.writes.length = 0
    screen.setLive(['only'])
    expect(cursorUps(target.all())).toEqual([1])
    expect(screen.height).toBe(1)
  })

  it('rewrites when wrapping changes even though the logical lines repeat', () => {
    const target = fakeTarget(20)
    const screen = new Screen(target)
    screen.setLive(['aaaa bbbb cccc dddd'])
    expect(screen.height).toBe(1)
    target.resize(8)
    target.writes.length = 0
    screen.setLive(['aaaa bbbb cccc dddd'])
    expect(target.all()).not.toBe('')
    expect(screen.height).toBeGreaterThan(1)
  })

  it('rewrites an identical frame after markStale, then skips again', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['one', 'two'])
    screen.setLive(['one', 'two'])
    // Something cleared or reflowed the screen behind this class's back: the
    // cached frame matches, but the pixels may not.
    screen.markStale()
    target.writes.length = 0
    screen.setLive(['one', 'two'])
    expect(target.all()).not.toBe('')
    expect(screen.height).toBe(2)
    // Trust resumes with the rewrite; the frame after it is a repeat again.
    target.writes.length = 0
    screen.setLive(['one', 'two'])
    expect(target.writes).toEqual([])
  })
})

describe('Screen cursor accounting', () => {
  it('does not skip an identical frame after the width changed', () => {
    // A resize reflows the pixels the terminal already holds, so the same rows
    // at a new width are not the same picture; skipping would leave the
    // terminal's reflow uncorrected.
    const target = fakeTarget(20)
    const screen = new Screen(target)
    screen.setLive(['short'])
    target.resize(8)
    target.writes.length = 0
    screen.setLive(['short'])
    expect(target.writes).not.toEqual([])
  })
})

describe('Screen cursor placement against a real terminal', () => {
  it('erases exactly the rows it drew when the requested cursor row was negative', async () => {
    // `drawLive` clamps the placement into the region; the NEXT erase descends
    // from wherever that clamp left the cursor. Caching the raw request instead
    // made the descent overshoot the bottom and the climb start below the
    // region's first row, so CLEAR_BELOW never reached the old frame's top.
    const emulator = createEmulator(20, 6)
    const screen = new Screen(emulator.target)
    screen.setLive(['top', 'mid', 'bot'], { row: -2, column: 0 })
    screen.setLive(['new'])
    expect(await emulator.scrollback()).toEqual(['new'])
    emulator.dispose()
  })
})

// Damage is confined to a stable, current live region; geometry changes retain
// the existing full erase path. These assertions protect both bandwidth and cells.
describe('Screen row damage', () => {
  it('writes only changed rows, not unchanged composer chrome', () => {
    const target = fakeTarget(40)
    const screen = new Screen(target)
    screen.setLive(['stream before', 'unchanged composer', 'unchanged status'], { row: 1, column: 2 })
    target.writes.length = 0
    screen.setLive(['stream after', 'unchanged composer', 'unchanged status'], { row: 1, column: 2 })
    expect(target.all()).toContain('stream after')
    expect(target.all()).not.toContain('unchanged composer')
    expect(target.all()).not.toContain('unchanged status')
    expect(target.all()).not.toContain('\u001b[0J')
  })

  it('moves the cursor without rewriting any unchanged row', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['first', 'second'], { row: 1, column: 2 })
    target.writes.length = 0
    screen.setLive(['first', 'second'], { row: 0, column: 3 })
    expect(target.all()).not.toContain('first')
    expect(target.all()).not.toContain('second')
    expect(target.all()).not.toContain('\u001b[0K')
  })

  it('replaces wide and styled rows without disturbing scrollback or neighboring cells', async () => {
    const emulator = createEmulator(12, 8)
    const screen = new Screen(emulator.target)
    screen.commit(['history'])
    screen.setLive(['\u001b[31m标准模式\u001b[0m', 'neighbor', 'bottom'], { row: 1, column: 3 })
    screen.setLive(['\u001b[32me\u0301\u001b[0m', 'neighbor', 'new bottom'], { row: 0, column: 1 })
    expect(await emulator.screen()).toEqual(['history', 'é', 'neighbor', 'new bottom'])
    expect(await emulator.cell(0, 1)).toMatchObject({ fg: 2 })
    expect(await emulator.cell(0, 2)).toMatchObject({ chars: 'n', fg: undefined })
    expect(await emulator.cursor()).toEqual({ row: 1, column: 1 })
    screen.commit(['next'])
    screen.close()
    expect(await emulator.scrollback()).toEqual(['history', 'next'])
    emulator.dispose()
  })

  it('cancels right-margin wrap before moving from a hidden cursor', async () => {
    const emulator = createEmulator(8, 6)
    const screen = new Screen(emulator.target)
    screen.commit(['history'])
    screen.setLive(['12345678', 'abcdefgh'])
    screen.setLive(['short', 'abcdefgh'])
    expect(await emulator.screen()).toEqual(['history', 'short', 'abcdefgh'])
    screen.setLive(['short', 'xy'], { row: 0, column: 2 })
    expect(await emulator.screen()).toEqual(['history', 'short', 'xy'])
    expect(await emulator.cursor()).toEqual({ row: 1, column: 2 })
    emulator.dispose()
  })

  it('does a full redraw after invalidation even with the same height', () => {
    const target = fakeTarget()
    const screen = new Screen(target)
    screen.setLive(['old', 'chrome'], { row: 0, column: 0 })
    screen.markStale()
    target.writes.length = 0
    screen.setLive(['new', 'chrome'], { row: 0, column: 0 })
    expect(target.all()).toContain('\u001b[0J')
    expect(target.all()).toContain('chrome')
  })
})


describe('Screen live wrap reuse', () => {
  it('wraps only new styled strings, and forgets old-width results on resize', () => {
    const wrap = vi.spyOn(widths, 'wrapToWidth')
    try {
      const target = fakeTarget(20)
      const screen = new Screen(target)
      screen.setLive(['stream', 'stable chrome'], { row: 1, column: 0 })
      wrap.mockClear()
      screen.setLive(['stream grows', 'stable chrome'], { row: 1, column: 0 })
      expect(wrap.mock.calls.map(call => call[0])).toEqual(['stream grows'])
      wrap.mockClear()
      target.resize(10)
      screen.setLive(['stream grows', 'stable chrome'], { row: 1, column: 0 })
      expect(wrap.mock.calls.map(call => call[0])).toEqual(['stream grows', 'stable chrome'])
    } finally {
      wrap.mockRestore()
    }
  })

  it('reuses rows after reordering but does not retain past-frame transcript rows', () => {
    const wrap = vi.spyOn(widths, 'wrapToWidth')
    try {
      const target = fakeTarget(20)
      const screen = new Screen(target)
      screen.setLive(['first', 'second'])
      wrap.mockClear()
      screen.setLive(['second', 'first'])
      expect(wrap).not.toHaveBeenCalled()
      screen.setLive(['third'])
      wrap.mockClear()
      screen.setLive(['first'])
      expect(wrap).toHaveBeenCalledWith('first', 20)
      screen.close()
      wrap.mockClear()
      screen.setLive(['first'])
      expect(wrap).toHaveBeenCalledWith('first', 20)
    } finally {
      wrap.mockRestore()
    }
  })
})

it('matches full redraw cells and cursor through mixed live frames and commits', async () => {
  const damaged = createEmulator(13, 10)
  const full = createEmulator(13, 10)
  const fast = new Screen(damaged.target)
  const reference = new Screen(full.target)
  const choices = ['unchanged', '标准模式', '\u001b[31mcolored\u001b[0m', 'e\u0301', '1234567890123', '', 'short']
  try {
    for (let frame = 0; frame < 48; frame += 1) {
      if (frame % 9 === 0) {
        fast.commit([`commit ${String(frame)}`])
        reference.commit([`commit ${String(frame)}`])
      }
      const count = 1 + Math.floor(frame / 6) % 4
      const lines = Array.from({ length: count }, (_, row) => choices[(frame + row * 3) % choices.length] ?? '')
      const cursor = frame % 3 === 0 ? undefined : { row: frame % count, column: frame % 8 }
      fast.setLive(lines, cursor)
      // An independent drawing path: force the original full erase/repaint.
      reference.markStale()
      reference.setLive(lines, cursor)
      expect(await damaged.scrollback()).toEqual(await full.scrollback())
      expect(await damaged.cursor()).toEqual(await full.cursor())
      for (let row = 0; row < 10; row += 1) {
        for (let column = 0; column < 13; column += 1) {
          expect(await damaged.cell(column, row)).toEqual(await full.cell(column, row))
        }
      }
    }
  } finally {
    damaged.dispose()
    full.dispose()
  }
})
