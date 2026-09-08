/**
 * Capability probe: the process-local `ctx.agents` registry.
 *
 * dshline uses the real registry in two places: Work resolves a live local
 * child with `get(sessionId)`, while session attachment delegates fresh and
 * resumed transitions to `create()` and `resume()`. This probe exercises the
 * real service/runtime dispatch, its entered-agent lookup, and the published
 * `AgentFactory` delegation seam without loading an AgentLoop.
 *
 * The factory below is deliberately local: its returned handles and agents do
 * not prove concrete loop creation, persistence loading, setup, announcement
 * policy, or lifecycle behavior. Those are owned by the installed provider.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, {
  type Agent,
  type AgentFactory,
  type AgentHandle,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

/** The minimum live shape the registry reads while storing an Agent. */
function localAgent(ctx: Context, id: SessionId): Agent {
  const session = { id }
  return { id, session, ctx } as unknown as Agent
}

/**
 * Publish a local handle through the real registry, as an AgentFactory would.
 * @param ctx - context carrying the real registry.
 * @param id - shared agent/session identity.
 * @returns a local handle backed by the registry's real registration path.
 */
function localHandle(ctx: Context, id: SessionId): AgentHandle {
  const agent = localAgent(ctx, id)
  const detach = ctx.agents.enter(agent, undefined)
  ctx.agents.announce(agent)
  return {
    agent,
    dispose: async () => { detach() },
  }
}

/** Mount the real registry without an agent loop or persistence plugin. */
async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  return ctx
}

describe('capability: agents', () => {
  it('returns an entered and announced live Agent by SessionId', async () => {
    const ctx = await mounted()
    const id = SessionId('capability-probe-entered')
    const agent = localAgent(ctx, id)
    const detach = ctx.agents.enter(agent, undefined)
    try {
      expect(ctx.agents.get(id)).toBe(agent)
      ctx.agents.announce(agent)
      expect(ctx.agents.get(id)).toBe(agent)
      detach()
      expect(ctx.agents.get(id)).toBeUndefined()
    } finally {
      detach()
      await ctx.fiber.dispose()
    }
  })

  it('delegates create and resume options through the AgentFactory seam', async () => {
    const ctx = await mounted()
    const creates: CreateAgentOptions[] = []
    const resumes: ResumeAgentOptions[] = []
    const factory: AgentFactory = {
      createAgent: async (_ownerCtx, options) => {
        creates.push(options)
        return localHandle(ctx, options.sessionId)
      },
      resume: async (_ownerCtx, options) => {
        resumes.push(options)
        return localHandle(ctx, options.resumeSessionId)
      },
    }
    const disposeFactory = ctx.agents.setFactory(factory)
    const createOptions: CreateAgentOptions = {
      sessionId: SessionId('capability-probe-created'),
      meta: { cwd: '/capability-probe' },
    }
    const resumeOptions: ResumeAgentOptions = {
      resumeSessionId: SessionId('capability-probe-resumed'),
    }
    try {
      const created = await ctx.agents.create(createOptions)
      expect(creates).toEqual([createOptions])
      expect(created.agent).toBe(ctx.agents.get(createOptions.sessionId))
      await created.dispose()
      expect(ctx.agents.get(createOptions.sessionId)).toBeUndefined()

      const resumed = await ctx.agents.resume(resumeOptions)
      expect(resumes).toEqual([resumeOptions])
      expect(resumed.agent).toBe(ctx.agents.get(resumeOptions.resumeSessionId))
      await resumed.dispose()
      expect(ctx.agents.get(resumeOptions.resumeSessionId)).toBeUndefined()
    } finally {
      disposeFactory()
      await ctx.fiber.dispose()
    }
  })
})
