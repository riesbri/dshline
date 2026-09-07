/**
 * Generation-safe reads of the Harness-owned session corpus.
 *
 * Listing and exact relationship reads use concrete query-engine services.
 * Full-text session and event search remain optional backend capabilities. No
 * persistence scan or frontend index exists here: Harness owns corpus order,
 * filtering, search ranking, cursor validity, and lineage.
 * @module dshline/sessions/catalog
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventRecord,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionLineageTrace,
  SessionQueryErrorCode,
  SessionRecord,
  SessionResultFilter,
  SessionSearchCursor,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
  SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import {
  applyOrigin,
  equalFilters,
  EVERY_WORKSPACE,
  NO_FILTERS,
  sessionFilterClauses,
  type SessionFiltersValue,
  type SessionWorkspace,
} from './filters.ts'
import { flattenLineage } from './lineage.ts'
import type {
  CatalogState,
  ContentState,
  EventHitEntry,
  EventSearchState,
  LineageRow,
  LineageState,
  SessionDetail,
  SessionEntry,
  SessionOrigin,
} from './model.ts'

/**
 * The exact `ctx.sessionQuery` read surface consumed by the Sessions catalog.
 */
export interface SessionQueryReads {
  /** The complete logical corpus, newest first. */
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]>
  /** The complete matching logical corpus in Harness order. */
  filterSessions(
    filters: readonly SessionResultFilter[],
    signal?: AbortSignal,
  ): Promise<SessionRecord[]>
  /** Folded titles for many sessions from one corpus observation. */
  readTitleSnapshots(
    sessionIds: readonly SessionId[],
    signal?: AbortSignal,
  ): Promise<SessionTitleObservationResult[]>
  /** Lightweight per-event records for one session. */
  listEvents(sessionId: SessionId): Promise<SessionEventRecord[]>
  /** Full-text search across the corpus; an abstract backend surface. */
  searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>>
  /** Full-text search within one session; an abstract backend surface. */
  searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage>
  /** Concrete ancestry and descendant tracing over the logical corpus. */
  traceSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLineageTrace>
}

/** What the catalog needs from its owner. */
export interface SessionCatalogSpec {
  /** The mounted session-query engine, or undefined in a profile without one. */
  readonly query: SessionQueryReads | undefined
  /** Redraw after catalog state changes. */
  readonly invalidate: () => void
  /** Rows to keep from one listing; omitted, {@link CATALOG_LIMIT} applies. */
  readonly limit?: number
  /**
   * The exact corpus scope the `current` workspace filter narrows to.
   *
   * An arbitrary scope rather than "this window's directory": `/sessions`
   * supplies the attached session's own workspace and `/worktrees` supplies
   * the workspace a reader selected, and both reach the same
   * `filterSessions` translation. Omitted, nothing narrows by workspace.
   */
  readonly workspace?: SessionWorkspace
  /** Current time source; omitted, `Date.now` applies. */
  readonly now?: () => number
}

/** Maximum rows retained from the authoritative listing corpus. */
export const CATALOG_LIMIT = 200

/** Full-text results requested from either search service per page. */
export const CONTENT_SEARCH_LIMIT = 50

/** Typed capability code for a deployment without either full-text surface. */
const SEARCH_DISABLED: SessionQueryErrorCode = 'SESSION_QUERY_SEARCH_DISABLED'
/** Typed cancellation code used by query backends. */
const SEARCH_ABORTED: SessionQueryErrorCode = 'SESSION_QUERY_ABORTED'
/** Cursor failures that require an explicit cursorless restart. */
const CURSOR_RESTART_CODES: readonly SessionQueryErrorCode[] = [
  'SESSION_QUERY_STALE_CURSOR',
  'SESSION_QUERY_INVALID_CURSOR',
]

interface ContentChain {
  readonly chain: number
  readonly filterGeneration: number
  readonly request: SessionSearchRequest
  readonly query: string
  entries: readonly SessionEntry[]
  returned: number
  nextCursor: SessionSearchCursor | undefined
}

interface EventChain {
  readonly chain: number
  readonly request: SessionEventSearchRequest
  readonly sessionId: SessionId
  readonly query: string
  hits: readonly EventHitEntry[]
  nextCursor: SessionSearchCursor | undefined
}

/**
 * Read one error's machine-routable code without importing the error class.
 * @param error - a thrown value from the query engine.
 * @returns its `code`, when it carries a string one.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * A thrown value as a line the frontend may draw.
 * @param error - the thrown value.
 * @returns its message; untrusted, so the view still escapes it.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One settled title observation's presentation traits. */
interface ObservedTraits {
  /** Folded title, present when the log carried a non-empty one. */
  readonly title?: string
  /**
   * Authoritative live-preferred header origin.
   *
   * `SessionHeader.origin` is immutable metadata and is only ever `subagent`
   * or absent; a search backend's own hit projection may omit it, so the
   * observed source header from the title read restores it.
   */
  readonly origin?: 'subagent'
}

/**
 * The delegated-or-own classification of one corpus record.
 *
 * A fulfilled title observation's live-preferred source header is the
 * authoritative reading: an absent origin means `own`, because the header
 * contract records `subagent` whenever the session is delegated. Only a
 * rejected or missing observation falls back to the hit's own header — which
 * may itself have omitted the field, but is then all Harness gave us.
 * @param record - the corpus or search-hit record.
 * @param trait - the settled observation, when one resolved for this session.
 * @returns the presentation origin.
 */
function classifyOrigin(record: SessionRecord, trait: ObservedTraits | undefined): SessionOrigin {
  const origin = trait === undefined ? record.header.origin : trait.origin
  return origin === 'subagent' ? 'delegated' : 'own'
}

/**
 * Turn one corpus record and its observed traits into a listable entry.
 * @param record - the logical-corpus record.
 * @param trait - the settled title observation for this id, when it resolved.
 * @param snippet - a provider excerpt, when this is a search result.
 * @returns the entry.
 */
function toEntry(record: SessionRecord, trait: ObservedTraits | undefined, snippet?: string): SessionEntry {
  return {
    id: record.header.id,
    title: trait?.title,
    createdAt: record.header.createdAt,
    cwd: record.header.cwd,
    live: record.live,
    persisted: record.persisted,
    parent: record.header.parentSession,
    origin: classifyOrigin(record, trait),
    ...snippet === undefined ? {} : { snippet },
  }
}

/**
 * Fold a batch title observation into per-session presentation traits.
 *
 * Every fulfilled settlement stores an entry, even one with no title and no
 * origin: fulfilment means an authoritative observed header exists, which the
 * caller must be able to tell apart from a rejected or missing observation.
 * A rejected member is dropped rather than propagated: the batch isolates
 * per-session failures on purpose, and a session whose title could not be read
 * is still listable and still resumable — showing it untitled is the honest
 * reading, where dropping the row would hide a session that exists.
 * @param results - the batch's ordered settlements.
 * @returns traits by session id for every fulfilled observation.
 */
function observedTraits(results: readonly SessionTitleObservationResult[]): Map<SessionId, ObservedTraits> {
  const traits = new Map<SessionId, ObservedTraits>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const title = result.value.title?.title
    traits.set(result.sessionId, {
      ...title !== undefined && title !== '' ? { title } : {},
      ...(result.value.session.origin === 'subagent'
        ? { origin: result.value.session.origin }
        : {}),
    })
  }
  return traits
}

/**
 * Replace one lineage row's displayed title from an authoritative observation.
 *
 * The optional `title` property must be omitted — never set to `undefined` —
 * under `exactOptionalPropertyTypes`.
 * @param row - an ancestor, target, or descendant row.
 * @param title - the observed folded title, when the log carries one.
 * @returns the row carrying no stale title and the fresh reading.
 */
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
 * Apply one settlement batch to a displayed session entry.
 *
 * The distinction is the whole point: a FULFILLED observation is authoritative
 * — a present title replaces the displayed one, and a fulfilled observation
 * with no title deliberately clears it — while a REJECTED (or otherwise
 * missing) observation obtains no new fact, so the previous displayed
 * observation is preserved exactly rather than wiped by an absent map entry.
 * @param entry - the displayed entry.
 * @param traits - the settled batch, keyed by session id.
 * @returns the entry with its title reconciled, or the same entry untouched.
 */
function applyObservedTitle(entry: SessionEntry, traits: ReadonlyMap<SessionId, ObservedTraits>): SessionEntry {
  const observed = traits.get(entry.id)
  return observed === undefined ? entry : { ...entry, title: observed.title }
}

/**
 * Apply one settlement batch to a cached lineage row.
 * @param row - the displayed row.
 * @param traits - the settled batch, keyed by session id.
 * @returns the row with its title reconciled, or the same row untouched.
 */
function applyObservedLineageTitle(row: LineageRow, traits: ReadonlyMap<SessionId, ObservedTraits>): LineageRow {
  if (row.kind === 'pruned') return row
  const observed = traits.get(row.id)
  return observed === undefined ? row : withObservedTitle(row, observed.title)
}

/** The generation-safe data source behind the Sessions browser. */
export class SessionCatalog {
  private base: CatalogState
  private contentState: ContentState = { kind: 'idle' }
  private eventState: EventSearchState = { kind: 'idle' }
  private lineageState: LineageState = { kind: 'idle' }
  private filterValue: SessionFiltersValue = NO_FILTERS
  /**
   * The application-time anchor for the current filter's age windows.
   *
   * Captured when the filters are applied and reused by every listing and
   * content search until the filters change again, so "today" means the same
   * range in list mode and content mode even when local midnight passes while
   * the browser stays open. Untouched by query edits or mode switches; only
   * applying the filters again captures a new anchor.
   */
  private filterAnchor = 0
  private readonly details = new Map<SessionId, SessionDetail>()
  private readonly detailsInFlight = new Set<SessionId>()
  private listingGeneration = 0
  private titleGeneration = 0
  private filterGeneration = 0
  private searchGeneration = 0
  private eventGeneration = 0
  private lineageGeneration = 0
  private listingAbort: AbortController | undefined
  private titleAbort: AbortController | undefined
  private searchAbort: AbortController | undefined
  private eventAbort: AbortController | undefined
  private lineageAbort: AbortController | undefined
  private contentChain: ContentChain | undefined
  private eventChain: EventChain | undefined
  /**
   * Settled-page counter for the full-text scopes.
   *
   * The views use a revision change — not a row count — to notice that a page
   * landed, because an empty page settles without appending anything.
   */
  private pageRevision = 0
  private disposed = false

  constructor(private readonly spec: SessionCatalogSpec) {
    this.base = spec.query === undefined ? { kind: 'unavailable' } : { kind: 'loading' }
  }

  /** The current listing state. */
  listing(): CatalogState {
    return this.base
  }

  /** The active filter value. */
  filters(): SessionFiltersValue {
    return this.filterValue
  }

  /** The optional content search's current state. */
  content(): ContentState {
    return this.contentState
  }

  /** The within-session event search's current state. */
  events(): EventSearchState {
    return this.eventState
  }

  /**
   * The lineage state for one selected session.
   * @param sessionId - the currently selected session.
   * @returns its state, or idle when the stored trace belongs to another row.
   */
  lineage(sessionId: SessionId): LineageState {
    if (this.lineageState.kind === 'idle') return this.lineageState
    return this.lineageState.sessionId === sessionId ? this.lineageState : { kind: 'idle' }
  }

  /**
   * The bounded detail already read for one session.
   * @param sessionId - the session.
   * @returns its detail, or undefined until {@link requestDetail} has landed.
   */
  detail(sessionId: SessionId): SessionDetail | undefined {
    return this.details.get(sessionId)
  }

  /** Load the unfiltered newest-first listing for backward-compatible callers. */
  refresh(): void {
    this.requestListing(NO_FILTERS, false)
  }

  /**
   * Store and apply one filter value to the complete logical corpus.
   *
   * A filter change also resigns the active content search: its pages answered
   * a request with the PREVIOUS clauses, so the retained rows and cursor are
   * simply discarded rather than left labelled by a request that no longer
   * exists. The view starts a fresh search under the new clauses.
   *
   * The application-time anchor is captured here, so age windows freeze at the
   * moment the reader applied them and stay comparable across list and content
   * modes until they are applied again.
   * @param filters - the complete replacement filter value.
   */
  applyFilters(filters: SessionFiltersValue): void {
    this.filterValue = { ...filters }
    this.filterAnchor = this.now()
    this.filterGeneration += 1
    this.searchGeneration += 1
    this.searchAbort?.abort()
    this.searchAbort = undefined
    this.contentChain = undefined
    this.contentState = { kind: 'idle' }
    this.spec.invalidate()
    this.requestListing(this.filterValue, !equalFilters(this.filterValue, NO_FILTERS))
  }

  /**
   * Re-observe titles for every live projection after a rename.
   *
   * A rename appends a log event; every projection that displays this title —
   * the bounded base listing, the active content-search chain, and any cached
   * lineage tree — is patched from ONE authoritative batch observation rather
   * than rebuilt. Nothing stored locally ever claims a title Harness did not
   * fold, and a projection replaced by a newer request while the batch was in
   * flight is left to its own generation.
   */
  refreshTitles(): void {
    const query = this.spec.query
    if (query === undefined || this.disposed) return
    const listing = this.base
    const listingGeneration = this.listingGeneration
    const contentChain = this.contentChain
    const lineage = this.lineageState
    const ids = new Set<SessionId>()
    if (listing.kind === 'ready') for (const entry of listing.entries) ids.add(entry.id)
    if (contentChain !== undefined) for (const entry of contentChain.entries) ids.add(entry.id)
    if (lineage.kind === 'ready') {
      for (const row of lineage.rows) if (row.kind !== 'pruned') ids.add(row.id)
    }
    if (ids.size === 0) return
    const generation = (this.titleGeneration += 1)
    this.titleAbort?.abort()
    const abort = new AbortController()
    this.titleAbort = abort
    void (async (): Promise<void> => {
      try {
        const traits = observedTraits(await query.readTitleSnapshots([...ids], abort.signal))
        if (this.stale(generation, this.titleGeneration) || this.disposed) return
        let changed = false
        if (this.listingGeneration === listingGeneration && this.base === listing && listing.kind === 'ready') {
          this.base = {
            ...listing,
            entries: listing.entries.map(entry => applyObservedTitle(entry, traits)),
          }
          changed = true
        }
        if (contentChain !== undefined
          && this.contentChain === contentChain
          && contentChain.filterGeneration === this.filterGeneration) {
          // Pagination appends to the chain IN PLACE, so a page that landed
          // while this batch was in flight carries ids this batch never read;
          // only the captured ids may be re-titled, and a trailing row keeps
          // whatever title its own page read had.
          contentChain.entries = contentChain.entries.map(entry => ids.has(entry.id)
            ? applyObservedTitle(entry, traits)
            : entry)
          const content = this.contentState
          if (content.kind === 'ready' && content.query === contentChain.query) {
            this.contentState = { ...content, entries: contentChain.entries }
          }
          changed = true
        }
        if (lineage.kind === 'ready' && this.lineageState === lineage) {
          this.lineageState = {
            ...lineage,
            rows: lineage.rows.map(row => applyObservedLineageTitle(row, traits)),
          }
          changed = true
        }
        if (changed) this.spec.invalidate()
      } catch (error: unknown) {
        if (this.stale(generation, this.titleGeneration)) return
        if (errorCode(error) === SEARCH_ABORTED) return
      }
    })()
  }

  /**
   * Start a fresh cursorless content search under the current filters.
   * @param text - the query, interpreted by the backend as data.
   */
  search(text: string): void {
    const query = this.spec.query
    if (query === undefined) return
    const trimmed = text.trim()
    const generation = (this.searchGeneration += 1)
    this.searchAbort?.abort()
    this.searchAbort = undefined
    if (trimmed === '') {
      this.contentChain = undefined
      this.contentState = { kind: 'idle' }
      this.spec.invalidate()
      return
    }
    const sessionFilters = sessionFilterClauses(this.filterValue, this.spec.workspace ?? EVERY_WORKSPACE, this.filterAnchor)
    const request: SessionSearchRequest = {
      query: trimmed,
      sessionFilters,
      limit: CONTENT_SEARCH_LIMIT,
    }
    const chain: ContentChain = {
      chain: generation,
      filterGeneration: this.filterGeneration,
      request,
      query: trimmed,
      entries: [],
      returned: 0,
      nextCursor: undefined,
    }
    this.contentChain = chain
    this.contentState = { kind: 'searching', query: trimmed }
    this.spec.invalidate()
    this.requestContentPage(query, chain, undefined)
  }

  /** Append the next content page when the stored opaque cursor is still usable. */
  loadMoreContent(): void {
    const query = this.spec.query
    const chain = this.contentChain
    const state = this.contentState
    if (query === undefined || chain === undefined || state.kind !== 'ready') return
    if (state.loadingMore || state.restart || !state.more) return
    if (chain.filterGeneration !== this.filterGeneration || chain.nextCursor === undefined) return
    this.contentState = { ...state, loadingMore: true }
    this.spec.invalidate()
    this.requestContentPage(query, chain, chain.nextCursor)
  }

  /** Restart the current content query without replaying its cursor. */
  restartContentSearch(): void {
    const chain = this.contentChain
    if (chain !== undefined) this.search(chain.query)
  }

  /**
   * Start a fresh cursorless event search within one session.
   * @param sessionId - the selected session.
   * @param text - the query, interpreted by the backend as data.
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
    const request: SessionEventSearchRequest = {
      sessionId,
      query: trimmed,
      limit: CONTENT_SEARCH_LIMIT,
    }
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

  /** Append the next within-session event page. */
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
   * Request and flatten the selected session's lineage.
   * @param sessionId - the selected session.
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
        const traits = observedTraits(await query.readTitleSnapshots(ids, abort.signal))
        if (this.stale(generation, this.lineageGeneration)) return
        const titledRows = rows.map(row => this.titleLineageRow(row, traits))
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
   * Ask for one session's bounded detail, at most once per session.
   * @param sessionId - the selected session.
   */
  requestDetail(sessionId: SessionId): void {
    const query = this.spec.query
    if (query === undefined) return
    if (this.details.has(sessionId) || this.detailsInFlight.has(sessionId)) return
    this.detailsInFlight.add(sessionId)
    void (async (): Promise<void> => {
      try {
        const events = await query.listEvents(sessionId)
        if (this.disposed) return
        this.details.set(sessionId, {
          events: events.length,
          lastActivityAt: events.at(-1)?.time,
        })
        this.spec.invalidate()
      } catch {
        // Failure leaves this optional fact absent; it never hides the session.
      } finally {
        this.detailsInFlight.delete(sessionId)
      }
    })()
  }

  /** Invalidate and abort every asynchronous tier owned by this catalog. */
  dispose(): void {
    this.disposed = true
    this.listingGeneration += 1
    this.titleGeneration += 1
    this.filterGeneration += 1
    this.searchGeneration += 1
    this.eventGeneration += 1
    this.lineageGeneration += 1
    this.listingAbort?.abort()
    this.titleAbort?.abort()
    this.searchAbort?.abort()
    this.eventAbort?.abort()
    this.lineageAbort?.abort()
    this.listingAbort = undefined
    this.titleAbort = undefined
    this.searchAbort = undefined
    this.eventAbort = undefined
    this.lineageAbort = undefined
  }

  private requestListing(filters: SessionFiltersValue, filtered: boolean): void {
    const query = this.spec.query
    if (query === undefined) return
    const generation = (this.listingGeneration += 1)
    this.titleGeneration += 1
    this.listingAbort?.abort()
    this.titleAbort?.abort()
    const abort = new AbortController()
    this.listingAbort = abort
    this.base = { kind: 'loading' }
    this.spec.invalidate()
    void (async (): Promise<void> => {
      try {
        const clauses = sessionFilterClauses(filters, this.spec.workspace ?? EVERY_WORKSPACE, this.filterAnchor)
        const records = filtered
          ? await query.filterSessions(clauses, abort.signal)
          : await query.listSessions(abort.signal)
        const classified = applyOrigin(
          records.map(record => toEntry(record, undefined)),
          filtered ? filters.origin : 'all',
        )
        const limit = this.spec.limit ?? CATALOG_LIMIT
        const kept = classified.slice(0, limit)
        const traits = observedTraits(await query.readTitleSnapshots(
          kept.map(entry => entry.id),
          abort.signal,
        ))
        if (this.stale(generation, this.listingGeneration)) return
        this.base = {
          kind: 'ready',
          entries: kept.map(entry => ({ ...entry, title: traits.get(entry.id)?.title })),
          truncated: classified.length - kept.length,
        }
      } catch (error: unknown) {
        if (this.stale(generation, this.listingGeneration)) return
        if (errorCode(error) === SEARCH_ABORTED) return
        this.base = { kind: 'failed', message: reason(error) }
      }
      this.spec.invalidate()
    })()
  }

  private requestContentPage(
    query: SessionQueryReads,
    chain: ContentChain,
    cursor: SessionSearchCursor | undefined,
  ): void {
    const abort = new AbortController()
    this.searchAbort = abort
    void (async (): Promise<void> => {
      try {
        const request = cursor === undefined ? chain.request : { ...chain.request, cursor }
        const page = await query.searchSessions(request, { signal: abort.signal })
        const traits = observedTraits(await query.readTitleSnapshots(
          page.items.map(hit => hit.header.id),
          abort.signal,
        ))
        if (!this.currentContentChain(chain)) return
        // A search backend's own hit projection may omit `origin`. The batch
        // title observation resolves the authoritative live-preferred source
        // header for the same id, so origin is recovered from that observed
        // header rather than guessed; a rejected observation falls back to the
        // hit's own header, which classifies an absent origin as `own` per the
        // header contract.
        const pageEntries = applyOrigin(
          page.items.map(hit => toEntry(hit, traits.get(hit.header.id), hit.bestMatch.snippet)),
          this.filterValue.origin,
        )
        chain.entries = [...chain.entries, ...pageEntries]
        chain.returned += page.items.length
        chain.nextCursor = page.nextCursor
        this.pageRevision += 1
        this.contentState = {
          kind: 'ready',
          query: chain.query,
          entries: chain.entries,
          returned: chain.returned,
          matched: chain.entries.length,
          more: page.nextCursor !== undefined,
          loadingMore: false,
          restart: false,
          revision: this.pageRevision,
        }
      } catch (error: unknown) {
        if (!this.currentContentChain(chain)) return
        const code = errorCode(error)
        if (code === SEARCH_ABORTED) return
        if (code === SEARCH_DISABLED) {
          this.contentState = { kind: 'unsupported' }
        } else if (CURSOR_RESTART_CODES.includes(code as SessionQueryErrorCode)) {
          this.pageRevision += 1
          this.contentState = {
            kind: 'ready',
            query: chain.query,
            entries: chain.entries,
            returned: chain.returned,
            matched: chain.entries.length,
            more: false,
            loadingMore: false,
            restart: true,
            revision: this.pageRevision,
          }
        } else {
          this.contentState = { kind: 'failed', message: reason(error) }
        }
      }
      this.spec.invalidate()
    })()
  }

  private requestEventPage(
    query: SessionQueryReads,
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

  private currentContentChain(chain: ContentChain): boolean {
    return !this.stale(chain.chain, this.searchGeneration)
      && this.contentChain === chain
      && chain.filterGeneration === this.filterGeneration
  }

  private currentEventChain(chain: EventChain): boolean {
    return !this.stale(chain.chain, this.eventGeneration)
      && this.eventChain === chain
  }

  private titleLineageRow(row: LineageRow, traits: ReadonlyMap<SessionId, ObservedTraits>): LineageRow {
    if (row.kind === 'pruned') return row
    const title = traits.get(row.id)?.title
    return title === undefined ? row : { ...row, title }
  }

  private now(): number {
    return this.spec.now?.() ?? Date.now()
  }

  private stale(generation: number, current: number): boolean {
    return this.disposed || generation !== current
  }
}
