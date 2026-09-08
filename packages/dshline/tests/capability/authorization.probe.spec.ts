/**
 * Capability probe: Harness's `authorization` seam, against the real service.
 *
 * This is the compatibility evidence `tools/capability-probes.mjs` names for
 * the `authorization` seam. The concrete `AuthorizationService` is mounted
 * over a local in-memory `CredentialProvider` subclass that supplies the
 * credential record surface; it does not prove production provider storage
 * semantics.
 *
 * The probe checks the deterministic service contract dshline relies on:
 *
 * 1. the published service mounts and provides `ctx.authorization`;
 * 2. `list()` publishes flow labels, methods, in-flight state, and the
 *    `<scope>/<id>` key that the adapter's route-key helper consumes;
 * 3. `begin()` routes notices/prompts through its supplied interaction and
 *    reports authorization only after the local record was committed;
 * 4. a withdrawn attempt settles `cancelled` rather than throwing.
 *
 * The full bundle patch and browser `/connect` presentation are not exercised
 * here. The useful evidence is AuthorizationService orchestration layered over
 * a minimal local credential fixture.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import CredentialProvider from '@deepseek-ai/dsh-credentials'
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

/** A local credential record service; AuthorizationService owns the real orchestration. */
class MemoryCredentials extends CredentialProvider {
  /** Records this provider holds, by key. */
  private readonly records = new Map<string, CredentialRecord>()

  override async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return undefined
  }

  override async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: false, writable: true }
  }

  override async set(_ref: CredentialRef, _value: string): Promise<void> {}

  override async unset(_ref: CredentialRef): Promise<void> {}

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const held = this.records.get(key)
    return held === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: held.kind, writable: true }
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [...this.records].map(([key, record]) => ({ key: key as CredentialKey, kind: record.kind }))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next === undefined) this.records.delete(key)
    else this.records.set(key, next)
    // The real base-class notifier supplies the event the authorization
    // orchestration watches after a record commit.
    this.notifyRecordUpdated(key)
    return next
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    this.notifyRecordUpdated(key)
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
    // The composition dependency publication relies on this being mountable. A
    // default export that stopped being a Service would fail here early.
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
    // `inFlight` lets a consumer disable the action before it reaches the
    // service's ALREADY_IN_FLIGHT error.
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
        // Exercise the two interaction payload shapes a consumer may route to
        // a transcript notice or overlay: a page/code notice and a question.
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
        // A flow waiting with no question on screen: cancellation must still
        // reach its signal listener.
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
    // Not a throw: the service reports a withdrawn sign-in as cancellation,
    // which a consumer can present distinctly from failure.
    expect(await running).toEqual({ status: 'cancelled' })
  })
})
