/**
 * The guided first run, driven the way a person drives it.
 *
 * `runSetup` is a conductor over surfaces that already have their own tests,
 * so what is asserted here is only what the conductor itself decides: whether
 * it opens at all, what it commits, which step it offers next, and — the one
 * that matters most — that backing out at any point leaves Harness untouched.
 *
 * The seams are recorders. A test that ends with `mutations` empty is the
 * whole point of several of these.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { Key } from '@dshline/renderer'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { gatherSetupFacts, runSetup, setupNeeded } from '../src/setup/index.ts'
import type { TuiOverlay } from '../src/slots.ts'

/**
 * Let pending microtasks run, so a settled prompt's continuation has pushed
 * its next overlay before the test presses into it.
 * @returns when the queue has drained.
 */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

const ENTER: Key = { kind: 'key', name: 'enter' }
const DOWN: Key = { kind: 'key', name: 'down' }
const ESCAPE: Key = { kind: 'key', name: 'escape' }

/** What a test wants this environment to be. */
interface Environment {
  /** Route keys an adapter has registered. */
  registered?: string[]
  /** Models each registered route advertises. */
  models?: Record<string, { id: string; name: string }[]>
  /** Route keys the configurable directory publishes. */
  configurable?: string[]
  /** Alpha-2 deferred catalog diagnostics, keyed by route. */
  diagnostics?: Record<string, string>
  /** Whether the settings seam is mounted. */
  settings?: boolean
  /** The selection the window would open with. */
  selected?: { provider: string; model: string }
  /**
   * Credential reference each route's stored profile names, keyed by route.
   * A route absent here names none — the posture an OAuth-authorized or
   * provider-native route is in, which must never read as broken.
   */
  refs?: Record<string, string>
  /** References the credential seam reports as present. */
  configured?: string[]
  /** References the credential seam cannot answer for at all. */
  unreadable?: string[]
  /** Whether a credential seam is mounted. */
  credentials?: boolean
}

/** A harness under test, and everything it was asked to do. */
interface Harness {
  readonly ctx: Context
  readonly committed: string[]
  readonly mutations: unknown[]
  readonly press: (...keys: Key[]) => Promise<void>
  readonly text: () => string
  readonly render: (columns: number, rows: number) => string[]
  readonly mounted: () => boolean
  /** Register a route mid-flow, as configuring one through `/connect` would. */
  readonly registerRoute: (provider: string) => void
  /** Routes any code asked for a model catalog, in call order. */
  readonly listedModels: string[]
  /** How many times model discovery was attempted. */
  readonly discovered: number
  /** How many times the settings document was described. */
  readonly described: number
  /** Every credential reference asked about, in call order. */
  readonly credentialReads: string[]
  readonly selection: ModelSelectionRef
}

/**
 * Build a context whose seams answer what a test asked for.
 * @param environment - the answers.
 * @returns the harness.
 */
function harness(environment: Environment): Harness {
  const stack: TuiOverlay[] = []
  const committed: string[] = []
  const mutations: unknown[] = []
  const registered = [...environment.registered ?? []]
  const listedModels: string[] = []
  let discovered = 0
  let described = 0
  const credentialReads: string[] = []
  const configurable = environment.configurable ?? []
  // The route profiles a settings section would resolve to. A route with no
  // entry in `refs` stores no reference at all, which is what the reading has
  // to treat as "nothing established" rather than "missing".
  const profiles = Object.fromEntries(configurable.map(provider => [
    provider,
    environment.refs?.[provider] === undefined ? {} : { apiKeyEnv: environment.refs[provider] },
  ]))
  const settings = {
    describe: () => {
      described += 1
      return describeSections()
    },
    mutate: async (...args: unknown[]) => { mutations.push(args) },
  }
  const describeSections = () => [{
      ns: 'llm-pi-ai',
      revision: 3,
      value: { providers: profiles },
      user: {},
      // The credential reference is found through the schema ROLE, never a
      // field name — the contract `/connect` reads and this shares.
      schema: {
        uid: 1,
        refs: {
          1: { type: 'object', meta: {}, dict: { providers: 2 } },
          2: { type: 'dict', meta: {}, inner: 3 },
          3: { type: 'object', meta: {}, dict: { apiKeyEnv: 4 } },
          4: { type: 'string', meta: { role: 'credential-ref' } },
        },
      },
    }]
  const credentials = {
    describe: async (ref: string) => {
      credentialReads.push(ref)
      if (environment.unreadable?.includes(ref) === true) throw new Error('the store is offline')
      return { configured: environment.configured?.includes(ref) === true, writable: true }
    },
    set: async () => {},
    unset: async () => {},
    describeRecord: async () => ({ configured: false, writable: true }),
    deleteRecord: async () => {},
  }
  const ctx = {
    llm: {
      listProviders: () => registered.map(id => ({ id, name: id })),
      listConfigurableProviders: () => configurable.map(provider => ({
        provider,
        displayName: provider,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', provider],
        declared: false,
        ...environment.diagnostics?.[provider] === undefined
          ? {}
          : { error: environment.diagnostics[provider] },
      })),
      listModels: async (provider: string) => {
        listedModels.push(provider)
        return environment.models?.[provider] ?? []
      },
      discoverModels: async () => {
        discovered += 1
        return []
      },
      resolveModelInfo: async () => ({}),
    },
    get: (name: string) => {
      if (name === 'settings') return environment.settings === false ? undefined : settings
      if (name === 'credentials') return environment.credentials === false ? undefined : credentials
      // No authorization and no home-path service: this environment is
      // deliberately thinner than a real profile, which is exactly what a
      // degrading report has to cope with.
      return undefined
    },
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay) => {
        stack.push(overlay)
        return (): void => {
          const index = stack.indexOf(overlay)
          if (index >= 0) stack.splice(index, 1)
        }
      },
      invalidate: (): void => {},
    },
    on: () => (): void => {},
  } as unknown as Context
  return {
    ctx,
    committed,
    mutations,
    selection: { current: environment.selected, assembled: undefined },
    press: async (...keys) => {
      for (const key of keys) stack.at(-1)?.handleKey(key)
      await settle()
    },
    text: () => stripAnsi((stack.at(-1)?.render(90, 24) ?? []).join('\n')),
    render: (columns, rows) => (stack.at(-1)?.render(columns, rows) ?? []).map(line => stripAnsi(line)),
    mounted: () => stack.length > 0,
    registerRoute: provider => { registered.push(provider) },
    listedModels,
    get discovered() { return discovered },
    get described() { return described },
    credentialReads,
  }
}

/**
 * Run the flow with a harness's seams.
 * @param h - the harness.
 * @returns the promise the flow settles.
 */
function run(h: Harness): Promise<void> {
  return runSetup({
    ctx: h.ctx,
    commit: lines => { h.committed.push(...lines.map(stripAnsi)) },
    version: '0.17.0',
    selection: h.selection,
    onModelChanged: () => {},
  })
}

describe('whether the guided flow opens at all', () => {
  /**
   * Ask the real trigger the way the window asks it.
   * @param environment - the registry and selection to present.
   * @returns whether setup would open.
   */
  async function opens(environment: Environment): Promise<boolean> {
    const h = harness(environment)
    return setupNeeded(h.ctx, h.selection)
  }

  /** A registered, selected, configurable route — topology complete. */
  const SETTLED: Environment = {
    registered: ['openai'],
    configurable: ['openai'],
    selected: { provider: 'openai', model: 'gpt-x' },
  }

  it('opens when no provider route is registered', async () => {
    expect(await opens({})).toBe(true)
  })

  it('opens when a route is registered but no model is selected', async () => {
    // The case a route count alone gets wrong: `/model` has something to offer,
    // and the composer would still open with nothing selected to send to.
    expect(await opens({ registered: ['openai'] })).toBe(true)
  })

  it('opens when the selected model names a route nothing registered', async () => {
    // A remembered default whose provider left the profile. Established from
    // the registry and the selection alone — no adapter is asked anything.
    expect(await opens({ registered: ['openai'], selected: { provider: 'gone', model: 'old' } })).toBe(true)
  })

  it('judges the selection by its provider, not by the model id', async () => {
    // Exact model validity belongs to the Harness adapter that executes the
    // request, not to this startup topology check.
    expect(await opens({ ...SETTLED, selected: { provider: 'openai', model: 'retired-model' } })).toBe(false)
  })

  it('opens when the selected route names a credential Harness says is absent', async () => {
    // The stock first install: the base composition ships a default selection
    // and its adapter registers that route before any key exists, so every
    // topology check passes while the first prompt would fail.
    expect(await opens({ ...SETTLED, refs: { openai: 'OPENAI_API_KEY' } })).toBe(true)
  })

  it('stays out of the way when that credential is present', async () => {
    expect(await opens({
      ...SETTLED,
      refs: { openai: 'OPENAI_API_KEY' },
      configured: ['OPENAI_API_KEY'],
    })).toBe(false)
  })

  it('keeps provider diagnostics separate from exact model validity', async () => {
    const h = harness({
      ...SETTLED,
      selected: { provider: 'openai', model: 'healthy' },
      refs: { openai: 'OPENAI_API_KEY' },
      configured: ['OPENAI_API_KEY'],
      diagnostics: { openai: 'broken override for another-model' },
      models: { openai: [{ id: 'usable', name: 'Usable' }] },
    })
    // The provider diagnostic remains available to Connect, but startup does
    // not turn its advisory catalog into exact-model validation.
    expect(await setupNeeded(h.ctx, h.selection)).toBe(false)
    expect(h.listedModels).toEqual([])
  })

  it('stays out of the way when the route names no credential reference', async () => {
    // An `llm-pi-ai` route activated by an account sign-in stores no
    // `apiKeyEnv` — that field carries no schema default — and a route
    // authenticating through provider-native discovery stores none either.
    // Neither is misconfigured, so neither may be called broken.
    expect(await opens(SETTLED)).toBe(false)
  })

  it('stays out of the way when the credential store cannot answer', async () => {
    // Unread is not unset. Turning a failed read into a fault would interrupt
    // a working launch over a store that was merely busy.
    expect(await opens({
      ...SETTLED,
      refs: { openai: 'OPENAI_API_KEY' },
      unreadable: ['OPENAI_API_KEY'],
    })).toBe(false)
  })

  it('stays out of the way when no credential seam is mounted at all', async () => {
    expect(await opens({ ...SETTLED, refs: { openai: 'OPENAI_API_KEY' }, credentials: false })).toBe(false)
  })

  it('stays out of the way when no settings seam can name a reference', async () => {
    expect(await opens({ ...SETTLED, refs: { openai: 'OPENAI_API_KEY' }, settings: false })).toBe(false)
  })

  it('asks no adapter for a catalog while deciding', async () => {
    // Startup readiness uses route and credential facts only: no catalog or
    // discovery query is made while deciding whether setup should open.
    const h = harness({ ...SETTLED, refs: { openai: 'OPENAI_API_KEY' } })
    await setupNeeded(h.ctx, h.selection)
    expect(h.listedModels).toEqual([])
    expect(h.discovered).toBe(0)
  })
})

describe('the report reads Harness once', () => {
  const SETTLED_MISSING: Environment = {
    registered: ['openai'],
    configurable: ['openai'],
    selected: { provider: 'openai', model: 'gpt-x' },
    refs: { openai: 'OPENAI_API_KEY' },
  }

  it('derives the selected route\'s readiness from the pass it already took', async () => {
    // One `describe()` and one look at that reference. A second read would be
    // a second SNAPSHOT, and the `Models` row and the reason beside it would
    // then describe two different moments.
    const h = harness(SETTLED_MISSING)
    const facts = await gatherSetupFacts(h.ctx, '0.17.0', h.selection.current)
    expect(h.described).toBe(1)
    expect(h.credentialReads).toEqual(['OPENAI_API_KEY'])
    // And it reached the same verdict the narrow startup read reaches.
    expect(facts.reason).toBe('credential-missing')
    expect(facts.credentialRef).toBe('OPENAI_API_KEY')
  })

  it('keeps the provider diagnostic in the full report without changing readiness', async () => {
    const h = harness({
      registered: ['openai'],
      configurable: ['openai'],
      selected: { provider: 'openai', model: 'healthy' },
      refs: { openai: 'OPENAI_API_KEY' },
      configured: ['OPENAI_API_KEY'],
      diagnostics: { openai: 'broken override for another-model' },
      models: { openai: [{ id: 'usable', name: 'Usable' }] },
    })
    const facts = await gatherSetupFacts(h.ctx, '0.17.0', h.selection.current)
    expect(facts.reason).toBeUndefined()
    if (facts.connect.kind !== 'ready') throw new Error('expected a ready Connect reading')
    expect(facts.connect.providers[0]?.error).toBe('broken override for another-model')
    expect(await setupNeeded(h.ctx, h.selection)).toBe(false)
  })

  it('agrees with the startup gate on the same environment', async () => {
    // Two paths to one answer: the gate reads one route, the report derives
    // from a whole pass, and they must never disagree.
    for (const environment of [
      SETTLED_MISSING,
      { ...SETTLED_MISSING, configured: ['OPENAI_API_KEY'] },
      { ...SETTLED_MISSING, refs: {} },
      { ...SETTLED_MISSING, unreadable: ['OPENAI_API_KEY'] },
      { registered: ['openai'], configurable: ['openai'] },
      {},
    ]) {
      const h = harness(environment)
      const facts = await gatherSetupFacts(h.ctx, '0.17.0', h.selection.current)
      expect(await setupNeeded(h.ctx, h.selection)).toBe(facts.reason !== undefined)
    }
  })
})

describe('the guided flow', () => {
  it('commits the report to scrollback before asking anything', async () => {
    const h = harness({ configurable: ['openai'] })
    const running = run(h)
    await settle()
    const report = h.committed.join('\n')
    // Finished rows, not a bounded overlay: these are the lines a person
    // scrolls back to and pastes into a bug report.
    expect(report).toContain('Setup')
    expect(report).toContain('dshline')
    expect(report).toContain('0.17.0')
    expect(report).toContain('no provider route is active')
    await h.press(ESCAPE)
    await running
  })

  it('shows a provider diagnostic and offers Connect repair without preflighting the model', async () => {
    const h = harness({
      registered: ['openai'],
      configurable: ['openai'],
      selected: { provider: 'openai', model: 'healthy' },
      refs: { openai: 'OPENAI_API_KEY' },
      configured: ['OPENAI_API_KEY'],
      diagnostics: { openai: 'broken override for another-model' },
      models: { openai: [{ id: 'usable', name: 'Usable' }] },
    })
    const running = run(h)
    await settle()
    expect(h.text()).toContain('Harness reports a configuration diagnostic')
    expect(h.text()).toContain('Review provider configuration')
    expect(h.committed.join('\\n')).toContain('broken override for another-model')
    await h.press(ESCAPE)
    await running
  })

  it('leaves on Not now, having written nothing', async () => {
    const h = harness({ configurable: ['openai'] })
    const running = run(h)
    await settle()
    expect(h.text()).toContain('Connect a provider')
    // Second row: `Not now`.
    await h.press(DOWN, ENTER)
    await running
    expect(h.mounted()).toBe(false)
    expect(h.mutations).toEqual([])
    expect(h.committed.join('\n')).toContain('no provider is configured yet')
  })

  it('leaves on a dismissal, having written nothing', async () => {
    const h = harness({ configurable: ['openai'] })
    const running = run(h)
    await settle()
    await h.press(ESCAPE)
    await running
    expect(h.mounted()).toBe(false)
    expect(h.mutations).toEqual([])
  })

  it('leads with the model step once a route is registered', async () => {
    const h = harness({
      registered: ['openai'],
      configurable: ['openai'],
      models: { openai: [{ id: 'gpt-x', name: 'GPT X' }] },
    })
    const running = run(h)
    await settle()
    // The missing piece goes first. `enter` on the opening selection is the
    // model picker, not another provider browser.
    await h.press(ENTER)
    await settle()
    expect(h.text()).toContain('openai/gpt-x')
    await h.press(ENTER)
    await running
    expect(h.selection.current).toEqual({ provider: 'openai', model: 'gpt-x' })
    const transcript = h.committed.join('\n')
    expect(transcript).toContain('model set to openai / gpt-x')
    expect(transcript).toContain('Ready.')
    expect(h.mounted()).toBe(false)
  })

  it('returns to the report when the model picker is dismissed, and selects nothing', async () => {
    const h = harness({
      registered: ['openai'],
      configurable: ['openai'],
      models: { openai: [{ id: 'gpt-x', name: 'GPT X' }] },
    })
    const running = run(h)
    await settle()
    await h.press(ENTER)
    await settle()
    await h.press(ESCAPE)
    await settle()
    // Back at the report, not gone: declining the picker must not drop the
    // reader at a composer that still cannot send.
    expect(h.text()).toContain('Choose a model')
    expect(h.text()).toContain('Not now')
    expect(h.selection.current).toBeUndefined()
    // `Choose a model`, `Connect another provider`, `Not now`.
    await h.press(DOWN, DOWN, ENTER)
    await running
    expect(h.mutations).toEqual([])
  })

  it('opens the model picker itself once connecting produced the missing route', async () => {
    // The handoff: the conductor re-reads after `/connect` closes, and when a
    // route appeared while the selection is still absent it opens the picker
    // rather than returning to a checklist that would only say to open it.
    const h = harness({ configurable: ['openai'], models: { openai: [{ id: 'gpt-x', name: 'GPT X' }] } })
    const running = run(h)
    await settle()
    // `Connect a provider` is the only step besides `Not now` while nothing is
    // registered, so it opens first.
    await h.press(ENTER)
    await settle()
    // Stand in for what configuring achieved: a registered route.
    h.registerRoute('openai')
    // Close `/connect`; the conductor takes it from there.
    await h.press(ESCAPE)
    await settle()
    expect(h.text()).toContain('Select a model')
    await h.press(ENTER)
    await running
    expect(h.selection.current).toEqual({ provider: 'openai', model: 'gpt-x' })
    expect(h.committed.join('\n')).toContain('Ready.')
  })

  it('does not reopen the picker when a usable model is already selected', async () => {
    // Connecting a second provider is not a request to change models, so a
    // working selection is left exactly as it was.
    const h = harness({
      registered: ['openai'],
      configurable: ['openai'],
      models: { openai: [{ id: 'gpt-x', name: 'GPT X' }] },
      selected: { provider: 'openai', model: 'gpt-x' },
    })
    const running = run(h)
    await settle()
    // `Choose a model`, `Connect another provider`, `Start the session`.
    await h.press(DOWN, ENTER)
    await settle()
    await h.press(ESCAPE)
    await settle()
    // Back at the checklist, with the selection untouched and no picker raised.
    expect(h.text()).toContain('Start the session')
    expect(h.selection.current).toEqual({ provider: 'openai', model: 'gpt-x' })
    await h.press(DOWN, DOWN, ENTER)
    await running
    expect(h.selection.current).toEqual({ provider: 'openai', model: 'gpt-x' })
    expect(h.mutations).toEqual([])
  })

  it('offers no configuration step, and still a way out, when no seam would accept one', async () => {
    // Neither seam: the harness mounts a credential store by default now, and
    // "no seam would accept one" has to mean exactly that.
    const h = harness({ settings: false, credentials: false })
    const running = run(h)
    await settle()
    expect(h.text()).not.toContain('Connect a provider')
    expect(h.text()).toContain('Not now')
    await h.press(ENTER)
    await running
    expect(h.mounted()).toBe(false)
    expect(h.mutations).toEqual([])
  })

  it('stays inside a narrow or short terminal, because its picker is a bounded overlay', async () => {
    const h = harness({ configurable: ['openai'] })
    const running = run(h)
    await settle()
    // Setup prints no list of its own; the step picker is `promptSelect`, which
    // is a viewport over its rows. If that ever stopped being true, an
    // unbounded live region would show up here as a row count past the screen
    // or a line wider than the terminal.
    for (const [columns, rows] of [[20, 6], [40, 10], [80, 24], [200, 24]] as const) {
      const drawn = h.render(columns, rows)
      expect(drawn.length).toBeLessThanOrEqual(rows)
      for (const line of drawn) expect(displayWidth(line)).toBeLessThanOrEqual(columns)
    }
    await h.press(ESCAPE)
    await running
  })
})
