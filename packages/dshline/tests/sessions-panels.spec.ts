/** Behavior tests for the bounded Sessions filter and event child panels. */

import { describe, expect, it, vi } from 'vitest'
import type { Key, KeyName } from '@dshline/renderer'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFiltersValue } from '../src/sessions/filters.ts'
import type { EventSearchState } from '../src/sessions/model.ts'
import {
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
  readonly searches: Array<{ sessionId: SessionId; query: string }>
  readonly loads: () => number
  readonly opens: () => number[]
  readonly closes: () => number
} {
  const state = { value: initial }
  const searches: Array<{ sessionId: SessionId; query: string }> = []
  const opened: number[] = []
  let loads = 0
  let closes = 0
  const spec: EventsOverlaySpec = {
    target: TARGET,
    events: () => state.value,
    searchEvents: (sessionId, query) => { searches.push({ sessionId, query }) },
    loadMoreEvents: () => { loads += 1 },
    openContext: hit => { opened.push(hit.seq) },
    now: () => NOW,
    close: () => { closes += 1 },
    invalidate: () => {},
  }
  return {
    overlay: createEventsOverlay(spec),
    state,
    searches,
    loads: () => loads,
    opens: () => opened,
    closes: () => closes,
  }
}

/** One landed hit state. */
function ready(overrides: Partial<Extract<EventSearchState, { kind: 'ready' }>> = {}): Extract<EventSearchState, { kind: 'ready' }> {
  return {
    kind: 'ready',
    sessionId: TARGET,
    query: 'alpha',
    hits: [{
      sessionId: TARGET,
      seq: 7,
      type: 'assistant/message',
      time: NOW - 120_000,
      snippet: 'alpha answer',
    }],
    more: false,
    loadingMore: false,
    restart: false,
    revision: 0,
    ...overrides,
  }
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

  it('opens the selected hit on Enter, and neither searches nor closes', () => {
    // Deliberate break: leaving a hit inert would hide the published context
    // read; wiring it to close would imply an action the hit never offered.
    const view = mountEvents(ready({ query: '' }))
    view.overlay.render(COLUMNS, ROWS)
    view.overlay.handleKey(key('enter'))
    expect(view.opens()).toEqual([7])
    expect(view.closes()).toBe(0)
    expect(view.loads()).toBe(0)
    expect(view.searches).toEqual([])
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

/** A raw windowed event the context reader draws. */
function rawEvent(seq: number, type: string, data: unknown): { seq: number; type: string; data: unknown; time: number } {
  return { seq, type, data, time: NOW - 1000 * seq }
}

/** The hit the context reader was opened over. */
const CONTEXT_HIT = {
  sessionId: TARGET,
  seq: 7,
  type: 'assistant/message',
  time: NOW - 120_000,
  snippet: 'alpha answer',
}

/** Mount an event-context reader over a controllable read. */
function mountContext(): {
  readonly overlay: SessionsChildOverlay
  readonly reads: Array<{ sessionId: SessionId; seq: number; before: number; after: number }>
  readonly resolve: (events: Array<{ seq: number; type: string; data: unknown; time: number }>) => void
  readonly reject: (message: string) => void
  readonly closes: () => number
} {
  const reads: Array<{ sessionId: SessionId; seq: number; before: number; after: number }> = []
  let closes = 0
  let resolveRead: (value: unknown) => void = () => {}
  let rejectRead: (reason?: unknown) => void = () => {}
  const overlay = createEventContextOverlay({
    hit: CONTEXT_HIT,
    read: (request, signal) => {
      reads.push({
        sessionId: request.sessionId,
        seq: request.seq as number,
        before: request.before ?? 0,
        after: request.after ?? 0,
      })
      return new Promise((resolve, reject) => {
        resolveRead = resolve
        rejectRead = reject
        signal?.addEventListener('abort', () => { rejectRead(new Error('aborted')) })
      })
    },
    close: () => { closes += 1 },
    invalidate: () => {},
  })
  return {
    overlay,
    reads,
    resolve: events => {
      resolveRead({
        session: { id: TARGET },
        inheritedEventCount: 0,
        target: events[0],
        events,
        startSeq: events[0]?.seq ?? 0,
        endSeq: events[events.length - 1]?.seq ?? 0,
      })
    },
    reject: message => { rejectRead(new Error(message)) },
    closes: () => closes,
  }
}

describe('the event context reader', () => {
  it('reads one bounded window around the hit, centred by before/after', async () => {
    const view = mountContext()
    expect(view.reads).toEqual([{ sessionId: TARGET, seq: 7, before: 4, after: 8 }])
    view.resolve([
      rawEvent(3, 'user/message', { content: [{ type: 'text', text: 'the prompt' }] }),
      rawEvent(7, 'assistant/message', { content: [{ type: 'text', text: 'the alpha answer' }] }),
      rawEvent(9, 'tool/call', { name: 'bash', arguments: '{"command":"ls"}' }),
    ])
    await vi.waitFor(() => {
      expect(screen(view.overlay)).toContain('the alpha answer')
    })
    const drawn = screen(view.overlay)
    expect(drawn).toContain('❯ 7 · assistant/message · the alpha answer')
    expect(drawn).toContain('3 · user/message · the prompt')
    expect(drawn).toContain('9 · tool/call · bash {"command":"ls"}')
  })

  it('draws an unknown event type without guessing at its payload', async () => {
    const view = mountContext()
    view.resolve([rawEvent(4, 'goal/change', { opaque: true })])
    await vi.waitFor(() => {
      expect(screen(view.overlay)).toContain('4 · goal/change')
    })
    expect(screen(view.overlay)).not.toContain('opaque')
  })

  it('escapes control characters in event text', async () => {
    const view = mountContext()
    view.resolve([rawEvent(7, 'user/message', { content: [{ type: 'text', text: 'a\u001b[2Jb' }] })])
    await vi.waitFor(() => {
      expect(screen(view.overlay)).toContain('7 · user/message')
    })
    expect(screen(view.overlay)).not.toContain('\u001b[2J')
  })

  it('moves within the landed window and reports failure truthfully', async () => {
    const view = mountContext()
    view.resolve([
      rawEvent(3, 'user/message', { content: [{ type: 'text', text: 'one' }] }),
      rawEvent(7, 'assistant/message', { content: [{ type: 'text', text: 'two' }] }),
      rawEvent(8, 'assistant/message', { content: [{ type: 'text', text: 'three' }] }),
    ])
    await vi.waitFor(() => { expect(screen(view.overlay)).toContain('❯ 7') })
    view.overlay.handleKey(key('down'))
    expect(screen(view.overlay)).toContain('❯ 8')
    view.overlay.handleKey(key('up'))
    view.overlay.handleKey(key('up'))
    expect(screen(view.overlay)).toContain('❯ 3')
  })

  it('shows the failure message when the read rejects', async () => {
    const view = mountContext()
    view.reject('cold log unavailable')
    await vi.waitFor(() => {
      expect(screen(view.overlay)).toContain('Read failed: cold log unavailable')
    })
  })

  it('closes on escape and cancels its pending read', async () => {
    const view = mountContext()
    view.overlay.handleKey(key('escape'))
    expect(view.closes()).toBe(1)
    // The abort listener was registered: a late resolve must not land state.
    view.resolve([])
    expect(screen(view.overlay)).toContain('esc back')
  })

  it('a selected hit is opened by enter, and the trailing rows keep their actions', () => {
    const opened: number[] = []
    const state = { value: ready() }
    const overlay = createEventsOverlay({
      target: TARGET,
      events: () => state.value,
      searchEvents: () => {},
      loadMoreEvents: () => {},
      openContext: hit => { opened.push(hit.seq) },
      now: () => NOW,
      close: () => {},
      invalidate: () => {},
    })
    expect(screen(overlay)).toContain('↵ context')
    overlay.handleKey(key('enter'))
    expect(opened).toEqual([7])
  })
})
