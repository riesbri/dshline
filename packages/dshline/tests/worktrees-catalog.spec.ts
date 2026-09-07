/**
 * `/worktrees`' grouping: one authority, and it is the session corpus.
 *
 * The assertions worth making here are about WHERE a fact came from. A row
 * exists because `ctx.sessionQuery` reported a session whose header records
 * that exact cwd, and a row's sessions are the same corpus filtered on the
 * same exact cwd — one relationship read twice, never two authorities
 * compared. Nothing is stored, canonicalized, or discovered anywhere else.
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
import { worktreeLabel, worktreeRows } from '../src/worktrees/model.ts'

/** Let the catalog's own awaits settle before reading its state. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

/**
 * A promise whose completion a test controls.
 * @returns the promise and its resolve function.
 */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

/**
 * One structurally valid session header, as the corpus stores it.
 * @param id - the session id.
 * @param overrides - header fields to replace; omit `cwd` for a legacy header.
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
 * @param cwd - the exact cwd its header records, or undefined for a legacy session.
 * @param createdAt - when it was created; the corpus orders on this.
 * @returns the record.
 */
function record(id: string, cwd: string | undefined, createdAt = 1_000): SessionRecord {
  return {
    header: header(id, { createdAt, ...(cwd === undefined ? {} : { cwd }) }),
    live: false,
    persisted: true,
  }
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
 * A session-query engine narrowed to the reads these two views use.
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

/** The corpus the acceptance example describes, in Harness's newest-first order. */
const CORPUS: readonly SessionRecord[] = [
  record('s4', '/home/me/src/dshline-ui', 4_000),
  record('s3', '/home/me/src/dshline-auth', 3_000),
  record('s2', '/home/me/src/dshline', 2_000),
  record('s1', '/home/me/src/dshline', 1_000),
]

describe('grouping the corpus into working directories', () => {
  it('groups sessions by their exact stored cwd, one row per directory', async () => {
    const catalog = new WorktreeCatalog({
      query: engine({ listSessions: async () => [...CORPUS] }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    expect(listing.kind).toBe('ready')
    if (listing.kind !== 'ready') return
    expect(listing.rows).toEqual([
      { cwd: '/home/me/src/dshline-ui', sessions: 1, current: false },
      { cwd: '/home/me/src/dshline-auth', sessions: 1, current: false },
      { cwd: '/home/me/src/dshline', sessions: 2, current: false },
    ])
  })

  it('orders groups by the newest session in each, which is Harness\'s own corpus order', () => {
    // No second ordering authority and nothing saved: `listSessions` is newest
    // first with a stable id tiebreak, so first appearance IS the order.
    const rows = worktreeRows([
      record('older', '/b', 1_000),
      record('newest', '/a', 9_000),
      record('middle', '/c', 5_000),
    ], undefined)
    expect(rows.map(row => row.cwd)).toEqual(['/b', '/a', '/c'])
  })

  it('keeps two spellings of one directory apart rather than inventing path identity', async () => {
    const catalog = new WorktreeCatalog({
      query: engine({
        listSessions: async () => [
          record('canonical', '/home/me/src/dshline'),
          record('linked', '/home/me/link-to-dshline'),
          record('trailing', '/home/me/src/dshline/'),
        ],
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('expected a ready listing')
    // dshline does not realpath, join, or normalize a stored cwd: the group
    // key is the string Harness wrote, and three strings are three rows.
    expect(listing.rows).toHaveLength(3)
  })

  it('never turns a cwd-less legacy session into a row', async () => {
    const catalog = new WorktreeCatalog({
      query: engine({
        listSessions: async () => [
          record('legacy', undefined),
          record('blank', ''),
          record('real', '/home/me/src/dshline'),
        ],
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('expected a ready listing')
    expect(listing.rows.map(row => row.cwd)).toEqual(['/home/me/src/dshline'])
  })

  it('marks the row the attached session\'s own header cwd names', async () => {
    const catalog = new WorktreeCatalog({
      query: engine({ listSessions: async () => [...CORPUS] }),
      invalidate: () => {},
      currentWorkspace: '/home/me/src/dshline-auth',
    })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('expected a ready listing')
    expect(listing.rows.filter(row => row.current).map(row => row.cwd))
      .toEqual(['/home/me/src/dshline-auth'])
  })

  it('marks nothing when the attached session\'s cwd names no group', async () => {
    const catalog = new WorktreeCatalog({
      query: engine({ listSessions: async () => [...CORPUS] }),
      invalidate: () => {},
      currentWorkspace: '/home/me/src/somewhere-else',
    })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('expected a ready listing')
    expect(listing.rows.some(row => row.current)).toBe(false)
  })

  it('reports an unmounted session corpus without reading anything', async () => {
    const catalog = new WorktreeCatalog({ query: undefined, invalidate: () => {} })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toEqual({ kind: 'unavailable' })
    expect(catalog.selection()).toBeUndefined()
  })

  it('reports an empty corpus as ready and empty', async () => {
    const catalog = new WorktreeCatalog({ query: engine({}), invalidate: () => {} })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toEqual({ kind: 'ready', rows: [] })
  })

  it('surfaces a refused corpus read with Harness\'s own message', async () => {
    const catalog = new WorktreeCatalog({
      query: engine({
        listSessions: async () => { throw new Error('session persistence is unavailable') },
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toEqual({
      kind: 'failed',
      message: 'session persistence is unavailable',
    })
  })

  it('observes a directory that appears in a later corpus read', async () => {
    let corpus: readonly SessionRecord[] = [record('s1', '/home/me/src/dshline')]
    const catalog = new WorktreeCatalog({
      query: engine({ listSessions: async () => [...corpus] }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    expect((catalog.listing() as { rows: unknown[] }).rows).toHaveLength(1)
    // A session another dshline process persisted, or one this process just
    // created: it arrives through the ordinary corpus listing and needs no
    // discovery database to compensate.
    corpus = [record('s2', '/home/me/src/dshline-auth', 5_000), ...corpus]
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('expected a ready listing')
    expect(listing.rows.map(row => row.cwd))
      .toEqual(['/home/me/src/dshline-auth', '/home/me/src/dshline'])
  })

  it('drops a read that lands after dispose rather than repainting a closed view', async () => {
    const gate = deferred<SessionRecord[]>()
    let paints = 0
    const catalog = new WorktreeCatalog({
      query: engine({ listSessions: async () => await gate.promise }),
      invalidate: () => { paints += 1 },
    })
    catalog.refresh()
    const before = paints
    catalog.dispose()
    gate.resolve([...CORPUS])
    await settled()
    expect(paints).toBe(before)
    expect(catalog.listing().kind).toBe('loading')
  })

  it('drops a superseded read rather than letting it overwrite a newer one', async () => {
    const first = deferred<SessionRecord[]>()
    let call = 0
    const catalog = new WorktreeCatalog({
      query: engine({
        listSessions: async () => {
          call += 1
          return call === 1 ? await first.promise : [record('s9', '/home/me/src/latest')]
        },
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    catalog.refresh()
    await settled()
    first.resolve([...CORPUS])
    await settled()
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('expected a ready listing')
    expect(listing.rows.map(row => row.cwd)).toEqual(['/home/me/src/latest'])
  })
})

describe('the sessions under one selected directory', () => {
  it('asks Harness for that exact cwd, through the one session query path', async () => {
    const clauses: SessionResultFilter[][] = []
    const catalog = new WorktreeCatalog({
      query: engine({
        listSessions: async () => [...CORPUS],
        filterSessions: async (filters) => {
          clauses.push([...filters])
          return [record('s3', '/home/me/src/dshline-auth', 3_000)]
        },
        readTitleSnapshots: async () => [titled('s3', 'Implement auth flow')],
      }),
      invalidate: () => {},
      currentWorkspace: '/home/me/src/dshline',
    })
    catalog.refresh()
    await settled()
    catalog.select('/home/me/src/dshline-auth')
    await settled()
    // The clause is the selected directory's own cwd, and it is
    // `filterSessions` — the same call `/sessions` makes — rather than a
    // second query path this feature invented.
    expect(clauses).toEqual([[{ kind: 'cwd', values: ['/home/me/src/dshline-auth'] }]])
    const selection = catalog.selection()
    if (selection?.sessions.kind !== 'ready') throw new Error('expected a ready session listing')
    expect(selection.row.cwd).toBe('/home/me/src/dshline-auth')
    expect(selection.sessions.entries.map(entry => entry.title)).toEqual(['Implement auth flow'])
  })

  it('never lists the whole corpus into the second view', async () => {
    let listed = 0
    const catalog = new WorktreeCatalog({
      query: engine({
        listSessions: async () => {
          listed += 1
          return [...CORPUS]
        },
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    catalog.select('/home/me/src/dshline')
    await settled()
    // One corpus read, for the grouping. The second view goes through
    // `filterSessions`; a bare `SessionCatalog.refresh()` would have taken
    // another `listSessions` and shown every directory's sessions.
    expect(listed).toBe(1)
  })

  it('reports the group count and the group rows from the same relationship', async () => {
    const catalog = new WorktreeCatalog({
      query: engine({
        listSessions: async () => [...CORPUS],
        filterSessions: async () => [
          record('s2', '/home/me/src/dshline', 2_000),
          record('s1', '/home/me/src/dshline', 1_000),
        ],
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('expected a ready listing')
    const group = listing.rows.find(row => row.cwd === '/home/me/src/dshline')
    catalog.select('/home/me/src/dshline')
    await settled()
    const selection = catalog.selection()
    if (selection?.sessions.kind !== 'ready') throw new Error('expected a ready session listing')
    expect(group?.sessions).toBe(2)
    expect(selection.sessions.entries).toHaveLength(2)
  })

  it('goes back to the directory list without leaving a selection behind', async () => {
    const catalog = new WorktreeCatalog({
      query: engine({ listSessions: async () => [...CORPUS] }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    catalog.select('/home/me/src/dshline')
    await settled()
    expect(catalog.selection()?.row.cwd).toBe('/home/me/src/dshline')
    catalog.select(undefined)
    await settled()
    expect(catalog.selection()).toBeUndefined()
  })

  it('keeps a selected directory usable when a refresh no longer groups it', async () => {
    let corpus: readonly SessionRecord[] = [record('s1', '/home/me/src/dshline')]
    const catalog = new WorktreeCatalog({
      query: engine({ listSessions: async () => [...corpus] }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    catalog.select('/home/me/src/dshline')
    await settled()
    corpus = []
    catalog.refresh()
    await settled()
    // The reader is standing in a place they chose, and `+ New session` there
    // is still exactly as valid: the directory is only ever used as the new
    // session's cwd, which Harness validates itself.
    expect(catalog.selection()?.row).toEqual({
      cwd: '/home/me/src/dshline',
      sessions: 0,
      current: false,
    })
  })

  it('reports an unmounted corpus per directory rather than an empty listing', async () => {
    const catalog = new WorktreeCatalog({ query: undefined, invalidate: () => {} })
    catalog.select('/home/me/src/dshline')
    await settled()
    expect(catalog.selection()?.sessions).toEqual({ kind: 'unavailable' })
  })
})

describe('the label a row shows', () => {
  it('is the last path segment, derived and never stored', () => {
    expect(worktreeLabel('/home/me/src/dshline-auth')).toBe('dshline-auth')
    expect(worktreeLabel('/home/me/src/dshline/')).toBe('dshline')
    expect(worktreeLabel('C:\\src\\dshline')).toBe('dshline')
  })

  it('falls back to the path itself when there is no segment to take', () => {
    expect(worktreeLabel('/')).toBe('/')
  })
})
