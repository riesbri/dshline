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
import { CHROME_MIN_COLUMNS } from '../src/chrome.ts'
import { createCompletion } from '../src/completion.ts'
import type { TuiSlotView } from '../src/slots.ts'
import { TuiSlots } from '../src/slots.ts'
import { StreamBuffer } from '../src/stream.ts'
import { createTimingView, TurnTimer } from '../src/timing.ts'
import { createComposerView, createStatusView } from '../src/views.ts'

/**
 * Every pathological width, then representative ordinary ones.
 *
 * The range below the shared chrome floor is exhaustive rather than sampled,
 * which is the contract `narrow-root.spec.ts` already holds the root chrome to:
 * these are the widths where `chromeWidth` returns more columns than the
 * terminal has, where a fixed row prefix can outgrow the whole row, and where
 * every field budget hits its floor at once. One column is included because a
 * terminal can be one column wide, and the invariant is not "usually".
 */
const WIDTHS: readonly number[] = [
  ...Array.from({ length: CHROME_MIN_COLUMNS }, (_, index) => index + 1),
  13, 14, 16, 20, 24, 30, 40, 60, 80, 100, 120, 200,
]

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

/**
 * A CLOSED turn whose spans are hours long, so every duration is a fixed string.
 *
 * The running fixture above measures against the wall clock, which is what
 * makes it a width stress but also makes its durations move between two
 * renders. Anything that compares one render's durations with another's needs a
 * turn whose closing events have all arrived.
 * @returns the fold, with a finished turn retained.
 */
function finishedTurn(): TurnTimer {
  const timer = new TurnTimer()
  let seq = 0
  const event = (type: string, data: unknown, time: number): SessionEvent =>
    ({ type, data, seq: (seq += 1), time } as unknown as SessionEvent)
  timer.observe(event('turn/start', { turn: 1 }, 0))
  for (let index = 0; index < 12; index += 1) {
    const callId = `c${String(index)}`
    timer.observe(event('tool/call', { callId, name: `tool_number_${String(index)}`, arguments: '{}' }, 0))
    timer.observe(event(
      'tool/result',
      { message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, content: [] }] } },
      3_600_000 * (index + 1),
    ))
  }
  timer.observe(event('turn/end', { turn: 1 }, 3_600_000 * 13))
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

/**
 * Every way one composition can break the live region's contract with `Screen`.
 *
 * Six claims, returned rather than asserted so one run reports the whole
 * failure surface instead of the first violation it meets:
 *
 * - no logical row is wider than the terminal, because `Screen.wrap` turns one
 *   that is into two physical rows after `compose` has spent the budget;
 * - no more physical rows than the terminal has, because rows that scroll off
 *   cannot be climbed back to and erased;
 * - the cursor row is inside the drawn region, at or above zero, because
 *   `Screen` climbs from the region's bottom to place it and a row outside the
 *   region is an erase origin outside it too;
 * - the cursor column is at or above zero and no further right than the
 *   terminal's own last cell boundary, for the same reason: the placement is a
 *   `CUF` from column zero, and one past the width is a column the frame does
 *   not have.
 * @param ctx - a registry holding the composed window's views.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @param where - what to name this composition in a failure.
 * @returns one line per violation, empty when the composition is sound.
 */
function violations(ctx: Context, columns: number, rows: number, where: string): string[] {
  const found: string[] = []
  const at = `${where} ${String(columns)}x${String(rows)}`
  const { lines, cursor } = ctx.tuiSlots.compose(columns, rows)
  for (const [index, line] of lines.entries()) {
    const width = displayWidth(line)
    if (width > columns) {
      found.push(`${at}: row ${String(index)} is ${String(width)} of ${String(columns)} columns — ${JSON.stringify(stripAnsi(line))}`)
    }
  }
  const physical = lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
  if (physical.length > rows) {
    found.push(`${at}: ${String(physical.length)} physical rows of ${String(rows)} (${String(lines.length)} logical)`)
  }
  if (cursor === undefined) return found
  if (cursor.row < 0) found.push(`${at}: cursor row ${String(cursor.row)} is negative`)
  if (cursor.row >= physical.length) {
    found.push(`${at}: cursor row ${String(cursor.row)} of ${String(physical.length)} drawn rows`)
  }
  if (cursor.column < 0) found.push(`${at}: cursor column ${String(cursor.column)} is negative`)
  if (cursor.column > columns) {
    found.push(`${at}: cursor column ${String(cursor.column)} past ${String(columns)} columns`)
  }
  return found
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
              failures.push(...violations(ctx, columns, rows, `content=${JSON.stringify(content.slice(0, 6))} stream=${String(streaming)} timing=${String(timing)}`))
            }
          }
        }
      }
    }
    expect(failures.slice(0, 12), `${String(failures.length)} violations`).toEqual([])
  })
})

describe('below the shared chrome floor', () => {
  /** Every width from one column up to and including the floor. */
  const NARROW: readonly number[] = Array.from(
    { length: CHROME_MIN_COLUMNS + 2 },
    (_, index) => index + 1,
  )

  /**
   * Rows one view contributes on its own, isolated from the composed window.
   * @param view - the view to draw.
   * @param columns - the terminal's width.
   * @returns the view's own logical rows.
   */
  const drawn = (view: TuiSlotView, columns: number): readonly string[] => view.render(columns, 24)

  /**
   * Rows wider than the terminal, described for a failure message.
   * @param rows - the rows to measure.
   * @param columns - the terminal's width.
   * @returns one description per offending row.
   */
  const wider = (rows: readonly string[], columns: number): string[] => rows
    .filter(row => displayWidth(row) > columns)
    .map(row => `${String(displayWidth(row))} of ${String(columns)}: ${JSON.stringify(stripAnsi(row))}`)

  it('keeps every completion row inside the terminal, or draws none', async () => {
    // Two failures, one row. `chromeWidth` floors at the chrome minimum, so
    // below it the list was laid out against a width wider than the terminal;
    // and the row's four-column prefix was outside the budget entirely, so
    // cutting the label could not bound the row it sat in.
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: '/com' })
    const completion = createCompletion(composer, {
      commands: () => Array.from({ length: 20 }, (_, index) => ({
        name: `command-${String(index)}`,
        summary: 'does a thing worth describing at length',
      })),
      commandArguments: () => undefined,
      paths: async () => [],
    } as never, () => {}, () => ROWS_BELOW)
    await completion.refresh()

    for (const columns of NARROW) {
      const rows = drawn(completion.view, columns)
      expect(wider(rows, columns), `at ${String(columns)} columns`).toEqual([])
      // The policy, stated as an assertion rather than left to whatever the
      // arithmetic happens to do: below a prefix plus one column of label there
      // is no row that names a candidate, so the list stands down whole rather
      // than spending a live row on `  › `.
      if (columns < 5) expect(rows, `at ${String(columns)} columns`).toEqual([])
      else expect(rows.length, `at ${String(columns)} columns`).toBeGreaterThan(0)
    }

    // Above the floor the same offer is legible, which is what makes the narrow
    // cases a bound on a real list rather than on its absence.
    expect(drawn(completion.view, 80).some(row => stripAnsi(row).includes('command-0'))).toBe(true)
  })

  it('keeps every measured timing row inside the terminal without cutting a duration', () => {
    // The measured rows are budgeted from the DURATION's width as well as the
    // terminal's, and the label and gap have floors of one, so their sum could
    // exceed the width they were laid out for. Cutting the row would have
    // bounded it and turned `2h 41m` into `2h 4` — a different valid reading,
    // which is what this file's heading ladder already refuses to produce. So
    // the panel gives up whole fields instead, and this checks both halves.
    const view = createTimingView(finishedTurn(), () => true, () => 0)

    /**
     * The trailing duration a row states, when it states one.
     *
     * Elision rows are excluded rather than parsed. `… +8 more` degrades to
     * `… +8` by its own ladder, whose trailing number is a COUNT — and a count
     * read as a duration would fail this check for saying something true.
     * Both the panel's elision marker and a span row too narrow for any field
     * open with the same mark, and neither claims a duration.
     * @param row - one rendered panel row.
     * @returns the duration, or nothing when the row states none.
     */
    const stated = (row: string): string | undefined => {
      const text = stripAnsi(row).trimEnd()
      if (text.trimStart().startsWith('\u2026')) return undefined
      return /(?<duration>\d[\dhms ]*)$/u.exec(text)?.groups?.duration
    }

    // Reference set: at a comfortable width every row draws its duration in
    // full, so these are the whole facts the narrow forms may state.
    const whole = new Set(drawn(view, 80).slice(1).map(stated).filter(row => row !== undefined))
    expect(whole.size).toBeGreaterThan(0)

    for (const columns of NARROW) {
      const rows = drawn(view, columns)
      expect(wider(rows, columns), `at ${String(columns)} columns`).toEqual([])
      // The panel never disappears: a heading always fits, and every span still
      // accounts for itself even where it can only say `…`.
      expect(rows.length, `at ${String(columns)} columns`).toBeGreaterThan(1)
      for (const row of rows.slice(1)) {
        const shown = stated(row)
        if (shown === undefined) continue
        expect(
          whole.has(shown),
          `at ${String(columns)} columns: ${JSON.stringify(stripAnsi(row))} states a partial duration`,
        ).toBe(true)
      }
    }
  })
})
