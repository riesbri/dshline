/**
 * Capability probe: plan mode's logged Harness seam.
 *
 * Production dshline does not read a live `ctx.planMode` mirror; it folds the
 * committed `plan/mode` session events with `planModeAfter`. The real
 * `PlanModeController` registers the `plan` projection that reads those events,
 * while this probe appends typed event records and verifies dshline's consumer
 * over the resulting Session log. Model-loop selection and terminal
 * presentation are outside the probe.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { planModeAfter } from '../../src/modes.ts'

/** Mount the concrete controller and the real services it injects. */
async function mounted(): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PlanModeController, { section: 'Probe plan guidance' })
  const session = ctx.sessions.create(SessionId('plan-mode-probe'))
  const agent = { id: session.id, session, ctx } as unknown as Agent
  return { ctx, agent }
}

describe('capability: planMode', () => {
  it('folds typed plan/mode events through the real controller projection and dshline', async () => {
    const { ctx, agent } = await mounted()
    try {
      expect(ctx.planMode.get(agent)).toEqual({ active: false })
      agent.session.append('plan/mode', { active: true })
      expect(ctx.planMode.get(agent)).toEqual({ active: true })
      expect(sessionPlan(agent)).toBe(true)
      expect(ctx.sessionProjections.snapshot(agent.session).values.plan).toMatchObject({ active: true, pending: false })

      agent.session.append('plan/mode', { active: false })
      expect(ctx.planMode.get(agent)).toEqual({ active: false })
      expect(sessionPlan(agent)).toBe(false)
      expect(ctx.sessionProjections.snapshot(agent.session).values.plan).toMatchObject({ active: false, pending: false })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/** Fold the session's typed plan/mode stream through dshline's adapter. */
function sessionPlan(agent: Agent): boolean {
  return agent.session.snapshotEvents().reduce(planModeAfter, false)
}
