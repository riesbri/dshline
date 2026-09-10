/** Tests for reading the Harness session corpus, and for degrading when it cannot. */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_QUERY_READ_WINDOW_MAX, SessionSearchCursor } from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventReadRequest,
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventRecord,
  SessionEventWindow,
  SessionLineageTrace,
  SessionRecord,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
  SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import type { SessionQueryReads } from '../src/sessions/catalog.ts'
import { EVENT_CONTEXT_AFTER, EVENT_CONTEXT_BEFORE, SessionCatalog } from '../src/sessions/catalog.ts'
import { NO_FILTERS } from '../src/sessions/filters.ts'
import { flattenLineage } from '../src/sessions/lineage.ts'

/** Let the catalog's own awaits settle before reading its state. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
}

/**
 * A promise whose completion a test controls.
 * @returns the promise and its resolve/reject functions.
 */
function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

/**
 * One structurally valid session header, as the corpus stores it.
 *
 * `isSeeded: false` is the default because these fixtures describe UNSEEDED
 * sessions: it is the fork-lineage marker — whether this session opened with
 * an inherited event prefix in front of its own work — and none of the rows
 * below claim one. It is deliberately independent of the other two lineage
 * fields a fixture may set: `parentSession` is durable parent identity and
 * `origin: 'subagent'` is navigation classification, and Harness sets both on
 * every subagent child whether or not that child was given a seed. A fixture
 * that means a fork says `isSeeded: true` itself.
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
 * One corpus record with the header fields presentation reads.
 * @param id - the session id.
 * @param overrides - header and availability fields to replace.
 * @returns the record.
 */
function record(id: string, overrides: Partial<SessionRecord & SessionHeader> = {}): SessionRecord {
  const { live = false, persisted = true, ...rest } = overrides as Record<string, unknown>
  return {
    header: header(id, { cwd: '/w', ...rest }),
    live: live as boolean,
    persisted: persisted as boolean,
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
 * One cross-session content-search hit.
 * @param id - session id.
 * @param overrides - record fields to replace.
 * @returns the hit.
 */
function searchHit(id: string, overrides: Partial<SessionRecord & SessionHeader> = {}): SessionSearchHit {
  return {
    ...record(id, overrides),
    bestMatch: {
      sessionId: id as SessionId,
      seq: 4,
      type: 'user/message',
      time: 2_000,
      surface: 'current',
      snippet: `snippet ${id}`,
    },
  }
}

/**
 * One within-session content-search hit.
 * @param sessionId - owning session.
 * @param seq - event sequence number.
 * @returns the hit.
 */
function eventHit(sessionId: string, seq: number): SessionEventSearchHit {
  return {
    sessionId: sessionId as SessionId,
    seq,
    type: 'assistant/message',
    time: 2_000 + seq,
    surface: 'current',
    snippet: `event ${String(seq)}`,
  }
}

/** Parts of the query surface a test overrides. */
type Reads = Partial<SessionQueryReads>

/**
 * A session-query engine narrowed to the eight reads the catalog uses.
 * @param reads - the behaviours this test needs.
 * @returns the fake engine.
 */
function engine(reads: Reads): SessionQueryReads {
  return {
    listSessions: reads.listSessions ?? (async () => []),
    filterSessions: reads.filterSessions ?? (async () => []),
    readTitleSnapshots: reads.readTitleSnapshots ?? (async () => []),
    listEvents: reads.listEvents ?? (async () => []),
    searchSessions: reads.searchSessions ?? (async () => ({ items: [] })),
    searchEvents: reads.searchEvents ?? (async request => ({
      session: record(request.sessionId).header,
      items: [],
    } as SessionEventSearchPage)),
    readEvent: reads.readEvent ?? (async request => window(request.sessionId, request.seq)),
    traceSession: reads.traceSession ?? (async sessionId => ({
      target: record(sessionId),
      ancestors: [],
      descendants: [],
      complete: true,
      root: record(sessionId),
    })),
  }
}

/**
 * One raw event for a context-window fixture.
 * @param seq - the event sequence number.
 * @param type - the event discriminant.
 * @param data - the event payload.
 * @returns the event.
 */
function sessionEvent(seq: number, type: string, data: unknown = {}): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 2_000 + seq, data } as unknown as SessionEvent
}

/**
 * A single-target window as the real read would return it.
 * @param sessionId - the owning session.
 * @param seq - the target sequence number.
 * @param events - the full window, defaulting to just the target.
 * @returns the window.
 */
function window(sessionId: string, seq: number, events: SessionEvent[] = [sessionEvent(seq, 'turn/start')]): SessionEventWindow {
  return {
    session: header(sessionId),
    inheritedEventCount: 0,
    target: events.find(event => event.seq === SessionSeq(seq)) ?? events[0]!,
    events,
    startSeq: SessionSeq(events[0]?.seq ?? seq),
    endSeq: SessionSeq(events.at(-1)?.seq ?? seq),
  } as unknown as SessionEventWindow
}

describe('listing the corpus', () => {
  it('reports no corpus at all when the service is absent, without a failure', () => {
    // A profile that mounts no session query has an unavailable view, not a
    // broken one: the capability rule is degrade, never boot-fail.
    const catalog = new SessionCatalog({ query: undefined, invalidate: () => {} })
    expect(catalog.listing()).toEqual({ kind: 'unavailable' })
    catalog.refresh()
    expect(catalog.listing()).toEqual({ kind: 'unavailable' })
  })

  it('folds headers and one batched title observation into rows', async () => {
    let titleCalls = 0
    const catalog = new SessionCatalog({
      query: engine({
        listSessions: async () => [
          record('a', { cwd: '/w/one', parentSession: 'root' as SessionId }),
          record('b', { live: true, origin: 'subagent' }),
        ],
        readTitleSnapshots: async ids => {
          titleCalls += 1
          expect(ids).toEqual(['a', 'b'])
          return [titled('a', 'First')]
        },
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    expect(listing.kind === 'ready' && listing.entries).toMatchObject([
      { id: 'a', title: 'First', cwd: '/w/one', parent: 'root', origin: 'own', persisted: true },
      { id: 'b', title: undefined, live: true, origin: 'delegated' },
    ])
    // One batched observation, not one call per row: the batch resolves every id
    // from a single corpus listing.
    expect(titleCalls).toBe(1)
  })

  it('keeps a session whose title could not be read', async () => {
    // The batch isolates per-session failures on purpose, and an unreadable title
    // does not make a session unresumable — dropping the row would hide it.
    const catalog = new SessionCatalog({
      query: engine({
        listSessions: async () => [record('a')],
        readTitleSnapshots: async () => [{ sessionId: 'a' as SessionId, status: 'rejected', reason: new Error('nope') }],
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toMatchObject({ kind: 'ready', entries: [{ id: 'a', title: undefined }] })
  })

  it('bounds the listing and says how much it dropped', async () => {
    const catalog = new SessionCatalog({
      query: engine({ listSessions: async () => [record('a'), record('b'), record('c')] }),
      invalidate: () => {},
      limit: 2,
    })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toMatchObject({ kind: 'ready', truncated: 1 })
  })

  it('reports a refused listing instead of showing an empty corpus', async () => {
    // An empty list and an unreadable one look identical on screen, and one of
    // them means the reader's history is gone.
    const catalog = new SessionCatalog({
      query: engine({ listSessions: async () => { throw new Error('persistence unreadable') } }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toEqual({ kind: 'failed', message: 'persistence unreadable' })
  })

  it('discards a listing that landed after a newer one was asked for', async () => {
    let call = 0
    const catalog = new SessionCatalog({
      query: engine({
        listSessions: async () => {
          call += 1
          return call === 1 ? [record('stale')] : [record('fresh')]
        },
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    catalog.refresh()
    await settled()
    expect(catalog.listing()).toMatchObject({ kind: 'ready', entries: [{ id: 'fresh' }] })
  })

  it('discards everything in flight once the browser is gone', async () => {
    // A result that lands after the overlay was dismissed would repaint a live
    // region that has moved on, so neither the state nor the redraw may follow.
    let repaints = 0
    const catalog = new SessionCatalog({
      query: engine({ listSessions: async () => [record('a')] }),
      invalidate: () => { repaints += 1 },
    })
    catalog.refresh()
    expect(repaints).toBe(1)
    catalog.dispose()
    await settled()
    expect(repaints).toBe(1)
    expect(catalog.listing()).toEqual({ kind: 'loading' })
  })
})

describe('filtering the authoritative listing', () => {
  it('asks Harness for ANDed clauses and preserves its order before bounding', async () => {
    const now = 40 * 24 * 60 * 60 * 1_000
    let asked: readonly unknown[] | undefined
    const catalog = new SessionCatalog({
      query: engine({
        filterSessions: async filters => {
          asked = filters
          return [
            record('newer-own', { createdAt: 1, parentSession: 'root' as SessionId }),
            record('delegated', { createdAt: 9_000, origin: 'subagent' }),
            record('older-own', { createdAt: 8_000 }),
            record('dropped-own', { createdAt: 10_000 }),
          ]
        },
      }),
      workspace: { kind: 'cwd', cwd: '/w' },
      now: () => now,
      limit: 2,
      invalidate: () => {},
    })
    catalog.applyFilters({ workspace: 'current', origin: 'own', age: '7d' })
    await settled()
    expect(asked).toEqual([
      { kind: 'cwd', values: ['/w'] },
      { kind: 'created-at', from: now - 7 * 24 * 60 * 60 * 1_000, to: now },
    ])
    expect(catalog.listing()).toMatchObject({
      kind: 'ready',
      entries: [{ id: 'newer-own' }, { id: 'older-own' }],
      truncated: 1,
    })
  })

  it('uses the base listing service for refresh and an explicitly empty filter value', async () => {
    let listed = 0
    let filtered = 0
    const catalog = new SessionCatalog({
      query: engine({
        listSessions: async () => { listed += 1; return [record('base')] },
        filterSessions: async () => { filtered += 1; return [] },
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    catalog.applyFilters(NO_FILTERS)
    await settled()
    expect({ listed, filtered }).toEqual({ listed: 2, filtered: 0 })
  })

  it('aborts and discards a filter listing superseded by another value', async () => {
    const first = deferred<SessionRecord[]>()
    const signals: AbortSignal[] = []
    let calls = 0
    const catalog = new SessionCatalog({
      query: engine({
        filterSessions: async (_filters, signal) => {
          signals.push(signal!)
          calls += 1
          return calls === 1 ? first.promise : [record('fresh')]
        },
      }),
      invalidate: () => {},
    })
    catalog.applyFilters({ ...NO_FILTERS, origin: 'own' })
    catalog.applyFilters({ ...NO_FILTERS, origin: 'delegated' })
    first.resolve([record('stale')])
    await settled()
    expect(signals[0]?.aborted).toBe(true)
    expect(catalog.listing()).toMatchObject({ kind: 'ready', entries: [] })
  })

  it('refreshes titles without asking for another listing', async () => {
    let listings = 0
    let titles = 0
    const catalog = new SessionCatalog({
      query: engine({
        listSessions: async () => { listings += 1; return [record('a')] },
        readTitleSnapshots: async () => {
          titles += 1
          return titles === 1 ? [titled('a', 'Before')] : [titled('a', 'After')]
        },
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    catalog.refreshTitles()
    await settled()
    expect(listings).toBe(1)
    expect(catalog.listing()).toMatchObject({ kind: 'ready', entries: [{ title: 'After' }] })
  })

  it('does no title work after the browser is disposed', async () => {
    // A rename finishing after the browser closed must not start a title read
    // that would repaint a live region which has moved on.
    let repaints = 0
    let titleReads = 0
    const catalog = new SessionCatalog({
      query: engine({
        listSessions: async () => [record('a')],
        readTitleSnapshots: async () => {
          titleReads += 1
          return [titled('a', 'After')]
        },
      }),
      invalidate: () => { repaints += 1 },
    })
    catalog.refresh()
    await settled()
    catalog.dispose()
    catalog.refreshTitles()
    await settled()
    expect(titleReads).toBe(1)
    expect(repaints).toBe(2)
  })

  it('refreshes active content-search titles after a rename', async () => {
    // Renaming from a content-search result must re-observe the title in the
    // cached content chain: the row the reader is looking at switches to the
    // authoritative "New title" without re-running the search.
    // Deliberate break: refreshing only the base listing leaves the content row
    // showing the pre-rename title.
    let titleReads = 0
    let searches = 0
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async () => {
          searches += 1
          return { items: [searchHit('a')] }
        },
        readTitleSnapshots: async () => {
          titleReads += 1
          return [titleReads === 1 ? titled('a', 'Old title') : titled('a', 'New title')]
        },
      }),
      invalidate: () => {},
    })
    catalog.search('needle')
    await settled()
    expect(catalog.content()).toMatchObject({ kind: 'ready', entries: [{ id: 'a', title: 'Old title' }] })
    catalog.refreshTitles()
    await settled()
    expect(catalog.content()).toMatchObject({ kind: 'ready', entries: [{ id: 'a', title: 'New title' }] })
    expect(searches).toBe(1)
  })

  it('never clears titles for pages appended while a rename refresh is in flight', async () => {
    // The content chain is appended in place by pagination. A page that lands
    // while the title batch is awaited carries ids the batch never read; the
    // patch must retitle only the captured ids and leave the appended row's own
    // title alone.
    // Deliberate break: re-titling the whole chain with the batch map turns the
    // appended row's title into undefined.
    let appendPage = (_page: SessionSearchPage<SessionSearchHit>): void => {}
    let titleCalls = 0
    const titleGate = deferred<SessionTitleObservationResult[]>()
    const cursor = SessionSearchCursor('second-page')
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async request => {
          if (request.cursor === undefined) return { items: [searchHit('first')], nextCursor: cursor }
          return new Promise<SessionSearchPage<SessionSearchHit>>(resolve => { appendPage = resolve })
        },
        readTitleSnapshots: async ids => {
          if (ids.includes('second' as SessionId)) return [titled('second', 'Second')]
          titleCalls += 1
          return titleCalls === 1 ? [] : titleGate.promise
        },
      }),
      invalidate: () => {},
    })
    catalog.search('needle')
    await settled()
    catalog.loadMoreContent()
    catalog.refreshTitles() // captures only 'first' at call time
    appendPage({ items: [searchHit('second')] })
    await settled()
    titleGate.resolve([titled('first', 'First')])
    await settled()
    const content = catalog.content()
    const titles = content.kind === 'ready'
      ? new Map(content.entries.map(entry => [entry.id, entry.title]))
      : new Map()
    expect(titles.get('first' as SessionId)).toBe('First')
    expect(titles.get('second' as SessionId)).toBe('Second')
  })

  it('applies fulfilled title observations and preserves rejected ones', async () => {
    // A rejected settlement obtains no new fact, so the previously displayed
    // authoritative title must survive; a fulfilled observation replaces it,
    // and a fulfilled observation with no title deliberately clears it.
    // Deliberate break: reading titles through `traits.get(id)?.title` turns a
    // rejected B into undefined, wiping a title that was never re-observed.
    let reads = 0
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async () => ({ items: [searchHit('a'), searchHit('b')] }),
        readTitleSnapshots: async () => {
          reads += 1
          if (reads === 1) return [titled('a', 'Old A'), titled('b', 'Old B')]
          if (reads === 2) {
            return [
              titled('a', 'New A'),
              { sessionId: 'b' as SessionId, status: 'rejected', reason: new Error('nope') },
            ]
          }
          return [
            titled('a', 'New A'),
            {
              sessionId: 'b' as SessionId,
              status: 'fulfilled',
              value: {
                session: header('b'),
              },
            },
          ]
        },
      }),
      invalidate: () => {},
    })
    catalog.search('needle')
    await settled()
    catalog.refreshTitles()
    await settled()
    let content = catalog.content()
    let byId = content.kind === 'ready' ? new Map(content.entries.map(e => [e.id, e.title])) : new Map()
    expect(byId.get('a' as SessionId)).toBe('New A')
    expect(byId.get('b' as SessionId)).toBe('Old B')
    catalog.refreshTitles()
    await settled()
    content = catalog.content()
    byId = content.kind === 'ready' ? new Map(content.entries.map(e => [e.id, e.title])) : new Map()
    expect(byId.get('a' as SessionId)).toBe('New A')
    expect(byId.get('b' as SessionId)).toBeUndefined()
  })

  it('preserves rejected lineage titles while applying fulfilled ones', async () => {
    // Same settlement policy applied to the cached lineage tree: a rejected
    // ancestor keeps its displayed title; a fulfilled no-title observation
    // clears it.
    let reads = 0
    const trace: SessionLineageTrace = {
      target: record('child', { parentSession: 'root' as SessionId }),
      ancestors: [record('root')],
      descendants: [],
      complete: true,
      root: record('root'),
    }
    const catalog = new SessionCatalog({
      query: engine({
        traceSession: async () => trace,
        readTitleSnapshots: async ids => {
          reads += 1
          if (reads === 1) return ids.map(id => titled(id, id === 'child' ? 'Old A' : 'Old B'))
          if (reads === 2) {
            return [
              { sessionId: 'child' as SessionId, status: 'fulfilled', value: {
                session: header('child', { origin: 'subagent' }),
                title: { title: 'New A', messageSeqs: [], source: { kind: 'user' }, eventSeq: 2, updatedAt: 2_000 },
              } },
              { sessionId: 'root' as SessionId, status: 'rejected', reason: new Error('nope') },
            ]
          }
          return [
            titled('child', 'New A'),
            {
              sessionId: 'root' as SessionId,
              status: 'fulfilled',
              value: {
                session: header('root'),
              },
            },
          ]
        },
      }),
      invalidate: () => {},
    })
    catalog.requestLineage('child' as SessionId)
    await settled()
    catalog.refreshTitles()
    await settled()
    let lineage = catalog.lineage('child' as SessionId)
    let rows = lineage.kind === 'ready' ? new Map(lineage.rows.filter(r => r.kind !== 'pruned').map(r => [r.id, r.title])) : new Map()
    expect(rows.get('child' as SessionId)).toBe('New A')
    expect(rows.get('root' as SessionId)).toBe('Old B')
    catalog.refreshTitles()
    await settled()
    lineage = catalog.lineage('child' as SessionId)
    rows = lineage.kind === 'ready' ? new Map(lineage.rows.filter(r => r.kind !== 'pruned').map(r => [r.id, r.title])) : new Map()
    expect(rows.get('root' as SessionId)).toBeUndefined()
  })

  it('preserves rejected base-listing titles while applying fulfilled ones', async () => {
    let reads = 0
    const catalog = new SessionCatalog({
      query: engine({
        listSessions: async () => [record('a'), record('b')],
        readTitleSnapshots: async () => {
          reads += 1
          if (reads === 1) return [titled('a', 'Old A'), titled('b', 'Old B')]
          return [
            titled('a', 'New A'),
            { sessionId: 'b' as SessionId, status: 'rejected', reason: new Error('nope') },
          ]
        },
      }),
      invalidate: () => {},
    })
    catalog.refresh()
    await settled()
    catalog.refreshTitles()
    await settled()
    const listing = catalog.listing()
    const byId = listing.kind === 'ready' ? new Map(listing.entries.map(e => [e.id, e.title])) : new Map()
    expect(byId.get('a' as SessionId)).toBe('New A')
    expect(byId.get('b' as SessionId)).toBe('Old B')
  })

  it('refreshes cached lineage titles after a rename', async () => {
    // The lineage tree may have been read earlier; reopening it must not
    // display the stale pre-rename title. The re-observation patches the cached
    // rows in place from the authoritative fold.
    // Deliberate break: refreshing only the base listing leaves the lineage
    // rows showing "Old title".
    let titleReads = 0
    const trace: SessionLineageTrace = {
      target: record('child', { parentSession: 'root' as SessionId }),
      ancestors: [record('root')],
      descendants: [],
      complete: true,
      root: record('root'),
    }
    const catalog = new SessionCatalog({
      query: engine({
        traceSession: async () => trace,
        readTitleSnapshots: async ids => {
          titleReads += 1
          return ids.map(id => (titleReads === 1 ? titled(id, 'Old title') : titled(id, 'New title')))
        },
      }),
      invalidate: () => {},
    })
    catalog.requestLineage('child' as SessionId)
    await settled()
    const before = catalog.lineage('child' as SessionId)
    expect(before.kind === 'ready' ? before.rows.map(row => row.kind === 'target' ? row.title : undefined) : []).toContain('Old title')
    catalog.refreshTitles()
    await settled()
    const after = catalog.lineage('child' as SessionId)
    expect(after.kind === 'ready' ? after.rows.map(row => row.kind === 'target' ? row.title : undefined) : []).toContain('New title')
  })
})

describe('searching what sessions said', () => {
  /** One hit whose strongest match carries an excerpt. */
  const hit: SessionSearchHit = {
    ...record('a'),
    bestMatch: {
      sessionId: 'a' as SessionId,
      seq: 4,
      type: 'user/message',
      time: 2_000,
      surface: 'current',
      snippet: '…the parser wraps CJK…',
    },
  }

  it('asks Harness, and carries its excerpt back', async () => {
    let asked: SessionSearchRequest | undefined
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async (request: SessionSearchRequest): Promise<SessionSearchPage<SessionSearchHit>> => {
          asked = request
          return { items: [hit] }
        },
        readTitleSnapshots: async () => [titled('a', 'Wrap work')],
      }),
      invalidate: () => {},
    })
    catalog.search('  cjk  ')
    expect(catalog.content()).toEqual({ kind: 'searching', query: 'cjk' })
    await settled()
    expect(asked?.query).toBe('cjk')
    expect(catalog.content()).toMatchObject({
      kind: 'ready',
      query: 'cjk',
      entries: [{ id: 'a', title: 'Wrap work', snippet: '…the parser wraps CJK…' }],
    })
  })

  it('degrades to unsupported when the backend indexes nothing', async () => {
    // The engine's two full-text methods are its only abstract surface, so a
    // deployment may implement neither. That is a capability to report, not an
    // error to paint red.
    const disabled = Object.assign(new Error('no index'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
    const catalog = new SessionCatalog({
      query: engine({ searchSessions: async () => { throw disabled } }),
      invalidate: () => {},
    })
    catalog.search('anything')
    await settled()
    expect(catalog.content()).toEqual({ kind: 'unsupported' })
  })

  it('reports any non-cursor search failure with Harness’s own reason', async () => {
    const broken = Object.assign(new Error('index generation failed'), { code: 'SESSION_QUERY_INDEX_FAILED' })
    const catalog = new SessionCatalog({
      query: engine({ searchSessions: async () => { throw broken } }),
      invalidate: () => {},
    })
    catalog.search('anything')
    await settled()
    expect(catalog.content()).toEqual({ kind: 'failed', message: 'index generation failed' })
  })

  it('cancels a superseded search through the engine’s own signal', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async (_request, exec?: SessionSearchExecContext) => {
          signals.push(exec?.signal)
          return { items: [] }
        },
      }),
      invalidate: () => {},
    })
    catalog.search('one')
    catalog.search('two')
    await settled()
    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    expect(catalog.content()).toMatchObject({ kind: 'ready', query: 'two' })
  })

  it('treats a cleared query as no search rather than a search for nothing', async () => {
    const catalog = new SessionCatalog({
      query: engine({ searchSessions: async () => { throw new Error('must not be asked') } }),
      invalidate: () => {},
    })
    catalog.search('   ')
    await settled()
    expect(catalog.content()).toEqual({ kind: 'idle' })
  })

  it('carries the captured filter request and opaque cursor across one appended page', async () => {
    const next = deferred<SessionSearchPage<SessionSearchHit>>()
    const cursor = SessionSearchCursor('opaque-one')
    const requests: SessionSearchRequest[] = []
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async request => {
          requests.push(request)
          return request.cursor === undefined
            ? { items: [searchHit('a')], nextCursor: cursor }
            : next.promise
        },
      }),
      workspace: { kind: 'cwd', cwd: '/w' },
      now: () => 10 * 24 * 60 * 60 * 1_000,
      invalidate: () => {},
    })
    catalog.applyFilters({ workspace: 'current', origin: 'all', age: '7d' })
    catalog.search('needle')
    await settled()
    catalog.loadMoreContent()
    catalog.loadMoreContent()
    expect(requests).toHaveLength(2)
    expect(requests[0]?.sessionFilters).toEqual([
      { kind: 'cwd', values: ['/w'] },
      { kind: 'created-at', from: 3 * 24 * 60 * 60 * 1_000, to: 10 * 24 * 60 * 60 * 1_000 },
    ])
    expect(requests[1]).toEqual({ ...requests[0], cursor })
    expect(catalog.content()).toMatchObject({ kind: 'ready', loadingMore: true })
    next.resolve({ items: [searchHit('b')] })
    await settled()
    expect(catalog.content()).toMatchObject({
      kind: 'ready',
      entries: [{ id: 'a' }, { id: 'b' }],
      returned: 2,
      matched: 2,
      more: false,
      loadingMore: false,
      restart: false,
    })
  })

  it('resets the chain on every fresh query and discards the previous page', async () => {
    const old = deferred<SessionSearchPage<SessionSearchHit>>()
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async request => request.query === 'old'
          ? old.promise
          : { items: [searchHit('new')] },
      }),
      invalidate: () => {},
    })
    catalog.search('old')
    catalog.search('new')
    old.resolve({ items: [searchHit('old')] })
    await settled()
    expect(catalog.content()).toMatchObject({ kind: 'ready', query: 'new', entries: [{ id: 'new' }] })
  })

  it('resigns the content search and its cursor when filters change', async () => {
    // A filter change answers a DIFFERENT request, so the retained rows and the
    // continuation cursor are discarded rather than left labelled by clauses
    // that no longer exist — and a late page from the old chain must not land.
    // Deliberate break: retaining the old rows with a stale cursor fails the
    // idle assertion below.
    const next = deferred<SessionSearchPage<SessionSearchHit>>()
    const cursor = SessionSearchCursor('old-filter-cursor')
    const requests: SessionSearchRequest[] = []
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async request => {
          requests.push(request)
          return request.cursor === undefined
            ? { items: [searchHit('kept')], nextCursor: cursor }
            : next.promise
        },
      }),
      invalidate: () => {},
      workspace: { kind: 'cwd', cwd: '/work/root' },
    })
    catalog.search('needle')
    await settled()
    catalog.loadMoreContent()
    catalog.applyFilters({ ...NO_FILTERS, origin: 'delegated' })
    next.resolve({ items: [searchHit('stale-page', { origin: 'subagent' })] })
    await settled()
    expect(catalog.content()).toEqual({ kind: 'idle' })
    // A fresh search carries the NEW filter clauses and starts cursorless.
    requests.length = 0
    catalog.applyFilters({ ...NO_FILTERS, workspace: 'current' })
    catalog.search('needle')
    await settled()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.sessionFilters).toEqual([{ kind: 'cwd', values: ['/work/root'] }])
    expect(requests[0]?.cursor).toBeUndefined()
  })

  it.each([
    'SESSION_QUERY_STALE_CURSOR',
    'SESSION_QUERY_INVALID_CURSOR',
  ])('retains accumulated rows and requests restart for %s', async code => {
    const cursor = SessionSearchCursor('expired')
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async request => {
          if (request.cursor === undefined) return { items: [searchHit('context')], nextCursor: cursor }
          throw Object.assign(new Error('cursor rejected'), { code })
        },
      }),
      invalidate: () => {},
    })
    catalog.search('needle')
    await settled()
    catalog.loadMoreContent()
    await settled()
    expect(catalog.content()).toMatchObject({
      kind: 'ready',
      entries: [{ id: 'context' }],
      more: false,
      loadingMore: false,
      restart: true,
    })
  })

  it('counts backend returns separately from presentation origin matches', async () => {
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async () => ({
          items: [searchHit('own'), searchHit('delegated', { origin: 'subagent' })],
        }),
      }),
      invalidate: () => {},
    })
    catalog.applyFilters({ ...NO_FILTERS, origin: 'own' })
    catalog.search('needle')
    await settled()
    expect(catalog.content()).toMatchObject({
      kind: 'ready',
      entries: [{ id: 'own' }],
      returned: 2,
      matched: 1,
      more: false,
    })
  })

  it('marks an empty continuation page as settled without appending rows', async () => {
    // A page that returned no retained rows still answers the load: the
    // revision must advance so the view can stop showing "Loading more…" even
    // though no row appeared. Deliberate break: no revision bump on an empty
    // page leaves the view's landing guard permanently armed.
    const cursor = SessionSearchCursor('second-cursor')
    const requests: SessionSearchRequest[] = []
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async request => {
          requests.push(request)
          return request.cursor === undefined
            ? { items: [searchHit('kept')], nextCursor: cursor }
            : { items: [], nextCursor: cursor }
        },
      }),
      invalidate: () => {},
    })
    catalog.search('needle')
    await settled()
    const before = catalog.content()
    expect(before.kind === 'ready' ? before.revision : -1).toBe(1)
    catalog.loadMoreContent()
    await settled()
    const after = catalog.content()
    expect(after).toMatchObject({ kind: 'ready', entries: [{ id: 'kept' }], more: true })
    expect(after.kind === 'ready' ? after.revision : -1).toBe(2)
  })

  it('treats a backend abort as cancellation, not as a failure', async () => {
    // When a superseding search aborts the previous one and the engine reports
    // SESSION_QUERY_ABORTED, the abort must be swallowed rather than painted as
    // a failed search for the query the reader is now looking at.
    const first = deferred<SessionSearchPage<SessionSearchHit>>()
    let firstSignal: AbortSignal | undefined
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async (_request, exec) => {
          if (firstSignal === undefined) {
            firstSignal = exec?.signal
            return first.promise
          }
          return { items: [searchHit('fresh')] }
        },
      }),
      invalidate: () => {},
    })
    catalog.search('one')
    catalog.search('two')
    first.reject(Object.assign(new Error('cancelled'), { code: 'SESSION_QUERY_ABORTED' }))
    await settled()
    expect(firstSignal?.aborted).toBe(true)
    expect(catalog.content()).toMatchObject({ kind: 'ready', query: 'two', entries: [{ id: 'fresh' }] })
  })

  it('recovers delegated origin from the authoritative observed header', async () => {
    // A search backend's persisted hit projection may omit `origin`, so a
    // delegated child's hit arrives unmarked. The batch title observation
    // resolves the authoritative live-preferred source header for the same id,
    // which carries the immutable origin metadata — the presentation-only
    // origin filter must use THAT rather than the incomplete hit header.
    // The precedence also runs the other way: a fulfilled observation whose
    // authoritative header has NO origin means `own`, even when the lossy hit
    // header claimed `subagent`.
    // Deliberate break: classifying from the hit header alone lets the
    // delegated hit vanish from "delegated" and lets the observed-own hit leak
    // in as delegated.
    const observed: SessionTitleObservationResult[] = [
      {
        sessionId: 'delegated' as SessionId,
        status: 'fulfilled',
        value: {
          session: header('delegated', { createdAt: 2_000, origin: 'subagent' }),
        },
      },
      {
        sessionId: 'observed-own' as SessionId,
        status: 'fulfilled',
        value: {
          session: header('observed-own', { createdAt: 2_000 }),
        },
      },
    ]
    const catalog = new SessionCatalog({
      query: engine({
        searchSessions: async () => ({
          items: [
            searchHit('delegated'),
            searchHit('own'),
            searchHit('observed-own', { origin: 'subagent' }),
          ],
        }),
        readTitleSnapshots: async () => observed,
      }),
      invalidate: () => {},
    })
    catalog.applyFilters({ ...NO_FILTERS, origin: 'delegated' })
    catalog.search('needle')
    await settled()
    const delegated = catalog.content()
    expect(delegated.kind === 'ready' ? delegated.entries.map(entry => entry.id) : []).toEqual(['delegated'])
    catalog.applyFilters({ ...NO_FILTERS, origin: 'own' })
    catalog.search('needle')
    await settled()
    // The unobserved hit keeps the header's own classification; the fulfilled
    // own observation keeps its authoritative reading, both `own` per the
    // SessionHeader contract — never a guessed mark.
    const own = catalog.content()
    expect(own.kind === 'ready' ? own.entries.map(entry => entry.id) : []).toEqual(['own', 'observed-own'])
  })
})

describe('the filter time anchor', () => {
  /** One instantated local time, so local-midnight arithmetic is deterministic. */
  function instant(year: number, month: number, day: number, hour: number, minute: number): number {
    return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
  }

  it('freezes a today window across listing and content search', async () => {
    // Applying "today" just before midnight and starting the content search
    // after midnight must still use the SAME creation-time range in both
    // surfaces; the anchor is captured once, at filter-application time.
    // Deliberate break: re-anchoring the age range at search time changes the
    // local-midnight `from` and fails the clause equality below.
    let clock = instant(2026, 8, 27, 23, 59, 0)
    const listingClauses: SessionResultFilter[] = []
    const requests: SessionSearchRequest[] = []
    const catalog = new SessionCatalog({
      query: engine({
        filterSessions: async clauses => {
          listingClauses.push(...clauses)
          return []
        },
        searchSessions: async request => {
          requests.push(request)
          return { items: [] }
        },
      }),
      invalidate: () => {},
      now: () => clock,
    })
    catalog.applyFilters({ ...NO_FILTERS, age: 'today' })
    await settled()
    clock = instant(2026, 8, 28, 0, 2, 0)
    catalog.search('needle')
    await settled()
    expect(requests[0]?.sessionFilters).toEqual(listingClauses)
  })

  it('freezes a rolling seven-day window at the same boundary', async () => {
    // Same contract for a rolling window: advancing past its outer edge while
    // the browser stays open must not silently widen the range.
    let clock = instant(2026, 8, 20, 12, 0, 0)
    const listingClauses: SessionResultFilter[] = []
    const requests: SessionSearchRequest[] = []
    const catalog = new SessionCatalog({
      query: engine({
        filterSessions: async clauses => {
          listingClauses.push(...clauses)
          return []
        },
        searchSessions: async request => {
          requests.push(request)
          return { items: [] }
        },
      }),
      invalidate: () => {},
      now: () => clock,
    })
    catalog.applyFilters({ ...NO_FILTERS, age: '7d' })
    await settled()
    clock = instant(2026, 8, 24, 18, 0, 0)
    catalog.search('needle')
    await settled()
    expect(requests[0]?.sessionFilters).toEqual(listingClauses)
  })

  it('re-anchors the windows when the filters are applied again', async () => {
    // Applying the filters again is the deliberate re-anchor: the same chosen
    // age window is re-read at the new application time, so two applications a
    // day apart legitimately differ.
    let clock = instant(2026, 8, 27, 23, 59, 0)
    const clauseSets: SessionResultFilter[][] = []
    const catalog = new SessionCatalog({
      query: engine({
        filterSessions: async clauses => {
          clauseSets.push([...clauses])
          return []
        },
      }),
      invalidate: () => {},
      now: () => clock,
    })
    catalog.applyFilters({ ...NO_FILTERS, age: '7d' })
    await settled()
    clock = instant(2026, 8, 28, 12, 0, 0)
    catalog.applyFilters({ ...NO_FILTERS, age: '7d' })
    await settled()
    expect(clauseSets).toHaveLength(2)
    expect(clauseSets[0]).not.toEqual(clauseSets[1])
  })
})

describe('searching within one session', () => {
  it('maps event hits and an empty final page into ready state', async () => {
    let empty = false
    const catalog = new SessionCatalog({
      query: engine({
        searchEvents: async request => ({
          session: record(request.sessionId).header,
          items: empty ? [] : [eventHit(request.sessionId, 3)],
        }),
      }),
      invalidate: () => {},
    })
    catalog.searchEvents('a' as SessionId, 'needle')
    await settled()
    expect(catalog.events()).toMatchObject({
      kind: 'ready',
      sessionId: 'a',
      query: 'needle',
      hits: [{ sessionId: 'a', seq: 3, snippet: 'event 3' }],
      more: false,
      loadingMore: false,
      restart: false,
    })
    empty = true
    catalog.searchEvents('a' as SessionId, 'nothing')
    await settled()
    expect(catalog.events()).toMatchObject({ kind: 'ready', hits: [], more: false })
  })

  it('resets on session change and discards the old selected session', async () => {
    const old = deferred<SessionEventSearchPage>()
    const catalog = new SessionCatalog({
      query: engine({
        searchEvents: async request => request.sessionId === 'a'
          ? old.promise
          : { session: record('b').header, items: [eventHit('b', 1)] },
      }),
      invalidate: () => {},
    })
    catalog.searchEvents('a' as SessionId, 'same')
    catalog.searchEvents('b' as SessionId, 'same')
    old.resolve({ session: record('a').header, items: [eventHit('a', 1)] })
    await settled()
    expect(catalog.events()).toMatchObject({ kind: 'ready', sessionId: 'b', hits: [{ sessionId: 'b' }] })
  })

  it('discards a page whose indexed header names another session', async () => {
    const catalog = new SessionCatalog({
      query: engine({
        searchEvents: async () => ({
          session: record('wrong').header,
          items: [eventHit('wrong', 1)],
        }),
      }),
      invalidate: () => {},
    })
    catalog.searchEvents('wanted' as SessionId, 'needle')
    await settled()
    expect(catalog.events()).toEqual({ kind: 'searching', sessionId: 'wanted', query: 'needle' })
  })

  it('degrades event search when both backend search surfaces are disabled', async () => {
    const disabled = Object.assign(new Error('no index'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
    const catalog = new SessionCatalog({
      query: engine({ searchEvents: async () => { throw disabled } }),
      invalidate: () => {},
    })
    catalog.searchEvents('a' as SessionId, 'needle')
    await settled()
    expect(catalog.events()).toEqual({ kind: 'unsupported' })
  })

  it('appends one opaque-cursor event page and ignores duplicate loading', async () => {
    const next = deferred<SessionEventSearchPage>()
    const cursor = SessionSearchCursor('event-page')
    let calls = 0
    const catalog = new SessionCatalog({
      query: engine({
        searchEvents: async request => {
          calls += 1
          return request.cursor === undefined
            ? { session: record('a').header, items: [eventHit('a', 1)], nextCursor: cursor }
            : next.promise
        },
      }),
      invalidate: () => {},
    })
    catalog.searchEvents('a' as SessionId, 'needle')
    await settled()
    catalog.loadMoreEvents()
    catalog.loadMoreEvents()
    expect(calls).toBe(2)
    next.resolve({ session: record('a').header, items: [eventHit('a', 2)] })
    await settled()
    expect(catalog.events()).toMatchObject({
      kind: 'ready',
      hits: [{ seq: 1 }, { seq: 2 }],
      more: false,
      loadingMore: false,
    })
  })

  it('reports Harness session-not-found failures for event browsing', async () => {
    const missing = Object.assign(new Error('session missing'), {
      code: 'SESSION_QUERY_SESSION_NOT_FOUND',
    })
    const catalog = new SessionCatalog({
      query: engine({ searchEvents: async () => { throw missing } }),
      invalidate: () => {},
    })
    catalog.searchEvents('missing' as SessionId, 'needle')
    await settled()
    expect(catalog.events()).toEqual({ kind: 'failed', message: 'session missing' })
  })

  it.each([
    'SESSION_QUERY_STALE_CURSOR',
    'SESSION_QUERY_INVALID_CURSOR',
  ])('retains event hits and requests restart for %s', async code => {
    const cursor = SessionSearchCursor('expired-event')
    const catalog = new SessionCatalog({
      query: engine({
        searchEvents: async request => {
          if (request.cursor === undefined) {
            return { session: record('a').header, items: [eventHit('a', 1)], nextCursor: cursor }
          }
          throw Object.assign(new Error('cursor rejected'), { code })
        },
      }),
      invalidate: () => {},
    })
    catalog.searchEvents('a' as SessionId, 'needle')
    await settled()
    catalog.loadMoreEvents()
    await settled()
    expect(catalog.events()).toMatchObject({
      kind: 'ready',
      hits: [{ seq: 1 }],
      more: false,
      loadingMore: false,
      restart: true,
    })
  })

  it('swallows a backend abort for a superseded event search', async () => {
    const first = deferred<SessionEventSearchPage>()
    let firstSignal: AbortSignal | undefined
    const catalog = new SessionCatalog({
      query: engine({
        searchEvents: async (_request, exec) => {
          if (firstSignal === undefined) {
            firstSignal = exec?.signal
            return first.promise
          }
          return { session: record('a').header, items: [eventHit('a', 2)] }
        },
      }),
      invalidate: () => {},
    })
    catalog.searchEvents('a' as SessionId, 'one')
    catalog.searchEvents('a' as SessionId, 'two')
    first.reject(Object.assign(new Error('cancelled'), { code: 'SESSION_QUERY_ABORTED' }))
    await settled()
    expect(firstSignal?.aborted).toBe(true)
    expect(catalog.events()).toMatchObject({
      kind: 'ready',
      query: 'two',
      hits: [{ seq: 2 }],
    })
  })
})

describe('reading one hit’s context', () => {
  it('passes the exact hit and a bounded before/after to readEvent', async () => {
    const requests: SessionEventReadRequest[] = []
    const catalog = new SessionCatalog({
      query: engine({
        readEvent: async request => {
          requests.push(request)
          return window(request.sessionId, request.seq, [
            sessionEvent(request.seq - 1, 'step/start'),
            sessionEvent(request.seq, 'user/message', { content: [{ type: 'text', text: 'the match' }] }),
            sessionEvent(request.seq + 1, 'step/end'),
          ])
        },
      }),
      invalidate: () => {},
    })
    catalog.requestEventContext('a' as SessionId, SessionSeq(5))
    await settled()
    expect(requests).toEqual([{
      sessionId: 'a',
      seq: 5,
      before: EVENT_CONTEXT_BEFORE,
      after: EVENT_CONTEXT_AFTER,
    }])
    expect(catalog.eventContext('a' as SessionId, SessionSeq(5))).toMatchObject({
      kind: 'ready',
      sessionId: 'a',
      seq: 5,
      window: { startSeq: 4, endSeq: 6, target: { seq: 5 } },
    })
  })

  it('keeps the window comfortably inside Harness’s accepted maximum', () => {
    // The engine rejects a request above this, so the constants must stay below
    // it rather than silently failing at the call site.
    expect(EVENT_CONTEXT_BEFORE).toBeGreaterThan(0)
    expect(EVENT_CONTEXT_AFTER).toBeGreaterThan(0)
    expect(EVENT_CONTEXT_BEFORE).toBeLessThan(SESSION_QUERY_READ_WINDOW_MAX)
    expect(EVENT_CONTEXT_AFTER).toBeLessThan(SESSION_QUERY_READ_WINDOW_MAX)
  })

  it('reports a failed context read truthfully', async () => {
    const missing = Object.assign(new Error('event not found'), {
      code: 'SESSION_QUERY_EVENT_NOT_FOUND',
    })
    const catalog = new SessionCatalog({
      query: engine({ readEvent: async () => { throw missing } }),
      invalidate: () => {},
    })
    catalog.requestEventContext('a' as SessionId, SessionSeq(9))
    await settled()
    expect(catalog.eventContext('a' as SessionId, SessionSeq(9))).toEqual({
      kind: 'failed',
      sessionId: 'a',
      seq: 9,
      message: 'event not found',
    })
  })

  it('reports idle for a context that belongs to a different hit', async () => {
    const catalog = new SessionCatalog({
      query: engine({ readEvent: async request => window(request.sessionId, request.seq) }),
      invalidate: () => {},
    })
    catalog.requestEventContext('a' as SessionId, SessionSeq(4))
    await settled()
    expect(catalog.eventContext('a' as SessionId, SessionSeq(4))).toMatchObject({ kind: 'ready' })
    expect(catalog.eventContext('a' as SessionId, SessionSeq(5))).toEqual({ kind: 'idle' })
    expect(catalog.eventContext('b' as SessionId, SessionSeq(4))).toEqual({ kind: 'idle' })
  })

  it('never lets a superseded read win', async () => {
    const first = deferred<SessionEventWindow>()
    let firstSignal: AbortSignal | undefined
    const catalog = new SessionCatalog({
      query: engine({
        readEvent: async (request, signal) => {
          if (request.seq === SessionSeq(1)) {
            firstSignal = signal
            return first.promise
          }
          return window('a', 2, [sessionEvent(2, 'turn/start')])
        },
      }),
      invalidate: () => {},
    })
    catalog.requestEventContext('a' as SessionId, SessionSeq(1))
    catalog.requestEventContext('a' as SessionId, SessionSeq(2))
    first.resolve(window('a', 1))
    await settled()
    expect(firstSignal?.aborted).toBe(true)
    expect(catalog.eventContext('a' as SessionId, SessionSeq(2))).toMatchObject({ kind: 'ready', seq: 2 })
    expect(catalog.eventContext('a' as SessionId, SessionSeq(1))).toEqual({ kind: 'idle' })
  })

  it('swallows a backend abort reported for a superseded read', async () => {
    const first = deferred<SessionEventWindow>()
    let firstSignal: AbortSignal | undefined
    const catalog = new SessionCatalog({
      query: engine({
        readEvent: async (request, signal) => {
          if (request.seq === SessionSeq(1)) {
            firstSignal = signal
            return first.promise
          }
          return window('a', 2, [sessionEvent(2, 'turn/start')])
        },
      }),
      invalidate: () => {},
    })
    catalog.requestEventContext('a' as SessionId, SessionSeq(1))
    catalog.requestEventContext('a' as SessionId, SessionSeq(2))
    first.reject(Object.assign(new Error('cancelled'), { code: 'SESSION_QUERY_ABORTED' }))
    await settled()
    expect(firstSignal?.aborted).toBe(true)
    expect(catalog.eventContext('a' as SessionId, SessionSeq(2))).toMatchObject({ kind: 'ready', seq: 2 })
  })

  it('aborts an in-flight context read on disposal so it cannot repaint', async () => {
    const pending = deferred<SessionEventWindow>()
    let signal: AbortSignal | undefined
    const catalog = new SessionCatalog({
      query: engine({
        readEvent: async (_request, readSignal) => {
          signal = readSignal
          return pending.promise
        },
      }),
      invalidate: () => {},
    })
    catalog.requestEventContext('a' as SessionId, SessionSeq(3))
    catalog.dispose()
    pending.resolve(window('a', 3))
    await settled()
    expect(signal?.aborted).toBe(true)
    expect(catalog.eventContext('a' as SessionId, SessionSeq(3))).toMatchObject({ kind: 'loading' })
  })

  it('performs no context read while searching or reading event state', async () => {
    // The whole disclosure model: discovery is `searchEvents()`, and a raw-log
    // window is paid for only when a hit is activated.
    // Deliberate break: refreshing context while hits land makes a plain search
    // read a session log per result row.
    let contextReads = 0
    const catalog = new SessionCatalog({
      query: engine({
        searchEvents: async request => ({
          session: record(request.sessionId).header,
          items: [eventHit(request.sessionId, 1)],
        }),
        readEvent: async request => {
          contextReads += 1
          return window(request.sessionId, request.seq)
        },
      }),
      invalidate: () => {},
    })
    catalog.searchEvents('a' as SessionId, 'needle')
    await settled()
    expect(catalog.events().kind).toBe('ready')
    catalog.loadMoreEvents()
    await settled()
    expect(catalog.eventContext('a' as SessionId, SessionSeq(1))).toEqual({ kind: 'idle' })
    expect(contextReads).toBe(0)
  })
})

describe('tracing bounded lineage', () => {
  it('flattens ancestors, target, and children and folds their titles', async () => {
    const trace: SessionLineageTrace = {
      target: record('target', { parentSession: 'root' as SessionId }),
      ancestors: [record('root')],
      descendants: [{ session: record('child', { origin: 'subagent' }), descendants: [] }],
      complete: true,
      root: record('root'),
    }
    const catalog = new SessionCatalog({
      query: engine({
        traceSession: async () => trace,
        readTitleSnapshots: async ids => ids.map(id => titled(id, `Title ${id}`)),
      }),
      invalidate: () => {},
    })
    catalog.requestLineage('target' as SessionId)
    await settled()
    expect(catalog.lineage('target' as SessionId)).toMatchObject({
      kind: 'ready',
      targetRow: 1,
      complete: true,
      rows: [
        { kind: 'ancestor', id: 'root', depth: 0, title: 'Title root' },
        { kind: 'target', id: 'target', depth: 1, title: 'Title target' },
        { kind: 'descendant', id: 'child', depth: 2, origin: 'delegated' },
      ],
    })
  })

  it('exposes an unresolved parent without inventing another lineage row', async () => {
    const catalog = new SessionCatalog({
      query: engine({
        traceSession: async () => ({
          target: record('target', { parentSession: 'missing' as SessionId }),
          ancestors: [],
          descendants: [],
          complete: false,
          unresolvedParentId: 'missing' as SessionId,
        }),
      }),
      invalidate: () => {},
    })
    catalog.requestLineage('target' as SessionId)
    await settled()
    expect(catalog.lineage('target' as SessionId)).toMatchObject({
      kind: 'ready',
      complete: false,
      unresolvedParentId: 'missing',
      rows: [{ kind: 'target', id: 'target' }],
    })
  })

  it('reports exact ancestor and descendant pruning under a small bound', () => {
    const rows = flattenLineage({
      target: record('target'),
      ancestors: [record('parent'), record('grandparent'), record('root')],
      descendants: [{
        session: record('child'),
        descendants: [{ session: record('grandchild'), descendants: [] }],
      }],
      complete: true,
      root: record('root'),
    }, { ancestors: 1, depth: 1, nodes: 1 })
    expect(rows).toMatchObject([
      { kind: 'pruned', label: '… 2 earlier ancestors' },
      { kind: 'ancestor', id: 'parent' },
      { kind: 'target', id: 'target' },
      { kind: 'descendant', id: 'child' },
      { kind: 'pruned', label: '… 1 descendants hidden' },
    ])
  })

  it('discards a trace that lands after the selection changes', async () => {
    const old = deferred<SessionLineageTrace>()
    const catalog = new SessionCatalog({
      query: engine({
        traceSession: async sessionId => sessionId === 'old'
          ? old.promise
          : {
              target: record('new'),
              ancestors: [],
              descendants: [],
              complete: true,
              root: record('new'),
            },
      }),
      invalidate: () => {},
    })
    catalog.requestLineage('old' as SessionId)
    catalog.requestLineage('new' as SessionId)
    old.resolve({
      target: record('old'),
      ancestors: [],
      descendants: [],
      complete: true,
      root: record('old'),
    })
    await settled()
    expect(catalog.lineage('new' as SessionId)).toMatchObject({
      kind: 'ready',
      rows: [{ kind: 'target', id: 'new' }],
    })
    expect(catalog.lineage('old' as SessionId)).toEqual({ kind: 'idle' })
  })

  it('dispose aborts listing, content, event, context, and lineage reads together', () => {
    const signals: AbortSignal[] = []
    const never = new Promise<never>(() => {})
    const catalog = new SessionCatalog({
      query: engine({
        filterSessions: async (_filters, signal) => { signals.push(signal!); return never },
        searchSessions: async (_request, exec) => { signals.push(exec!.signal!); return never },
        searchEvents: async (_request, exec) => { signals.push(exec!.signal!); return never },
        readEvent: async (_request, signal) => { signals.push(signal!); return never },
        traceSession: async (_sessionId, signal) => { signals.push(signal!); return never },
      }),
      invalidate: () => {},
    })
    catalog.applyFilters({ ...NO_FILTERS, origin: 'own' })
    catalog.search('content')
    catalog.searchEvents('a' as SessionId, 'event')
    catalog.requestEventContext('a' as SessionId, SessionSeq(7))
    catalog.requestLineage('a' as SessionId)
    catalog.dispose()
    expect(signals).toHaveLength(5)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })

  it('reports an invalid-lineage rejection as a failed trace, not a hidden one', async () => {
    const cyclic = Object.assign(new Error('lineage cycle'), {
      code: 'SESSION_QUERY_INVALID_LINEAGE',
    })
    const catalog = new SessionCatalog({
      query: engine({ traceSession: async () => { throw cyclic } }),
      invalidate: () => {},
    })
    catalog.requestLineage('a' as SessionId)
    await settled()
    expect(catalog.lineage('a' as SessionId)).toEqual({
      kind: 'failed',
      sessionId: 'a',
      message: 'lineage cycle',
    })
  })
})

describe('the detail one selected row costs', () => {
  /**
   * A raw-log record listing.
   * @param count - how many events.
   * @returns the records.
   */
  function events(count: number): SessionEventRecord[] {
    return Array.from({ length: count }, (_unused, index) => ({
      sessionId: 'a' as SessionId,
      seq: index,
      type: 'turn/start',
      time: 5_000 + index,
      surface: 'log-only',
    }))
  }

  it('reads one log per selection and reuses it afterwards', async () => {
    // Holding the down arrow would otherwise load a megabyte per keypress: each
    // read loads and surface-folds a whole session log.
    let reads = 0
    const catalog = new SessionCatalog({
      query: engine({
        listEvents: async () => {
          reads += 1
          return events(3)
        },
      }),
      invalidate: () => {},
    })
    catalog.requestDetail('a' as SessionId)
    catalog.requestDetail('a' as SessionId)
    await settled()
    expect(catalog.detail('a' as SessionId)).toEqual({ events: 3, lastActivityAt: 5_002 })
    catalog.requestDetail('a' as SessionId)
    await settled()
    expect(reads).toBe(1)
  })

  it('leaves the row without counts when its log cannot be listed', async () => {
    const catalog = new SessionCatalog({
      query: engine({ listEvents: async () => { throw new Error('unreadable') } }),
      invalidate: () => { throw new Error('a missing fact is not a repaint') },
    })
    catalog.requestDetail('a' as SessionId)
    await settled()
    expect(catalog.detail('a' as SessionId)).toBeUndefined()
  })

  it('reports an empty log as empty rather than as unknown', async () => {
    const catalog = new SessionCatalog({ query: engine({}), invalidate: () => {} })
    catalog.requestDetail('a' as SessionId)
    await settled()
    expect(catalog.detail('a' as SessionId)).toEqual({ events: 0, lastActivityAt: undefined })
  })
})
