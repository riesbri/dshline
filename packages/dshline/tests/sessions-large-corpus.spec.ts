/**
 * Large-corpus guarantees for the ordinary Sessions listing pipeline.
 *
 * The catalog retains at most {@link CATALOG_LIMIT} rows, but an authoritative
 * listing can be arbitrarily larger. These tests pin the two things that must
 * therefore stay bounded no matter how big the corpus is: the number of full
 * `SessionEntry` projections and the number of title observations. A direct
 * projection counter is read off the fixture records themselves — only
 * `toEntry` reads `record.live` — so the bound is asserted without exposing a
 * new public API.
 *
 * Counting is deliberately NOT bounded: `truncated` and `newest of N` are
 * exact, so the scan still visits every authoritative record. Only the
 * materialization is capped.
 */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  SessionEventSearchPage,
  SessionRecord,
  SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import type { Key } from '@dshline/renderer'
import type { SessionQueryReads } from '../src/sessions/catalog.ts'
import { CATALOG_LIMIT, SessionCatalog } from '../src/sessions/catalog.ts'
import { NO_FILTERS } from '../src/sessions/filters.ts'
import { createSessionsOverlay, type SessionsOverlaySpec } from '../src/sessions/overlay.ts'

/** Let the catalog's own awaits settle before reading its state. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

/** A fixed application-time anchor for deterministic age windows. */
const NOW = 1_800_000_000_000
/** One day in milliseconds, for age-window assertions. */
const DAY = 24 * 60 * 60 * 1_000
/** Corpus sizes large enough to dwarf the retained bound. */
const CORPUS = 10_000

/**
 * One structurally valid session header.
 * @param id - the session id.
 * @param overrides - header fields to replace.
 * @returns the header.
 */
function header(id: string, overrides: Record<string, unknown> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: id as SessionId,
    createdAt: NOW,
    isSeeded: false,
    ...overrides,
  } as SessionHeader
}

/** A 10,000-record corpus with a read counter on every record's `live`. */
interface LargeCorpus {
  readonly records: SessionRecord[]
  /** Full `SessionEntry` projections performed so far, via `toEntry`. */
  projections: () => number
}

/**
 * Build a deterministic large corpus.
 *
 * `live` is an accessor because `toEntry` is its only reader in the exercised
 * paths, which is what makes the projection count observable without a public
 * hook. The corpus deliberately interleaves delegated and own rows so an
 * origin filter has qualifying records both before and after the retained
 * bound.
 * @param size - number of authoritative records.
 * @returns the records and the projection counter.
 */
function largeCorpus(size: number): LargeCorpus {
  let projections = 0
  const records = Array.from({ length: size }, (_, index) => {
    const record = {
      header: header(`large-${String(index).padStart(6, '0')}`, {
        createdAt: NOW - index,
        cwd: index % 2 === 0 ? '/w/even' : '/w/odd',
        ...(index % 3 === 0 ? { origin: 'subagent' } : {}),
      }),
      live: index % 5 === 0,
      persisted: true,
    } as { header: SessionHeader; live: boolean; persisted: boolean }
    const live = record.live
    Object.defineProperty(record, 'live', {
      enumerable: true,
      get() { projections += 1; return live },
    })
    return record as unknown as SessionRecord
  })
  return { records, projections: () => projections }
}

/** What one catalog construction observed. */
interface Observed {
  readonly calls: { listSessions: number; filterSessions: number; readTitleSnapshots: number }
  readonly clauses: readonly (readonly unknown[])[]
  readonly titleIds: readonly (readonly SessionId[])[]
}

/**
 * A counting session-query engine over one fixed corpus.
 * @param records - the authoritative listing to return.
 * @param observed - the mutable recorder the engine appends to.
 * @returns the narrowed query surface.
 */
function countingEngine(records: readonly SessionRecord[], observed: Observed): SessionQueryReads {
  return {
    listSessions: async () => { observed.calls.listSessions += 1; return [...records] },
    filterSessions: async clauses => {
      observed.calls.filterSessions += 1
      observed.clauses.push(clauses)
      return [...records]
    },
    readTitleSnapshots: async ids => {
      observed.calls.readTitleSnapshots += 1
      observed.titleIds.push([...ids])
      return ids.map(id => ({
        sessionId: id,
        status: 'fulfilled',
        value: { session: header(id) },
      } satisfies SessionTitleObservationResult))
    },
    listEvents: async () => [],
    searchSessions: async () => ({ items: [] }),
    searchEvents: async request => ({
      session: header(request.sessionId),
      items: [],
    } as SessionEventSearchPage),
    readEvent: async () => { throw new Error('not exercised') },
    traceSession: async () => { throw new Error('not exercised') },
  }
}

/**
 * Mount a catalog, apply one action, and settle.
 * @param records - the authoritative corpus.
 * @param action - what to ask the catalog to do once mounted.
 * @param overrides - catalog spec fields to replace.
 * @returns the catalog state and what the engine observed.
 */
async function browse(
  records: readonly SessionRecord[],
  action: (catalog: SessionCatalog) => void,
  overrides: { readonly workspace?: { readonly kind: 'cwd'; readonly cwd: string } } = {},
): Promise<{ catalog: SessionCatalog; observed: Observed }> {
  const observed: Observed = {
    calls: { listSessions: 0, filterSessions: 0, readTitleSnapshots: 0 },
    clauses: [],
    titleIds: [],
  }
  const catalog = new SessionCatalog({
    query: countingEngine(records, observed),
    invalidate: () => {},
    now: () => NOW,
    ...overrides,
  })
  action(catalog)
  await settled()
  return { catalog, observed }
}

/**
 * The ids one origin choice retains from a corpus, in Harness order.
 * @param records - the authoritative corpus.
 * @param delegated - whether to retain delegated rather than own rows.
 * @returns the expected retained ids, before the limit is applied.
 */
function expectedIds(records: readonly SessionRecord[], delegated: boolean): SessionId[] {
  return records
    .filter(record => (record.header.origin === 'subagent') === delegated)
    .map(record => record.header.id)
}

describe('a 10,000-record ordinary listing', () => {
  it('materializes at most the configured limit and counts every dropped row', async () => {
    // The whole point of the bound: a corpus two orders of magnitude past the
    // limit must not build a second full presentation corpus. The scan still
    // visits every record, so the exact truncated count and `newest of N` stay
    // truthful.
    // Deliberate break: projecting before bounding makes the counter 10,000.
    const { records, projections } = largeCorpus(CORPUS)
    const { catalog } = await browse(records, c => { c.refresh() })
    const listing = catalog.listing()
    expect(listing).toMatchObject({
      kind: 'ready',
      entries: expect.any(Array),
      truncated: CORPUS - CATALOG_LIMIT,
    })
    if (listing.kind !== 'ready') throw new Error('listing did not settle')
    expect(listing.entries).toHaveLength(CATALOG_LIMIT)
    expect(projections()).toBe(CATALOG_LIMIT)
    // Harness order is preserved: the retained rows are the first `limit`
    // authoritative records, in the order Harness returned them.
    expect(listing.entries.map(entry => entry.id)).toEqual(
      records.slice(0, CATALOG_LIMIT).map(record => record.header.id),
    )
  })

  it('observes titles for exactly one batch of at most the retained ids, in order', async () => {
    const { records } = largeCorpus(CORPUS)
    const { observed } = await browse(records, c => { c.refresh() })
    expect(observed.calls.readTitleSnapshots).toBe(1)
    expect(observed.titleIds).toHaveLength(1)
    const ids = observed.titleIds[0] ?? []
    expect(ids).toHaveLength(CATALOG_LIMIT)
    expect(ids).toEqual(records.slice(0, CATALOG_LIMIT).map(record => record.header.id))
  })

  it('keeps a row whose title observation was rejected', async () => {
    const { records } = largeCorpus(CORPUS)
    const observed: Observed = {
      calls: { listSessions: 0, filterSessions: 0, readTitleSnapshots: 0 },
      clauses: [],
      titleIds: [],
    }
    const catalog = new SessionCatalog({
      query: {
        ...countingEngine(records, observed),
        readTitleSnapshots: async ids => {
          observed.calls.readTitleSnapshots += 1
          observed.titleIds.push([...ids])
          return ids.map(id => ({ sessionId: id, status: 'rejected', reason: new Error('nope') }))
        },
      },
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('listing did not settle')
    expect(listing.entries).toHaveLength(CATALOG_LIMIT)
    expect(listing.entries.every(entry => entry.title === undefined)).toBe(true)
  })

  it('never commits a 10,000-record listing superseded before it settled', async () => {
    // The corpus is large enough that a real listing can be in flight while the
    // reader applies another filter. The generation guard must still discard the
    // older projection rather than letting it paint under the newer request.
    const { records, projections } = largeCorpus(CORPUS)
    const observed: Observed = {
      calls: { listSessions: 0, filterSessions: 0, readTitleSnapshots: 0 },
      clauses: [],
      titleIds: [],
    }
    let release!: (value: readonly SessionRecord[]) => void
    const gate = new Promise<readonly SessionRecord[]>(resolve => { release = resolve })
    const catalog = new SessionCatalog({
      query: {
        ...countingEngine(records, observed),
        listSessions: async () => { observed.calls.listSessions += 1; return gate as Promise<SessionRecord[]> },
      },
      invalidate: () => {},
    })
    catalog.refresh()
    catalog.refresh()
    release(records)
    await settled()
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('listing did not settle')
    // Only the surviving listing's retained rows are projected; the superseded
    // one never materialized past the points the driver had reached.
    expect(listing.entries).toHaveLength(CATALOG_LIMIT)
    expect(projections()).toBeLessThanOrEqual(CATALOG_LIMIT * 2)
  })
})

describe('origin remains presentation-only at scale', () => {
  it.each([
    ['delegated', true],
    ['own', false],
  ] as const)('retains the first %s rows and counts the rest', async (choice, delegated) => {
    const { records, projections } = largeCorpus(CORPUS)
    const { catalog, observed } = await browse(records, c => {
      c.applyFilters({ ...NO_FILTERS, origin: choice })
    })
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('listing did not settle')
    const qualifying = expectedIds(records, delegated)
    expect(listing.entries.map(entry => entry.id)).toEqual(qualifying.slice(0, CATALOG_LIMIT))
    expect(listing.truncated).toBe(qualifying.length - CATALOG_LIMIT)
    expect(projections()).toBe(CATALOG_LIMIT)
    // Zero Harness clauses: origin has no predicate, so this is a plain listing
    // that never invokes the filtered read.
    expect(observed.calls).toEqual({ listSessions: 1, filterSessions: 0, readTitleSnapshots: 1 })
    expect(observed.clauses).toEqual([])
    expect(observed.titleIds[0]).toEqual(qualifying.slice(0, CATALOG_LIMIT))
  })

  it('keeps rows on the far side of the retained bound countable but unprojected', async () => {
    // A delegated corpus whose first qualifying row sits AFTER the bound: the
    // scan must still reach it for the count without materializing anything on
    // the way.
    const records = Array.from({ length: CORPUS }, (_, index) => ({
      header: header(`late-${String(index).padStart(6, '0')}`, {
        createdAt: NOW - index,
        cwd: '/w',
        // Only the very last record is delegated.
        ...(index === CORPUS - 1 ? { origin: 'subagent' } : {}),
      }),
      live: false,
      persisted: true,
    })) as SessionRecord[]
    const { catalog, observed } = await browse(records, c => {
      c.applyFilters({ ...NO_FILTERS, origin: 'delegated' })
    })
    const listing = catalog.listing()
    if (listing.kind !== 'ready') throw new Error('listing did not settle')
    expect(listing.entries.map(entry => entry.id)).toEqual([records[CORPUS - 1]!.header.id])
    expect(listing.truncated).toBe(0)
    expect(observed.calls).toEqual({ listSessions: 1, filterSessions: 0, readTitleSnapshots: 1 })
  })
})

describe('the Harness call each filter value makes', () => {
  /**
   * Run one catalog action over a small corpus and report the calls it made.
   * @param filters - the filter value to apply, or undefined for `refresh()`.
   * @param workspace - the catalog's workspace scope, when one applies.
   * @returns the observed service calls.
   */
  async function callsFor(
    filters: (typeof NO_FILTERS) | undefined,
    workspace?: { readonly kind: 'cwd'; readonly cwd: string },
  ): Promise<Observed['calls']> {
    const { records } = largeCorpus(20)
    const { observed } = await browse(
      records,
      c => { if (filters === undefined) c.refresh(); else c.applyFilters(filters) },
      workspace === undefined ? {} : { workspace },
    )
    return observed.calls
  }

  it.each([
    ['unfiltered refresh', undefined, undefined, { listSessions: 1, filterSessions: 0, readTitleSnapshots: 1 }],
    ['explicit no filters', NO_FILTERS, undefined, { listSessions: 1, filterSessions: 0, readTitleSnapshots: 1 }],
    ['workspace current', { ...NO_FILTERS, workspace: 'current' }, { kind: 'cwd', cwd: '/w/even' }, { listSessions: 0, filterSessions: 1, readTitleSnapshots: 1 }],
    ['age 7d', { ...NO_FILTERS, age: '7d' }, undefined, { listSessions: 0, filterSessions: 1, readTitleSnapshots: 1 }],
    ['workspace and age', { ...NO_FILTERS, workspace: 'current', age: '7d' }, { kind: 'cwd', cwd: '/w/even' }, { listSessions: 0, filterSessions: 1, readTitleSnapshots: 1 }],
    ['origin only own', { ...NO_FILTERS, origin: 'own' }, undefined, { listSessions: 1, filterSessions: 0, readTitleSnapshots: 1 }],
    ['origin only delegated', { ...NO_FILTERS, origin: 'delegated' }, undefined, { listSessions: 1, filterSessions: 0, readTitleSnapshots: 1 }],
  ] as const)('%s', async (_name, filters, workspace, expected) => {
    expect(await callsFor(filters, workspace)).toEqual(expected)
  })

  it('does not ask the filtered read for an empty clause set', async () => {
    // The regression: an origin-only browser filter translates to zero Harness
    // clauses, and `filterSessions([])` would make the engine re-derive the
    // whole corpus under an empty predicate for no new rows.
    const { records } = largeCorpus(50)
    const observed: Observed = {
      calls: { listSessions: 0, filterSessions: 0, readTitleSnapshots: 0 },
      clauses: [],
      titleIds: [],
    }
    const catalog = new SessionCatalog({
      query: {
        ...countingEngine(records, observed),
        filterSessions: async () => { throw new Error('filterSessions must not be called with zero clauses') },
      },
      invalidate: () => {},
    })
    catalog.applyFilters({ ...NO_FILTERS, origin: 'delegated' })
    await settled()
    expect(observed.calls.listSessions).toBe(1)
  })

  it('still applies a real workspace clause to the filtered read', async () => {
    const { records } = largeCorpus(20)
    const { observed } = await browse(
      records,
      c => { c.applyFilters({ ...NO_FILTERS, workspace: 'current' }) },
      { workspace: { kind: 'cwd', cwd: '/w/even' } },
    )
    expect(observed.calls.filterSessions).toBe(1)
    expect(observed.clauses[0]).toEqual([{ kind: 'cwd', values: ['/w/even'] }])
  })
})

describe('ordinary browsing stays local', () => {
  /**
   * Mount the real Sessions overlay over a real catalog.
   * @param query - the session-query surface.
   * @returns the overlay and the catalog behind it.
   */
  function mount(query: SessionQueryReads): { overlay: ReturnType<typeof createSessionsOverlay>; catalog: SessionCatalog } {
    const catalog = new SessionCatalog({ query, invalidate: () => {} })
    const spec: SessionsOverlaySpec = {
      listing: () => catalog.listing(),
      content: () => catalog.content(),
      filters: () => catalog.filters(),
      applyFilters: filters => { catalog.applyFilters(filters) },
      loadMoreContent: () => { catalog.loadMoreContent() },
      restartContentSearch: () => { catalog.restartContentSearch() },
      lineage: sessionId => catalog.lineage(sessionId),
      requestLineage: sessionId => { catalog.requestLineage(sessionId) },
      events: () => catalog.events(),
      searchEvents: (sessionId, text) => { catalog.searchEvents(sessionId, text) },
      loadMoreEvents: () => { catalog.loadMoreEvents() },
      requestEventContext: (sessionId, seq) => { catalog.requestEventContext(sessionId, seq) },
      eventContext: (sessionId, seq) => catalog.eventContext(sessionId, seq),
      detail: sessionId => catalog.detail(sessionId),
      requestDetail: sessionId => { catalog.requestDetail(sessionId) },
      search: text => { catalog.search(text) },
      currentSessionId: undefined,
      workspace: undefined,
      home: '/home',
      now: () => NOW,
      resume: () => ({ kind: 'resume' }),
      push: () => {},
      close: () => {},
      invalidate: () => {},
    }
    return { overlay: createSessionsOverlay(spec), catalog }
  }

  it('costs no Harness read for 100 cursor moves or 10 typed filter characters', async () => {
    // Cursor movement and local filtering read the retained presentation array;
    // neither may turn browsing into a corpus read.
    // Deliberate break: a per-move or per-keystroke listing call makes the
    // counters non-zero.
    const { records } = largeCorpus(CORPUS)
    const observed: Observed = {
      calls: { listSessions: 0, filterSessions: 0, readTitleSnapshots: 0 },
      clauses: [],
      titleIds: [],
    }
    const { overlay, catalog } = mount(countingEngine(records, observed))
    catalog.refresh()
    await settled()
    overlay.render(90, 24)
    const afterOpen = { ...observed.calls }
    const draw = (): void => { overlay.render(90, 24) }
    for (let move = 0; move < 100; move += 1) {
      overlay.handleKey({ kind: 'key', name: 'down' } satisfies Key)
      draw()
    }
    for (const character of 'benchmark ') {
      overlay.handleKey({ kind: 'text', text: character } satisfies Key)
      draw()
    }
    expect(observed.calls).toEqual(afterOpen)
    expect(observed.calls).toEqual({ listSessions: 1, filterSessions: 0, readTitleSnapshots: 1 })
  })
})

describe('title identity is not reused across listings', () => {
  it('re-observes titles from a fresh batch on every listing', async () => {
    // A reopened catalog is a fresh authoritative listing; nothing observes a
    // retained title map from a previous one.
    const { records } = largeCorpus(CORPUS)
    const { records: second } = largeCorpus(CORPUS)
    const observed: Observed = {
      calls: { listSessions: 0, filterSessions: 0, readTitleSnapshots: 0 },
      clauses: [],
      titleIds: [],
    }
    let call = 0
    const catalog = new SessionCatalog({
      query: {
        ...countingEngine(records, observed),
        listSessions: async () => {
          observed.calls.listSessions += 1
          call += 1
          return call === 1 ? [...records] : [...second]
        },
      },
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    catalog.refresh()
    await settled()
    expect(observed.calls.readTitleSnapshots).toBe(2)
    expect(observed.titleIds[1]).toEqual(second.slice(0, CATALOG_LIMIT).map(record => record.header.id))
  })
})

describe('bound search stays bounded', () => {
  it('keeps an event search from reading an event body until disclosure', async () => {
    // Discovery is `searchEvents()`; `readEvent()` is paid only when a hit is
    // opened. The catalog-level guarantee is already covered elsewhere; this
    // pins it on the same large-corpus fixture so the disclosure contract is
    // not accidentally folded into the listing work.
    const { records } = largeCorpus(50)
    const observed: Observed = {
      calls: { listSessions: 0, filterSessions: 0, readTitleSnapshots: 0 },
      clauses: [],
      titleIds: [],
    }
    const reads = { searchEvents: 0, readEvent: 0 }
    const catalog = new SessionCatalog({
      query: {
        ...countingEngine(records, observed),
        searchEvents: async request => {
          reads.searchEvents += 1
          return {
            session: header(request.sessionId),
            items: [{ sessionId: request.sessionId, seq: 3 as SessionSeq, type: 'user/message', time: NOW, surface: 'current', snippet: 'needle' }],
          } as SessionEventSearchPage
        },
        readEvent: async () => { reads.readEvent += 1; throw new Error('not exercised') },
      },
      invalidate: () => {},
    })
    catalog.searchEvents('a' as SessionId, 'needle')
    await settled()
    expect(catalog.events().kind).toBe('ready')
    catalog.loadMoreEvents()
    await settled()
    expect(reads).toEqual({ searchEvents: 1, readEvent: 0 })
  })
})
