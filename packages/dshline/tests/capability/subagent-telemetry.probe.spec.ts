/**
 * Capability probe: the `subagentTiming` and `tokenUsage` session projections.
 *
 * This is the compatibility evidence for the two Harness projection units a
 * Work 3.0 subagent row reads, so it mounts the REAL
 * `@deepseek-ai/dsh-subagent` and `@deepseek-ai/dsh-token-meter` over a real
 * `SessionStore` and a real projection registry, and drives them with real
 * `Session.append` calls rather than with a dshline-shaped fake. What is
 * asserted is exactly what the row claims:
 *
 * 1. both units are registered under the keys `HarnessWork` narrows its
 *    snapshot to, and reachable for a CHILD session through the generic
 *    registry — an upstream rename fails here rather than as a blank fact row;
 * 2. active time is the projection's own accumulation of post-descriptor
 *    turns, and a descriptor replayed from a fork seed does not contribute;
 * 3. the four token buckets are disjoint, so the row's total is their sum;
 * 4. `tokenUsage` has NO such descriptor reset — it folds the complete log, so
 *    a really-seeded child's projection carries its parent's usage too, and the
 *    row must refuse to attribute that to the child;
 * 5. a live child's route comes from its own logged request envelope.
 *
 * The child Agent itself is synthetic: publishing a real one needs the agent
 * loop, which is not a dependency here. Everything it stands in front of — the
 * Session, its log, both projection folds, and the request-header fold — is
 * real, and those are the contracts under test.
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { HarnessWork } from '../../src/work/index.ts'
import { activeElapsedMs, subagentDuration } from '../../src/work/model.ts'
import type { SubagentRunInfo } from '@deepseek-ai/dsh-subagent'

/** A fixed origin, so every asserted duration is an exact arithmetic claim. */
const ORIGIN = 1_800_000_000_000

/** Mount the real store, registry, subagent runtime, and token meter. */
async function harness(): Promise<{ ctx: Context; child: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(TokenMeter)
  return { ctx, child: ctx.sessions.create() }
}

/**
 * A Work projection observing one synthetic local child over a real Session.
 * @param ctx - the context holding the real registry.
 * @param child - the real child session the row reads.
 * @param options - the child Agent's creation-time route.
 * @returns the projection, the child Agent, and the lifecycle start hook.
 */
function work(ctx: Context, child: Session, options: Agent['options'] = {}): {
  readonly projection: HarnessWork
  readonly agent: Agent
  readonly start: (info: SubagentRunInfo) => void
} {
  const childAgent = { status: 'running', options, session: child } as unknown as Agent
  const parent = { session: ctx.sessions.create(), ctx } as unknown as Agent
  let started: ((info: SubagentRunInfo) => void) | undefined
  const projection = new HarnessWork({
    agent: parent,
    subagents: { listChildren: async () => [], interrupt: () => {} } as never,
    agents: { get: () => childAgent },
    projections: ctx.sessionProjections,
    onSubagentStart: listener => { started = listener; return () => {} },
    invalidate: () => {},
  })
  return {
    projection,
    agent: childAgent,
    start: info => { started?.(info) },
  }
}

/** The lifecycle edge for a local child of the exact session under test. */
function edge(child: Session): SubagentRunInfo {
  return { runId: 'run-1' as SubagentRunInfo['runId'], provider: 'spawn', id: child.id, local: true }
}

describe('capability: subagent telemetry projections', () => {
  afterEach(() => { vi.useRealTimers() })

  it('serves both units for a child session under the keys Work narrows to', async () => {
    const { ctx, child } = await harness()
    try {
      child.append('subagent/descriptor', snapshotSubagentDescriptor({
        mode: 'one-shot', provider: 'spawn', label: 'Fix OAuth flow',
      }))
      const snapshot = ctx.sessionProjections.snapshot(child, ['subagentTiming', 'tokenUsage'])
      // The keys, by name: this is what "Work may show active time and tokens"
      // means, and it is the assertion an upstream rename must break.
      expect(Object.keys(snapshot.values).sort()).toEqual(['subagentTiming', 'tokenUsage'])
      expect(snapshot.values.subagentTiming).toEqual({ settledMs: 0 })
      expect(snapshot.values.tokenUsage).toEqual({
        uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('accumulates completed post-descriptor turns and holds an open one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(ORIGIN)
    const { ctx, child } = await harness()
    try {
      const { projection, start } = work(ctx, child)
      start(edge(child))
      child.append('subagent/descriptor', snapshotSubagentDescriptor({
        mode: 'one-shot', provider: 'spawn', label: 'Fix OAuth flow',
      }))
      child.append('turn/start', { turn: 1 })
      vi.setSystemTime(ORIGIN + 42_000)
      child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      // One settled turn, no open interval: the row's clock is exactly the
      // projection's figure, with nothing added by dshline.
      expect(projection.snapshot().subagents[0]?.timing).toEqual({ settledMs: 42_000 })
      expect(subagentDuration(projection.snapshot().subagents[0]!, ORIGIN + 99_000))
        .toEqual({ ms: 42_000, kind: 'active' })

      vi.setSystemTime(ORIGIN + 50_000)
      child.append('turn/start', { turn: 2 })
      vi.setSystemTime(ORIGIN + 54_000)
      child.append('assistant/attempt', {
        turn: 2,
        step: 1,
        stream: [
          { type: 'chunk', time: ORIGIN + 54_000, chunk: { type: 'reasoning-delta', index: 0, text: 'work' } },
        ],
      } as never)
      const timing = projection.snapshot().subagents[0]?.timing
      expect(timing).toEqual({ settledMs: 42_000, active: { since: ORIGIN + 50_000, through: ORIGIN + 54_000 } })
      // Running: the open turn advances with the frame clock.
      expect(activeElapsedMs(timing!, true, ORIGIN + 60_000)).toBe(52_000)
      // Not running: it freezes at the projection's own bound instead.
      expect(activeElapsedMs(timing!, false, ORIGIN + 60_000)).toBe(46_000)
      projection.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not count a fork-replayed ancestor descriptor’s turns as the child’s', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(ORIGIN)
    const { ctx, child } = await harness()
    try {
      const { projection, start } = work(ctx, child)
      start(edge(child))
      // A fork seed can carry an ancestor's descriptor AND completed turns
      // under it. Every descriptor resets the accumulation, so the child's own
      // descriptor is its authoritative timing origin.
      child.append('subagent/descriptor', snapshotSubagentDescriptor({
        mode: 'one-shot', provider: 'spawn', label: 'ancestor',
      }))
      child.append('turn/start', { turn: 1 })
      vi.setSystemTime(ORIGIN + 600_000)
      child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(projection.snapshot().subagents[0]?.timing?.settledMs).toBe(600_000)

      child.append('subagent/descriptor', snapshotSubagentDescriptor({
        mode: 'one-shot', provider: 'spawn', label: 'Fix OAuth flow',
      }))
      child.append('turn/start', { turn: 2 })
      vi.setSystemTime(ORIGIN + 600_000 + 5_000)
      child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      // Ten minutes of inherited history, five seconds of this child's work.
      expect(projection.snapshot().subagents[0]?.timing).toEqual({ settledMs: 5_000 })
      projection.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('totals the four disjoint token buckets across the child’s whole log', async () => {
    const { ctx, child } = await harness()
    try {
      const { projection, start } = work(ctx, child)
      start(edge(child))
      child.append('subagent/descriptor', snapshotSubagentDescriptor({
        mode: 'one-shot', provider: 'spawn', label: 'Fix OAuth flow',
      }))
      child.append('turn/start', { turn: 1 })
      // Usage reaches the projection inside a settled attempt's embedded
      // stream: Harness stores one durable settlement per attempt, and the
      // per-delta log event it used to be no longer exists.
      child.append('assistant/attempt', {
        turn: 1,
        step: 1,
        stream: [{
          type: 'chunk',
          time: ORIGIN,
          chunk: {
            type: 'usage',
            // `reasoningTokens` is already inside `outputTokens` by upstream's
            // contract, which is why the row may sum the buckets at all.
            usage: {
              inputTokens: 4_000, outputTokens: 800, cacheReadTokens: 200,
              cacheWriteTokens: 100, reasoningTokens: 300,
            },
          },
        }],
      } as never)
      expect(projection.snapshot().subagents[0]?.tokens).toBe(5_100)
      projection.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses to attribute a fork-seeded child’s inherited usage to that child', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(ORIGIN)
    const { ctx } = await harness()
    try {
      // A REAL parent log with a real completed turn and real provider usage,
      // taken as the seed rather than a hand-made `inheritedEventCount`: the
      // fork backend seeds a child with exactly this — a balanced
      // completed-turn prefix of its parent — and sets the inherited cut to its
      // length (dsh-subagent's `inheritedEventCount = seed.length`).
      const parent = ctx.sessions.create()
      parent.append('turn/start', { turn: 1 })
      parent.append('assistant/attempt', {
        turn: 1,
        step: 1,
        stream: [{
          type: 'chunk', time: ORIGIN, chunk: { type: 'usage', usage: { inputTokens: 44_000, outputTokens: 1_000 } },
        }],
      } as never)
      parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const seed = parent.snapshotEvents()
      expect(seed).toHaveLength(3)

      const child = ctx.sessions.create(undefined, {
        seed,
        inheritedEventCount: seed.length as never,
        meta: { isSeeded: true, parentSession: parent.id, origin: 'subagent' },
      })
      // The generic lineage fact the guard reads, straight from the store.
      expect(child.inheritedEventCount).toBe(seed.length)

      const { projection, start } = work(ctx, child)
      start(edge(child))
      child.append('subagent/descriptor', snapshotSubagentDescriptor({
        mode: 'one-shot', provider: 'fork', label: 'Fix OAuth flow',
      }))
      child.append('turn/start', { turn: 2 })
      child.append('assistant/attempt', {
        turn: 2,
        step: 1,
        stream: [{
          type: 'chunk', time: ORIGIN, chunk: { type: 'usage', usage: { inputTokens: 14_000, outputTokens: 1_000 } },
        }],
      } as never)
      vi.setSystemTime(ORIGIN + 42_000)
      child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

      // Harness's projection is cumulative over the COMPLETE log: 45k inherited
      // plus 15k of the child's own. That is the documented contract, not a bug.
      expect(ctx.sessionProjections.snapshot(child, ['tokenUsage']).values.tokenUsage).toEqual({
        uncachedInputTokens: 58_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0,
      })
      const row = projection.snapshot().subagents[0]
      // THE REGRESSION: Work must not present that 60k as this worker's spend.
      // Removing the inherited-history guard fails here.
      expect(row?.tokens).toBeUndefined()
      // The asymmetry is deliberate: `subagentTiming` DOES reset at the child's
      // own descriptor, so its active time stays honest for the same child.
      expect(row?.timing).toEqual({ settledMs: 42_000 })
      expect(subagentDuration(row!, ORIGIN + 99_000)).toEqual({ ms: 42_000, kind: 'active' })
      projection.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads the effective route from the child’s own logged request envelope', async () => {
    const { ctx, child } = await harness()
    try {
      const { projection, start } = work(ctx, child, { provider: 'created-with', model: 'created-model' })
      start(edge(child))
      // Before any request, creation-time options are all the child has.
      expect(projection.snapshot().subagents[0]?.route)
        .toEqual({ provider: 'created-with', model: 'created-model' })
      child.append('request/header', {
        header: { config: { provider: 'openai-codex', model: 'gpt-x', reasoningEffort: 'high' } },
        reason: 'initial',
      })
      // `Session.requestHeader()` is the canonical fold of those snapshots, and
      // the envelope a request was actually built under wins outright.
      expect(projection.snapshot().subagents[0]?.route)
        .toEqual({ provider: 'openai-codex', model: 'gpt-x', reasoningEffort: 'high' })
      projection.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
