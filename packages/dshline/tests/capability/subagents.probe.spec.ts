/**
 * Capability probe: `ctx.subagents`.
 *
 * Exercises the exact provider-neutral lifecycle contract `HarnessWork`
 * consumes — `subagent/start`/`subagent/end` scoped to the delegating parent,
 * `registerProvider`, and `SubagentActivation` — against the real
 * `@deepseek-ai/dsh-subagent` service, through the same `createHarnessWork`
 * wiring production code uses. The registered provider is a trivial in-repo
 * stand-in, not modeled on any real backend (Codex, Claude Code, …): the point
 * is the generic seam, never a provider-specific integration.
 * @module
 */

import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SubagentRuntime, { type SubagentProvider, type SubagentResult } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarnessWork } from '../../src/work/index.ts'

const PROBE_PROVIDER_NAME = 'capability-probe'

/** Directory selection only: no model context or filesystem is exercised by this probe. */
class ProbeWorkingDirectory extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  async ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return agent.session.header.cwd ?? '/tmp'
  }
}

/** A non-driving parent, published through the real host registry over a real Session. */
function probeParent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId('capability-probe-parent'), { meta: { cwd: '/tmp' } })
  const inbox = createInboxStub()
  return {
    id: session.id, session, ctx, options: {}, status: 'idle', inbox,
    send: (message, target) => { inbox.append(target, message) },
    followup: message => { inbox.append('next-turn', message) },
    steer: message => { inbox.append('next-step', message) },
    inject: message => { inbox.append('next-step', message) },
    cancel: (_cause, options) => { if (!options?.keepInbox) inbox.clear() },
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
  }
}

/** A provider with no real backend: no process, no model, no persistence. */
function createProbeProvider(): { readonly provider: SubagentProvider, settle: (result: SubagentResult) => void } {
  let settle: ((result: SubagentResult) => void) | undefined
  const provider: SubagentProvider = {
    name: PROBE_PROVIDER_NAME,
    capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start: async request => {
      void request
      return {
        id: SessionId('capability-probe-child'),
        localAgent: undefined,
        result: new Promise<SubagentResult>(resolve => { settle = resolve }),
        dispose: async () => {},
      }
    },
  }
  return { provider, settle: result => settle?.(result) }
}

describe('capability: subagents', () => {
  let scope: Scope | undefined

  afterEach(async () => {
    await scope?.dispose()
    scope = undefined
  })

  it('observes provider-neutral lifecycle through ctx.subagents and generic Work', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(ProbeWorkingDirectory)
      await ctx.plugin(SubagentRuntime)
      // The human prompt operation is a public instance method on the same
      // service object, which is what lets a same-process terminal call it
      // instead of the model-authored `sendMessage`. Asserted against the real
      // runtime, not a fake.
      expect(typeof ctx.subagents.prompt).toBe('function')
      const { provider, settle } = createProbeProvider()
      ctx.subagents.registerProvider(provider)

      const parent = probeParent(ctx)
      scope = createScope(ctx, parent)
      Object.assign(parent, { ctx: scope.ctx })
      await ctx.agents.register(parent)
      expect(ctx.agents.get(parent.id)).toBe(parent)

      const controller = new AbortController()
      const work = createHarnessWork(ctx, parent, () => {})
      expect(work.snapshot()).toEqual({ available: true, workflows: [], subagents: [], jobs: [] })

      // A lookalike with the same durable id is not the live host owner.
      await expect(ctx.subagents.startActivation({
        provider: PROBE_PROVIDER_NAME,
        label: 'unauthorized probe',
        request: { parent: { ...parent }, prompt: [{ type: 'text', text: 'probe' }] },
        signal: controller.signal,
        delivery: 'caller',
      })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(work.snapshot().subagents).toEqual([])

      const run = await ctx.subagents.startActivation({
        provider: PROBE_PROVIDER_NAME,
        label: 'capability probe',
        request: { parent, prompt: [{ type: 'text', text: 'probe' }] },
        signal: controller.signal,
        delivery: 'caller',
      })

      expect(work.snapshot().subagents).toEqual([
        expect.objectContaining({ id: String(run.childId), source: 'subagent', provider: PROBE_PROVIDER_NAME, local: false, state: 'running' }),
      ])

      settle({ output: [], stopReason: 'completed' })
      await run.result
      await run.dispose()
      // subagent/end delivery and HarnessWork's own handler are both synchronous
      // dispatch, but let any pending microtask from cordis' emit settle first.
      await Promise.resolve()

      expect(work.snapshot().subagents).toEqual([])
      work.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
