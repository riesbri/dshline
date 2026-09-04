/**
 * Capability probe: Harness's `sessionStats` projection, against the real plugin.
 *
 * This is the compatibility evidence `tools/capability-probes.mjs` names for the
 * `sessionStats` seam, so it mounts the REAL `@deepseek-ai/dsh-session-stats`
 * over a real `SessionStore` and a real projection registry — never a
 * dshline-shaped fake. Four contracts are asserted, because `/usage`'s
 * performance section is built on exactly these and nothing else:
 *
 * 1. the unit registers a `sessionStats` key that dshline's own generic observer
 *    can read, carrying the eight fields the section reports;
 * 2. dshline's two derivations are that projection's own totals divided, and
 *    agree with the numbers Harness published in the same cut;
 * 3. a session whose events were all logged BEFORE the unit mounted — the
 *    resumed-session shape — reports the whole log, because the registry folds
 *    it, not because dshline replayed anything;
 * 4. a step Harness counted but did not time yields no averages at all, rather
 *    than zero ones;
 * 5. a zero summed wall time is the ABSENCE of a contribution and not a
 *    measurement of zero — real streaming and a real tool call can both elapse
 *    and leave the total at zero, which is why `/usage` refuses to print it.
 *
 * The fold itself is upstream's contract and upstream's test. What is under
 * test here is dshline's dependency on it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import { isMeasured, sessionPerformance } from '../../src/performance.ts'
import { SessionProjectionObserver } from '../../src/projections/observer.ts'

/** Milliseconds a step's first token lands after its start, in the log below. */
const FIRST_TOKEN_MS = 800

/** Milliseconds the assembled message lands after that first token. */
const DECODE_MS = 3_200

/** Provider-reported output tokens for the timed step. */
const OUTPUT_TOKENS = 64

/** Where the synthetic clock starts, so every asserted duration is exact. */
const CLOCK_ORIGIN = 1_760_000_000_000

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Mount the real store and registry, optionally with the real stats plugin.
 * @param withStats - whether to mount `@deepseek-ai/dsh-session-stats`.
 * @returns the context and one fresh session.
 */
async function harness(withStats: boolean): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (withStats) await ctx.plugin(SessionStatsPlugin)
  return { ctx, session: ctx.sessions.create() }
}

/**
 * Append one fully timed step at controlled wall-clock times.
 *
 * The times are the projection's only input for its wall-time fields, and
 * `Session` stamps every event with `Date.now()`, so a fake clock is what makes
 * a real-projection assertion exact instead of "some small number of ms".
 * @param session - the session to append to.
 * @param turn - the turn number.
 * @param startedAt - the moment `step/start` is logged.
 * @param ttftMs - how long this step takes to its first token.
 */
function timedStep(session: Session, turn: number, startedAt: number, ttftMs = FIRST_TOKEN_MS): void {
  vi.setSystemTime(startedAt)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  // The first token's moment travels INSIDE the settled message now: Harness
  // stores one durable settlement per attempt carrying its exact timed stream,
  // so there is no separate per-delta event left to time the step from.
  vi.setSystemTime(startedAt + ttftMs + DECODE_MS)
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    stream: [
      { type: 'chunk', time: startedAt + ttftMs, chunk: { type: 'text-delta', index: 0, text: 'a' } },
    ],
    usage: { inputTokens: 10, outputTokens: OUTPUT_TOKENS },
  } as never, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('capability: sessionStats', () => {
  it('registers the projection key dshline reads, through the generic observer', async () => {
    vi.useFakeTimers()
    const { ctx, session } = await harness(true)
    const observer = new SessionProjectionObserver({
      registry: ctx.sessionProjections,
      session,
      invalidate: () => {},
    })
    timedStep(session, 1, CLOCK_ORIGIN)

    const snapshot = observer.snapshot()
    expect(snapshot).toBeDefined()
    // The key, by name: this is what "session statistics are mounted" means to
    // dshline, and an upstream rename fails here rather than as a blank section.
    expect(snapshot?.values.sessionStats).toEqual({
      turns: 1,
      steps: 1,
      llmMs: FIRST_TOKEN_MS + DECODE_MS,
      toolMs: 0,
      ttftMs: FIRST_TOKEN_MS,
      ttftSteps: 1,
      decodeMs: DECODE_MS,
      decodeTokens: OUTPUT_TOKENS,
    })
    observer.dispose()
  })

  it('derives both averages from that cut’s own totals and nothing else', async () => {
    vi.useFakeTimers()
    const { ctx, session } = await harness(true)
    timedStep(session, 1, CLOCK_ORIGIN)
    // A second step twice as slow to its first token, so the average is provably
    // an average rather than either step's own figure repeated.
    timedStep(session, 2, CLOCK_ORIGIN + 60_000, 2 * FIRST_TOKEN_MS)

    const performance = sessionPerformance(ctx.sessionProjections.snapshot(session))
    const stats = performance.stats
    expect(stats).toBeDefined()
    expect(stats?.turns).toBe(2)
    expect(stats?.steps).toBe(2)
    // The whole of dshline's arithmetic, checked against the same cut it read.
    expect(performance.averageTtftMs).toBe((stats?.ttftMs ?? 0) / (stats?.ttftSteps ?? 1))
    expect(performance.averageTtftMs).toBe(1.5 * FIRST_TOKEN_MS)
    expect(performance.decodeTokensPerSecond)
      .toBeCloseTo((stats?.decodeTokens ?? 0) / ((stats?.decodeMs ?? 0) / 1000), 6)
    expect(performance.decodeTokensPerSecond).toBeCloseTo(2 * OUTPUT_TOKENS / (2 * DECODE_MS / 1000), 6)
  })

  it('reports a resumed session’s whole log from the registry’s own fold', async () => {
    vi.useFakeTimers()
    // Every event is logged with no stats unit mounted, which is the shape a
    // reopened session presents: the durable log exists and this process has
    // folded none of it. Mounting the unit afterwards is the registry's lazy
    // build, and dshline replays nothing.
    const { ctx, session } = await harness(false)
    timedStep(session, 1, CLOCK_ORIGIN)
    timedStep(session, 2, CLOCK_ORIGIN + 60_000)
    expect(sessionPerformance(ctx.sessionProjections.snapshot(session)).stats).toBeUndefined()

    await ctx.plugin(SessionStatsPlugin)
    const resumed = sessionPerformance(ctx.sessionProjections.snapshot(session))
    expect(resumed.stats).toMatchObject({
      turns: 2,
      steps: 2,
      ttftSteps: 2,
      decodeTokens: 2 * OUTPUT_TOKENS,
    })
    expect(resumed.averageTtftMs).toBe(FIRST_TOKEN_MS)
  })

  it('claims no average for a step Harness counted but did not time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(CLOCK_ORIGIN)
    const { ctx, session } = await harness(true)
    // A cancelled step: `step/end` lands from the loop's `finally`, so the step
    // counts, but no message assembled so nothing was timed.
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'legacy' } } } as never)

    const performance = sessionPerformance(ctx.sessionProjections.snapshot(session))
    expect(performance.stats).toMatchObject({ turns: 1, steps: 1, ttftSteps: 0, decodeMs: 0 })
    // Both denominators are zero, and neither average is invented from it.
    expect(performance.averageTtftMs).toBeUndefined()
    expect(performance.decodeTokensPerSecond).toBeUndefined()
  })

  it('leaves both wall times at zero after work that really elapsed', async () => {
    vi.useFakeTimers()
    const { ctx, session } = await harness(true)
    // Ten seconds of streaming and a four-second tool call, both real and both
    // uncontributing: the step is cancelled before a message assembles, and the
    // tool's result never lands, so `turn/end` drops the pending call. This is
    // the contract behind `isMeasured` — a zero here is the absence of a
    // contribution, so `model time 0ms` would claim a measurement Harness never
    // made.
    vi.setSystemTime(CLOCK_ORIGIN)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: 'a', name: 'read', arguments: '{}' } as never)
    vi.setSystemTime(CLOCK_ORIGIN + 4_000)
    // A cancelled attempt settles as `assistant/attempt` carrying the stream it
    // did deliver — real streaming, and still no assembled message to time
    // against, which is exactly what the assertion below is about.
    session.append('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [
        { type: 'chunk', time: CLOCK_ORIGIN + 4_000, chunk: { type: 'text-delta', index: 0, text: 'partial' } },
      ],
    } as never)
    vi.setSystemTime(CLOCK_ORIGIN + 10_000)
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'legacy' } } } as never)

    const performance = sessionPerformance(ctx.sessionProjections.snapshot(session))
    expect(performance.stats).toMatchObject({ turns: 1, steps: 1, llmMs: 0, toolMs: 0 })
    expect(isMeasured(performance.stats?.llmMs ?? 0)).toBe(false)
    expect(isMeasured(performance.stats?.toolMs ?? 0)).toBe(false)
  })

  it('has no key at all in a composition that does not mount the unit', async () => {
    const { ctx, session } = await harness(false)
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect('sessionStats' in snapshot.values).toBe(false)
    const performance = sessionPerformance(snapshot)
    // The registry IS mounted, so this is the "unit absent" reading, which is a
    // different fact from "no projections at all" and reads differently.
    expect(performance.projections).toBe(true)
    expect(performance.stats).toBeUndefined()
  })
})
