/**
 * Capability probe: the Harness token meter, against the real service.
 *
 * This is the compatibility evidence `tools/capability-probes.mjs` names for the
 * `tokenMeter` seam, so it deliberately mounts the REAL `@deepseek-ai/dsh-token-meter`
 * over a real `SessionStore` and a real projection registry rather than a
 * dshline-shaped fake. Three contracts are asserted, because dshline's context
 * intelligence is built on exactly these three and nothing else:
 *
 * 1. the three projection units the status line and `/context` read are
 *    registered and reachable through the generic snapshot;
 * 2. `measure()` returns per-node prices keyed by durable seq, in surface order;
 * 3. a surface REPLACEMENT removes the shadowed nodes from that node set —
 *    which is what makes the entry list a picture of the model's current
 *    context rather than of the session's history.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { contextReading, ContextSurveyor } from '../../src/context/model.ts'
import { SessionProjectionObserver } from '../../src/projections/observer.ts'

/** Mount the real meter over the real store and registry. */
async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create() }
}

/** One user prompt on the surface. */
function prompt(session: Session, text: string): number {
  return session.append('user/message', {
    id: `m-${String(session.seq)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as never, { surfaceOp: 'append' }).seq
}

describe('capability: tokenMeter', () => {
  it('registers the three projection units dshline reads, through the generic snapshot', async () => {
    const { ctx, session } = await harness()
    const observer = new SessionProjectionObserver({
      registry: ctx.sessionProjections,
      session,
      invalidate: () => {},
    })
    prompt(session, 'hello')

    const snapshot = observer.snapshot()
    expect(snapshot).toBeDefined()
    // The keys, by name: this is what "the token meter is mounted" means to
    // dshline, and an upstream rename would fail here rather than as a silent
    // blank panel.
    expect(snapshot?.values.contextPressure).toBeDefined()
    expect(snapshot?.values.contextBreakdown).toBeDefined()
    expect(snapshot?.values.tokenUsage).toBeDefined()

    const reading = contextReading(snapshot)
    expect(reading.projections).toBe(true)
    expect(reading.metered).toBe(true)
    // No provider has reported a prompt size, so occupancy is absent rather
    // than zero — the case `/context` must not fabricate a percentage for.
    expect(reading.occupancy).toBeUndefined()
    expect(reading.composition?.messages).toBeGreaterThan(0)
    observer.dispose()
  })

  it('prices current surface nodes by durable seq and drops a shadowed range', async () => {
    const { ctx, session } = await harness()
    const first = prompt(session, 'a'.repeat(400))
    const second = prompt(session, 'b'.repeat(80))

    const before = ctx.tokenMeter.measure(session)
    expect(before.nodes.map(node => node.seq)).toEqual([first, second])
    // Larger content prices higher: the ordering the entry list depends on.
    const bySeq = new Map(before.nodes.map(node => [node.seq, node.tokens]))
    expect(bySeq.get(first)).toBeGreaterThan(bySeq.get(second) ?? 0)
    expect(before.surfaceTokens).toBe(before.nodes.reduce((sum, node) => sum + node.tokens, 0))

    // A replacement shadowing both nodes: exactly what a compaction commits,
    // carrying the durable checkpoint source every backend must write —
    // `compactCheckpointSource(compactionId)` in
    // `@deepseek-ai/dsh-compaction/checkpoint`.
    const summary = session.append('user/message', {
      id: 'm-summary',
      role: 'user',
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'probe-compaction' },
    } as never, {
      surfaceOp: { op: 'replace', start: first, end: second },
      sourceEventSeqs: [first, second],
    })

    const after = ctx.tokenMeter.measure(session)
    expect(after.nodes.map(node => node.seq)).toEqual([summary.seq])
    expect(after.surfaceTokens).toBeLessThan(before.surfaceTokens)

    // And the surveyor, which is dshline's only consumer of that node set,
    // reports the same thing: one entry, the summary, recognized as a
    // replacement off the generic surface contract.
    const surveyor = new ContextSurveyor({ meter: () => ctx.tokenMeter, session, limit: 8 })
    const survey = surveyor.read()
    expect(survey.available).toBe(true)
    expect(survey.nodes).toBe(1)
    expect(survey.entries[0]?.seq).toBe(summary.seq)
    // Named a summary from compaction's own provenance, not merely because a
    // range was replaced — the surface contract permits any producer to replace.
    expect(survey.entries[0]?.kind).toBe('summary')
    expect(survey.entries[0]?.replaced).toBe(true)
  })

  it('measures once per surface revision, not once per read', async () => {
    const { ctx, session } = await harness()
    prompt(session, 'first')
    let measured = 0
    const surveyor = new ContextSurveyor({
      meter: () => ({
        measure: session_ => {
          measured += 1
          return ctx.tokenMeter.measure(session_)
        },
      }),
      session,
      limit: 8,
    })

    surveyor.read()
    surveyor.read()
    surveyor.read()
    expect(measured).toBe(1)

    // A non-surface event — the shape a turn appends around every reply — must
    // not cost a remeasurement.
    session.append('turn/start', { turn: 1 })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [] } as never)
    surveyor.read()
    expect(measured).toBe(1)

    // A surface event must.
    prompt(session, 'second')
    surveyor.read()
    expect(measured).toBe(2)
  })
})
