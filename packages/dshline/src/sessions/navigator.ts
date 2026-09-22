/**
 * Generation-safe navigation reads within one selected session.
 *
 * This keeps event discovery, explicit event disclosure, and lineage tracing
 * reusable by session surfaces that are not corpus catalogs. It owns every
 * cancellation handle for those reads, so disposing a surface cannot let a
 * late result redraw the next one.
 * @module dshline/sessions/navigator
 */

import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  SessionEventReadRequest,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionEventWindow,
  SessionLineageTrace,
  SessionQueryErrorCode,
  SessionSearchCursor,
  SessionSearchExecContext,
  SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import { flattenLineage } from './lineage.ts'
import type {
  EventContextState,
  EventHitEntry,
  EventSearchState,
  LineageRow,
  LineageState,
} from './model.ts'

/** Full-text results requested from either search service per page. */
export const CONTENT_SEARCH_LIMIT = 50

/** Raw events read on each side of one disclosed search hit. */
export const EVENT_CONTEXT_BEFORE = 8

/** Raw events read after one disclosed search hit. */
export const EVENT_CONTEXT_AFTER = 8

/** The exact query reads required for one-session navigation. */
export interface SessionNavigationReads {
  /** Full-text search within one session. */
  searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage>
  /** Read one exact event and a bounded surrounding raw-log window. */
  readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow>
  /** Trace one session's ancestors and descendants. */
  traceSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLineageTrace>
}

/** A folded title that can safely replace a displayed lineage title. */
export interface SessionObservedTitle {
  /** The authoritative folded title, absent when the session has none. */
  readonly title?: string
}

/** Construction dependencies for a {@link SessionNavigator}. */
export interface SessionNavigatorSpec {
  /** Mounted navigation reads, or undefined when session query is unavailable. */
  readonly query: SessionNavigationReads | undefined
  /** Redraw after navigation state changes. */
  readonly invalidate: () => void
  /**
   * Observe folded titles for lineage rows.
   *
   * The catalog supplies this adapter so title settlement policy remains owned
   * by the catalog rather than duplicated by each navigation surface.
   */
  readonly observeTitles: (
    sessionIds: readonly SessionId[],
    signal?: AbortSignal,
  ) => Promise<ReadonlyMap<SessionId, SessionObservedTitle>>
}

/** Typed capability code for a deployment without either full-text surface. */
const SEARCH_DISABLED: SessionQueryErrorCode = 'SESSION_QUERY_SEARCH_DISABLED'
/** Typed cancellation code used by query backends. */
const SEARCH_ABORTED: SessionQueryErrorCode = 'SESSION_QUERY_ABORTED'
/** Cursor failures that require an explicit cursorless restart. */
const CURSOR_RESTART_CODES: readonly SessionQueryErrorCode[] = [
  'SESSION_QUERY_STALE_CURSOR',
  'SESSION_QUERY_INVALID_CURSOR',
]

interface EventChain {
  readonly chain: number
  readonly request: SessionEventSearchRequest
  readonly sessionId: SessionId
  readonly query: string
  hits: readonly EventHitEntry[]
  nextCursor: SessionSearchCursor | undefined
}

/** Read one error's machine-routable code without importing its error class. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Turn a thrown value into the line a frontend may draw. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Replace one lineage row's title from an authoritative observation. */
function withObservedTitle(
  row: Extract<LineageRow, { kind: 'ancestor' | 'target' | 'descendant' }>,
  title: string | undefined,
): LineageRow {
  const rest = {
    kind: row.kind,
    depth: row.depth,
    id: row.id,
    createdAt: row.createdAt,
    origin: row.origin,
    ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
  }
  return title === undefined ? rest : { ...rest, title }
}

/**
 * Fold one settled title batch into the traits lineage rows consume.
 *
 * The ONE home of Harness title-settlement policy for every navigation surface:
 * a fulfilled observation contributes an entry even when the log carries no
 * title (which is how a stale displayed title is cleared), a rejected member is
 * dropped rather than propagated, and an empty title is an absence rather than
 * a placeholder. Both the corpus catalog and the attached-session hub pass
 * their `readTitleSnapshots` results through here, so the two cannot drift.
 * @param results - the batch's ordered settlements.
 * @returns traits by session id for every fulfilled observation.
 */
export function observedTitleTraits(
  results: readonly SessionTitleObservationResult[],
): Map<SessionId, SessionObservedTitle> {
  const traits = new Map<SessionId, SessionObservedTitle>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const title = result.value.title?.title
    traits.set(result.sessionId, title !== undefined && title !== '' ? { title } : {})
  }
  return traits
}

/** Generation-safe event and lineage navigation for one session surface. */
export class SessionNavigator {
  private eventState: EventSearchState = { kind: 'idle' }
  private eventContextState: EventContextState = { kind: 'idle' }
  private lineageState: LineageState = { kind: 'idle' }
  private eventGeneration = 0
  private eventContextGeneration = 0
  private lineageGeneration = 0
  private eventAbort: AbortController | undefined
  private eventContextAbort: AbortController | undefined
  private lineageAbort: AbortController | undefined
  private eventChain: EventChain | undefined
  /** A revision changes for an empty settled page too. */
  private pageRevision = 0
  private disposed = false

  /**
   * @param spec - the navigation reads and redraw callback.
   */
  constructor(private readonly spec: SessionNavigatorSpec) {}

  /** @returns the current within-session event search state. */
  events(): EventSearchState {
    return this.eventState
  }

  /**
   * @param sessionId - the hit's owning session.
   * @param seq - the hit's event sequence number.
   * @returns context only when it belongs to that exact hit.
   */
  eventContext(sessionId: SessionId, seq: SessionSeq): EventContextState {
    if (this.eventContextState.kind === 'idle') return this.eventContextState
    return this.eventContextState.sessionId === sessionId && this.eventContextState.seq === seq
      ? this.eventContextState
      : { kind: 'idle' }
  }

  /**
   * @param sessionId - the selected session.
   * @returns lineage only when it belongs to that selected session.
   */
  lineage(sessionId: SessionId): LineageState {
    if (this.lineageState.kind === 'idle') return this.lineageState
    return this.lineageState.sessionId === sessionId ? this.lineageState : { kind: 'idle' }
  }

  /**
   * @returns the current lineage state for catalog title reconciliation.
   */
  lineageSnapshot(): LineageState {
    return this.lineageState
  }

  /**
   * Start a fresh cursorless event search within one session.
   * @param sessionId - the selected session.
   * @param text - backend-interpreted query text.
   * @returns nothing.
   */
  searchEvents(sessionId: SessionId, text: string): void {
    const query = this.spec.query
    if (query === undefined) return
    const trimmed = text.trim()
    const generation = (this.eventGeneration += 1)
    this.eventAbort?.abort()
    this.eventAbort = undefined
    if (trimmed === '') {
      this.eventChain = undefined
      this.eventState = { kind: 'idle' }
      this.spec.invalidate()
      return
    }
    const request: SessionEventSearchRequest = { sessionId, query: trimmed, limit: CONTENT_SEARCH_LIMIT }
    const chain: EventChain = {
      chain: generation,
      request,
      sessionId,
      query: trimmed,
      hits: [],
      nextCursor: undefined,
    }
    this.eventChain = chain
    this.eventState = { kind: 'searching', sessionId, query: trimmed }
    this.spec.invalidate()
    this.requestEventPage(query, chain, undefined)
  }

  /** Append the next within-session event page when its cursor remains valid. */
  loadMoreEvents(): void {
    const query = this.spec.query
    const chain = this.eventChain
    const state = this.eventState
    if (query === undefined || chain === undefined || state.kind !== 'ready') return
    if (state.loadingMore || state.restart || !state.more || chain.nextCursor === undefined) return
    this.eventState = { ...state, loadingMore: true }
    this.spec.invalidate()
    this.requestEventPage(query, chain, chain.nextCursor)
  }

  /**
   * Read one disclosed hit's exact target event and bounded raw-log window.
   * @param sessionId - the hit's owning session.
   * @param seq - the hit's event sequence number.
   * @returns nothing.
   */
  requestEventContext(sessionId: SessionId, seq: SessionSeq): void {
    const query = this.spec.query
    if (query === undefined) return
    const generation = (this.eventContextGeneration += 1)
    this.eventContextAbort?.abort()
    const abort = new AbortController()
    this.eventContextAbort = abort
    this.eventContextState = { kind: 'loading', sessionId, seq }
    this.spec.invalidate()
    void (async (): Promise<void> => {
      try {
        const request: SessionEventReadRequest = {
          sessionId,
          seq,
          before: EVENT_CONTEXT_BEFORE,
          after: EVENT_CONTEXT_AFTER,
        }
        const window = await query.readEvent(request, abort.signal)
        if (this.stale(generation, this.eventContextGeneration)) return
        this.eventContextState = { kind: 'ready', sessionId, seq, window }
      } catch (error: unknown) {
        if (this.stale(generation, this.eventContextGeneration)) return
        if (errorCode(error) === SEARCH_ABORTED) return
        this.eventContextState = { kind: 'failed', sessionId, seq, message: reason(error) }
      }
      this.spec.invalidate()
    })()
  }

  /**
   * Request and flatten the selected session's lineage.
   * @param sessionId - the selected session.
   * @returns nothing.
   */
  requestLineage(sessionId: SessionId): void {
    const query = this.spec.query
    if (query === undefined) return
    const generation = (this.lineageGeneration += 1)
    this.lineageAbort?.abort()
    const abort = new AbortController()
    this.lineageAbort = abort
    this.lineageState = { kind: 'loading', sessionId }
    this.spec.invalidate()
    void (async (): Promise<void> => {
      try {
        const trace = await query.traceSession(sessionId, abort.signal)
        const rows = flattenLineage(trace)
        const ids = rows.flatMap(row => row.kind === 'pruned' ? [] : [row.id])
        const titles = await this.spec.observeTitles(ids, abort.signal)
        if (this.stale(generation, this.lineageGeneration)) return
        const titledRows = rows.map(row => this.titleLineageRow(row, titles))
        const targetRow = titledRows.findIndex(row => row.kind === 'target')
        this.lineageState = {
          kind: 'ready',
          sessionId,
          rows: titledRows,
          targetRow,
          complete: trace.complete,
          ...trace.complete ? {} : { unresolvedParentId: trace.unresolvedParentId },
        }
      } catch (error: unknown) {
        if (this.stale(generation, this.lineageGeneration)) return
        if (errorCode(error) === SEARCH_ABORTED) return
        this.lineageState = { kind: 'failed', sessionId, message: reason(error) }
      }
      this.spec.invalidate()
    })()
  }

  /**
   * Apply a catalog-owned title observation to the exact lineage snapshot read.
   * @param snapshot - lineage state captured before observing titles.
   * @param titles - authoritative fulfilled title observations.
   * @returns whether the displayed lineage changed.
   */
  reconcileLineageTitles(
    snapshot: LineageState,
    titles: ReadonlyMap<SessionId, SessionObservedTitle>,
  ): boolean {
    if (snapshot.kind !== 'ready' || this.lineageState !== snapshot) return false
    this.lineageState = {
      ...snapshot,
      rows: snapshot.rows.map(row => {
        if (row.kind === 'pruned') return row
        const observed = titles.get(row.id)
        return observed === undefined ? row : withObservedTitle(row, observed.title)
      }),
    }
    return true
  }

  /** Abort every in-flight navigation read and reject all late settlements. */
  dispose(): void {
    this.disposed = true
    this.cancelReads()
  }

  /**
   * Abandon in-flight reads and return the navigation surface to idle.
   *
   * Separate from {@link dispose} because a surface can close and reopen over
   * the life of one attachment: the reads must be aborted so a late page cannot
   * repaint, but the navigator stays usable for the next open. The state is
   * reset to `idle` rather than left at `loading`, because an aborted read has
   * no page coming and `loading` would be a promise nothing will keep.
   *
   * Disposal deliberately does NOT reset the state: the corpus browser asserts
   * its last reading after closing, and the catalog owns those states for its
   * whole (one-open) life.
   */
  abort(): void {
    this.cancelReads()
    this.eventChain = undefined
    this.eventState = { kind: 'idle' }
    this.eventContextState = { kind: 'idle' }
    this.lineageState = { kind: 'idle' }
  }

  /** Bump every generation and abort every live read, leaving state untouched. */
  private cancelReads(): void {
    this.eventGeneration += 1
    this.eventContextGeneration += 1
    this.lineageGeneration += 1
    this.eventAbort?.abort()
    this.eventContextAbort?.abort()
    this.lineageAbort?.abort()
    this.eventAbort = undefined
    this.eventContextAbort = undefined
    this.lineageAbort = undefined
  }

  private requestEventPage(
    query: SessionNavigationReads,
    chain: EventChain,
    cursor: SessionSearchCursor | undefined,
  ): void {
    const abort = new AbortController()
    this.eventAbort = abort
    void (async (): Promise<void> => {
      try {
        const request = cursor === undefined ? chain.request : { ...chain.request, cursor }
        const page = await query.searchEvents(request, { signal: abort.signal })
        if (!this.currentEventChain(chain) || page.session.id !== chain.sessionId) return
        chain.hits = [...chain.hits, ...page.items.map(hit => ({
          sessionId: hit.sessionId,
          seq: hit.seq,
          type: hit.type,
          time: hit.time,
          snippet: hit.snippet,
        }))]
        chain.nextCursor = page.nextCursor
        this.pageRevision += 1
        this.eventState = {
          kind: 'ready',
          sessionId: chain.sessionId,
          query: chain.query,
          hits: chain.hits,
          more: page.nextCursor !== undefined,
          loadingMore: false,
          restart: false,
          revision: this.pageRevision,
        }
      } catch (error: unknown) {
        if (!this.currentEventChain(chain)) return
        const code = errorCode(error)
        if (code === SEARCH_ABORTED) return
        if (code === SEARCH_DISABLED) {
          this.eventState = { kind: 'unsupported' }
        } else if (CURSOR_RESTART_CODES.includes(code as SessionQueryErrorCode)) {
          this.pageRevision += 1
          this.eventState = {
            kind: 'ready',
            sessionId: chain.sessionId,
            query: chain.query,
            hits: chain.hits,
            more: false,
            loadingMore: false,
            restart: true,
            revision: this.pageRevision,
          }
        } else {
          this.eventState = { kind: 'failed', message: reason(error) }
        }
      }
      this.spec.invalidate()
    })()
  }

  private currentEventChain(chain: EventChain): boolean {
    return !this.stale(chain.chain, this.eventGeneration) && this.eventChain === chain
  }

  private titleLineageRow(
    row: LineageRow,
    titles: ReadonlyMap<SessionId, SessionObservedTitle>,
  ): LineageRow {
    if (row.kind === 'pruned') return row
    const title = titles.get(row.id)?.title
    return title === undefined ? row : { ...row, title }
  }

  private stale(generation: number, current: number): boolean {
    return this.disposed || generation !== current
  }
}
