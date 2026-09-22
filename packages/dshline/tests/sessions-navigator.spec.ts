/** Focused invariants for reusable one-session navigation reads. */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventSearchPage,
  SessionEventWindow,
  SessionLineageTrace,
  SessionSearchCursor,
} from '@deepseek-ai/dsh-session-query'
import { SessionNavigator } from '../src/sessions/navigator.ts'

/** Let the navigator's own awaits settle before asserting its state. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
}

/** A promise whose completion a test controls. */
function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

/** A structurally valid session header for navigation fixtures. */
function header(id: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: id as SessionId,
    createdAt: 1_000,
    isSeeded: false,
  } as SessionHeader
}

/** A minimal corpus record accepted by the lineage flattener. */
function record(id: string) {
  return { header: header(id), live: false, persisted: true }
}

/** Construct a navigator with safe no-op reads, then apply test overrides. */
function navigator(overrides: Partial<ConstructorParameters<typeof SessionNavigator>[0]> = {}) {
  return new SessionNavigator({
    query: {
      searchEvents: async request => ({ session: header(request.sessionId), items: [] } as SessionEventSearchPage),
      readEvent: async () => { throw new Error('not requested') },
      traceSession: async sessionId => ({
        target: record(sessionId), ancestors: [], descendants: [], complete: true, root: record(sessionId),
      } as SessionLineageTrace),
    },
    invalidate: () => {},
    observeTitles: async () => new Map(),
    ...overrides,
  })
}

describe('SessionNavigator', () => {
  it('aborts a superseded event search and keeps only the newer state', async () => {
    let firstSignal: AbortSignal | undefined
    let calls = 0
    const nav = navigator({
      query: {
        searchEvents: async (request, exec) => {
          calls += 1
          if (calls === 1) {
            firstSignal = exec?.signal
            return new Promise<SessionEventSearchPage>(() => {})
          }
          return {
            session: header(request.sessionId),
            items: [{
              sessionId: request.sessionId,
              seq: SessionSeq(2),
              type: 'user/message',
              time: 2_000,
              surface: 'current',
              snippet: 'new',
            }],
          } as SessionEventSearchPage
        },
        readEvent: async () => { throw new Error('not requested') },
        traceSession: async sessionId => ({
          target: record(sessionId), ancestors: [], descendants: [], complete: true, root: record(sessionId),
        } as SessionLineageTrace),
      },
    })
    nav.searchEvents('a' as SessionId, 'old')
    nav.searchEvents('a' as SessionId, 'new')
    await settled()
    expect(firstSignal?.aborted).toBe(true)
    expect(nav.events()).toMatchObject({ kind: 'ready', query: 'new', hits: [{ seq: 2 }] })
  })

  it('aborts every one-session read on disposal', () => {
    const signals: AbortSignal[] = []
    const never = new Promise<never>(() => {})
    const nav = navigator({
      query: {
        searchEvents: async (_request, exec) => { signals.push(exec!.signal!); return never },
        readEvent: async (_request, signal) => { signals.push(signal!); return never },
        traceSession: async (_sessionId, signal) => { signals.push(signal!); return never },
      },
    })
    nav.searchEvents('a' as SessionId, 'needle')
    nav.requestEventContext('a' as SessionId, SessionSeq(1))
    nav.requestLineage('a' as SessionId)
    nav.dispose()
    expect(signals).toHaveLength(3)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })

  it('binds lineage title reconciliation to its captured trace', async () => {
    const nav = navigator({
      query: {
        searchEvents: async request => ({ session: header(request.sessionId), items: [] } as SessionEventSearchPage),
        readEvent: async () => { throw new Error('not requested') },
        traceSession: async sessionId => ({
          target: record(sessionId), ancestors: [], descendants: [], complete: true, root: record(sessionId),
        } as SessionLineageTrace),
      },
      observeTitles: async ids => new Map(ids.map(id => [id, { title: 'Initial' }])),
    })
    nav.requestLineage('a' as SessionId)
    await settled()
    const snapshot = nav.lineageSnapshot()
    nav.requestLineage('b' as SessionId)
    await settled()
    expect(nav.reconcileLineageTitles(snapshot, new Map([['a' as SessionId, { title: 'stale' }]]))).toBe(false)
    expect(nav.lineage('b' as SessionId)).toMatchObject({ kind: 'ready', rows: [{ title: 'Initial' }] })
  })

  it('never lets a superseded context read paint under a later hit', async () => {
    const first = deferred<SessionEventWindow>()
    const second = deferred<SessionEventWindow>()
    let calls = 0
    const nav = navigator({
      query: {
        searchEvents: async request => ({ session: header(request.sessionId), items: [] } as SessionEventSearchPage),
        readEvent: async () => {
          calls += 1
          return calls === 1 ? first.promise : second.promise
        },
        traceSession: async sessionId => ({
          target: record(sessionId), ancestors: [], descendants: [], complete: true, root: record(sessionId),
        } as SessionLineageTrace),
      },
    })
    nav.requestEventContext('a' as SessionId, SessionSeq(1))
    nav.requestEventContext('a' as SessionId, SessionSeq(2))
    // The first read settles after the reader already moved: it must not paint.
    first.resolve({ target: { seq: 1 } } as unknown as SessionEventWindow)
    await settled()
    expect(nav.eventContext('a' as SessionId, SessionSeq(1))).toEqual({ kind: 'idle' })
    second.resolve({ target: { seq: 2 } } as unknown as SessionEventWindow)
    await settled()
    expect(nav.eventContext('a' as SessionId, SessionSeq(2))).toMatchObject({ kind: 'ready', seq: 2 })
  })

  it('keeps a newer lineage request when an older trace settles late', async () => {
    const first = deferred<SessionLineageTrace>()
    const second = deferred<SessionLineageTrace>()
    let calls = 0
    const nav = navigator({
      query: {
        searchEvents: async request => ({ session: header(request.sessionId), items: [] } as SessionEventSearchPage),
        readEvent: async () => { throw new Error('not requested') },
        traceSession: async () => {
          calls += 1
          return calls === 1 ? first.promise : second.promise
        },
      },
    })
    nav.requestLineage('a' as SessionId)
    nav.requestLineage('b' as SessionId)
    first.resolve({
      target: record('a'), ancestors: [], descendants: [], complete: true, root: record('a'),
    } as SessionLineageTrace)
    await settled()
    expect(nav.lineage('b' as SessionId)).toMatchObject({ kind: 'loading', sessionId: 'b' })
    second.resolve({
      target: record('b'), ancestors: [], descendants: [], complete: true, root: record('b'),
    } as SessionLineageTrace)
    await settled()
    expect(nav.lineage('b' as SessionId)).toMatchObject({ kind: 'ready', sessionId: 'b' })
    // And the abandoned target never becomes readable through this surface.
    expect(nav.lineage('a' as SessionId)).toEqual({ kind: 'idle' })
  })

  it('restarts on a stale cursor instead of presenting a partial page as complete', async () => {
    let calls = 0
    const nav = navigator({
      query: {
        searchEvents: async (request): Promise<SessionEventSearchPage> => {
          calls += 1
          if (calls === 1) {
            return {
              session: header(request.sessionId),
              items: [{
                sessionId: request.sessionId,
                seq: SessionSeq(1),
                type: 'user/message',
                time: 1,
                surface: 'current',
                snippet: 'first',
              }],
              nextCursor: 'opaque' as unknown as SessionSearchCursor,
            } as SessionEventSearchPage
          }
          const stale = Object.assign(new Error('stale'), { code: 'SESSION_QUERY_STALE_CURSOR' })
          throw stale
        },
        readEvent: async () => { throw new Error('not requested') },
        traceSession: async sessionId => ({
          target: record(sessionId), ancestors: [], descendants: [], complete: true, root: record(sessionId),
        } as SessionLineageTrace),
      },
    })
    nav.searchEvents('a' as SessionId, 'q')
    await settled()
    expect(nav.events()).toMatchObject({ kind: 'ready', more: true, hits: [{ seq: 1 }] })
    nav.loadMoreEvents()
    await settled()
    // The retained page stays, and `restart` is the honest signal that the
    // cursor was refused rather than the list being complete.
    expect(nav.events()).toMatchObject({ kind: 'ready', restart: true, hits: [{ seq: 1 }] })
  })

  it('aborts in-flight reads on demand and returns the surface to idle', async () => {
    // `abort` is what a closed hub calls: the reads stop, and `loading` must
    // not survive as a promise nothing will keep if the hub is reopened.
    const signals: AbortSignal[] = []
    const nav = navigator({
      query: {
        searchEvents: async (_request, exec) => { signals.push(exec!.signal!); return new Promise(() => {}) },
        readEvent: async (_request, signal) => { signals.push(signal!); return new Promise(() => {}) },
        traceSession: async (_sessionId, signal) => { signals.push(signal!); return new Promise(() => {}) },
      },
    })
    nav.searchEvents('a' as SessionId, 'needle')
    nav.requestEventContext('a' as SessionId, SessionSeq(1))
    nav.requestLineage('a' as SessionId)
    nav.abort()
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(nav.events()).toEqual({ kind: 'idle' })
    expect(nav.eventContext('a' as SessionId, SessionSeq(1))).toEqual({ kind: 'idle' })
    expect(nav.lineage('a' as SessionId)).toEqual({ kind: 'idle' })
    // Still usable: abort is not disposal.
    nav.searchEvents('a' as SessionId, 'again')
    expect(nav.events()).toMatchObject({ kind: 'searching', query: 'again' })
  })
})
