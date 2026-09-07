/**
 * Capability probe: `ctx.llm`, against the real runtime.
 *
 * The compatibility evidence `tools/capability-probes.mjs` names for the `llm`
 * seam. `model.spec.ts` and `connect-catalog.spec.ts` cast hand-typed objects
 * through `as unknown as Context`, which proves dshline's own logic but never
 * asks the real `@deepseek-ai/dsh-llm` runtime for the fields those callers
 * read. This probe mounts the real `LlmRuntime` and a real abstract
 * `LlmAdapter` subclass — the same package `ctx.llm` publishes — and asserts
 * exactly the reads production code makes, nothing more:
 *
 * - `listProviders()` detaches `{ id, name }`, the route key `discover()` joins
 *   into every `/model` label and passes to `listModels`;
 * - `listModels()` returns the catalog `discover()` folds (`model.id`,
 *   `model.name`);
 * - `resolveModelInfo()` carries `context.contextWindow`,
 *   `reasoning.efforts[].id`, and `inputModalities` — the metadata shape
 *   dshline reads and the window may cache per selection;
 * - `listConfigurableProviders()` returns the directory fields
 *   `connect/catalog.ts` reads (`provider`, `displayName`, `settingsNs`,
 *   `settingsPath`, `declared`);
 * - `discoverModels()` answers a draft interrogation with the candidate fields
 *   `connect/model-editor.ts` folds (`id`, `name`, `contextWindow`,
 *   `maxTokens`).
 *
 * The adapter streams nothing: no dshline code path dispatches a model call —
 * the agent loop owns that — so `stream` is refused like the methods
 * `HarnessWork` must not call are in the jobs probe.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  LlmConfigurableProvider,
  LlmDiscoveredModel,
  LlmModelDiscoveryRequest,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

/** The one provider route this probe's adapter serves. */
const PROVIDER = 'probe-llm'

/** The settings namespace the probe's configurable-provider entry declares. */
const SETTINGS_NS = 'llm-pi-ai'

/** An adapter over the real abstract base, answering everything EXCEPT a call. */
class ProbeAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Probe Provider' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [{ provider, id: 'probe-model', name: 'Probe Model', inputModalities: ['text'] }]
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider, id: model, name: 'Probe Model', inputModalities: ['text'],
      context: { contextWindow: 65_536 },
      reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }] },
    }
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<never> {
    throw new Error('capability probe: dshline never dispatches a model call')
  }
}

/** Mount the real runtime and register the probe adapter's route. */
async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER], new ProbeAdapter())
  return ctx
}

describe('capability: llm', () => {
  it('lists registered routes as detached { id, name } metadata', async () => {
    const ctx = await mounted()
    try {
      expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'Probe Provider' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists one route\'s catalog with the id and name /model folds', async () => {
    const ctx = await mounted()
    try {
      const models = await ctx.llm.listModels(PROVIDER)
      expect(models).toEqual([
        { provider: PROVIDER, id: 'probe-model', name: 'Probe Model', inputModalities: ['text'] },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves exact model metadata the window and /model read', async () => {
    const ctx = await mounted()
    try {
      const info = await ctx.llm.resolveModelInfo(PROVIDER, 'probe-model')
      // The status line's context window, the carried-effort check, and the
      // modality gate for image I/O each read a different corner of this shape.
      expect(info.context?.contextWindow).toBe(65_536)
      expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'high'])
      expect(info.inputModalities).toEqual(['text'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('declares configurable providers /connect can list, registered or dormant', async () => {
    const ctx = await mounted()
    try {
      const entry: LlmConfigurableProvider = {
        provider: PROVIDER,
        displayName: 'Probe Provider',
        settingsNs: SETTINGS_NS,
        settingsPath: ['providers', PROVIDER],
        declared: false,
      }
      const handle = ctx.llm.registerConfigurableProviders([entry])
      try {
        expect(ctx.llm.listConfigurableProviders()).toEqual([entry])
      } finally {
        handle()
      }
      // Withdrawal is part of the contract /connect's watchers ride.
      expect(ctx.llm.listConfigurableProviders()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('interrogates a draft endpoint through a registered discovery', async () => {
    const ctx = await mounted()
    try {
      ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request: LlmModelDiscoveryRequest) => {
        expect(request.baseURL).toBe('http://localhost:9/probe')
        return [
          { id: 'gw-small', name: 'Gateway Small', contextWindow: 32_768, maxTokens: 8_192 },
          { id: 'gw-large', name: 'Gateway Large', contextWindow: 131_072, maxTokens: 32_768 },
        ] satisfies LlmDiscoveredModel[]
      })
      const discovered = await ctx.llm.discoverModels(SETTINGS_NS, { baseURL: 'http://localhost:9/probe' })
      // The draft fold reads exactly these four fields; nothing more is claimed.
      expect(discovered).toEqual([
        { id: 'gw-small', name: 'Gateway Small', contextWindow: 32_768, maxTokens: 8_192 },
        { id: 'gw-large', name: 'Gateway Large', contextWindow: 131_072, maxTokens: 32_768 },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
