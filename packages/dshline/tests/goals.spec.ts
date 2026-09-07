/**
 * Harness Goal adapter: the split between the durable `goal` projection and
 * live, process-local activation.
 *
 * The tests that matter here are not about wording. They are about which
 * authority each half of the reading comes from, because both authorities
 * answer with a plausible-looking goal and only one of them is right for each
 * half. A regression that quietly went back to reading durable fields off
 * `ctx.goals.get(agent)` would render identically in every ordinary session and
 * would be wrong in exactly the resumed one.
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import GoalService, { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalActivation, GoalPhase, GoalProjection, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { SessionProjectionObserver } from '../src/projections/observer.ts'
import { goalReading } from '../src/goals/model.ts'

/**
 * One durable `goal` projection value, as the registry publishes it.
 * @param over - the durable fields that matter to a test.
 * @returns the projection value.
 */
function projection(over: {
  objective?: string
  phase?: GoalPhase
  roundsStarted?: number
  maxGoalRounds?: number
} = {}): GoalProjection {
  return {
    goal: {
      id: GoalId('goal-projected'),
      revision: 4,
      objective: over.objective ?? 'ship it',
      phase: over.phase ?? 'active',
      maxGoalRounds: over.maxGoalRounds ?? 256,
    },
    roundsStarted: over.roundsStarted ?? 3,
    createdAt: 1_000,
    updatedAt: 2_000,
  }
}

/**
 * One validated projection cut carrying a given `goal` value.
 * @param goal - the projection value, `null` for no current goal, or undefined to leave the key unregistered.
 * @returns the cut.
 */
function cut(goal: GoalProjection | null | undefined): ProjectionSnapshot {
  return { asOfSeq: 7, values: goal === undefined ? {} : { goal } } as ProjectionSnapshot
}

/** A counting activation source, so a test can prove it was never consulted. */
function activationSource(activation: GoalActivation | undefined): {
  read: () => GoalActivation | undefined
  calls: () => number
} {
  let calls = 0
  return { read: () => { calls += 1; return activation }, calls: () => calls }
}

/**
 * One source file with its comments removed.
 *
 * The assertion is about what the code does, and every prose explanation of the
 * split necessarily names the paths the code must not take.
 * @param url - the module's file URL.
 * @returns the source with block and line comments stripped.
 */
function code(url: URL): string {
  return readFileSync(fileURLToPath(url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
}

describe('the Goal projection adapter', () => {
  it('reports nothing without a projected goal, however the projection is missing', () => {
    // Three different absences, one presentation: no registry at all, a
    // registry that never registered the goal unit, and the goal domain's own
    // "no current goal". None of them is a goal, and none may become one by
    // asking the service what it thinks.
    const never = activationSource('armed')
    expect(goalReading(undefined, never.read)).toBeUndefined()
    expect(goalReading(cut(undefined), never.read)).toBeUndefined()
    expect(goalReading(cut(null), never.read)).toBeUndefined()
    expect(never.calls()).toBe(0)
  })

  it('counts the rounds from the projection while live activation is armed', () => {
    expect(goalReading(cut(projection()), () => 'armed'))
      .toEqual({ label: 'goal 3/256', running: true })
  })

  it('says armed rather than nought of a cap no round has approached', () => {
    // `goal 0/256` reads as a progress meter stuck at zero. It is not progress
    // at all: 256 is the deployment's round cap, and nothing has been spent.
    expect(goalReading(cut(projection({ roundsStarted: 0 })), () => 'armed'))
      .toEqual({ label: 'goal armed', running: true })
  })

  it('marks a durably active goal that this process will not continue', () => {
    // The resumed-session shape, and the whole reason for the split: the log
    // says active, the process says disarmed, and only the second one predicts
    // what will happen next.
    expect(goalReading(cut(projection()), () => 'disarmed'))
      .toEqual({ label: 'goal idle', running: false })
  })

  it('treats an unobtainable activation as idle rather than inferring armed', () => {
    // No goal service, no live agent, a refused read. The durable phase is
    // still `active`, and inferring `armed` from it is the exact claim this
    // adapter must never make.
    expect(goalReading(cut(projection()), () => undefined))
      .toEqual({ label: 'goal idle', running: false })
  })

  it('takes a stopped phase from the projection without consulting the service at all', () => {
    // A paused, blocked, or complete goal reads the same whatever activation
    // says, so asking is a pointless service call on a line redrawn by every
    // spinner beat — and a call the service documents as able to throw.
    for (const phase of ['paused', 'blocked', 'complete'] as const) {
      const source = activationSource('armed')
      expect(goalReading(cut(projection({ phase })), source.read), phase)
        .toEqual({ label: `goal ${phase}`, running: false })
      expect(source.calls(), phase).toBe(0)
    }
  })

  it('never calls a goal running unless the projection is active and activation is armed', () => {
    const running = (phase: GoalPhase, activation: GoalActivation): boolean =>
      goalReading(cut(projection({ phase })), () => activation)?.running === true
    expect(running('paused', 'armed')).toBe(false)
    expect(running('complete', 'armed')).toBe(false)
    expect(running('active', 'disarmed')).toBe(false)
    expect(running('active', 'armed')).toBe(true)
  })

  it('keeps the objective out of the status reading, including when it is long', () => {
    const reading = goalReading(
      cut(projection({ objective: 'migrate every call site off the deprecated adapter' })),
      () => 'armed',
    )
    expect(reading).toEqual({ label: 'goal 3/256', running: true })
    expect(reading?.label).not.toContain('deprecated adapter')
  })
})

describe('the Goal authority split', () => {
  it('renders durable state from the projection and takes only activation from the service', () => {
    // The distinguishing test. Both authorities answer, and they disagree about
    // every durable field. A `GoalView` is exactly what `ctx.goals.get(agent)`
    // returns, so an implementation that went back to reading durable state
    // from the service would render the service's objective, phase, and counts
    // here — and this test is the only thing that would notice.
    const service: GoalView = {
      id: GoalId('goal-from-service'),
      revision: 99,
      objective: 'a stale objective the service still remembers',
      phase: 'complete',
      maxGoalRounds: 25,
      roundsStarted: 24,
      createdAt: 5,
      updatedAt: 6,
      activation: 'armed',
    }
    const durable = projection({
      objective: 'ship the release', phase: 'active', roundsStarted: 12, maxGoalRounds: 256,
    })
    const reading = goalReading(cut(durable), () => service.activation)
    // Durable half: entirely the projection's.
    expect(reading).toEqual({
      label: 'goal 12/256',
      running: true,
    })
    expect(reading?.label).not.toContain('stale objective')
    expect(reading?.label).not.toContain('complete')
    // The service's own round count, which shares no digits with `12/256`.
    expect(reading?.label).not.toContain('24')

    // Live half: entirely the service's. The same projection with a disarmed
    // process is idle, and not one character of the durable text moves.
    expect(goalReading(cut(durable), () => 'disarmed')).toEqual({
      label: 'goal idle',
      running: false,
    })
  })

  it('adds no dshline snapshot of its own and consumes only activation from the service', () => {
    // Two status-frame invariants no unit test of the adapter can see. Goal
    // shares the frame's one direct projection snapshot with Todo and the
    // context reading rather than taking a second one, and `.activation` is the
    // only field this frontend consumes from the goal service anywhere.
    //
    // Asserted against the source because neither is expressible in the type
    // system: the adopted Harness generation publishes no activation-only accessor, so `get()` hands
    // back a whole `GoalView` and nothing but this stops a durable field being
    // read off it. That call does resolve its own durable half through
    // `sessionProjections.stateOf()` internally — a service-side read, not a
    // dshline one, and not what this counts.
    const source = code(new URL('../src/attachment.ts', import.meta.url))
    const frame = source.slice(source.indexOf('const status = createStatusView('), source.indexOf('const streamView'))
    expect(frame.match(/projections\.snapshot\(\)/gu)).toHaveLength(1)
    expect(frame).toContain('goal: goalReading(projected, goalActivation)')
    expect(source.match(/get\('goals'\)/gu)).toHaveLength(1)
    expect(source).toContain('ctx.get(\'goals\')?.get(agent)?.activation')
  })
})

/** Mount the real goal domain beside the real registry and agent store. */
async function harness(): Promise<{ ctx: Context; agent: Agent; observer: SessionProjectionObserver }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  const session: Session = ctx.sessions.create()
  // The goal service needs the registry's exact live agent and nothing else
  // about one: no loop, no provider, no model.
  const agent = { id: session.id, session, ctx } as unknown as Agent
  ctx.agents.register(agent)
  const observer = new SessionProjectionObserver({
    registry: ctx.sessionProjections, session, invalidate: () => {},
  })
  return { ctx, agent, observer }
}

describe('the real Goal service and session projection', () => {
  it('reads the durable goal from the registry and activation from the service', async () => {
    const { ctx, agent, observer } = await harness()
    const created = ctx.goals.create(agent, { objective: 'ship the release', maxGoalRounds: 8 })
    // One continuation-shaped `user/message` attributed to the goal, folded
    // into `roundsStarted` by the real projection unit.
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'goal', goalId: created.id, revision: created.revision, round: 1 },
    }), { surfaceOp: 'append' })

    const durable = observer.snapshot()?.values.goal
    expect(durable?.goal.objective).toBe('ship the release')
    expect(durable?.goal.phase).toBe('active')
    expect(durable?.roundsStarted).toBe(1)
    // Activation is deliberately absent from the durable projection value.
    expect(durable).not.toHaveProperty('activation')

    expect(goalReading(observer.snapshot(), () => ctx.goals.get(agent)?.activation))
      .toEqual({ label: 'goal 1/8', running: true })
    observer.dispose()
  })

  it('reports idle after a real disarm, with the durable projection untouched', async () => {
    // The acceptance case for the whole change. `disarm()` is process-local: it
    // writes no `goal/change`, advances no revision, and notifies no listener.
    // A projection observer therefore cannot see it, which is exactly why the
    // service is still consulted for this one fact.
    const { ctx, agent, observer } = await harness()
    ctx.goals.create(agent, { objective: 'ship the release', maxGoalRounds: 8 })
    const before = observer.snapshot()
    expect(goalReading(before, () => ctx.goals.get(agent)?.activation)?.running).toBe(true)

    ctx.goals.disarm(agent)

    const after = observer.snapshot()
    // Durable authority: unchanged, still active, same revision, same cut.
    expect(after?.values.goal).toEqual(before?.values.goal)
    expect(after?.values.goal?.goal.phase).toBe('active')
    expect(after?.asOfSeq).toBe(before?.asOfSeq)
    // Live authority: disarmed.
    expect(ctx.goals.get(agent)?.activation).toBe('disarmed')
    // dshline joins the two into the one reading neither could give alone.
    expect(goalReading(after, () => ctx.goals.get(agent)?.activation))
      .toEqual({ label: 'goal idle', running: false })
    observer.dispose()
  })

  it('starts a reopened session idle and rearms only on a real resume', async () => {
    // The `agent/session-start` edge the service installs is what makes every
    // reopened session start disarmed; `resume()` is the authorized way back.
    const { ctx, agent, observer } = await harness()
    const created = ctx.goals.create(agent, { objective: 'ship the release', maxGoalRounds: 8 })
    ctx.emit('agent/session-start', { agent, session: agent.session })
    expect(observer.snapshot()?.values.goal?.goal.phase).toBe('active')
    expect(goalReading(observer.snapshot(), () => ctx.goals.get(agent)?.activation))
      .toEqual({ label: 'goal idle', running: false })

    ctx.goals.resume(agent, { id: created.id, revision: created.revision })
    expect(goalReading(observer.snapshot(), () => ctx.goals.get(agent)?.activation)?.running).toBe(true)
    observer.dispose()
  })

  it('takes a real pause, block, and complete from the projection alone', async () => {
    const { ctx, agent, observer } = await harness()
    const created = ctx.goals.create(agent, { objective: 'ship the release', maxGoalRounds: 8 })
    const paused = ctx.goals.pause(agent, { id: created.id, revision: created.revision })
    const never = activationSource('armed')
    expect(goalReading(observer.snapshot(), never.read)?.label).toBe('goal paused')

    const resumed = ctx.goals.resume(agent, { id: paused.id, revision: paused.revision })
    const blocked = ctx.goals.block(agent, { id: resumed.id, revision: resumed.revision }, {
      code: 'needs-input', message: 'waiting on a decision',
    })
    expect(goalReading(observer.snapshot(), never.read)?.label).toBe('goal blocked')

    ctx.goals.complete(agent, { id: blocked.id, revision: blocked.revision })
    expect(goalReading(observer.snapshot(), never.read)?.label).toBe('goal complete')
    // Not one of those three needed the live service.
    expect(never.calls()).toBe(0)
    observer.dispose()
  })

  it('drops the segment when a real clear leaves no current goal', async () => {
    const { ctx, agent, observer } = await harness()
    const created = ctx.goals.create(agent, { objective: 'ship the release' })
    ctx.goals.clear(agent, { id: created.id, revision: created.revision })
    expect(observer.snapshot()?.values.goal).toBeNull()
    expect(goalReading(observer.snapshot(), () => ctx.goals.get(agent)?.activation)).toBeUndefined()
    observer.dispose()
  })
})
