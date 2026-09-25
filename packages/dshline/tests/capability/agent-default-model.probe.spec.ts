/**
 * Capability probe: `ctx.agentDefaultModel`, against the real service.
 *
 * The production selection path reads `currentSelection()` when a window opens
 * and calls `saveSelection()` after `/model` or `/reasoning` changes a default.
 *
 * The adopted generation took this service off the settings document entirely.
 * Its three fields are `Volatile` references on the row's own `Config`, and a
 * save is `configEditor.edit(entry, …)` addressed at this row's PROFILE ENTRY —
 * not a section some plugin handed a settings provider. So this probe claims
 * what the service now decides and what dshline reads from it:
 *
 * 1. the composition selection, and that a save on a row that is not a profile
 *    entry resolves and writes nothing rather than throwing;
 * 2. that `currentSelection()` projects the row's own configuration rather than a
 *    snapshot taken at mount, and when a composed reasoning effort is projected
 *    at all;
 * 3. that the instance keeps itself off generated settings pages, and withdraws
 *    that policy together with its fiber.
 *
 * The persistence half — a `configEditor` writing a real profile patch, and the
 * Loader committing it — belongs to packages this one does not depend on, and is
 * not claimed here.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import type { Config } from '@deepseek-ai/dsh-agent-default-model'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

/** The composition entry every case below starts from. */
const COMPOSED = { provider: 'probe-provider', model: 'probe-model' }

/**
 * Mount the concrete service over the composition entry under test.
 * @param options - whether to provide the settings and configuration-editor
 *   seams this service would see inside a profile.
 * @returns the context, the row's fiber, and a counter of editor writes.
 */
async function mounted(options: { seams?: boolean; composed?: Config } = {}): Promise<{
  ctx: Context
  row: Fiber
  editor: { edits: number }
}> {
  const ctx = new Context()
  const editor = { edits: 0 }
  const row = await ctx.plugin(AgentDefaultModelConfig, options.composed ?? COMPOSED)
  if (options.seams ?? true) {
    ctx.provide('configEditor', { edit: async () => { editor.edits += 1 } })
    // Present but deliberately inert: this probe claims a save is refused BEFORE
    // the editor is reached, because a row with no profile entry has nothing to
    // address.
    ctx.provide('settings', { configure: () => () => {} })
  }
  return { ctx, row, editor }
}

/** A selection stored by a reader through `/model` and `/reasoning`. */
const SAVED: ModelSelection = {
  provider: 'saved-provider',
  model: 'saved-model',
  reasoningEffort: ReasoningEffortId('high'),
}

describe('capability: agentDefaultModel', () => {
  it('publishes the composition selection and stores nothing without a profile entry', async () => {
    // A row mounted outside a profile has no entry id and so nothing to address.
    // The save resolves and writes nothing: a deployment without a configuration
    // editor keeps its composition entry, which is what the window then draws.
    const { ctx, editor } = await mounted()
    try {
      expect(ctx.agentDefaultModel.currentSelection()).toEqual({
        provider: 'probe-provider',
        model: 'probe-model',
      })
      await expect(ctx.agentDefaultModel.saveSelection(SAVED)).resolves.toBeUndefined()
      expect(editor.edits).toBe(0)
      expect(ctx.agentDefaultModel.currentSelection()).toEqual({
        provider: 'probe-provider',
        model: 'probe-model',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries the composed reasoning effort only when the row declares one', async () => {
    // The projection is not a fixed shape: an omitted field must be ABSENT rather
    // than present and undefined, because this value goes straight into a request.
    const without = await mounted()
    try {
      expect(Object.keys(without.ctx.agentDefaultModel.currentSelection()).sort())
        .toStrictEqual(['model', 'provider'])
    } finally {
      await without.ctx.fiber.dispose()
    }

    const declared = await mounted({
      composed: { ...COMPOSED, reasoningEffort: ReasoningEffortId('high') },
    })
    try {
      expect(declared.ctx.agentDefaultModel.currentSelection()).toEqual({
        provider: 'probe-provider',
        model: 'probe-model',
        reasoningEffort: ReasoningEffortId('high'),
      })
    } finally {
      await declared.ctx.fiber.dispose()
    }
  })

  it('derives every read from the row’s own config rather than a snapshot at mount', async () => {
    // What a stored choice needs: the value in force is whatever the row
    // currently declares, not what it declared when the service was constructed.
    // A snapshot would make a stored `/model` apply only to the NEXT window —
    // which is what the `Volatile` fields exist to prevent, since Harness commits
    // one by mutating the live reference rather than reloading the row. A change
    // to the composition entry reaches it through that row's own reload, and the
    // row is the same row afterwards.
    const { ctx, row } = await mounted()
    try {
      const uid = row.uid
      row.update({ ...COMPOSED, model: 'saved-model', reasoningEffort: ReasoningEffortId('high') })
      await row.await()
      expect(ctx.agentDefaultModel.currentSelection()).toEqual({
        provider: 'probe-provider',
        model: 'saved-model',
        reasoningEffort: ReasoningEffortId('high'),
      })
      expect(row.uid).toBe(uid)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps its own instance off generated settings pages, and withdraws that with the fiber', async () => {
    const calls: { policy: { auto?: boolean }; released: boolean }[] = []
    const ctx = new Context()
    ctx.provide('settings', {
      configure: (policy: { auto?: boolean }) => {
        const call = { policy, released: false }
        calls.push(call)
        return () => { call.released = true }
      },
    })
    const row = await ctx.plugin(AgentDefaultModelConfig, COMPOSED)
    await ctx.fiber.await()
    // Only the caller's own instance is affected, and the policy is what keeps a
    // model route out of a generated settings page it has no business in.
    expect(calls).toStrictEqual([{ policy: { auto: false }, released: false }])
    await row.dispose()
    expect(calls).toStrictEqual([{ policy: { auto: false }, released: true }])
    await ctx.fiber.dispose()
  })
})
