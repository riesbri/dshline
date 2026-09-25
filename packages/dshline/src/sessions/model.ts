/**
 * What a session IS, for a reader who has to recognise one in a list.
 *
 * The hard part of a session browser is not drawing rows; it is deciding which
 * facts identify a session to a person. An id does not, a timestamp barely does,
 * and a title only does when something wrote one. So an entry carries the whole
 * set Harness can answer for — title, age, workspace, lineage, availability —
 * and the view decides how much of it fits.
 *
 * Everything here is pure. The catalog owns the reads and the overlay owns the
 * keyboard; this module owns the vocabulary and the string rules, which is the
 * part worth testing without a terminal or a harness.
 * @module dshline/sessions/model
 */

import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEventWindow } from '@deepseek-ai/dsh-session-query'

/**
 * How Harness can produce a session, as far as presentation is concerned.
 *
 * `delegated` is `SessionHeader.origin === 'subagent'`, which the header
 * documents as presentation metadata rather than proof of anything the child can
 * still do. It is worth showing because a deployment that delegates a lot fills
 * its corpus with children nobody typed into, and a reader scanning for their
 * own work needs to tell those apart at a glance.
 */
export type SessionOrigin = 'own' | 'delegated'

/**
 * How far a displayed title has been resolved.
 *
 * `title` on {@link SessionEntry} remains a convenient text projection, but it
 * is deliberately not the authority: `undefined` can mean four different things
 * while a picker is loading. The state keeps those meanings visible to the
 * renderer and to local filtering.
 */
export type SessionTitleState =
  /** The exact title observation has not been requested or has not settled. */
  | { readonly kind: 'pending' }
  /** A possibly stale Harness projection hint; it is not an exact log fold. */
  | { readonly kind: 'provisional'; readonly title: string | undefined }
  /** The exact Harness title observation settled, including exact absence. */
  | { readonly kind: 'exact'; readonly title: string | undefined }
  /** The exact observation was unreadable; any retained hint is still provisional. */
  | { readonly kind: 'failed'; readonly title: string | undefined; readonly message: string }

/** A title value supplied by a Harness live projection or optional cache before exact observation. */
export interface SessionTitleHint {
  /** The projected title, or undefined when that cut had no title. */
  readonly title: string | undefined
}

/** One session as the browser lists it. */
export interface SessionEntry {
  /** Harness session id, the only stable identity a row has. */
  readonly id: SessionId
  /**
   * The folded `session/title`, or undefined when the exact log has none.
   *
   * This is a display convenience only. Read {@link titleState} before treating
   * absence as a fact or matching it as a negative result.
   */
  readonly title: string | undefined
  /**
   * The exact/provisional/pending/failed meaning of {@link title}.
   *
   * Optional only for source-compatible embedders that still construct the
   * pre-resolution shape; {@link entryTitleState} treats that legacy shape as
   * exact. Every catalog-produced row supplies the state explicitly.
   */
  readonly titleState?: SessionTitleState
  /** When the session was created, from its immutable header. */
  readonly createdAt: number
  /** Workspace the session was created in, when the header records one. */
  readonly cwd: string | undefined
  /** Whether `ctx.sessions` currently holds the id. */
  readonly live: boolean
  /** Whether the mounted persistence backend currently materializes the id. */
  readonly persisted: boolean
  /** The session this one was forked or delegated from, when the header says. */
  readonly parent: SessionId | undefined
  /** Coarse header classification, for telling delegated children apart. */
  readonly origin: SessionOrigin
  /**
   * A plain-text excerpt from the strongest matching event, present only on a
   * content-search result. It is provider-selected text from the log, so it is
   * untrusted and must be escaped before it is drawn.
   */
  readonly snippet?: string
}

/**
 * The bounded extra reading taken for ONE disclosed session.
 *
 * Deliberately not part of {@link SessionEntry}: both facts come from loading
 * and surface-folding a whole session log, so a list that shows them pays a log
 * read per row the cursor touches. They are read when the detail surface that
 * presents them is opened, and never for ordinary browsing.
 */
export interface SessionDetail {
  /** Raw log events in the session. */
  readonly events: number
  /** Timestamp of its last event, or undefined for an empty log. */
  readonly lastActivityAt: number | undefined
}

/** Which corpus the visible rows came from. */
export type SessionSearchMode = 'filter' | 'content'

/** The listing the browser draws before any search is applied. */
export type CatalogState =
  /** No `ctx.sessionQuery` is mounted, so there is no corpus to browse. */
  | { readonly kind: 'unavailable' }
  /** The first listing is in flight. */
  | { readonly kind: 'loading' }
  /** Harness refused the listing; the message is its own and is untrusted. */
  | { readonly kind: 'failed'; readonly message: string }
  /** A listing arrived. `truncated` counts rows the limit dropped. */
  | { readonly kind: 'ready'; readonly entries: readonly SessionEntry[]; readonly truncated: number }

/** The state of the optional full-text pass over session contents. */
export type ContentState =
  /** Nothing has been asked for yet. */
  | { readonly kind: 'idle' }
  /** A search for `query` is in flight. */
  | { readonly kind: 'searching'; readonly query: string }
  /** Results for `query`, possibly none. */
  | {
    readonly kind: 'ready'
    readonly query: string
    readonly entries: readonly SessionEntry[]
    readonly returned: number
    readonly matched: number
    readonly more: boolean
    readonly loadingMore: boolean
    readonly restart: boolean
    /** Settled-page counter; changes when any page lands, even an empty one. */
    readonly revision: number
  }
  /** This deployment's session-query backend does not offer full-text search. */
  | { readonly kind: 'unsupported' }
  /** The search failed; the message is Harness's own and is untrusted. */
  | { readonly kind: 'failed'; readonly message: string }

/** One within-session full-text result row. */
export interface EventHitEntry {
  /** Session that owns the matching event. */
  readonly sessionId: SessionId
  /**
   * Monotonic event sequence number within the session.
   *
   * Kept as Harness's own branded {@link SessionSeq} rather than widened to
   * `number`: the value is passed back verbatim to `readEvent()` when the hit is
   * disclosed, and preserving the type means that call needs no cast that would
   * let a non-sequence number reach the read seam.
   */
  readonly seq: SessionSeq
  /** Harness event discriminant. */
  readonly type: string
  /** Event time in Unix epoch milliseconds. */
  readonly time: number
  /** Provider-selected plain-text excerpt; untrusted at the drawing boundary. */
  readonly snippet: string
}

/** The state of full-text search within one selected session. */
export type EventSearchState =
  /** Nothing has been asked for yet. */
  | { readonly kind: 'idle' }
  /** A cursorless search is in flight. */
  | { readonly kind: 'searching'; readonly sessionId: SessionId; readonly query: string }
  /** Accumulated event hits and continuation state. */
  | {
    readonly kind: 'ready'
    readonly sessionId: SessionId
    readonly query: string
    readonly hits: readonly EventHitEntry[]
    readonly more: boolean
    readonly loadingMore: boolean
    readonly restart: boolean
    /** Settled-page counter; changes when any page lands, even an empty one. */
    readonly revision: number
  }
  /** This deployment offers neither session nor event full-text search. */
  | { readonly kind: 'unsupported' }
  /** The event search failed; the message is Harness's own and is untrusted. */
  | { readonly kind: 'failed'; readonly message: string }

/**
 * The state of the ONE search hit whose surrounding context is disclosed.
 *
 * Deliberately not part of {@link EventSearchState}: reading a hit's context
 * loads a raw-log window, so a search that fetched context for every row would
 * pay a read per row the cursor touched. It is requested when a hit is opened
 * and never while hits are landing, moving, or drawing.
 *
 * The `sessionId` and `seq` are carried so a stale read can be recognised and
 * discarded rather than painted under the wrong hit: {@link SessionCatalog}
 * exposes this state only for the exact hit it belongs to.
 */
export type EventContextState =
  /** No context has been requested. */
  | { readonly kind: 'idle' }
  /** A read for this exact hit is in flight. */
  | { readonly kind: 'loading'; readonly sessionId: SessionId; readonly seq: SessionSeq }
  /** The target event plus its bounded raw-log window. */
  | {
    readonly kind: 'ready'
    readonly sessionId: SessionId
    readonly seq: SessionSeq
    readonly window: SessionEventWindow
  }
  /** The read failed; the message is Harness's own and is untrusted. */
  | { readonly kind: 'failed'; readonly sessionId: SessionId; readonly seq: SessionSeq; readonly message: string }

/** One flattened row in a bounded session-lineage tree. */
export type LineageRow =
  | {
    readonly kind: 'ancestor' | 'target' | 'descendant'
    readonly depth: number
    readonly id: SessionId
    readonly title?: string
    readonly createdAt: number
    readonly cwd?: string
    readonly origin: SessionOrigin
  }
  | {
    readonly kind: 'pruned'
    readonly depth: number
    readonly label: string
  }

/** The state of the selected session's bounded lineage trace. */
export type LineageState =
  /** No lineage has been requested. */
  | { readonly kind: 'idle' }
  /** A trace for the selected session is in flight. */
  | { readonly kind: 'loading'; readonly sessionId: SessionId }
  /** A flattened trace, with the target's stable row index. */
  | {
    readonly kind: 'ready'
    readonly sessionId: SessionId
    readonly rows: readonly LineageRow[]
    readonly targetRow: number
    readonly complete: boolean
    readonly unresolvedParentId?: SessionId
  }
  /** The trace failed; the message is Harness's own and is untrusted. */
  | { readonly kind: 'failed'; readonly sessionId: SessionId; readonly message: string }

/** Minutes in the units the relative age steps through. */
const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = MINUTES_PER_HOUR * 24

/**
 * A relative age in the coarsest unit that is still informative.
 *
 * Coarse on purpose: a list is scanned, not read, and `3d` separates rows where
 * `3d 4h 12m` only makes them the same width. Weeks are the last unit, because
 * past that the number stops meaning anything a reader acts on.
 * @param at - a timestamp in milliseconds.
 * @param now - the current time in milliseconds.
 * @returns a short relative description.
 */
export function relativeAge(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < MINUTES_PER_HOUR) return `${String(minutes)}m ago`
  if (minutes < MINUTES_PER_DAY) return `${String(Math.round(minutes / MINUTES_PER_HOUR))}h ago`
  const days = Math.round(minutes / MINUTES_PER_DAY)
  if (days < 7) return `${String(days)}d ago`
  return `${String(Math.round(days / 7))}w ago`
}

/** What a row is called when its exact log never carried a title. */
export const UNTITLED = 'untitled'

/** A clear list label for the currently open session when it has no title. */
export const CURRENT = 'current'

/** A pending title is never rendered as an exact `untitled` row. */
export const LOADING_TITLE = 'loading title…'

/** A failed exact title observation is not an exact `untitled` row. */
export const TITLE_UNAVAILABLE = 'title unavailable'

/** Prefix that makes a possibly stale projection visibly provisional. */
export const PROVISIONAL_TITLE_PREFIX = '~ '

/**
 * Resolve an entry's title state, including the legacy exact fallback.
 * @param entry - the entry to inspect.
 * @returns its explicit state or an exact state derived from legacy text.
 */
export function entryTitleState(entry: SessionEntry): SessionTitleState {
  return entry.titleState ?? { kind: 'exact', title: entry.title }
}

/** Whether a title state is an exact settled observation. */
export function titleIsExact(state: SessionTitleState): boolean {
  return state.kind === 'exact'
}

/**
 * The name a row shows, including the distinction between absent and unknown.
 * @param entry - the session.
 * @param currentSessionId - the open session, when the caller has one.
 * @returns its exact/provisional title or an honest resolution label.
 */
export function sessionLabel(entry: SessionEntry, currentSessionId?: SessionId): string {
  const state = entryTitleState(entry)
  switch (state.kind) {
    case 'pending':
      return entry.id === currentSessionId ? `${CURRENT} · ${LOADING_TITLE}` : LOADING_TITLE
    case 'provisional':
      return state.title === undefined || state.title.trim() === ''
        ? `${PROVISIONAL_TITLE_PREFIX}${TITLE_UNAVAILABLE}`
        : `${PROVISIONAL_TITLE_PREFIX}${state.title}`
    case 'failed':
      return state.title === undefined || state.title.trim() === ''
        ? (entry.id === currentSessionId ? `${CURRENT} · ${TITLE_UNAVAILABLE}` : TITLE_UNAVAILABLE)
        : `${PROVISIONAL_TITLE_PREFIX}${state.title}`
    case 'exact': {
      const title = state.title
      if (title !== undefined && title.trim() !== '') return title
      return entry.id === currentSessionId ? CURRENT : UNTITLED
    }
  }
}

/**
 * A workspace path shortened at the home directory.
 *
 * Not cosmetic: the home prefix is the same on every row, so it is the one part
 * of a path that never distinguishes two sessions, while the part that does —
 * the project folder — is the part a narrow terminal cuts off first.
 * @param cwd - the absolute workspace path, or undefined.
 * @param home - the user's home directory, when it is known.
 * @returns the path to display, or undefined when there is none.
 */
export function shortWorkspace(cwd: string | undefined, home: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  if (home === undefined || home === '') return cwd
  if (cwd === home) return '~'
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
}

/**
 * Normalise text for matching.
 *
 * Case is folded and whitespace runs collapse, so a query typed with one space
 * finds a title that was wrapped or indented in the log. Deliberately the same
 * shape as the session-query text clause, which is also literal, case-
 * insensitive, and whitespace-flexible — the two search tiers should not
 * disagree about what counts as a match.
 * @param text - the raw text.
 * @returns its normalised form.
 */
function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

/**
 * Whether a query matches one entry's identifying text.
 *
 * Metadata is always searchable. A title contributes a positive match only
 * when it has a value; an unresolved title never becomes a fabricated
 * negative, because a late exact observation may still match.
 * @param entry - the candidate.
 * @param query - raw query text; an empty query matches everything.
 * @returns whether the entry can be listed as a match.
 */
export function matchesQuery(entry: SessionEntry, query: string): boolean {
  const needle = normalize(query)
  if (needle === '') return true
  const metadata = normalize([entry.cwd ?? '', entry.id].join(' '))
  if (metadata.includes(needle)) return true
  const state = entryTitleState(entry)
  return state.kind !== 'pending'
    && state.kind !== 'failed'
    && normalize(state.title ?? '').includes(needle)
}

/** A filtered listing plus whether every title was exact at this pass. */
export interface SessionFilterResult {
  /** Entries that currently match, in Harness order. */
  readonly entries: readonly SessionEntry[]
  /** Whether an unresolved title could still add a match. */
  readonly complete: boolean
}

/**
 * Apply a query while reporting whether title matching is authoritative.
 *
 * An unresolved title is not shown as a match merely because it might become
 * one: that would flood a filtered picker with every pending row. It does,
 * however, keep the result explicitly incomplete so the view can say that
 * more matches may arrive. Workspace and id matches remain immediately useful.
 * @param entries - the listing.
 * @param query - raw query text.
 * @returns the current matches and whether the title pass is complete.
 */
export function filterEntriesWithState(
  entries: readonly SessionEntry[],
  query: string,
): SessionFilterResult {
  const needle = normalize(query)
  if (needle === '') {
    return {
      entries,
      complete: entries.every(entry => titleIsExact(entryTitleState(entry))),
    }
  }
  let complete = true
  const matches = entries.filter(entry => {
    const metadata = normalize([entry.cwd ?? '', entry.id].join(' '))
    if (metadata.includes(needle)) return true
    const state = entryTitleState(entry)
    if (state.kind === 'exact') return normalize(state.title ?? '').includes(needle)
    complete = false
    return (state.kind === 'provisional' || state.kind === 'failed')
      && normalize(state.title ?? '').includes(needle)
  })
  return { entries: matches, complete }
}

/**
 * Apply a query to a listing, preserving Harness's newest-first order.
 *
 * Order is not re-ranked. Harness returns the corpus newest-first, and a
 * frontend that re-sorted by its own idea of relevance would be inventing a
 * ranking the corpus never agreed to — which is exactly what the content tier
 * asks the backend for instead.
 * @param entries - the listing.
 * @param query - raw query text.
 * @returns the matching entries, in their original order.
 */
export function filterEntries(
  entries: readonly SessionEntry[],
  query: string,
): readonly SessionEntry[] {
  return filterEntriesWithState(entries, query).entries
}

/** One `label  value` line in a disclosed session's fact block. */
export interface SessionFact {
  /** Short noun naming the fact. */
  readonly label: string
  /** The authoritative value; untrusted text, so the view still escapes it. */
  readonly value: string
}

/** What turning a session into fact lines needs beyond the session itself. */
export interface SessionFactsContext {
  /** The user's home directory, for shortening the workspace path. */
  readonly home: string | undefined
  /** Current time in milliseconds, for the relative ages. */
  readonly now: number
}

/**
 * The facts a disclosed session can state, most identifying first.
 *
 * Every line is a fact Harness already answered — the immutable header, the
 * corpus record's availability, and the bounded log read. Nothing is derived,
 * defaulted, or invented: a fact Harness did not answer is simply absent, which
 * is why the event count and last activity disappear rather than read `unknown`
 * while (or after) the bounded read that would have produced them.
 *
 * Order matters because a short terminal keeps a prefix of this list: the
 * workspace and the times are how a person recognises a session, and the id is
 * what they need only when they are about to quote it somewhere else.
 * @param entry - the disclosed session.
 * @param detail - its bounded log reading, when one has landed.
 * @param context - the home directory and the current time.
 * @returns the fact lines, in display order.
 */
export function sessionFacts(
  entry: SessionEntry,
  detail: SessionDetail | undefined,
  context: SessionFactsContext,
): readonly SessionFact[] {
  const workspace = shortWorkspace(entry.cwd, context.home)
  const availability = [...entry.live ? ['live'] : [], ...entry.persisted ? ['persisted'] : []]
  return [
    ...workspace === undefined ? [] : [{ label: 'Workspace', value: workspace }],
    { label: 'Created', value: relativeAge(entry.createdAt, context.now) },
    ...detail?.lastActivityAt === undefined
      ? []
      : [{ label: 'Activity', value: relativeAge(detail.lastActivityAt, context.now) }],
    ...detail === undefined ? [] : [{ label: 'Events', value: String(detail.events) }],
    { label: 'Origin', value: entry.origin },
    ...availability.length === 0 ? [] : [{ label: 'Availability', value: availability.join(' · ') }],
    ...entry.parent === undefined ? [] : [{ label: 'Parent', value: entry.parent }],
    { label: 'Session', value: entry.id },
  ]
}
