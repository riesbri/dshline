/**
 * Capability probe: `ctx.subagents`.
 *
 * Exercises the exact provider-neutral lifecycle contract `HarnessWork`
 * consumes — `subagent/start`/`subagent/end`/`subagent/disposed` scoped to the delegating parent,
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
import SubagentRuntime, { type SubagentProvider, type SubagentResult, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarnessWork } from '../../src/work/index.ts'

const PROBE_PROVIDER_NAME = 'capability-probe'

/** A provider with no real backend: no process, no model, no persistence. */
function createProbeProvider(): {
  readonly provider: SubagentProvider
  readonly settle: (result: SubagentResult) => void
  readonly disposeStarted: Promise<void>
  readonly releaseDispose: () => void
} {
  let settle: ((result: SubagentResult) => void) | undefined
  let disposeStartedResolve: (() => void) | undefined
  let resolveDispose: (() => void) | undefined
  let disposeReleased = false
  const disposeStarted = new Promise<void>(resolve => { disposeStartedResolve = resolve })
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
        dispose: () => {
          disposeStartedResolve?.()
          return new Promise<void>(resolve => {
            resolveDispose = resolve
            if (disposeReleased) resolve()
          })
        },
      }
    },
  }
  return {
    provider,
    settle: result => settle?.(result),
    disposeStarted,
    releaseDispose: () => {
      disposeReleased = true
      resolveDispose?.()
    },
  }
}

describe('capability: subagents', () => {
  let scope: Scope | undefined

  afterEach(async () => {
    await scope?.dispose()
    scope = undefined
  })

  it('observes provider-neutral lifecycle through ctx.subagents and generic Work', async () => {
    const ctx = new Context()
    let settle: ((result: SubagentResult) => void) | undefined
    let releaseDispose: (() => void) | undefined
    let run: SubagentRun | undefined
    let disposing: Promise<void> | undefined
    let work: ReturnType<typeof createHarnessWork> | undefined
    try {
      await ctx.plugin(SubagentRuntime)
      const probe = createProbeProvider()
      settle = probe.settle
      releaseDispose = probe.releaseDispose
      ctx.subagents.registerProvider(probe.provider)

      const parent = {
        id: 'capability-probe-parent',
        session: { id: 'capability-probe-parent', header: { cwd: '/tmp' } },
      } as unknown as Agent
      scope = createScope(ctx, parent)
      Object.assign(parent, { ctx: scope.ctx })

      const controller = new AbortController()
      work = createHarnessWork(ctx, parent, () => {})
      expect(work.snapshot()).toEqual({ available: true, workflows: [], subagents: [], jobs: [] })

      run = await ctx.subagents.start(PROBE_PROVIDER_NAME, {
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
      // The real Harness seam delivers `subagent/end` before consumer-owned
      // disposal, so Work must retain the same lifecycle epoch as stopping.
      expect(work.snapshot().subagents).toMatchObject([{ state: 'stopping', runId: expect.any(String) }])
      disposing = run.dispose()
      await probe.disposeStarted
      // Disposal is independently held open: result settlement alone must not
      // remove the retained lifecycle epoch.
      expect(work.snapshot().subagents).toMatchObject([{ state: 'stopping' }])
      releaseDispose()
      await disposing
      // Both lifecycle deliveries are synchronous, but let any pending microtask
      // from cordis' emit settle first.
      await Promise.resolve()

      expect(work.snapshot().subagents).toEqual([])
      work.dispose()
      work = undefined
    } finally {
      // Resolve every externally controlled edge before tearing down the real
      // Harness scope; a failed assertion must not leave a handle awaiting us.
      settle?.({ output: [], stopReason: 'cancelled' })
      if (run !== undefined && disposing === undefined) disposing = run.dispose()
      releaseDispose?.()
      if (disposing !== undefined) await disposing.catch(() => {})
      work?.dispose()
      await ctx.fiber.dispose()
    }
  })
})
