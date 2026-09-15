/**
 * Capability probe: the process-local `ctx.agents` registry.
 *
 * dshline uses the real registry in two places: Work resolves a live local
 * child with `get(sessionId)`, while session attachment delegates fresh and
 * resumed transitions to `create()` and `resume()`. This probe exercises the
 * real service/runtime dispatch, its entered-agent lookup, and the published
 * `AgentFactory` delegation seam without loading an AgentLoop.
 *
 * Publication is ordered: `enter()` inserts an unannounced entry and
 * `announce(agent, source)` awaits the serial `agent/created` listeners that
 * complete initialization before any queued work proceeds.
 *
 * It proves the registry's own dispatch and the lifecycle source each
 * publication reports — not AgentLoop creation, model setup, persistence
 * loading, announcement policy, or provider behavior.
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
  type SessionStartSource,
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
 *
 * The source is a parameter rather than a constant because `agent/created`
 * carries it as part of the upstream lifecycle contract, and a factory that
 * announced every publication as `startup` would misreport its own resume path
 * to every listener that reads it. `SessionStartSource` is upstream's own
 * union; no parallel one is declared here.
 * @param ctx - context carrying the real registry.
 * @param id - shared agent/session identity.
 * @param source - why this agent is being published, as the lifecycle edge reports it.
 * @returns a local handle backed by the registry's real registration path,
 *   after its awaited creation announcement has settled.
 */
async function localHandle(ctx: Context, id: SessionId, source: SessionStartSource): Promise<AgentHandle> {
  const agent = localAgent(ctx, id)
  const detach = ctx.agents.enter(agent, undefined)
  await ctx.agents.announce(agent, source)
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
      // Publication is an awaited edge: `announce` runs serial `agent/created`
      // listeners and resolves only once every one of them has finished, and a
      // detach requested while that dispatch is in flight is deferred until it
      // settles. Awaiting is what makes the removal below observable rather
      // than merely requested.
      await ctx.agents.announce(agent, 'startup')
      expect(ctx.agents.get(id)).toBe(agent)
      detach()
      expect(ctx.agents.get(id)).toBeUndefined()
    } finally {
      detach()
      await ctx.fiber.dispose()
    }
  })

  it('delegates create and resume options through the AgentFactory seam, each with its own lifecycle source', async () => {
    const ctx = await mounted()
    const creates: CreateAgentOptions[] = []
    const resumes: ResumeAgentOptions[] = []
    // What every `agent/created` listener saw, in publication order. The Goal
    // service is one such listener in production, and `source` is the only
    // thing distinguishing a fresh start from a reopened session on that edge.
    const sources: SessionStartSource[] = []
    ctx.on('agent/created', ({ source }) => { sources.push(source) })
    const factory: AgentFactory = {
      createAgent: async (_ownerCtx, options) => {
        creates.push(options)
        return await localHandle(ctx, options.sessionId, 'startup')
      },
      resume: async (_ownerCtx, options) => {
        resumes.push(options)
        return await localHandle(ctx, options.resumeSessionId, 'resume')
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

      // The two paths are distinguishable on the edge itself, not merely in the
      // factory's own bookkeeping.
      expect(sources).toEqual(['startup', 'resume'])
    } finally {
      disposeFactory()
      await ctx.fiber.dispose()
    }
  })
})
