/**
 * Capability probe: `ctx.settings`, against the real service.
 *
 * `settings.spec.ts` already mounts the real service, but for dshline's own row
 * and through its facets. This probe exercises the service's own operations —
 * `describe()`/`mutate()`/`update()`, their path-op and revision logic — which
 * are what Connect and `/plugins` rely on:
 *
 * - `describe()` publishes one descriptor per profile ENTRY, with the `revision`
 *   Connect carries into every write, plus `value`/`user` for the overridden
 *   marking the catalog reads;
 * - `mutate()` applies `{ op: 'set', path }` edits while preserving the current
 *   section — the path-op merge contract those consumers rely on;
 * - `unset` removes exactly one path;
 * - a write naming a stale `expectedRevision` rejects with
 *   `SettingsConflictError` — the conflict check that stops a stale browser
 *   snapshot from overwriting something configured in the meantime.
 *
 * The generation this probe targets deleted the consumer-side registration
 * outright: there is no `SettingsProvider` to subclass, no `register()`, and no
 * abstract `load`/`persist` pair. A namespace is the Loader profile entry id of a
 * row whose own `static Config` declares its fields, so the fixture below mounts
 * a real cordis fiber for the row and hands the service a configuration editor
 * that holds the raw profile section. Persistence to a real profile patch, and
 * the Loader's own commit of an accepted write, are the deployment's business
 * and are not claimed here; the service's decisions are.
 * @module
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import SettingsForms, { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'

/** The namespace this probe registers, standing in for a provider profile row. */
const NS = 'probe-llm'

/** One profile entry, as far as the settings service reads it. */
interface ProfileEntry {
  readonly id: string
  readonly options: { readonly id: string; readonly name: string; config: Record<string, unknown> }
  readonly fiber: Fiber
}

/** The configuration editor, as the settings service calls it. */
interface ConfigurationEditor {
  readonly documentPath: string
  entries(): ProfileEntry[]
  configuration(): {
    entry: ProfileEntry
    inherited: Record<string, unknown>
    override: Record<string, unknown>
  }[]
  edit(
    entry: ProfileEntry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** A profile-shaped row: the same fields a provider entry declares. */
const Probe = {
  Config: z.object({
    displayName: z.string().default('').volatile(),
    baseURL: z.string().default('').volatile(),
    apiKeyEnv: z.string().default('').role('credential-ref').volatile(),
    providers: z.dict(z.object({ baseURL: z.string().default('') })).default({}).volatile(),
  }),
  apply: () => {},
}

/** A row with no editable field at all, for the refusal the service names. */
const Inert = {
  Config: z.object({ fixed: z.string().default('fixed') }),
  apply: () => {},
}

/** A row with one live field beside one ordinary field, for the volatility rule. */
const Mixed = {
  Config: z.object({
    fixed: z.string().default('fixed'),
    live: z.number().min(1).default(2).volatile(),
  }),
  apply: () => {},
}

/** The raw section a started-from profile patch carries for the probe row. */
const SEED: Record<string, unknown> = {
  displayName: 'Shipped',
  baseURL: 'http://shipped.example',
  apiKeyEnv: 'SHIPPED_KEY',
}

/** What a mounted probe hands back. */
interface Mounted {
  readonly ctx: Context
  /** Notices the service published, as `[namespace, revision]` pairs. */
  readonly notices: [string, number][]
  /** The raw sections the editor was asked to persist, in order. */
  readonly persisted: Record<string, unknown>[]
}

/**
 * Mount the real service over one profile row, as a profile's Loader would.
 * @param options - the row's own schema, and the raw section it starts from.
 * @returns the mounted context and the records the service produced.
 */
async function mounted(options: { runtime?: typeof Probe | typeof Inert | typeof Mixed; patch?: Record<string, unknown> } = {}): Promise<Mounted> {
  const ctx = new Context()
  // The service waits on the Loader and reads the profile home for the document
  // it imports from a previous generation. A fresh temporary home has none, so
  // the import is a no-op rather than a rewrite of someone's home.
  const home = mkdtempSync(join(tmpdir(), 'dshline-settings-probe-'))
  ctx.provide('loader', { await: () => Promise.resolve() })
  ctx.provide('profileContext', {
    name: 'dshline-probe', home, dir: home, cwd: home, overlays: [], startedBundles: [],
    patchPath: join(home, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
  })

  const runtime = options.runtime ?? Probe
  const patch = options.patch ?? SEED
  const row = await ctx.plugin(runtime, patch)
  // A row's resolved config is where the service reads the values in force from,
  // so the editor keeps it in step with the raw section it persists.
  let resolved: Record<string, unknown> = { ...patch }
  row.config = resolved
  const entry: ProfileEntry = { id: NS, options: { id: NS, name: 'probe-llm', config: patch }, fiber: row }
  const persisted: Record<string, unknown>[] = []
  const editor: ConfigurationEditor = {
    documentPath: join(home, 'cordis.patch.yml'),
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: entry.options.config }],
    edit: async (_row, change) => {
      const next = change(entry.options.config, {})
      entry.options.config = next
      resolved = { ...resolved, ...next }
      row.config = resolved
      persisted.push(next)
    },
  }
  ctx.provide('configEditor', editor)
  await ctx.plugin(SettingsForms)
  const notices: [string, number][] = []
  // Subscribed after the mount, so the first `describe()` the service performs
  // while wiring itself up is not counted as a change this listener witnessed.
  ctx.settings.describe()
  ctx.on('settings/document-updated', (ns, revision) => { notices.push([ns, revision]) })
  return { ctx, notices, persisted }
}

describe('capability: settings', () => {
  it('describes a namespace with the revision a write is checked against', async () => {
    const { ctx } = await mounted()
    try {
      expect(ctx.settings.describe()).toMatchObject([{
        ns: NS,
        revision: 0,
        value: { displayName: 'Shipped', baseURL: 'http://shipped.example' },
        // Presence in `user` is what marks a field user-overridden.
        user: { displayName: 'Shipped' },
      }])
      // The revision advances when the RAW section changes, which is what a
      // conflict-checked write compares against.
      await ctx.settings.mutate(NS, [{ op: 'set', path: ['displayName'], value: 'Moved' }])
      expect(ctx.settings.describe().map(d => d.revision)).toStrictEqual([1])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('announces an entry change as settings/document-updated, once, with the new revision', async () => {
    const { ctx, notices } = await mounted()
    try {
      await ctx.settings.mutate(NS, [{ op: 'set', path: ['displayName'], value: 'Moved' }])
      // The feed is not value-gated: it announces the raw entry change, and it
      // carries the revision a consumer would send back with its next write.
      expect(notices).toStrictEqual([[NS, 1]])
      // Storing the value already in force changed nothing, so nothing is said.
      await ctx.settings.mutate(NS, [{ op: 'set', path: ['displayName'], value: 'Moved' }])
      expect(notices).toStrictEqual([[NS, 1]])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('applies path ops without deleting fields the caller never saw', async () => {
    const { ctx } = await mounted()
    const revision = ctx.settings.describe().map(d => d.revision)[0] ?? 0
    try {
      // A caller writes one nested path while the base preserves the section.
      await ctx.settings.mutate(NS, [
        { op: 'set', path: ['providers', 'gw', 'baseURL'], value: 'http://localhost:9' },
      ], revision)
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
    const { ctx } = await mounted()
    try {
      await ctx.settings.mutate(NS, [
        { op: 'set', path: ['providers', 'gw', 'baseURL'], value: 'http://localhost:9' },
        { op: 'unset', path: ['baseURL'] },
      ])
      const after = ctx.settings.describe().find(d => d.ns === NS)
      expect(after?.user).toStrictEqual({
        displayName: 'Shipped',
        apiKeyEnv: 'SHIPPED_KEY',
        providers: { gw: { baseURL: 'http://localhost:9' } },
      })
      expect(after?.value).toMatchObject({ apiKeyEnv: 'SHIPPED_KEY' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a write naming a stale revision with SettingsConflictError', async () => {
    const { ctx } = await mounted()
    const revision = ctx.settings.describe().map(d => d.revision)[0] ?? 0
    try {
      // Something else writes between this caller's read...
      await ctx.settings.mutate(NS, [{ op: 'set', path: ['displayName'], value: 'Moved' }])
      // ...so the checked write must refuse rather than clobber it.
      await expect(ctx.settings.mutate(NS, [
        { op: 'set', path: ['displayName'], value: 'Stale' },
      ], revision)).rejects.toBeInstanceOf(SettingsConflictError)
      expect(ctx.settings.describe().find(d => d.ns === NS)?.value).toMatchObject({ displayName: 'Moved' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a namespace no entry answers to, and an entry with no live field', async () => {
    const { ctx, persisted } = await mounted()
    try {
      await expect(ctx.settings.update('missing', {})).rejects.toThrow('No configurable plugin entry "missing"')
      expect(persisted).toStrictEqual([])
    } finally {
      await ctx.fiber.dispose()
    }

    const inert = await mounted({ runtime: Inert, patch: { fixed: 'fixed' } })
    try {
      await expect(inert.ctx.settings.update(NS, {})).rejects.toThrow('has no volatile fields')
      expect(inert.persisted).toStrictEqual([])
    } finally {
      await inert.ctx.fiber.dispose()
    }
  })

  it('refuses an edit to a field the schema does not mark volatile', async () => {
    // The one property that decides what a form may do, and the reason the
    // schema lives on the row: an ordinary field is committed by patching the
    // fiber's config, which remounts the row, so the service refuses to present
    // that as a live edit.
    const { ctx, persisted } = await mounted({ runtime: Mixed, patch: { fixed: 'fixed', live: 2 } })
    try {
      await expect(ctx.settings.update(NS, { fixed: 'changed' })).rejects.toThrow('Config field "fixed" is not volatile')
      await expect(ctx.settings.mutate(NS, [
        { op: 'set', path: ['fixed'], value: 'changed' },
      ])).rejects.toThrow('Config field "fixed" is not volatile')
      expect(persisted).toStrictEqual([])
      // The live neighbour is still writable, so the refusal is about the field
      // and not about the row.
      await ctx.settings.update(NS, { live: 5 })
      expect(ctx.settings.describe().find(d => d.ns === NS)?.value).toStrictEqual({ live: 5 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
