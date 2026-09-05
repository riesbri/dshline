/** Joining the four Harness surfaces that describe provider configuration. */

import { describe, expect, it, vi } from 'vitest'
import type { LlmConfigurableProvider, LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { ConnectCatalog, watchAdapters } from '../src/connect/catalog.ts'
import type {
  AuthorizationEntryRead,
  ConnectSeams,
  SettingsDescriptorRead,
} from '../src/connect/harness.ts'
import type { ConnectProviderRow, ConnectState } from '../src/connect/model.ts'

/** The `llm-pi-ai` schema shape: a dict of profiles under `providers`. */
const PI_AI_SCHEMA = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3 },
    3: { type: 'object', meta: {}, dict: { apiKeyEnv: 4 } },
    4: { type: 'string', meta: { role: 'credential-ref' } },
  },
}

/** What a test wants the seams to answer. */
interface Fixture {
  directory?: LlmConfigurableProvider[]
  registered?: LlmProviderInfo[]
  models?: Record<string, LlmModelInfo[] | Error>
  descriptors?: SettingsDescriptorRead[]
  refs?: Record<string, { configured: boolean; source?: string; writable: boolean } | Error>
  records?: Record<string, { configured: boolean; kind?: string; writable: boolean }>
  flows?: AuthorizationEntryRead[]
  withoutSettings?: boolean
  withoutCredentials?: boolean
  withoutAuthorization?: boolean
}

/**
 * Build seams that answer exactly what a test asked for.
 * @param fixture - the answers.
 * @returns the seams.
 */
function seamsFor(fixture: Fixture): ConnectSeams {
  const settings = {
    describe: () => fixture.descriptors ?? [],
    mutate: async () => {},
  }
  const credentials = {
    describe: async (ref: string) => {
      const answer = fixture.refs?.[ref]
      if (answer instanceof Error) throw answer
      return answer ?? { configured: false, writable: true }
    },
    set: async () => {},
    unset: async () => {},
    describeRecord: async (key: string) => fixture.records?.[key] ?? { configured: false, writable: true },
    deleteRecord: async () => {},
  }
  const authorization = {
    list: () => fixture.flows ?? [],
    begin: async () => ({ status: 'cancelled' as const }),
    cancel: () => {},
  }
  return {
    llm: {
      listProviders: () => fixture.registered ?? [],
      listConfigurableProviders: () => fixture.directory ?? [],
      listModels: async (provider: string) => {
        const answer = fixture.models?.[provider]
        if (answer instanceof Error) throw answer
        return answer ?? []
      },
      discoverModels: async () => [],
    },
    settings: fixture.withoutSettings === true ? undefined : settings,
    credentials: fixture.withoutCredentials === true ? undefined : credentials,
    authorization: fixture.withoutAuthorization === true ? undefined : authorization,
  }
}

/**
 * Read one complete pass.
 * @param fixture - what the seams answer.
 * @returns the reading.
 */
async function read(fixture: Fixture): Promise<ConnectState> {
  const catalog = new ConnectCatalog({ seams: seamsFor(fixture), invalidate: () => {} })
  catalog.refresh()
  // One microtask drain is enough: every read here is an already-resolved promise.
  await vi.waitFor(() => { expect(catalog.state().kind).not.toBe('loading') })
  return catalog.state()
}

/**
 * The one provider row of a reading.
 * @param state - the reading.
 * @returns the row.
 */
function only(state: ConnectState): ConnectProviderRow {
  if (state.kind !== 'ready') throw new Error(`expected a ready reading, got ${state.kind}`)
  const [row] = state.providers
  if (row === undefined) throw new Error('expected one provider row')
  return row
}

/** A directory entry for a pi-ai catalog route. */
const OPENAI: LlmConfigurableProvider = {
  provider: 'openai',
  displayName: 'OpenAI',
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'openai'],
  declared: false,
}

describe('reading the configurable-provider directory', () => {
  it('lists a dormant route the adapter declares before any profile exists', async () => {
    // This is what makes `/connect` possible: a bare-mounted adapter publishes
    // its whole installed catalog, so a provider can be offered before it is
    // configured and before `/model` has ever heard of it.
    const row = only(await read({ directory: [OPENAI] }))
    expect(row.state).toBe('dormant')
    expect(row.models).toBeUndefined()
    expect(row.userOwned).toBe(false)
  })

  it('calls a route active once an adapter has registered it', async () => {
    const state = await read({
      directory: [OPENAI],
      registered: [{ id: 'openai', name: 'OpenAI' }],
      models: { openai: [{ provider: 'openai', id: 'gpt', name: 'GPT' }] },
    })
    const row = only(state)
    expect(row.state).toBe('active')
    expect(row.models).toBe(1)
  })

  it('separates a configured route from a registered one', async () => {
    // A profile the adapter refused leaves the route configured but not live,
    // and calling that "dormant" would hide the very state a reader is debugging.
    const row = only(await read({
      directory: [OPENAI],
      descriptors: [{
        ns: 'llm-pi-ai',
        schema: PI_AI_SCHEMA,
        value: { providers: { openai: {} } },
        revision: 3,
      }],
    }))
    expect(row.state).toBe('configured')
  })

  it('says nothing about the catalog of a route it could not list', async () => {
    const row = only(await read({
      directory: [OPENAI],
      registered: [{ id: 'openai', name: 'OpenAI' }],
      models: { openai: new Error('unreachable') },
    }))
    expect(row.state).toBe('active')
    expect(row.models).toBeUndefined()
  })
})

describe('joining a route with its settings section', () => {
  it('finds the credential field by role and the reference by value', async () => {
    const row = only(await read({
      directory: [OPENAI],
      descriptors: [{
        ns: 'llm-pi-ai',
        schema: PI_AI_SCHEMA,
        value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
        revision: 7,
      }],
      refs: { OPENAI_API_KEY: { configured: true, source: 'file', writable: true } },
    }))
    expect(row.credential.field).toBe('apiKeyEnv')
    expect(row.credential.ref).toBe('OPENAI_API_KEY')
    expect(row.credential.info).toEqual({ configured: true, source: 'file', writable: true })
    expect(row.revision).toBe(7)
  })

  it('knows the field without a reference, which is what makes a first key writable', async () => {
    const row = only(await read({
      directory: [OPENAI],
      descriptors: [{ ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 1 }],
    }))
    expect(row.credential.field).toBe('apiKeyEnv')
    expect(row.credential.ref).toBeUndefined()
    expect(row.credential.info).toBeUndefined()
  })

  it('marks a profile the user layer carries, so removing it restores the base', async () => {
    const row = only(await read({
      directory: [OPENAI],
      descriptors: [{
        ns: 'llm-pi-ai',
        schema: PI_AI_SCHEMA,
        value: { providers: { openai: {} } },
        base: { providers: { openai: {} } },
        user: { providers: { openai: {} } },
        revision: 2,
      }],
    }))
    expect(row.userOwned).toBe(true)
  })

  it('does not mark a profile that only the composition base carries', async () => {
    const row = only(await read({
      directory: [OPENAI],
      descriptors: [{
        ns: 'llm-pi-ai',
        schema: PI_AI_SCHEMA,
        value: { providers: { openai: {} } },
        base: { providers: { openai: {} } },
        revision: 2,
      }],
    }))
    expect(row.userOwned).toBe(false)
  })

  it('reads a reference as unknown when the store could not answer', async () => {
    // Unknown, never missing: a red mark on a working provider is worse than no
    // mark at all.
    const row = only(await read({
      directory: [OPENAI],
      descriptors: [{
        ns: 'llm-pi-ai',
        schema: PI_AI_SCHEMA,
        value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
        revision: 1,
      }],
      refs: { OPENAI_API_KEY: new Error('store offline') },
    }))
    expect(row.credential.ref).toBe('OPENAI_API_KEY')
    expect(row.credential.info).toBeUndefined()
  })
})

describe('reading sign-ins', () => {
  it('lists each flow with the record it writes', async () => {
    const state = await read({
      flows: [{
        key: 'llm-pi-ai/openai',
        label: 'ChatGPT (Codex)',
        methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
        inFlight: false,
      }],
      records: { 'llm-pi-ai/openai': { configured: true, kind: 'grant', writable: true } },
    })
    if (state.kind !== 'ready') throw new Error('expected a ready reading')
    expect(state.signIns).toHaveLength(1)
    expect(state.signIns[0]?.record?.configured).toBe(true)
  })

  it('keeps a sign-in a separate ROW from the route it authenticates', async () => {
    // The two are still listed apart, each under the identity Harness gave it.
    // What the link adds is a stated relation between them, not a merge.
    const state = await read({
      directory: [OPENAI],
      flows: [{ key: 'llm-pi-ai/openai', label: 'OpenAI', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false }],
    })
    if (state.kind !== 'ready') throw new Error('expected a ready reading')
    expect(state.providers).toHaveLength(1)
    expect(state.signIns).toHaveLength(1)
    expect(state.signIns[0]?.route).toEqual({ provider: 'openai', state: 'dormant' })
  })

  it('links a sign-in to its route at the state the SAME pass read', async () => {
    const state = await read({
      directory: [OPENAI],
      registered: [{ id: 'openai', name: 'OpenAI' }],
      descriptors: [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { openai: {} } }, user: {}, schema: PI_AI_SCHEMA }],
      flows: [{ key: 'llm-pi-ai/openai', label: 'OpenAI', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false }],
    })
    if (state.kind !== 'ready') throw new Error('expected a ready reading')
    // A route state read at a different moment from the rows beside it is how
    // a row comes to contradict the list it sits in.
    expect(state.signIns[0]?.route).toEqual({ provider: 'openai', state: 'active' })
  })

  it('links nothing for a record no published route corresponds to', async () => {
    const state = await read({
      directory: [OPENAI],
      flows: [
        // Another plugin's scope: Harness publishes no correspondence for it,
        // so none is claimed — the refusal `connect/model.ts` makes in general.
        { key: 'some-plugin/thing', label: 'Something', methods: [], inFlight: false },
        // This adapter's scope, but a route the directory does not publish.
        { key: 'llm-pi-ai/absent', label: 'Absent', methods: [], inFlight: false },
      ],
    })
    if (state.kind !== 'ready') throw new Error('expected a ready reading')
    expect(state.signIns.map(row => row.route)).toEqual([undefined, undefined])
  })

  it('re-reads on demand and hands the reading back to the caller', async () => {
    // What the post-sign-in activation offer is judged from: a pass whose
    // result the caller receives rather than only paints.
    // `seamsFor` closes over the fixture, so changing it between passes is how
    // a test moves the world underneath a browser.
    const fixture: Fixture = { directory: [OPENAI], registered: [] }
    const catalog = new ConnectCatalog({ seams: seamsFor(fixture), invalidate: () => {} })
    const before = await catalog.reread()
    expect(before.kind === 'ready' && before.providers[0]?.state).toBe('dormant')
    fixture.registered = [{ id: 'openai', name: 'OpenAI' }]
    const after = await catalog.reread()
    expect(after.kind === 'ready' && after.providers[0]?.state).toBe('active')
    catalog.dispose()
  })
})

describe('a deployment missing an optional seam', () => {
  it('still reads, and says which seams answered', async () => {
    const state = await read({
      directory: [OPENAI],
      withoutSettings: true,
      withoutCredentials: true,
      withoutAuthorization: true,
    })
    if (state.kind !== 'ready') throw new Error('expected a ready reading')
    expect(state.capabilities).toEqual({ settings: false, credentials: false, authorization: false })
    expect(state.signIns).toEqual([])
    expect(state.providers[0]?.credential).toEqual({ field: undefined, ref: undefined, info: undefined })
  })

  it('reports a failed read rather than an empty one', async () => {
    const seams = seamsFor({})
    const broken: ConnectSeams = {
      ...seams,
      llm: {
        ...seams.llm,
        listConfigurableProviders: () => { throw new Error('registry is down') },
      },
    }
    const catalog = new ConnectCatalog({ seams: broken, invalidate: () => {} })
    catalog.refresh()
    await vi.waitFor(() => { expect(catalog.state().kind).toBe('failed') })
    expect(catalog.state()).toEqual({ kind: 'failed', message: 'registry is down' })
  })
})

describe('overlapping passes', () => {
  it('drops a stale pass instead of letting it repaint a newer reading', async () => {
    let release: (() => void) | undefined
    let call = 0
    let repaints = 0
    const seams = seamsFor({ directory: [OPENAI], registered: [{ id: 'openai', name: 'OpenAI' }] })
    seams.llm.listModels = async provider => {
      call += 1
      // Only the FIRST pass is held open, so the second one lands first and the
      // first becomes the stale result that must never reach the live region.
      if (call === 1) await new Promise<void>(resolve => { release = resolve })
      return [{ provider, id: `model-${String(call)}`, name: 'M' }]
    }
    const catalog = new ConnectCatalog({ seams, invalidate: () => { repaints += 1 } })
    catalog.refresh()
    catalog.refresh()
    await vi.waitFor(() => { expect(repaints).toBe(1) })
    const settled = catalog.state()
    release?.()
    // Long enough for the held pass to finish and try to settle.
    await new Promise<void>(resolve => { setTimeout(resolve, 10) })
    expect(repaints).toBe(1)
    expect(catalog.state()).toBe(settled)
  })

  it('abandons in-flight passes when the browser closes', async () => {
    const invalidate = vi.fn()
    const catalog = new ConnectCatalog({ seams: seamsFor({ directory: [OPENAI] }), invalidate })
    catalog.refresh()
    catalog.dispose()
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
    expect(invalidate).not.toHaveBeenCalled()
    expect(catalog.state().kind).toBe('loading')
  })
})

/** A minimal cordis-shaped context: only `.on`, which is all `watchAdapters` calls. */
function eventBus(): { ctx: Context; emit: (event: string) => void } {
  const handlers = new Map<string, Set<() => void>>()
  const ctx = {
    on: (event: string, handler: () => void) => {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return (): void => { handlers.get(event)?.delete(handler) }
    },
  } as unknown as Context
  return {
    ctx,
    emit: event => { for (const handler of handlers.get(event) ?? []) handler() },
  }
}

describe('watching for changes made from elsewhere', () => {
  const EVENTS = [
    'llm/adapters-updated',
    'settings/updated',
    'settings/document-updated',
    'credentials/reference-updated',
    'credentials/record-updated',
  ] as const

  it.each(EVENTS)('refreshes after %s', async event => {
    const catalog = new ConnectCatalog({ seams: seamsFor({ directory: [OPENAI] }), invalidate: () => {} })
    catalog.refresh()
    await vi.waitFor(() => { expect(catalog.state().kind).not.toBe('loading') })
    const { ctx, emit } = eventBus()
    const unwatch = watchAdapters(ctx, catalog)
    const before = catalog.state()
    emit(event)
    await vi.waitFor(() => { expect(catalog.state()).not.toBe(before) })
    unwatch()
  })

  it('coalesces a burst of events into one pass', async () => {
    let reads = 0
    const seams = seamsFor({ directory: [OPENAI] })
    const counting = {
      ...seams,
      llm: {
        ...seams.llm,
        listConfigurableProviders: () => {
          reads += 1
          return seams.llm.listConfigurableProviders()
        },
      },
    }
    const catalog = new ConnectCatalog({ seams: counting, invalidate: () => {} })
    catalog.refresh()
    await vi.waitFor(() => { expect(catalog.state().kind).not.toBe('loading') })
    const before = reads
    const { ctx, emit } = eventBus()
    const unwatch = watchAdapters(ctx, catalog)
    // A single write commonly fires more than one of these together.
    emit('settings/updated')
    emit('settings/document-updated')
    emit('credentials/reference-updated')
    await vi.waitFor(() => { expect(reads).toBeGreaterThan(before) })
    expect(reads).toBe(before + 1)
    unwatch()
  })

  it('disposes every subscription, so a closed browser never repaints again', async () => {
    const catalog = new ConnectCatalog({ seams: seamsFor({ directory: [OPENAI] }), invalidate: () => {} })
    catalog.refresh()
    await vi.waitFor(() => { expect(catalog.state().kind).not.toBe('loading') })
    const { ctx, emit } = eventBus()
    const unwatch = watchAdapters(ctx, catalog)
    unwatch()
    const before = catalog.state()
    for (const event of EVENTS) emit(event)
    await new Promise<void>(resolve => { setTimeout(resolve, 10) })
    expect(catalog.state()).toBe(before)
  })
})
