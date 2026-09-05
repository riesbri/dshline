/**
 * Which provider route one `llm-pi-ai` sign-in authenticates.
 *
 * `connect/model.ts` refuses this join in general, and these tests are mostly
 * about keeping that refusal intact: the link is only ever produced for a
 * record whose scope names this one adapter family AND whose id names a route
 * that family actually published, at the address it publishes routes at. Every
 * other shape answers undefined, which leaves the sign-in row exactly as it
 * read before the link existed.
 *
 * The knowledge being exercised is upstream's own, stated on both sides:
 * `recordKeyFor(providerId)` builds `llm-pi-ai/<providerId>` where its own
 * parameter doc calls `providerId` "pi-ai's own provider id, which is also the
 * harness route key", and `directoryEntries` publishes that id at
 * `providers.<id>` in the same namespace.
 */

import { describe, expect, it } from 'vitest'
import { piAiSignInRoute } from '../src/connect/pi-ai.ts'
import type { ConnectProviderRow } from '../src/connect/model.ts'

/**
 * One published provider route.
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
    state: 'dormant',
    models: undefined,
    credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
    userOwned: false,
    revision: 1,
    ...overrides,
  }
}

describe('linking a sign-in to the route it authenticates', () => {
  it('resolves a record to the route the same directory published', () => {
    const openai = route()
    const anthropic = route({ provider: 'anthropic', settingsPath: ['providers', 'anthropic'] })
    expect(piAiSignInRoute('llm-pi-ai/openai', [anthropic, openai])).toBe(openai)
    expect(piAiSignInRoute('llm-pi-ai/anthropic', [anthropic, openai])).toBe(anthropic)
  })

  it('resolves nothing for a scope this module does not own', () => {
    // Another plugin's records are written in a format this family never
    // agreed to, and its ids mean nothing here.
    expect(piAiSignInRoute('some-plugin/openai', [route()])).toBeUndefined()
    expect(piAiSignInRoute('LLM-PI-AI/openai', [route()])).toBeUndefined()
  })

  it('resolves nothing for a route the directory never published', () => {
    // Verified, not assumed: a key is only ever resolved against routes that
    // actually exist, so an id nothing published stays unlinked.
    expect(piAiSignInRoute('llm-pi-ai/absent', [route()])).toBeUndefined()
    expect(piAiSignInRoute('llm-pi-ai/openai', [])).toBeUndefined()
  })

  it('follows the address the directory published, wherever the dict sits', () => {
    // The parent segment is the namespace's to choose; what has to hold is that
    // the route is addressed BY ITS OWN KEY, because that is what makes the
    // published path this sign-in's profile and not a neighbour's.
    const moved = route({ settingsPath: ['routes', 'openai'] })
    expect(piAiSignInRoute('llm-pi-ai/openai', [moved])).toBe(moved)
  })

  it('resolves nothing when the published address is not keyed by the route id', () => {
    // Fail closed, exactly as `protocolChoices` and `headersCurated` do on a
    // schema this module no longer recognizes: activating the wrong path would
    // replace a profile that is not this sign-in's.
    expect(piAiSignInRoute('llm-pi-ai/openai', [route({ settingsPath: ['providers', 'openai', 'profile'] })]))
      .toBeUndefined()
    // An empty path means the whole section IS the profile, which `activateRoute`
    // refuses outright.
    expect(piAiSignInRoute('llm-pi-ai/openai', [route({ settingsPath: [] })])).toBeUndefined()
  })

  it('resolves nothing for a route another namespace happens to name the same', () => {
    expect(piAiSignInRoute('llm-pi-ai/openai', [route({ settingsNs: 'llm-deepseek' })])).toBeUndefined()
  })

  it('refuses a key that is not one scope and one id', () => {
    expect(piAiSignInRoute('llm-pi-ai', [route()])).toBeUndefined()
    expect(piAiSignInRoute('llm-pi-ai/', [route()])).toBeUndefined()
    expect(piAiSignInRoute('/openai', [route()])).toBeUndefined()
    expect(piAiSignInRoute('', [route()])).toBeUndefined()
    // A second separator means this is not an address this module can read.
    expect(piAiSignInRoute('llm-pi-ai/openai/extra', [route()])).toBeUndefined()
  })
})
