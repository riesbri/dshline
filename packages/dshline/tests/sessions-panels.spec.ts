/** Behavior tests for the bounded Sessions filter and event child panels. */

import { describe, expect, it } from 'vitest'
import type { Key, KeyName } from '@dshline/renderer'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventWindow } from '@deepseek-ai/dsh-session-query'
import type { SessionFiltersValue } from '../src/sessions/filters.ts'
import type { EventContextState, EventHitEntry, EventSearchState } from '../src/sessions/model.ts'
import {
  CHILD_CLOSE_REQUESTED,
  createEventContextOverlay,
  createEventsOverlay,
  createFilterOverlay,
  type EventsOverlaySpec,
  type SessionsChildOverlay,
} from '../src/sessions/panels.ts'

/** Comfortable frame dimensions. */
const COLUMNS = 80
const ROWS = 24

/** Stable session and clock inputs. */
const TARGET = 'session-target' as SessionId
const NOW = 1_800_000_000_000

/** One named keystroke. */
function key(name: KeyName): Key {
  return { kind: 'key', name }
}

/** Printable keystrokes as the decoder delivers them. */
function typed(text: string): Key[] {
  return [...text].map(character => ({ kind: 'text', text: character }))
}

/** Render one child as plain screen text. */
function screen(overlay: SessionsChildOverlay, columns = COLUMNS, rows = ROWS): string {
  return overlay.render(columns, rows).map(stripAnsi).join('\n')
}

describe('the Sessions filter picker', () => {
  it('renders its initial value and cycles fields independently in both directions', () => {
    // Deliberate break: mutating a shared choices index changes a second field
    // while the cursor is editing the first.
    const applied: SessionFiltersValue[] = []
    const overlay = createFilterOverlay({
      value: { workspace: 'all', origin: 'all', age: 'all' },
      workspace: '/work',
      apply: value => { applied.push(value) },
      close: () => {},
      invalidate: () => {},
    })
    expect(screen(overlay)).toContain('Workspace · all')
    expect(screen(overlay)).toContain('Origin · all')
    expect(screen(overlay)).toContain('Age · all')

    overlay.handleKey(key('right'))
    overlay.handleKey(key('down'))
    overlay.handleKey(key('right'))
    overlay.handleKey(key('down'))
    overlay.handleKey(key('left'))
    const drawn = screen(overlay)
    expect(drawn).toContain('Workspace · current')
    expect(drawn).toContain('Origin · own')
    expect(drawn).toContain('Age · 30d')
    expect(applied).toEqual([])
  })

  it('applies the complete changed value exactly once and closes', () => {
    // Deliberate break: failing to guard a repeated Enter applies the same
    // catalog filter twice and starts two listings.
    const applied: SessionFiltersValue[] = []
    let closes = 0
    const overlay = createFilterOverlay({
      value: { workspace: 'all', origin: 'all', age: 'all' },
      workspace: '/work',
      apply: value => { applied.push(value) },
      close: () => { closes += 1 },
      invalidate: () => {},
    })
    overlay.handleKey(key('right'))
    overlay.handleKey(key('enter'))
    overlay.handleKey(key('enter'))
    expect(applied).toEqual([{ workspace: 'current', origin: 'all', age: 'all' }])
    expect(closes).toBe(1)
  })

  it('cancels without applying on escape', () => {
    // Deliberate break: sharing the apply and close paths commits edits when a
    // reader explicitly cancels them.
    const applied: SessionFiltersValue[] = []
    let closed = false
    const overlay = createFilterOverlay({
      value: { workspace: 'all', origin: 'all', age: 'all' },
      workspace: '/work',
      apply: value => { applied.push(value) },
      close: () => { closed = true },
      invalidate: () => {},
    })
    overlay.handleKey(key('right'))
    overlay.handleKey(key('escape'))
    expect(applied).toEqual([])
    expect(closed).toBe(true)
  })

  it('does not offer current when there is no effective workspace', () => {
    // Deliberate break: retaining the two-choice cycle allows a filter the
    // catalog cannot translate to a cwd predicate.
    const overlay = createFilterOverlay({
      value: { workspace: 'all', origin: 'all', age: 'all' },
      workspace: undefined,
      apply: () => {},
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey(key('right'))
    expect(screen(overlay)).toContain('Workspace · all')
    expect(screen(overlay)).not.toContain('Workspace · current')
  })

  it('uses a bounded compact answer on narrow and tiny terminals', () => {
    // Deliberate break: drawing the normal frame at 20 columns wraps its field
    // rows and spends more physical lines than the overlay was given.
    const overlay = createFilterOverlay({
      value: { workspace: 'all', origin: 'all', age: 'all' },
      workspace: '/work',
      apply: () => {},
      close: () => {},
      invalidate: () => {},
    })
    const narrow = overlay.render(20, ROWS).map(stripAnsi)
    expect(narrow).toHaveLength(1)
    expect(narrow[0]).toContain('esc back')
    expect(overlay.render(COLUMNS, 1)).toHaveLength(1)
  })
})

/** Mount an event panel over mutable search state. */
function mountEvents(initial: EventSearchState = { kind: 'idle' }): {
  readonly overlay: SessionsChildOverlay
  readonly state: { value: EventSearchState }
  readonly context: { value: EventContextState }
  readonly searches: Array<{ sessionId: SessionId; query: string }>
  readonly reads: Array<{ sessionId: SessionId; seq: number }>
  readonly pushed: SessionsChildOverlay[]
  readonly loads: () => number
  readonly closes: () => number
} {
  const state = { value: initial }
  const context: { value: EventContextState } = { value: { kind: 'idle' } }
  const searches: Array<{ sessionId: SessionId; query: string }> = []
  const reads: Array<{ sessionId: SessionId; seq: number }> = []
  const pushed: SessionsChildOverlay[] = []
  let loads = 0
  let closes = 0
  const spec: EventsOverlaySpec = {
    target: TARGET,
    events: () => state.value,
    searchEvents: (sessionId, query) => { searches.push({ sessionId, query }) },
    loadMoreEvents: () => { loads += 1 },
    readEvent: (sessionId, seq) => { reads.push({ sessionId, seq }) },
    eventContext: () => context.value,
    push: factory => { pushed.push(factory(() => {}) as SessionsChildOverlay) },
    now: () => NOW,
    close: () => { closes += 1 },
    invalidate: () => {},
  }
  return {
    overlay: createEventsOverlay(spec),
    state,
    context,
    searches,
    reads,
    pushed,
    loads: () => loads,
    closes: () => closes,
  }
}

/** One landed event hit. */
function hit(seq: number, overrides: Partial<EventHitEntry> = {}): EventHitEntry {
  return {
    sessionId: TARGET,
    seq: SessionSeq(seq),
    type: 'assistant/message',
    time: NOW - 120_000,
    snippet: 'alpha answer',
    ...overrides,
  }
}

/** One landed hit state. */
function ready(overrides: Partial<Extract<EventSearchState, { kind: 'ready' }>> = {}): Extract<EventSearchState, { kind: 'ready' }> {
  return {
    kind: 'ready',
    sessionId: TARGET,
    query: 'alpha',
    hits: [hit(7)],
    more: false,
    loadingMore: false,
    restart: false,
    revision: 0,
    ...overrides,
  }
}

/** One raw context-window event. */
function event(seq: number, type: string, data: unknown = {}): SessionEvent {
  return { type, seq: SessionSeq(seq), time: NOW + seq * 1_000, data } as unknown as SessionEvent
}

/** A user message event whose semantic text Harness extracts. */
function userEvent(seq: number, text: string): SessionEvent {
  return event(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * A ready context state whose window contains the target and its neighbors.
 * @param events - the window's events, in ascending seq order.
 * @param targetSeq - the target's sequence number.
 * @returns the state.
 */
function contextReady(events: SessionEvent[], targetSeq = 1): Extract<EventContextState, { kind: 'ready' }> {
  const target = events.find(one => one.seq === SessionSeq(targetSeq)) ?? events[0]!
  const session: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: TARGET,
    createdAt: NOW,
    isSeeded: false,
  } as SessionHeader
  const window: SessionEventWindow = {
    session,
    inheritedEventCount: 0,
    target,
    events,
    startSeq: events[0]!.seq,
    endSeq: events.at(-1)!.seq,
  } as unknown as SessionEventWindow
  return { kind: 'ready', sessionId: TARGET, seq: target.seq, window }
}

/** Mount the bounded context inspector over mutable state. */
function mountContext(initial: EventContextState): {
  readonly overlay: SessionsChildOverlay
  readonly invalidates: () => number
  readonly closes: () => number
} {
  let invalidates = 0
  let closes = 0
  const overlay = createEventContextOverlay({
    context: () => initial,
    now: () => NOW,
    close: () => { closes += 1 },
    invalidate: () => { invalidates += 1 },
  })
  return { overlay, invalidates: () => invalidates, closes: () => closes }
}

describe('the within-session events browser', () => {
  it('edits locally and searches the target exactly once per non-empty tab', () => {
    // Deliberate break: searching on every typed character turns a deliberate
    // backend gesture into three reads for this three-letter query.
    const view = mountEvents()
    for (const one of typed('alpha')) view.overlay.handleKey(one)
    expect(screen(view.overlay)).toContain('alpha')
    expect(view.searches).toEqual([])
    view.overlay.handleKey(key('tab'))
    expect(view.searches).toEqual([{ sessionId: TARGET, query: 'alpha' }])
    view.overlay.handleKey(key('tab'))
    expect(view.searches).toHaveLength(2)
  })

  it('does not search an empty query', () => {
    // Deliberate break: forwarding whitespace-only text creates a backend query
    // whose result cannot be identified from the blank prompt.
    const view = mountEvents()
    view.overlay.handleKey(key('tab'))
    for (const one of typed('   ')) view.overlay.handleKey(one)
    view.overlay.handleKey(key('tab'))
    expect(view.searches).toEqual([])
  })

  it('invalidates displayed results after an edit without rerunning search', () => {
    // Deliberate break: continuing to draw the landed `alpha` hit beneath an
    // `alphax` prompt labels stale results as if they answered the new words.
    const view = mountEvents()
    for (const one of typed('alpha')) view.overlay.handleKey(one)
    view.overlay.handleKey(key('tab'))
    view.state.value = ready()
    expect(screen(view.overlay)).toContain('alpha answer')
    view.overlay.handleKey({ kind: 'text', text: 'x' })
    const drawn = screen(view.overlay)
    expect(drawn).not.toContain('alpha answer')
    expect(drawn).toContain('Type what this session said')
    expect(view.searches).toHaveLength(1)
  })

  it('renders escaped one-line snippets and minimal authoritative detail', () => {
    // Deliberate break: drawing the raw CSI would let a provider-selected
    // snippet erase the terminal before the frame can be inspected.
    const malicious = '\u001b[2J第一行\n第二行'
    const view = mountEvents(ready({
      query: '',
      hits: [{
        sessionId: TARGET,
        seq: 19,
        type: 'assistant/审查',
        time: NOW - 120_000,
        snippet: malicious,
      }],
    }))
    const rows = view.overlay.render(COLUMNS, ROWS)
    expect(rows.join('\n')).not.toContain('\u001b[2J')
    const drawn = rows.map(stripAnsi).join('\n')
    expect(drawn).toContain('第一行 第二行')
    expect(drawn).toContain('assistant/审查 · seq 19 · 2m ago')
    for (const row of rows) expect(displayWidth(stripAnsi(row))).toBeLessThanOrEqual(COLUMNS)
  })

  it.each([
    [ready({ query: '', hits: [] }), 'Nothing in this session matches that.'],
    [{ kind: 'unsupported' } as EventSearchState, 'no within-session search'],
  ])('shows the non-hit state %# as a sentence', (state, expected) => {
    expect(screen(mountEvents(state).overlay)).toContain(expected)
  })

  it('escapes a failed-search reason', () => {
    // Deliberate break: styling before escaping either destroys the error color
    // or lets the reason's control sequence execute.
    const malicious = '\u001b[2Jindex gone'
    const view = mountEvents({ kind: 'failed', message: malicious })
    const rows = view.overlay.render(COLUMNS, ROWS)
    expect(rows.join('\n')).not.toContain(malicious)
    expect(rows.map(stripAnsi).join('\n')).toContain('Search failed:')
    expect(rows.map(stripAnsi).join('\n')).toContain('index gone')
  })

  it('loads more only from the selectable continuation row', () => {
    // Deliberate break: treating Enter on a hit as continuation makes inspecting
    // the cursor issue an unrelated page request.
    const view = mountEvents()
    for (const one of typed('alpha')) view.overlay.handleKey(one)
    view.overlay.handleKey(key('tab'))
    view.state.value = ready({ more: true })
    expect(screen(view.overlay)).toContain('Load more…')
    view.overlay.handleKey(key('enter'))
    expect(view.loads()).toBe(0)
    view.overlay.handleKey(key('end'))
    view.overlay.handleKey(key('enter'))
    view.overlay.handleKey(key('enter'))
    expect(view.loads()).toBe(1)
    expect(screen(view.overlay)).toContain('Loading more…')
  })

  it('marks an empty event page landed so the row stops loading', () => {
    // Deliberate break: waiting for an appended hit to notice a page would leave
    // "Loading more…" visible forever when the page retained nothing.
    const view = mountEvents()
    for (const one of typed('alpha')) view.overlay.handleKey(one)
    view.overlay.handleKey(key('tab'))
    view.state.value = ready({ more: true })
    view.overlay.render(COLUMNS, ROWS)
    view.overlay.handleKey(key('end'))
    view.overlay.handleKey(key('enter'))
    expect(screen(view.overlay)).toContain('Loading more…')
    view.state.value = ready({ more: true, revision: 1 })
    view.overlay.render(COLUMNS, ROWS)
    expect(screen(view.overlay)).toContain('Load more…')
    expect(screen(view.overlay)).not.toContain('Loading more…')
    expect(view.loads()).toBe(1)
  })

  it('keeps a zero-hit ready page pageable behind Load more', () => {
    // The pagination contract returns opaque cursor pages and does not promise
    // a non-final page is never empty; a zero-hit ready state must still offer
    // the continuation instead of claiming the session search is over.
    // Deliberate break: suppressing the continuation when hits === 0 strands
    // the reader on the no-match sentence.
    const view = mountEvents()
    for (const one of typed('alpha')) view.overlay.handleKey(one)
    view.overlay.handleKey(key('tab'))
    view.state.value = ready({ hits: [], more: true })
    view.overlay.render(COLUMNS, ROWS)
    const drawn = screen(view.overlay)
    expect(drawn).toContain('No matching events on the pages read so far.')
    expect(drawn).toContain('Load more…')
    view.overlay.handleKey(key('end'))
    view.overlay.handleKey(key('enter'))
    expect(view.loads()).toBe(1)
    // The next page lands hits; they append and become visible.
    view.state.value = ready({ more: false, revision: 1 })
    view.overlay.render(COLUMNS, ROWS)
    expect(screen(view.overlay)).toContain('alpha answer')
  })

  it('restarts changed results through a fresh target search', () => {
    // Deliberate break: sending restart through load-more reuses the cursor the
    // backend has explicitly declared stale.
    const view = mountEvents()
    for (const one of typed('alpha')) view.overlay.handleKey(one)
    view.overlay.handleKey(key('tab'))
    view.state.value = ready({ more: true, restart: true })
    view.overlay.render(COLUMNS, ROWS)
    view.overlay.handleKey(key('end'))
    expect(screen(view.overlay)).toContain('Refresh (results changed)')
    view.overlay.handleKey(key('enter'))
    expect(view.searches).toEqual([
      { sessionId: TARGET, query: 'alpha' },
      { sessionId: TARGET, query: 'alpha' },
    ])
    expect(view.loads()).toBe(0)
  })

  it('opens bounded context on Enter for a selected hit', () => {
    // The read and the child are requested from the explicit activation, and
    // nothing else: the search is not restarted, no page is loaded, and the
    // browser itself stays open beneath.
    const view = mountEvents(ready({ query: '' }))
    view.overlay.render(COLUMNS, ROWS)
    view.overlay.handleKey(key('enter'))
    expect(view.reads).toEqual([{ sessionId: TARGET, seq: SessionSeq(7) }])
    expect(view.pushed).toHaveLength(1)
    expect(view.pushed[0]?.[CHILD_CLOSE_REQUESTED]()).toBe(false)
    expect(view.closes()).toBe(0)
    expect(view.loads()).toBe(0)
    expect(view.searches).toEqual([])
  })

  it('keeps the query and selection when the context child closes', () => {
    // The context panel is pushed OVER the search, not into it: closing it must
    // return to the same query, results, and selected hit rather than restart
    // the search or lose the reader's place.
    const view = mountEvents()
    for (const one of typed('alpha')) view.overlay.handleKey(one)
    view.overlay.handleKey(key('tab'))
    view.state.value = ready({ more: true, hits: [hit(1), hit(2), hit(3)] })
    view.overlay.render(COLUMNS, ROWS)
    view.overlay.handleKey(key('down'))
    view.overlay.handleKey(key('enter'))
    expect(view.reads).toEqual([{ sessionId: TARGET, seq: SessionSeq(2) }])

    const child = view.pushed[0]!
    child.handleKey(key('escape'))
    expect(child[CHILD_CLOSE_REQUESTED]()).toBe(true)

    const drawn = screen(view.overlay)
    expect(drawn).toContain('alpha')
    expect(drawn).toContain('alpha answer')
    // Still on the same hit: activating again reads it, not a neighbor.
    view.overlay.handleKey(key('enter'))
    expect(view.reads).toEqual([
      { sessionId: TARGET, seq: SessionSeq(2) },
      { sessionId: TARGET, seq: SessionSeq(2) },
    ])
  })

  it('reads no context while hits land, render, or move under the cursor', () => {
    // The on-demand disclosure invariant: `searchEvents()` discovers hits and
    // `readEvent()` is paid only when one is explicitly opened. A cursor that
    // moved through results would otherwise read a raw-log window per row.
    // Deliberate break: fetching context in `render` or `move` turns holding
    // the down arrow into a session-log read per keystroke.
    const view = mountEvents(ready({ query: '', hits: [hit(1), hit(2), hit(3)] }))
    view.overlay.render(COLUMNS, ROWS)
    view.overlay.handleKey(key('down'))
    view.overlay.handleKey(key('down'))
    view.overlay.render(COLUMNS, ROWS)
    view.overlay.handleKey(key('up'))
    view.overlay.render(COLUMNS, ROWS)
    expect(view.reads).toEqual([])
    expect(view.pushed).toEqual([])
    view.overlay.handleKey(key('enter'))
    expect(view.reads).toEqual([{ sessionId: TARGET, seq: SessionSeq(2) }])
  })

  it('advertises context on a hit and continuation on the trailing row', () => {
    // Deliberate break: leaving the footer on the hit unchanged hides the new
    // action, and reusing the hit's help on the trailing row would advertise
    // the wrong Enter behavior.
    const view = mountEvents(ready({ query: '', hits: [hit(1)], more: true }))
    expect(screen(view.overlay)).toContain('↵ context')
    view.overlay.handleKey(key('end'))
    const drawn = screen(view.overlay)
    expect(drawn).toContain('↵ load more')
    expect(drawn).not.toContain('↵ context')
  })

  it('clears a query on first escape and closes on the second', () => {
    // Deliberate break: closing on the first Escape loses the same two-stage
    // query recovery the parent browser teaches.
    const view = mountEvents()
    for (const one of typed('alpha')) view.overlay.handleKey(one)
    view.overlay.handleKey(key('escape'))
    expect(view.closes()).toBe(0)
    expect(screen(view.overlay)).not.toContain('alpha█')
    view.overlay.handleKey(key('escape'))
    expect(view.closes()).toBe(1)
  })
})

describe('the bounded event context inspector', () => {
  it('shows a loading headline while the read is in flight', () => {
    const view = mountContext({ kind: 'loading', sessionId: TARGET, seq: SessionSeq(1) })
    const drawn = screen(view.overlay)
    expect(drawn).toContain('Sessions · context')
    expect(drawn).toContain('Reading surrounding events…')
  })

  it('shows a truthful failure reason', () => {
    // Deliberate break: styling before escaping either destroys the error color
    // or lets the reason's control sequence execute.
    const malicious = '\u001b[2Jevent vanished'
    const view = mountContext({ kind: 'failed', sessionId: TARGET, seq: SessionSeq(1), message: malicious })
    const rows = view.overlay.render(COLUMNS, ROWS)
    expect(rows.join('\n')).not.toContain(malicious)
    const drawn = rows.map(stripAnsi).join('\n')
    expect(drawn).toContain('Context failed:')
    expect(drawn).toContain('event vanished')
  })

  it('marks the target and shows neighboring events in order', () => {
    // Deliberate break: dropping the marker makes the target indistinguishable
    // from its neighbors, which is the one row the reader came for.
    const view = mountContext(contextReady([
      event(0, 'turn/start'),
      userEvent(1, 'the surrounding events matter'),
      event(2, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ], 1))
    const rows = view.overlay.render(COLUMNS, ROWS).map(stripAnsi)
    const drawn = rows.join('\n')
    expect(drawn).toContain('▶ user/message · seq 1')
    expect(drawn).toContain('turn/start · seq 0')
    expect(drawn).toContain('turn/end · seq 2')
    expect(drawn).toContain('the surrounding events matter')
    // Ascending seq order, target in the middle.
    expect(drawn.indexOf('turn/start · seq 0')).toBeLessThan(drawn.indexOf('user/message · seq 1'))
    expect(drawn.indexOf('user/message · seq 1')).toBeLessThan(drawn.indexOf('turn/end · seq 2'))
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(COLUMNS)
  })

  it('escapes semantic text and wraps it across physical rows', () => {
    // Deliberate break: drawing raw CSI lets an event payload erase the frame,
    // and measuring in code units wraps CJK at the wrong column.
    const malicious = `${'终端宽度'.repeat(20)}\u001b[2Jafter`
    const view = mountContext(contextReady([userEvent(1, malicious)], 1))
    const rows = view.overlay.render(COLUMNS, ROWS)
    expect(rows.join('\n')).not.toContain('\u001b[2J')
    const drawn = rows.map(stripAnsi).join('\n')
    expect(drawn).toContain('终端宽度')
    expect(drawn).toContain('after')
    for (const row of rows) expect(displayWidth(stripAnsi(row))).toBeLessThanOrEqual(COLUMNS)
    // Multiline content survives as more than one body row.
    expect(rows.length).toBeGreaterThan(4)
  })

  it('shows only type and sequence for an event with no semantic text', () => {
    // Unknown and structural events remain unknown: no JSON.stringify of an
    // arbitrary payload is ever substituted for text Harness did not extract.
    const view = mountContext(contextReady([event(1, 'turn/start', { turn: 7, step: 3 })], 1))
    const drawn = view.overlay.render(COLUMNS, ROWS).map(stripAnsi).join('\n')
    expect(drawn).toContain('▶ turn/start · seq 1')
    expect(drawn).not.toContain('"turn"')
    expect(drawn).not.toContain('{')
  })

  it('scrolls the window over content taller than the terminal', () => {
    // A 15-row terminal cannot show the whole window; down and end must reveal
    // rows a bounded frame would otherwise hide.
    const events = Array.from({ length: 12 }, (_unused, index) => userEvent(index, `line ${String(index)} `.repeat(8)))
    const view = mountContext(contextReady(events, 0))
    const first = view.overlay.render(COLUMNS, 15).map(stripAnsi).join('\n')
    expect(first).toContain('↑↓ scroll')
    view.overlay.handleKey(key('end'))
    const last = view.overlay.render(COLUMNS, 15).map(stripAnsi).join('\n')
    expect(last).toContain('line 11')
  })

  it('opens on the target rather than on the first neighbor', () => {
    // The reader asked for this event; a short terminal must not spend every
    // row on preceding context and leave the highlighted event off-screen.
    const events = [
      ...Array.from({ length: 6 }, (_unused, index) => userEvent(index, `before ${String(index)} `.repeat(6))),
      userEvent(20, 'TARGET-EVENT-CONTENT'),
      ...Array.from({ length: 6 }, (_unused, index) => userEvent(30 + index, `after ${String(index)} `.repeat(6))),
    ]
    const view = mountContext(contextReady(events, 20))
    const drawn = view.overlay.render(COLUMNS, 15).map(stripAnsi).join('\n')
    expect(drawn).toContain('TARGET-EVENT-CONTENT')
  })

  it('falls back to a bounded, closable summary on a tiny terminal', () => {
    const view = mountContext(contextReady([userEvent(1, 'body')], 1))
    const narrow = view.overlay.render(20, ROWS).map(stripAnsi)
    expect(narrow).toHaveLength(1)
    expect(narrow[0]).toContain('esc back')
    expect(view.overlay.render(COLUMNS, 3)).toHaveLength(1)
  })

  it('closes on escape and ctrl-c', () => {
    const escape = mountContext({ kind: 'loading', sessionId: TARGET, seq: SessionSeq(1) })
    expect(escape.overlay[CHILD_CLOSE_REQUESTED]()).toBe(false)
    escape.overlay.handleKey(key('escape'))
    expect(escape.closes()).toBe(1)
    expect(escape.overlay[CHILD_CLOSE_REQUESTED]()).toBe(true)

    const ctrlC = mountContext({ kind: 'loading', sessionId: TARGET, seq: SessionSeq(1) })
    ctrlC.overlay.handleKey(key('ctrl-c'))
    expect(ctrlC.closes()).toBe(1)
  })
})
