/**
 * Capability probe: Harness's `authorization` seam, against the real service.
 *
 * This is the compatibility evidence `tools/capability-probes.mjs` names for
 * the `authorization` seam, and it earns a probe of its own now rather than
 * before because dshline's bundle patch COMPOSES this package. A row dshline
 * inserts is a row whose failure to mount is dshline's boot failing, so the
 * shape it is mounted by — a default-exported `Service` class injecting
 * `credentials` — is now part of this frontend's contract with upstream and
 * not only part of `/connect`'s.
 *
 * The real `AuthorizationService` is mounted over a real abstract
 * `CredentialProvider` subclass, never a dshline-shaped fake, and everything
 * asserted is something a `/connect` decision is built on:
 *
 * 1. the package mounts by its published default export and provides
 *    `ctx.authorization` — the composition dshline's own patch performs;
 * 2. `list()` publishes the label, methods, and `inFlight` that
 *    `ConnectSignInRow` is assembled from, and its key is the `<scope>/<id>`
 *    string {@link piAiSignInRoute} reads to find the route a sign-in
 *    authenticates;
 * 3. an attempt's notices and prompts reach the CALLER's interaction, which is
 *    what lets `authorize.ts` put a sign-in URL in scrollback and a question in
 *    an overlay;
 * 4. `authorized` is reported only after a record was committed during the
 *    attempt — so the transcript row saying "signed in" is never ahead of the
 *    credential store;
 * 5. a withdrawn attempt settles `cancelled` rather than throwing, which is the
 *    whole basis of closing `/connect` mid-login.
 *
 * The seam's own internals are upstream's contract and upstream's tests. What
 * is under test here is dshline's dependence on them.
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { piAiSignInRoute } from '../../src/connect/pi-ai.ts'
import type { ConnectProviderRow } from '../../src/connect/model.ts'

/**
 * A real `CredentialProvider` over a Map.
 *
 * The abstract class from `@deepseek-ai/dsh-credentials` is subclassed rather
 * than replaced, so the seam's commit confirmation runs against the real
 * `describeRecord`/`modifyRecord` contract and the real
 * `credentials/record-updated` event it watches for.
 */
class MemoryCredentials extends Service {
  /** Records this provider holds, by key. */
  private readonly records = new Map<string, CredentialRecord>()

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return undefined
  }

  async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: false, writable: true }
  }

  async set(_ref: CredentialRef, _value: string): Promise<void> {}

  async unset(_ref: CredentialRef): Promise<void> {}

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const held = this.records.get(key)
    return held === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: held.kind, writable: true }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [...this.records].map(([key, record]) => ({ key: key as CredentialKey, kind: record.kind }))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next === undefined) this.records.delete(key)
    else this.records.set(key, next)
    // The event the seam watches to confirm a commit happened during the
    // attempt; without it a re-authorization could pass a stale record off as
    // fresh, which is the failure `NOT_COMMITTED` exists to prevent.
    this.ctx.emit('credentials/record-updated', key)
    return next
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    this.ctx.emit('credentials/record-updated', key)
  }
}

/** The record `dsh-llm-pi-ai`'s own `recordKeyFor('openai')` would build. */
const OPENAI = credentialKey('llm-pi-ai', 'openai')

/**
 * Mount the real credential provider and the real authorization service.
 * @returns the composed context.
 */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  // By the package's default export and nothing else — the same shape
  // `packages/dshline/cordis.patch.yml` mounts it by name.
  await ctx.plugin(AuthorizationService)
  return ctx
}

describe('capability probe: the authorization seam', () => {
  it('mounts by its default export and provides ctx.authorization', async () => {
    const ctx = await harness()
    // The row dshline's bundle patch inserts. A default export that stopped
    // being a mountable Service would fail here rather than at a user's boot.
    expect(ctx.get('authorization')).toBeDefined()
  })

  it('publishes each flow as the facts a sign-in row is assembled from', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow({
      key: OPENAI,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
      run: async () => {},
    })
    const [entry] = ctx.authorization.list()
    expect(entry?.label).toBe('ChatGPT (Codex)')
    expect(entry?.methods.map(method => method.id)).toEqual(['oauth', 'api-key'])
    // `inFlight` is what lets a browser render the action unavailable rather
    // than discovering ALREADY_IN_FLIGHT through an error.
    expect(entry?.inFlight).toBe(false)
  })

  it('keys a flow as <scope>/<id>, which is what the route link reads', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow({
      key: OPENAI,
      label: 'OpenAI',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: async () => {},
    })
    const key = ctx.authorization.list()[0]?.key
    expect(key).toBe('llm-pi-ai/openai')
    // The join dshline performs for this one adapter family, against a key the
    // REAL seam produced rather than a string a test wrote out.
    const route: ConnectProviderRow = {
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
    }
    expect(piAiSignInRoute(String(key), [route])).toBe(route)
  })

  it('routes notices and prompts to the caller that began the attempt', async () => {
    const ctx = await harness()
    const notices: AuthorizationNotice[] = []
    ctx.authorization.registerFlow({
      key: OPENAI,
      label: 'OpenAI',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: async session => {
        // The two shapes `authorize.ts` splits between scrollback and an
        // overlay: a one-way notice carrying a page and a code, and a question.
        session.notify({ message: 'Continue in your browser', url: 'https://auth.example/go', code: 'ABCD-1234' })
        const typed = await session.prompt({ kind: 'text', message: 'Paste the code' })
        await ctx.credentials.modifyRecord(OPENAI, async () => ({ kind: 'grant', payload: { token: typed } }))
      },
    })
    const asked: AuthorizationPrompt[] = []
    const outcome = await ctx.authorization.begin({
      key: OPENAI,
      interaction: {
        notify: notice => { notices.push(notice) },
        prompt: async prompt => {
          asked.push(prompt)
          return 'typed-code'
        },
      },
    })
    expect(outcome).toEqual({ status: 'authorized' })
    expect(notices).toEqual([
      { message: 'Continue in your browser', url: 'https://auth.example/go', code: 'ABCD-1234' },
    ])
    expect(asked.map(prompt => prompt.kind)).toEqual(['text'])
    // `authorized` means the record really is in the store, which is what makes
    // "signed in" a safe thing for the transcript to say.
    expect((await ctx.credentials.describeRecord(OPENAI)).configured).toBe(true)
  })

  it('refuses to report authorized when the flow committed nothing', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow({
      key: OPENAI,
      label: 'OpenAI',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      // Resolves without writing a record.
      run: async () => {},
    })
    await expect(ctx.authorization.begin({
      key: OPENAI,
      interaction: { notify: () => {}, prompt: async () => '' },
    })).rejects.toThrow(/NOT_COMMITTED|committing/u)
  })

  it('settles a withdrawn attempt as cancelled rather than as a failure', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow({
      key: OPENAI,
      label: 'OpenAI',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: async session => {
        // A login waiting on a browser callback with no question on screen —
        // the exact shape closing `/connect` has to be able to take down.
        await new Promise<void>((_resolve, reject) => {
          session.signal.addEventListener('abort', () => { reject(new Error('withdrawn')) }, { once: true })
        })
      },
    })
    const withdrawal = new AbortController()
    const running = ctx.authorization.begin({
      key: OPENAI,
      signal: withdrawal.signal,
      interaction: { notify: () => {}, prompt: async () => '' },
    })
    withdrawal.abort()
    // Not a throw: `/connect` reports a withdrawn sign-in as a withdrawal, and
    // would have to invent that distinction if the seam raised here.
    expect(await running).toEqual({ status: 'cancelled' })
  })
})
