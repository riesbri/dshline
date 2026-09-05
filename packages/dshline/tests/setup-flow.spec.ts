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
import { runSetup, setupNeeded } from '../src/setup/index.ts'
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
  /** Whether the settings seam is mounted. */
  settings?: boolean
  /** The selection the window would open with. */
  selected?: { provider: string; model: string }
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
  const configurable = environment.configurable ?? []
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      revision: 3,
      value: {},
      user: {},
      schema: {
        uid: 1,
        refs: {
          1: { type: 'object', meta: {}, dict: { providers: 2 } },
          2: { type: 'dict', meta: {}, inner: 3 },
          3: { type: 'object', meta: {}, dict: { apiKeyEnv: 4 } },
          4: { type: 'string', meta: { role: 'credential-ref' } },
        },
      },
    }],
    mutate: async (...args: unknown[]) => { mutations.push(args) },
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
      })),
      listModels: async (provider: string) => environment.models?.[provider] ?? [],
      discoverModels: async () => [],
      resolveModelInfo: async () => ({}),
    },
    get: (name: string) => {
      if (name === 'settings') return environment.settings === false ? undefined : settings
      // No credentials, no authorization, no home-path service: this
      // environment is deliberately thinner than a real profile, which is
      // exactly what a degrading report has to cope with.
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
  function opens(environment: Environment): boolean {
    const h = harness(environment)
    return setupNeeded(h.ctx, h.selection)
  }

  it('opens when no provider route is registered', () => {
    expect(opens({})).toBe(true)
  })

  it('opens when a route is registered but no model is selected', () => {
    // The case a route count alone gets wrong: `/model` has something to offer,
    // and the composer would still open with nothing selected to send to.
    expect(opens({ registered: ['openai'] })).toBe(true)
  })

  it('opens when the selected model names a route nothing registered', () => {
    // A remembered default whose provider left the profile. Established from
    // the registry and the selection alone — no adapter is asked anything.
    expect(opens({ registered: ['openai'], selected: { provider: 'gone', model: 'old' } })).toBe(true)
  })

  it('stays out of the way when a registered route is selected', () => {
    expect(opens({ registered: ['openai'], selected: { provider: 'openai', model: 'gpt-x' } })).toBe(false)
  })

  it('judges the selection by its provider, not by the model id', () => {
    // Whether the route still serves that exact model is a `listModels`
    // question, and asking it would put a possible network call in front of
    // every launch. The picker answers it when the reader opens it.
    expect(opens({ registered: ['openai'], selected: { provider: 'openai', model: 'retired-model' } })).toBe(false)
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
    const h = harness({ settings: false })
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
