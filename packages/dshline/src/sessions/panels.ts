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
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEventReadRequest, SessionEventWindow } from '@deepseek-ai/dsh-session-query'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { textOf } from '../transcript.ts'
import type {
  AgeChoice,
  OriginChoice,
  SessionFiltersValue,
  WorkspaceChoice,
} from './filters.ts'
import type { EventHitEntry, EventSearchState } from './model.ts'
import { relativeAge } from './model.ts'

/** Rows outside a child panel's scrolling body. */
const PANEL_FIXED_ROWS = 4

/** Rows outside the events browser's scrolling body, including its query row. */
const EVENTS_FIXED_ROWS = 5

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
  /** Open the context reader over one selected hit. */
  readonly openContext: (hit: EventHitEntry) => void
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
  const activate = (): void => {
    // A selected hit opens its context; the trailing row is the only other
    // selectable thing, and it loads or refreshes instead.
    if (selected < visible.length) {
      const hit = visible[selected]
      if (hit !== undefined) spec.openContext(hit)
      return
    }
    if (selected !== visible.length || trailing === undefined) return
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
            eventHelp(selected < visible.length ? 'hit' : trailing),
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

/** Choose truthful event help for what the cursor rests on. */
function eventHelp(selection: 'hit' | Trailing | undefined): string {
  const action = selection === 'hit'
    ? '↵ context'
    : selection?.kind === 'more' ? '↵ load more' : selection?.kind === 'refresh' ? '↵ refresh' : undefined
  return ['type query', 'tab search', '↑↓ move', ...action === undefined ? [] : [action], 'esc back'].join(' · ')
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

/** Raw events read on each side of a hit; small, because rows stay one line. */
const CONTEXT_BEFORE_EVENTS = 4
/** Raw events read after a hit, weighting what happened next over what led in. */
const CONTEXT_AFTER_EVENTS = 8

/** What one event-context reader holds. */
export interface EventContextOverlaySpec {
  /** The selected hit whose surrounding log is read. */
  readonly hit: EventHitEntry
  /** The published windowed read, bound to the same query engine as search. */
  readonly read: (request: SessionEventReadRequest, signal?: AbortSignal) => Promise<SessionEventWindow>
  /** Ask the stack owner to remove this child. */
  readonly close: () => void
  /** Redraw after the read lands or the cursor moves. */
  readonly invalidate: () => void
}

/** The windowed read's progress. */
type EventContextState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly window: SessionEventWindow }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Create the context reader a selected event-search hit opens.
 *
 * `searchEvents` answers "this session said something like this"; the windowed
 * `readEvent` answers "what was happening around it". The read is one bounded
 * raw-log window per open — no prefetch, no cache — and it is cancelled with
 * the overlay, exactly like the searches the browser starts.
 * @param spec - the hit, the published read, and owner controls.
 * @returns a bounded child overlay that closes on escape.
 */
export function createEventContextOverlay(spec: EventContextOverlaySpec): SessionsChildOverlay {
  const viewport = new RowViewport()
  let cursor = 0
  let state: EventContextState = { kind: 'loading' }
  let closed = false
  const abort = new AbortController()

  const close = (): void => {
    if (closed) return
    closed = true
    abort.abort()
    spec.close()
  }
  const rows = (inner: number): { lines: readonly string[]; selectedRow: number } => {
    if (state.kind === 'loading') {
      return { lines: [paint(truncateToWidth('Reading context…', Math.max(1, inner - 2)), 'muted')], selectedRow: 0 }
    }
    if (state.kind === 'failed') {
      const text = truncateToWidth(escapeControls(`Read failed: ${state.message}`), Math.max(1, inner - 2))
      return { lines: [paint(text, 'error')], selectedRow: 0 }
    }
    const lines = state.window.events.map((event, index) => contextRow(event, index === cursor, inner))
    return { lines, selectedRow: Math.min(cursor, Math.max(0, lines.length - 1)) }
  }
  const move = (amount: number): void => {
    if (state.kind !== 'ready') return
    const length = state.window.events.length
    if (length === 0) return
    cursor = (cursor + amount + length) % length
    spec.invalidate()
  }

  void spec.read(
    {
      sessionId: spec.hit.sessionId,
      seq: spec.hit.seq as SessionSeq,
      before: CONTEXT_BEFORE_EVENTS,
      after: CONTEXT_AFTER_EVENTS,
    },
    abort.signal,
  ).then(
    window => {
      if (closed) return
      state = { kind: 'ready', window }
      // Land the cursor on the hit itself when the window holds it.
      const at = window.events.findIndex(event => event.seq === spec.hit.seq)
      cursor = at === -1 ? 0 : at
      spec.invalidate()
    },
    error => {
      if (closed) return
      state = {
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
      spec.invalidate()
    },
  )

  return {
    [CHILD_CLOSE_REQUESTED]: () => closed,
    render(columns, terminalRows = 24) {
      if (terminalRows <= PANEL_FIXED_ROWS || columns < PANEL_MIN_COLUMNS) {
        return compactPanel('Event context', columns, terminalRows)
      }
      const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
      const capacity = terminalRows - PANEL_FIXED_ROWS
      if (capacity <= 0) return compactPanel('Event context', columns, terminalRows)
      const rendered = rows(inner)
      viewport.update(rendered.lines.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      if (rendered.selectedRow >= viewport.end) viewport.move(rendered.selectedRow - viewport.end + 1)
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint('Sessions · event context', 'overlay-title'),
          body: rendered.lines.slice(viewport.start, viewport.end),
          footer: fitFooterHelp('↑↓ move · esc back', footerBudget(columns)),
        }),
      ]
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactPanel('Event context', columns, terminalRows)
    },
    handleKey(key: Key) {
      if (closed || key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          move(-1)
          return
        case 'down':
          move(1)
          return
        case 'home':
        case 'ctrl-a':
          cursor = 0
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          if (state.kind === 'ready') cursor = Math.max(0, state.window.events.length - 1)
          viewport.last()
          spec.invalidate()
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
 * Draw one raw event of the window as one bounded row.
 * @param event - the raw session event.
 * @param hitSeq - the seq the reader opened; that row is highlighted.
 * @param inner - the frame's inner width in columns.
 * @returns the row.
 */
function contextRow(event: SessionEvent, hitSeq: number, inner: number): string {
  const facts = `${String(event.seq)} · ${event.type}`
  const summary = eventSummary(event)
  const room = Math.max(1, inner - 2 - displayWidth(facts) - (summary === '' ? 0 : 3))
  const body = summary === '' ? '' : ` · ${truncateToWidth(escapeControls(summary).replaceAll('\n', ' '), room)}`
  const row = `${event.seq === hitSeq ? '❯' : ' '} ${truncateToWidth(`${facts}${body}`, Math.max(1, inner - 2))}`
  return event.seq === hitSeq ? paint(row, 'selection') : row
}

/**
 * One plain-text line standing in for an event, for the common durable shapes
 * only. Anything else draws its type alone; guessing at unknown payloads would
 * present text the log does not carry.
 * @param event - the raw session event.
 * @returns the summary text, unescaped and unbounded.
 */
function eventSummary(event: SessionEvent): string {
  const data = event.data as {
    content?: readonly ContentBlock[]
    message?: { content?: readonly ContentBlock[] }
    name?: string
    arguments?: string
    args?: string
  }
  switch (event.type) {
    case 'user/message':
    case 'assistant/message':
      return textOf(data.content ?? data.message?.content ?? []).trim()
    case 'tool/call':
      return `${data.name ?? ''} ${data.arguments ?? ''}`.trim()
    case 'command/run':
      return `${data.name ?? ''} ${data.args ?? ''}`.trim()
    default:
      return ''
  }
}
