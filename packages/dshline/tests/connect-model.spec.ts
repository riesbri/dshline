/** What Connect concludes from Harness's facts, and what it refuses to conclude. */

import { describe, expect, it } from 'vitest'
import type {
  ConnectCapabilities,
  ConnectCreateRow,
  ConnectProviderRow,
  ConnectSignInRow,
} from '../src/connect/model.ts'
import {
  derivedCredentialRef,
  filterRows,
  matchesRow,
  newRouteIdProblem,
  noActionsReason,
  providerDetail,
  providerFacts,
  providerReadiness,
  rowActions,
  signInFacts,
} from '../src/connect/model.ts'

/** Every optional seam mounted, which is the ordinary deployment. */
const ALL: ConnectCapabilities = { settings: true, credentials: true, authorization: true }

/**
 * One configurable provider route.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function provider(overrides: Partial<ConnectProviderRow> = {}): ConnectProviderRow {
  return {
    kind: 'provider',
    provider: 'openai',
    displayName: 'OpenAI',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openai'],
    declared: false,
    state: 'active',
    models: 12,
    credential: {
      field: 'apiKeyEnv',
      ref: 'OPENAI_API_KEY',
      info: { configured: true, source: 'file', writable: true },
    },
    userOwned: true,
    revision: 4,
    ...overrides,
  }
}

/**
 * One registered authorization flow.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function signIn(overrides: Partial<ConnectSignInRow> = {}): ConnectSignInRow {
  return {
    kind: 'sign-in',
    key: 'llm-pi-ai/openai',
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    inFlight: false,
    record: { configured: false, writable: true },
    route: undefined,
    ...overrides,
  }
}

describe('readiness', () => {
  it('is ready only for a live route whose named reference is confirmed present', () => {
    expect(providerReadiness(provider())).toBe('ready')
  })

  it('is missing only for a live route whose named reference is confirmed absent', () => {
    const row = provider({ credential: { field: 'apiKeyEnv', ref: 'OPENAI_API_KEY', info: { configured: false, writable: true } } })
    expect(providerReadiness(row)).toBe('missing')
  })

  it('says nothing about a route that names no reference', () => {
    // Reference-free is provider-native authentication — a Bedrock credential
    // chain, Vertex ADC, a stored sign-in. Marking it red would call a working
    // provider broken.
    const row = provider({ credential: { field: 'apiKeyEnv', ref: undefined, info: undefined } })
    expect(providerReadiness(row)).toBe('unknown')
  })

  it('says nothing when the credential seam could not be asked', () => {
    const row = provider({ credential: { field: 'apiKeyEnv', ref: 'OPENAI_API_KEY', info: undefined } })
    expect(providerReadiness(row)).toBe('unknown')
  })

  it('says nothing about a route no adapter has registered', () => {
    expect(providerReadiness(provider({ state: 'dormant' }))).toBe('unknown')
  })
})

describe('what a row reports', () => {
  it('names the model count only for a live route that could be listed', () => {
    expect(providerFacts(provider())).toEqual(['active', '12 models', 'key from file'])
    expect(providerFacts(provider({ models: undefined }))).toEqual(['active', 'key from file'])
    expect(providerFacts(provider({ state: 'dormant', models: undefined })))
      .toEqual(['not active', 'key from file'])
  })

  it('teaches activation only when the existing action is available', () => {
    const dormant = provider({
      state: 'dormant',
      models: undefined,
      userOwned: false,
      credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
    })
    expect(providerFacts(dormant, ALL)).toEqual(['not active', 'activate to add models', 'no key reference'])
    const noSettings: ConnectCapabilities = { settings: false, credentials: true, authorization: true }
    expect(providerFacts(dormant, noSettings)).toEqual(['not active', 'no key reference'])
    expect(providerFacts({ ...dormant, revision: undefined }, ALL)).toEqual(['not active', 'no key reference'])
    expect(providerFacts({ ...dormant, settingsPath: [] }, ALL)).toEqual(['not active', 'no key reference'])
  })

  it('names the reference when it is unset, so the reader knows what to set', () => {
    const row = provider({ credential: { field: 'apiKeyEnv', ref: 'OPENAI_API_KEY', info: { configured: false, writable: true } } })
    expect(providerFacts(row)).toContain('OPENAI_API_KEY unset')
  })

  it('distinguishes a route with no reference from one whose reference is unset', () => {
    const row = provider({ credential: { field: 'apiKeyEnv', ref: undefined, info: undefined } })
    expect(providerFacts(row)).toContain('no key reference')
  })

  it('reports a sign-in by its record, and by the attempt when one is running', () => {
    expect(signInFacts(signIn())).toEqual(['not signed in'])
    expect(signInFacts(signIn({ record: { configured: true, kind: 'grant', writable: true } })))
      .toEqual(['signed in'])
    expect(signInFacts(signIn({ inFlight: true }))).toEqual(['signing in…'])
    expect(signInFacts(signIn({ record: undefined }))).toEqual(['sign-in available'])
  })

  it('says when an authorized account has no route to reach a model through', () => {
    const authorized = { configured: true, kind: 'grant', writable: true }
    // The state a person used to be left to work out for themselves: the
    // credential is stored, and `/model` still offers nothing.
    expect(signInFacts(signIn({ record: authorized, route: { provider: 'openai', state: 'dormant' } })))
      .toEqual(['signed in', 'openai route not active'])
    expect(signInFacts(signIn({ record: authorized, route: { provider: 'openai', state: 'configured' } })))
      .toEqual(['signed in', 'openai route not active'])
    // Nothing extra to say once the route is live.
    expect(signInFacts(signIn({ record: authorized, route: { provider: 'openai', state: 'active' } })))
      .toEqual(['signed in'])
    // No link established: exactly what it reported before the field existed.
    expect(signInFacts(signIn({ record: authorized, route: undefined }))).toEqual(['signed in'])
    // And nothing is claimed about a route for an account nobody signed into.
    expect(signInFacts(signIn({ route: { provider: 'openai', state: 'dormant' } }))).toEqual(['not signed in'])
  })

  it('matches a sign-in by the route key its row shows', () => {
    const row = signIn({
      record: { configured: true, kind: 'grant', writable: true },
      route: { provider: 'openai', state: 'dormant' },
    })
    expect(matchesRow(row, 'openai')).toBe(true)
    // A row that shows no route key does not match one; the key it IS addressed
    // by still matches, because that is drawn too.
    expect(matchesRow(signIn({ key: 'other/thing' }), 'openai')).toBe(false)
    expect(matchesRow(signIn({ key: 'other/thing' }), 'other/thing')).toBe(true)
  })

  it('spells the settings address the stored document uses', () => {
    expect(providerDetail(provider())[0]).toBe('llm-pi-ai · providers.openai')
    expect(providerDetail(provider({ settingsPath: [] }))[0]).toBe('llm-pi-ai')
  })

  it('tags a route the owning adapter says it ships nothing about', () => {
    expect(providerDetail(provider({ declared: true }))).toContain('custom route')
    expect(providerDetail(provider({ declared: undefined }))).not.toContain('custom route')
  })
})

describe('the derived credential reference', () => {
  it('matches the convention the official Models page uses', () => {
    // Both surfaces must derive the same reference or the same provider would
    // read as configured in one and unconfigured in the other.
    expect(derivedCredentialRef('openai')).toBe('OPENAI_API_KEY')
    expect(derivedCredentialRef('opencode-go')).toBe('OPENCODE_GO_API_KEY')
  })

  it('collapses a RUN of non-alphanumerics into one underscore', () => {
    // Character-by-character replacement would give `FOO__BAR_API_KEY`, and the
    // web page would then read a different reference for the same route.
    expect(derivedCredentialRef('foo--bar')).toBe('FOO_BAR_API_KEY')
    expect(derivedCredentialRef('a.b_c-d')).toBe('A_B_C_D_API_KEY')
    expect(derivedCredentialRef('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
  })

  it('refuses an id that cannot become a POSIX identifier', () => {
    // A leading digit passes every other check and then fails at the credential
    // seam with a raw regular expression, which is not an error a reader can act on.
    expect(derivedCredentialRef('4o-gateway')).toBeUndefined()
  })
})

describe('the actions Harness allows', () => {
  it('offers a key, a clear, and a removal for a configured writable route', () => {
    expect(rowActions(provider(), ALL).map(action => action.id))
      .toEqual(['set-key', 'clear-key', 'deactivate'])
  })

  it('offers activation only while the route is dormant', () => {
    const dormant = provider({
      state: 'dormant',
      models: undefined,
      userOwned: false,
      credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
    })
    expect(rowActions(dormant, ALL).map(action => action.id)).toEqual(['set-key', 'activate'])
    expect(rowActions(provider(), ALL).map(action => action.id)).not.toContain('activate')
  })

  it('offers no key action when the schema declares no credential field', () => {
    // An adapter that does not authenticate through a reference must not be
    // handed one; the alternative is writing a field its schema would reject.
    const row = provider({ credential: { field: undefined, ref: undefined, info: undefined } })
    expect(rowActions(row, ALL).map(action => action.id)).not.toContain('set-key')
    expect(noActionsReason({ ...row, userOwned: false }, ALL))
      .toContain('names a credential reference')
  })

  it('offers no key action when the reference is supplied by a read-only source', () => {
    // The seam rejects such a write, and `describe().writable` is published so a
    // surface renders it read-only rather than discovering that by error.
    const row = provider({
      userOwned: false,
      credential: { field: 'apiKeyEnv', ref: 'OPENAI_API_KEY', info: { configured: true, source: 'env', writable: false } },
    })
    expect(rowActions(row, ALL)).toEqual([])
    expect(noActionsReason(row, ALL)).toContain('read-only source')
  })

  it('offers nothing that a missing seam could not carry out', () => {
    const withoutCredentials: ConnectCapabilities = { settings: true, credentials: false, authorization: true }
    expect(rowActions(provider(), withoutCredentials).map(action => action.id)).toEqual(['deactivate'])
    const withoutSettings: ConnectCapabilities = { settings: false, credentials: true, authorization: true }
    expect(rowActions(provider(), withoutSettings).map(action => action.id))
      .toEqual(['set-key', 'clear-key'])
  })

  it('will not remove a profile the user layer does not carry', () => {
    // Unsetting restores the composition base; a route that only HAS a base has
    // nothing here to remove, and offering it would suggest otherwise.
    expect(rowActions(provider({ userOwned: false }), ALL).map(action => action.id))
      .not.toContain('deactivate')
  })

  it('offers no profile op for a namespace whose whole section is the profile', () => {
    // `llm-deepseek` is configured as its whole section (`settingsPath: []`), so
    // a set or unset there would replace every field the namespace holds. The
    // writes refuse it, and an offer that is known to fail must never be listed.
    const deepseek = provider({
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      credential: {
        field: 'apiKeyEnv',
        ref: 'DEEPSEEK_API_KEY',
        info: { configured: true, source: 'file', writable: true },
      },
    })
    expect(rowActions(deepseek, ALL).map(action => action.id)).toEqual(['set-key', 'clear-key'])
  })

  it('still offers a first key for a whole-section profile, which writes a field path', () => {
    // Recording the reference writes `apiKeyEnv`, not the section root, so this
    // one is addressable where activate and deactivate are not.
    const dormantSection = provider({
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      state: 'dormant',
      models: undefined,
      userOwned: false,
      credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
    })
    expect(rowActions(dormantSection, ALL).map(action => action.id)).toEqual(['set-key'])
  })

  it('explains a whole-section route that has nothing left to offer', () => {
    const row = provider({
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      userOwned: true,
      credential: { field: undefined, ref: undefined, info: undefined },
    })
    expect(rowActions(row, ALL)).toEqual([])
    expect(noActionsReason(row, ALL)).toContain('names a credential reference')
  })

  it('will not write settings against a namespace whose revision was not read', () => {
    const row = provider({ revision: undefined, credential: { field: 'apiKeyEnv', ref: undefined, info: undefined } })
    expect(rowActions(row, ALL)).toEqual([])
  })

  it('offers a sign-in, and a sign-out only once a record exists', () => {
    expect(rowActions(signIn(), ALL).map(action => action.id)).toEqual(['sign-in'])
    expect(rowActions(signIn({ record: { configured: true, kind: 'grant', writable: true } }), ALL)
      .map(action => action.id)).toEqual(['sign-in', 'sign-out'])
  })

  it('offers nothing while an attempt for the key is already running', () => {
    // One attempt per key is the seam's rule, and `inFlight` is published so a
    // surface can honour it instead of provoking ALREADY_IN_FLIGHT.
    const row = signIn({ inFlight: true })
    expect(rowActions(row, ALL)).toEqual([])
    expect(noActionsReason(row, ALL)).toContain('already running')
  })

  it('says that a sign-out is local, because "sign out" would not be true', () => {
    const row = signIn({ record: { configured: true, kind: 'grant', writable: true } })
    const action = rowActions(row, ALL).find(candidate => candidate.id === 'sign-out')
    expect(action?.description).toContain('issuer is not told')
  })
})

describe('filtering', () => {
  it('matches what the row shows, in either section', () => {
    expect(matchesRow(provider(), 'openai')).toBe(true)
    expect(matchesRow(provider(), 'pi-ai')).toBe(true)
    expect(matchesRow(provider({ state: 'dormant' }), 'not active')).toBe(true)
    expect(matchesRow(provider({ state: 'dormant' }), 'dormant')).toBe(false)
    expect(matchesRow(signIn(), 'chatgpt')).toBe(true)
    expect(matchesRow(signIn(), 'anthropic')).toBe(false)
  })

  it('keeps declaration order and returns everything for an empty query', () => {
    const rows = [provider({ provider: 'openai' }), provider({ provider: 'anthropic' })]
    expect(filterRows(rows, '  ')).toBe(rows)
    expect(filterRows(rows, 'a').map(row => row.provider)).toEqual(['openai', 'anthropic'])
  })

  it('matches a create row by its label', () => {
    const row: ConnectCreateRow = { kind: 'create', label: 'Add custom provider', targets: [] }
    expect(matchesRow(row, 'custom')).toBe(true)
    expect(matchesRow(row, 'openai')).toBe(false)
  })
})

describe('whether a typed id can become a new route', () => {
  it('accepts a lowercase id with internal hyphens', () => {
    expect(newRouteIdProblem('local-llama', new Set())).toBeUndefined()
  })

  it('refuses an id already declared', () => {
    expect(newRouteIdProblem('openai', new Set(['openai']))).toContain('already declared')
  })

  it('refuses an empty id', () => {
    expect(newRouteIdProblem('', new Set())).toContain('required')
  })

  it('refuses a leading digit, which cannot become a credential reference', () => {
    expect(newRouteIdProblem('4o-gateway', new Set())).toBeDefined()
  })

  it('refuses uppercase and consecutive or trailing hyphens', () => {
    expect(newRouteIdProblem('Local-Llama', new Set())).toBeDefined()
    expect(newRouteIdProblem('local--llama', new Set())).toBeDefined()
    expect(newRouteIdProblem('local-', new Set())).toBeDefined()
  })
})
