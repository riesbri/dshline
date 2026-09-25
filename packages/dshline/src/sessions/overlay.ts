/**
 * The Sessions browser: a bounded, keyboard-first list over the Harness corpus.
 *
 * A PICKER first and an inspector second. The list answers one question — which
 * session — so a row carries the two facts that answer it, a title and an age,
 * and nothing else competes with them. Every other fact Harness can tell us
 * about one session, and every action that only makes sense for one session,
 * lives one keystroke away behind `→`.
 *
 * That split is not only visual. The event count and last-activity time cost a
 * whole log read, so a list that shows them has to take that read every time the
 * cursor moves. Moving them behind the disclosure means ordinary browsing reads
 * the corpus listing and nothing else.
 * @module dshline/sessions/overlay
 */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  paint,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { SurfaceNotice } from '../surface.ts'
import type { SurfaceNoticeReading } from '../surface.ts'
import { equalFilters, NO_FILTERS, type SessionFiltersValue } from './filters.ts'
import { createLineageOverlay } from './lineage-overlay.ts'
import type {
  CatalogState,
  ContentState,
  EventContextState,
  EventSearchState,
  LineageState,
  SessionDetail,
  SessionEntry,
  SessionFact,
  SessionSearchMode,
} from './model.ts'
import {
  entryTitleState,
  filterEntriesWithState,
  relativeAge,
  sessionFacts,
  sessionLabel,
} from './model.ts'
import {
  CHILD_CLOSE_REQUESTED,
  createEventsOverlay,
  createFilterOverlay,
  type SessionsChildOverlay,
} from './panels.ts'

/** Rows outside the scrolling list: leading blank, two borders, query, spacer. */
const SESSIONS_FIXED_ROWS = 5

/** Rows outside the detail surface's body: leading blank, two borders, spacer. */
const DETAIL_FIXED_ROWS = 4

/** Narrowest terminal that can hold a useful title-and-age session row. */
const SESSIONS_MIN_COLUMNS = BOX_CHROME_COLUMNS + 24

/** Content rows yield at this width before a title and its excerpt collide. */
const CONTENT_COMPACT_COLUMNS = 40

/** Content rows yield at this height before the selected excerpt consumes the viewport. */
const CONTENT_COMPACT_ROWS = 15

/** How long a transient browser notice stays on screen before the list returns. */
const NOTICE_MS = 4_000

/** Columns protected for a title before the open marker is surrendered. */
const MIN_TITLE_COLUMNS = 24

/** Columns given to a detail fact's label before its value starts. */
const DETAIL_LABEL_COLUMNS = 13

/** The answer a resume request gets back from the owner. */
export type ResumeRequest =
  /** Accepted; the overlay closes and the owner performs the switch. */
  | { readonly kind: 'resume' }
  /** Declined, with a sentence the reader can act on. */
  | { readonly kind: 'refused'; readonly message: string }

/** Result of collecting and submitting one rename draft. */
export type RenameDraftOutcome =
  /** Harness accepted the rename and returned its normalized title. */
  | { readonly kind: 'renamed'; readonly title: string }
  /** The reader dismissed the child prompt without submitting a title. */
  | { readonly kind: 'cancelled' }
  /** Harness or the caller rejected the attempted rename. */
  | { readonly kind: 'failed'; readonly message: string }

/** What the browser needs from its owner. */
export interface SessionsOverlaySpec {
  /** The corpus listing. */
  readonly listing: () => CatalogState
  /**
   * Prioritize exact title reads for the rows currently useful to the reader.
   *
   * Optional so small embedders and pure presentation tests can mount the
   * overlay without a catalog; the real Sessions owner always supplies it.
   */
  readonly prioritizeTitles?: (entries: readonly SessionEntry[], exhaustive?: boolean) => void
  /** Tell the catalog when local query text changes, so queued work can be abandoned. */
  readonly titleQueryChanged?: (query: string) => void
  /** The optional full-text pass. */
  readonly content: () => ContentState
  /** The active catalog filters. */
  readonly filters: () => SessionFiltersValue
  /** Replace the active catalog filters. */
  readonly applyFilters: (filters: SessionFiltersValue) => void
  /** Append the next content-search page. */
  readonly loadMoreContent: () => void
  /** Restart the current content search without its stale cursor. */
  readonly restartContentSearch: () => void
  /** Read lineage state for one session. */
  readonly lineage: (sessionId: SessionId) => LineageState
  /** Request lineage for one session. */
  readonly requestLineage: (sessionId: SessionId) => void
  /** Read the within-session event-search state. */
  readonly events: () => EventSearchState
  /** Search events inside one session. */
  readonly searchEvents: (sessionId: SessionId, query: string) => void
  /** Append the next within-session event page. */
  readonly loadMoreEvents: () => void
  /** Read bounded context for one disclosed search hit. */
  readonly requestEventContext: (sessionId: SessionId, seq: SessionSeq) => void
  /** The catalog's context state for one exact search hit. */
  readonly eventContext: (sessionId: SessionId, seq: SessionSeq) => EventContextState
  /** Bounded detail already read for one session. */
  readonly detail: (sessionId: SessionId) => SessionDetail | undefined
  /** Ask for one session's bounded detail; called when its detail is disclosed. */
  readonly requestDetail: (sessionId: SessionId) => void
  /** Hand a query to Harness's corpus full-text surface. */
  readonly search: (query: string) => void
  /** The session this window is driving, when there is one. */
  readonly currentSessionId: SessionId | undefined
  /** Effective workspace used by the `current` filter. */
  readonly workspace: string | undefined
  /** The user's home directory, for shortening workspace paths. */
  readonly home: string | undefined
  /** Current time, injected so ages and notices are assertable. */
  readonly now: () => number
  /** Ask the owner to reopen one session. */
  readonly resume: (entry: SessionEntry) => ResumeRequest
  /** Collect and submit a title for the current live session, when supported. */
  readonly renameDraft?: (focusedTitle: string | undefined) => Promise<RenameDraftOutcome>
  /** Push a child overlay onto the slot stack; the parent stays mounted beneath. */
  readonly push: (overlay: TuiOverlay) => void
  /** Remove this overlay from the live region. */
  readonly close: () => void
  /** Redraw after a move, an edit, or a landed read. */
  readonly invalidate: () => void
}

/** One continuation row after a landed, pageable content result. */
type Trailing = { readonly kind: 'more' | 'refresh' | 'loading' }

/** The resolved corpus before terminal geometry is known. */
interface Resolved {
  readonly entries: readonly SessionEntry[]
  readonly message: string | undefined
  readonly listed: number
  readonly corpus: number | undefined
  readonly content: Extract<ContentState, { kind: 'ready' }> | undefined
  /** Whether local title matching is authoritative for this frame. */
  readonly filterComplete: boolean
}

/**
 * The drawn document, where the selected block sits, and where the choices are.
 *
 * `rows` is exactly what {@link RowViewport} scrolls over, so the selected
 * result's excerpt and an optional continuation row count toward its length.
 * `selectedRow` and `selectedHeight` describe the block the viewport follows —
 * an entry with its match excerpt is two rows, everything else is one — so the
 * evidence that explains a content hit does not scroll off the moment its entry
 * reaches the last visible row. `selectableRows` narrows `rows` to the physical
 * lines that are actual choices — every session entry, plus a `Load more…` or
 * `Refresh` continuation — because `more below` answers a question about
 * choices, and neither an excerpt nor a `Loading more…` status row is one.
 */
interface Rendered {
  readonly rows: readonly string[]
  readonly selectedRow: number
  readonly selectedHeight: number
  readonly selectableRows: readonly number[]
}

/**
 * One action offered for the disclosed session.
 *
 * Every kind here is session-scoped, which is the whole reason Filters left:
 * filters address the CORPUS, so offering them under one row's title said that
 * narrowing the list was something you did to that session.
 */
type Action =
  | { readonly kind: 'lineage' | 'events'; readonly label: string }
  | { readonly kind: 'rename'; readonly label: 'Rename' }

/**
 * Create the Sessions browser overlay.
 * @param spec - corpus reads, child panels, resume authority, and overlay controls.
 * @returns a temporary live-region overlay that never writes the transcript.
 */
export function createSessionsOverlay(spec: SessionsOverlaySpec): TuiOverlay {
  const viewport = new RowViewport()
  let mode: SessionSearchMode = 'filter'
  let submode: 'list' | 'detail' = 'list'
  let query = ''
  let selected = 0
  let actionSelected = 0
  let visible: readonly SessionEntry[] = []
  let trailing: Trailing | undefined
  let loadingFrom: number | undefined
  let loadingRevision: number | undefined
  let closed = false
  // The notice owns its own expiry repaint; the surface passes its injected
  // clock so one timeline grades the deadline and arms the timer.
  const notice = new SurfaceNotice(NOTICE_MS, { now: spec.now, invalidate: spec.invalidate })

  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const currentNotice = (): SurfaceNoticeReading | undefined => notice.read()
  const focusedEntry = (): SessionEntry | undefined => visible[selected]
  const selectableLength = (): number => visible.length + (trailing?.kind === 'more' || trailing?.kind === 'refresh' ? 1 : 0)
  /**
   * Ask the catalog for the title work this frame can make useful.
   *
   * Only the first viewport and the selected neighborhood are requested for an
   * ordinary list. A query is different: an unresolved title can still match,
   * so the owner is asked to complete the retained corpus before the UI claims
   * that no session matches.
   */
  const prioritizeVisibleTitles = (capacity: number, exhaustive: boolean): void => {
    if (mode !== 'filter' || spec.prioritizeTitles === undefined) return
    if (exhaustive) {
      spec.prioritizeTitles(visible, true)
      return
    }
    if (visible.length === 0) return
    const wanted = Math.max(1, Math.min(visible.length, capacity))
    const priority: SessionEntry[] = []
    const seen = new Set<SessionId>()
    const add = (entry: SessionEntry | undefined): void => {
      if (entry === undefined || seen.has(entry.id)) return
      seen.add(entry.id)
      priority.push(entry)
    }
    add(visible[selected])
    for (let index = 0; index < wanted; index += 1) add(visible[index])
    for (let index = Math.max(0, selected - 2); index <= Math.min(visible.length - 1, selected + 2); index += 1) {
      add(visible[index])
    }
    spec.prioritizeTitles(priority)
  }
  const move = (amount: number): void => {
    const length = selectableLength()
    if (length === 0) return
    selected = (selected + amount + length) % length
    spec.invalidate()
  }
  const edit = (next: string): void => {
    query = next
    spec.titleQueryChanged?.(next)
    // A content result answers the PREVIOUS words. Editing returns to the
    // immediate title/workspace filter so the query line never labels stale rows.
    mode = 'filter'
    selected = 0
    loadingFrom = undefined
    loadingRevision = undefined
    viewport.first()
    spec.invalidate()
  }
  const toggleMode = (): void => {
    mode = mode === 'content' ? 'filter' : 'content'
    selected = 0
    loadingFrom = undefined
    loadingRevision = undefined
    viewport.first()
    if (mode === 'content') spec.search(query)
    else spec.invalidate()
  }
  const resume = (): void => {
    const entry = focusedEntry()
    if (entry === undefined) return
    const answer = spec.resume(entry)
    if (answer.kind === 'resume') {
      close()
      return
    }
    notice.show(answer.message)
    spec.invalidate()
  }
  const activateList = (): void => {
    if (selected === visible.length && trailing !== undefined) {
      if (trailing.kind === 'more') {
        if (loadingFrom !== undefined) return
        loadingFrom = visible.length
        const state = spec.content()
        loadingRevision = state.kind === 'ready' ? state.revision : undefined
        spec.loadMoreContent()
        spec.invalidate()
      } else if (trailing.kind === 'refresh') {
        spec.restartContentSearch()
      }
      return
    }
    resume()
  }
  const actions = (entry: SessionEntry): readonly Action[] => [
    { kind: 'events', label: 'Find in this session' },
    { kind: 'lineage', label: 'Lineage' },
    // Rename wields `ctx.sessionTitle`, which holds live Session objects only,
    // so it is offered on the session this window drives and nowhere else.
    ...entry.id === spec.currentSessionId && spec.renameDraft !== undefined
      ? [{ kind: 'rename', label: 'Rename' } as const]
      : [],
  ]
  /**
   * Disclose the focused session's detail and session-scoped actions.
   *
   * The ONLY place the bounded detail read is asked for: this is the surface
   * that presents an event count and a last-activity time, so opening it is
   * what pays for reading the log. Moving the cursor pays nothing.
   */
  const discloseFocused = (): void => {
    const entry = focusedEntry()
    if (entry === undefined) return
    submode = 'detail'
    actionSelected = 0
    spec.requestDetail(entry.id)
    spec.invalidate()
  }
  const focusInList = (sessionId: SessionId): boolean => {
    const index = visible.findIndex(entry => entry.id === sessionId)
    if (index < 0) return false
    selected = index
    submode = 'list'
    viewport.first()
    spec.invalidate()
    return true
  }
  const pushChild = (factory: (childClose: () => void) => TuiOverlay): void => {
    let closeRequested = false
    const child = factory(() => {
      closeRequested = true
      spec.invalidate()
    })
    const wrapped: SessionsChildOverlay = {
      [CHILD_CLOSE_REQUESTED]: () => closeRequested,
      render: (columns, rows) => child.render(columns, rows),
      handleKey: key => { child.handleKey(key) },
      ...(child.mounted === undefined ? {} : { mounted: () => { child.mounted?.() } }),
      ...(child.dispose === undefined ? {} : { dispose: () => { child.dispose?.() } }),
    }
    spec.push(wrapped)
  }
  const renameFailed = (error: unknown): void => {
    // The browser may have closed while the prompt was up; a dismissed overlay
    // must not repaint a live region that has moved on.
    if (closed) return
    const reason = error instanceof Error ? error.message : String(error)
    notice.show(`Rename failed: ${reason}`)
    spec.invalidate()
  }
  const renamed = (outcome: RenameDraftOutcome): void => {
    if (closed) return
    if (outcome.kind === 'renamed') {
      notice.show(`Renamed to “${outcome.title}”`)
    } else if (outcome.kind === 'failed') {
      notice.show(`Rename failed: ${outcome.message}`)
    }
    spec.invalidate()
  }
  /**
   * Open the corpus filter picker.
   *
   * Reached by `ctrl-f` from the list, because filters narrow the CORPUS: which
   * row happens to be under the cursor has nothing to do with it. The keystroke
   * is a ctrl gesture rather than a bare `f` for the reason the query line
   * exists — every printable character is already search input here.
   */
  const openFilters = (): void => {
    pushChild(childClose => createFilterOverlay({
      value: spec.filters(),
      workspace: spec.workspace,
      apply: filters => {
        spec.applyFilters(filters)
        if (mode !== 'content') return
        // A content filter change restarts the corpus from scratch: reset the
        // overlay's pagination bookkeeping (an armed load-more index belonged
        // to the resigned chain and would land on a different row in the
        // replacement results) and restart the SAME query cursorless under
        // the new clauses, so the reader does not fall back to metadata mode
        // and need a second tab to ask the question they were asking. An
        // empty query simply stays idle.
        selected = 0
        loadingFrom = undefined
        loadingRevision = undefined
        viewport.first()
        if (query.trim() !== '') spec.search(query)
      },
      close: childClose,
      invalidate: spec.invalidate,
    }))
  }
  const openAction = (target: SessionEntry): void => {
    const action = actions(target)[actionSelected]
    if (action === undefined) return
    if (action.kind === 'rename') {
      submode = 'list'
      const renameDraft = spec.renameDraft
      if (renameDraft === undefined) return
      // The disclosed row is the source of the prefill: it carries the currently
      // displayed authoritative folded title, even when that session came from
      // a content-search page rather than the bounded base listing.
      void renameDraft(target.title).then(renamed, renameFailed)
      return
    }
    if (action.kind === 'lineage') {
      pushChild(childClose => createLineageOverlay({
        target: target.id,
        lineage: spec.lineage,
        requestLineage: spec.requestLineage,
        home: spec.home,
        now: spec.now,
        focus: focusInList,
        close: childClose,
        invalidate: spec.invalidate,
      }))
      return
    }
    pushChild(childClose => createEventsOverlay({
      target: target.id,
      events: spec.events,
      searchEvents: spec.searchEvents,
      loadMoreEvents: spec.loadMoreEvents,
      readEvent: spec.requestEventContext,
      eventContext: spec.eventContext,
      push: pushChild,
      now: spec.now,
      close: childClose,
      invalidate: spec.invalidate,
    }))
  }

  return {
    render(columns, terminalRows = 24) {
      const resolved = resolve(spec, mode, query)
      visible = resolved.entries
      if (loadingFrom !== undefined) {
        // The catalog's revision is the authoritative landing signal: it changes
        // when a page settles even when that page appended no visible rows, so
        // a refused or empty page cannot leave the continuation row loading.
        const pageLanded = resolved.content === undefined
          || (loadingRevision !== undefined && resolved.content.revision !== loadingRevision)
        const appended = visible.length > loadingFrom
        if (appended || pageLanded || resolved.content?.restart === true) {
          // The old Load-more index is now the first newly appended entry, so
          // the cursor naturally lands on the start of the page. A page that
          // appended no retained entries simply clamps to the last real row.
          if (appended) selected = loadingFrom
          loadingFrom = undefined
          loadingRevision = undefined
        }
      }
      trailing = contentTrailing(resolved, loadingFrom !== undefined)
      const length = selectableLength()
      selected = Math.min(selected, Math.max(0, length - 1))
      prioritizeVisibleTitles(
        Math.max(1, terminalRows - SESSIONS_FIXED_ROWS),
        query.trim() !== '',
      )

      // The framed footer and the compact fallback must agree about what Enter
      // runs for the current selection, so classify it once. A content cursor's
      // `more available` is a Harness fact; the `↵ load more` action belongs to
      // the Load more row only while that row is actually under the cursor.
      const selectedTrailing = selected === visible.length ? trailing : undefined
      const resumable = focusedEntry() !== undefined
      const enterAction = selectedEnterAction(resumable, selectedTrailing)

      const disclosed = submode === 'detail' ? focusedEntry() : undefined
      if (disclosed !== undefined) {
        const available = actions(disclosed)
        actionSelected = Math.min(actionSelected, Math.max(0, available.length - 1))
        return renderDetail(disclosed, available, actionSelected, spec, columns, terminalRows)
      }
      // A corpus that moved under an open detail surface can leave the disclosed
      // row gone; the list is the honest place to be then.
      submode = 'list'
      const active = currentNotice()
      const compactContent = mode === 'content'
        && (columns <= CONTENT_COMPACT_COLUMNS || terminalRows <= CONTENT_COMPACT_ROWS)
      if (compactContent || terminalRows <= SESSIONS_FIXED_ROWS || columns < SESSIONS_MIN_COLUMNS) {
        return compactFallback(resolved, columns, terminalRows, active, enterAction)
      }
      const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
      const capacity = terminalRows - SESSIONS_FIXED_ROWS - (active === undefined ? 0 : 1)
      if (capacity <= 0) return compactFallback(resolved, columns, terminalRows, active, enterAction)
      const rendered = renderResolved(resolved, spec, mode, selected, trailing, inner, spec.now())
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      // Follow the selected BLOCK — an entry plus its match excerpt — rather than
      // the entry row alone, so the evidence for a content hit is not scrolled
      // off exactly when the reader is judging it. `End` pins the physical
      // bottom against the previous frame's geometry, so this render-time follow
      // is what makes one `End` press settle immediately. When the window cannot
      // hold the whole block, the ENTRY row wins: it identifies the result, and a
      // reader who cannot see which row is selected cannot judge its excerpt
      // either. `Math.min` caps the scroll at the entry's own row.
      const selectedEnd = rendered.selectedRow + rendered.selectedHeight
      const overshoot = selectedEnd - viewport.end
      if (overshoot > 0) viewport.move(Math.min(overshoot, rendered.selectedRow - viewport.start))
      const count = counter(resolved, rendered, viewport)
      const filtered = !equalFilters(spec.filters(), NO_FILTERS)
      const context = mode === 'content'
        ? `Sessions · contents${filtered ? ' · filtered' : ''}`
        : `Sessions${filtered ? ' · filtered' : ''}`
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint(context, 'overlay-title'),
          body: [
            queryRow(query, mode === 'content' ? `contents · ${count}` : count, inner),
            ...active === undefined
              ? []
              : [noticeLine(active.text, inner)],
            '',
            ...rendered.rows.slice(viewport.start, viewport.end),
          ],
          footer: fitFooterHelp(
            help(mode, query, resumable, selectedTrailing),
            footerBudget(columns),
          ),
        }),
      ]
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(resolved, columns, terminalRows, active, enterAction)
    },
    handleKey(key: Key) {
      if (submode === 'detail') {
        if (key.kind !== 'key') return
        const disclosed = focusedEntry()
        if (disclosed === undefined) {
          submode = 'list'
          spec.invalidate()
          return
        }
        const available = actions(disclosed)
        switch (key.name) {
          case 'up':
            actionSelected = (actionSelected - 1 + available.length) % available.length
            spec.invalidate()
            return
          case 'down':
            actionSelected = (actionSelected + 1) % available.length
            spec.invalidate()
            return
          case 'enter':
            openAction(disclosed)
            return
          // `left` is the inverse of the `right` that opened this, and `escape`
          // still means back, so neither gesture is a dead end.
          case 'left':
          case 'escape':
            submode = 'list'
            spec.invalidate()
            return
          case 'ctrl-c':
            close()
            return
          default:
            return
        }
      }
      if (key.kind === 'text') {
        edit(query + key.text)
        return
      }
      if (key.kind === 'paste') {
        edit(query + key.text.replace(/\s+/gu, ' '))
        return
      }
      switch (key.name) {
        case 'up':
          move(-1)
          return
        case 'down':
          move(1)
          return
        case 'home':
        case 'ctrl-a':
          selected = 0
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          selected = Math.max(0, selectableLength() - 1)
          viewport.last()
          spec.invalidate()
          return
        case 'backspace':
          edit([...query].slice(0, -1).join(''))
          return
        case 'ctrl-u':
          edit('')
          return
        case 'ctrl-w':
          edit(query.replace(/\s*\S*$/u, ''))
          return
        case 'tab':
          toggleMode()
          return
        case 'right':
          discloseFocused()
          return
        case 'ctrl-f':
          openFilters()
          return
        case 'enter':
          activateList()
          return
        case 'escape':
          if (query !== '') {
            edit('')
            return
          }
          close()
          return
        case 'ctrl-c':
          close()
          return
        default:
          return
      }
    },
    dispose(): void {
      notice.dispose()
    },
  }
}

/** Resolve the current listing or content corpus. */
function resolve(spec: SessionsOverlaySpec, mode: SessionSearchMode, query: string): Resolved {
  if (mode === 'content') return resolveContent(spec.content())
  const listing = spec.listing()
  switch (listing.kind) {
    case 'unavailable': return said('This profile mounts no session query service.')
    case 'loading': return said('Reading sessions…')
    case 'failed': return said(`Harness could not list sessions: ${listing.message}`)
    case 'ready': {
      const filtered = filterEntriesWithState(listing.entries, query)
      if (filtered.entries.length === 0) {
        return said(
          !filtered.complete
            ? 'Some session titles are still loading; matches may appear.'
            : query === '' ? 'No sessions yet.' : 'No session matches that.',
          filtered.complete,
        )
      }
      return {
        entries: filtered.entries,
        message: undefined,
        listed: listing.entries.length,
        ...listing.truncated > 0 ? { corpus: listing.entries.length + listing.truncated } : { corpus: undefined },
        content: undefined,
        filterComplete: filtered.complete,
      }
    }
  }
}

/** Resolve the optional corpus content-search state. */
function resolveContent(content: ContentState): Resolved {
  switch (content.kind) {
    case 'idle': return said('Type what a session said, then press tab to search contents.')
    case 'searching': return said('Searching session contents…')
    case 'unsupported': return said('This deployment’s session index offers no content search.')
    case 'failed': return said(`Content search failed: ${content.message}`)
    case 'ready': {
      if (content.entries.length > 0) {
        return {
          entries: content.entries,
          message: undefined,
          listed: content.entries.length,
          corpus: undefined,
          content,
          filterComplete: true,
        }
      }
      // Zero visible rows is not automatically "nothing matched": the backend
      // may have returned hits that the presentation-only origin filter
      // retained none of, and the opaque cursor may still lead to later pages
      // with matching-origin rows. The ready state is preserved so the
      // continuation row can stay selectable; only a search that returned
      // nothing AND has nowhere to continue says the flat no-match sentence.
      const stranded = content.returned === 0 && !content.more && !content.restart
      return {
        entries: [],
        message: stranded
          ? 'Nothing in any session log matches that.'
          : content.more || content.restart
            ? 'No returned results match the active filters yet.'
            : 'No returned results match the active filters.',
        listed: 0,
        corpus: undefined,
        content,
        filterComplete: true,
      }
    }
  }
}

/** Build a non-selectable resolution carrying one sentence. */
function said(text: string, filterComplete = true): Resolved {
  return { entries: [], message: text, listed: 0, corpus: undefined, content: undefined, filterComplete }
}

/** Decide whether a landed content result has a continuation row. */
function contentTrailing(resolved: Resolved, locallyLoading: boolean): Trailing | undefined {
  const content = resolved.content
  if (content === undefined) return undefined
  if (content.restart) return { kind: 'refresh' }
  if (content.loadingMore || locallyLoading) return { kind: 'loading' }
  return content.more ? { kind: 'more' } : undefined
}

/**
 * Draw entries, the selected row's excerpt, and an optional continuation row.
 *
 * Also reports the physical extent of the selected block and the physical row of
 * every selectable row, so the viewport can follow the block and the counter can
 * describe choices rather than every physical line.
 */
function renderResolved(
  resolved: Resolved,
  spec: SessionsOverlaySpec,
  mode: SessionSearchMode,
  selected: number,
  trailing: Trailing | undefined,
  inner: number,
  now: number,
): Rendered {
  if (resolved.entries.length === 0) {
    // A zero-visible-row result can still carry a selectable continuation: the
    // message row is not a session, so Enter on the trailing row must be the
    // only activation, and the message itself never resumes. The explanation is
    // presentation only and is never a choice; only the continuation is recorded.
    const rows = [paint(truncateToWidth(escapeControls(resolved.message ?? ''), inner), 'muted')]
    const selectableRows: number[] = []
    let selectedRow = 0
    if (trailing !== undefined) {
      const active = trailing.kind !== 'loading'
      if (active) selectedRow = rows.length
      if (active) selectableRows.push(rows.length)
      rows.push(trailingRow(trailing, active, inner))
    }
    return { rows, selectedRow, selectedHeight: 1, selectableRows }
  }
  const rows: string[] = []
  const selectableRows: number[] = []
  let selectedRow = 0
  let selectedHeight = 1
  resolved.entries.forEach((entry, index) => {
    const active = index === selected
    if (active) selectedRow = rows.length
    // Every visible entry is a choice; the excerpt below the selected one is not.
    selectableRows.push(rows.length)
    rows.push(entryRow(entry, active, spec, inner, now))
    if (active) {
      const excerpt = snippetRows(entry, mode, inner)
      rows.push(...excerpt)
      selectedHeight = rows.length - selectedRow
    }
  })
  if (trailing !== undefined) {
    const active = selected === resolved.entries.length && trailing.kind !== 'loading'
    if (active) selectedRow = rows.length
    // Only the actionable continuations are choices; `loading` is a status row.
    if (trailing.kind === 'more' || trailing.kind === 'refresh') selectableRows.push(rows.length)
    rows.push(trailingRow(trailing, active, inner))
  }
  return { rows, selectedRow, selectedHeight, selectableRows }
}

/** Draw one session row: the title, and the age that orders the list. */
function entryRow(
  entry: SessionEntry,
  active: boolean,
  spec: SessionsOverlaySpec,
  inner: number,
  now: number,
): string {
  const right = rightColumn(entry, spec, inner, active, now)
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 8))
  const label = truncateToWidth(
    escapeControls(sessionLabel(entry, spec.currentSessionId)),
    Math.max(1, inner - 3 - rightWidth),
  )
  const gap = Math.max(1, inner - 2 - displayWidth(label) - rightWidth)
  const plain = `${label}${' '.repeat(gap)}${truncateToWidth(right, rightWidth)}`
  if (active) return paint(`❯ ${plain}`, 'selection')
  return `  ${entryTitleState(entry).kind !== 'exact' || (entry.title === undefined && entry.id !== spec.currentSessionId)
    ? paint(plain, 'subdued')
    : plain}`
}

/**
 * The relationship and age shown at the right of a session row.
 *
 * `open` is the relationship a picker cannot defer: reopening the current session
 * is the choice Harness refuses. A delegated child is also worth one small list
 * label, because otherwise its row looks like an unrelated untitled session. Live
 * and fork details remain behind disclosure; they do not change what the reader
 * should choose.
 * @param entry - the row.
 * @param spec - the clock and the current session id.
 * @param inner - the frame's inner width.
 * @param active - whether the row is selected, so selection colour can own it.
 * @returns the right-hand column's text.
 */
function rightColumn(
  entry: SessionEntry,
  spec: SessionsOverlaySpec,
  inner: number,
  active: boolean,
  now: number,
): string {
  const age = relativeAge(entry.createdAt, now)
  const delegated = entry.origin === 'delegated'
    ? active ? 'delegated' : paint('delegated', 'subdued')
    : undefined
  const relation = [
    entry.id === spec.currentSessionId ? 'open' : undefined,
    delegated,
  ].filter((part): part is string => part !== undefined)
  if (relation.length === 0) return age
  const full = `${relation.join(' · ')} · ${age}`
  if (entry.id !== spec.currentSessionId) return full
  if (inner - 3 - displayWidth(full) >= MIN_TITLE_COLUMNS) return full
  const withoutOpen = `${delegated === undefined ? '' : `${delegated} · `}${age}`
  return inner - 3 - displayWidth(withoutOpen) >= MIN_TITLE_COLUMNS ? withoutOpen : age
}

/**
 * The excerpt Harness picked, under the selected content-search row.
 *
 * The one piece of secondary text the LIST still carries, because it is not
 * metadata about the session: it is the reason this row is in the result at
 * all, and a content hit with its match hidden is a row a reader cannot judge.
 * @param entry - the selected row.
 * @param mode - which corpus produced the row.
 * @param inner - the frame's inner width.
 * @returns the excerpt row, or nothing.
 */
function snippetRows(entry: SessionEntry, mode: SessionSearchMode, inner: number): string[] {
  if (mode !== 'content' || entry.snippet === undefined || entry.snippet === '') return []
  const snippet = escapeControls(entry.snippet).replaceAll('\n', ' ')
  return [paint(`    “${truncateToWidth(snippet, Math.max(1, inner - 7))}”`, 'subdued')]
}

/** Draw a selectable or dimmed content continuation row. */
function trailingRow(trailing: Trailing, active: boolean, inner: number): string {
  const label = trailing.kind === 'more'
    ? 'Load more…'
    : trailing.kind === 'refresh' ? 'Refresh (results changed)' : 'Loading more…'
  const row = `${active ? '❯' : ' '} ${truncateToWidth(label, Math.max(1, inner - 2))}`
  return paint(row, active ? 'selection' : trailing.kind === 'loading' ? 'subdued' : 'muted')
}

/** Draw the query line with its cursor and honest right-hand count. */
function queryRow(query: string, right: string, inner: number): string {
  const prompt = '⌕ '
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 4))
  const room = Math.max(1, inner - displayWidth(prompt) - rightWidth - 1)
  const shown = truncateToWidth(escapeControls(query), room)
  const typed = displayWidth(shown) >= room ? shown : `${shown}█`
  const gap = Math.max(1, inner - displayWidth(prompt) - displayWidth(typed) - rightWidth)
  return `${paint(prompt, 'prompt-mark')}${typed}${' '.repeat(gap)}${paint(truncateToWidth(right, rightWidth), 'muted')}`
}

/**
 * Draw one disclosed session: what it is, then what can be done to it.
 *
 * The facts are ordered most to least identifying, and a short terminal spends
 * its rows from the bottom of that order: the actions and the title are what
 * the surface is FOR, so a session id is surrendered before a Lineage entry
 * is, and the whole fact block is surrendered before the actions are.
 * @param entry - the disclosed session.
 * @param actions - its session-scoped actions.
 * @param selected - the focused action.
 * @param spec - detail reads, the clock, and the home directory.
 * @param columns - terminal width.
 * @param terminalRows - terminal height.
 * @returns the framed rows, or a compact fallback.
 */
function renderDetail(
  entry: SessionEntry,
  actions: readonly Action[],
  selected: number,
  spec: SessionsOverlaySpec,
  columns: number,
  terminalRows: number,
): string[] {
  if (terminalRows <= DETAIL_FIXED_ROWS || columns < SESSIONS_MIN_COLUMNS) {
    return compactDetail(columns, terminalRows)
  }
  const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
  const headline = paint(
    truncateToWidth(escapeControls(sessionLabel(entry, spec.currentSessionId)), inner),
    'overlay-headline',
  )
  const actionRows = actions.map((action, index) => {
    const label = truncateToWidth(action.label, Math.max(1, inner - 2))
    return index === selected ? paint(`❯ ${label}`, 'selection') : `  ${label}`
  })
  // The leading blank is body row zero, so the budget covers everything after
  // it: the headline, the separating blanks, the actions, and whatever facts fit.
  const room = terminalRows - DETAIL_FIXED_ROWS - actionRows.length - 3
  const facts = room <= 0
    ? []
    : sessionFacts(entry, spec.detail(entry.id), {
      home: spec.home,
      now: spec.now(),
    }).slice(0, room).map(fact => factRow(fact, inner))
  const frame = [
    '',
    ...rootFrame({
      columns,
      context: paint('Sessions · details', 'overlay-title'),
      body: ['', headline, '', ...facts.length === 0 ? [] : [...facts, ''], ...actionRows],
      footer: fitFooterHelp('↑↓ move · ↵ open · ←/esc back', footerBudget(columns)),
    }),
  ]
  return physicalRows(frame, columns).length <= terminalRows ? frame : compactDetail(columns, terminalRows)
}

/**
 * Draw one `label  value` fact line.
 * @param fact - the label and its already-authoritative value.
 * @param inner - the frame's inner width.
 * @returns the fitted row.
 */
function factRow(fact: SessionFact, inner: number): string {
  const room = Math.max(1, inner - 2 - DETAIL_LABEL_COLUMNS)
  const value = truncateToWidth(escapeControls(fact.value), room)
  const label = fact.label.padEnd(DETAIL_LABEL_COLUMNS)
  return `  ${paint(label, 'muted')}${value}`
}

/**
 * The content-search facts as whole segments, most significant first.
 *
 * The one source of wording truth for the framed counter and the compact
 * fallback. It states only what Sessions owns: the retained-versus-returned
 * relationship, whether Harness's opaque cursor has a next page, and whether a
 * page is already in flight. It never infers a page number or a remainder.
 * @param content - the landed content-search state.
 * @returns the count, the cursor fact, and an optional in-flight fact.
 */
function contentCounterSegments(
  content: Extract<ContentState, { kind: 'ready' }>,
): readonly [string, string, ...string[]] {
  const count = content.matched < content.returned
    ? `${String(content.matched)} of ${String(content.returned)} matched`
    : `${String(content.returned)} result${content.returned === 1 ? '' : 's'}`
  return [
    count,
    content.more ? 'more available' : 'end',
    ...content.loadingMore ? ['loading more'] : [],
  ]
}

/**
 * The framed content counter, before any local geometry is appended.
 * @param content - the landed content-search state.
 * @returns the counter text.
 */
function contentCount(content: Extract<ContentState, { kind: 'ready' }>): string {
  return contentCounterSegments(content).join(' · ')
}

/**
 * Count sessions and continuation facts without inventing page numbers.
 *
 * `more below` is the one local-geometry fact here: it says another selectable
 * entry or continuation action sits outside the viewport, and stays separate
 * from the Harness cursor's `more available` / `end` and the local `loading
 * more`. The selected result's excerpt and a `Loading more…` status row are
 * physical rows without being choices, so they never earn it.
 */
function counter(resolved: Resolved, rendered: Rendered, viewport: RowViewport): string {
  const content = resolved.content
  let count: string
  if (content !== undefined) {
    count = contentCount(content)
  } else {
    const shown = resolved.entries.length
    if (shown === 0) return ''
    count = shown === resolved.listed
      ? `${String(shown)} session${shown === 1 ? '' : 's'}`
      : `${String(shown)} of ${String(resolved.listed)}`
    if (resolved.corpus !== undefined) count += ` · newest of ${String(resolved.corpus)}`
  }
  if (!resolved.filterComplete) count += ' · titles loading'
  // `viewport.end` is exclusive, so a choice exactly at that row is below. Only
  // recorded choices can earn the hint; a hidden excerpt or `Loading more…` row
  // is geometry, not another choice.
  if (rendered.selectableRows.some(row => row >= viewport.end)) count += ' · more below'
  return count
}

/**
 * The action Enter will run for the current selection.
 *
 * Derived from the SELECTION rather than from `content.more`: `more available`
 * is a Harness cursor fact, while `↵ load more` belongs to the local Load more
 * row being selected. A `loading` trailing row is a status row and is never
 * selectable, so it contributes no action.
 * @param resumable - whether a real session row is under the cursor.
 * @param selectedTrailing - the continuation row, when it is the selection.
 * @returns the action label, or undefined when Enter has no browser action.
 */
function selectedEnterAction(
  resumable: boolean,
  selectedTrailing: Trailing | undefined,
): string | undefined {
  if (selectedTrailing?.kind === 'more') return '↵ load more'
  if (selectedTrailing?.kind === 'refresh') return '↵ refresh'
  return resumable ? '↵ reopen' : undefined
}

/**
 * Choose whole help segments for the current list state.
 *
 * Ordered least to most essential, because {@link fitFooterHelp} drops from the
 * front: the keyboard model a narrowing terminal keeps longest is the one a
 * reader cannot guess — reopening, and the way out.
 * @param mode - which corpus the rows came from.
 * @param query - the current query, which decides what escape means.
 * @param resumable - whether a real session row is under the cursor.
 * @param selectedTrailing - the continuation row, when it is the selection.
 * @returns the help line before fitting.
 */
function help(
  mode: SessionSearchMode,
  query: string,
  resumable: boolean,
  selectedTrailing: Trailing | undefined,
): string {
  const action = selectedEnterAction(resumable, selectedTrailing)
  return [
    ...selectableHelp(resumable || action !== undefined),
    mode === 'content' ? 'tab filter' : 'tab search contents',
    'ctrl-f filters',
    ...resumable ? ['→ details'] : [],
    ...action === undefined ? [] : [action],
    query === '' ? 'esc close' : 'esc clear',
  ].join(' · ')
}

/** Include movement help only while the cursor has somewhere to move. */
function selectableHelp(selectable: boolean): string[] {
  return selectable ? ['↑↓ move'] : []
}

/** Count physical terminal rows for a candidate frame. */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * One notice as a single physical row.
 *
 * A notice's text is untrusted, and it can contain newlines (a Harness error
 * message). A newline would let `Screen` expand one logical row into several,
 * overflowing a short terminal, so lines are flattened after escaping, before
 * styling and truncation.
 * @param text - the notice text.
 * @param inner - the frame's inner width, or the terminal width in fallback.
 * @returns one fitted error row.
 */
function noticeLine(text: string, inner: number): string {
  const flat = escapeControls(text).replaceAll('\n', ' ')
  return paint(truncateToWidth(flat, Math.max(1, inner)), 'error')
}

/**
 * Give a tiny terminal one safe, closable Sessions summary.
 *
 * A landed content result projects the SAME facts the framed counter states —
 * results, cursor, in-flight load — plus the action Enter will actually run.
 * Ordinary filter mode keeps its existing `N sessions · ↵ reopen` line.
 * @param resolved - the resolved corpus.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @param notice - an active refusal, which owns the row.
 * @param enterAction - the action Enter will run for the current selection.
 * @returns one fitted physical row, or nothing.
 */
function compactFallback(
  resolved: Resolved,
  columns: number,
  rows: number,
  notice: SurfaceNoticeReading | undefined,
  enterAction: string | undefined,
): string[] {
  if (rows <= 0) return []
  if (notice !== undefined) {
    return [noticeLine(notice.text, Math.max(1, columns))]
  }
  const content = resolved.content
  const candidates = content === undefined
    ? [
      resolved.entries.length === 0
        ? 'Sessions · esc close'
        : `${String(resolved.entries.length)} sessions · ↵ reopen · esc close`,
      'esc close',
      'esc',
    ]
    : compactContentLines(content, enterAction)
  const shown = candidates.find(candidate => displayWidth(candidate) <= columns)
  return shown === undefined ? [] : [paint(shown, 'overlay-headline')]
}

/**
 * The compact content summary, most complete first.
 *
 * Each candidate is a whole-segment projection of the same facts the framed
 * counter states, followed by the current Enter action and the exit. A narrower
 * terminal drops whole segments rather than wrapping or substituting a generic
 * sentence: a `sessions` count would be a lie here because a content row is a
 * result, and the action must stay the one Enter will run. `more below` is
 * deliberately absent — it describes viewport geometry the one-line form has no
 * viewport to measure.
 * @param content - the landed content-search state.
 * @param action - the Enter action for the current selection, when there is one.
 * @returns candidate lines, widest first.
 */
function compactContentLines(
  content: Extract<ContentState, { kind: 'ready' }>,
  action: string | undefined,
): readonly string[] {
  const [count, cursor, ...inFlight] = contentCounterSegments(content)
  const withTail = (segments: readonly string[]): string =>
    [...segments, ...action === undefined ? [] : [action], 'esc close'].join(' · ')
  return [
    withTail([count, cursor, ...inFlight]),
    withTail([count, cursor]),
    withTail([count]),
    withTail([]),
    'esc close',
    'esc',
  ]
}

/** Give a tiny terminal one safe detail-surface summary. */
function compactDetail(columns: number, rows: number): string[] {
  if (rows <= 0) return []
  const shown = ['Details · esc back', 'esc back', 'esc'].find(candidate => displayWidth(candidate) <= columns)
  return shown === undefined ? [] : [paint(shown, 'overlay-headline')]
}
