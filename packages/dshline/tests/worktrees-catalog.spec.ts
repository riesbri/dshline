/**
 * `/worktrees`' transient join: two Harness authorities, and no third one.
 *
 * The assertions worth making here are about WHERE a fact came from. A
 * workspace row must be the registry's own record, a session row must be the
 * corpus filtered on that record's exact path, and neither may be
 * reconstructed from the other — the registry's membership account and
 * `ctx.sessionQuery` can disagree honestly, and a frontend that averaged them
 * would be a third authority.
 */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventSearchPage,
  SessionRecord,
  SessionResultFilter,
  SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import type { SessionQueryReads } from '../src/sessions/catalog.ts'
import { WorktreeCatalog } from '../src/worktrees/catalog.ts'
import type { WorkspaceEntry, WorkspaceRegistryReads } from '../src/worktrees/harness.ts'

/** Let the catalog's own awaits settle before reading its state. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

/**
 * One structurally valid session header, as the corpus stores it.
 * @param id - the session id.
 * @param overrides - header fields to replace.
 * @returns the header.
 */
function header(id: string, overrides: Record<string, unknown> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: id as SessionId,
    createdAt: 1_000,
    isSeeded: false,
    ...overrides,
  } as SessionHeader
}

/**
 * One corpus record rooted in a directory.
 * @param id - the session id.
 * @param cwd - the workspace its header records.
 * @returns the record.
 */
function record(id: string, cwd: string): SessionRecord {
  return { header: header(id, { cwd }), live: false, persisted: true }
}

/**
 * A fulfilled batch title observation.
 * @param id - the session id.
 * @param title - the folded title.
 * @returns the settlement.
 */
function titled(id: string, title: string): SessionTitleObservationResult {
  return {
    sessionId: id as SessionId,
    status: 'fulfilled',
    value: {
      session: header(id),
      title: { title, messageSeqs: [0], source: { kind: 'fallback' }, eventSeq: 1, updatedAt: 1_000 },
    },
  }
}

/**
 * A session-query engine narrowed to the reads the session catalog uses.
 * @param reads - the behaviours this test needs.
 * @returns the fake engine.
 */
function engine(reads: Partial<SessionQueryReads>): SessionQueryReads {
  return {
    listSessions: reads.listSessions ?? (async () => []),
    filterSessions: reads.filterSessions ?? (async () => []),
    readTitleSnapshots: reads.readTitleSnapshots ?? (async () => []),
    listEvents: reads.listEvents ?? (async () => []),
    searchSessions: reads.searchSessions ?? (async () => ({ items: [] })),
    searchEvents: reads.searchEvents ?? (async request => ({
      session: header(String(request.sessionId)),
      items: [],
    } as SessionEventSearchPage)),
    traceSession: reads.traceSession ?? (async sessionId => ({
      session: header(String(sessionId)),
      ancestors: [],
      descendants: [],
    })),
  }
}

/** What a fake workspace record carries. */
interface FakeWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds?: readonly SessionId[]
  readonly status?: 'ok' | 'missing-dir'
}

/** A registry that records what it was asked to do. */
interface FakeRegistry {
  readonly registry: WorkspaceRegistryReads
  readonly attached: Array<{ readonly workspaceId: string; readonly sessionId: SessionId }>
  readonly created: string[]
  readonly resolved: string[]
}

/**
 * A Workspace registry over fixed records.
 * @param workspaces - the records it holds, in registry order.
 * @param options - a listing that throws, or a create that refuses.
 * @returns the registry and its call log.
 */
function registryOf(
  workspaces: readonly FakeWorkspace[],
  options: {
    readonly listThrows?: Error
    readonly createRejects?: Error
    readonly attachRejects?: Error
    readonly resolveRejects?: Error
  } = {},
): FakeRegistry {
  const attached: Array<{ workspaceId: string; sessionId: SessionId }> = []
  const created: string[] = []
  const resolved: string[] = []
  const rows = [...workspaces]
  const entry = (row: FakeWorkspace): WorkspaceEntry => ({
    id: row.id,
    path: row.path,
    title: row.title,
    sessionIds: row.sessionIds ?? [],
    attachSession: async (sessionId) => {
      if (options.attachRejects !== undefined) throw options.attachRejects
      attached.push({ workspaceId: row.id, sessionId })
    },
    status: async () => row.status ?? 'ok',
  })
  return {
    attached,
    created,
    resolved,
    registry: {
      list: () => {
        if (options.listThrows !== undefined) throw options.listThrows
        return rows.map(entry)
      },
      get: id => {
        const row = rows.find(candidate => candidate.id === id)
        return row === undefined ? undefined : entry(row)
      },
      resolveByPath: async (path) => {
        resolved.push(path)
        if (options.resolveRejects !== undefined) throw options.resolveRejects
        const row = rows.find(candidate => candidate.path === path)
        return row === undefined ? undefined : entry(row)
      },
      create: async (path) => {
        created.push(path)
        if (options.createRejects !== undefined) throw options.createRejects
        const existing = rows.find(candidate => candidate.path === path)
        if (existing !== undefined) return entry(existing)
        const row: FakeWorkspace = { id: `ws-${String(rows.length + 1)}`, path, title: 'new' }
        rows.push(row)
        return entry(row)
      },
    },
  }
}

/** The three workspaces most cases below list. */
const WORKSPACES: readonly FakeWorkspace[] = [
  { id: 'ws-main', path: '/home/dev/src/dshline', title: 'dshline', sessionIds: ['a' as SessionId, 'b' as SessionId] },
  { id: 'ws-auth', path: '/home/dev/src/dshline-auth', title: 'auth experiment', sessionIds: ['c' as SessionId] },
  { id: 'ws-quiet', path: '/home/dev/src/dshline-quiet', title: 'quiet' },
]

describe('the /worktrees workspace catalog', () => {
  it('lists the registry\'s own records, in its own order, with its titles and canonical paths', async () => {
    const { registry } = registryOf(WORKSPACES)
    const catalog = new WorktreeCatalog({ registry, query: engine({}), invalidate: () => {} })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    expect(listing.kind).toBe('ready')
    if (listing.kind !== 'ready') return
    expect(listing.rows.map(row => row.id)).toEqual(['ws-main', 'ws-auth', 'ws-quiet'])
    expect(listing.rows.map(row => row.title)).toEqual(['dshline', 'auth experiment', 'quiet'])
    expect(listing.rows.map(row => row.path)).toEqual([
      '/home/dev/src/dshline',
      '/home/dev/src/dshline-auth',
      '/home/dev/src/dshline-quiet',
    ])
    expect(listing.rows.map(row => row.sessions)).toEqual([2, 1, 0])
  })

  it('marks the workspace the registry itself resolved the current directory to', async () => {
    const fake = registryOf(WORKSPACES)
    const catalog = new WorktreeCatalog({
      registry: fake.registry,
      query: engine({}),
      invalidate: () => {},
      currentWorkspace: '/home/dev/src/dshline-auth',
    })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('expected a ready listing')
    // Through `resolveByPath`, never through a string comparison here:
    // canonicalizing a path is `fs.realpath`, which is Harness's canon.
    expect(fake.resolved).toEqual(['/home/dev/src/dshline-auth'])
    expect(listing.rows.filter(row => row.current).map(row => row.id)).toEqual(['ws-auth'])
    expect(catalog.unregistered()).toBeUndefined()
  })

  it('offers the current directory for registration only when the registry positively owns none', async () => {
    const fake = registryOf(WORKSPACES)
    const catalog = new WorktreeCatalog({
      registry: fake.registry,
      query: engine({}),
      invalidate: () => {},
      currentWorkspace: '/home/dev/src/fresh-worktree',
    })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('expected a ready listing')
    expect(listing.rows.some(row => row.current)).toBe(false)
    expect(catalog.unregistered()).toBe('/home/dev/src/fresh-worktree')
  })

  it('offers no registration when the current directory does not resolve at all', async () => {
    const fake = registryOf(WORKSPACES, { resolveRejects: new Error('ENOENT') })
    const catalog = new WorktreeCatalog({
      registry: fake.registry,
      query: engine({}),
      invalidate: () => {},
      currentWorkspace: '/home/dev/src/deleted',
    })
    catalog.refresh()
    await settled()
    // A create() would reject with the same error one keystroke later, so
    // offering it would be a promise the registry has already refused.
    expect(catalog.unregistered()).toBeUndefined()
  })

  it('reports an empty registry as ready and empty, not as unavailable', async () => {
    const { registry } = registryOf([])
    const catalog = new WorktreeCatalog({ registry, query: engine({}), invalidate: () => {} })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toEqual({ kind: 'ready', rows: [] })
  })

  it('reports an absent Workspace capability without reading anything', async () => {
    const catalog = new WorktreeCatalog({
      registry: undefined,
      query: engine({}),
      invalidate: () => {},
      currentWorkspace: '/home/dev/src/dshline',
    })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toEqual({ kind: 'unavailable' })
    expect(catalog.unregistered()).toBeUndefined()
    expect(catalog.selection()).toBeUndefined()
  })

  it('reports a registry that refused the read as failed, carrying its own message', async () => {
    const { registry } = registryOf([], { listThrows: new Error('workspace registry is not started yet') })
    const catalog = new WorktreeCatalog({ registry, query: engine({}), invalidate: () => {} })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toEqual({
      kind: 'failed',
      message: 'workspace registry is not started yet',
    })
  })
})

describe('the sessions under one selected worktree', () => {
  it('asks Harness for the selected workspace\'s exact cwd, through the one session query path', async () => {
    const clauses: SessionResultFilter[][] = []
    const { registry } = registryOf(WORKSPACES)
    const catalog = new WorktreeCatalog({
      registry,
      query: engine({
        filterSessions: async (filters) => {
          clauses.push([...filters])
          return [record('c', '/home/dev/src/dshline-auth')]
        },
        readTitleSnapshots: async () => [titled('c', 'Implement auth flow')],
      }),
      invalidate: () => {},
      currentWorkspace: '/home/dev/src/dshline',
    })
    catalog.refresh()
    await settled()
    catalog.select('ws-auth')
    await settled()
    // The clause is the selected workspace's path, not the window's, and it is
    // `filterSessions` — the same call `/sessions` makes — rather than a
    // second query this feature invented.
    expect(clauses).toEqual([[{ kind: 'cwd', values: ['/home/dev/src/dshline-auth'] }]])
    const selection = catalog.selection()
    if (selection?.sessions.kind !== 'ready') throw new Error('expected a ready session listing')
    expect(selection.workspace.id).toBe('ws-auth')
    expect(selection.sessions.entries.map(entry => entry.title)).toEqual(['Implement auth flow'])
  })

  it('never lists the whole corpus: an unfiltered listSessions is not the read it takes', async () => {
    let listed = 0
    const { registry } = registryOf(WORKSPACES)
    const catalog = new WorktreeCatalog({
      registry,
      query: engine({
        listSessions: async () => {
          listed += 1
          return [record('everything', '/somewhere/else')]
        },
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    catalog.select('ws-main')
    await settled()
    expect(listed).toBe(0)
  })

  it('reads the live directory check for the one workspace a reader opened, and no other', async () => {
    const { registry } = registryOf([
      ...WORKSPACES.slice(0, 2),
      { id: 'ws-gone', path: '/home/dev/src/moved', title: 'moved', status: 'missing-dir' },
    ])
    const catalog = new WorktreeCatalog({ registry, query: engine({}), invalidate: () => {} })
    catalog.refresh()
    await settled()
    catalog.select('ws-gone')
    await settled()
    expect(catalog.selection()?.status).toBe('missing-dir')
    catalog.select('ws-main')
    await settled()
    expect(catalog.selection()?.status).toBe('ok')
  })

  it('goes back to the workspace list without leaving a selection behind', async () => {
    const { registry } = registryOf(WORKSPACES)
    const catalog = new WorktreeCatalog({ registry, query: engine({}), invalidate: () => {} })
    catalog.refresh()
    await settled()
    catalog.select('ws-main')
    await settled()
    expect(catalog.selection()?.workspace.id).toBe('ws-main')
    catalog.select(undefined)
    await settled()
    expect(catalog.selection()).toBeUndefined()
  })

  it('reports an unmounted session corpus per workspace rather than an empty one', async () => {
    const { registry } = registryOf(WORKSPACES)
    const catalog = new WorktreeCatalog({ registry, query: undefined, invalidate: () => {} })
    catalog.refresh()
    await settled()
    catalog.select('ws-main')
    await settled()
    expect(catalog.selection()?.sessions).toEqual({ kind: 'unavailable' })
  })
})

describe('registering the directory Harness has no record for', () => {
  it('uses Harness\'s own single add route and re-reads the listing', async () => {
    const fake = registryOf(WORKSPACES)
    const catalog = new WorktreeCatalog({
      registry: fake.registry,
      query: engine({}),
      invalidate: () => {},
      currentWorkspace: '/home/dev/src/fresh-worktree',
    })
    catalog.refresh()
    await settled()
    const outcome = await catalog.register('/home/dev/src/fresh-worktree')
    await settled()
    expect(fake.created).toEqual(['/home/dev/src/fresh-worktree'])
    expect(outcome).toEqual({ kind: 'registered', workspaceId: 'ws-4' })
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('expected a ready listing')
    expect(listing.rows.map(row => row.path)).toContain('/home/dev/src/fresh-worktree')
    expect(catalog.unregistered()).toBeUndefined()
  })

  it('surfaces a refusal from Harness instead of pretending a record exists', async () => {
    const fake = registryOf(WORKSPACES, { createRejects: new Error('path is not a directory') })
    const catalog = new WorktreeCatalog({
      registry: fake.registry,
      query: engine({}),
      invalidate: () => {},
      currentWorkspace: '/home/dev/src/a-file',
    })
    catalog.refresh()
    await settled()
    expect(await catalog.register('/home/dev/src/a-file')).toEqual({
      kind: 'failed',
      message: 'path is not a directory',
    })
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('expected a ready listing')
    expect(listing.rows).toHaveLength(3)
  })

  it('says the capability is absent rather than failing when no registry is mounted', async () => {
    const catalog = new WorktreeCatalog({ registry: undefined, query: engine({}), invalidate: () => {} })
    expect(await catalog.register('/anywhere')).toEqual({ kind: 'unavailable' })
  })
})

describe('abandoning the picker', () => {
  it('drops a read that lands after dispose rather than repainting a closed view', async () => {
    let resolveResolve: ((value: WorkspaceEntry | undefined) => void) | undefined
    const fake = registryOf(WORKSPACES)
    const registry: WorkspaceRegistryReads = {
      ...fake.registry,
      resolveByPath: () => new Promise<WorkspaceEntry | undefined>((resolve) => { resolveResolve = resolve }),
    }
    let paints = 0
    const catalog = new WorktreeCatalog({
      registry,
      query: engine({}),
      invalidate: () => { paints += 1 },
      currentWorkspace: '/home/dev/src/dshline',
    })
    catalog.refresh()
    const before = paints
    catalog.dispose()
    resolveResolve?.(undefined)
    await settled()
    expect(paints).toBe(before)
  })
})
