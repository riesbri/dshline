/**
 * Capability probe: `ctx.agentPresets`, against the real registry.
 *
 * dshline consumes this seam through the structural `AgentPresetsSeam` view in
 * `plugins/harness.ts`, deliberately WITHOUT importing the service's values —
 * a profile that mounts no registry must still start. That choice buys
 * degradation at the cost of a drift risk: nothing in the production build
 * compares the structural view with the real `@deepseek-ai/dsh-agent-preset-registry`
 * class. This probe is where that comparison lives, in both directions:
 *
 * - the real `AgentPresetRegistry` service is mounted with a real
 *   `AgentPreset` declaration supplying a real `plugins` list, and assigned to
 *   the structural view, so an upstream shape change fails this file at
 *   compile time — this file is in `tests/tsconfig.capability.json`, run by
 *   `pnpm run typecheck:capabilities` and by `pnpm typecheck`, so that claim is
 *   enforced by `tsc` and not only by Vitest transpiling and running it;
 * - the roster reads `/plugins` browses with (`list`, `resolve`, `defaultId`)
 *   are driven against that real declaration;
 * - `readDocument()` is asserted to render the declared child list back as the
 *   Loader's own entry-list YAML, which is what `/plugins` parses and, in the
 *   adopted generation, the ONLY composition read that exists;
 * - the `agentPreset` Session projection the registry registers folds the
 *   creation-header case `sessionFacts()` reads through the real projection
 *   registry.
 *
 * The authoring assertions the previous generation carried here are gone
 * because the architecture removed what they exercised. There is no `copy()`,
 * no `authorable` root, and no `path` to write: a preset is an ordinary
 * declaration row, and the registry "writes no declarations". Dropping those
 * assertions is the point of this migration, not a gap in coverage — a probe
 * that still expected a `copy()` would be asserting a contract this generation
 * deliberately withdrew.
 *
 * `mount`/`recompose`/`select` need a full agent composition to evaluate, so
 * they are not exercised here; their shapes are held by the structural
 * assignment above, and their behavior is upstream's own test territory.
 * @module
 */

import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { sessionFacts } from '../../src/plugins/harness.ts'
import type { AgentPresetsSeam } from '../../src/plugins/harness.ts'

/** An empty agent-plane composition: valid YAML, mounts no row at all. */
const COMPOSITION = '[]\n'

/**
 * Mount the real registry with one real declaration over it.
 *
 * This is the whole composition model the adopted generation replaced a preset
 * directory with: a registry service, and an ordinary `AgentPreset` row whose
 * `plugins` list IS the composition. There is no root to point at and no file
 * to lay out.
 * @returns a context carrying the real services.
 */
async function mounted(): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  // Injection precondition only: the registry declares `loader` alongside
  // `sessionProjections`, and it eagerly builds a Loader tree per declaration.
  ctx.provide('loader', {} as never)
  // A bare test context supplies the base URL a composition resolves its
  // package names against; upstream normally supplies the profile's own.
  ctx.baseUrl = `${pathToFileURL(tmpdir()).href}/`
  await ctx.plugin(AgentPresetRegistry, { default: 'shipped' })
  await ctx.plugin(AgentPreset, { id: 'shipped', name: 'shipped', plugins: [] })
  return { ctx }
}

describe('capability: agentPresets', () => {
  it('satisfies the structural seam view dshline consumes instead of the service', async () => {
    const { ctx } = await mounted()
    try {
      // The compile-time check the production build cannot make for itself:
      // the real service still satisfies every method and row shape
      // `plugins/harness.ts` declares. The value is discarded; the
      // assignability is the assertion.
      const seam: AgentPresetsSeam = ctx.agentPresets
      void seam
      expect(ctx.agentPresets.defaultId).toBe('shipped')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists a real declaration and resolves it, with no trust or path on the row', async () => {
    const { ctx } = await mounted()
    try {
      const rows = await ctx.agentPresets.list()
      expect(rows.map(row => [row.id, row.name])).toEqual([['shipped', 'shipped']])
      expect(rows[0]?.broken).toBeUndefined()
      // The two fields the previous generation's row carried and this one
      // deliberately does not: there is no file behind a preset, so there is no
      // path to report and nothing to classify a row as shipped or user-owned.
      expect(rows[0]).not.toHaveProperty('trust')
      expect(rows[0]).not.toHaveProperty('path')
      const resolved = await ctx.agentPresets.resolve('shipped')
      expect(resolved.id).toBe('shipped')
      await expect(ctx.agentPresets.resolve('missing')).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('renders one declaration back as entry-list YAML, and accepts nothing in return', async () => {
    const { ctx } = await mounted()
    try {
      const document = await ctx.agentPresets.readDocument('shipped')
      expect(document.agentPreset).toBe('shipped')
      expect(document.content).toBe(COMPOSITION)
      await expect(ctx.agentPresets.readDocument('missing')).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers the agentPreset projection sessionFacts reads', async () => {
    const { ctx } = await mounted()
    try {
      // A session created under a preset, the way the real creation header
      // records it.
      const id = SessionId('preset-probe')
      const session = Session.create(id, undefined, {
        version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: '/ws', isSeeded: false,
        agentPreset: 'shipped',
      })
      expect(sessionFacts(ctx, session)).toEqual({ presetId: 'shipped', started: false })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
