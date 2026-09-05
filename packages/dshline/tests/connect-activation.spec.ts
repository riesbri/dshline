/**
 * The step between a successful sign-in and a model: activating the route that
 * credential authenticates.
 *
 * The invariant every case here defends is the same one: **an authentication
 * is not consent to change provider configuration.** So the settings seam is a
 * recorder, and most of these tests assert that it recorded nothing.
 *
 * Pickers are driven by pressing keys into whatever overlay was pushed, the
 * way `connect-route-editor.spec.ts` drives its forms, rather than by stubbing
 * `promptSelect` — a stub would prove the branch was reached and not that a
 * person could reach it.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import { offerRouteActivation } from '../src/connect/activation.ts'
import type { ConnectSeams, SettingsPathOp } from '../src/connect/harness.ts'
import type {
  ConnectProviderRow,
  ConnectRouteState,
  ConnectSignInRow,
  ConnectState,
} from '../src/connect/model.ts'
import type { TuiOverlay } from '../src/slots.ts'

/**
 * Let every pending microtask run, so a settled prompt's continuation has
 * pushed its next overlay before the test presses into it.
 * @returns when the queue has drained.
 */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

const ENTER: Key = { kind: 'key', name: 'enter' }
const DOWN: Key = { kind: 'key', name: 'down' }
const ESCAPE: Key = { kind: 'key', name: 'escape' }

/** A context whose slot registry hands each pushed overlay to the test. */
function slots(): {
  ctx: Context
  press: (...keys: Key[]) => Promise<void>
  text: () => string
  mounted: () => boolean
} {
  const stack: TuiOverlay[] = []
  const ctx = {
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
  } as unknown as Context
  return {
    ctx,
    press: async (...keys) => {
      for (const key of keys) stack.at(-1)?.handleKey(key)
      await settle()
    },
    text: () => stripAnsi((stack.at(-1)?.render(90, 24) ?? []).join('\n')),
    mounted: () => stack.length > 0,
  }
}

/** Everything the seams were asked to write. */
interface Recorder {
  readonly seams: ConnectSeams
  readonly mutations: { ns: string; ops: readonly SettingsPathOp[]; revision: number | undefined }[]
}

/**
 * Seams that record every settings write and never fail unless told to.
 * @param failure - a rejection for `mutate`, when the test wants one.
 * @returns the seams and what they recorded.
 */
function recorder(failure?: Error): Recorder {
  const mutations: Recorder['mutations'] = []
  return {
    mutations,
    seams: {
      llm: {
        listProviders: () => [],
        listConfigurableProviders: () => [],
        listModels: async () => [],
        discoverModels: async () => [],
      },
      settings: {
        describe: () => [],
        mutate: async (ns, ops, revision) => {
          if (failure !== undefined) throw failure
          mutations.push({ ns, ops, revision })
        },
      },
      credentials: {
        describe: async () => ({ configured: true, writable: true }),
        set: async () => {},
        unset: async () => {},
        describeRecord: async () => ({ configured: true, writable: true }),
        deleteRecord: async () => {},
      },
      authorization: undefined,
    },
  }
}

/**
 * One `llm-pi-ai` provider route.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function route(overrides: Partial<ConnectProviderRow> = {}): ConnectProviderRow {
  return {
    kind: 'provider',
    provider: 'openai',
    displayName: 'OpenAI',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openai'],
    declared: false,
    state: 'dormant' as ConnectRouteState,
    models: undefined,
    credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
    userOwned: false,
    revision: 7,
    ...overrides,
  }
}

/**
 * One sign-in row.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function signIn(overrides: Partial<ConnectSignInRow> = {}): ConnectSignInRow {
  return {
    kind: 'sign-in',
    key: 'llm-pi-ai/openai',
    label: 'OpenAI',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    inFlight: false,
    record: { configured: true, writable: true },
    route: undefined,
    ...overrides,
  }
}

/**
 * A complete reading carrying one provider row.
 * @param providers - the rows the re-read reports.
 * @returns the state.
 */
function reading(providers: readonly ConnectProviderRow[]): ConnectState {
  return {
    kind: 'ready',
    providers,
    signIns: [],
    capabilities: { settings: true, credentials: true, authorization: true },
    newRouteTargets: [],
  }
}

/** The outcome `runAuthorization` hands over after a successful sign-in. */
const SIGNED_IN = { kind: 'done', message: 'OpenAI: signed in' } as const

describe('activating the route a sign-in authenticates', () => {
  it('offers activation for a dormant route, and writes only after the reader chooses it', async () => {
    const { ctx, press, text } = slots()
    const { seams, mutations } = recorder()
    const running = offerRouteActivation({
      ctx,
      seams,
      row: signIn(),
      outcome: SIGNED_IN,
      reread: async () => reading([route()]),
      signal: new AbortController().signal,
    })
    await settle()
    // The reader is told the distinction rather than left to discover it.
    expect(text()).toContain('authorized')
    expect(text()).toContain('not active')
    expect(text()).toContain('Activate the openai route')
    // Nothing has been written while the question is still on screen.
    expect(mutations).toEqual([])
    await press(ENTER)
    expect(await running).toEqual({
      kind: 'done',
      message: 'OpenAI: signed in · openai route activated · choose a model with /model',
    })
    // The empty profile at the route's own path, at the revision the re-read
    // reported — never a wholesale section write.
    expect(mutations).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'openai'], value: {} }],
      revision: 7,
    }])
  })

  it('writes nothing when the reader chooses Not now', async () => {
    const { ctx, press } = slots()
    const { seams, mutations } = recorder()
    const running = offerRouteActivation({
      ctx,
      seams,
      row: signIn(),
      outcome: SIGNED_IN,
      reread: async () => reading([route()]),
      signal: new AbortController().signal,
    })
    await settle()
    await press(DOWN, ENTER)
    expect(await running).toEqual({ kind: 'done', message: 'OpenAI: signed in · openai route left inactive' })
    expect(mutations).toEqual([])
  })

  it('writes nothing when the reader dismisses the question', async () => {
    const { ctx, press } = slots()
    const { seams, mutations } = recorder()
    const running = offerRouteActivation({
      ctx,
      seams,
      row: signIn(),
      outcome: SIGNED_IN,
      reread: async () => reading([route()]),
      signal: new AbortController().signal,
    })
    await settle()
    await press(ESCAPE)
    expect(await running).toEqual({ kind: 'done', message: 'OpenAI: signed in · openai route left inactive' })
    expect(mutations).toEqual([])
  })

  it('asks nothing and writes nothing when the route is already active', async () => {
    const { ctx, mounted } = slots()
    const { seams, mutations } = recorder()
    const outcome = await offerRouteActivation({
      ctx,
      seams,
      row: signIn(),
      outcome: SIGNED_IN,
      reread: async () => reading([route({ state: 'active' })]),
      signal: new AbortController().signal,
    })
    expect(outcome).toEqual({ kind: 'done', message: 'OpenAI: signed in · openai is active' })
    expect(mounted()).toBe(false)
    expect(mutations).toEqual([])
  })

  it('leaves an unlinked sign-in exactly as the flow reported it', async () => {
    const { ctx, mounted } = slots()
    const { seams, mutations } = recorder()
    // A record another plugin owns: nothing published ties it to a route.
    const outcome = await offerRouteActivation({
      ctx,
      seams,
      row: signIn({ key: 'some-other-plugin/thing', label: 'Something' }),
      outcome: { kind: 'done', message: 'Something: signed in' },
      reread: async () => reading([route()]),
      signal: new AbortController().signal,
    })
    expect(outcome).toEqual({ kind: 'done', message: 'Something: signed in' })
    expect(mounted()).toBe(false)
    expect(mutations).toEqual([])
  })

  it('reports rather than offers when the seams would refuse the activation', async () => {
    const { ctx, mounted } = slots()
    const { seams, mutations } = recorder()
    // A route already carrying configuration that did not register is not a
    // dormant one, so `rowActions` offers no activation for it — and neither
    // may this, because the write would replace that configuration.
    const outcome = await offerRouteActivation({
      ctx,
      seams,
      row: signIn(),
      outcome: SIGNED_IN,
      reread: async () => reading([route({ state: 'configured' })]),
      signal: new AbortController().signal,
    })
    expect(outcome).toEqual({
      kind: 'done',
      message: 'OpenAI: signed in · openai is not active, and this profile cannot activate it here',
    })
    expect(mounted()).toBe(false)
    expect(mutations).toEqual([])
  })

  it('says which half failed when the settings write is refused', async () => {
    const { ctx, press } = slots()
    const { seams } = recorder(new Error('revision 7 is stale'))
    const running = offerRouteActivation({
      ctx,
      seams,
      row: signIn(),
      outcome: SIGNED_IN,
      reread: async () => reading([route()]),
      signal: new AbortController().signal,
    })
    await settle()
    await press(ENTER)
    const outcome = await running
    expect(outcome.kind).toBe('failed')
    // Both halves, because only one of them went wrong.
    expect(outcome.message).toContain('signed in, but')
    expect(outcome.message).toContain('revision 7 is stale')
  })

  it('raises no question over a browser that has already closed', async () => {
    const { ctx, mounted } = slots()
    const { seams, mutations } = recorder()
    const withdrawn = new AbortController()
    withdrawn.abort()
    const outcome = await offerRouteActivation({
      ctx,
      seams,
      row: signIn(),
      outcome: SIGNED_IN,
      reread: async () => reading([route()]),
      signal: withdrawn.signal,
    })
    expect(outcome).toEqual({ kind: 'done', message: 'OpenAI: signed in · openai route left inactive' })
    expect(mounted()).toBe(false)
    expect(mutations).toEqual([])
  })

  it('judges the offer from a fresh reading, not the one the sign-in began under', async () => {
    const { ctx, mounted } = slots()
    const { seams, mutations } = recorder()
    // The row the browser was showing said dormant; by the time the sign-in
    // finished, something else had activated the route. Offering activation
    // from the stale row would replace that configuration with `{}`.
    const outcome = await offerRouteActivation({
      ctx,
      seams,
      row: signIn({ route: { provider: 'openai', state: 'dormant' } }),
      outcome: SIGNED_IN,
      reread: async () => reading([route({ state: 'active' })]),
      signal: new AbortController().signal,
    })
    expect(outcome).toEqual({ kind: 'done', message: 'OpenAI: signed in · openai is active' })
    expect(mounted()).toBe(false)
    expect(mutations).toEqual([])
  })

  it('leaves the sign-in outcome alone when the re-read could not answer', async () => {
    const { ctx, mounted } = slots()
    const { seams, mutations } = recorder()
    const outcome = await offerRouteActivation({
      ctx,
      seams,
      row: signIn(),
      outcome: SIGNED_IN,
      reread: async () => ({ kind: 'failed', message: 'the settings document could not be read' }),
      signal: new AbortController().signal,
    })
    expect(outcome).toEqual(SIGNED_IN)
    expect(mounted()).toBe(false)
    expect(mutations).toEqual([])
  })
})
