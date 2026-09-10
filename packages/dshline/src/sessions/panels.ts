/** Bounded child panels the Sessions browser opens over itself. */

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
import { extractSessionEventText, type SessionEventWindow } from '@deepseek-ai/dsh-session-query'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import type {
  AgeChoice,
  OriginChoice,
  SessionFiltersValue,
  WorkspaceChoice,
} from './filters.ts'
import type { EventContextState, EventHitEntry, EventSearchState } from './model.ts'
import { relativeAge } from './model.ts'

/** Rows outside a child panel's scrolling body. */
const PANEL_FIXED_ROWS = 4

/** Rows outside the events browser's scrolling body, including its query row. */
const EVENTS_FIXED_ROWS = 5

/** Rows outside the context inspector's scrolling body: summary, borders, spacer. */
const CONTEXT_FIXED_ROWS = 5

/** Columns an event's semantic text is indented under its metadata row. */
const CONTEXT_INDENT = 4

/** Narrowest terminal that can show a useful two-column browser row. */
const PANEL_MIN_COLUMNS = BOX_CHROME_COLUMNS + 24

/** Title room protected before a right-hand event label is drawn. */
const MIN_EVENT_TEXT_COLUMNS = 16

/** Number of independently focused fields in the filter picker. */
const FILTER_FIELD_COUNT = 3

/** Private signal consumed by the Sessions owner after a child handles a key. */
export const CHILD_CLOSE_REQUESTED = Symbol('dshline.sessions.child-close-requested')

/** A child overlay that can ask its stack owner to remove it. */
export interface SessionsChildOverlay extends TuiOverlay {
  /** Whether the child has asked to be removed from the overlay stack. */
  readonly [CHILD_CLOSE_REQUESTED]: () => boolean
}

/** What the filter picker needs from its parent browser. */
export interface FilterOverlaySpec {
  /** Filter value copied when the picker opens. */
  readonly value: SessionFiltersValue
  /** Effective workspace; without one, `current` is not an available choice. */
  readonly workspace: string | undefined
  /** Apply the complete edited value. */
  readonly apply: (filters: SessionFiltersValue) => void
  /** Ask the stack owner to remove this child. */
  readonly close: () => void
  /** Redraw after a field move or value change. */
  readonly invalidate: () => void
}

/** What the within-session event browser needs from its parent. */
export interface EventsOverlaySpec {
  /** Session whose events are searched. */
  readonly target: SessionId
  /** Current event-search state. */
  readonly events: () => EventSearchState
  /** Start or restart a within-session search. */
  readonly searchEvents: (sessionId: SessionId, query: string) => void
  /** Append the next event-search page. */
  readonly loadMoreEvents: () => void
  /**
   * Read bounded context for one hit.
   *
   * The only read this overlay calls on activation of an ordinary hit; it is
   * never called while hits land, render, or move under the cursor.
   */
  readonly readEvent: (sessionId: SessionId, seq: SessionSeq) => void
  /** The catalog's context state for one exact hit. */
  readonly eventContext: (sessionId: SessionId, seq: SessionSeq) => EventContextState
  /** Push a child overlay onto the slot stack; the browser stays mounted beneath. */
  readonly push: (overlay: (childClose: () => void) => TuiOverlay) => void
  /** Current time for relative event ages. */
  readonly now: () => number
  /** Ask the stack owner to remove this child. */
  readonly close: () => void
  /** Redraw after editing, moving, or starting a read. */
  readonly invalidate: () => void
}

/** One selectable continuation row after landed results. */
type Trailing = { readonly kind: 'more' | 'refresh' | 'loading' }

/** Rendered event rows and the physical row holding the cursor. */
interface RenderedEvents {
  readonly rows: readonly string[]
  readonly selectedRow: number
}

/**
 * Create the three-field Sessions filter picker.
 * @param spec - initial value, workspace availability, and owner controls.
 * @returns a bounded child overlay that applies only on Enter.
 */
export function createFilterOverlay(spec: FilterOverlaySpec): SessionsChildOverlay {
  let value: SessionFiltersValue = { ...spec.value }
  let selected = 0
  let closed = false
  let applied = false

  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const cycle = (amount: number): void => {
    if (selected === 0) {
      const choices: readonly WorkspaceChoice[] = spec.workspace === undefined ? ['all'] : ['all', 'current']
      value = { ...value, workspace: cycleValue(value.workspace, choices, amount) }
    } else if (selected === 1) {
      const choices: readonly OriginChoice[] = ['all', 'own', 'delegated']
      value = { ...value, origin: cycleValue(value.origin, choices, amount) }
    } else {
      const choices: readonly AgeChoice[] = ['all', 'today', '7d', '30d']
      value = { ...value, age: cycleValue(value.age, choices, amount) }
    }
    spec.invalidate()
  }

  return {
    [CHILD_CLOSE_REQUESTED]: () => closed,
    render(columns, terminalRows = 24) {
      if (terminalRows <= PANEL_FIXED_ROWS || columns < PANEL_MIN_COLUMNS) {
        return compactPanel('Filters', columns, terminalRows)
      }
      const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
      const labels = [
        ['Workspace', value.workspace],
        ['Origin', value.origin],
        ['Age', value.age],
      ] as const
      const body = labels.map(([label, choice], index) => pickerRow(label, choice, index === selected, inner))
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint('Sessions · filters', 'overlay-title'),
          body: ['', ...body],
          footer: fitFooterHelp(
            '↑↓ field · ←→ change · ↵ apply · esc cancel',
            footerBudget(columns),
          ),
        }),
      ]
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactPanel('Filters', columns, terminalRows)
    },
    handleKey(key: Key) {
      if (closed || key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          selected = (selected + FILTER_FIELD_COUNT - 1) % FILTER_FIELD_COUNT
          spec.invalidate()
          return
        case 'down':
          selected = (selected + 1) % FILTER_FIELD_COUNT
          spec.invalidate()
          return
        case 'left':
          cycle(-1)
          return
        case 'right':
          cycle(1)
          return
        case 'enter':
          if (applied) return
          applied = true
          spec.apply({ ...value })
          close()
          return
        case 'escape':
        case 'ctrl-c':
          close()
          return
        default:
          return
      }
    },
  }
}

/**
 * Create a query-line browser over full-text hits inside one session.
 * @param spec - target session, event-search state, and owner controls.
 * @returns a bounded child overlay whose hit rows are intentionally read-only.
 */
export function createEventsOverlay(spec: EventsOverlaySpec): SessionsChildOverlay {
  const viewport = new RowViewport()
  let query = ''
  let submitted = ''
  let selected = 0
  let visible: readonly EventHitEntry[] = []
  let trailing: Trailing | undefined
  let loadingFrom: number | undefined
  let loadingRevision: number | undefined
  let closed = false

  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const edit = (next: string): void => {
    query = next
    selected = 0
    viewport.first()
    spec.invalidate()
  }
  const runSearch = (): void => {
    const trimmed = query.trim()
    if (trimmed === '') return
    submitted = trimmed
    selected = 0
    loadingFrom = undefined
    loadingRevision = undefined
    viewport.first()
    spec.searchEvents(spec.target, trimmed)
  }
  const selectableLength = (): number => visible.length + (trailing?.kind === 'more' || trailing?.kind === 'refresh' ? 1 : 0)
  const move = (amount: number): void => {
    const length = selectableLength()
    if (length === 0) return
    selected = (selected + amount + length) % length
    spec.invalidate()
  }
  /**
   * Disclose one hit's bounded surrounding context.
   *
   * The read and the child it presents are requested together, from this one
   * explicit activation, so nothing above pays for a raw-log window it is not
   * showing.
   * @param hit - the activated result row.
   */
  const openContext = (hit: EventHitEntry): void => {
    spec.readEvent(hit.sessionId, hit.seq)
    spec.push(childClose => createEventContextOverlay({
      context: () => spec.eventContext(hit.sessionId, hit.seq),
      now: spec.now,
      close: childClose,
      invalidate: spec.invalidate,
    }))
  }
  const activate = (): void => {
    if (selected === visible.length) {
      if (trailing === undefined) return
      if (trailing.kind === 'more') {
        if (loadingFrom !== undefined) return
        loadingFrom = visible.length
        const state = spec.events()
        loadingRevision = state.kind === 'ready' ? state.revision : undefined
        spec.loadMoreEvents()
        spec.invalidate()
      } else if (trailing.kind === 'refresh') {
        const state = spec.events()
        if (state.kind === 'ready') {
          submitted = state.query
          spec.searchEvents(spec.target, state.query)
        }
      }
      return
    }
    const hit = visible[selected]
    if (hit !== undefined) openContext(hit)
  }

  return {
    [CHILD_CLOSE_REQUESTED]: () => closed,
    render(columns, terminalRows = 24) {
      const state = displayedEventState(spec.events(), spec.target, submitted, query)
      visible = state.kind === 'ready' ? state.hits : []
      if (loadingFrom !== undefined) {
        // The catalog's revision is the authoritative landing signal; see the
        // main browser's identical guard for the reasoning.
        const pageLanded = state.kind !== 'ready'
          || (loadingRevision !== undefined && state.revision !== loadingRevision)
        const appended = visible.length > loadingFrom
        if (appended || pageLanded || (state.kind === 'ready' && state.restart)) {
          if (appended) selected = loadingFrom
          loadingFrom = undefined
          loadingRevision = undefined
        }
      }
      trailing = eventTrailing(state, loadingFrom !== undefined)
      const length = selectableLength()
      selected = Math.min(selected, Math.max(0, length - 1))

      if (terminalRows <= EVENTS_FIXED_ROWS || columns < PANEL_MIN_COLUMNS) {
        return compactPanel('Events', columns, terminalRows)
      }
      const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
      const capacity = terminalRows - EVENTS_FIXED_ROWS
      if (capacity <= 0) return compactPanel('Events', columns, terminalRows)
      const rendered = renderEvents(state, spec, selected, trailing, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      if (rendered.selectedRow >= viewport.end) viewport.move(rendered.selectedRow - viewport.end + 1)
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint('Sessions · events', 'overlay-title'),
          body: [
            eventQueryRow(query, inner),
            '',
            ...rendered.rows.slice(viewport.start, viewport.end),
          ],
          footer: fitFooterHelp(
            eventHelp(selected < visible.length, selected === visible.length ? trailing : undefined),
            footerBudget(columns),
          ),
        }),
      ]
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactPanel('Events', columns, terminalRows)
    },
    handleKey(key: Key) {
      if (closed) return
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
          runSearch()
          return
        case 'enter':
          activate()
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
  }
}

/** What the bounded context inspector needs from its parent browser. */
export interface EventContextOverlaySpec {
  /**
   * The catalog's current context state for this exact hit.
   *
   * The catalog has already narrowed this to the hit the panel was opened for,
   * so the inspector draws what it returns and does not re-identify the hit.
   */
  readonly context: () => EventContextState
  /** Current time for relative event ages. */
  readonly now: () => number
  /** Ask the stack owner to remove this child. */
  readonly close: () => void
  /** Redraw after scrolling. */
  readonly invalidate: () => void
}

/** Rendered context rows and the physical row span holding the target event. */
interface RenderedContext {
  readonly headline: string
  readonly rows: readonly string[]
  /** First physical row of the target event, or -1 when it is not shown. */
  readonly targetRow: number
  /** Exclusive end of the target event's rows, or -1 when it is not shown. */
  readonly targetEndRow: number
}

/**
 * Create a bounded, scrollable inspector over one hit and its neighbors.
 *
 * The window is already bounded by the catalog's read, and this panel bounds it
 * again to the terminal: only whole committed-frame rows are drawn, the rest
 * scroll, and the target is marked rather than left for the reader to find. The
 * content itself is Harness's own semantic extraction, escaped before it is
 * measured so an event payload can never drive the terminal.
 * @param spec - target hit, catalog state, and owner controls.
 * @returns a bounded child overlay that closes on esc or ctrl-c.
 */
export function createEventContextOverlay(spec: EventContextOverlaySpec): SessionsChildOverlay {
  const viewport = new RowViewport()
  let closed = false
  let positioned = false
  /**
   * The last ready presentation, kept against the window and width that made it.
   *
   * A ready window is immutable, but the semantic text inside one event is not
   * bounded by the event count: a single tool result can be large. Re-running
   * Harness's extraction, escaping, and wrapping over the whole window on every
   * arrow-key redraw is work with no output, so it is done once per window per
   * width. The relative ages are fixed at that first paint; a resize or a new
   * window is what recomputes, exactly as `tool-output.ts` and
   * `plan-review.ts` cache their immutable documents.
   */
  let cachedPresentation: { readonly window: SessionEventWindow; readonly inner: number; readonly rendered: RenderedContext } | undefined

  /**
   * The window's presentation at one width, rendering only when either changed.
   * @param state - the catalog's current context state.
   * @param inner - the frame's inner width.
   * @returns the rendered context.
   */
  const presentation = (state: EventContextState, inner: number): RenderedContext => {
    if (state.kind !== 'ready') return renderEventContext(state, inner, spec.now())
    const cached = cachedPresentation
    if (cached !== undefined && cached.window === state.window && cached.inner === inner) return cached.rendered
    const rendered = renderEventContext(state, inner, spec.now())
    cachedPresentation = { window: state.window, inner, rendered }
    return rendered
  }

  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }

  return {
    [CHILD_CLOSE_REQUESTED]: () => closed,
    render(columns, terminalRows = 24) {
      if (terminalRows <= CONTEXT_FIXED_ROWS || columns < PANEL_MIN_COLUMNS) {
        return compactPanel('Context', columns, terminalRows)
      }
      const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
      const capacity = terminalRows - CONTEXT_FIXED_ROWS
      if (capacity <= 0) return compactPanel('Context', columns, terminalRows)
      const state = spec.context()
      const rendered = presentation(state, inner)
      viewport.update(rendered.rows.length, capacity)
      if (!positioned && rendered.targetRow >= 0) {
        // Open on the match, not on whichever neighbor happens to come first:
        // the reader asked for THIS event, and a short terminal can otherwise
        // show eight preceding events and never the highlighted one. The whole
        // target block is brought into view where it fits, and positioning
        // happens once so scrolling afterwards is not snapped back on redraw.
        if (rendered.targetEndRow > viewport.end) viewport.move(rendered.targetEndRow - viewport.end)
        if (rendered.targetRow < viewport.start) viewport.move(rendered.targetRow - viewport.start)
        positioned = true
      }
      // Positioning can leave rows hidden ABOVE with none below, and End can
      // leave rows hidden above with none below too; help is truthful only when
      // it looks in both directions.
      const scrollable = viewport.start > 0 || viewport.end < rendered.rows.length
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint('Sessions · context', 'overlay-title'),
          body: [
            rendered.headline,
            '',
            ...rendered.rows.slice(viewport.start, viewport.end),
          ],
          footer: fitFooterHelp(
            contextHelp(state, scrollable),
            footerBudget(columns),
          ),
        }),
      ]
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactPanel('Context', columns, terminalRows)
    },
    handleKey(key: Key) {
      if (closed || key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          if (viewport.move(-1)) spec.invalidate()
          return
        case 'down':
          if (viewport.move(1)) spec.invalidate()
          return
        case 'home':
          if (viewport.first()) spec.invalidate()
          return
        case 'end':
          if (viewport.last()) spec.invalidate()
          return
        case 'escape':
        case 'ctrl-c':
          close()
          return
        default:
          return
      }
    },
  }
}

/** Cycle one choice, wrapping at both ends. */
function cycleValue<T>(current: T, choices: readonly T[], amount: number): T {
  const at = Math.max(0, choices.indexOf(current))
  return choices[(at + amount + choices.length) % choices.length] ?? current
}

/** Draw one filter field without allowing its current value to disappear. */
function pickerRow(label: string, value: string, active: boolean, inner: number): string {
  const plain = truncateToWidth(`${label} · ${value}`, Math.max(1, inner - 2))
  return active ? paint(`❯ ${plain}`, 'selection') : `  ${plain}`
}

/** Hide stale event results as soon as the visible query is edited. */
function displayedEventState(
  state: EventSearchState,
  target: SessionId,
  submitted: string,
  query: string,
): EventSearchState {
  if (query.trim() !== submitted) return { kind: 'idle' }
  if ((state.kind === 'searching' || state.kind === 'ready') && state.sessionId !== target) return { kind: 'idle' }
  if ((state.kind === 'searching' || state.kind === 'ready') && state.query !== submitted) return { kind: 'idle' }
  return state
}

/** Decide whether landed event hits have a continuation action. */
/**
 * Decide whether landed event hits have a continuation action.
 *
 * A ready state exposes one even with zero hits: the pagination contract
 * returns opaque cursor pages and does not promise a non-final page can never
 * be empty. Only a finished, empty result has no continuation.
 * @param state - the ready event-search state to read.
 * @param locallyLoading - whether this browser's own load is still armed.
 * @returns the continuation kind, or undefined at the end of results.
 */
function eventTrailing(state: EventSearchState, locallyLoading: boolean): Trailing | undefined {
  if (state.kind !== 'ready') return undefined
  if (state.restart) return { kind: 'refresh' }
  if (state.loadingMore || locallyLoading) return { kind: 'loading' }
  return state.more ? { kind: 'more' } : undefined
}

/** Turn one event-search state into viewport rows. */
function renderEvents(
  state: EventSearchState,
  spec: EventsOverlaySpec,
  selected: number,
  trailing: Trailing | undefined,
  inner: number,
): RenderedEvents {
  if (state.kind !== 'ready' || state.hits.length === 0) {
    // A zero-hit ready state can still carry a selectable continuation; the
    // message row itself is never an activation target.
    const rows = [paint(truncateToWidth(escapeControls(eventMessage(state)), inner), state.kind === 'failed' ? 'error' : 'muted')]
    let selectedRow = 0
    if (trailing !== undefined) {
      const active = trailing.kind !== 'loading'
      if (active) selectedRow = rows.length
      rows.push(trailingRow(trailing, active, inner))
    }
    return { rows, selectedRow }
  }
  const rows: string[] = []
  let selectedRow = 0
  state.hits.forEach((hit, index) => {
    const active = index === selected
    if (active) selectedRow = rows.length
    rows.push(eventRow(hit, active, spec, inner))
    if (active) rows.push(eventDetailRow(hit, spec, inner))
  })
  if (trailing !== undefined) {
    const active = selected === state.hits.length && trailing.kind !== 'loading'
    if (active) selectedRow = rows.length
    rows.push(trailingRow(trailing, active, inner))
  }
  return { rows, selectedRow }
}

/** Sentence standing in for an event result list. */
function eventMessage(state: EventSearchState): string {
  switch (state.kind) {
    case 'idle': return 'Type what this session said, then press tab.'
    case 'searching': return 'Searching this session…'
    case 'unsupported': return 'This deployment offers no within-session search.'
    case 'failed': return `Search failed: ${state.message}`
    case 'ready':
      // A finished empty result states the flat truth; a pageable one says the
      // pages read so far carried nothing, without declaring the search over.
      return state.more || state.restart
        ? 'No matching events on the pages read so far.'
        : 'Nothing in this session matches that.'
  }
}

/** Draw one event hit with provider text on the left and exact metadata right. */
function eventRow(hit: EventHitEntry, active: boolean, spec: EventsOverlaySpec, inner: number): string {
  const right = escapeControls(`${hit.type} · ${relativeAge(hit.time, spec.now())}`)
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - MIN_EVENT_TEXT_COLUMNS - 3))
  const snippetRoom = Math.max(1, inner - 2 - rightWidth - 1)
  const snippet = truncateToWidth(escapeControls(hit.snippet).replaceAll('\n', ' '), snippetRoom)
  const gap = Math.max(1, inner - 2 - displayWidth(snippet) - rightWidth)
  const plain = `${snippet}${' '.repeat(gap)}${truncateToWidth(right, rightWidth)}`
  return active ? paint(`❯ ${plain}`, 'selection') : `  ${plain}`
}

/** Draw authoritative type, sequence, and time under the selected event. */
function eventDetailRow(hit: EventHitEntry, spec: EventsOverlaySpec, inner: number): string {
  const facts = escapeControls(`${hit.type} · seq ${String(hit.seq)} · ${relativeAge(hit.time, spec.now())}`)
  return paint(`    ${truncateToWidth(facts, Math.max(1, inner - 4))}`, 'muted')
}

/** Draw a continuation row, dimming the non-selectable loading state. */
function trailingRow(trailing: Trailing, active: boolean, inner: number): string {
  const label = trailing.kind === 'more'
    ? 'Load more…'
    : trailing.kind === 'refresh' ? 'Refresh (results changed)' : 'Loading more…'
  const row = `${active ? '❯' : ' '} ${truncateToWidth(label, Math.max(1, inner - 2))}`
  return paint(row, active ? 'selection' : trailing.kind === 'loading' ? 'subdued' : 'muted')
}

/** Draw the event query prompt and visible cursor block. */
function eventQueryRow(query: string, inner: number): string {
  const prompt = '⌕ '
  const room = Math.max(1, inner - displayWidth(prompt))
  const shown = truncateToWidth(escapeControls(query), room)
  const typed = displayWidth(shown) >= room ? shown : `${shown}█`
  return `${paint(prompt, 'prompt-mark')}${typed}`
}

/**
 * Choose truthful event help for the selected row.
 *
 * A hit opens context; the trailing row keeps its own continuation actions.
 * @param selectedHit - whether a real result row, not the trailing row, is selected.
 * @param trailing - the continuation row, when it is selected.
 * @returns the help line before fitting.
 */
function eventHelp(selectedHit: boolean, trailing: Trailing | undefined): string {
  const action = trailing?.kind === 'more'
    ? '↵ load more'
    : trailing?.kind === 'refresh'
      ? '↵ refresh'
      : selectedHit ? '↵ context' : undefined
  return ['type query', 'tab search', '↑↓ move', ...action === undefined ? [] : [action], 'esc back'].join(' · ')
}

/**
 * Turn one disclosed hit's context state into a headline and scrolling rows.
 *
 * Every displayed fact is Harness's: the event type, its sequence number, the
 * time it was recorded (shown as a relative age), and the body produced by
 * Harness's own {@link extractSessionEventText}. An event with no semantic text
 * — a structural boundary or an unknown declaration-merged type — deliberately
 * contributes only its metadata row rather than a stringified payload.
 * @param state - the catalog's context state for this hit.
 * @param inner - the frame's inner width.
 * @param now - the clock the relative ages are inscribed against.
 * @returns the headline, the physical rows, and the target's row index.
 */
function renderEventContext(state: EventContextState, inner: number, now: number): RenderedContext {
  switch (state.kind) {
    case 'idle':
      return { headline: paint(truncateToWidth('No event context.', inner), 'muted'), rows: [], targetRow: -1, targetEndRow: -1 }
    case 'loading':
      return {
        headline: paint(truncateToWidth('Reading surrounding events…', inner), 'muted'),
        rows: [],
        targetRow: -1,
        targetEndRow: -1,
      }
    case 'failed':
      return {
        headline: paint(truncateToWidth(`Context failed: ${escapeControls(state.message)}`, inner), 'error'),
        rows: [],
        targetRow: -1,
        targetEndRow: -1,
      }
    case 'ready': {
      const { window } = state
      const extent = `seq ${String(window.startSeq)}–${String(window.endSeq)} · `
        + `${String(window.events.length)} event${window.events.length === 1 ? '' : 's'}`
      const headline = paint(truncateToWidth(escapeControls(extent), inner), 'muted')
      const rows: string[] = []
      let targetRow = -1
      let targetEndRow = -1
      const textWidth = Math.max(1, inner - CONTEXT_INDENT)
      for (const event of window.events) {
        const isTarget = event.seq === window.target.seq
        if (isTarget) targetRow = rows.length
        const meta = `${event.type} · seq ${String(event.seq)} · ${relativeAge(event.time, now)}`
        rows.push(paint(
          `${isTarget ? '▶' : ' '} ${truncateToWidth(escapeControls(meta), Math.max(1, inner - 2))}`,
          isTarget ? 'selection' : 'muted',
        ))
        const text = extractSessionEventText(event)
        if (text !== '') {
          for (const line of wrapToWidth(escapeControls(text), textWidth)) {
            rows.push(line === '' ? '' : `${' '.repeat(CONTEXT_INDENT)}${line}`)
          }
        }
        if (isTarget) targetEndRow = rows.length
      }
      return { headline, rows, targetRow, targetEndRow }
    }
  }
}

/** Choose context help, advertising scroll while rows are hidden above or below. */
function contextHelp(state: EventContextState, scrollable: boolean): string {
  return [...state.kind === 'ready' && scrollable ? ['↑↓ scroll'] : [], 'esc close'].join(' · ')
}

/** Count physical rows the terminal would draw. */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/** Give a tiny terminal one safe, closable child-panel summary. */
function compactPanel(label: string, columns: number, rows: number): string[] {
  if (rows <= 0) return []
  const candidates = [`${label} · esc back`, 'esc back', 'esc']
  const shown = candidates.find(candidate => displayWidth(candidate) <= columns)
  return shown === undefined ? [] : [paint(shown, 'overlay-headline')]
}
