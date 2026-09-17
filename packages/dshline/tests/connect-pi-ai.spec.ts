/** Curated presentation for the one known configuration domain: `llm-pi-ai`. */

import { describe, expect, it } from 'vitest'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import {
  API_FIELD,
  BASE_URL_FIELD,
  CONTEXT_WINDOW_FIELD,
  createRouteOp,
  curatedModelFields,
  curatedOverrideFields,
  DISPLAY_NAME_FIELD,
  extraActions,
  fieldOps,
  HEADERS_FIELD,
  headersCurated,
  INPUT_FIELD,
  isPiAiNamespace,
  MAX_TOKENS_FIELD,
  mergeModelEntry,
  mergeOverrideEntry,
  MODEL_OVERRIDES_FIELD,
  MODELS_FIELD,
  NAME_FIELD,
  piAiDeclarationTarget,
  protocolChoices,
  rawHeaders,
  rawModelOverrides,
  rawModels,
  REASONING_EFFORTS_FIELD,
  routeModelSchema,
  setHeadersOp,
  setModelsOp,
  setOverrideOp,
  unsetHeadersOp,
  unsetModelsOp,
  unsetOverrideOp,
} from '../src/connect/pi-ai.ts'
import type { ConnectCapabilities, ConnectProviderRow } from '../src/connect/model.ts'
import type { SettingsDescriptorRead } from '../src/connect/harness.ts'

/** A schema shaping `api` as a union of string consts, the way `dsh-llm-pi-ai` does. */
const PI_AI_SCHEMA = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3 },
    3: { type: 'object', meta: {}, dict: { api: 4, apiKeyEnv: 8, baseURL: 9, models: 10 } },
    4: { type: 'union', meta: {}, list: [5, 6, 7] },
    5: { type: 'const', meta: {}, value: 'openai-completions' },
    6: { type: 'const', meta: {}, value: 'openai-responses' },
    7: { type: 'const', meta: {}, value: 'anthropic-messages' },
    8: { type: 'string', meta: { role: 'credential-ref' } },
    9: { type: 'string', meta: {} },
    10: { type: 'array', meta: {}, inner: 3 },
  },
}

/**
 * The real `llm-pi-ai` model shapes: a `models` array of objects, a
 * `modelOverrides` dict of the SAME object (keyed by model id), and the
 * `input`/`reasoningEfforts` field shapes the schema actually serializes.
 * Mirrors `z.array(modelProfile)` / `z.dict(modelOverride)` with
 * `z.union(MODALITIES)` and `z.union([z.const(false), reasoningEfforts])`.
 */
const PI_AI_MODEL_SCHEMA = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3, sKey: 20 },
    3: { type: 'object', meta: {}, dict: { models: 4, modelOverrides: 8 } },
    4: { type: 'array', meta: { default: [] }, inner: 5 },
    5: { type: 'object', meta: { default: {} }, dict: { id: 6, name: 7, contextWindow: 11, maxTokens: 11, input: 12, reasoningEfforts: 14 } },
    6: { type: 'string', meta: { required: true } },
    7: { type: 'string', meta: {} },
    8: { type: 'dict', meta: { default: {} }, inner: 9, sKey: 10 },
    9: { type: 'object', meta: { default: {} }, dict: { name: 7, contextWindow: 11, maxTokens: 11, input: 12, reasoningEfforts: 14 } },
    10: { type: 'string', meta: {} },
    11: { type: 'number', meta: { step: 1, min: 1 } },
    12: { type: 'array', meta: { default: [] }, inner: 13 },
    13: { type: 'union', meta: {}, list: [15, 16] },
    15: { type: 'const', meta: { required: true }, value: 'text' },
    16: { type: 'const', meta: { required: true }, value: 'image' },
    14: { type: 'union', meta: {}, list: [17, 18] },
    17: { type: 'const', meta: {}, value: false },
    18: { type: 'dict', meta: { default: {} }, inner: 21, sKey: 19 },
    19: { type: 'union', meta: {}, list: [22, 23] },
    22: { type: 'const', meta: { required: true }, value: 'off' },
    23: { type: 'const', meta: { required: true }, value: 'high' },
    21: { type: 'union', meta: {}, list: [24, 25] },
    24: { type: 'string', meta: {} },
    25: { type: 'const', meta: {}, value: null },
    20: { type: 'string', meta: {} },
  },
}

describe('recognizing the one domain this module presents', () => {
  it('is llm-pi-ai and only llm-pi-ai', () => {
    expect(isPiAiNamespace('llm-pi-ai')).toBe(true)
    expect(isPiAiNamespace('llm-deepseek')).toBe(false)
  })
})

describe('reading curated model fields off a raw entry', () => {
  it('reads what it curates and ignores the rest', () => {
    expect(curatedModelFields({ id: 'gpt', name: 'GPT', contextWindow: 128000, compat: {} }))
      .toEqual({ id: 'gpt', name: 'GPT', contextWindow: 128000, maxTokens: undefined })
  })

  it('refuses an entry with no usable id', () => {
    expect(curatedModelFields({ name: 'no id' })).toBeUndefined()
    expect(curatedModelFields('not an object')).toBeUndefined()
    expect(curatedModelFields(null)).toBeUndefined()
  })
})

describe('the inherited-vs-explicit-empty distinction', () => {
  it('is absent when the profile has no models field at all', () => {
    expect(rawModels({ baseURL: 'https://x' })).toBeUndefined()
  })

  it('is an explicit empty array when the profile says so', () => {
    expect(rawModels({ models: [] })).toEqual([])
  })

  it('reads the stored entries verbatim otherwise', () => {
    expect(rawModels({ models: [{ id: 'a' }] })).toEqual([{ id: 'a' }])
  })
})

describe('merging curated edits without losing unknown fields', () => {
  it('spreads the retained shape first, so curated fields win but the rest survives', () => {
    const retained = { id: 'gpt', name: 'old', compat: { supportsDeveloperRole: false } }
    const merged = mergeModelEntry(retained, {
      id: 'gpt',
      name: 'new',
      contextWindow: undefined,
      maxTokens: undefined,
      input: undefined,
      reasoningEfforts: undefined,
    })
    expect(merged).toEqual({ id: 'gpt', name: 'new', compat: { supportsDeveloperRole: false } })
  })

  it('deletes every curated field cleared to undefined rather than writing null', () => {
    const retained = {
      id: 'gpt',
      name: 'old',
      contextWindow: 1000,
      input: ['text'],
      reasoningEfforts: { low: 'low' },
    }
    expect(mergeModelEntry(retained, {
      id: 'gpt',
      name: undefined,
      contextWindow: undefined,
      maxTokens: undefined,
      input: undefined,
      reasoningEfforts: undefined,
    })).toEqual({ id: 'gpt' })
  })

  it('writes the capability fields it was given, including an explicit disable', () => {
    expect(mergeModelEntry(undefined, {
      id: 'gpt',
      name: undefined,
      contextWindow: undefined,
      maxTokens: undefined,
      input: ['text', 'image'],
      reasoningEfforts: false,
    })).toEqual({ id: 'gpt', input: ['text', 'image'], reasoningEfforts: false })
  })

  it('builds a fresh entry when there is nothing retained', () => {
    expect(mergeModelEntry(undefined, {
      id: 'gpt',
      name: 'GPT',
      contextWindow: 128000,
      maxTokens: undefined,
      input: undefined,
      reasoningEfforts: undefined,
    })).toEqual({ id: 'gpt', name: 'GPT', contextWindow: 128000 })
  })
})

describe('override values and reading them back', () => {
  it('merges curated fields without ever writing an id', () => {
    expect(mergeOverrideEntry({ id: 'stray', name: 'old', compat: { supportsStore: false } }, {
      id: 'gpt',
      name: 'new',
      contextWindow: undefined,
      maxTokens: undefined,
      input: undefined,
      reasoningEfforts: undefined,
    })).toEqual({ name: 'new', compat: { supportsStore: false } })
  })

  it('reads an override value whose id is the dict key', () => {
    expect(curatedOverrideFields('gpt', { name: 'GPT', input: ['text'], reasoningEfforts: { off: null } }))
      .toMatchObject({ id: 'gpt', name: 'GPT', input: ['text'], reasoningEfforts: { off: null } })
  })

  it('still reads an id-only view from a malformed value, so it stays visible', () => {
    expect(curatedOverrideFields('gpt', 'not an object')).toMatchObject({ id: 'gpt', name: undefined })
  })

  it('reads the raw override dict, empty for anything that is not one', () => {
    expect(rawModelOverrides({ modelOverrides: { gpt: { name: 'G' } } })).toEqual({ gpt: { name: 'G' } })
    expect(rawModelOverrides({ modelOverrides: [] })).toEqual({})
    expect(rawModelOverrides({})).toEqual({})
  })
})

describe('model schema derivation', () => {
  it('reads the fields and vocabularies from the entry objects themselves', () => {
    expect(routeModelSchema(PI_AI_MODEL_SCHEMA, ['providers', 'openai'])).toEqual({
      models: true,
      overrides: true,
      entry: {
        name: true,
        contextWindow: { min: 1, step: 1 },
        maxTokens: { min: 1, step: 1 },
        input: ['text', 'image'],
        reasoningLevels: ['off', 'high'],
        reasoningCanDisable: true,
      },
    })
  })

  it('answers nothing readable for a route the schema does not describe', () => {
    const noModels = {
      uid: 1,
      refs: {
        1: { type: 'object', meta: {}, dict: { providers: 2 } },
        2: { type: 'dict', meta: {}, inner: 3 },
        3: { type: 'object', meta: {}, dict: { api: 4 } },
        4: { type: 'string', meta: {} },
      },
    }
    expect(routeModelSchema(noModels, ['providers', 'openai']))
      .toEqual({ models: false, overrides: false, entry: undefined })
  })
})

describe('override path ops', () => {
  it('sets one id under the route without touching a sibling', () => {
    expect(setOverrideOp(['providers', 'openai'], 'gpt', { name: 'G' }))
      .toEqual({ op: 'set', path: ['providers', 'openai', MODEL_OVERRIDES_FIELD, 'gpt'], value: { name: 'G' } })
  })

  it('unsets exactly the named id', () => {
    expect(unsetOverrideOp(['providers', 'openai'], 'gpt'))
      .toEqual({ op: 'unset', path: ['providers', 'openai', MODEL_OVERRIDES_FIELD, 'gpt'] })
  })
})

describe('protocol choices read from the schema', () => {
  it('offers the union of string consts the api field is built from', () => {
    expect(protocolChoices(PI_AI_SCHEMA, ['providers', 'openai']))
      .toEqual(['openai-completions', 'openai-responses', 'anthropic-messages'])
  })

  it('answers the same shape for a route id the schema has never seen', () => {
    // A dict describes every key with one element node — this is what lets a
    // brand-new route id get the same protocol offer as an existing one.
    expect(protocolChoices(PI_AI_SCHEMA, ['providers', 'not-yet-declared']))
      .toEqual(['openai-completions', 'openai-responses', 'anthropic-messages'])
  })

  it('offers nothing when the schema does not shape the field as a union of consts', () => {
    const plain = {
      uid: 1,
      refs: {
        1: { type: 'object', meta: {}, dict: { providers: 2 } },
        2: { type: 'dict', meta: {}, inner: 3 },
        3: { type: 'object', meta: {}, dict: { api: 4 } },
        4: { type: 'string', meta: {} },
      },
    }
    expect(protocolChoices(plain, ['providers', 'openai'])).toEqual([])
  })
})

describe('path ops for curated field changes', () => {
  it('writes one op per changed field, addressed under the route path', () => {
    const ops = fieldOps(['providers', 'openai'], [
      { field: BASE_URL_FIELD, value: 'https://example.test/v1' },
      { field: API_FIELD, value: undefined },
    ])
    expect(ops).toEqual([
      { op: 'set', path: ['providers', 'openai', BASE_URL_FIELD], value: 'https://example.test/v1' },
      { op: 'unset', path: ['providers', 'openai', API_FIELD] },
    ])
  })
})

describe('the models array ops', () => {
  it('sets the whole array for a customized catalog', () => {
    expect(setModelsOp(['providers', 'openai'], [{ id: 'gpt' }]))
      .toEqual({ op: 'set', path: ['providers', 'openai', MODELS_FIELD], value: [{ id: 'gpt' }] })
  })

  it('unsets, never sets an empty array, to restore inheritance', () => {
    expect(unsetModelsOp(['providers', 'openai']))
      .toEqual({ op: 'unset', path: ['providers', 'openai', MODELS_FIELD] })
  })
})

describe('declaring a brand-new route, whole', () => {
  it('writes the curated fields, the credential reference, and every model in one op', () => {
    const op = createRouteOp(['providers', 'local-llama'], {
      displayName: 'Local Llama',
      baseURL: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      headers: {},
      models: [{ id: 'llama3', name: undefined, contextWindow: undefined, maxTokens: undefined }],
      credentialField: 'apiKeyEnv',
      credentialRef: 'LOCAL_LLAMA_API_KEY',
    })
    expect(op).toEqual({
      op: 'set',
      path: ['providers', 'local-llama'],
      value: {
        baseURL: 'http://127.0.0.1:11434/v1',
        api: 'openai-completions',
        displayName: 'Local Llama',
        apiKeyEnv: 'LOCAL_LLAMA_API_KEY',
        models: [{ id: 'llama3' }],
      },
    })
  })

  it('omits the credential field entirely for a keyless route', () => {
    const op = createRouteOp(['providers', 'local-llama'], {
      displayName: undefined,
      baseURL: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      headers: {},
      models: [{ id: 'llama3', name: undefined, contextWindow: undefined, maxTokens: undefined }],
      credentialField: undefined,
      credentialRef: undefined,
    })
    expect(op.value).not.toHaveProperty('apiKeyEnv')
    expect(op.value).not.toHaveProperty(DISPLAY_NAME_FIELD)
  })

  it('writes request headers when the form collected some, and omits the key when it did not', () => {
    const withHeaders = createRouteOp(['providers', 'gateway'], {
      displayName: undefined,
      baseURL: 'https://gw.example/v1',
      api: 'openai-completions',
      headers: { 'X-Tenant-Id': 'acme' },
      models: [{ id: 'gpt-oss', name: undefined, contextWindow: undefined, maxTokens: undefined }],
      credentialField: undefined,
      credentialRef: undefined,
    })
    expect(withHeaders.value).toMatchObject({ [HEADERS_FIELD]: { 'X-Tenant-Id': 'acme' } })
    // An empty map and an absent key say the same thing, so only one of them
    // is ever written — see `unsetHeadersOp`.
    const without = createRouteOp(['providers', 'gateway'], {
      displayName: undefined,
      baseURL: 'https://gw.example/v1',
      api: 'openai-completions',
      headers: {},
      models: [{ id: 'gpt-oss', name: undefined, contextWindow: undefined, maxTokens: undefined }],
      credentialField: undefined,
      credentialRef: undefined,
    })
    expect(without.value).not.toHaveProperty(HEADERS_FIELD)
  })
})

describe('curating a route’s request headers', () => {
  it('reads the stored map, and answers undefined for a field that is absent or not an object', () => {
    expect(rawHeaders({ headers: { 'X-A': '1' } })).toEqual({ 'X-A': '1' })
    expect(rawHeaders({})).toBeUndefined()
    expect(rawHeaders({ headers: 'nope' })).toBeUndefined()
    expect(rawHeaders({ headers: ['nope'] })).toBeUndefined()
    expect(rawHeaders(undefined)).toBeUndefined()
  })

  it('sets the whole map under the route, and unsets rather than writing an empty one', () => {
    expect(setHeadersOp(['providers', 'gw'], { 'X-A': '1' })).toEqual({
      op: 'set',
      path: ['providers', 'gw', HEADERS_FIELD],
      value: { 'X-A': '1' },
    })
    expect(unsetHeadersOp(['providers', 'gw'])).toEqual({
      op: 'unset',
      path: ['providers', 'gw', HEADERS_FIELD],
    })
  })

  it('offers the editor only while the schema still shapes the field as a dict of strings', () => {
    const dictOfStrings = {
      uid: 1,
      refs: {
        1: { type: 'object', dict: { providers: 2 } },
        2: { type: 'dict', inner: 3 },
        3: { type: 'object', dict: { headers: 4 } },
        4: { type: 'dict', inner: 5 },
        5: { type: 'string' },
      },
    }
    expect(headersCurated(dictOfStrings, ['providers', 'gw'])).toBe(true)
    // Reshaped: the values stopped being plain text, so this editor would be
    // writing something the namespace no longer accepts.
    const dictOfObjects = {
      ...dictOfStrings,
      refs: { ...dictOfStrings.refs, 5: { type: 'object', dict: {} } },
    }
    expect(headersCurated(dictOfObjects, ['providers', 'gw'])).toBe(false)
    // Gone entirely.
    const noField = {
      ...dictOfStrings,
      refs: { ...dictOfStrings.refs, 3: { type: 'object', dict: {} } },
    }
    expect(headersCurated(noField, ['providers', 'gw'])).toBe(false)
    expect(headersCurated(undefined, ['providers', 'gw'])).toBe(false)
  })
})

describe('the one action a generic row picker cannot offer', () => {
  const ALL: ConnectCapabilities = { settings: true, credentials: true, authorization: true }

  function row(overrides: Partial<ConnectProviderRow> = {}): ConnectProviderRow {
    return {
      kind: 'provider',
      provider: 'openai',
      displayName: 'OpenAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      declared: false,
      state: 'active',
      models: 3,
      credential: { field: 'apiKeyEnv', ref: 'OPENAI_API_KEY', info: { configured: true, source: 'file', writable: true } },
      userOwned: true,
      revision: 4,
      ...overrides,
    }
  }

  it('offers edit-route only for a writable pi-ai row', () => {
    expect(extraActions(row(), ALL).map(action => action.id)).toEqual(['edit-route'])
  })

  it('offers nothing for any other namespace', () => {
    expect(extraActions(row({ settingsNs: 'llm-deepseek' }), ALL)).toEqual([])
  })

  it('offers nothing without a settings provider, a revision, or an addressable path', () => {
    expect(extraActions(row(), { ...ALL, settings: false })).toEqual([])
    expect(extraActions(row({ revision: undefined }), ALL)).toEqual([])
    expect(extraActions(row({ settingsPath: [] }), ALL)).toEqual([])
  })
})

describe('whether this module can service declaring a brand-new pi-ai route', () => {
  /** A pi-ai catalog entry, whose profile lives at `providers.<id>`. */
  const OPENAI_ENTRY: LlmConfigurableProvider = {
    provider: 'openai',
    displayName: 'OpenAI',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openai'],
    declared: false,
  }

  const PI_AI_DESCRIPTOR: SettingsDescriptorRead = {
    ns: 'llm-pi-ai',
    schema: PI_AI_SCHEMA,
    value: { providers: { openai: {} } },
    revision: 5,
  }

  it('finds the dict one segment above an existing route, once every check passes', () => {
    const target = piAiDeclarationTarget([OPENAI_ENTRY], new Map([['llm-pi-ai', PI_AI_DESCRIPTOR]]))
    expect(target).toEqual({ settingsNs: 'llm-pi-ai', parentPath: ['providers'], revision: 5 })
  })

  it('offers nothing when the directory has no llm-pi-ai entry at all', () => {
    // No entry means no known address to even guess at — there is no fallback
    // to a hardcoded 'providers' path.
    expect(piAiDeclarationTarget([], new Map())).toBeUndefined()
  })

  it('ignores an entry from a namespace this module does not present', () => {
    // A dict-shaped `providers` under some OTHER namespace is not evidence
    // that namespace can be hand-declared into: only llm-pi-ai's own entries
    // are ever consulted.
    const other: LlmConfigurableProvider = {
      provider: 'foo',
      displayName: 'Foo',
      settingsNs: 'llm-other',
      settingsPath: ['providers', 'foo'],
      declared: false,
    }
    const descriptor: SettingsDescriptorRead = { ...PI_AI_DESCRIPTOR, ns: 'llm-other' }
    expect(piAiDeclarationTarget([other], new Map([['llm-other', descriptor]]))).toBeUndefined()
  })

  it('offers nothing for a namespace whose whole section is the profile', () => {
    // `settingsPath: []` has no segment above it to be a dict.
    const wholeSection: LlmConfigurableProvider = { ...OPENAI_ENTRY, settingsPath: [] }
    expect(piAiDeclarationTarget([wholeSection], new Map([['llm-pi-ai', PI_AI_DESCRIPTOR]]))).toBeUndefined()
  })

  it('offers nothing when the schema does not shape the parent as a dict', () => {
    const descriptor: SettingsDescriptorRead = {
      ...PI_AI_DESCRIPTOR,
      schema: {
        uid: 1,
        refs: { 1: { type: 'object', meta: {}, dict: { providers: 2 } }, 2: { type: 'object', meta: {}, dict: {} } },
      },
    }
    expect(piAiDeclarationTarget([OPENAI_ENTRY], new Map([['llm-pi-ai', descriptor]]))).toBeUndefined()
  })

  it('offers nothing when entries disagree about where the dict sits', () => {
    const other: LlmConfigurableProvider = { ...OPENAI_ENTRY, provider: 'other', settingsPath: ['legacy', 'other'] }
    expect(piAiDeclarationTarget([OPENAI_ENTRY, other], new Map([['llm-pi-ai', PI_AI_DESCRIPTOR]]))).toBeUndefined()
  })

  it('offers nothing when the curated baseURL field is no longer reachable', () => {
    // A dict shape alone is not enough: this module also has to be able to
    // find the fields it curates, or a wizard it starts would fail partway
    // through writing a profile it cannot fully describe.
    const descriptor: SettingsDescriptorRead = {
      ...PI_AI_DESCRIPTOR,
      schema: {
        uid: 1,
        refs: {
          1: { type: 'object', meta: {}, dict: { providers: 2 } },
          2: { type: 'dict', meta: {}, inner: 3 },
          3: { type: 'object', meta: {}, dict: { api: 4 } },
          4: { type: 'union', meta: {}, list: [5] },
          5: { type: 'const', meta: {}, value: 'openai-completions' },
        },
      },
    }
    expect(piAiDeclarationTarget([OPENAI_ENTRY], new Map([['llm-pi-ai', descriptor]]))).toBeUndefined()
  })

  it('offers nothing when the curated models field is no longer reachable', () => {
    // `runCreateRoute` always writes a `models` array; a schema that stopped
    // describing that field would accept the row and then fail the write.
    const descriptor: SettingsDescriptorRead = {
      ...PI_AI_DESCRIPTOR,
      schema: {
        uid: 1,
        refs: {
          1: { type: 'object', meta: {}, dict: { providers: 2 } },
          2: { type: 'dict', meta: {}, inner: 3 },
          3: { type: 'object', meta: {}, dict: { api: 4, baseURL: 6 } },
          4: { type: 'union', meta: {}, list: [5] },
          5: { type: 'const', meta: {}, value: 'openai-completions' },
          6: { type: 'string', meta: {} },
        },
      },
    }
    expect(piAiDeclarationTarget([OPENAI_ENTRY], new Map([['llm-pi-ai', descriptor]]))).toBeUndefined()
  })

  it('does not require a credential-ref field — a keyless route stays declarable', () => {
    // Absence of a credential-ref field is a supported state (an
    // unauthenticated local server), not a reason to disable creation
    // outright; `runCreateRoute` itself adapts what it asks for.
    const descriptor: SettingsDescriptorRead = {
      ...PI_AI_DESCRIPTOR,
      schema: {
        uid: 1,
        refs: {
          1: { type: 'object', meta: {}, dict: { providers: 2 } },
          2: { type: 'dict', meta: {}, inner: 3 },
          3: { type: 'object', meta: {}, dict: { api: 4, baseURL: 6, models: 7 } },
          4: { type: 'union', meta: {}, list: [5] },
          5: { type: 'const', meta: {}, value: 'openai-completions' },
          6: { type: 'string', meta: {} },
          7: { type: 'array', meta: {}, inner: 3 },
        },
      },
    }
    expect(piAiDeclarationTarget([OPENAI_ENTRY], new Map([['llm-pi-ai', descriptor]])))
      .toEqual({ settingsNs: 'llm-pi-ai', parentPath: ['providers'], revision: 5 })
  })

  it('offers nothing when no protocol choice can be derived', () => {
    // The same schema-shape check `protocolChoices` makes: a namespace this
    // module cannot offer a protocol for is one it cannot safely declare a
    // route into either — capability drift disables the row rather than
    // falling back to a stale dshline protocol list.
    const descriptor: SettingsDescriptorRead = {
      ...PI_AI_DESCRIPTOR,
      schema: {
        uid: 1,
        refs: {
          1: { type: 'object', meta: {}, dict: { providers: 2 } },
          2: { type: 'dict', meta: {}, inner: 3 },
          3: { type: 'object', meta: {}, dict: { api: 4, baseURL: 5 } },
          4: { type: 'string', meta: {} },
          5: { type: 'string', meta: {} },
        },
      },
    }
    expect(piAiDeclarationTarget([OPENAI_ENTRY], new Map([['llm-pi-ai', descriptor]]))).toBeUndefined()
  })
})
