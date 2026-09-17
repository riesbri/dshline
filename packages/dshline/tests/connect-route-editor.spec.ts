/**
 * Declaring and editing one `llm-pi-ai` route from a terminal.
 *
 * Every prompt and menu here is driven the same way a person would: pressing
 * keys into whatever overlay `ctx.tuiSlots.pushOverlay` most recently mounted.
 * That is deliberate — it is the only way to prove the invariants that matter
 * (discovery goes through `ctx.llm.discoverModels` and nothing else, settings
 * land before a credential, a typed key never reaches an outcome message)
 * without re-implementing the flows against their internals.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import type { TuiOverlay } from '../src/slots.ts'
import { runCreateRoute, runRouteEditor } from '../src/connect/route-editor.ts'
import type {
  ConnectCredentials,
  ConnectLlm,
  ConnectSeams,
  ConnectSettings,
  LlmModelDiscoveryRequestRead,
  SettingsDescriptorRead,
} from '../src/connect/harness.ts'
import type { ConnectNewRouteTarget, ConnectProviderRow } from '../src/connect/model.ts'

/**
 * Let every pending microtask run, so a settled prompt's continuation has
 * pushed its next overlay before the test presses into it.
 * @returns when the queue has drained.
 */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

/** A context whose slot registry hands each pushed overlay to the test. */
function slots(): {
  ctx: Context
  type: (text: string) => Promise<void>
  press: (...keys: Key[]) => Promise<void>
  text: (columns?: number, rows?: number) => string
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
    type: async text => { stack.at(-1)?.handleKey({ kind: 'text', text }); await settle() },
    press: async (...keys) => {
      for (const key of keys) stack.at(-1)?.handleKey(key)
      await settle()
    },
    text: (columns = 90, rows = 24) => stripAnsi((stack.at(-1)?.render(columns, rows) ?? []).join('\n')),
  }
}

const ENTER: Key = { kind: 'key', name: 'enter' }
const DOWN: Key = { kind: 'key', name: 'down' }
const UP: Key = { kind: 'key', name: 'up' }
const CTRL_U: Key = { kind: 'key', name: 'ctrl-u' }

/** The `llm-pi-ai` schema shape: a dict of profiles under `providers`. */
const PI_AI_SCHEMA = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3 },
    3: { type: 'object', meta: {}, dict: { api: 4, apiKeyEnv: 6, baseURL: 7, displayName: 7, models: 7 } },
    4: { type: 'union', meta: {}, list: [5] },
    5: { type: 'const', meta: {}, value: 'openai-completions' },
    6: { type: 'string', meta: { role: 'credential-ref' } },
    7: { type: 'string', meta: {} },
  },
}

/** The same shape, with `headers` still described the way `dsh-llm-pi-ai` describes it. */
const PI_AI_SCHEMA_WITH_HEADERS = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3 },
    3: {
      type: 'object',
      meta: {},
      dict: { api: 4, apiKeyEnv: 6, baseURL: 7, displayName: 7, models: 7, headers: 8 },
    },
    4: { type: 'union', meta: {}, list: [5] },
    5: { type: 'const', meta: {}, value: 'openai-completions' },
    6: { type: 'string', meta: { role: 'credential-ref' } },
    7: { type: 'string', meta: {} },
    8: { type: 'dict', meta: {}, inner: 7 },
  },
}

/** A schema with no `credential-ref` field at all — a keyless-only route domain. */
const SCHEMA_WITHOUT_CREDENTIAL_REF = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3 },
    3: { type: 'object', meta: {}, dict: { api: 4, baseURL: 6, models: 6 } },
    4: { type: 'union', meta: {}, list: [5] },
    5: { type: 'const', meta: {}, value: 'openai-completions' },
    6: { type: 'string', meta: {} },
  },
}

/** A schema with no derivable protocol choice: `api` is a plain string, not a union of consts. */
const SCHEMA_WITHOUT_PROTOCOL = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3 },
    3: { type: 'object', meta: {}, dict: { api: 4, baseURL: 4 } },
    4: { type: 'string', meta: {} },
  },
}

/** What one test wants the seams to answer, and what it recorded. */
interface Fixture {
  descriptor?: SettingsDescriptorRead
  /**
   * Descriptors `describe()` hands back in order, the last repeating — so a
   * test can model a namespace whose revision moves after a rejected save.
   */
  descriptors?: readonly SettingsDescriptorRead[]
  directory?: readonly { provider: string }[] | (() => readonly { provider: string }[])
  liveProviders?: readonly { id: string }[]
  setCredential?: (ref: string, value: string) => Promise<void>
  discoverModels?: (ns: string, request: LlmModelDiscoveryRequestRead) => Promise<{ id: string }[]>
  /** Errors `mutate` throws, by call index; an index with no entry succeeds. */
  mutateRejections?: readonly unknown[]
}

/**
 * Build seams that answer exactly what a test asked for, recording every call
 * and its relative order.
 * @param fixture - the answers.
 * @returns the seams and the calls they recorded.
 */
function seamsFor(fixture: Fixture): {
  seams: ConnectSeams
  mutateCalls: { ns: string; ops: readonly unknown[]; revision: number | undefined }[]
  credentialCalls: { ref: string; value: string }[]
  discoverCalls: { ns: string; request: LlmModelDiscoveryRequestRead }[]
  order: string[]
} {
  const mutateCalls: { ns: string; ops: readonly unknown[]; revision: number | undefined }[] = []
  const credentialCalls: { ref: string; value: string }[] = []
  const discoverCalls: { ns: string; request: LlmModelDiscoveryRequestRead }[] = []
  const order: string[] = []
  let describeCount = 0
  const settings: ConnectSettings = {
    describe: () => {
      const listed = fixture.descriptors
      if (listed !== undefined) {
        const descriptor = listed[Math.min(describeCount, listed.length - 1)]
        describeCount += 1
        return descriptor === undefined ? [] : [descriptor]
      }
      return fixture.descriptor === undefined ? [] : [fixture.descriptor]
    },
    mutate: async (ns, ops, revision) => {
      order.push('settings')
      const rejection = fixture.mutateRejections?.[mutateCalls.length]
      mutateCalls.push({ ns, ops, revision })
      if (rejection !== undefined) throw rejection
    },
  }
  const credentials: ConnectCredentials = {
    describe: async () => ({ configured: false, writable: true }),
    set: async (ref, value) => {
      order.push('credentials')
      credentialCalls.push({ ref, value })
      await (fixture.setCredential?.(ref, value) ?? Promise.resolve())
    },
    unset: async () => {},
    describeRecord: async () => ({ configured: false, writable: true }),
    deleteRecord: async () => {},
  }
  const llm: ConnectLlm = {
    listProviders: () => (fixture.liveProviders ?? []).map(entry => ({ id: entry.id, name: entry.id })),
    listConfigurableProviders: () => {
      const directory = typeof fixture.directory === 'function' ? fixture.directory() : fixture.directory
      return (directory ?? []).map(entry => ({
        provider: entry.provider,
        displayName: entry.provider,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', entry.provider],
      }))
    },
    listModels: async () => [],
    discoverModels: async (ns, request) => {
      discoverCalls.push({ ns, request })
      return fixture.discoverModels?.(ns, request) ?? []
    },
  }
  return {
    seams: { llm, settings, credentials, authorization: undefined },
    mutateCalls,
    credentialCalls,
    discoverCalls,
    order,
  }
}

const TARGET: ConnectNewRouteTarget = { settingsNs: 'llm-pi-ai', parentPath: ['providers'], revision: 9 }

describe('declaring a brand-new route', () => {
  it('writes settings before a credential, and reports where the key landed', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama') // Provider ID
    await press(ENTER)
    await type('http://127.0.0.1:11434/v1') // Endpoint
    await press(ENTER)
    await press(ENTER) // Protocol, the only choice, at the cursor
    await type('  sk-secret-value  ') // API key, with harmless surrounding whitespace
    await press(ENTER)
    await press(DOWN, ENTER) // '+ Add model manually'
    await type('llama3') // model id
    await press(ENTER)
    await press(UP, ENTER) // 'Done' is now the last item
    // Review menu: display-name(0), base-url(1), protocol(2), api-key(3), models(4), create(5), cancel(6).
    await press(UP, UP, ENTER) // 'Create provider'
    const result = await outcome
    expect(result).toEqual({ kind: 'done', message: 'local-llama: route created, key stored behind LOCAL_LLAMA_API_KEY' })
    expect(fixture.order).toEqual(['settings', 'credentials'])
    expect(fixture.mutateCalls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'local-llama'],
        value: {
          baseURL: 'http://127.0.0.1:11434/v1',
          api: 'openai-completions',
          apiKeyEnv: 'LOCAL_LLAMA_API_KEY',
          models: [{ id: 'llama3' }],
        },
      }],
      revision: 9,
    }])
    // Normalized — the surrounding whitespace never reaches the seam.
    expect(fixture.credentialCalls).toEqual([{ ref: 'LOCAL_LLAMA_API_KEY', value: 'sk-secret-value' }])
  })

  it('never lets the typed key reach the reported outcome, even when storing it fails', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 },
      setCredential: async () => { throw new Error('vault unreachable') },
    })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://127.0.0.1:11434/v1')
    await press(ENTER)
    await press(ENTER) // protocol
    await type('a-very-secret-key')
    await press(ENTER)
    await press(DOWN, ENTER) // add model manually
    await type('llama3')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER) // done
    await press(UP, UP, ENTER) // create
    const result = await outcome
    // The route was written — a visible, recoverable route naming an unset
    // reference beats storing a secret nothing points at.
    expect(fixture.mutateCalls).toHaveLength(1)
    expect(result?.kind).toBe('done')
    expect(result?.message).not.toContain('a-very-secret-key')
    expect(result?.message).toContain('could not be stored')
  })

  it('refuses a duplicate id and lets the reader correct it', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 },
      directory: [{ provider: 'openai' }],
    })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('openai')
    await press(ENTER)
    // Refused; the id prompt is still on screen, corrected and resubmitted.
    await type('openai-mirror')
    await press(ENTER)
    await type('http://example.test/v1')
    await press(ENTER)
    await press(ENTER) // protocol
    await press(ENTER) // no key
    await press(DOWN, ENTER) // add model manually
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER) // done
    await press(UP, UP, ENTER) // create
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'openai-mirror'],
      value: { baseURL: 'http://example.test/v1', api: 'openai-completions', models: [{ id: 'm' }] },
    }])
  })

  it('refuses an id already owned by a live route the directory does not list', async () => {
    // A composition-declared route, say — it publishes no configurable-provider
    // entry, but its id is still a real registration at the LLM seam, and a
    // custom route must not be allowed to collide with it.
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 },
      liveProviders: [{ id: 'deepseek-official' }],
    })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('deepseek-official')
    await press(ENTER)
    // Refused; corrected and resubmitted.
    await type('deepseek-mirror')
    await press(ENTER)
    await type('http://example.test/v1')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(DOWN, ENTER)
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER)
    await press(UP, UP, ENTER)
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops[0]).toMatchObject({ path: ['providers', 'deepseek-mirror'] })
  })

  it('keeps the reader inside the review when Create is chosen with nothing selected', async () => {
    // The wizard already has a proper draft/review screen at this point;
    // punishing the reader by closing the whole thing over a missing model
    // would be needlessly harsh. A notice explains it, and the draft survives
    // so the reader can open Models and correct it without starting over.
    const { ctx, type, press } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://127.0.0.1:11434/v1')
    await press(ENTER)
    await press(ENTER) // protocol
    await press(ENTER) // no key
    await press(UP, ENTER) // 'Done' immediately: fetch(0), add(1), done(2)
    await press(UP, UP, ENTER) // 'Create provider', with nothing selected
    // Refused in place: nothing written, and the wizard is still running.
    expect(fixture.mutateCalls).toEqual([])
    // Correct it: open Models and add one by hand.
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // 'Models', index 4 of 7
    await press(DOWN, ENTER) // '+ Add model manually'
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER) // 'Done', now 4 items
    await press(UP, UP, ENTER) // 'Create provider' again, this time with a model
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls).toHaveLength(1)
    expect(fixture.mutateCalls[0]?.ops[0]).toMatchObject({ value: { models: [{ id: 'm' }] } })
  })

  it('never asks for an API key, and never writes one, when the schema names no credential-reference field', async () => {
    // A route with nowhere to store a key is still legitimate — an
    // unauthenticated local server has to stay possible. The wizard has to
    // skip the question entirely rather than ask it and drop the answer.
    const { ctx, type, press } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: SCHEMA_WITHOUT_CREDENTIAL_REF, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://127.0.0.1:11434/v1')
    await press(ENTER)
    await press(ENTER) // protocol — the very next prompt is Models, not an API key
    await press(DOWN, ENTER) // '+ Add model manually'
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER) // 'Done'
    // Review menu has no API-key row: display-name(0), base-url(1),
    // protocol(2), models(3), create(4), cancel(5).
    await press(UP, UP, ENTER) // 'Create provider'
    const result = await outcome
    expect(result).toEqual({ kind: 'done', message: 'local-llama: route created' })
    expect(fixture.mutateCalls[0]?.ops[0]).toEqual({
      op: 'set',
      path: ['providers', 'local-llama'],
      value: { baseURL: 'http://127.0.0.1:11434/v1', api: 'openai-completions', models: [{ id: 'm' }] },
    })
    expect(fixture.credentialCalls).toEqual([])
  })

  it('fetches candidates through ctx.llm.discoverModels, never a network call of its own', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 },
      discoverModels: async () => [{ id: 'llama3' }, { id: 'llama3-instruct' }],
    })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://127.0.0.1:11434/v1')
    await press(ENTER)
    await press(ENTER)
    await type('sk-one-shot')
    await press(ENTER)
    await press(ENTER) // 'Fetch available models', the first item
    // Both candidates now listed, unchecked. Selecting one opens a small
    // toggle/edit/back menu of its own; 'toggle' is the first choice.
    await press(DOWN, DOWN, ENTER)
    await press(ENTER)
    await press(UP, ENTER) // back at the models menu; 'Done' is now the last item
    await press(UP, UP, ENTER) // 'Create provider'
    const result = await outcome
    expect(fixture.discoverCalls).toEqual([{
      ns: 'llm-pi-ai',
      request: { apiKey: 'sk-one-shot', baseURL: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
    }])
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'local-llama'],
      value: expect.objectContaining({ models: [{ id: 'llama3' }] }),
    }])
  })

  it('fails closed, writing nothing, when no protocol choice can be derived', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: SCHEMA_WITHOUT_PROTOCOL, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    const result = await outcome
    expect(result?.kind).toBe('failed')
    expect(result?.message).toContain('llm-pi-ai')
    expect(fixture.mutateCalls).toEqual([])
  })

  it('writes with the revision read when the wizard opened, not an older one the row was shown from', async () => {
    const { ctx, type, press } = slots()
    // The create row's target carries whatever revision the catalog last read;
    // the descriptor here is deliberately fresher, simulating time spent
    // browsing /connect between that read and opening the wizard.
    const stale: ConnectNewRouteTarget = { ...TARGET, revision: 1 }
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 42 } })
    const outcome = runCreateRoute(ctx, fixture.seams, stale)
    await type('local-llama')
    await press(ENTER)
    await type('http://example.test/v1')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER) // no key
    await press(DOWN, ENTER)
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER)
    await press(UP, UP, ENTER)
    await outcome
    expect(fixture.mutateCalls[0]?.revision).toBe(42)
  })

  it('leaves the final review with zero writes when the reader cancels', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://example.test/v1')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER) // no key
    await press(DOWN, ENTER)
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER)
    // Review menu: cancel is the last item.
    await press(UP, ENTER)
    const result = await outcome
    expect(result).toBeUndefined()
    expect(fixture.mutateCalls).toEqual([])
    expect(fixture.credentialCalls).toEqual([])
  })

  it('shows the final review as a confirmation, never the key material', async () => {
    const { ctx, type, press, text } = slots()
    const fixture = seamsFor({ descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA, value: {}, revision: 9 } })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('local-llama')
    await press(ENTER)
    await type('http://example.test/v1')
    await press(ENTER)
    await press(ENTER)
    await type('sk-should-never-be-shown')
    await press(ENTER)
    await press(DOWN, ENTER)
    await type('m')
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(ENTER)
    await press(UP, ENTER)
    // A choice's description is drawn only for the row currently selected;
    // move onto 'api-key' (index 3) to see its own.
    await press(DOWN, DOWN, DOWN)
    const shown = text()
    expect(shown).toContain('configured')
    expect(shown).not.toContain('sk-should-never-be-shown')
    await press(UP, UP, UP, UP, ENTER) // back to 'cancel', writing nothing
    await outcome
  })
})

/** One existing, hand-declared provider row, whose profile explicitly names one model. */
function declaredRow(overrides: Partial<ConnectProviderRow> = {}): ConnectProviderRow {
  return {
    kind: 'provider',
    provider: 'local-llama',
    displayName: 'Local Llama',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'local-llama'],
    declared: true,
    state: 'active',
    models: 1,
    credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
    userOwned: true,
    revision: 9,
    ...overrides,
  }
}

/** A descriptor for `declaredRow()`, at whatever profile shape a test wants. */
function descriptorFor(profile: Record<string, unknown>): SettingsDescriptorRead {
  return {
    ns: 'llm-pi-ai',
    schema: PI_AI_SCHEMA,
    value: { providers: { 'local-llama': profile } },
    revision: 9,
  }
}

/** The same, against a schema that still describes `headers`. */
function headerDescriptorFor(profile: Record<string, unknown>): SettingsDescriptorRead {
  return {
    ns: 'llm-pi-ai',
    schema: PI_AI_SCHEMA_WITH_HEADERS,
    value: { providers: { 'local-llama': profile } },
    revision: 9,
  }
}

describe('editing an existing route', () => {
  it('changes the base URL with a narrow op, leaving everything else untouched', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://old/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    // Menu: base-url(0), protocol(1), display-name(2), models(3), reset-models(4), save(5), cancel(6).
    await press(ENTER) // base-url
    await press(CTRL_U) // clear the prefilled value
    await type('http://new/v1')
    await press(ENTER)
    await press(UP, UP, ENTER) // save
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', 'local-llama', 'baseURL'], value: 'http://new/v1' }],
      revision: 9,
    }])
  })

  it('resets the model catalog by unsetting the field, never by writing an empty array', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // reset-models, index 4 while it is still offered
    // The menu no longer offers reset-models once inherited; save is now index 4.
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{ op: 'unset', path: ['providers', 'local-llama', 'models'] }],
      revision: 9,
    }])
  })

  it('reports nothing changed, and writes nothing, when the reader saves without editing', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(UP, UP, ENTER) // save, index 5 of 7
    const result = await outcome
    expect(result).toEqual({ kind: 'done', message: 'local-llama: nothing changed' })
    expect(fixture.mutateCalls).toEqual([])
  })

  it('discards a draft when the reader cancels, writing nothing', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(ENTER) // base-url
    await press(CTRL_U) // clear the prefilled value
    await type('http://changed/v1')
    await press(ENTER)
    await press(UP, ENTER) // cancel, the last item
    const result = await outcome
    expect(result).toBeUndefined()
    expect(fixture.mutateCalls).toEqual([])
  })

  it('resolves a stored credential internally by provider, never sending an apiKey', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // 'models', index 3
    await press(ENTER) // 'Fetch available models', the first item
    await press(UP, ENTER) // back out: 'Done'
    await press(UP, ENTER) // 'cancel', discarding
    await outcome
    expect(fixture.discoverCalls).toEqual([{
      ns: 'llm-pi-ai',
      request: { provider: 'local-llama', baseURL: 'http://x/v1', api: 'openai-completions' },
    }])
  })

  it('only offers protocol and display-name edits for a declared route', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const catalogRow = declaredRow({ declared: false })
    const outcome = runRouteEditor(ctx, fixture.seams, catalogRow)
    // Menu is now: base-url(0), models(1), reset-models(2), save(3), cancel(4).
    await press(UP, ENTER) // cancel, the last item
    const result = await outcome
    expect(result).toBeUndefined()
    expect(fixture.mutateCalls).toEqual([])
  })

  describe('opening the Models submenu without an actual change', () => {
    // The regression this whole group guards: a route with no `models`
    // override inherits the owning adapter's catalog. Entering the submenu
    // and leaving without adopting anything must not turn that absence into a
    // stored `models: []` — an explicitly empty catalog is a different, and
    // materially worse, Harness state than "unset".
    function inheritedFixture(discoverModels?: Fixture['discoverModels']) {
      return seamsFor({
        descriptor: descriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions' }), // no `models` key at all
        ...discoverModels === undefined ? {} : { discoverModels },
      })
    }

    it('leaves an inherited catalog inherited when the submenu is opened and immediately left', async () => {
      const { ctx, press } = slots()
      const fixture = inheritedFixture()
      const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
      // Menu without reset-models (still inherited): base-url(0), protocol(1),
      // display-name(2), models(3), save(4), cancel(5).
      await press(DOWN, DOWN, DOWN, ENTER) // models
      await press(UP, ENTER) // 'Done' immediately: fetch(0), add(1), done(2) -> up lands on done
      await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
      const result = await outcome
      expect(result).toEqual({ kind: 'done', message: 'local-llama: nothing changed' })
      expect(fixture.mutateCalls).toEqual([])
    })

    it('leaves an inherited catalog inherited when a fetch finds candidates nobody adopts', async () => {
      const { ctx, press } = slots()
      const fixture = inheritedFixture(async () => [{ id: 'discovered' }])
      const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
      await press(DOWN, DOWN, DOWN, ENTER) // models
      await press(ENTER) // fetch, the first item
      // One new, unchecked candidate now listed: fetch(0), add(1), discovered(2), done(3).
      await press(UP, ENTER) // 'Done' without adopting it
      await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
      const result = await outcome
      expect(result).toEqual({ kind: 'done', message: 'local-llama: nothing changed' })
      expect(fixture.mutateCalls).toEqual([])
    })

    it('writes an override, never a models array, once a catalog model is adopted', async () => {
      const { ctx, type, press } = slots()
      const fixture = inheritedFixture()
      const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
      await press(DOWN, DOWN, DOWN, ENTER) // models
      await press(DOWN, ENTER) // '+ Add model manually', the second item
      await type('m1')
      await press(ENTER)
      // Now three items: fetch(0), add(1), m1(2), done(3).
      await press(UP, ENTER) // Done
      // A real change means reset-models now shows: base-url(0), protocol(1),
      // display-name(2), models(3), reset-models(4), save(5), cancel(6).
      await press(UP, UP, ENTER) // save
      const result = await outcome
      expect(result?.kind).toBe('done')
      expect(fixture.mutateCalls).toEqual([{
        ns: 'llm-pi-ai',
        ops: [{ op: 'set', path: ['providers', 'local-llama', 'modelOverrides', 'm1'], value: {} }],
        revision: 9,
      }])
    })
  })
})

describe('curating a route’s request headers', () => {
  // Menu with the field offered: base-url(0), protocol(1), display-name(2),
  // headers(3), models(4), reset-models(5), save(6), cancel(7).
  const HEADERS_ROW: Key[] = [DOWN, DOWN, DOWN, ENTER]

  it('adds one and writes the whole map under the route, touching nothing else', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: headerDescriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(...HEADERS_ROW)
    await press(ENTER) // '+ Add header'
    await type('X-Tenant-Id')
    await press(ENTER)
    await type('acme')
    await press(ENTER)
    // Submenu now: add(0), X-Tenant-Id(1), Done(2).
    await press(UP, ENTER) // Done
    await press(UP, UP, ENTER) // save
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'local-llama', 'headers'],
        value: { 'X-Tenant-Id': 'acme' },
      }],
      revision: 9,
    }])
  })

  it('unsets the field rather than writing an empty map when the last one is removed', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: headerDescriptorFor({
        baseURL: 'http://x/v1',
        api: 'openai-completions',
        headers: { 'X-A': '1' },
        models: [{ id: 'a' }],
      }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(...HEADERS_ROW)
    await press(DOWN, ENTER) // the 'X-A' row
    await press(DOWN, ENTER) // 'Remove header'
    // Submenu now: add(0), Done(1).
    await press(UP, ENTER) // Done
    await press(UP, UP, ENTER) // save
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{ op: 'unset', path: ['providers', 'local-llama', 'headers'] }],
      revision: 9,
    }])
  })

  it('shows names on the route menu and values only one level in', async () => {
    const { ctx, press, text } = slots()
    const fixture = seamsFor({
      descriptor: headerDescriptorFor({
        baseURL: 'http://x/v1',
        api: 'openai-completions',
        headers: { Authorization: 'Bearer super-secret' },
        models: [{ id: 'a' }],
      }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    // A bearer token is exactly what a header value can be, and nothing in the
    // settings seam marks it as one: `headers` has no `credential-ref` role, so
    // `redactSecrets` leaves it whole. The route menu is passed through on the
    // way to everything else, so the value must not be sitting on it — not even
    // with the row under the cursor, which is the only state that renders its
    // description at all.
    await press(DOWN, DOWN, DOWN)
    const routeMenu = text()
    expect(routeMenu).toContain('Request headers')
    expect(routeMenu).toContain('Authorization')
    expect(routeMenu).not.toContain('Bearer super-secret')
    await press(ENTER)
    expect(text()).not.toContain('Bearer super-secret')
    // Shown only once the reader has opened this submenu AND moved onto that
    // header's row — asking to see it. An editor that hid the value it is about
    // to write could not be used to repair a route that does not work.
    await press(DOWN)
    expect(text()).toContain('Bearer super-secret')
    await press(DOWN, ENTER) // Done
    await press(UP, UP, ENTER) // save
    const result = await outcome
    expect(result).toEqual({ kind: 'done', message: 'local-llama: nothing changed' })
    expect(fixture.mutateCalls).toEqual([])
  })

  it('opens a header whose name collides with one of the menu’s own sentinels', async () => {
    const { ctx, press, text } = slots()
    // `__done` is a legal HTTP field name. Rows keyed by name rather than by
    // position would make selecting this one close the menu instead of opening
    // it, and the header would be uneditable from the terminal.
    const fixture = seamsFor({
      descriptor: headerDescriptorFor({
        baseURL: 'http://x/v1',
        api: 'openai-completions',
        headers: { __done: 'not-a-sentinel' },
        models: [{ id: 'a' }],
      }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(...HEADERS_ROW)
    await press(DOWN, ENTER) // the '__done' row, not the 'Done' row
    expect(text()).toContain('Remove header')
    await press(DOWN, ENTER) // 'Remove header'
    await press(UP, ENTER) // Done, now the only row after '+ Add header'
    await press(UP, UP, ENTER) // save
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{ op: 'unset', path: ['providers', 'local-llama', 'headers'] }],
      revision: 9,
    }])
  })

  it('offers nothing, and rewrites nothing, when the schema no longer describes the field', async () => {
    const { ctx, press, text } = slots()
    // A stored map the schema stopped describing: this editor must neither
    // render it nor write it back.
    const fixture = seamsFor({
      descriptor: descriptorFor({
        baseURL: 'http://x/v1',
        api: 'openai-completions',
        headers: { 'X-A': '1' },
        models: [{ id: 'a' }],
      }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    expect(text()).not.toContain('Request headers')
    await press(UP, UP, ENTER) // save, index 5 of the 7-row menu
    const result = await outcome
    expect(result).toEqual({ kind: 'done', message: 'local-llama: nothing changed' })
    expect(fixture.mutateCalls).toEqual([])
  })

  it('says an unsaved header edit cannot reach a fetch, and still sends only the discovery request’s own fields', async () => {
    const { ctx, type, press, text } = slots()
    const fixture = seamsFor({
      descriptor: headerDescriptorFor({ baseURL: 'http://x/v1', api: 'openai-completions', models: [{ id: 'a' }] }),
      discoverModels: async () => [],
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(...HEADERS_ROW)
    await press(ENTER) // '+ Add header'
    await type('X-Tenant-Id')
    await press(ENTER)
    await type('acme')
    await press(ENTER)
    await press(UP, ENTER) // Done
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // models(4)
    expect(text()).toContain('unsaved header edits are not sent')
    await press(ENTER) // 'Fetch available models'
    // The request carries what `LlmModelDiscoveryRequest` names and nothing
    // else: headers reach the endpoint through the adapter's own resolution of
    // the STORED profile, never smuggled into the draft's request by this
    // frontend.
    expect(fixture.discoverCalls).toEqual([{
      ns: 'llm-pi-ai',
      request: { provider: 'local-llama', baseURL: 'http://x/v1', api: 'openai-completions' },
    }])
    await press(UP, ENTER) // Done, out of the models submenu
    await press(UP, ENTER) // cancel, index 7
    expect(await outcome).toBeUndefined()
    expect(fixture.mutateCalls).toEqual([])
  })

  describe('a stored map hand-edited to carry two case spellings of one name', () => {
    // `X-Test` and `x-test` are one HTTP header, but a hand-edited
    // `settings.yaml` can still store both as distinct object keys, and
    // `entriesFromRawHeaders` renders each as its own row (see the `__done`
    // regression above: rows are keyed by position precisely so a case this
    // odd is still reachable). The row's own index must be what edit and
    // remove act on — a case-insensitive name lookup would find the WRONG row,
    // or both.
    function duplicateSpellingFixture(): ReturnType<typeof seamsFor> {
      return seamsFor({
        descriptor: headerDescriptorFor({
          baseURL: 'http://x/v1',
          api: 'openai-completions',
          headers: { 'X-Test': 'one', 'x-test': 'two' },
          models: [{ id: 'a' }],
        }),
      })
    }

    it('edits the second row without touching the first', async () => {
      const { ctx, type, press } = slots()
      const fixture = duplicateSpellingFixture()
      const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
      await press(...HEADERS_ROW)
      // Submenu: add(0), X-Test(1), x-test(2), Done(3). Open the second row.
      await press(DOWN, DOWN, ENTER)
      await press(ENTER) // 'Edit value', at the cursor
      await press(CTRL_U) // clear the prefilled 'two'
      await type('TWO-NEW')
      await press(ENTER)
      await press(UP, ENTER) // Done
      await press(UP, UP, ENTER) // save
      const result = await outcome
      expect(result?.kind).toBe('done')
      // `X-Test` is unchanged; only the row the reader actually opened moved.
      // A name-based `upsertHeader('x-test', …)` would instead have matched
      // `X-Test` first and left this exact bug in place.
      expect(fixture.mutateCalls).toEqual([{
        ns: 'llm-pi-ai',
        ops: [{
          op: 'set',
          path: ['providers', 'local-llama', 'headers'],
          value: { 'X-Test': 'one', 'x-test': 'TWO-NEW' },
        }],
        revision: 9,
      }])
    })

    it('removes one row and leaves the other in the written map', async () => {
      const { ctx, press } = slots()
      const fixture = duplicateSpellingFixture()
      const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
      await press(...HEADERS_ROW)
      // Submenu: add(0), X-Test(1), x-test(2), Done(3). Open the second row.
      await press(DOWN, DOWN, ENTER)
      await press(DOWN, ENTER) // 'Remove header'
      // Submenu now: add(0), X-Test(1), Done(2).
      await press(UP, ENTER) // Done
      await press(UP, UP, ENTER) // save
      const result = await outcome
      expect(result?.kind).toBe('done')
      // A name-based `removeHeader('x-test', …)` folds both keys to the same
      // name and would have dropped `X-Test` too.
      expect(fixture.mutateCalls).toEqual([{
        ns: 'llm-pi-ai',
        ops: [{
          op: 'set',
          path: ['providers', 'local-llama', 'headers'],
          value: { 'X-Test': 'one' },
        }],
        revision: 9,
      }])
    })
  })
})

describe('declaring a route that needs request headers', () => {
  it('writes them with the profile, and says a fetch cannot use them yet', async () => {
    const { ctx, type, press, text } = slots()
    const fixture = seamsFor({
      descriptor: { ns: 'llm-pi-ai', schema: PI_AI_SCHEMA_WITH_HEADERS, value: {}, revision: 9 },
      discoverModels: async () => [],
    })
    const outcome = runCreateRoute(ctx, fixture.seams, TARGET)
    await type('gateway')
    await press(ENTER) // Provider ID
    await type('https://gw.example/v1')
    await press(ENTER) // Endpoint
    await press(ENTER) // Protocol, the only choice
    await press(ENTER) // API key, left blank
    await press(DOWN, ENTER) // '+ Add model manually'
    await type('gpt-oss')
    await press(ENTER)
    // One press per overlay: the continuation that pushes the models menu has
    // not run when the key is delivered.
    await press(UP, ENTER) // Done, out of the models submenu
    // Review: display-name(0), base-url(1), protocol(2), api-key(3),
    // headers(4), models(5), create(6), cancel(7).
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // headers
    await press(ENTER) // '+ Add header'
    await type('X-Tenant-Id')
    await press(ENTER)
    await type('acme')
    await press(ENTER)
    await press(UP, ENTER) // Done
    // Back on the review menu; the fetch cannot carry them until the route is
    // written, and says so rather than looking like the endpoint refused.
    await press(DOWN, DOWN, DOWN, DOWN, DOWN, ENTER) // models
    expect(text()).toContain('cannot send this route’s request headers until the route exists')
    await press(UP, ENTER) // Done
    await press(UP, UP, ENTER) // 'Create provider'
    const result = await outcome
    expect(result).toEqual({ kind: 'done', message: 'gateway: route created' })
    expect(fixture.mutateCalls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'gateway'],
        value: {
          baseURL: 'https://gw.example/v1',
          api: 'openai-completions',
          headers: { 'X-Tenant-Id': 'acme' },
          models: [{ id: 'gpt-oss' }],
        },
      }],
      revision: 9,
    }])
  })
})

/**
 * The `llm-pi-ai` model shapes this pass curates: the real `models` array, a
 * `modelOverrides` dict of the same entry object, and the `input`/
 * `reasoningEfforts` field shapes `z.union(MODALITIES)` and
 * `z.union([z.const(false), reasoningEfforts])` serialize to.
 */
const CAPABILITY_SCHEMA = {
  uid: 1,
  refs: {
    1: { type: 'object', meta: {}, dict: { providers: 2 } },
    2: { type: 'dict', meta: {}, inner: 3, sKey: 30 },
    3: { type: 'object', meta: {}, dict: { api: 4, apiKeyEnv: 7, baseURL: 7, displayName: 7, models: 40, modelOverrides: 41 } },
    4: { type: 'union', meta: {}, list: [5] },
    5: { type: 'const', meta: {}, value: 'openai-completions' },
    7: { type: 'string', meta: {} },
    40: { type: 'array', meta: { default: [] }, inner: 42 },
    41: { type: 'dict', meta: { default: {} }, inner: 42, sKey: 7 },
    42: {
      type: 'object',
      meta: { default: {} },
      dict: { id: 6, name: 7, contextWindow: 11, maxTokens: 11, input: 12, reasoningEfforts: 14, compat: 43 },
    },
    43: { type: 'object', meta: { default: {} }, dict: { supportsStore: 44 } },
    44: { type: 'boolean', meta: {} },
    6: { type: 'string', meta: { required: true } },
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
    23: { type: 'const', meta: { required: true }, value: 'low' },
    21: { type: 'union', meta: {}, list: [24, 25] },
    24: { type: 'string', meta: {} },
    25: { type: 'const', meta: {}, value: null },
    30: { type: 'string', meta: {} },
  },
}

/** A capability-aware descriptor; `user` carries what the user layer alone wrote. */
function capabilityDescriptor(
  profile: Record<string, unknown>,
  user?: Record<string, unknown>,
  revision = 9,
): SettingsDescriptorRead {
  return {
    ns: 'llm-pi-ai',
    schema: CAPABILITY_SCHEMA,
    value: { providers: { 'local-llama': profile } },
    ...user === undefined ? {} : { user: { providers: { 'local-llama': user } } },
    revision,
  }
}

describe('editing a model capability on an inherited catalog route', () => {
  const OVERRIDE = { compat: { supportsStore: false } }

  it('writes only the edited field path of one override, leaving an unrendered sibling and models alone', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: capabilityDescriptor(
        { baseURL: 'http://x/v1', api: 'openai-completions', modelOverrides: { gpt: OVERRIDE } },
        { modelOverrides: { gpt: OVERRIDE } },
      ),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    // Route menu: base-url(0), protocol(1), display-name(2), models(3), save(4), cancel(5).
    await press(DOWN, DOWN, DOWN, ENTER) // models
    // Models: fetch(0), add(1), gpt(2), done(3).
    await press(DOWN, DOWN, ENTER) // gpt
    // Row: remove-override(0), edit(1), back(2).
    await press(DOWN, ENTER) // edit
    // Fields: name(0), context(1), max(2), advanced(3), back(4).
    await press(DOWN, DOWN, DOWN, ENTER) // advanced
    // Advanced: input(0), reasoning(1), back(2).
    await press(ENTER) // input
    // Modalities: text(0), image(1), inherit(2), done(3).
    await press(ENTER) // toggle text
    await press(DOWN, ENTER) // toggle image
    await press(DOWN, DOWN, DOWN, ENTER) // done
    await press(DOWN, DOWN, ENTER) // back out of advanced
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls).toEqual([{
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'local-llama', 'modelOverrides', 'gpt', 'input'],
        value: ['text', 'image'],
      }],
      revision: 9,
    }])
  })

  it('declares an explicit disabled reasoning capability', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: capabilityDescriptor(
        { baseURL: 'http://x/v1', api: 'openai-completions', modelOverrides: { gpt: OVERRIDE } },
        { modelOverrides: { gpt: OVERRIDE } },
      ),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    await press(DOWN, ENTER) // edit
    await press(DOWN, DOWN, DOWN, ENTER) // advanced
    await press(DOWN, ENTER) // reasoning
    // Reasoning: inherit(0), disabled(1), mapping(2), back(3).
    await press(DOWN, ENTER) // disabled
    await press(DOWN, DOWN, ENTER) // back out of advanced
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'local-llama', 'modelOverrides', 'gpt', 'reasoningEfforts'],
      value: false,
    }])
  })

  it('builds a custom level mapping, a level other than off sending no wire value', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: capabilityDescriptor(
        { baseURL: 'http://x/v1', api: 'openai-completions', modelOverrides: { gpt: OVERRIDE } },
        { modelOverrides: { gpt: OVERRIDE } },
      ),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    await press(DOWN, ENTER) // edit
    await press(DOWN, DOWN, DOWN, ENTER) // advanced
    await press(DOWN, ENTER) // reasoning
    await press(DOWN, DOWN, ENTER) // mapping
    // Mapping: off(0), low(1), done(2), back(3).
    await press(ENTER) // off
    // off actions: not-offered(0), send-nothing(1), wire(2), back(3).
    await press(DOWN, ENTER) // send nothing
    await press(DOWN, ENTER) // low
    // low actions: not-offered(0), send-no-value(1), wire(2), back(3) — the
    // schema's leaf accepts null for every level, not only one named `off`.
    await press(DOWN, DOWN, ENTER) // wire
    await type('low')
    await press(ENTER)
    await press(DOWN, DOWN, ENTER) // done
    await press(DOWN, DOWN, ENTER) // back out of advanced
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'local-llama', 'modelOverrides', 'gpt', 'reasoningEfforts'],
      value: { off: null, low: 'low' },
    }])
  })

  it('keeps a stored override the installed catalog no longer lists, and can remove it exactly', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: capabilityDescriptor(
        { baseURL: 'http://x/v1', api: 'openai-completions', modelOverrides: { stale: { name: 'Gone' } } },
        { modelOverrides: { stale: { name: 'Gone' } } },
      ),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    // Models: fetch(0), add(1), stale(2), done(3) — listed from the user layer
    // even though no catalog reports it.
    await press(DOWN, DOWN, ENTER) // stale
    await press(ENTER) // remove override
    await press(UP, ENTER) // done with models
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'unset',
      path: ['providers', 'local-llama', 'modelOverrides', 'stale'],
    }])
  })

  it('locks an override that lives in the composition base rather than the user layer', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: capabilityDescriptor({ baseURL: 'http://x/v1', api: 'openai-completions', modelOverrides: { gpt: OVERRIDE } }),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    // No user-layer override: only Back is offered.
    await press(ENTER) // back
    await press(UP, ENTER) // done with models
    await press(UP, ENTER) // discard
    expect(await outcome).toBeUndefined()
    expect(fixture.mutateCalls).toEqual([])
  })
})

describe('a rejected save keeps the draft and never retries on its own', () => {
  const CONFLICT = Object.assign(new Error('settings namespace "llm-pi-ai" changed since it was read'), { code: 'SETTINGS_CONFLICT' })

  /** Drive the display-name edit and one Save, leaving the outcome pending. */
  async function editAndSave(
    type: (text: string) => Promise<void>,
    press: (...keys: Key[]) => Promise<void>,
  ): Promise<void> {
    await press(DOWN, DOWN, ENTER) // display name
    await press(CTRL_U)
    await type('Changed')
    await press(ENTER)
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save, index 4 of 6
  }

  it('shows a refusal, keeps the draft, and writes nothing more until a second explicit Save', async () => {
    const { ctx, type, press, text } = slots()
    const fixture = seamsFor({
      descriptor: capabilityDescriptor({ baseURL: 'http://x/v1', api: 'openai-completions' }),
      directory: [{ provider: 'local-llama' }],
      mutateRejections: [new Error('llm-pi-ai: provider "local-llama" model "gpt" has an empty reasoningEfforts')],
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await editAndSave(type, press)
    expect(fixture.mutateCalls).toHaveLength(1)
    expect(text()).toContain('refused the edit')
    await press(UP, ENTER) // discard, the last item
    expect(await outcome).toBeUndefined()
    expect(fixture.mutateCalls).toHaveLength(1)
  })

  it('explains a revision race, refreshes the revision, and applies the same draft on the next Save', async () => {
    const { ctx, type, press, text } = slots()
    const fixture = seamsFor({
      descriptors: [
        capabilityDescriptor({ baseURL: 'http://x/v1', api: 'openai-completions' }, undefined, 9),
        capabilityDescriptor({ baseURL: 'http://x/v1', api: 'openai-completions' }, undefined, 10),
      ],
      directory: [{ provider: 'local-llama' }],
      mutateRejections: [CONFLICT],
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await editAndSave(type, press)
    expect(fixture.mutateCalls).toHaveLength(1)
    expect(text()).toContain('changed elsewhere')
    // The next Save is the reader's, not an automatic retry.
    await press(DOWN, DOWN, DOWN, DOWN, ENTER)
    const result = await outcome
    expect(result?.kind).toBe('done')
    expect(fixture.mutateCalls.map(call => call.revision)).toEqual([9, 10])
    expect(fixture.mutateCalls[1]?.ops).toEqual(fixture.mutateCalls[0]?.ops)
  })

  it('refuses to resurrect a route removed underneath the editor', async () => {
    const { ctx, type, press, text } = slots()
    const fixture = seamsFor({
      descriptor: capabilityDescriptor({ baseURL: 'http://x/v1', api: 'openai-completions' }),
      directory: () => [],
      mutateRejections: [CONFLICT],
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await editAndSave(type, press)
    expect(text()).toContain('removed elsewhere')
    // A second Save is refused too: the profile is not re-created by a path op.
    await press(DOWN, DOWN, DOWN, DOWN, ENTER)
    expect(fixture.mutateCalls).toHaveLength(1)
    expect(text()).toContain('no longer configured')
    await press(UP, ENTER) // discard
    expect(await outcome).toBeUndefined()
    expect(fixture.mutateCalls).toHaveLength(1)
  })
})

/** `CAPABILITY_SCHEMA` with the reasoning dict's value leaf (node 21) replaced. */
function capabilitySchemaWithWire(wire: unknown): unknown {
  const schema = structuredClone(CAPABILITY_SCHEMA) as { uid: number; refs: Record<string, unknown> }
  schema.refs['21'] = wire
  return schema
}

/** `CAPABILITY_SCHEMA` with the reasoning level vocabulary (nodes 22/23) replaced. */
function capabilitySchemaWithLevels(first: string, second: string): unknown {
  const schema = structuredClone(CAPABILITY_SCHEMA) as { uid: number; refs: Record<string, unknown> }
  schema.refs['22'] = { type: 'const', meta: { required: true }, value: first }
  schema.refs['23'] = { type: 'const', meta: { required: true }, value: second }
  return schema
}

/**
 * `CAPABILITY_SCHEMA` with no `false` branch and an unrenderable value leaf:
 * the only reasoning states left are ones this form cannot express.
 */
function capabilitySchemaUnrenderableOnly(): unknown {
  const schema = capabilitySchemaWithWire({ type: 'object', meta: {}, dict: {} }) as {
    uid: number
    refs: Record<string, unknown>
  }
  schema.refs['14'] = 18 // the bare dict, without `const(false)`
  return schema
}

/** A descriptor over an arbitrary schema fixture. */
function descriptorWithSchema(
  schema: unknown,
  profile: Record<string, unknown>,
  user?: Record<string, unknown>,
): SettingsDescriptorRead {
  return {
    ns: 'llm-pi-ai',
    schema,
    value: { providers: { 'local-llama': profile } },
    ...user === undefined ? {} : { user: { providers: { 'local-llama': user } } },
    revision: 9,
  }
}

/** A structural settings conflict, the way the seam reports a lost revision race. */
const SETTINGS_CONFLICT = Object.assign(
  new Error('settings namespace "llm-pi-ai" changed since it was read'),
  { code: 'SETTINGS_CONFLICT' },
)

describe('schema-derived reasoning leaves', () => {
  const OVERRIDE = { compat: { supportsStore: false } }
  const profile = { baseURL: 'http://x/v1', api: 'openai-completions', modelOverrides: { gpt: OVERRIDE } }
  const user = { modelOverrides: { gpt: OVERRIDE } }

  it('assigns null to a level whose name the frontend has never seen', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorWithSchema(capabilitySchemaWithLevels('tiny', 'huge'), profile, user),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    await press(DOWN, ENTER) // edit
    await press(DOWN, DOWN, DOWN, ENTER) // advanced
    await press(DOWN, ENTER) // reasoning
    await press(DOWN, DOWN, ENTER) // mapping
    await press(ENTER) // tiny
    await press(DOWN, ENTER) // send no wire value
    await press(DOWN, DOWN, ENTER) // done
    await press(DOWN, DOWN, ENTER) // back out of advanced
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    expect((await outcome)?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'local-llama', 'modelOverrides', 'gpt', 'reasoningEfforts'],
      value: { tiny: null },
    }])
  })

  it('offers no null action for a level literally named off when the leaf is string-only', async () => {
    const { ctx, type, press } = slots()
    const fixture = seamsFor({
      descriptor: descriptorWithSchema(capabilitySchemaWithWire({ type: 'string', meta: {} }), profile, user),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    await press(DOWN, ENTER) // edit
    await press(DOWN, DOWN, DOWN, ENTER) // advanced
    await press(DOWN, ENTER) // reasoning
    await press(DOWN, DOWN, ENTER) // mapping
    await press(ENTER) // off
    // A string-only leaf: not-offered(0), wire(1), back(2). A special case on
    // the name `off` would insert a null action and land this on the wrong row.
    await press(DOWN, ENTER) // wire
    await type('sent')
    await press(ENTER)
    await press(DOWN, DOWN, ENTER) // done
    await press(DOWN, DOWN, ENTER) // back out of advanced
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    expect((await outcome)?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'local-llama', 'modelOverrides', 'gpt', 'reasoningEfforts'],
      value: { off: 'sent' },
    }])
  })

  it('keeps the draft when Harness refuses a schema-derived mapping it accepts structurally', async () => {
    const { ctx, press, text } = slots()
    const fixture = seamsFor({
      descriptor: descriptorWithSchema(capabilitySchemaWithLevels('tiny', 'huge'), profile, user),
      directory: [{ provider: 'local-llama' }],
      // The schema allowed `tiny: null`; Harness's own rule does not. The
      // frontend must build it, submit it, and show this refusal — not
      // pre-empt it with a validator of its own.
      mutateRejections: [new Error('llm-pi-ai: provider "local-llama" model "gpt" reasoningEfforts.tiny needs the wire value dispatch should send; only "off" may leave it empty')],
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    await press(DOWN, ENTER) // edit
    await press(DOWN, DOWN, DOWN, ENTER) // advanced
    await press(DOWN, ENTER) // reasoning
    await press(DOWN, DOWN, ENTER) // mapping
    await press(ENTER) // tiny
    await press(DOWN, ENTER) // send no wire value
    await press(DOWN, DOWN, ENTER) // done
    await press(DOWN, DOWN, ENTER) // back out of advanced
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    expect(fixture.mutateCalls).toHaveLength(1)
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'local-llama', 'modelOverrides', 'gpt', 'reasoningEfforts'],
      value: { tiny: null },
    }])
    expect(text()).toContain('refused the edit')
    await press(UP, ENTER) // discard, the last item
    expect(await outcome).toBeUndefined()
    expect(fixture.mutateCalls).toHaveLength(1)
  })

  it('hides the mapping editor when the value leaf is a shape it cannot render', async () => {
    const { ctx, press, text } = slots()
    const fixture = seamsFor({
      descriptor: descriptorWithSchema(
        capabilitySchemaWithWire({ type: 'object', meta: {}, dict: {} }),
        profile,
        user,
      ),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    await press(DOWN, ENTER) // edit
    await press(DOWN, DOWN, DOWN, ENTER) // advanced
    await press(DOWN, ENTER) // reasoning
    expect(text()).toContain('Reasoning capability')
    expect(text()).not.toContain('Custom mapping')
    await press(UP, ENTER) // back out of reasoning, the last item
    await press(UP, ENTER) // back out of advanced
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(UP, ENTER) // discard the route
    expect(await outcome).toBeUndefined()
    expect(fixture.mutateCalls).toEqual([])
  })

  it('offers no reasoning row when neither disable nor a mapping can be expressed', async () => {
    const { ctx, press, text } = slots()
    const fixture = seamsFor({
      descriptor: descriptorWithSchema(capabilitySchemaUnrenderableOnly(), profile, user),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    await press(DOWN, ENTER) // edit
    await press(DOWN, DOWN, DOWN, ENTER) // advanced
    expect(text()).toContain('Input modalities')
    expect(text()).not.toContain('Reasoning capability')
    await press(UP, ENTER) // back out of advanced, the last item
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(UP, ENTER) // discard the route
    expect(await outcome).toBeUndefined()
    expect(fixture.mutateCalls).toEqual([])
  })
})

describe('conflict-safe override writes', () => {
  it('reapplies only the edited field after a conflict, leaving a concurrently changed sibling', async () => {
    const { ctx, press, text } = slots()
    const at = (supportsStore: boolean, revision: number): SettingsDescriptorRead => capabilityDescriptor(
      { baseURL: 'http://x/v1', api: 'openai-completions', modelOverrides: { gpt: { compat: { supportsStore } } } },
      { modelOverrides: { gpt: { compat: { supportsStore } } } },
      revision,
    )
    const fixture = seamsFor({
      descriptors: [at(false, 9), at(true, 10)],
      directory: [{ provider: 'local-llama' }],
      mutateRejections: [SETTINGS_CONFLICT],
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    await press(DOWN, ENTER) // edit
    await press(DOWN, DOWN, DOWN, ENTER) // advanced
    await press(ENTER) // input
    await press(ENTER) // toggle text
    await press(DOWN, DOWN, DOWN, ENTER) // done
    await press(DOWN, DOWN, ENTER) // back out of advanced
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    expect(fixture.mutateCalls).toHaveLength(1)
    expect(text()).toContain('changed elsewhere')
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // the reader's second Save
    expect((await outcome)?.kind).toBe('done')
    expect(fixture.mutateCalls).toHaveLength(2)
    expect(fixture.mutateCalls[1]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'local-llama', 'modelOverrides', 'gpt', 'input'],
      value: ['text'],
    }])
    expect(JSON.stringify(fixture.mutateCalls[1]?.ops)).not.toContain('compat')
  })

  it('does not carry a concurrently changed name when only reasoning was edited', async () => {
    const { ctx, press } = slots()
    const at = (name: string, revision: number): SettingsDescriptorRead => capabilityDescriptor(
      { baseURL: 'http://x/v1', api: 'openai-completions', modelOverrides: { gpt: { name } } },
      { modelOverrides: { gpt: { name } } },
      revision,
    )
    const fixture = seamsFor({
      descriptors: [at('Old', 9), at('Web', 10)],
      directory: [{ provider: 'local-llama' }],
      mutateRejections: [SETTINGS_CONFLICT],
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    await press(DOWN, ENTER) // edit
    await press(DOWN, DOWN, DOWN, ENTER) // advanced
    await press(DOWN, ENTER) // reasoning
    await press(DOWN, ENTER) // disabled
    await press(DOWN, DOWN, ENTER) // back out of advanced
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // the reader's second Save
    expect((await outcome)?.kind).toBe('done')
    const ops = fixture.mutateCalls[1]?.ops
    expect(ops).toEqual([{
      op: 'set',
      path: ['providers', 'local-llama', 'modelOverrides', 'gpt', 'reasoningEfforts'],
      value: false,
    }])
    expect(JSON.stringify(ops)).not.toContain('name')
  })

  it('does not carry a concurrently changed reasoning mapping when only the capacity was edited', async () => {
    const { ctx, type, press } = slots()
    const at = (wire: string, revision: number): SettingsDescriptorRead => capabilityDescriptor(
      { baseURL: 'http://x/v1', api: 'openai-completions', modelOverrides: { gpt: { reasoningEfforts: { off: wire } } } },
      { modelOverrides: { gpt: { reasoningEfforts: { off: wire } } } },
      revision,
    )
    const fixture = seamsFor({
      descriptors: [at('old', 9), at('web', 10)],
      directory: [{ provider: 'local-llama' }],
      mutateRejections: [SETTINGS_CONFLICT],
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    await press(DOWN, ENTER) // edit
    await press(DOWN, ENTER) // context window
    await type('9000')
    await press(ENTER)
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // the reader's second Save
    expect((await outcome)?.kind).toBe('done')
    expect(fixture.mutateCalls[1]?.ops).toEqual([{
      op: 'set',
      path: ['providers', 'local-llama', 'modelOverrides', 'gpt', 'contextWindow'],
      value: 9000,
    }])
  })

  it('unsets exactly the cleared field rather than rewriting the override', async () => {
    const { ctx, press } = slots()
    const fixture = seamsFor({
      descriptor: capabilityDescriptor(
        { baseURL: 'http://x/v1', api: 'openai-completions', modelOverrides: { gpt: { name: 'Old', compat: { supportsStore: false } } } },
        { modelOverrides: { gpt: { name: 'Old', compat: { supportsStore: false } } } },
      ),
    })
    const outcome = runRouteEditor(ctx, fixture.seams, declaredRow())
    await press(DOWN, DOWN, DOWN, ENTER) // models
    await press(DOWN, DOWN, ENTER) // gpt
    await press(DOWN, ENTER) // edit
    await press(ENTER) // display name
    await press(CTRL_U) // clear it
    await press(ENTER)
    await press(UP, ENTER) // back out of fields
    await press(UP, ENTER) // done with models
    await press(DOWN, DOWN, DOWN, DOWN, ENTER) // save
    expect((await outcome)?.kind).toBe('done')
    expect(fixture.mutateCalls[0]?.ops).toEqual([{
      op: 'unset',
      path: ['providers', 'local-llama', 'modelOverrides', 'gpt', 'name'],
    }])
  })
})
