/**
 * The one property the whole live region depends on, checked over the real views.
 *
 * `Screen` redraws by climbing the rows it remembers, so a region taller than
 * the terminal is not a cosmetic problem: its first rows have scrolled off,
 * cannot be climbed back to, and are never erased again — they become durable
 * scrollback, and what a reader sees is the root chrome printed a second time.
 *
 * `TuiSlots.compose` budgets in LOGICAL lines and hands each view the rows the
 * views above it have not spent, which is only equivalent to the physical
 * budget while every row fits the terminal's width. `Screen.wrap` re-wraps an
 * overlong row into two AFTER that budgeting is finished, so one row wider than
 * the terminal is one row of overflow that no view's own accounting can see.
 * That makes width the load-bearing half of a height invariant, which is why
 * this asserts both against the same composition.
 *
 * Every view is asked at once, across the widths and heights a real terminal
 * actually opens at, because the failure only appears in combination: a view
 * that fits alone can still be the one that pushes the region over.
 * @module dshline/tests/live-region-bounds
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Composer, displayWidth, stripAnsi, wrapToWidth } from '@dshline/renderer'
import { createCompletion } from '../src/completion.ts'
import { TuiSlots } from '../src/slots.ts'
import { StreamBuffer } from '../src/stream.ts'
import { createTimingView, TurnTimer } from '../src/timing.ts'
import { createComposerView, createStatusView } from '../src/views.ts'

/** Terminal widths from the narrowest split pane to a wide window. */
const WIDTHS = [8, 10, 11, 12, 13, 14, 16, 20, 24, 30, 40, 60, 80, 100, 120, 200] as const

/** Terminal heights from a cramped pane to a tall window. */
const HEIGHTS = [10, 12, 14, 16, 20, 24, 30, 40, 50] as const

/** Composer contents that exercise the empty, one-row, tall and completing frames. */
const CONTENTS = [
  '',
  'short',
  Array.from({ length: 30 }, (_, index) => `line ${String(index)}`).join('\n'),
  'x'.repeat(2000),
  '/com',
] as const

/** What the runner spends its rows on beneath the composer. */
const ROWS_BELOW = 2

/** A turn whose spans are many and whose durations are long, which is the timing worst case. */
function measuredTurn(): TurnTimer {
  const timer = new TurnTimer()
  let seq = 0
  const event = (type: string, data: unknown, time: number): SessionEvent =>
    ({ type, data, seq: (seq += 1), time } as unknown as SessionEvent)
  timer.observe(event('turn/start', { turn: 1 }, 0))
  for (let index = 0; index < 12; index += 1) {
    // Far enough apart to format wide. The panel derives its label width, gap
    // and bar cells by subtracting the DURATION's width from the terminal's, so
    // the duration string is the input that decides whether a measured row fits
    // at all — a long-running turn is what makes it wide in production, and a
    // wide one is what this reproduces.
    timer.observe(event(
      'tool/call',
      { callId: `c${String(index)}`, name: `tool_number_${String(index)}`, arguments: '{}' },
      3_600_000 * (index + 1),
    ))
  }
  return timer
}

/** The status line with every optional reading present, which is its widest form. */
function busyStatus(): ReturnType<typeof createStatusView> {
  return createStatusView(() => ({
    busy: true,
    tick: 3,
    elapsedMs: 12_345,
    activityWord: 'working',
    activity: { title: 'delegated_subagent', others: 2 },
    model: 'deepseek-v4-flash',
    effort: 'high',
    usage: '$1.23',
    cacheRead: '42% cached',
    tokens: 120_000,
    contextWindow: 1_000_000,
    detail: 'full',
    work: '1 workflow · 3 subagents · 2 jobs',
    pending: { queued: 1, steering: 1 },
    todo: '3/7',
    plan: true,
    replay: undefined,
    goal: { label: 'goal 4/12', running: true },
  } as never))
}

/** One registry holding every view the runner registers, composed as it composes them. */
async function window(
  content: string,
  timer: TurnTimer,
  timing: () => boolean,
  stream: StreamBuffer,
): Promise<Context> {
  const composer = new Composer()
  if (content !== '') composer.handle({ kind: 'paste', text: content })
  const rowsBelow = (): number => ROWS_BELOW
  const completion = createCompletion(composer, {
    commands: () => Array.from({ length: 20 }, (_, index) => ({
      name: `command-${String(index)}`,
      summary: 'does a thing worth describing at length',
    })),
    commandArguments: () => undefined,
    paths: async () => [],
  } as never, () => {}, rowsBelow)
  // A standing offer, not a fresh one: the list is only in the region while it
  // has candidates, and a `/`-prefixed token is how it gets them.
  if (content.startsWith('/')) await completion.refresh()

  const ctx = new Context()
  await ctx.plugin(TuiSlots)
  ctx.tuiSlots.register('stream', { render: (columns: number) => stream.live(columns) })
  ctx.tuiSlots.register('status', busyStatus())
  ctx.tuiSlots.register('composer', createComposerView(composer, '/work/repo', rowsBelow))
  ctx.tuiSlots.register('completion', completion.view)
  ctx.tuiSlots.register('timing', createTimingView(timer, timing, () => 0))
  return ctx
}

describe('the composed live region', () => {
  it('draws no row wider than the terminal, and no more rows than it has', async () => {
    const timer = measuredTurn()
    const stream = new StreamBuffer()
    const failures: string[] = []
    for (const content of CONTENTS) {
      for (const streaming of [false, true]) {
        stream.reset()
        // An unfinished line long enough to fill the stream region's own bound.
        if (streaming) stream.push('text', 'y'.repeat(600), 80)
        for (const timing of [false, true]) {
          const ctx = await window(content, timer, () => timing, stream)
          for (const rows of HEIGHTS) {
            for (const columns of WIDTHS) {
              const { lines, cursor } = ctx.tuiSlots.compose(columns, rows)
              const where = `content=${JSON.stringify(content.slice(0, 6))} stream=${String(streaming)} timing=${String(timing)} ${String(columns)}x${String(rows)}`
              for (const [index, line] of lines.entries()) {
                const width = displayWidth(line)
                if (width > columns) {
                  failures.push(`${where}: row ${String(index)} is ${String(width)} of ${String(columns)} columns — ${JSON.stringify(stripAnsi(line))}`)
                }
              }
              const physical = lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
              if (physical.length > rows) {
                failures.push(`${where}: ${String(physical.length)} physical rows of ${String(rows)} (${String(lines.length)} logical)`)
              }
              // A cursor outside the drawn region places the caret on chrome
              // the frame does not hold, which is the same arithmetic going
              // wrong one step earlier.
              if (cursor !== undefined && cursor.row >= physical.length) {
                failures.push(`${where}: cursor row ${String(cursor.row)} of ${String(physical.length)} rows`)
              }
            }
          }
        }
      }
    }
    expect(failures.slice(0, 12), `${String(failures.length)} violations`).toEqual([])
  })
})

describe('below the shared chrome floor', () => {
  it('keeps every completion row inside the terminal', async () => {
    // `chromeWidth` floors at the chrome minimum, so under it the list was laid
    // out against a width wider than the terminal, and its shortest row — the
    // `… N more` marker — was not cut at all.
    const stream = new StreamBuffer()
    const ctx = await window('/com', measuredTurn(), () => false, stream)
    for (const columns of [8, 10, 11, 12, 13, 14]) {
      const rows = ctx.tuiSlots.compose(columns, 24).lines
      const offenders = rows
        .filter(row => displayWidth(row) > columns)
        .map(row => `${String(displayWidth(row))} of ${String(columns)}: ${JSON.stringify(stripAnsi(row))}`)
      expect(offenders, `at ${String(columns)} columns`).toEqual([])
      // The list contributes rows at these widths rather than standing down, so
      // the widths above are measuring the list and not its absence. Its labels
      // are cut to whatever is left of the width, which is why presence is
      // asserted here and the readable form is asserted at a real width below.
      expect(rows.length, `at ${String(columns)} columns`).toBeGreaterThan(0)
    }
    // Above the floor the same fixture is legible, which is what makes the
    // narrow cases a bound on a real offer.
    const wide = ctx.tuiSlots.compose(80, 24).lines
    expect(wide.some(row => stripAnsi(row).includes('command-0'))).toBe(true)
  })

  it('keeps every measured timing row inside the terminal', async () => {
    // The measured rows are budgeted from the duration's width as well as the
    // terminal's, and their label and gap have floors of one, so the sum could
    // exceed the width they were laid out for.
    const stream = new StreamBuffer()
    const ctx = await window('', measuredTurn(), () => true, stream)
    for (const columns of [8, 10, 11, 12, 13, 14, 16, 18]) {
      const rows = ctx.tuiSlots.compose(columns, 24).lines
      const offenders = rows
        .filter(row => displayWidth(row) > columns)
        .map(row => `${String(displayWidth(row))} of ${String(columns)}: ${JSON.stringify(stripAnsi(row))}`)
      expect(offenders, `at ${String(columns)} columns`).toEqual([])
      expect(rows.some(row => stripAnsi(row).includes('timing'))).toBe(true)
    }
  })
})
