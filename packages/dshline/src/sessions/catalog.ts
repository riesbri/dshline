/**
 * Generation-safe reads of the Harness-owned session corpus.
 *
 * Listing and exact relationship reads use concrete query-engine services.
 * Full-text session and event search remain optional backend capabilities. No
 * persistence scan or frontend index exists here: Harness owns corpus order,
 * filtering, search ranking, cursor validity, and lineage.
 * @module dshline/sessions/catalog
 */

import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  SessionEventRecord,
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
  EVERY_WORKSPACE,
  NO_FILTERS,
  originRetained,
  sessionFilterClauses,
  type OriginChoice,
  type SessionFiltersValue,
  type SessionWorkspace,
} from './filters.ts'
import {
  CONTENT_SEARCH_LIMIT,
  observedTitleTraits,
  SessionNavigator,
  type SessionNavigationReads,
  type SessionObservedTitle,
} from './navigator.ts'
export { CONTENT_SEARCH_LIMIT, EVENT_CONTEXT_AFTER, EVENT_CONTEXT_BEFORE } from './navigator.ts'
import type {
  CatalogState,
  ContentState,
  EventContextState,
  EventSearchState,
  LineageState,
  SessionDetail,
  SessionEntry,
  SessionOrigin,
  SessionTitleHint,
  SessionTitleState,
} from './model.ts'
import { entryTitleState } from './model.ts'

/**
 * The exact `ctx.sessionQuery` read surface consumed by the Sessions catalog.
 */
export interface SessionQueryReads extends SessionNavigationReads {
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
}

/** What the catalog needs from its owner. */
export interface SessionCatalogSpec {
  /** The mounted session-query engine, or undefined in a profile without one. */
  readonly query: SessionQueryReads | undefined
  /** Redraw after catalog state changes. */
  readonly invalidate: () => void
  /**
   * Rows to keep from one listing; omitted, {@link CATALOG_LIMIT} applies.
   *
   * A non-negative safe integer. This is internal presentation configuration,
   * not corpus data, so an unusable value is rejected before any Harness read
   * rather than coerced by `Math.min`/`slice` into a fractional or `NaN`
   * truncation count. The same value is validated once for every origin mode.
   */
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
  /**
   * Optional Harness projection title hints, keyed by the listed record.
   *
   * A hint is provisional by contract: it may describe a durable prefix that
   * predates the current log. The catalog still requests exact titles for
   * visible rows, but a hit gives the picker something useful before that
   * request settles. A callback is used instead of a dshline-owned cache so
   * the projection service remains Harness's authority.
   */
  readonly titleHints?: (record: SessionRecord) => SessionTitleHint | undefined
}

/** Maximum rows retained from the authoritative listing corpus. */
export const CATALOG_LIMIT = 200

/** Maximum exact title observations requested by one visible-row batch. */
export const TITLE_BATCH_SIZE = 20

/**
 * Maximum exact title observations once a query makes the whole retained title
 * set relevant.
 *
 * Deliberately the presentation cap rather than the visible batch: the pinned
 * Harness title API repeats a full persistence listing inside every call, so
 * ten small batches would add ten directory scans. The first visible batch has
 * already opened the list before a query can arrive; one remaining bounded batch
 * preserves exact filtering without turning a title search back into repeated
 * full-corpus enumeration.
 */
export const EXHAUSTIVE_TITLE_BATCH_SIZE = CATALOG_LIMIT

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

/** One settled title observation's presentation traits and title state. */
interface TitleObservation extends SessionObservedTitle {
  /** Exact, provisional, or failed resolution state for this id. */
  readonly state: SessionTitleState
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
 * Fold title observations into states without conflating absence and failure.
 *
 * A fulfilled result with no `session/title` event is exact absence. A rejected
 * member is an unreadable exact observation, not an untitled session. The
 * caller can still retain a provisional hint on a failed result.
 * @param results - ordered per-id settlements from Harness.
 * @returns states and origin traits keyed by session id.
 */
function titleObservations(
  results: readonly SessionTitleObservationResult[],
): Map<SessionId, TitleObservation> {
  const observations = new Map<SessionId, TitleObservation>()
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const title = result.value.title?.title
      observations.set(result.sessionId, {
        ...title === undefined ? {} : { title },
        state: { kind: 'exact', title },
        ...(result.value.session.origin === 'subagent'
          ? { origin: result.value.session.origin }
          : {}),
      })
      continue
    }
    observations.set(result.sessionId, {
      state: { kind: 'failed', title: undefined, message: reason(result.reason) },
    })
  }
  return observations
}

/** Keep only exact observations for lineage's title reconciliation. */
function exactTitleTraits(
  observations: ReadonlyMap<SessionId, TitleObservation>,
): Map<SessionId, SessionObservedTitle> {
  const traits = new Map<SessionId, SessionObservedTitle>()
  for (const [id, observation] of observations) {
    if (observation.state.kind !== 'exact') continue
    traits.set(id, observation.state.title === undefined ? {} : { title: observation.state.title })
  }
  return traits
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
 * @param observation - the settled observation, when one resolved for this session.
 * @returns the presentation origin.
 */
function classifyOrigin(record: SessionRecord, observation: TitleObservation | undefined): SessionOrigin {
  const origin = observation === undefined ? record.header.origin : observation.origin
  return origin === 'subagent' ? 'delegated' : 'own'
}

/**
 * Turn one corpus record and its observed traits into a listable entry.
 * @param record - the logical-corpus record.
 * @param observation - the settled title observation, when one resolved.
 * @param snippet - a provider excerpt, when this is a search result.
 * @param hint - a Harness projection hint used before exact observation.
 * @returns the entry.
 */
function toEntry(
  record: SessionRecord,
  observation: TitleObservation | undefined,
  snippet?: string,
  hint?: SessionTitleHint,
): SessionEntry {
  const state: SessionTitleState = observation?.state
    ?? (hint === undefined
      ? { kind: 'pending' }
      : { kind: 'provisional', title: hint.title })
  return {
    id: record.header.id,
    title: state.kind === 'pending' ? undefined : state.title,
    titleState: state,
    createdAt: record.header.createdAt,
    cwd: record.header.cwd,
    live: record.live,
    persisted: record.persisted,
    parent: record.header.parentSession,
    origin: classifyOrigin(record, observation),
    ...snippet === undefined ? {} : { snippet },
  }
}

/**
 * Validate one configured listing limit.
 *
 * A listing limit is internal presentation configuration rather than corpus
 * data, so an unusable value is a programming error, not a listing failure: it
 * is rejected with a named contract before any Harness read, instead of being
 * silently coerced into a fractional or `NaN` `truncated` count. Both origin
 * regimes pass through this one gate, so an invalid limit cannot behave
 * differently for `all` and `own`/`delegated`.
 * @param value - the configured limit.
 * @returns the same value, once proven a non-negative safe integer.
 */
function listingLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Session catalog limit must be a non-negative safe integer')
  }
  return value
}

/**
 * Materialize the retained list from one authoritative listing.
 *
 * The two regimes have different costs, and naming the difference is the point:
 *
 * - `all` has no origin predicate — workspace/age clauses, if any, were already
 *   applied by Harness — and `records.length` is already the exact
 *   authoritative total, so dshline touches only the retained prefix.
 *   Presentation work is O(min(N, limit)). Harness still returned and paid for
 *   the whole corpus — this bounds the frontend's second corpus, not the
 *   authoritative listing itself.
 * - `own`/`delegated` are presentation-only classifications Harness publishes
 *   no predicate for, so every authoritative header must be read to keep
 *   `truncated` and `newest of N` exact. Classification is O(N); only
 *   materialization is bounded to `limit`.
 *
 * Either way rows are emitted in their existing Harness order.
 * @param records - the authoritative listing, in Harness order.
 * @param origin - the presentation-only origin choice to retain.
 * @param limit - maximum entries to materialize; already validated.
 * @returns the retained entries and the exact count the limit dropped.
 */
function retainListing(
  records: readonly SessionRecord[],
  origin: OriginChoice,
  limit: number,
  titleHints: SessionCatalogSpec['titleHints'],
): { readonly entries: SessionEntry[]; readonly truncated: number } {
  const entries: SessionEntry[] = []
  const hint = (record: SessionRecord): SessionTitleHint | undefined => {
    try {
      return titleHints?.(record)
    } catch {
      // A projection hint is optional presentation. A broken hint must not
      // turn a readable Harness corpus into a failed picker; exact hydration
      // remains the fallback.
      return undefined
    }
  }
  if (origin === 'all') {
    const retained = Math.max(0, Math.min(records.length, limit))
    for (let index = 0; index < retained; index += 1) {
      const record = records[index]!
      entries.push(toEntry(record, undefined, undefined, hint(record)))
    }
    return { entries, truncated: records.length - retained }
  }
  let retained = 0
  for (const record of records) {
    if (!originRetained(classifyOrigin(record, undefined), origin)) continue
    retained += 1
    if (entries.length < limit) entries.push(toEntry(record, undefined, undefined, hint(record)))
  }
  return { entries, truncated: retained - entries.length }
}

/**
 * Apply one settlement batch to a displayed session entry.
 *
 * A fulfilled observation is authoritative, including exact absence. A failed
 * observation never erases a provisional hint: it changes the state to failed
 * while retaining the last known text as visibly non-exact.
 * @param entry - the displayed entry.
 * @param observations - settled states keyed by session id.
 * @returns the entry with its title reconciled, or the same entry untouched.
 */
function applyObservedTitle(
  entry: SessionEntry,
  observations: ReadonlyMap<SessionId, TitleObservation>,
): SessionEntry {
  const observed = observations.get(entry.id)
  if (observed === undefined) return entry
  const prior = entryTitleState(entry)
  const state = observed.state.kind === 'failed'
    ? { ...observed.state, title: prior.kind === 'pending' ? undefined : prior.title }
    : observed.state
  return {
    ...entry,
    title: state.kind === 'pending' ? undefined : state.title,
    titleState: state,
  }
}

/** The generation-safe data source behind the Sessions browser. */
export class SessionCatalog {
  private base: CatalogState
  private contentState: ContentState = { kind: 'idle' }
  private readonly navigator: SessionNavigator
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
  private listingAbort: AbortController | undefined
  private titleAbort: AbortController | undefined
  /** Exact title ids waiting for a bounded demand-driven batch. */
  private titleQueue: SessionId[] = []
  /** Whether queued work was made relevant by a local title query. */
  private exhaustiveTitlesQueued = false
  /** Ids already queued or being read, so a redraw never duplicates work. */
  private readonly titleRequested = new Set<SessionId>()
  /** Ids in the currently running exact-title batch. */
  private titleInFlightIds: readonly SessionId[] = []
  /** Whether the current batch was queued by an exhaustive local query. */
  private titleInFlightExhaustive = false
  private searchAbort: AbortController | undefined
  private contentChain: ContentChain | undefined
  /**
   * Settled-page counter for the full-text scopes.
   *
   * The views use a revision change — not a row count — to notice that a page
   * landed, because an empty page settles without appending anything.
   */
  private pageRevision = 0
  private disposed = false
  /**
   * The validated listing limit shared by every request and origin mode.
   *
   * Resolved once at construction so no listing path can reach
   * {@link retainListing} with an unusable value.
   */
  private readonly limit: number

  constructor(private readonly spec: SessionCatalogSpec) {
    this.limit = listingLimit(spec.limit ?? CATALOG_LIMIT)
    this.base = spec.query === undefined ? { kind: 'unavailable' } : { kind: 'loading' }
    this.navigator = new SessionNavigator({
      query: spec.query,
      invalidate: spec.invalidate,
      observeTitles: async (sessionIds, signal) => observedTitleTraits(
        await spec.query?.readTitleSnapshots(sessionIds, signal) ?? [],
      ),
    })
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
    return this.navigator.events()
  }

  /**
   * @param sessionId - the hit's owning session.
   * @param seq - the hit's event sequence number.
   * @returns context only when it belongs to that exact hit.
   */
  eventContext(sessionId: SessionId, seq: SessionSeq) {
    return this.navigator.eventContext(sessionId, seq)
  }

  /**
   * @param sessionId - the currently selected session.
   * @returns lineage only when it belongs to that selected session.
   */
  lineage(sessionId: SessionId) {
    return this.navigator.lineage(sessionId)
  }

  /**
   * The bounded detail already read for one session.
   * @param sessionId - the session.
   * @returns its detail, or undefined until {@link requestDetail} has landed.
   */
  detail(sessionId: SessionId): SessionDetail | undefined {
    return this.details.get(sessionId)
  }

  /**
   * Prioritize exact title observations for rows the reader can see.
   *
   * The overlay calls this with the current viewport and selected row. A
   * non-empty local query asks for the whole retained corpus because an
   * unresolved title could become a match; an empty query never causes the
   * remaining 200 rows to be opened just because the browser exists.
   * @param entries - visible or selected entries, in reader priority order.
   * @param exhaustive - whether unresolved rows outside `entries` matter too.
   */
  prioritizeTitles(entries: readonly SessionEntry[], exhaustive = false): void {
    if (this.disposed || this.base.kind !== 'ready') return
    const candidates = exhaustive ? this.base.entries : entries
    if (exhaustive) this.exhaustiveTitlesQueued = true
    for (const entry of candidates) {
      if (entryTitleState(entry).kind === 'exact') continue
      if (this.titleRequested.has(entry.id)) continue
      this.titleRequested.add(entry.id)
      this.titleQueue.push(entry.id)
    }
    this.drainTitleQueue()
  }

  /**
   * Tell the catalog that the local metadata/title query changed.
   *
   * A non-empty query keeps unresolved retained titles relevant, including
   * while its text is edited. Clearing it makes queued exhaustive work no
   * longer useful; an already-running exhaustive batch is aborted and its ids
   * become eligible for a later visible request. A visible batch is allowed to
   * finish because its titles remain useful to the current viewport.
   * @param query - the new local query text.
   */
  titleQueryChanged(query: string): void {
    if (query.trim() === '') {
      const inFlight = new Set(this.titleInFlightIds)
      for (const id of this.titleQueue) {
        if (!inFlight.has(id)) this.titleRequested.delete(id)
      }
      this.titleQueue = []
      this.exhaustiveTitlesQueued = false
      if (!this.titleInFlightExhaustive) return
      this.titleGeneration += 1
      for (const id of this.titleInFlightIds) this.titleRequested.delete(id)
      this.titleInFlightIds = []
      this.titleAbort?.abort()
    }
  }

  /** Load the unfiltered newest-first listing for backward-compatible callers. */
  refresh(): void {
    this.requestListing(NO_FILTERS)
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
    this.requestListing(this.filterValue)
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
    const lineage = this.navigator.lineageSnapshot()
    const ids = new Set<SessionId>()
    if (listing.kind === 'ready') for (const entry of listing.entries) ids.add(entry.id)
    if (contentChain !== undefined) for (const entry of contentChain.entries) ids.add(entry.id)
    if (lineage.kind === 'ready') {
      for (const row of lineage.rows) if (row.kind !== 'pruned') ids.add(row.id)
    }
    if (ids.size === 0) return
    const generation = (this.titleGeneration += 1)
    this.titleQueue = []
    this.exhaustiveTitlesQueued = false
    this.titleRequested.clear()
    this.titleInFlightIds = []
    this.titleInFlightExhaustive = false
    this.titleAbort?.abort()
    const abort = new AbortController()
    this.titleAbort = abort
    void (async (): Promise<void> => {
      try {
        const observations = titleObservations(await query.readTitleSnapshots([...ids], abort.signal))
        if (this.stale(generation, this.titleGeneration) || this.disposed) return
        let changed = false
        if (this.listingGeneration === listingGeneration && this.base === listing && listing.kind === 'ready') {
          this.base = {
            ...listing,
            entries: listing.entries.map(entry => applyObservedTitle(entry, observations)),
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
            ? applyObservedTitle(entry, observations)
            : entry)
          const content = this.contentState
          if (content.kind === 'ready' && content.query === contentChain.query) {
            this.contentState = { ...content, entries: contentChain.entries }
          }
          changed = true
        }
        if (this.navigator.reconcileLineageTitles(lineage, exactTitleTraits(observations))) changed = true
        if (changed) this.spec.invalidate()
      } catch (error: unknown) {
        if (this.stale(generation, this.titleGeneration)) return
        if (errorCode(error) === SEARCH_ABORTED) return
      } finally {
        if (this.titleAbort === abort) {
          this.titleAbort = undefined
          this.drainTitleQueue()
        }
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
   * @param sessionId - the selected session.
   * @param text - the backend-interpreted query text.
   */
  searchEvents(sessionId: SessionId, text: string): void {
    this.navigator.searchEvents(sessionId, text)
  }

  /** Append the next within-session event page. */
  loadMoreEvents(): void {
    this.navigator.loadMoreEvents()
  }

  /**
   * @param sessionId - the hit's owning session.
   * @param seq - the hit's event sequence number.
   */
  requestEventContext(sessionId: SessionId, seq: SessionSeq): void {
    this.navigator.requestEventContext(sessionId, seq)
  }

  /**
   * @param sessionId - the selected session.
   */
  requestLineage(sessionId: SessionId): void {
    this.navigator.requestLineage(sessionId)
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
    this.listingAbort?.abort()
    this.titleAbort?.abort()
    this.searchAbort?.abort()
    this.titleQueue = []
    this.exhaustiveTitlesQueued = false
    this.titleRequested.clear()
    this.titleInFlightIds = []
    this.titleInFlightExhaustive = false
    this.listingAbort = undefined
    this.titleAbort = undefined
    this.searchAbort = undefined
    this.navigator.dispose()
  }

  /**
   * Start a fresh authoritative listing under one filter value.
   *
   * The Harness call is chosen by the TRANSLATED CLAUSES, not by whether the
   * browser's filter value differs from the default. Origin has no Harness
   * predicate, so an origin-only filter translates to zero clauses and is a
   * plain listing; `filterSessions([])` would ask the engine to re-derive the
   * whole corpus under an empty predicate and then have the frontend discard
   * it down to the same rows. The origin choice still applies below, as it
   * always did, because {@link retainListing} scans presentation-only.
   * @param filters - the complete filter value to apply.
   */
  private requestListing(filters: SessionFiltersValue): void {
    const query = this.spec.query
    if (query === undefined) return
    const generation = (this.listingGeneration += 1)
    this.titleGeneration += 1
    this.listingAbort?.abort()
    this.titleAbort?.abort()
    this.titleQueue = []
    this.exhaustiveTitlesQueued = false
    this.titleRequested.clear()
    this.titleInFlightIds = []
    this.titleInFlightExhaustive = false
    const abort = new AbortController()
    this.listingAbort = abort
    this.base = { kind: 'loading' }
    this.spec.invalidate()
    void (async (): Promise<void> => {
      try {
        const clauses = sessionFilterClauses(filters, this.spec.workspace ?? EVERY_WORKSPACE, this.filterAnchor)
        const records = clauses.length === 0
          ? await query.listSessions(abort.signal)
          : await query.filterSessions(clauses, abort.signal)
        if (this.stale(generation, this.listingGeneration)) return
        const { entries: kept, truncated } = retainListing(
          records,
          filters.origin,
          this.limit,
          this.spec.titleHints,
        )
        if (this.stale(generation, this.listingGeneration)) return
        // Metadata is the cheap, authoritative half of the listing. Publish it
        // before asking Harness to open any cold log; the overlay can already
        // navigate by age/workspace/id while title work is demand-driven.
        this.base = { kind: 'ready', entries: kept, truncated }
        this.spec.invalidate()
        // The first viewport is the useful default when a caller owns a catalog
        // without an overlay yet. It is deliberately bounded; a reader who
        // resumes immediately cannot be held behind 180 unrelated bodies.
        this.prioritizeTitles(kept.slice(0, TITLE_BATCH_SIZE))
      } catch (error: unknown) {
        if (this.stale(generation, this.listingGeneration)) return
        if (errorCode(error) === SEARCH_ABORTED) return
        this.base = { kind: 'failed', message: reason(error) }
        this.spec.invalidate()
      }
    })()
  }

  /** Start the next bounded exact-title batch, if demand has queued one. */
  private drainTitleQueue(): void {
    const query = this.spec.query
    if (query === undefined || this.disposed || this.titleAbort !== undefined) return
    if (this.base.kind !== 'ready' || this.titleQueue.length === 0) return
    const batchSize = this.exhaustiveTitlesQueued ? EXHAUSTIVE_TITLE_BATCH_SIZE : TITLE_BATCH_SIZE
    const ids = this.titleQueue.splice(0, batchSize)
    const listing = this.base
    const generation = this.titleGeneration
    const abort = new AbortController()
    this.titleAbort = abort
    this.titleInFlightIds = ids
    this.titleInFlightExhaustive = this.exhaustiveTitlesQueued
    void (async (): Promise<void> => {
      let changed = false
      try {
        const observations = titleObservations(await query.readTitleSnapshots(ids, abort.signal))
        for (const id of ids) {
          if (observations.has(id)) continue
          observations.set(id, {
            state: { kind: 'failed', title: undefined, message: 'Harness returned no title observation' },
          })
        }
        if (this.stale(generation, this.titleGeneration) || this.base !== listing) return
        this.base = {
          ...listing,
          entries: listing.entries.map(entry => ids.includes(entry.id)
            ? applyObservedTitle(entry, observations)
            : entry),
        }
        changed = true
      } catch (error: unknown) {
        if (this.stale(generation, this.titleGeneration) || errorCode(error) === SEARCH_ABORTED) return
        if (this.base !== listing) return
        const observations = new Map<SessionId, TitleObservation>(ids.map(id => [id, {
          state: { kind: 'failed', title: undefined, message: reason(error) },
        }]))
        this.base = {
          ...listing,
          entries: listing.entries.map(entry => ids.includes(entry.id)
            ? applyObservedTitle(entry, observations)
            : entry),
        }
        changed = true
      } finally {
        if (this.titleAbort === abort) {
          if (!this.stale(generation, this.titleGeneration) && !this.disposed && changed) {
            this.spec.invalidate()
          }
          if (this.titleQueue.length === 0) this.exhaustiveTitlesQueued = false
          this.titleAbort = undefined
          this.titleInFlightIds = []
          this.titleInFlightExhaustive = false
          if (!this.disposed) this.drainTitleQueue()
        }
      }
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
        const observations = titleObservations(await query.readTitleSnapshots(
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
          page.items.map(hit => toEntry(hit, observations.get(hit.header.id), hit.bestMatch.snippet)),
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

  private currentContentChain(chain: ContentChain): boolean {
    return !this.stale(chain.chain, this.searchGeneration)
      && this.contentChain === chain
      && chain.filterGeneration === this.filterGeneration
  }

  private now(): number {
    return this.spec.now?.() ?? Date.now()
  }

  private stale(generation: number, current: number): boolean {
    return this.disposed || generation !== current
  }
}
