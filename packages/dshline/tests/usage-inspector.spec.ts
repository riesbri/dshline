/**
 * Tests for bare `/usage` as an inspector.
 *
 * The pricing table, the peak windows, and the per-message fold are covered in
 * `usage.spec.ts`. What is under test here is the hybrid the inspector reports:
 * Harness's `tokenUsage` projection for the four disjoint buckets and the
 * cache-read share derived from them, and dshline's own fold for the money.
 *
 * Their scopes are NOT the same, and two tests hold that distinction in place
 * against the REAL projection rather than a fake: they coincide on a session of
 * finalized messages, and they part company as soon as a retried attempt reports
 * usage in a chunk. A silent equivalence is exactly what a fake could not show.
 *
 * The performance section's own authority — Harness's `sessionStats` unit — is
 * probed against the real plugin in `capability/session-stats.probe.spec.ts`.
 * What is under test here is what `/usage` does with it, including the two ways
 * it can be absent and the figures it must refuse to print.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
import {
  cacheReadShare,
  formatCacheRead,
  formatCacheShare,
  pricingFrom,
  SessionUsage,
  usageBuckets,
  usageInspection,
} from '../src/usage.ts'
import type { UsageBuckets, UsageInspection, UsageReading } from '../src/usage.ts'
import { createUsageOverlay } from '../src/usage-overlay.ts'
import { formatDuration, formatTokenRate, isMeasured, sessionPerformance } from '../src/performance.ts'
import { SessionProjectionObserver } from '../src/projections/observer.ts'

/** A reading dshline's own fold would produce. */
function reading(overrides: Partial<UsageReading> = {}): UsageReading {
  return { inputTokens: 2_310_000, outputTokens: 42_000, costUsd: 0.84, partial: false, ...overrides }
}

/** One projection cut carrying Harness's usage buckets. */
function cut(values: ProjectionSnapshot['values'] = {}): ProjectionSnapshot {
  return { asOfSeq: 0, values }
}

/** Buckets whose prompt total is `input`, of which `cacheRead` came from cache. */
function buckets(cacheRead: number, input: number): UsageBuckets {
  return {
    uncachedInput: input - cacheRead,
    cacheRead,
    cacheWrite: 0,
    input,
    output: 0,
  }
}

/**
 * Harness's whole-log figures, all zero unless overridden.
 *
 * A zero is not a measured zero in this projection — see {@link isMeasured} —
 * which is why the default is the shape a session with nothing recorded yet has.
 */
function stats(overrides: Partial<SessionStatsProjection> = {}): SessionStatsProjection {
  return {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    ...overrides,
  }
}

/**
 * The example figures the presentation tests read.
 *
 * Nineteen steps over seven turns, 640ms to first token, and 8_460 output
 * tokens decoded in 200s — 42.3 tok/s.
 */
const SHIPPED_STATS = stats({
  turns: 7,
  steps: 19,
  llmMs: 252_000,
  toolMs: 63_000,
  ttftMs: 12_160,
  ttftSteps: 19,
  decodeMs: 200_000,
  decodeTokens: 8_460,
})

/**
 * Close one step of one turn, which is what `sessionStats` counts.
 * @param session - the session to append to.
 * @param turn - the turn number; a new one raises the turn count too.
 */
function closeStep(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** One priced step, appended the way the attachment observes them. */
function record(session: Session, turn: number, reported: Record<string, number>): void {
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn, step: 1,
    message: {
      id: `a-${String(turn)}`, role: 'assistant',
      content: [{ type: 'text', text: 'ok' }], source: { kind: 'model' },
    },
    usage: reported,
  } as never, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
}

/**
 * Whether one drawn row carries exactly this section heading and nothing else.
 *
 * The frame's own title carries `Usage` too, so a substring match over the whole
 * report would pass with the section heading deleted. Stripping the box drawing
 * is what makes the assertion about a row rather than about the picture.
 * @param drawn - the rendered rows.
 * @param text - the heading to look for.
 * @returns whether one row is exactly that heading.
 */
function hasHeading(drawn: readonly string[], text: string): boolean {
  return drawn.some(row => row.replace(/[│╭╮╰╯─]/gu, '').trim() === text)
}

/** The rows one inspection renders as, at a given geometry. */
function rows(inspection: UsageInspection, columns = 80, terminalRows = 24): string[] {
  const overlay = createUsageOverlay({
    inspection: () => inspection,
    mode: () => 'cost',
    chooseDisplay: () => {},
    close: () => {},
  })
  return overlay.render(columns, terminalRows).map(stripAnsi)
}

describe('the usage inspection', () => {
  it('reports Harness’s four buckets, their sum, and an honestly named cache ratio', () => {
    const inspection = usageInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 317_000,
        cacheReadTokens: 1_980_000,
        cacheWriteTokens: 13_000,
        outputTokens: 42_000,
      },
    }), reading())
    expect(inspection.buckets).toEqual({
      uncachedInput: 317_000,
      cacheRead: 1_980_000,
      cacheWrite: 13_000,
      input: 2_310_000,
      output: 42_000,
    })
    // A ratio of two buckets, not a provider metric: 1.98M of 2.31M.
    expect(inspection.cacheReadShare).toBeCloseTo(0.857, 2)
  })

  it('falls back to dshline’s own totals rather than leaving a hole', () => {
    const noRegistry = usageInspection(undefined, reading())
    expect(noRegistry.projections).toBe(false)
    expect(noRegistry.buckets).toBeUndefined()
    expect(noRegistry.reading.inputTokens).toBe(2_310_000)

    // Registry present, meter absent: the same fallback, a different reason.
    const unmetered = usageInspection(cut(), reading())
    expect(unmetered.projections).toBe(true)
    expect(unmetered.buckets).toBeUndefined()
  })

  it('claims no cache ratio for a session that has sent nothing', () => {
    const inspection = usageInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
      },
    }), reading({ inputTokens: 0, outputTokens: 0, costUsd: undefined }))
    expect(inspection.cacheReadShare).toBeUndefined()
  })

  it('coincides with the real Harness projection on a session of finalized messages', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TokenMeter)
    const session: Session = ctx.sessions.create()
    const usage = new SessionUsage(pricingFrom(undefined), [])

    // Two priced steps on the same route, folded the way the attachment folds
    // them: from `assistant/message`, at the event's own time.
    const steps = [
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 30 },
      { inputTokens: 50, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 0 },
    ]
    for (const [index, reported] of steps.entries()) {
      const turn = index + 1
      session.append('step/start', { turn, step: 1 })
      const event = session.append('assistant/message', {
        turn, step: 1,
        message: {
          id: `a-${String(turn)}`, role: 'assistant',
          content: [{ type: 'text', text: 'ok' }], source: { kind: 'model' },
        },
        usage: reported,
      } as never, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      usage.observe(reported as never, 'deepseek-official', 'deepseek-v4-pro', event.time)
    }

    const snapshot = ctx.sessionProjections.snapshot(session)
    const inspection = usageInspection(snapshot, usage.reading)
    // On THIS shape of session — every request finalized, nothing retried — the
    // two folds see the same reports, so the report does not read as
    // contradicting itself. That is a property of the session, not a guarantee
    // about the folds; the next test is the counterexample.
    expect(inspection.buckets?.input).toBe(inspection.reading.inputTokens)
    expect(inspection.buckets?.output).toBe(inspection.reading.outputTokens)
    // And the money is dshline's, which no projection retains.
    expect(inspection.reading.costUsd).toBeGreaterThan(0)
  })

  it('counts a retried attempt’s chunk sample that the pricing fold never sees', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TokenMeter)
    const session: Session = ctx.sessions.create()
    const usage = new SessionUsage(pricingFrom(undefined), [])

    // The adopted generation's `tokenUsage` fold: a failed attempt settles as
    // `assistant/attempt` and contributes the last usage sample embedded in its
    // stream, `llm/retry-started` closes the replacement slot, and the retried
    // attempt's finalized message then ADDS rather than replaces. The
    // attachment's pricing fold observes `assistant/message` only, because it
    // needs the route and the moment beside the tokens — so the failed attempt's
    // 100 prompt tokens are Harness's alone.
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/attempt', {
      turn: 1, step: 1,
      stream: [{
        type: 'chunk',
        time: 1_760_000_000_000,
        chunk: {
          type: 'usage',
          usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 90, cacheWriteTokens: 0 },
        },
      }],
    } as never)
    session.append('llm/retry-started', { turn: 1, step: 1 } as never)
    const reported = { inputTokens: 100, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0 }
    const event = session.append('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'a-1', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }], source: { kind: 'model' },
      },
      usage: reported,
    } as never, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    usage.observe(reported as never, 'deepseek-official', 'deepseek-v4-pro', event.time)

    const inspection = usageInspection(ctx.sessionProjections.snapshot(session), usage.reading)
    expect(inspection.buckets?.input).toBe(1_100)
    expect(inspection.reading.inputTokens).toBe(1_000)
    // The point of the test: nothing may restore the claim that these agree, and
    // `CR` is a share of the buckets rather than of the priced total.
    expect(inspection.buckets?.input).not.toBe(inspection.reading.inputTokens)
    expect(inspection.cacheReadShare).toBeCloseTo(990 / 1_100, 10)
  })
})

describe('the cache-read share', () => {
  it('divides the cache-read bucket by the whole prompt total', () => {
    const totals = usageBuckets(cut({
      tokenUsage: {
        uncachedInputTokens: 317_000,
        cacheReadTokens: 1_980_000,
        cacheWriteTokens: 13_000,
        outputTokens: 42_000,
      },
    }))
    // Cache WRITES are in the denominator: they are prompt tokens that were not
    // served from cache, so leaving them out would overstate the share.
    expect(totals?.input).toBe(2_310_000)
    expect(cacheReadShare(totals)).toBeCloseTo(1_980_000 / 2_310_000, 10)
  })

  it('has no share at all without the tokenUsage projection', () => {
    expect(usageBuckets(undefined)).toBeUndefined()
    expect(usageBuckets(cut())).toBeUndefined()
    expect(cacheReadShare(usageBuckets(undefined))).toBeUndefined()
    expect(cacheReadShare(usageBuckets(cut()))).toBeUndefined()
    expect(formatCacheShare(cacheReadShare(usageBuckets(cut())))).toBeUndefined()
  })

  it('invents no ratio for a session that has sent no prompt tokens', () => {
    const empty = usageBuckets(cut({
      tokenUsage: {
        uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
      },
    }))
    expect(cacheReadShare(empty)).toBeUndefined()
    expect(formatCacheShare(cacheReadShare(empty))).toBeUndefined()
  })

  it('keeps one decimal, so 99.8% does not read as 100%', () => {
    expect(formatCacheShare(cacheReadShare(buckets(99_800, 100_000)))).toBe('99.8%')
    expect(formatCacheShare(cacheReadShare(buckets(1_980_000, 2_310_000)))).toBe('85.7%')
  })

  it('prints a round share without a trailing decimal', () => {
    expect(formatCacheShare(cacheReadShare(buckets(50_000, 100_000)))).toBe('50%')
    expect(formatCacheShare(cacheReadShare(buckets(25_000, 100_000)))).toBe('25%')
  })

  it('states a bound rather than moving a value to the nearest printable one', () => {
    // 99.99% is neither `100%` — it missed part of its prompt — nor `99.9%`,
    // which is a different number. The display's precision runs out; the value
    // does not change on the way to the screen.
    expect(formatCacheShare(cacheReadShare(buckets(999_900, 1_000_000)))).toBe('>99.9%')
    expect(formatCacheShare(cacheReadShare(buckets(999_999, 1_000_000)))).toBe('>99.9%')
    // And the same at the bottom: some of the prompt came from cache, and it was
    // less than a tenth of a percent of it.
    expect(formatCacheShare(cacheReadShare(buckets(1, 1_000_000)))).toBe('<0.1%')
    expect(formatCacheShare(cacheReadShare(buckets(400, 1_000_000)))).toBe('<0.1%')
  })

  it('prints the last value each bound gives way to', () => {
    // Either side of the resolution, so the bounds cannot swallow a printable
    // figure: these round to 99.9% and 0.1% and are reported as such.
    expect(formatCacheShare(cacheReadShare(buckets(999_000, 1_000_000)))).toBe('99.9%')
    expect(formatCacheShare(cacheReadShare(buckets(999_400, 1_000_000)))).toBe('99.9%')
    expect(formatCacheShare(cacheReadShare(buckets(1_000, 1_000_000)))).toBe('0.1%')
    expect(formatCacheShare(cacheReadShare(buckets(500, 1_000_000)))).toBe('0.1%')
  })

  it('keeps `0%` and `100%` for exactly none and exactly all of the prompt', () => {
    expect(formatCacheShare(cacheReadShare(buckets(0, 100_000)))).toBe('0%')
    expect(formatCacheShare(cacheReadShare(buckets(100_000, 100_000)))).toBe('100%')
  })

  it('reports nothing for a figure that is not a number', () => {
    expect(formatCacheShare(Number.NaN)).toBeUndefined()
    expect(formatCacheShare(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('labels the status segment `CR`, and follows the reader’s usage preference', () => {
    const share = cacheReadShare(buckets(99_800, 100_000))
    expect(formatCacheRead(share, 'cost')).toBe('CR 99.8%')
    expect(formatCacheRead(share, 'tokens')).toBe('CR 99.8%')
    // `off` asks for the line to be left to the context reading.
    expect(formatCacheRead(share, 'off')).toBeUndefined()
    expect(formatCacheRead(undefined, 'cost')).toBeUndefined()
    // The bounded forms reach the line whole, exactly as they read here.
    expect(formatCacheRead(cacheReadShare(buckets(999_900, 1_000_000)), 'cost')).toBe('CR >99.9%')
    expect(formatCacheRead(cacheReadShare(buckets(1, 1_000_000)), 'cost')).toBe('CR <0.1%')
    expect(formatCacheRead(cacheReadShare(buckets(100_000, 100_000)), 'cost')).toBe('CR 100%')
  })
})

describe('the usage inspector’s presentation', () => {
  it('reports the buckets, the ratio, the money, and the status preference', () => {
    const drawn = rows(usageInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 317_000, cacheReadTokens: 1_980_000,
        cacheWriteTokens: 13_000, outputTokens: 42_000,
      },
    }), reading()))
    const body = drawn.join('\n')
    expect(hasHeading(drawn, 'Usage')).toBe(true)
    expect(body).toMatch(/input\s+2\.3M/u)
    expect(body).toMatch(/uncached\s+317k/u)
    expect(body).toMatch(/cache read\s+2\.0M/u)
    expect(body).toMatch(/cache write\s+13k/u)
    expect(body).toMatch(/output\s+42k/u)
    // Named for what it is: no provider here publishes a hit rate.
    expect(body).toMatch(/cache read share\s+85\.7%/u)
    expect(body).not.toContain('hit rate')
    expect(body).toMatch(/cost\s+\$0\.84/u)
    expect(body).toMatch(/status line\s+cost/u)
    expect(body).toContain('s status display · esc close')
  })

  it('follows the projection while it stands open, with no timer and no refresh key', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TokenMeter)
    const session: Session = ctx.sessions.create()
    let redraws = 0
    // The existing generic observer, and the existing invalidation: the overlay
    // adds no observer, no subscription and no clock of its own.
    const observer = new SessionProjectionObserver({
      registry: ctx.sessionProjections,
      session,
      invalidate: () => { redraws += 1 },
    })
    const overlay = createUsageOverlay({
      inspection: () => usageInspection(observer.snapshot(), reading()),
      mode: () => 'cost',
      chooseDisplay: () => {},
      close: () => {},
    })
    const painted = (): string => overlay.render(80, 24).map(stripAnsi).join('\n')

    record(session, 1, { inputTokens: 200, outputTokens: 10, cacheReadTokens: 99_800, cacheWriteTokens: 0 })
    await Promise.resolve()
    expect(redraws).toBeGreaterThan(0)
    expect(painted()).toMatch(/cache read share\s+99\.8%/u)

    const before = redraws
    record(session, 2, { inputTokens: 100_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })
    await Promise.resolve()
    // Same overlay instance, no key pressed and no clock advanced: the figure
    // moved because the projection did.
    expect(redraws).toBeGreaterThan(before)
    expect(painted()).toMatch(/cache read share\s+49\.9%/u)
    // Nothing here offers a manual refresh, because nothing here needs one.
    expect(painted()).toContain('s status display · esc close')
    expect(painted()).not.toContain('refresh')
    observer.dispose()
  })

  it('reports no money at all for an unpriced session, rather than zero', () => {
    const body = rows(usageInspection(cut(), reading({ costUsd: undefined }))).join('\n')
    expect(body).toContain('No rates are configured')
    expect(body).not.toContain('$0.00')
  })

  it('says a partly priced total is a floor, and marks it', () => {
    const body = rows(usageInspection(cut(), reading({ partial: true }))).join('\n')
    expect(body).toContain('cost (partial)')
    expect(body).toContain('~$0.84')
    expect(body).toContain('is a floor')
  })

  it('names the reason the cache split is missing', () => {
    expect(rows(usageInspection(cut(), reading())).join('\n')).toContain('token meter is not mounted')
    expect(rows(usageInspection(undefined, reading())).join('\n'))
      .toContain('Session projections are unavailable')
  })

  it('hands the status-display choice to the existing picker, and leaves first', () => {
    const order: string[] = []
    const overlay = createUsageOverlay({
      inspection: () => usageInspection(cut(), reading()),
      mode: () => 'tokens',
      chooseDisplay: () => { order.push('picker') },
      close: () => { order.push('closed') },
    })
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'text', text: 's' })
    // Closed BEFORE the picker opens: two overlays claiming the keyboard is how
    // a picker becomes unreachable.
    expect(order).toEqual(['closed', 'picker'])
  })

  it('closes on esc, and falls back to one closable row on a tiny terminal', () => {
    let closed = false
    const overlay = createUsageOverlay({
      inspection: () => usageInspection(cut(), reading()),
      mode: () => 'cost',
      chooseDisplay: () => {},
      close: () => { closed = true },
    })
    const tiny = overlay.render(12, 24).map(stripAnsi)
    expect(tiny.length).toBe(1)
    expect(tiny[0]).toContain('esc close')
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(closed).toBe(true)
  })

  it('never draws a frame wider or taller than the terminal it was given', () => {
    const inspection = usageInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 317_000, cacheReadTokens: 1_980_000,
        cacheWriteTokens: 13_000, outputTokens: 42_000,
      },
    }), reading({ partial: true }))
    for (const [columns, terminalRows] of [[80, 24], [40, 10], [60, 6], [120, 40]] as const) {
      const drawn = rows(inspection, columns, terminalRows)
      const physical = drawn.reduce(
        (count, row) => count + Math.max(1, Math.ceil(displayWidth(row) / columns)),
        0,
      )
      expect(physical, `must fit ${String(terminalRows)} rows`).toBeLessThanOrEqual(terminalRows)
      for (const row of drawn) expect(displayWidth(row)).toBeLessThanOrEqual(columns)
    }
  })
})

describe('the session performance reading', () => {
  it('passes Harness’s counts through untouched', () => {
    const performance = sessionPerformance(cut({ sessionStats: SHIPPED_STATS }))
    expect(performance.projections).toBe(true)
    // Identity, not a copy with arithmetic done to it: dshline counts nothing.
    expect(performance.stats).toBe(SHIPPED_STATS)
    expect(performance.stats?.turns).toBe(7)
    expect(performance.stats?.steps).toBe(19)
  })

  it('derives an average first token as ttftMs / ttftSteps', () => {
    expect(sessionPerformance(cut({
      sessionStats: stats({ ttftMs: 12_160, ttftSteps: 19 }),
    })).averageTtftMs).toBe(640)
  })

  it('derives a decode rate as decodeTokens / (decodeMs / 1000)', () => {
    expect(sessionPerformance(cut({
      sessionStats: stats({ decodeMs: 200_000, decodeTokens: 8_460 }),
    })).decodeTokensPerSecond).toBeCloseTo(42.3, 6)
  })

  it('claims no average where the projection has no denominator', () => {
    // The shape of a session whose only step was cancelled: Harness counted it,
    // and timed none of it. `0 / 0` is NaN and would read as a figure.
    const untimed = sessionPerformance(cut({
      sessionStats: stats({ turns: 1, steps: 1, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 40 }),
    }))
    expect(untimed.stats?.steps).toBe(1)
    expect(untimed.averageTtftMs).toBeUndefined()
    expect(untimed.decodeTokensPerSecond).toBeUndefined()
  })

  it('reports nothing derived from a figure that is not a number', () => {
    // The unit's own schema admits only finite non-negative numbers, so this
    // guards a future generation's shape rather than today's.
    const broken = sessionPerformance(cut({
      sessionStats: stats({ ttftMs: Number.NaN, ttftSteps: 4, decodeMs: Number.POSITIVE_INFINITY, decodeTokens: 8 }),
    }))
    expect(broken.averageTtftMs).toBeUndefined()
    expect(broken.decodeTokensPerSecond).toBeUndefined()
  })

  it('tells the two absences apart', () => {
    // Registry mounted, unit not: a fact the reader can act on.
    const unmounted = sessionPerformance(cut())
    expect(unmounted.projections).toBe(true)
    expect(unmounted.stats).toBeUndefined()

    // No registry at all: a different fact, and one `/usage` already reports.
    const none = sessionPerformance(undefined)
    expect(none.projections).toBe(false)
    expect(none.stats).toBeUndefined()
  })

  it('reads a summed wall time of zero as no measurement, not as no elapsed work', () => {
    // Harness accrues `llmMs` only on a step that assembled a message, and
    // `toolMs` only on a call matched by its result. A step that streamed and
    // was cancelled, and a call whose result never landed, both leave the total
    // at zero — so zero says "nothing contributed", never "nothing took time".
    expect(isMeasured(0)).toBe(false)
    expect(isMeasured(1)).toBe(true)
    expect(isMeasured(252_000)).toBe(true)
    // Negative and non-finite cannot come from the unit's schema; refused anyway.
    expect(isMeasured(-1)).toBe(false)
    expect(isMeasured(Number.NaN)).toBe(false)
  })

  it('shares one projection cut with the token buckets, while the money stays separate', () => {
    const snapshot = cut({
      tokenUsage: {
        uncachedInputTokens: 317_000, cacheReadTokens: 1_980_000,
        cacheWriteTokens: 13_000, outputTokens: 42_000,
      },
      sessionStats: SHIPPED_STATS,
    })
    const inspection = usageInspection(snapshot, reading())
    // Both projection-backed halves come from this one cut, so they cannot
    // describe two different moments.
    expect(inspection.buckets).toEqual(usageBuckets(snapshot))
    expect(inspection.performance.stats).toBe(SHIPPED_STATS)
    // The money is not in that snapshot at all: it is dshline's pricing fold,
    // passed in beside it.
    expect(inspection.reading.costUsd).toBe(0.84)
    expect('costUsd' in snapshot.values).toBe(false)
  })
})

describe('performance figure formatting', () => {
  it('keeps milliseconds below a second, where a first token lives', () => {
    // `formatElapsed` alone floors to whole seconds and reports this as `0s`.
    expect(formatDuration(640)).toBe('640ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('keeps one decimal second below a minute, and the renderer’s own form above it', () => {
    expect(formatDuration(1_000)).toBe('1.0s')
    expect(formatDuration(4_200)).toBe('4.2s')
    expect(formatDuration(63_000)).toBe('1m 03s')
    expect(formatDuration(252_000)).toBe('4m 12s')
  })

  it('formats a rate bare, because the label carries the unit', () => {
    expect(formatTokenRate(42.3)).toBe('42.3')
    expect(formatTokenRate(1_240.4)).toBe('1240')
    expect(formatTokenRate(undefined)).toBeUndefined()
    expect(formatTokenRate(Number.NaN)).toBeUndefined()
  })
})

describe('the performance section', () => {
  it('reports turns, steps, both averages, and both wall times', () => {
    const drawn = rows(usageInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 317_000, cacheReadTokens: 1_980_000,
        cacheWriteTokens: 13_000, outputTokens: 42_000,
      },
      sessionStats: SHIPPED_STATS,
    }), reading()))
    const body = drawn.join('\n')
    expect(hasHeading(drawn, 'Performance')).toBe(true)
    expect(body).toMatch(/turns\s+7/u)
    expect(body).toMatch(/steps\s+19/u)
    // Named as averages, because that is what two totals divided can be.
    expect(body).toMatch(/avg first token\s+640ms/u)
    expect(body).toMatch(/avg output tok\/s\s+42\.3/u)
    expect(body).toMatch(/model time\s+4m 12s/u)
    expect(body).toMatch(/tool time\s+1m 03s/u)
    // And the usage section is still whole beside it.
    expect(body).toMatch(/input\s+2\.3M/u)
    expect(body).toMatch(/cost\s+\$0\.84/u)
  })

  it('never renders a wall time of zero, which Harness does not mean as zero elapsed', () => {
    // One counted step that assembled no message and matched no tool result:
    // real work may have elapsed, and both totals are still zero.
    const body = rows(usageInspection(cut({
      sessionStats: stats({ turns: 1, steps: 1 }),
    }), reading())).join('\n')
    expect(body).toMatch(/turns\s+1/u)
    expect(body).toMatch(/steps\s+1/u)
    // Neither row appears at all, and specifically not as `0ms`.
    expect(body).not.toContain('model time')
    expect(body).not.toContain('tool time')
    expect(body).not.toContain('0ms')
  })

  it('drops only the wall time that has no contribution, keeping the other', () => {
    // A session of ordinary replies with no tool calls: model time is measured,
    // tool time is not, and the section reports exactly what it has.
    const modelOnly = rows(usageInspection(cut({
      sessionStats: stats({ turns: 2, steps: 3, llmMs: 4_200 }),
    }), reading())).join('\n')
    expect(modelOnly).toMatch(/model time\s+4\.2s/u)
    expect(modelOnly).not.toContain('tool time')

    // And the reverse: a turn whose steps were all cancelled after its tools
    // had already run and returned.
    const toolOnly = rows(usageInspection(cut({
      sessionStats: stats({ turns: 1, steps: 2, toolMs: 1_500 }),
    }), reading())).join('\n')
    expect(toolOnly).toMatch(/tool time\s+1\.5s/u)
    expect(toolOnly).not.toContain('model time')
  })

  it('omits the averages it has no denominator for, rather than showing them as zero', () => {
    const body = rows(usageInspection(cut({
      sessionStats: stats({ turns: 1, steps: 1, llmMs: 4_200 }),
    }), reading())).join('\n')
    expect(body).toMatch(/steps\s+1/u)
    expect(body).not.toContain('avg first token')
    expect(body).not.toContain('avg output tok/s')
    expect(body).not.toMatch(/avg/u)
  })

  it('says in one line when the profile does not mount the unit, and guesses nothing', () => {
    const body = rows(usageInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 317_000, cacheReadTokens: 1_980_000,
        cacheWriteTokens: 13_000, outputTokens: 42_000,
      },
    }), reading())).join('\n')
    expect(body).toContain('Performance')
    expect(body).toContain('does not mount Harness session statistics')
    // No figure is invented — counts included — and the tokens are untouched.
    expect(body).not.toContain('turns')
    expect(body).not.toContain('steps')
    expect(body).not.toContain('avg first token')
    expect(body).toMatch(/input\s+2\.3M/u)
    expect(body).toMatch(/cost\s+\$0\.84/u)
  })

  it('omits the section entirely for a profile with no projections at all', () => {
    // The usage section has already said projections are unavailable; a second
    // row saying it again would spend two rows on one fact.
    const body = rows(usageInspection(undefined, reading())).join('\n')
    expect(body).toContain('Session projections are unavailable')
    expect(body).not.toContain('Performance')
    expect(body).not.toContain('session statistics')
    // `/usage` is still a working inspector: dshline's own totals answer.
    expect(body).toMatch(/input\s+2\.3M/u)
    expect(body).toMatch(/output\s+42k/u)
    expect(body).toMatch(/cost\s+\$0\.84/u)
    expect(body).toMatch(/status line\s+cost/u)
  })

  it('follows the sessionStats projection while the overlay stands open', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionStatsPlugin)
    const session: Session = ctx.sessions.create()
    let redraws = 0
    // The same generic observer the attachment already owns. The overlay adds
    // no listener of its own, no interval, and no replay.
    const observer = new SessionProjectionObserver({
      registry: ctx.sessionProjections,
      session,
      invalidate: () => { redraws += 1 },
    })
    const overlay = createUsageOverlay({
      inspection: () => usageInspection(observer.snapshot(), reading()),
      mode: () => 'cost',
      chooseDisplay: () => {},
      close: () => {},
    })
    const painted = (): string => overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(painted()).toMatch(/steps\s+0/u)

    closeStep(session, 1)
    await Promise.resolve()
    expect(redraws).toBeGreaterThan(0)
    expect(painted()).toMatch(/turns\s+1/u)
    expect(painted()).toMatch(/steps\s+1/u)

    const before = redraws
    closeStep(session, 2)
    await Promise.resolve()
    // Same overlay instance, no key pressed and no clock advanced.
    expect(redraws).toBeGreaterThan(before)
    expect(painted()).toMatch(/turns\s+2/u)
    expect(painted()).toMatch(/steps\s+2/u)
    observer.dispose()
  })

  it('stays inside a narrow or short terminal with the section present', () => {
    const inspection = usageInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 317_000, cacheReadTokens: 1_980_000,
        cacheWriteTokens: 13_000, outputTokens: 42_000,
      },
      sessionStats: SHIPPED_STATS,
    }), reading({ partial: true }))
    for (const [columns, terminalRows] of [[80, 24], [40, 10], [60, 6], [120, 40], [12, 24]] as const) {
      const drawn = rows(inspection, columns, terminalRows)
      const physical = drawn.reduce(
        (count, row) => count + Math.max(1, Math.ceil(displayWidth(row) / columns)),
        0,
      )
      expect(physical, `must fit ${String(terminalRows)} rows`).toBeLessThanOrEqual(terminalRows)
      for (const row of drawn) expect(displayWidth(row)).toBeLessThanOrEqual(columns)
    }
  })
})
