/**
 * The bounded read-only goal inspector: geometry, scrolling, escaping, and the
 * key contract.
 *
 * The authority split is tested where the authorities live (`goals.spec.ts` and
 * `goal-attachment.spec.ts`). This file drives the overlay directly, so the
 * report's own layout is tested at geometries a real terminal can present —
 * including the ones that must degrade rather than overflow — without a window
 * or a session.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalActivation, GoalPhase } from '@deepseek-ai/dsh-goal'
import { stripAnsi, type Key } from '@dshline/renderer'
import { createGoalOverlay } from '../src/goals/overlay.ts'
import type { GoalInspection } from '../src/goals/model.ts'
import { expectPhysicallyBounded, expectWholeHelp } from './surface-contracts.ts'

/**
 * One current-goal reading for the overlay.
 * @param over - the fields a test varies; the rest are ordinary.
 * @returns the reading.
 */
function reading(over: {
  objective?: string
  phase?: GoalPhase
  activation?: GoalActivation | undefined
  roundsStarted?: number
  maxGoalRounds?: number
  blocker?: { code: string; message: string }
  id?: string
  createdAt?: number
  updatedAt?: number
} = {}): GoalInspection {
  const phase = over.phase ?? 'active'
  return {
    kind: 'goal',
    goal: {
      id: GoalId(over.id ?? 'goal-1'),
      revision: 4,
      objective: over.objective ?? 'ship it',
      phase,
      maxGoalRounds: over.maxGoalRounds ?? 8,
      ...over.blocker === undefined ? {} : { blockedReason: over.blocker },
    },
    roundsStarted: over.roundsStarted ?? 3,
    createdAt: over.createdAt ?? 1_000,
    updatedAt: over.updatedAt ?? 2_000,
    // The overlay ignores activation for a stopped phase, so only an active
    // reading needs the distinction between absent and explicitly unknown.
    activation: phase === 'active' ? ('activation' in over ? over.activation : 'disarmed') : undefined,
  }
}

/** A named key event. */
function key(name: string): Key {
  return { kind: 'key', name } as Key
}

/** Build an overlay over a mutable reading and count its closes. */
function overlayFor(initial: GoalInspection): {
  overlay: ReturnType<typeof createGoalOverlay>
  set: (next: GoalInspection) => void
  closes: () => number
  invalidations: () => number
} {
  let current = initial
  let closes = 0
  let invalidations = 0
  const overlay = createGoalOverlay({
    reading: () => current,
    invalidate: () => { invalidations += 1 },
    close: () => { closes += 1 },
  })
  return {
    overlay,
    set: next => { current = next },
    closes: () => closes,
    invalidations: () => invalidations,
  }
}

/** Rendered rows with styling removed, for text assertions. */
function plain(overlay: { render: (columns: number, rows?: number) => readonly string[] }): string[] {
  return overlay.render(80, 24).map(stripAnsi)
}

describe('the goal inspector report', () => {
  it('shows Phase and Continuation as separate facts', () => {
    const { overlay } = overlayFor(reading({ objective: 'migrate the adapter' }))
    const text = plain(overlay).join('\n')
    expect(text).toContain('Goal')
    expect(text).toMatch(/Phase\s+active/)
    expect(text).toMatch(/Continuation\s+disarmed/)
    expect(text).toMatch(/Rounds\s+3\/8/)
    expect(text).toMatch(/Revision\s+4/)
    expect(text).toContain('migrate the adapter')
    // The footer's `idle` word is NOT reused: the report says what it is.
    expect(text).not.toContain('goal idle')
  })

  it('says unavailable rather than armed when activation cannot be read', () => {
    const { overlay } = overlayFor(reading({ activation: undefined }))
    expect(plain(overlay).join('\n')).toMatch(/Continuation\s+unavailable/)
  })

  it('reports a stopped phase as not continuing without consulting activation', () => {
    const { overlay } = overlayFor(reading({ phase: 'paused', activation: 'armed' }))
    const text = plain(overlay).join('\n')
    expect(text).toMatch(/Phase\s+paused/)
    expect(text).toMatch(/Continuation\s+not active/)
  })

  it('reports a blocked goal with its code and message', () => {
    const { overlay } = overlayFor(reading({
      phase: 'blocked',
      blocker: { code: 'awaiting-input', message: 'Need the approved specification' },
    }))
    const text = plain(overlay).join('\n')
    expect(text).toMatch(/Phase\s+blocked/)
    expect(text).toContain('awaiting-input')
    expect(text).toContain('Need the approved specification')
  })

  it('names each absence instead of showing a goal', () => {
    expect(plainFor({ kind: 'projections-unavailable' }).join('\n'))
      .toContain('Session projections are unavailable in this profile.')
    expect(plainFor({ kind: 'unregistered' }).join('\n'))
      .toContain('The goal projection is not published in this profile.')
    expect(plainFor({ kind: 'none' }).join('\n')).toContain('No goal is set for this session.')
  })
})

/** Render one absence reading at ordinary geometry. */
function plainFor(reading: GoalInspection): string[] {
  const { overlay } = overlayFor(reading)
  return plain(overlay)
}

describe('the goal inspector safety', () => {
  it('escapes controls before drawing and never lets one operate the terminal', () => {
    const { overlay } = overlayFor(reading({
      objective: 'safe \u001b[2J \u001b]0;title\u0007 end',
    }))
    const raw = overlay.render(80, 24).join('\n')
    // The escape is shown as caret notation; the raw CSI/OSC never reaches the
    // terminal as a sequence.
    expect(raw).toContain('^[[2J')
    expect(raw).toContain('^[]0;title^G')
    expect(raw).not.toContain('\u001b[2J')
    expect(raw).not.toContain('\u001b]0;')
    // The row carrying the display-safe text is colour-closed on that row.
    const row = overlay.render(80, 24).find(line => line.includes('safe'))
    expect(row?.endsWith('\u001b[0m')).toBe(true)
  })

  it('preserves blank lines in the objective instead of collapsing them', () => {
    const { overlay } = overlayFor(reading({ objective: 'alpha\n\nomega' }))
    const rows = plain(overlay)
    const alpha = rows.findIndex(row => row.includes('alpha'))
    const omega = rows.findIndex(row => row.includes('omega'))
    expect(alpha).toBeGreaterThanOrEqual(0)
    // The blank logical line occupies exactly one row between them.
    expect(omega - alpha).toBe(2)
  })

  it('keeps East Asian prose inside the frame', () => {
    const { overlay } = overlayFor(reading({ objective: '目标'.repeat(40) }))
    expectPhysicallyBounded(overlay, 40, 24, 'goal cjk')
  })

  it('names a timestamp outside the Date range instead of aborting the repaint', () => {
    // The Harness goal schema accepts any non-negative safe integer, which is
    // wider than `Date`: a stale or corrupt log can carry a finite value whose
    // `toISOString()` throws a RangeError. The row must degrade, not the frame.
    const { overlay } = overlayFor(reading({
      createdAt: Number.MAX_SAFE_INTEGER,
      updatedAt: -Number.MAX_SAFE_INTEGER,
    }))
    expect(() => overlay.render(80, 24)).not.toThrow()
    const text = plain(overlay).join('\n')
    expect(text).toMatch(/Created\s+unknown/)
    expect(text).toMatch(/Updated\s+unknown/)
  })
})

describe('the goal inspector geometry', () => {
  /** Widths from a sliver to a wide terminal. */
  const COLUMNS = [0, 1, 2, 3, 8, 13, 14, 15, 24, 80, 120] as const
  /** Heights from nothing to a tall window. */
  const ROWS = [0, 1, 2, 3, 4, 5, 8, 24] as const

  it('never overruns any terminal geometry, including the compact fallback', () => {
    const { overlay } = overlayFor(reading({
      objective: 'a long objective that has to wrap many times across a narrow terminal',
    }))
    for (const columns of COLUMNS) {
      for (const rows of ROWS) {
        expectPhysicallyBounded(overlay, columns, rows, 'goal')
      }
    }
  })

  it('draws only whole instructions in the compact fallback', () => {
    const { overlay } = overlayFor(reading())
    const allowed = ['goal active · disarmed · esc close', 'esc close', 'esc']
    // Heights at or below the three fixed rows, and widths below the frame
    // minimum, are the geometries that take the fallback.
    for (const rows of [1, 2, 3]) {
      for (const line of expectPhysicallyBounded(overlay, 80, rows, 'goal rows')) {
        expectWholeHelp(line, allowed, `goal at ${String(rows)} rows`)
      }
    }
    for (const columns of [1, 2, 3, 4, 5, 6, 8, 10, 12, 13]) {
      for (const line of expectPhysicallyBounded(overlay, columns, 5, 'goal columns')) {
        expectWholeHelp(line, allowed, `goal at ${String(columns)} columns`)
      }
    }
  })

  it('names its whole scroll help on the framed footer', () => {
    const { overlay } = overlayFor(reading())
    const bottom = plain(overlay).at(-1) ?? ''
    expect(bottom).toContain('↑↓ scroll · esc close')
  })

  it('reaches the end of a long document and walks back to the start', () => {
    const lines = Array.from({ length: 80 }, (_, index) => `line ${String(index + 1).padStart(2, '0')}`)
    const { overlay, invalidations } = overlayFor(reading({ objective: lines.join('\n') }))
    const at = (): string => plainRows(overlay, 80, 14).join('\n')
    expect(at()).toContain('line 01')
    expect(at()).not.toContain('line 80')
    for (let press = 0; press < 200; press += 1) overlay.handleKey(key('down'))
    expect(at()).toContain('line 80')
    expect(invalidations()).toBeGreaterThan(0)
    for (let press = 0; press < 200; press += 1) overlay.handleKey(key('up'))
    expect(at()).toContain('line 01')
  })

  it('keeps a scrolled window valid and reachable when the terminal shrinks', () => {
    const lines = Array.from({ length: 80 }, (_, index) => `line ${String(index + 1).padStart(2, '0')}`)
    const { overlay } = overlayFor(reading({ objective: lines.join('\n') }))
    overlay.render(80, 40)
    for (let press = 0; press < 200; press += 1) overlay.handleKey(key('down'))
    expect(plainRows(overlay, 80, 40).join('\n')).toContain('line 80')
    // A shorter window must leave a valid offset rather than overrun the
    // document, and the end must still be reachable from where it lands.
    expectPhysicallyBounded(overlay, 80, 8, 'goal shrunk')
    for (let press = 0; press < 200; press += 1) overlay.handleKey(key('down'))
    expect(plainRows(overlay, 80, 8).join('\n')).toContain('line 80')
  })

  it('clamps a scrolled window when the goal document shrinks under it', () => {
    const lines = Array.from({ length: 80 }, (_, index) => `line ${String(index + 1).padStart(2, '0')}`)
    const { overlay, set } = overlayFor(reading({ objective: lines.join('\n') }))
    overlay.render(80, 14)
    for (let press = 0; press < 200; press += 1) overlay.handleKey(key('down'))
    expect(plainRows(overlay, 80, 14).join('\n')).toContain('line 80')
    // Same goal identity, much shorter objective: the offset is clamped to the
    // smaller document instead of pointing past its end.
    set(reading({ objective: 'short objective' }))
    const shrunk = plainRows(overlay, 80, 14).join('\n')
    expect(shrunk).toContain('short objective')
    expect(shrunk).not.toContain('line 80')
  })

  it('returns to the top when the goal identity is replaced', () => {
    const lines = Array.from({ length: 80 }, (_, index) => `line ${String(index + 1).padStart(2, '0')}`)
    const { overlay, set } = overlayFor(reading({ objective: lines.join('\n') }))
    overlay.render(80, 14)
    for (let press = 0; press < 200; press += 1) overlay.handleKey(key('down'))
    expect(plainRows(overlay, 80, 14).join('\n')).toContain('line 80')
    set(reading({ id: 'goal-2', objective: 'a replacement goal' }))
    const replaced = plainRows(overlay, 80, 14).join('\n')
    expect(replaced).toContain('a replacement goal')
    expect(replaced).not.toContain('line 80')
  })
})

/** Render at one geometry with styling removed. */
function plainRows(
  overlay: { render: (columns: number, rows?: number) => readonly string[] },
  columns: number,
  rows: number,
): string[] {
  return overlay.render(columns, rows).map(stripAnsi)
}

describe('the goal inspector key contract', () => {
  it('closes on Escape and on ctrl-c, and only once', () => {
    for (const name of ['escape', 'ctrl-c']) {
      const { overlay, closes } = overlayFor(reading())
      overlay.handleKey(key(name))
      expect(closes(), name).toBe(1)
      overlay.handleKey(key(name))
      expect(closes(), name).toBe(1)
    }
  })

  it('ignores keys it does not own without closing or mutating anything', () => {
    const { overlay, closes } = overlayFor(reading())
    overlay.handleKey({ kind: 'text', text: 'x' } as Key)
    overlay.handleKey(key('left'))
    overlay.handleKey(key('enter'))
    expect(closes()).toBe(0)
  })

  it('does not redraw for an up/down press at the end of the document', () => {
    const { overlay, invalidations } = overlayFor(reading())
    overlay.render(80, 24)
    const before = invalidations()
    overlay.handleKey(key('up'))
    expect(invalidations()).toBe(before)
  })
})
