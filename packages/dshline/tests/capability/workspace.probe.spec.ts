/**
 * Capability probe: Harness's Workspace registry, against the real plugin.
 *
 * This is the compatibility evidence `tools/capability-probes.mjs` names for
 * the `workspaceRegistry` seam, so it mounts the REAL
 * `@deepseek-ai/dsh-workspace` over the real storage/domain stack `dsh-base`
 * composes — never a dshline-shaped fake. Five contracts are asserted, because
 * `/worktrees` is built on exactly these and nothing else:
 *
 * 1. dshline's narrow {@link WorkspaceRegistryReads} view is satisfied by the
 *    real service, and its {@link WorkspaceEntry} view by a real entity — the
 *    same conformance `worktreesSeams` proves at build time, proved here
 *    against the running object;
 * 2. `create` is idempotent per canonical path, which is what makes offering
 *    it as a human action safe: registering twice cannot produce two records;
 * 3. `resolveByPath` canonicalizes, so a symlinked spelling of an owned
 *    directory resolves to the SAME record — the reason dshline never
 *    normalizes a path itself;
 * 4. `attachSession` validates against the session's own stored header cwd and
 *    REFUSES a session created somewhere else, which is why the loop's
 *    membership write reports rather than retries;
 * 5. the registry never re-bootstraps: a directory Harness has never seen is
 *    simply absent from `list()`, which is the documented Phase 1 discovery
 *    limit `/worktrees` states in the docs rather than papering over.
 *
 * The durable domain, the write chain, and the bootstrap are upstream's
 * contract and upstream's tests. What is under test here is dshline's
 * dependency on them.
 */

import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
// Namespace imports: both ship an `apply`/`Config` module rather than a
// default export, which is how `dsh-base` names them as composition rows too.
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { WorkspaceEntry, WorkspaceRegistryReads } from '../../src/worktrees/harness.ts'
import { recordWorkspaceMembership, worktreesSeams } from '../../src/worktrees/harness.ts'

/** Temporary trees this file made, removed after every case. */
const scratch: string[] = []

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true })
})

/**
 * A fresh temporary directory, tracked for cleanup.
 * @param prefix - a readable prefix for the generated name.
 * @returns the created directory.
 */
async function scratchDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dshline-${prefix}-`))
  scratch.push(path)
  // Canonical from the start: the system temp root is itself a symlink on
  // macOS, and the registry stores `fs.realpath` results, so an uncanonicalized
  // expectation would fail for a reason that has nothing to do with the seam.
  return await realpath(path)
}

/** The real composition `/worktrees` reads through. */
interface Probe {
  readonly ctx: Context
  /** Replace what the header-only persistence peer lists. */
  readonly setSessions: (headers: readonly SessionHeader[]) => void
}

/**
 * Boot the real storage, domain, session store, and Workspace registry.
 *
 * `sessionPersistence` is a header-only stub for the reason upstream's own
 * test uses one: the registry reads `SessionHeader` fields and must never load
 * an event body, so a stub that throws on `load` is the assertion. Everything
 * else — the storage hub, the JSON backend, the domain facility, the session
 * store, and the registry — is the real published plugin.
 * @param sessions - the persisted headers the registry bootstraps from.
 * @returns the booted context.
 */
async function probe(sessions: readonly SessionHeader[] = []): Promise<Probe> {
  const root = await scratchDir('storages')
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionStore)
  let listed = [...sessions]
  ctx.provide('sessionPersistence', {
    list: async () => listed,
    load: () => { throw new Error('event bodies must not be loaded') },
    inspect: () => { throw new Error('event bodies must not be inspected') },
  } as never)
  await ctx.plugin(WorkspaceRegistry)
  return { ctx, setSessions: (headers) => { listed = [...headers] } }
}

/**
 * One persisted header, as the registry's bootstrap index reads it.
 * @param id - the session id.
 * @param cwd - the directory it ran in.
 * @returns the header.
 */
function header(id: string, cwd: string): SessionHeader {
  return { version: 0, id: id as SessionId, createdAt: 1_000, isSeeded: false, cwd } as SessionHeader
}

describe('capability: ctx.workspaceRegistry', () => {
  it('satisfies the narrow read view dshline consumes, entity included', async () => {
    const { ctx } = await probe()
    // The annotated assignment is the conformance check, exactly as
    // `worktreesSeams` performs it — no cast in either direction.
    const seams = worktreesSeams(ctx)
    const registry: WorkspaceRegistryReads | undefined = seams.workspaceRegistry
    expect(registry).toBeDefined()
    if (registry === undefined) return
    const dir = await scratchDir('ws')
    const created: WorkspaceEntry = await registry.create(dir)
    expect(typeof created.id).toBe('string')
    expect(created.title).toBe(dir.split('/').at(-1))
    expect(created.sessionIds).toEqual([])
    expect(await created.status()).toBe('ok')
    expect(registry.list().map(row => row.id)).toEqual([created.id])
    expect(registry.get(created.id)?.path).toBe(created.path)
  })

  it('is idempotent per canonical path, so registering twice cannot fork a record', async () => {
    const { ctx } = await probe()
    const registry = worktreesSeams(ctx).workspaceRegistry
    if (registry === undefined) throw new Error('expected the registry to be mounted')
    const dir = await scratchDir('ws')
    const first = await registry.create(dir)
    const again = await registry.create(dir)
    expect(again.id).toBe(first.id)
    expect(registry.list()).toHaveLength(1)
  })

  it('canonicalizes a path itself, which is why dshline never normalizes one', async () => {
    const { ctx } = await probe()
    const registry = worktreesSeams(ctx).workspaceRegistry
    if (registry === undefined) throw new Error('expected the registry to be mounted')
    const dir = await scratchDir('ws')
    const owned = await registry.create(dir)
    const links = await scratchDir('links')
    const link = join(links, 'alias')
    await symlink(dir, link)
    // A different spelling of the same directory, resolved by the registry's
    // own `fs.realpath` canon rather than by any string rule here.
    expect((await registry.resolveByPath(link))?.id).toBe(owned.id)
    expect((await registry.resolveByPath(`${dir}/`))?.id).toBe(owned.id)
  })

  it('answers undefined for an existing directory it does not own', async () => {
    const { ctx } = await probe()
    const registry = worktreesSeams(ctx).workspaceRegistry
    if (registry === undefined) throw new Error('expected the registry to be mounted')
    await registry.create(await scratchDir('ws'))
    expect(await registry.resolveByPath(await scratchDir('other'))).toBeUndefined()
  })

  it('validates membership against the session\'s own header cwd, and refuses a mismatch', async () => {
    const { ctx } = await probe()
    const registry = worktreesSeams(ctx).workspaceRegistry
    if (registry === undefined) throw new Error('expected the registry to be mounted')
    const dir = await scratchDir('ws')
    const workspace = await registry.create(dir)
    const inside = ctx.sessions.create(undefined, { meta: { cwd: dir } })
    const elsewhere = ctx.sessions.create(undefined, { meta: { cwd: await scratchDir('other') } })

    expect(await recordWorkspaceMembership(ctx, workspace.id, inside.id)).toEqual({ kind: 'attached' })
    expect(registry.get(workspace.id)?.sessionIds).toEqual([inside.id])

    const refused = await recordWorkspaceMembership(ctx, workspace.id, elsewhere.id)
    expect(refused.kind).toBe('failed')
    if (refused.kind !== 'failed') return
    expect(refused.message).toContain('cannot attach session')
    // The session still exists: a refused membership write is reported, never
    // repaired by destroying what was created.
    expect(ctx.sessions.get(elsewhere.id)).toBeDefined()
    expect(registry.get(workspace.id)?.sessionIds).toEqual([inside.id])
  })

  it('reports an unknown workspace id rather than throwing at the call site', async () => {
    const { ctx } = await probe()
    const session = ctx.sessions.create(undefined, { meta: { cwd: await scratchDir('ws') } })
    expect(await recordWorkspaceMembership(ctx, 'not-a-workspace', session.id))
      .toEqual({ kind: 'unknown' })
  })

  it('groups persisted history once at first start, and never re-bootstraps afterwards', async () => {
    const seen = await scratchDir('seen')
    const started = await probe([header('s-old', seen)])
    const registry = worktreesSeams(started.ctx).workspaceRegistry
    if (registry === undefined) throw new Error('expected the registry to be mounted')
    // The documented Phase 1 discovery source: a directory Harness has a
    // persisted session for becomes a workspace at first start.
    expect(registry.list().map(row => row.path)).toEqual([seen])

    // And a directory that appears in persistence later does NOT, because the
    // registry is initialized. `/worktrees` says so instead of scanning for it.
    const fresh = await scratchDir('fresh')
    started.setSessions([header('s-old', seen), header('s-new', fresh)])
    expect(registry.list().map(row => row.path)).toEqual([seen])
    expect(await registry.resolveByPath(fresh)).toBeUndefined()
  })
})
