/** Joining the preset roster, the active session's actual preset, and one preset's composition. */

import { describe, expect, it, vi } from 'vitest'
import { PluginsCatalog } from '../src/plugins/catalog.ts'
import type { AgentPresetRow, AgentPresetsSeam, PluginsSeams } from '../src/plugins/harness.ts'
import type { PluginsSessionFacts } from '../src/plugins/harness.ts'
import type { PluginsState } from '../src/plugins/catalog.ts'

/**
 * A Host mounting no capability registry: `health.ts` then reports every row
 * as `'unknown'`, which is this suite's subject — the catalog's own join, not
 * provider health (see plugins-health.spec.ts for that).
 */
const NO_HOST = { subagentProviders: undefined }

const STANDARD_TEXT = `- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
`

/** What a test wants the seams to answer. */
interface Fixture {
  presets?: AgentPresetRow[]
  defaultId?: string
  composed?: string
  /** The rendered composition each preset's `readDocument` answers with. */
  compositions?: Record<string, string | Error>
  /** Called with every id `readDocument` is asked for, so a read can be counted. */
  onRead?: (agentPreset: string) => void
  withoutAgentPresets?: boolean
  withoutSettings?: boolean
  withoutConfigEditor?: boolean
}

/**
 * Build seams that answer exactly what a test asked for.
 *
 * The roster carries no `trust` and no `path` — the adopted registry publishes
 * neither, and a fake that re-added them would be modelling the previous
 * generation's fiction rather than the real service's shape.
 * @param fixture - the answers.
 * @returns the seams.
 */
function seamsFor(fixture: Fixture): PluginsSeams {
  const agentPresets: AgentPresetsSeam = {
    get defaultId() { return fixture.defaultId ?? 'standard' },
    list: async () => fixture.presets ?? [
      { id: 'standard', name: 'Standard mode' },
    ],
    resolve: async (id?: string) => {
      const found = (fixture.presets ?? []).find(preset => preset.id === id)
      if (found === undefined) throw new Error(`unknown preset ${String(id)}`)
      return found
    },
    composedPreset: () => fixture.composed,
    mount: async (_agentCtx, id) => ({ id: id ?? 'standard' }),
    recompose: async (_agentCtx, id) => ({ id }),
    select: async (_agent, id) => id,
    // View-only by construction: the registry renders the declared child list
    // back as entry-list YAML and accepts nothing in return, so this is the one
    // composition read `/plugins` gets.
    readDocument: async agentPreset => {
      fixture.onRead?.(agentPreset)
      const answer = fixture.compositions?.[agentPreset] ?? STANDARD_TEXT
      if (answer instanceof Error) throw answer
      return { agentPreset, content: answer }
    },
  }
  return {
    agentPresets: fixture.withoutAgentPresets === true ? undefined : agentPresets,
    settings: fixture.withoutSettings === true ? undefined : { update: async () => {} },
    configEditor: fixture.withoutConfigEditor === true
      ? undefined
      : { entries: () => [], edit: async () => {} },
  }
}

/**
 * Read one complete pass.
 * @param fixture - what the seams answer.
 * @param session - the active session's projected facts.
 * @returns the reading.
 */
async function read(
  fixture: Fixture,
  session: PluginsSessionFacts = { presetId: undefined, started: false },
): Promise<PluginsState> {
  const catalog = new PluginsCatalog({
    seams: seamsFor(fixture),
    agentCtx: {},
    session: () => session,
    host: () => NO_HOST,
    invalidate: () => {},
  })
  catalog.refresh()
  await vi.waitFor(() => { expect(catalog.state().kind).not.toBe('loading') })
  return catalog.state()
}

describe('PluginsCatalog: capability absence', () => {
  it('reports unavailable, not a crash, when no agentPresets seam is mounted', async () => {
    const state = await read({ withoutAgentPresets: true })
    expect(state.kind).toBe('unavailable')
  })
})

describe('PluginsCatalog: a ready read', () => {
  it('joins the roster, default, and browsed composition', async () => {
    const state = await read({ defaultId: 'standard' })
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.defaultId).toBe('standard')
    expect(state.presets.map(row => row.id)).toEqual(['standard'])
    expect(state.browsing.kind).toBe('rows')
    if (state.browsing.kind !== 'rows') return
    expect(state.browsing.presetId).toBe('standard')
    expect(state.browsing.tree.rows.map(row => row.id)).toEqual(['tool-bash', 'tool-fs'])
  })

  it('reports capabilities from what is actually mounted', async () => {
    const state = await read({ withoutSettings: true, withoutConfigEditor: true })
    if (state.kind !== 'ready') throw new Error('expected ready')
    // `canWriteUserPresets` is gone with the writable preset root it stood for:
    // what a profile can do now is mount the editor or not, and the default
    // preset is a field of a namespace rather than a file the roster owns.
    expect(state.capabilities).toEqual({ agentPresets: true, settings: false, configEditor: false })
  })

  it('reports the configuration editor as mounted where a read is mounted', async () => {
    const state = await read({})
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.capabilities).toEqual({ agentPresets: true, settings: true, configEditor: true })
  })

  it('reports blank true when the session has produced no turn', async () => {
    const state = await read({}, { presetId: undefined, started: false })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.blank).toBe(true)
  })

  it('reports blank false once the turnBoundary projection reports a turn', async () => {
    const state = await read({}, { presetId: undefined, started: true })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.blank).toBe(false)
  })

  it('prefers the agent-composed preset over the projection when both are present', async () => {
    const state = await read(
      { composed: 'from-composed', defaultId: 'standard' },
      { presetId: 'from-header', started: false },
    )
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.sessionPresetId).toBe('from-composed')
  })

  it('falls back to the projection, then the default, when nothing is composed yet', async () => {
    const state = await read({ defaultId: 'standard' }, { presetId: undefined, started: false })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.sessionPresetId).toBeUndefined()
    expect(state.browsing.kind).toBe('rows')
    if (state.browsing.kind !== 'rows') return
    expect(state.browsing.presetId).toBe('standard')
  })
})

describe('PluginsCatalog: a read composes nothing', () => {
  it('never calls mount, recompose, or select while gathering a pass', async () => {
    // The adopted seam is one object with three composition-owning methods
    // beside two read-only ones, and the adopted catalog holds none of them: a
    // pass that reached for one would re-parent the agent's scope while merely
    // drawing a list. Rigged to throw so the assertion is a failure by name
    // rather than a silent equivalent.
    const base = seamsFor({}).agentPresets
    if (base === undefined) throw new Error('expected a preset seam')
    const seams: PluginsSeams = {
      agentPresets: {
        ...base,
        mount: () => { throw new Error('a read must not mount') },
        recompose: () => { throw new Error('a read must not recompose') },
        select: () => { throw new Error('a read must not select') },
      },
      settings: { update: async () => {} },
      configEditor: { entries: () => [], edit: async () => {} },
    }
    const catalog = new PluginsCatalog({
      seams,
      agentCtx: {},
      session: () => ({ presetId: undefined, started: false }),
      host: () => NO_HOST,
      invalidate: () => {},
    })
    catalog.refresh()
    await vi.waitFor(() => { expect(catalog.state().kind).toBe('ready') })
  })
})

describe('PluginsCatalog: every declaration is listed, broken ones included', () => {
  it('lists the roster in order, without special-casing any of it', async () => {
    // The previous generation tagged each row as shipped or profile-authored
    // and had a word for each. Nothing in the adopted roster supports that
    // distinction, so what is left to protect is the opposite: nothing is
    // filtered, re-ranked, or re-labelled on the way to the screen.
    const state = await read({
      presets: [
        { id: 'standard', name: 'Standard mode' },
        { id: 'standard-custom', name: 'Standard (custom)' },
        { id: 'minimal' },
        { id: 'broken-one', broken: 'composition is not a list of entries' },
      ],
    })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.presets.map(row => [row.id, row.name, row.broken])).toEqual([
      ['standard', 'Standard mode', undefined],
      ['standard-custom', 'Standard (custom)', undefined],
      ['minimal', 'minimal', undefined],
      ['broken-one', 'broken-one', 'composition is not a list of entries'],
    ])
  })
})

describe('PluginsCatalog: the roster\'s own broken is authoritative over dshline\'s own parse', () => {
  it('reports broken using the Harness-provided reason even when the raw file parses cleanly here', async () => {
    const state = await read({
      presets: [
        { id: 'standard', name: 'Standard mode', broken: 'a service row escaped its isolate realm' },
      ],
      // A perfectly well-formed composition, as far as this parser is concerned.
      compositions: { standard: STANDARD_TEXT },
    })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.browsing).toEqual({
      kind: 'broken',
      presetId: 'standard',
      reason: 'a service row escaped its isolate realm',
    })
  })

  it('never calls readDocument() at all once the roster already reports broken', async () => {
    const reads: string[] = []
    const state = await read({
      presets: [
        { id: 'standard', name: 'Standard mode', broken: 'unmountable' },
      ],
      onRead: id => { reads.push(id) },
    })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.browsing.kind).toBe('broken')
    expect(reads).toEqual([])
  })

  it('reads exactly the browsed preset, and no other', async () => {
    const reads: string[] = []
    const state = await read({
      presets: [
        { id: 'standard', name: 'Standard mode' },
        { id: 'minimal' },
      ],
      onRead: id => { reads.push(id) },
      composed: 'minimal',
    })
    if (state.kind !== 'ready') throw new Error('expected ready')
    // One composition is read per pass, and it is the one on screen — the
    // registry renders a declaration only when it is asked for.
    expect(reads).toEqual(['minimal'])
    expect(state.browsing.presetId).toBe('minimal')
  })
})

describe('PluginsCatalog: broken composition never crashes the pass', () => {
  it('reports the browsed preset as broken when its file will not parse', async () => {
    const state = await read({ compositions: { standard: 'not: a\nlist\n' } })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.browsing).toEqual({ kind: 'broken', presetId: 'standard', reason: expect.any(String) })
  })

  it('reports the browsed preset as broken when reading it throws', async () => {
    const state = await read({ compositions: { standard: new Error('ENOENT') } })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.browsing).toEqual({ kind: 'broken', presetId: 'standard', reason: 'ENOENT' })
  })

  it('still lists the roster even when the browsed composition is broken', async () => {
    const state = await read({ compositions: { standard: new Error('ENOENT') } })
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.presets).toHaveLength(1)
  })
})

describe('PluginsCatalog.browse: switching what is read without touching the session', () => {
  it('reads a different preset after browse(), leaving sessionPresetId untouched', async () => {
    const catalog = new PluginsCatalog({
      seams: seamsFor({
        presets: [
          { id: 'standard', name: 'Standard mode' },
          { id: 'standard-custom' },
        ],
        compositions: { standard: STANDARD_TEXT, 'standard-custom': '- id: tool-fs\n  name: fs\n' },
        composed: 'standard',
      }),
      agentCtx: {},
      session: () => ({ presetId: undefined, started: false }),
      host: () => NO_HOST,
      invalidate: () => {},
    })
    catalog.refresh()
    await vi.waitFor(() => { expect(catalog.state().kind).toBe('ready') })
    catalog.browse('standard-custom')
    await vi.waitFor(() => {
      const state = catalog.state()
      if (state.kind !== 'ready') throw new Error('not ready')
      expect(state.browsing.presetId).toBe('standard-custom')
    })
    const state = catalog.state()
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.sessionPresetId).toBe('standard')
  })
})

describe('PluginsCatalog: generation-stamped refresh', () => {
  it('drops a stale pass that settles after a newer one was already started', async () => {
    let resolveFirst: (() => void) | undefined
    const gate = new Promise<void>(resolve => { resolveFirst = resolve })
    let calls = 0
    const invalidations: number[] = []
    const base = seamsFor({}).agentPresets
    if (base === undefined) throw new Error('expected a preset seam')
    const seams: PluginsSeams = {
      agentPresets: {
        ...base,
        list: async () => {
          calls += 1
          if (calls === 1) await gate
          return [{ id: 'standard', name: 'Standard' }]
        },
      },
      settings: { update: async () => {} },
      configEditor: { entries: () => [], edit: async () => {} },
    }
    const catalog = new PluginsCatalog({
      seams,
      agentCtx: {},
      session: () => ({ presetId: undefined, started: false }),
      host: () => NO_HOST,
      invalidate: () => { invalidations.push(invalidations.length) },
    })
    catalog.refresh() // pass 1: blocked on `gate`
    catalog.refresh() // pass 2: resolves immediately, since calls > 1 skips the gate
    await vi.waitFor(() => { expect(catalog.state().kind).toBe('ready') })
    const settledAfterPass2 = invalidations.length
    resolveFirst?.()
    // Give the unblocked first pass a turn to (wrongly, if this fails) settle.
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(invalidations.length).toBe(settledAfterPass2)
  })

  it('drops results from passes that started before dispose()', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const base = seamsFor({}).agentPresets
    if (base === undefined) throw new Error('expected a preset seam')
    const seams: PluginsSeams = {
      agentPresets: { ...base, list: async () => { await gate; return [] } },
      settings: { update: async () => {} },
      configEditor: { entries: () => [], edit: async () => {} },
    }
    const catalog = new PluginsCatalog({
      seams,
      agentCtx: {},
      session: () => ({ presetId: undefined, started: false }),
      host: () => NO_HOST,
      invalidate: () => {},
    })
    catalog.refresh()
    catalog.dispose()
    release?.()
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(catalog.state().kind).toBe('loading')
  })
})
