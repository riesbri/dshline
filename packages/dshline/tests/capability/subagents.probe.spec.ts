/**
 * Capability probe: `ctx.subagents`.
 *
 * Exercises the exact provider-neutral lifecycle contract `HarnessWork`
 * consumes — `subagent/start`/`subagent/end` scoped to the delegating parent,
 * `registerProvider`, and `SubagentRun` — against the real
 * `@deepseek-ai/dsh-subagent` service, through the same `createHarnessWork`
 * wiring production code uses. The registered provider is a trivial in-repo
 * stand-in, not modeled on any real backend (Codex, Claude Code, …): the point
 * is the generic seam, never a provider-specific integration.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SubagentRuntime, { type SubagentProvider, type SubagentResult } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarnessWork } from '../../src/work/index.ts'

const PROBE_PROVIDER_NAME = 'capability-probe'

/** A provider with no real backend: no process, no model, no persistence. */
function createProbeProvider(): { readonly provider: SubagentProvider, settle: (result: SubagentResult) => void } {
  let settle: ((result: SubagentResult) => void) | undefined
  const provider: SubagentProvider = {
    name: PROBE_PROVIDER_NAME,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start: async request => {
      void request
      return {
        id: 'capability-probe-child' as Agent['session']['id'],
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
      await ctx.plugin(SubagentRuntime)
      // The human prompt operation is a public instance method on the same
      // service object, which is what lets a same-process terminal call it
      // instead of the model-authored `sendMessage`. Asserted against the real
      // runtime, not a fake.
      expect(typeof ctx.subagents.prompt).toBe('function')
      const { provider, settle } = createProbeProvider()
      ctx.subagents.registerProvider(provider)

      const parent = {
        id: 'capability-probe-parent',
        session: { id: 'capability-probe-parent', header: { cwd: '/tmp' } },
      } as unknown as Agent
      scope = createScope(ctx, parent)
      Object.assign(parent, { ctx: scope.ctx })

      const controller = new AbortController()
      const work = createHarnessWork(ctx, parent, () => {})
      expect(work.snapshot()).toEqual({ available: true, workflows: [], subagents: [], jobs: [] })

      const run = await ctx.subagents.start(PROBE_PROVIDER_NAME, {
        label: 'capability probe',
        prompt: [{ type: 'text', text: 'probe' }],
        parent,
        signal: controller.signal,
      })

      expect(work.snapshot().subagents).toEqual([
        expect.objectContaining({ source: 'subagent', provider: PROBE_PROVIDER_NAME, local: false, state: 'running' }),
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
