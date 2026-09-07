/**
 * Capability probe: `ctx.credentials`, against the abstract contract.
 *
 * `CredentialProvider` is intentionally abstract: a deployment supplies the
 * storage and policy, while dshline consumes the reference/record views and
 * notification shapes. This probe mounts the real abstract base with a local
 * in-memory implementation and checks Cordis mounting plus the exact calls
 * production makes. It does not claim evidence for how a production backend
 * stores, deletes, or derives `configured`.
 *
 * The authorization probe independently exercises AuthorizationService's record
 * orchestration over its own local credential fixture. Together they cover the
 * seam and dshline's calls without pretending the fixture is a backend.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import CredentialProvider, { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'

/** Minimal in-memory provider satisfying the real abstract contract, nothing more. */
class MemoryCredentialProvider extends CredentialProvider {
  // TS-private, not `#`-private: cordis serves consumers through a traced
  // proxy whose `this` carries no private-field brand.
  /** Values behind environment-shaped references, by reference name. */
  private readonly refs = new Map<string, string>()
  /** Plugin-owned records, by `<scope>/<id>` key. */
  private readonly records = new Map<string, CredentialRecord>()

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.refs.get(ref)
    return value === undefined || value === '' ? undefined : { value, source: 'provider-store' }
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.refs.get(ref)
    return {
      configured: value !== undefined && value !== '',
      source: 'provider-store',
      writable: true,
    }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    this.refs.set(ref, value)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    this.refs.delete(ref)
  }

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return this.records.get(key)
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    return { configured: this.records.has(key), kind: 'grant', writable: true }
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return [...this.records.keys()].map(key => ({ key, kind: 'grant' as const }))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key))
    if (next !== undefined) this.records.set(key, next)
    return next ?? this.records.get(key)
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
  }
}

/** The one reference the probe's route names, in the env-shaped vocabulary. */
const REF = 'PROBE_API_KEY'

/** The record address shape authorization entries hand Connect. */
const OPENAI = credentialKey('llm-pi-ai', 'openai')

/** Mount the real provider base as `ctx.credentials`. */
async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentialProvider)
  return ctx
}

describe('capability: credentials', () => {
  it('describes a reference as configured, sourced, and writable — never a value', async () => {
    const ctx = await mounted()
    try {
      const before = await ctx.credentials.describe(REF)
      expect(before.configured).toBe(false)
      await ctx.credentials.set(REF, 'probe-secret')
      const after = await ctx.credentials.describe(REF)
      expect(after).toEqual({ configured: true, source: 'provider-store', writable: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('forgets a reference through unset, which Connect reports as sign-out', async () => {
    const ctx = await mounted()
    try {
      await ctx.credentials.set(REF, 'probe-secret')
      await ctx.credentials.unset(REF)
      expect((await ctx.credentials.describe(REF)).configured).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('describes a record by its scoped key and deletes an absent one as a no-op', async () => {
    const ctx = await mounted()
    try {
      expect((await ctx.credentials.describeRecord(OPENAI)).configured).toBe(false)
      await ctx.credentials.modifyRecord(OPENAI, async () => ({ kind: 'grant', payload: { token: 't' } }))
      expect((await ctx.credentials.describeRecord(OPENAI)).configured).toBe(true)
      await ctx.credentials.deleteRecord(OPENAI)
      expect((await ctx.credentials.describeRecord(OPENAI)).configured).toBe(false)
      // A record already gone must not fail the forget action.
      await expect(ctx.credentials.deleteRecord(OPENAI)).resolves.toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
