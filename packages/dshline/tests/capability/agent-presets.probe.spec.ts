/**
 * Capability probe: `ctx.agentPresets`, against the real roster.
 *
 * dshline consumes this seam through the structural `AgentPresetsSeam` view in
 * `plugins/harness.ts`, deliberately WITHOUT importing the service's values —
 * a profile that mounts no roster must still start. That choice buys
 * degradation at the cost of a drift risk: nothing in the production build
 * compares the structural view with the real `@deepseek-ai/dsh-agent-presets`
 * class. This probe is where that comparison lives, in both directions:
 *
 * - the real `AgentPresets` service is mounted over a real temp root with a
 *   real composition file, and assigned to the structural view, so an
 *   upstream shape change fails this file at compile time;
 * - the roster reads `/plugins` browses with (`list`, `resolve`, `read`,
 *   `defaultId`, `authorable`) are driven through the real discovery over
 *   real directories;
 * - `copy()` authors a real locally authored preset, the one authoring write
 *   `/plugins` offers;
 * - the `agentPreset` Session projection the roster registers folds the
 *   creation-header case `sessionFacts()` reads through the real projection
 *   registry.
 *
 * `mount`/`recompose`/`select` need a full agent composition to evaluate, so
 * they are not exercised here; their shapes are held by the structural
 * assignment above, and their behavior is upstream's own test territory.
 * @module
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { sessionFacts } from '../../src/plugins/harness.ts'
import type { AgentPresetsSeam } from '../../src/plugins/harness.ts'

/** Temp roots this file creates; removed after the run. */
const homes: string[] = []

afterAll(async () => {
  await Promise.all(homes.map(async home => rm(home, { recursive: true, force: true })))
})

/** An empty agent-plane composition: valid YAML, registers nothing. */
const COMPOSITION = '[]\n'

/**
 * Lay out one preset under a root, the way a deployment ships or a user authors one.
 * @param root - the preset root directory.
 * @param id - the preset id; also its directory name.
 * @returns the root path.
 */
async function presetRoot(root: string, id: string): Promise<string> {
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, 'agent.cordis.yml'), COMPOSITION)
  await writeFile(join(root, id, 'preset.yml'), `name: ${id}\ndescription: probe preset ${id}\n`)
  return root
}

/**
 * Mount the real roster over a real temp root holding one preset.
 * @returns the context carrying the real service, and the root.
 */
async function mounted(): Promise<{ ctx: Context; root: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-probe-presets-'))
  homes.push(home)
  const root = await presetRoot(home, 'shipped')
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  // Injection precondition only: the roster declares `loader` alongside
  // `sessionProjections`. The roster's discovery and authoring reads touch no
  // loader surface — the stub exists so cordis applies the real plugin.
  ctx.provide('loader', {} as never)
  // The roster resolves a composition's package names against the base URL of
  // the composition it was loaded by; a bare test context supplies one itself.
  ctx.baseUrl = `${pathToFileURL(home).href}/`
  await ctx.plugin(AgentPresets, {
    default: 'shipped',
    roots: [{ path: root, trust: 'user' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  return { ctx, root }
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

  it('discovers a real root and reads one preset\'s composition verbatim', async () => {
    const { ctx, root } = await mounted()
    try {
      const rows = await ctx.agentPresets.list()
      expect(rows.map(row => [row.id, row.trust, row.name])).toEqual([['shipped', 'user', 'shipped']])
      expect(rows[0]?.broken).toBeUndefined()
      expect(rows[0]?.path).toBe(join(root, 'shipped', 'agent.cordis.yml'))
      const resolved = await ctx.agentPresets.resolve('shipped')
      expect(resolved.id).toBe('shipped')
      await expect(ctx.agentPresets.resolve('missing')).rejects.toThrow()
      // Verbatim composition text — what /plugins' row editor toggles within.
      await expect(ctx.agentPresets.read('shipped')).resolves.toBe(COMPOSITION)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('authors a locally authored copy into a writable root', async () => {
    const { ctx, root } = await mounted()
    try {
      expect(ctx.agentPresets.authorable).toBe(true)
      await ctx.agentPresets.copy('shipped', 'my-copy', 'My Copy')
      const rows = await ctx.agentPresets.list()
      expect(rows.find(row => row.id === 'my-copy')).toMatchObject({ trust: 'user', name: 'My Copy' })
      // The copy starts as the source's whole composition, which /plugins
      // then edits one row at a time in the copy's own file.
      await expect(ctx.agentPresets.read('my-copy')).resolves.toBe(COMPOSITION)
      await expect(readFile(join(root, 'my-copy', 'agent.cordis.yml'), 'utf8')).resolves.toBe(COMPOSITION)
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
