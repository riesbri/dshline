/**
 * Capability probe: `ctx.agentDefaultModel`, against the real service.
 *
 * The production selection path reads `currentSelection()` when a window opens
 * and calls `saveSelection()` after `/model` or `/reasoning` changes a default.
 * This probe uses the concrete Harness `AgentDefaultModelConfig` runtime over
 * the real abstract `SettingsProvider` contract when persistence is available;
 * the settings subclass supplies only an in-memory document. It therefore
 * proves the service's composition fallback, the consumed selection shape, and
 * the optional settings write, not any deployment's filesystem persistence.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import { describe, expect, it } from 'vitest'

/** In-memory persistence used only to expose the real settings-backed path. */
class MemorySettings extends SettingsProvider {
  static document: Record<string, unknown> = {}
  readonly writable = true

  protected async load(): Promise<Record<string, unknown>> {
    return structuredClone(MemorySettings.document)
  }

  protected async persist(namespace: string, section: Record<string, unknown>): Promise<void> {
    MemorySettings.document = { ...MemorySettings.document, [namespace]: structuredClone(section) }
  }
}

/** Mount the concrete service with or without the optional settings seam. */
async function mounted(withSettings: boolean): Promise<Context> {
  const ctx = new Context()
  if (withSettings) {
    MemorySettings.document = {}
    await ctx.plugin(MemorySettings)
  }
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'probe-provider', model: 'probe-model' })
  await new Promise<void>(resolve => setImmediate(resolve))
  return ctx
}

const SAVED: ModelSelection = {
  provider: 'saved-provider',
  model: 'saved-model',
  reasoningEffort: ReasoningEffortId('high'),
}

describe('capability: agentDefaultModel', () => {
  it('publishes the composition selection without a settings provider', async () => {
    const ctx = await mounted(false)
    try {
      expect(ctx.agentDefaultModel.currentSelection()).toEqual({
        provider: 'probe-provider',
        model: 'probe-model',
      })
      await expect(ctx.agentDefaultModel.saveSelection(SAVED)).resolves.toBeUndefined()
      // Without settings the composition entry remains the source of truth.
      expect(ctx.agentDefaultModel.currentSelection()).toEqual({
        provider: 'probe-provider',
        model: 'probe-model',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads a saved selection through the real SettingsProvider path', async () => {
    const ctx = await mounted(true)
    try {
      await ctx.agentDefaultModel.saveSelection(SAVED)
      expect(ctx.agentDefaultModel.currentSelection()).toEqual(SAVED)
      expect(MemorySettings.document['agent-default-model']).toEqual({
        provider: 'saved-provider',
        model: 'saved-model',
        reasoningEffort: 'high',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
