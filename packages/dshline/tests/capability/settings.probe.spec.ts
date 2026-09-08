/**
 * Capability probe: `ctx.settings`, against the real base contract.
 *
 * `settings.spec.ts` already mounts the real `SettingsProvider`, but only for
 * dshline's own namespace via the owner scope (`get`/`update`). This probe
 * exercises the real base `describe()`/`mutate()` path-op and revision logic
 * over a local in-memory load/persist implementation—the storage and watcher
 * behavior of a concrete deployment remain outside its claim. Those are the
 * operations Connect and `/plugins` rely on:
 *
 * - `describe()` publishes one descriptor per namespace with the `revision`
 *   Connect carries into every write, plus `value`/`user` for the overridden
 *   marking the catalog reads;
 * - `mutate()` applies `{ op: 'set', path }` edits while preserving the
 *   current section — the path-op merge contract those consumers rely on;
 * - `unset` removes exactly one path;
 * - a write naming a stale `expectedRevision` rejects with
 *   `SettingsConflictError` — the conflict check that stops a stale browser
 *   snapshot from overwriting something configured in the meantime.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import SettingsProvider, { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { describe, expect, it } from 'vitest'

/** The namespace this probe registers, standing in for a provider profile. */
const NS = 'probe-llm' as SettingsNamespace

/** A settings provider holding its document in memory, like a real file provider. */
class MemorySettings extends SettingsProvider {
  /** Raw document, namespace to raw section. */
  static seed: Record<string, unknown> = {}

  readonly writable = true

  /**
   * @returns the seeded raw document.
   */
  protected async load(): Promise<Record<string, unknown>> {
    return structuredClone(MemorySettings.seed)
  }

  /**
   * @param _ns - the namespace being written.
   * @param section - the merged user section.
   */
  protected async persist(_ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    MemorySettings.seed = { ...MemorySettings.seed, [_ns as string]: structuredClone(section) }
  }
}

/**
 * Mount the real provider and register one profile-shaped namespace.
 * @returns the mounted context.
 */
async function mounted(): Promise<Context> {
  MemorySettings.seed = {
    [NS]: { displayName: 'Shipped', baseURL: 'http://shipped.example', apiKeyEnv: 'SHIPPED_KEY' },
  }
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  ctx.settings.register(NS, Schema.object({
    displayName: Schema.string().default(''),
    baseURL: Schema.string().default(''),
    apiKeyEnv: Schema.string().role('credential-ref'),
  }))
  // The registration rides an effect, which settles asynchronously.
  await new Promise(resolve => setTimeout(resolve, 0))
  return ctx
}

describe('capability: settings', () => {
  it('describes a namespace with the revision a write is checked against', async () => {
    const ctx = await mounted()
    try {
      const [descriptor] = ctx.settings.describe()
      expect(descriptor.ns).toBe(NS)
      expect(descriptor.revision).toBe(0)
      expect(descriptor.value).toMatchObject({ displayName: 'Shipped', baseURL: 'http://shipped.example' })
      // Presence in `user` is what marks a field user-overridden.
      expect(descriptor.user).toMatchObject({ displayName: 'Shipped' })
      // The revision advances when the RAW section changes, which is what a
      // conflict-checked write compares against.
      await ctx.settings.mutate(NS, [{ op: 'set', path: ['displayName'], value: 'Moved' }])
      expect(ctx.settings.describe().find(d => d.ns === NS)?.revision).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('applies path ops without deleting fields the caller never saw', async () => {
    const ctx = await mounted()
    const [descriptor] = ctx.settings.describe()
    try {
      // A caller writes one nested path while the base preserves the section.
      await ctx.settings.mutate(NS, [
        { op: 'set', path: ['providers', 'gw', 'baseURL'], value: 'http://localhost:9' },
      ], descriptor.revision)
      const after = ctx.settings.describe().find(d => d.ns === NS)
      expect(after?.user).toMatchObject({
        displayName: 'Shipped',
        baseURL: 'http://shipped.example',
        providers: { gw: { baseURL: 'http://localhost:9' } },
      })
      expect(after?.value).toMatchObject({ apiKeyEnv: 'SHIPPED_KEY' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('unsets exactly one path', async () => {
    const ctx = await mounted()
    try {
      await ctx.settings.mutate(NS, [
        { op: 'set', path: ['providers', 'gw', 'baseURL'], value: 'http://localhost:9' },
        { op: 'unset', path: ['baseURL'] },
      ])
      const after = ctx.settings.describe().find(d => d.ns === NS)
      expect(after?.user).toMatchObject({ displayName: 'Shipped' })
      expect((after?.user as Record<string, unknown>).baseURL).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a write naming a stale revision with SettingsConflictError', async () => {
    const ctx = await mounted()
    const [descriptor] = ctx.settings.describe()
    try {
      // Something else writes between this caller's read...
      await ctx.settings.mutate(NS, [{ op: 'set', path: ['displayName'], value: 'Moved' }])
      // ...so the checked write must refuse rather than clobber it.
      await expect(ctx.settings.mutate(NS, [
        { op: 'set', path: ['displayName'], value: 'Stale' },
      ], descriptor.revision)).rejects.toBeInstanceOf(SettingsConflictError)
      expect(ctx.settings.get(NS)).toMatchObject({ displayName: 'Moved' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
