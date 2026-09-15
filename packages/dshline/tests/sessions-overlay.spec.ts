/** Tests for the Sessions browser's information hierarchy, keyboard, and states. */

import { describe, expect, it } from 'vitest'
import type { Key, KeyName } from '@dshline/renderer'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiOverlay } from '../src/slots.ts'
import { NO_FILTERS, type SessionFiltersValue } from '../src/sessions/filters.ts'
import type {
  CatalogState,
  ContentState,
  EventSearchState,
  LineageState,
  SessionDetail,
  SessionEntry,
} from '../src/sessions/model.ts'
import type { RenameDraftOutcome, ResumeRequest, SessionsOverlaySpec } from '../src/sessions/overlay.ts'
import { createSessionsOverlay } from '../src/sessions/overlay.ts'

/** Width and height of a comfortable terminal, for the normal frames. */
const COLUMNS = 90
const ROWS = 24

/** A fixed clock, so ages and notice expiry are exact. */
const NOW = 1_800_000_000_000

/**
 * One listable session.
 * @param overrides - fields to replace.
 * @returns the entry.
 */
function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'dshline-one' as SessionId,
    title: 'Fix the wrap bug',
    createdAt: NOW - 7_200_000,
    cwd: '/home/dev/projects/dshline',
    live: false,
    persisted: true,
    parent: undefined,
    origin: 'own',
    ...overrides,
  }
}

/** A complete landed content state with conservative continuation defaults. */
function contentReady(
  entries: readonly SessionEntry[],
  overrides: Partial<Extract<ContentState, { kind: 'ready' }>> = {},
): Extract<ContentState, { kind: 'ready' }> {
  return {
    kind: 'ready',
    query: 'x',
    entries,
    returned: entries.length,
    matched: entries.length,
    more: false,
    loadingMore: false,
    restart: false,
    revision: 0,
    ...overrides,
  }
}

/** What a test overrides on the overlay's owner surfaces. */
interface Harness {
  listing?: CatalogState
  content?: ContentState
  details?: Record<string, SessionDetail>
  filters?: SessionFiltersValue
  events?: EventSearchState
  lineage?: LineageState
  currentSessionId?: SessionId
  resume?: (target: SessionEntry) => ResumeRequest
  renameDraft?: (focusedTitle: string | undefined) => Promise<RenameDraftOutcome>
  now?: () => number
  /** Extra behavior chained after the recorded filter application. */
  applyFilters?: (filters: SessionFiltersValue) => void
  /** Extra behavior chained after the recorded content search. */
  search?: (text: string) => void
}

/** An overlay under test, plus what it asked its owner for. */
interface Mounted {
  render(columns?: number, rows?: number): string[]
  press(...keys: Key[]): void
  readonly searched: string[]
  readonly detailed: SessionId[]
  readonly closed: () => boolean
  readonly resumed: SessionEntry[]
  readonly pushed: TuiOverlay[]
  readonly renameCalls: () => number
  readonly renamePrefills: () => Array<string | undefined>
  readonly loadMoreCalls: () => number
  readonly restartCalls: () => number
}

/**
 * Mount the browser over a fixed corpus.
 * @param harness - the corpus and authority this test wants.
 * @returns the overlay and its recorded requests.
 */
function mount(harness: Harness = {}): Mounted {
  const searched: string[] = []
  const detailed: SessionId[] = []
  const resumed: SessionEntry[] = []
  const pushed: TuiOverlay[] = []
  let loadMoreCalls = 0
  let restartCalls = 0
  let renameCalls = 0
  const renamePrefills: Array<string | undefined> = []
  let invalidates = 0
  let closed = false
  const renameDraft = harness.renameDraft
  const spec: SessionsOverlaySpec = {
    listing: () => harness.listing ?? { kind: 'ready', entries: [entry()], truncated: 0 },
    content: () => harness.content ?? { kind: 'idle' },
    filters: () => harness.filters ?? NO_FILTERS,
    applyFilters: filters => {
      harness.filters = filters
      harness.applyFilters?.(filters)
    },
    loadMoreContent: () => { loadMoreCalls += 1 },
    restartContentSearch: () => { restartCalls += 1 },
    lineage: () => harness.lineage ?? { kind: 'idle' },
    requestLineage: () => {},
    events: () => harness.events ?? { kind: 'idle' },
    searchEvents: () => {},
    loadMoreEvents: () => {},
    requestEventContext: () => {},
    eventContext: () => ({ kind: 'idle' }),
    detail: sessionId => harness.details?.[sessionId],
    requestDetail: sessionId => { detailed.push(sessionId) },
    search: text => {
      searched.push(text)
      harness.search?.(text)
    },
    currentSessionId: harness.currentSessionId,
    workspace: '/home/dev/projects/dshline',
    home: '/home/dev',
    now: harness.now ?? ((): number => NOW),
    resume: target => {
      resumed.push(target)
      return harness.resume?.(target) ?? { kind: 'resume' }
    },
    ...(renameDraft === undefined
      ? {}
      : {
        renameDraft: async focusedTitle => {
          renameCalls += 1
          renamePrefills.push(focusedTitle)
          return renameDraft(focusedTitle)
        },
      }),
    push: overlay => { pushed.push(overlay) },
    close: () => { closed = true },
    invalidate: () => { invalidates += 1 },
  }
  const overlay = createSessionsOverlay(spec)
  return {
    render: (columns = COLUMNS, rows = ROWS) => [...overlay.render(columns, rows)],
    press: (...keys) => { for (const one of keys) overlay.handleKey(one) },
    searched,
    detailed,
    closed: () => closed,
    resumed,
    pushed,
    renameCalls: () => renameCalls,
    renamePrefills: () => [...renamePrefills],
    loadMoreCalls: () => loadMoreCalls,
    restartCalls: () => restartCalls,
    invalidates: () => invalidates,
  }
}

/**
 * Type one printable string into the overlay.
 * @param text - the characters, sent one at a time as the decoder would.
 * @returns the keystrokes.
 */
function typed(text: string): Key[] {
  return [...text].map(character => ({ kind: 'text', text: character }))
}

/**
 * One named keystroke.
 * @param name - the decoded key name.
 * @returns the keystroke.
 */
function key(name: KeyName): Key {
  return { kind: 'key', name }
}

/**
 * Everything the browser drew, as plain text.
 * @param view - the mounted overlay.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @returns the frame with styling removed.
 */
function screen(view: Mounted, columns = COLUMNS, rows = ROWS): string {
  return view.render(columns, rows).map(stripAnsi).join('\n')
}

/** Let an immediately settled rename outcome reach the overlay's notice path. */
async function renameSettled(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
}

/** An erase-display sequence a session log could contain, for the escaping test. */
const ERASE_DISPLAY = '\u001b[2Jafter'

describe('what the browser shows', () => {
  it('names the mode, the query, and how many sessions there are', () => {
    const view = mount({
      listing: { kind: 'ready', entries: [entry(), entry({ id: 'two' as SessionId, title: 'Roadmap' })], truncated: 0 },
    })
    const drawn = screen(view)
    expect(drawn).toContain('Sessions')
    expect(drawn).toContain('2 sessions')
    expect(drawn).toContain('Fix the wrap bug')
    expect(drawn).toContain('Roadmap')
  })

  it('shows the age of every row, so the list is scannable', () => {
    expect(screen(mount())).toContain('2h ago')
  })

  it('keeps secondary metadata out of the list entirely', () => {
    // A picker answers one question, and a workspace, an id, and an event count
    // repeated down every row are three things competing with the answer. None
    // of them is drawn until the reader asks for one session's detail.
    // Deliberate break: restoring the selected row's fact line puts a path and
    // an id back under the cursor and makes the list a wall of metadata again.
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry(), entry({ id: 'two' as SessionId, cwd: '/home/dev/other' })],
        truncated: 0,
      },
      details: { 'dshline-one': { events: 214, lastActivityAt: NOW - 600_000 } },
    })
    const drawn = screen(view)
    expect(drawn).toContain('Fix the wrap bug')
    expect(drawn).toContain('2h ago')
    expect(drawn).not.toContain('~/projects/dshline')
    expect(drawn).not.toContain('214')
    expect(drawn).not.toContain('dshline-one')
    expect(drawn).not.toContain('~/other')
  })

  it('takes no detail read while browsing, and one when detail is disclosed', () => {
    // The event count and last activity cost a whole log read. Browsing must
    // not pay for a surface it is not showing.
    // Deliberate break: re-arming a read on the selected row makes every arrow
    // press load a session log nothing on screen presents.
    const view = mount({
      listing: { kind: 'ready', entries: [entry(), entry({ id: 'two' as SessionId })], truncated: 0 },
    })
    view.render()
    view.press(key('down'))
    view.render()
    view.press(key('up'), key('down'))
    view.render()
    expect(view.detailed).toEqual([])
    view.press(key('right'))
    expect(view.detailed).toEqual(['two'])
  })

  it('marks the current session and identifies delegated children without a detail trip', () => {
    // `open` stays: reopening the current session is the choice Harness refuses,
    // and a reader who cannot see which row that is reads the refusal as a bug.
    // Delegated is the one additional relationship worth keeping in the list: it
    // explains why a child row exists without making the picker disclose every
    // other fact about it.
    const view = mount({
      currentSessionId: 'dshline-one' as SessionId,
      listing: {
        kind: 'ready',
        entries: [
          entry({ live: true }),
          entry({ id: 'two' as SessionId, live: true }),
          entry({ id: 'three' as SessionId, origin: 'delegated', parent: 'dshline-one' as SessionId }),
          entry({ id: 'four' as SessionId, parent: 'dshline-one' as SessionId }),
        ],
        truncated: 0,
      },
    })
    const drawn = screen(view)
    expect(drawn).toContain('open')
    expect(drawn).toContain('delegated')
    expect(drawn).not.toContain('live')
    expect(drawn).not.toContain('fork')
  })

  it('calls an untitled current session current in the list and details', () => {
    const view = mount({
      currentSessionId: 'dshline-one' as SessionId,
      listing: { kind: 'ready', entries: [entry({ title: undefined })], truncated: 0 },
    })
    const drawn = screen(view)
    expect(drawn).toContain('current')
    expect(drawn).not.toContain('untitled')
    view.press(key('right'))
    expect(screen(view)).toContain('current')
  })

  it('counts the rows, the listing, and the corpus without conflating them', () => {
    // Three different numbers, and a counter that merged any two of them would
    // be lying about at least one.
    const listing: CatalogState = {
      kind: 'ready',
      entries: [entry(), entry({ id: 'two' as SessionId, title: 'Roadmap' })],
      truncated: 200,
    }
    const view = mount({ listing })
    expect(screen(view)).toContain('2 sessions · newest of 202')
    view.press(...typed('roadmap'))
    expect(screen(view)).toContain('1 of 2 · newest of 202')
  })

  it('says nothing about a bound that was not applied', () => {
    expect(screen(mount({ listing: { kind: 'ready', entries: [entry()], truncated: 0 } })))
      .not.toContain('newest of')
  })

  it('gives the open marker up before the title on a narrow frame', () => {
    // The right column is metadata; the left is the only text saying which
    // session a row is. A title cut to fit `open · 6h ago` is a worse row.
    const wide = mount({
      currentSessionId: 'dshline-one' as SessionId,
      listing: { kind: 'ready', entries: [entry({ title: 'A reasonably long session title' })], truncated: 0 },
    })
    // Read the session ROW, not the frame: the footer's own `↵ reopen` would
    // answer a naive search for the marker.
    const row = (columns: number): string => screen(wide, columns, ROWS)
      .split('\n')
      .find(line => line.includes('reasonably long')) ?? ''
    expect(row(96)).toContain('open · 2h ago')
    expect(row(44)).not.toContain('open')
    // The age never goes: it is what orders the list.
    expect(row(44)).toContain('2h ago')
  })

  it('keeps the delegated cue and age readable on a narrow row', () => {
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry({
          title: 'A child with a long identifying title',
          origin: 'delegated',
        })],
        truncated: 0,
      },
    })
    const row = screen(view, 52, ROWS)
      .split('\n')
      .find(line => line.includes('A child with')) ?? ''
    expect(displayWidth(row)).toBeLessThanOrEqual(52)
    expect(row).toContain('delegated')
    expect(row).toContain('2h ago')
  })

  it('drops whole help segments rather than cutting one in half', () => {
    const view = mount()
    const narrow = view.render(46, ROWS).map(stripAnsi).at(-1) ?? ''
    expect(narrow).not.toContain('conte\n')
    expect(narrow).toMatch(/^╰─ .*─╯$/u)
    expect(narrow.includes('tab search contents') || narrow.includes('↵')).toBe(true)
    expect(narrow).toContain('esc close')
    // The way out is named last and surrendered last.
    const tiny = mount().render(30, ROWS).map(stripAnsi).at(-1) ?? ''
    expect(tiny).toContain('esc close')
  })

  it.each([
    [{ kind: 'unavailable' } as CatalogState, 'no session query service'],
    [{ kind: 'loading' } as CatalogState, 'Reading sessions'],
    [{ kind: 'failed', message: 'persistence unreadable' } as CatalogState, 'persistence unreadable'],
    [{ kind: 'ready', entries: [], truncated: 0 } as CatalogState, 'No sessions yet'],
  ])('has a sentence for state %# instead of an empty box', (listing, expected) => {
    const drawn = screen(mount({ listing }))
    expect(drawn).toContain(expected)
    // Nothing is selectable, so the help line must not advertise reopening.
    expect(drawn).not.toContain('reopen')
  })

  it('never lets a row escape the frame width', () => {
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry({ title: 'x'.repeat(400), cwd: `/home/dev/${'deep/'.repeat(60)}end` })],
        truncated: 0,
      },
      details: { 'dshline-one': { events: 9, lastActivityAt: NOW } },
    })
    for (const row of view.render(60, ROWS)) {
      expect(displayWidth(stripAnsi(row))).toBeLessThanOrEqual(60)
    }
  })

  it('never lets a wide-character title escape the frame width', () => {
    const view = mount({
      listing: { kind: 'ready', entries: [entry({ title: '审查渲染器'.repeat(40) })], truncated: 0 },
    })
    for (const row of view.render(70, ROWS)) {
      expect(displayWidth(stripAnsi(row))).toBeLessThanOrEqual(70)
    }
  })
})

describe('filtering, which is the default question', () => {
  it('narrows the list as characters arrive', () => {
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry(), entry({ id: 'two' as SessionId, title: 'Roadmap review' })],
        truncated: 0,
      },
    })
    view.press(...typed('road'))
    const drawn = screen(view)
    expect(drawn).toContain('Roadmap review')
    expect(drawn).not.toContain('Fix the wrap bug')
    expect(drawn).toContain('1 of 2')
  })

  it('says so when a query matches nothing, rather than showing the whole list', () => {
    const view = mount()
    view.press(...typed('attachments'))
    expect(screen(view)).toContain('No session matches that')
  })

  it('deletes one character per backspace, including outside the basic plane', () => {
    const view = mount({ listing: { kind: 'ready', entries: [entry({ title: 'rocket launch' })], truncated: 0 } })
    view.press(...typed('\u{1f680}'), key('backspace'))
    // The query is empty again, so the row is back.
    expect(screen(view)).toContain('rocket launch')
  })

  it('clears the whole query with ctrl-u and one word with ctrl-w', () => {
    const view = mount({ listing: { kind: 'ready', entries: [entry({ title: 'alpha beta' })], truncated: 0 } })
    view.press(...typed('alpha zzz'))
    expect(screen(view)).toContain('No session matches')
    view.press(key('ctrl-w'))
    expect(screen(view)).toContain('alpha beta')
    view.press(...typed('zzz'))
    expect(screen(view)).toContain('No session matches')
    view.press(key('ctrl-u'))
    expect(screen(view)).toContain('alpha beta')
  })

  it('collapses a pasted paragraph into one query line', () => {
    const view = mount({ listing: { kind: 'ready', entries: [entry({ title: 'wrap bug' })], truncated: 0 } })
    view.press({ kind: 'paste', text: 'wrap\n  bug' })
    expect(screen(view)).toContain('wrap bug')
  })

  it('takes the query back on the first escape and closes on the second', () => {
    const view = mount()
    view.press(...typed('zzz'))
    expect(screen(view)).toContain('esc clear')
    view.press(key('escape'))
    expect(view.closed()).toBe(false)
    expect(screen(view)).toContain('esc close')
    view.press(key('escape'))
    expect(view.closed()).toBe(true)
  })
})

describe('searching what sessions said', () => {
  it('hands the typed words to Harness on tab, and titles the frame for it', () => {
    const view = mount({ content: { kind: 'searching', query: 'cjk' } })
    view.press(...typed('cjk'), key('tab'))
    expect(view.searched).toEqual(['cjk'])
    const drawn = screen(view)
    expect(drawn).toContain('Sessions · contents')
    expect(drawn).toContain('Searching session contents')
  })

  it('shows the excerpt Harness selected, under the selected row', () => {
    const view = mount({
      content: contentReady(
        [entry({ snippet: 'the parser wraps CJK at the wrong column' })],
        { query: 'cjk' },
      ),
    })
    view.press(key('tab'))
    expect(screen(view)).toContain('the parser wraps CJK at the wrong column')
  })

  it('displays an escape sequence in an excerpt instead of obeying it', () => {
    // A snippet is provider-selected text out of a session log: as untrusted as
    // tool output, and able to erase the screen if it is drawn raw.
    const view = mount({
      content: contentReady([entry({ snippet: ERASE_DISPLAY })]),
    })
    view.press(key('tab'))
    const rows = view.render()
    expect(rows.join('\n')).not.toContain(ERASE_DISPLAY)
    expect(rows.map(stripAnsi).join('\n')).toContain('after')
  })

  it('keeps a newline in an excerpt from adding a row', () => {
    const view = mount({
      content: contentReady([entry({ snippet: 'first\nsecond' })]),
    })
    view.press(key('tab'))
    expect(screen(view)).toContain('first second')
  })

  it('reports an index that offers no content search as a capability, not a fault', () => {
    const view = mount({ content: { kind: 'unsupported' } })
    view.press(key('tab'))
    const drawn = screen(view)
    expect(drawn).toContain('no content search')
    expect(drawn).not.toContain('failed')
  })

  it('reports a failed search with the reason Harness gave', () => {
    const view = mount({ content: { kind: 'failed', message: 'index generation is stale' } })
    view.press(key('tab'))
    expect(screen(view)).toContain('index generation is stale')
  })

  it('drops back to filtering as soon as the query is edited', () => {
    // The results answered the PREVIOUS words. Keeping them on screen while the
    // query box says something else is the one thing a search box must not do.
    const view = mount({
      listing: { kind: 'ready', entries: [entry({ title: 'listing row' })], truncated: 0 },
      content: contentReady([entry({ id: 'hit' as SessionId, title: 'content row' })], { query: 'cjk' }),
    })
    view.press(...typed('cjk'), key('tab'))
    expect(screen(view)).toContain('content row')
    view.press(...typed('x'))
    const drawn = screen(view)
    expect(drawn).not.toContain('content row')
    expect(drawn).not.toContain('Sessions · contents')
  })

  it('returns to the listing on a second tab', () => {
    const view = mount({
      listing: { kind: 'ready', entries: [entry({ title: 'listing row' })], truncated: 0 },
      content: contentReady([], { query: '' }),
    })
    view.press(key('tab'), key('tab'))
    expect(screen(view)).toContain('listing row')
  })
})

describe('disclosing one session with right', () => {
  it('opens details with right and returns with the content corpus, query, and selection preserved', () => {
    // Deliberate break: resetting mode, query, or selected while entering the
    // detail surface makes one of these three sentinels disappear after Escape.
    const view = mount({
      content: contentReady([
        entry({ id: 'one' as SessionId, title: 'FIRST-CONTENT' }),
        entry({ id: 'two' as SessionId, title: 'SECOND-CONTENT' }),
      ], { query: 'content' }),
    })
    view.press(...typed('content'), key('tab'))
    view.render()
    view.press(key('down'), key('right'))
    expect(screen(view)).toContain('Sessions · details')
    expect(screen(view)).toContain('SECOND-CONTENT')
    expect(screen(view)).toContain('Lineage')
    expect(screen(view)).toContain('Find in this session')
    view.press(...typed('ignored'), key('right'), key('escape'))
    const returned = screen(view)
    expect(returned).toContain('Sessions · contents')
    expect(returned).toContain('content')
    view.press(key('enter'))
    expect(view.resumed.at(-1)?.id).toBe('two')
  })

  it('states the disclosed session facts Harness already answered', () => {
    // Every line is an authoritative reading — the immutable header, the corpus
    // record's availability, and the bounded log read — presented once, for the
    // one session the reader asked about.
    // Deliberate break: defaulting an unread event count to zero states a fact
    // Harness never answered.
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry({ live: true, parent: 'parent-session' as SessionId, origin: 'delegated' })],
        truncated: 0,
      },
      details: { 'dshline-one': { events: 214, lastActivityAt: NOW - 600_000 } },
    })
    view.render()
    view.press(key('right'))
    const drawn = screen(view)
    expect(drawn).toContain('Fix the wrap bug')
    expect(drawn).toMatch(/Workspace\s+~\/projects\/dshline/u)
    expect(drawn).toMatch(/Created\s+2h ago/u)
    expect(drawn).toMatch(/Activity\s+10m ago/u)
    expect(drawn).toMatch(/Events\s+214/u)
    expect(drawn).toMatch(/Origin\s+delegated/u)
    expect(drawn).toMatch(/Availability\s+live · persisted/u)
    expect(drawn).toMatch(/Parent\s+parent-session/u)
    expect(drawn).toMatch(/Session\s+dshline-one/u)
  })

  it('omits the log-derived facts until the bounded read has landed', () => {
    // Deliberate break: rendering a placeholder for an absent read claims the
    // read is still in flight, which a failed read makes permanently false.
    const view = mount()
    view.render()
    view.press(key('right'))
    const drawn = screen(view)
    expect(drawn).toMatch(/Created\s+2h ago/u)
    expect(drawn).not.toContain('Events')
    expect(drawn).not.toContain('Activity')
  })

  it('leaves the list alone when there is no session under the cursor', () => {
    // Deliberate break: disclosing an absent row draws a detail surface with no
    // subject and no way to name what its actions would act on.
    const view = mount({ listing: { kind: 'ready', entries: [], truncated: 0 } })
    view.render()
    view.press(key('right'))
    const drawn = screen(view)
    expect(drawn).not.toContain('Sessions · details')
    expect(drawn).toContain('No sessions yet')
    expect(view.detailed).toEqual([])
  })

  it('returns to the list on left as well as escape', () => {
    // Right opened it, so left has to close it: a disclosure whose inverse
    // gesture does nothing reads as a dead end.
    const view = mount()
    view.render()
    view.press(key('right'))
    expect(screen(view)).toContain('Sessions · details')
    view.press(key('left'))
    expect(screen(view)).not.toContain('Sessions · details')
    view.press(key('right'), key('escape'))
    expect(screen(view)).not.toContain('Sessions · details')
  })

  it('pushes the lineage and event browsers from the disclosed actions', () => {
    // Deliberate break: constructing a child without passing it through `push`
    // leaves the detail surface visible and the slot stack unchanged.
    const events = mount()
    events.render()
    events.press(key('right'), key('enter'))
    expect(events.pushed).toHaveLength(1)
    expect(events.pushed[0]?.render(COLUMNS, ROWS).map(stripAnsi).join('\n')).toContain('Sessions · events')

    const lineage = mount()
    lineage.render()
    lineage.press(key('right'), key('down'), key('enter'))
    expect(lineage.pushed).toHaveLength(1)
    expect(lineage.pushed[0]?.render(COLUMNS, ROWS).map(stripAnsi).join('\n')).toContain('Sessions · lineage')
  })

  it('offers no corpus filters under one session title', () => {
    // Filters address the corpus. Offering them here said that narrowing the
    // list was something you did to the session under the cursor.
    // Deliberate break: restoring the Filters entry makes the disclosed surface
    // a mixture of two scopes again.
    const view = mount()
    view.render()
    view.press(key('right'))
    expect(screen(view)).not.toContain('Filters')
  })
})

describe('catalog controls', () => {
  it('opens the corpus filters from the list with ctrl-f', () => {
    // Deliberate break: leaving filters behind the per-session menu makes a
    // corpus-wide control reachable only by first selecting a session.
    const view = mount()
    view.render()
    view.press(key('ctrl-f'))
    expect(view.pushed).toHaveLength(1)
    expect(view.pushed[0]?.render(COLUMNS, ROWS).map(stripAnsi).join('\n')).toContain('Sessions · filters')
  })

  it('opens the corpus filters even when no session row is selected', () => {
    // The corpus is exactly what a reader wants to re-narrow when the current
    // clauses left them nothing.
    // Deliberate break: keying filters off the focused row strands a reader
    // whose filters match no session.
    const view = mount({ listing: { kind: 'ready', entries: [], truncated: 0 } })
    view.render()
    view.press(key('ctrl-f'))
    expect(view.pushed).toHaveLength(1)
    expect(view.pushed[0]?.render(COLUMNS, ROWS).map(stripAnsi).join('\n')).toContain('Sessions · filters')
  })

  it('marks list and content titles when catalog filters are active', () => {
    // Deliberate break: comparing filter objects by identity leaves this title
    // unmarked even though one field differs from NO_FILTERS.
    const filters: SessionFiltersValue = { ...NO_FILTERS, age: '7d' }
    const view = mount({ filters, content: contentReady([entry()]) })
    expect(screen(view)).toContain('Sessions · filtered')
    view.press(key('tab'))
    expect(screen(view)).toContain('Sessions · contents · filtered')
  })

  it('restarts the same content query under new filters when applied in content mode', () => {
    // Deliberate break: leaving a stale idle content view after applying
    // filters forces a second tab before the new clauses are asked — the
    // searched log records only the first query.
    const view = mount()
    for (const one of typed('needle')) view.press(one)
    view.press(key('tab'))
    expect(view.searched).toEqual(['needle'])
    view.press(key('ctrl-f'))
    const child = view.pushed.at(-1)
    expect(child).toBeDefined()
    child.handleKey(key('right')) // workspace: all -> current
    child.handleKey(key('enter')) // apply, then the parent re-searches once
    expect(view.searched).toEqual(['needle', 'needle'])
  })

  it('discards armed pagination when filters are applied in content mode', () => {
    // Deliberate break: keeping the armed load-more index after a content
    // filter change selects a stale row in the REPLACEMENT results, so Enter
    // resumes the wrong session — the fresh search lands before the parent
    // redraws, exactly the window the reset has to cover.
    const rows = (prefix: string, count: number): SessionEntry[] =>
      Array.from({ length: count }, (_unused, index) => entry({
        id: `${prefix}-${String(index)}` as SessionId,
        title: `${prefix} ${String(index)}`,
      }))
    let searches = 0
    const harness: Harness = {
      content: contentReady(rows('old', 5), { more: true, revision: 1 }),
      search: () => {
        searches += 1
        harness.content = searches === 1
          ? contentReady(rows('old', 5), { more: true, revision: 1 })
          : contentReady(rows('replacement', 8), { more: false, revision: 2 })
      },
    }
    const view = mount(harness)
    for (const one of typed('needle')) view.press(one)
    view.press(key('tab'))
    view.render()
    view.press(key('end')) // select the Load more row (index 5)
    view.press(key('enter')) // arm load-more
    view.press(key('ctrl-f'))
    const child = view.pushed.at(-1)
    expect(child).toBeDefined()
    child.handleKey(key('right')) // workspace: all -> current
    child.handleKey(key('enter')) // apply: resign + reset + fresh search lands replacement
    view.render()
    view.press(key('enter'))
    expect(view.resumed.at(-1)?.id).toBe('replacement-0')
  })

  it('loads once, shows loading immediately, then selects the first appended entry', () => {
    // Deliberate break: leaving the continuation armed lets key repeat issue two
    // requests before the catalog's async state reaches the overlay.
    const harness: Harness = { content: contentReady([entry()], { more: true }) }
    const view = mount(harness)
    view.press(key('tab'))
    view.render()
    view.press(key('end'))
    expect(screen(view)).toContain('Load more…')
    view.press(key('enter'), key('enter'))
    expect(view.loadMoreCalls()).toBe(1)
    expect(screen(view)).toContain('Loading more…')

    harness.content = contentReady([
      entry(),
      entry({ id: 'new-first' as SessionId, title: 'FIRST-APPENDED' }),
      entry({ id: 'new-second' as SessionId, title: 'SECOND-APPENDED' }),
    ])
    view.render()
    view.press(key('enter'))
    expect(view.resumed.at(-1)?.id).toBe('new-first')
  })

  it('offers an explicit cursorless refresh when results changed', () => {
    // Deliberate break: treating restart as ordinary `more` would call the
    // cursor continuation instead of the restart surface.
    const view = mount({ content: contentReady([entry()], { more: true, restart: true }) })
    view.press(key('tab'))
    view.render()
    view.press(key('end'))
    expect(screen(view)).toContain('Refresh (results changed)')
    view.press(key('enter'))
    expect(view.restartCalls()).toBe(1)
    expect(view.loadMoreCalls()).toBe(0)
  })

  it('reports returned, matched, continuation, end, and loading facts honestly', () => {
    // Deliberate break: counting only visible entries reports `1 result` for a
    // provider page that returned three rows and retained one after filtering.
    const harness: Harness = {
      content: contentReady([entry()], { returned: 3, matched: 1, more: true }),
    }
    const view = mount(harness)
    view.press(key('tab'))
    expect(screen(view)).toContain('1 of 3 matched · more available')
    harness.content = contentReady([entry()], { returned: 1, matched: 1, loadingMore: true, more: true })
    expect(screen(view)).toContain('1 result · more available · loading more')
    harness.content = contentReady([entry()], { returned: 1, matched: 1, more: false })
    expect(screen(view)).toContain('1 result · end')
  })

  it('never resumes or discloses a continuation pseudo-row', () => {
    // Deliberate break: indexing `visible[selected]` after End used to make a
    // pseudo-row inherit the preceding session's resume and detail behavior.
    const view = mount({ content: contentReady([entry()], { more: true }) })
    view.press(key('tab'))
    view.render()
    view.press(key('end'))
    view.render()
    view.press(key('enter'))
    expect(view.resumed).toEqual([])
    view.press(key('right'))
    expect(view.detailed).toEqual([])
    expect(screen(view)).not.toContain('Sessions · details')
  })

  it('marks an empty continuation page landed so the row stops loading', () => {
    // Deliberate break: waiting for an appended row to notice a page would leave
    // "Loading more…" visible forever when the page retained nothing. The page
    // revision is the authoritative landing signal.
    const harness: Harness = { content: contentReady([entry()], { more: true }) }
    const view = mount(harness)
    view.press(key('tab'))
    view.render()
    view.press(key('end'))
    view.press(key('enter'))
    expect(screen(view)).toContain('Loading more…')
    harness.content = contentReady([entry()], { more: true, revision: 1 })
    view.render()
    expect(screen(view)).toContain('Load more…')
    expect(screen(view)).not.toContain('Loading more…')
    expect(view.loadMoreCalls()).toBe(1)
  })

  it('keeps a zero-visible page pageable behind Load more', () => {
    // The backend returned hits which the presentation-only origin filter
    // retained none of: the ready state must survive so the opaque cursor is
    // not stranded, the wording must not claim no session log matched, and the
    // continuation row must stay selectable. The never-resume rule must hold
    // for the message row too.
    // Deliberate break: converting a zero-visible ready state into the flat
    // no-match sentence drops the cursor and hides the continuation.
    const harness: Harness = {
      filters: { ...NO_FILTERS, origin: 'delegated' },
      content: contentReady([], { returned: 50, matched: 0, more: true, revision: 1 }),
    }
    const view = mount(harness)
    for (const one of typed('needle')) view.press(one)
    view.press(key('tab'))
    view.render()
    const drawn = screen(view)
    expect(drawn).toContain('No returned results match the active filters yet.')
    expect(drawn).toContain('Load more…')
    view.press(key('end'), key('enter'))
    expect(view.loadMoreCalls()).toBe(1)
    expect(view.resumed).toEqual([])
    // The next page returns a delegated match; it appends and becomes visible.
    harness.content = contentReady([entry({ id: 'delegated-hit' as SessionId, title: 'Delegated match' })], {
      returned: 51,
      matched: 1,
      more: false,
      revision: 2,
    })
    view.render()
    expect(screen(view)).toContain('Delegated match')
    expect(screen(view)).not.toContain('Load more…')
  })

  it('keeps zero visible rows actionable behind Refresh', () => {
    // Deliberate break: letting the no-row view swallow `restart` traps the
    // reader on an empty message with no way to re-ask the search.
    const view = mount({
      content: contentReady([], { returned: 50, matched: 0, more: false, restart: true, revision: 1 }),
    })
    for (const one of typed('needle')) view.press(one)
    view.press(key('tab'))
    view.render()
    expect(screen(view)).toContain('Refresh (results changed)')
    view.press(key('end'), key('enter'))
    expect(view.restartCalls()).toBe(1)
    expect(view.resumed).toEqual([])
  })

  it('counts the trailing row in viewport navigation and more-below facts', () => {
    // Deliberate break: sizing the viewport from entries alone makes End unable
    // to reveal the continuation row at the bottom of a short window.
    const rows = Array.from({ length: 12 }, (_unused, index) => entry({
      id: `page-${String(index)}` as SessionId,
      title: `Page row ${String(index)}`,
    }))
    const view = mount({ content: contentReady(rows, { more: true }) })
    view.press(key('tab'))
    expect(screen(view, COLUMNS, 16)).toContain('more below')
    view.press(key('end'))
    expect(screen(view, COLUMNS, 16)).toContain('Load more…')
    view.press(key('home'))
    expect(screen(view, COLUMNS, 16)).toContain('Page row 0')
  })

  it('surrenders the corpus gestures before the ones that pick a session', () => {
    // The mental model, ordered by how badly a reader needs it: type to search,
    // tab for contents, ctrl-f for filters, right for detail, enter to reopen.
    // A narrowing footer therefore loses the corpus half first.
    // Deliberate break: ordering reopen before detail hides the primary action
    // of a picker while a disclosure hint survives.
    const wide = mount().render(COLUMNS, ROWS).map(stripAnsi).at(-1) ?? ''
    expect(wide).toContain('ctrl-f filters')
    expect(wide).toContain('→ details')
    expect(wide.indexOf('ctrl-f filters')).toBeLessThan(wide.indexOf('→ details'))
    expect(wide.indexOf('→ details')).toBeLessThan(wide.indexOf('↵ reopen'))
    expect(wide.indexOf('↵ reopen')).toBeLessThan(wide.indexOf('esc close'))
    const narrow = mount().render(46, ROWS).map(stripAnsi).at(-1) ?? ''
    expect(narrow).toContain('↵ reopen')
    expect(narrow).toContain('esc close')
    expect(narrow).not.toContain('ctrl-f filters')
  })
})

describe('renaming the current session', () => {
  it('offers Rename only on the current row when rename authority exists', () => {
    // Deliberate break: keying this action only on capability offers rename on
    // the persisted second row, which has no live Session object to authorize it.
    const view = mount({
      currentSessionId: 'dshline-one' as SessionId,
      listing: {
        kind: 'ready',
        entries: [entry(), entry({ id: 'persisted-only' as SessionId })],
        truncated: 0,
      },
      renameDraft: async () => ({ kind: 'cancelled' }),
    })
    view.render()
    view.press(key('right'))
    expect(screen(view)).toContain('Rename')
    view.press(key('escape'), key('down'), key('right'))
    expect(screen(view)).not.toContain('Rename')
  })

  it('offers no Rename action without rename authority', () => {
    // Deliberate break: offering Rename without `renameDraft` advertises an
    // action this profile and launch window cannot perform.
    const view = mount({ currentSessionId: 'dshline-one' as SessionId })
    view.render()
    view.press(key('right'))
    expect(screen(view)).not.toContain('Rename')
  })

  it('prefills rename from the focused content row, not the bounded listing', () => {
    // The current session can sit beyond CATALOG_LIMIT and surface only through
    // content search; its prefill must come from the focused row, which carries
    // the displayed authoritative folded title, not from a bounded base
    // listing that may not contain the session at all.
    // Deliberate break: rediscovering the title from the base listing leaves
    // the prompt blank for a content-found session.
    const view = mount({
      currentSessionId: 'dshline-one' as SessionId,
      listing: {
        kind: 'ready',
        entries: [entry({ id: 'unrelated-ranked-first' as SessionId, title: 'Unrelated' })],
        truncated: 0,
      },
      content: contentReady([entry({ title: 'Old title' })]),
      renameDraft: async () => ({ kind: 'cancelled' }),
    })
    for (const one of typed('needle')) view.press(one)
    view.press(key('tab'))
    view.render()
    view.press(key('right'), key('down'), key('down'), key('enter'))
    expect(view.renamePrefills()).toEqual(['Old title'])
  })

  it('returns to the list, reports the accepted title, and never resumes', async () => {
    const view = mount({
      currentSessionId: 'dshline-one' as SessionId,
      renameDraft: async () => ({ kind: 'renamed', title: 'New Name' }),
    })
    view.render()
    view.press(key('right'), key('down'), key('down'), key('enter'))
    expect(screen(view)).toContain('Fix the wrap bug')
    await renameSettled()
    expect(screen(view)).toContain('Renamed to “New Name”')
    expect(view.renameCalls()).toBe(1)
    expect(view.resumed).toEqual([])
    expect(view.closed()).toBe(false)
  })

  it('escapes the reason from a failed rename before drawing it', async () => {
    const view = mount({
      currentSessionId: 'dshline-one' as SessionId,
      renameDraft: async () => ({ kind: 'failed', message: `invalid ${ERASE_DISPLAY}` }),
    })
    view.render()
    view.press(key('right'), key('down'), key('down'), key('enter'))
    await renameSettled()
    const rows = view.render()
    expect(rows.join('\n')).not.toContain(ERASE_DISPLAY)
    expect(rows.map(stripAnsi).join('\n')).toContain('Rename failed: invalid ^[[2Jafter')
    expect(view.resumed).toEqual([])
  })

  it('shows a failed notice when rename collection rejects', async () => {
    const view = mount({
      currentSessionId: 'dshline-one' as SessionId,
      renameDraft: async () => { throw new Error('title service disappeared') },
    })
    view.render()
    view.press(key('right'), key('down'), key('down'), key('enter'))
    await renameSettled()
    expect(screen(view)).toContain('Rename failed: title service disappeared')
    expect(view.resumed).toEqual([])
  })

  it('keeps a multiline rename failure on one row, even in a tiny terminal', async () => {
    // Deliberate break: drawing the notice with its raw newline lets Screen
    // expand one logical row into two, overflowing a short terminal.
    const view = mount({
      currentSessionId: 'dshline-one' as SessionId,
      renameDraft: async () => ({ kind: 'failed', message: 'line one\nline two' }),
    })
    view.render()
    view.press(key('right'), key('down'), key('down'), key('enter'))
    await renameSettled()
    const rows = view.render(COLUMNS, 6)
    expect(rows).toHaveLength(1)
    expect(rows.map(stripAnsi).join('\n')).toContain('Rename failed: line one line two')
  })

  it('ignores a rename that settles after the browser closed', async () => {
    // Deliberate break: letting the continuation invalidate after dismissal
    // repaints a live region the browser no longer owns.
    let resolveRename!: (outcome: RenameDraftOutcome) => void
    const view = mount({
      currentSessionId: 'dshline-one' as SessionId,
      renameDraft: () => new Promise<RenameDraftOutcome>(resolve => { resolveRename = resolve }),
    })
    view.render()
    view.press(key('right'), key('down'), key('down'), key('enter'))
    view.press(key('ctrl-c'))
    const before = view.invalidates()
    resolveRename({ kind: 'renamed', title: 'Late' })
    await renameSettled()
    expect(view.closed()).toBe(true)
    expect(view.invalidates()).toBe(before)
    expect(view.resumed).toEqual([])
  })

  it('shows nothing and preserves list state when rename is cancelled', async () => {
    // Deliberate break: treating cancellation as failure adds a notice and
    // changes this otherwise identical parent frame.
    const view = mount({
      currentSessionId: 'dshline-one' as SessionId,
      renameDraft: async () => ({ kind: 'cancelled' }),
    })
    const before = screen(view)
    view.press(key('right'), key('down'), key('down'), key('enter'))
    await renameSettled()
    expect(screen(view)).toBe(before)
    expect(view.renameCalls()).toBe(1)
    expect(view.resumed).toEqual([])
  })
})

describe('choosing a session', () => {
  it('reopens the selected row and closes', () => {
    const view = mount({
      listing: { kind: 'ready', entries: [entry(), entry({ id: 'two' as SessionId })], truncated: 0 },
    })
    view.render()
    view.press(key('down'), key('enter'))
    expect(view.resumed.map(target => target.id)).toEqual(['two'])
    expect(view.closed()).toBe(true)
  })

  it('keeps the browser open and says why when the owner refuses', () => {
    const view = mount({ resume: () => ({ kind: 'refused', message: 'Finish the current turn first.' }) })
    view.render()
    view.press(key('enter'))
    expect(view.closed()).toBe(false)
    expect(screen(view)).toContain('Finish the current turn first.')
  })

  it('lets a refusal expire so the list comes back', () => {
    let clock = NOW
    const view = mount({
      now: () => clock,
      resume: () => ({ kind: 'refused', message: 'Already open.' }),
    })
    view.render()
    view.press(key('enter'))
    expect(screen(view)).toContain('Already open.')
    clock += 5_000
    expect(screen(view)).not.toContain('Already open.')
  })

  it('does nothing when there is nothing to choose', () => {
    const view = mount({ listing: { kind: 'ready', entries: [], truncated: 0 } })
    view.render()
    view.press(key('enter'), key('up'), key('down'))
    expect(view.resumed).toEqual([])
    expect(view.closed()).toBe(false)
  })

  it('wraps at both ends of the list', () => {
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry(), entry({ id: 'two' as SessionId }), entry({ id: 'three' as SessionId })],
        truncated: 0,
      },
    })
    view.render()
    view.press(key('up'))
    view.render()
    view.press(key('enter'))
    expect(view.resumed.map(target => target.id)).toEqual(['three'])
  })

  it('jumps to the ends with home and end', () => {
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry(), entry({ id: 'two' as SessionId }), entry({ id: 'three' as SessionId })],
        truncated: 0,
      },
    })
    view.render()
    view.press(key('end'))
    view.render()
    view.press(key('enter'))
    expect(view.resumed.at(-1)?.id).toBe('three')
  })

  it('closes on ctrl-c without reopening anything', () => {
    const view = mount()
    view.press(key('ctrl-c'))
    expect(view.closed()).toBe(true)
    expect(view.resumed).toEqual([])
  })
})

describe('a terminal too small for the frame', () => {
  /** Enough rows to make the list scroll rather than fit. */
  const many: SessionEntry[] = Array.from({ length: 40 }, (_unused, index) =>
    entry({ id: `s-${String(index)}` as SessionId, title: `Session ${String(index)}` }))

  it('stays inside a short terminal and keeps the way out', () => {
    const view = mount({ listing: { kind: 'ready', entries: many, truncated: 0 } })
    for (const rows of [24, 15, 8, 5, 3, 1]) {
      const drawn = view.render(COLUMNS, rows)
      expect(drawn.length, `rows=${String(rows)}`).toBeLessThanOrEqual(rows)
      expect(drawn.map(stripAnsi).join('\n'), `rows=${String(rows)}`).toContain('esc')
    }
  })

  it('falls back on a narrow terminal rather than colliding title and age', () => {
    const view = mount({ listing: { kind: 'ready', entries: many, truncated: 0 } })
    const drawn = view.render(20, ROWS).map(stripAnsi)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toContain('esc close')
  })

  it('keeps a refusal visible even in the compact fallback', () => {
    // A declined action must not look ignored because the window is small.
    const view = mount({ resume: () => ({ kind: 'refused', message: 'Already live in this process.' }) })
    view.render()
    view.press(key('enter'))
    expect(screen(view, 20, 2)).toContain('Already live')
  })

  it('scrolls the selection into view instead of drawing past the window', () => {
    const view = mount({ listing: { kind: 'ready', entries: many, truncated: 0 } })
    view.render(COLUMNS, 12)
    view.press(key('end'))
    const drawn = view.render(COLUMNS, 12)
    expect(drawn.length).toBeLessThanOrEqual(12)
    expect(drawn.map(stripAnsi).join('\n')).toContain('Session 39')
    expect(drawn.map(stripAnsi).join('\n')).not.toContain('Session 0 ')
  })

  it('says when rows are hidden below the window', () => {
    const view = mount({ listing: { kind: 'ready', entries: many, truncated: 0 } })
    expect(screen(view, COLUMNS, 12)).toContain('more below')
  })

  it('keeps the disclosed surface inside every height, and keeps its way out', () => {
    // Deliberate break: drawing the whole fact block regardless of height wraps
    // the disclosed surface's bottom border into committed scrollback.
    const view = mount({
      currentSessionId: 'dshline-one' as SessionId,
      details: { 'dshline-one': { events: 214, lastActivityAt: NOW - 600_000 } },
      renameDraft: async () => ({ kind: 'cancelled' }),
    })
    view.render()
    view.press(key('right'))
    for (const rows of [24, 15, 10, 8, 5, 3, 1]) {
      const drawn = view.render(COLUMNS, rows)
      expect(drawn.length, `rows=${String(rows)}`).toBeLessThanOrEqual(rows)
      expect(drawn.map(stripAnsi).join('\n'), `rows=${String(rows)}`).toContain('esc')
    }
  })

  it('spends a short height on the actions and the title, not on the facts', () => {
    // The surface exists to say which session this is and offer what can be
    // done to it. A height that cannot hold everything keeps those.
    // Deliberate break: truncating the actions instead of the facts leaves a
    // detail surface that discloses nothing to act on.
    const view = mount({
      details: { 'dshline-one': { events: 214, lastActivityAt: NOW - 600_000 } },
    })
    view.render()
    view.press(key('right'))
    const drawn = view.render(COLUMNS, 9).map(stripAnsi).join('\n')
    expect(drawn).toContain('Fix the wrap bug')
    expect(drawn).toContain('Find in this session')
    expect(drawn).toContain('Lineage')
    expect(drawn).not.toContain('Session     ')
  })

  it('falls back on a narrow terminal rather than colliding a label and its value', () => {
    const view = mount()
    view.render()
    view.press(key('right'))
    const drawn = view.render(20, ROWS).map(stripAnsi)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toContain('esc back')
  })
})

describe('content-search overflow and selected evidence', () => {
  /**
   * One content result, optionally carrying a Harness match excerpt.
   * @param index - the result's index, used for its id and title.
   * @param snippet - the Harness-selected excerpt, when it has one.
   * @returns the entry.
   */
  function result(index: number, snippet?: string): SessionEntry {
    return entry({
      id: `result-${String(index)}` as SessionId,
      title: `Result ${String(index)}`,
      ...(snippet === undefined ? {} : { snippet }),
    })
  }

  /**
   * A page of content results.
   * @param count - how many results.
   * @param withSnippet - whether each result carries an excerpt.
   * @returns the entries.
   */
  function results(count: number, withSnippet: boolean): SessionEntry[] {
    return Array.from({ length: count }, (_unused, index) => result(index, withSnippet ? `match ${String(index)}` : undefined))
  }

  it('does not claim more below for a selected excerpt alone, and keeps it visible', () => {
    // 11 results fill the 11-row window exactly; the last result's excerpt is
    // the only row that would otherwise be below. Selecting a result is not a
    // second choice, so the hint stays away — but the excerpt is the evidence
    // for the hit, so the viewport must still reveal it.
    const view = mount({ content: contentReady(results(11, true)) })
    view.press(key('tab'))
    view.render(COLUMNS, 16)
    for (let step = 0; step < 10; step += 1) {
      view.press(key('down'))
      view.render(COLUMNS, 16)
    }
    const drawn = screen(view, COLUMNS, 16)
    expect(drawn).toContain('11 results · end')
    expect(drawn).not.toContain('more below')
    expect(drawn).toContain('match 10')
  })

  it('converges whether the last result is reached by Down or by End', () => {
    // The same logical selection must present the same viewport and counter,
    // whatever route reached it. An index-based predicate or a viewport that
    // follows only the entry row would let these two frames disagree.
    const items = results(11, true)
    const viaDown = mount({ content: contentReady(items) })
    viaDown.press(key('tab'))
    viaDown.render(COLUMNS, 16)
    for (let step = 0; step < 10; step += 1) {
      viaDown.press(key('down'))
      viaDown.render(COLUMNS, 16)
    }
    const viaEnd = mount({ content: contentReady(items) })
    viaEnd.press(key('tab'))
    viaEnd.render(COLUMNS, 16)
    viaEnd.press(key('end'))
    const downFrame = screen(viaDown, COLUMNS, 16)
    const endFrame = screen(viaEnd, COLUMNS, 16)
    expect(downFrame).toBe(endFrame)
    expect(endFrame).toContain('match 10')
    expect(endFrame).not.toContain('more below')
  })

  it('settles on the first End press when selecting the last result reveals its excerpt', () => {
    // Before selection this document is 11 rows. Selecting the last result adds
    // its excerpt as row 12, but `End` pins the bottom against the OLD geometry,
    // so the render-time block follow has to finish the job in the same frame.
    const items = [...Array.from({ length: 10 }, (_unused, index) => result(index)), result(10, 'match 10')]
    const view = mount({ content: contentReady(items) })
    view.press(key('tab'))
    view.render(COLUMNS, 16)
    view.press(key('end'))
    const drawn = screen(view, COLUMNS, 16)
    expect(drawn).toContain('match 10')
    expect(drawn).not.toContain('more below')
  })

  it('does not claim more below for a Loading more status row alone', () => {
    // `loading more` already reports the in-flight request; the dimmed row is
    // not a choice, so it cannot be the reason for a second hint. The Harness
    // cursor fact stays.
    const view = mount({
      content: contentReady(results(11, false), { more: true, loadingMore: true }),
    })
    view.press(key('tab'))
    const drawn = screen(view, COLUMNS, 16)
    expect(drawn).toContain('11 results')
    expect(drawn).toContain('more available')
    expect(drawn).toContain('loading more')
    expect(drawn).not.toContain('more below')
  })

  it('does not claim more below for a Loading more row after the cursor ended', () => {
    const view = mount({
      content: contentReady(results(11, false), { more: false, loadingMore: true }),
    })
    view.press(key('tab'))
    const drawn = screen(view, COLUMNS, 16)
    expect(drawn).toContain('end')
    expect(drawn).toContain('loading more')
    expect(drawn).not.toContain('more below')
  })

  it('still claims more below when the Load more action is below the viewport', () => {
    // `more available` is the Harness cursor; `more below` is the local fact
    // that the action which spends it is off-screen. They must be able to agree.
    const view = mount({ content: contentReady(results(11, false), { more: true }) })
    view.press(key('tab'))
    const drawn = screen(view, COLUMNS, 16)
    expect(drawn).toContain('more available')
    expect(drawn).toContain('more below')
  })

  it('lets end and more below coexist when Refresh is the hidden choice', () => {
    // A cursor restart clears `content.more` but leaves a selectable Refresh
    // action, so `end · more below` is truthful and must not be tied to the
    // Harness cursor fact.
    const view = mount({
      content: contentReady(results(11, false), { more: false, restart: true }),
    })
    view.press(key('tab'))
    const drawn = screen(view, COLUMNS, 16)
    expect(drawn).toContain('11 results · end')
    expect(drawn).toContain('more below')
  })

  it('still claims more below when a selected excerpt pushes a later result below', () => {
    const view = mount({ content: contentReady(results(11, true)) })
    view.press(key('tab'))
    view.render(COLUMNS, 16)
    for (let step = 0; step < 5; step += 1) {
      view.press(key('down'))
      view.render(COLUMNS, 16)
    }
    const drawn = screen(view, COLUMNS, 16)
    expect(drawn).toContain('match 5')
    expect(drawn).toContain('more below')
  })

  it('does not claim more below when every choice and the excerpt fit', () => {
    // The cursor is on the first result, not the last; a predicate derived from
    // logical ordering would still claim later choices are hidden.
    const view = mount({ content: contentReady(results(5, true)) })
    view.press(key('tab'))
    const drawn = screen(view, COLUMNS, 16)
    expect(drawn).toContain('5 results · end')
    expect(drawn).toContain('match 0')
    expect(drawn).not.toContain('more below')
  })

  it('keeps a zero-result explanation unselectable behind its Load more continuation', () => {
    // Presentation filtering can leave zero visible rows while the opaque cursor
    // still has a next page. The explanation is not a session, so only the
    // continuation is a choice. Framed content geometry always fits the two-row
    // message + continuation document, so there is nothing below to claim; that
    // Enter reaches the continuation and never the explanation is what pins the
    // selectable set.
    const view = mount({
      filters: { ...NO_FILTERS, origin: 'delegated' },
      content: contentReady([], { returned: 50, matched: 0, more: true, revision: 1 }),
    })
    for (const one of typed('needle')) view.press(one)
    view.press(key('tab'))
    view.render(COLUMNS, 16)
    const drawn = screen(view, COLUMNS, 16)
    expect(drawn).toContain('No returned results match the active filters yet.')
    expect(drawn).toContain('Load more…')
    expect(drawn).not.toContain('more below')
    view.press(key('enter'))
    expect(view.loadMoreCalls()).toBe(1)
    expect(view.resumed).toEqual([])
  })

  it('keeps a zero-result explanation unselectable behind its Refresh continuation', () => {
    const view = mount({
      filters: { ...NO_FILTERS, origin: 'delegated' },
      content: contentReady([], { returned: 50, matched: 0, more: false, restart: true, revision: 1 }),
    })
    for (const one of typed('needle')) view.press(one)
    view.press(key('tab'))
    view.render(COLUMNS, 16)
    const drawn = screen(view, COLUMNS, 16)
    expect(drawn).toContain('No returned results match the active filters yet.')
    expect(drawn).toContain('Refresh (results changed)')
    expect(drawn).not.toContain('more below')
    view.press(key('enter'))
    expect(view.restartCalls()).toBe(1)
    expect(view.resumed).toEqual([])
  })
})

describe('compact content-search summaries', () => {
  /**
   * The height-triggered compact geometry with columns to spare, so the full
   * truthful line can survive and only a genuinely narrow width makes it degrade.
   */
  const COMPACT_ROWS = 15

  /**
   * One retained content result.
   * @param index - the result's index, used for its id and title.
   * @returns the entry.
   */
  function hit(index: number): SessionEntry {
    return entry({ id: `compact-hit-${String(index)}` as SessionId, title: `Compact hit ${String(index)}` })
  }

  /**
   * A landed content page retaining `count` rows.
   * @param count - how many rows presentation keeps.
   * @param overrides - Harness facts to replace.
   * @returns the content state.
   */
  function page(
    count: number,
    overrides: Partial<Extract<ContentState, { kind: 'ready' }>> = {},
  ): ContentState {
    return contentReady(Array.from({ length: count }, (_unused, index) => hit(index)), overrides)
  }

  it('labels content-search rows as results, never as sessions', () => {
    // Deliberate break: the generic compact fallback said `3 sessions`, a count
    // of picks rather than of Harness hits.
    const view = mount({ content: page(3) })
    view.press(key('tab'))
    const drawn = screen(view, COLUMNS, COMPACT_ROWS)
    expect(drawn).toContain('3 results')
    expect(drawn).toContain('end')
    expect(drawn).toContain('↵ reopen')
    expect(drawn).toContain('esc close')
    expect(drawn).not.toContain('sessions')
  })

  it('keeps the Harness cursor continuation fact', () => {
    const view = mount({ content: page(3, { more: true }) })
    view.press(key('tab'))
    const drawn = screen(view, COLUMNS, COMPACT_ROWS)
    expect(drawn).toContain('3 results')
    expect(drawn).toContain('more available')
    expect(drawn).not.toContain('end')
  })

  it('keeps the in-flight load fact separate from the cursor fact', () => {
    const continuing = mount({ content: page(3, { more: true, loadingMore: true }) })
    continuing.press(key('tab'))
    const withMore = screen(continuing, COLUMNS, COMPACT_ROWS)
    expect(withMore).toContain('3 results')
    expect(withMore).toContain('more available')
    expect(withMore).toContain('loading more')

    const ended = mount({ content: page(3, { more: false, loadingMore: true }) })
    ended.press(key('tab'))
    const withoutMore = screen(ended, COLUMNS, COMPACT_ROWS)
    expect(withoutMore).toContain('end')
    expect(withoutMore).toContain('loading more')
    expect(withoutMore).not.toContain('more available')
  })

  it('keeps X-of-Y matched semantics after presentation filtering', () => {
    // Deliberate break: deriving the count from visible rows reports `2 results`
    // for a Harness page that returned three and retained two.
    const view = mount({ content: contentReady([hit(0), hit(1)], { returned: 3, matched: 2 }) })
    view.press(key('tab'))
    const drawn = screen(view, COLUMNS, COMPACT_ROWS)
    expect(drawn).toContain('2 of 3 matched')
    expect(drawn).not.toContain('2 results')
  })

  it('names the selected Load more action and runs it', () => {
    // Deliberate break: deciding the action from `content.more` alone, or
    // hard-coding `↵ reopen`, lies about what Enter does on the trailing row.
    const view = mount({ content: page(3, { more: true }) })
    view.press(key('tab'))
    view.render(COLUMNS, ROWS)
    view.press(key('end'))
    view.render(COLUMNS, ROWS)
    const drawn = screen(view, COLUMNS, COMPACT_ROWS)
    expect(drawn).toContain('↵ load more')
    expect(drawn).not.toContain('↵ reopen')
    view.press(key('enter'))
    expect(view.loadMoreCalls()).toBe(1)
    expect(view.resumed).toEqual([])
  })

  it('names the selected Refresh action and runs it', () => {
    // `end` here is the Harness cursor having ended or staled; Refresh is the
    // current local choice, so both facts must be able to coexist.
    const view = mount({ content: page(3, { more: false, restart: true }) })
    view.press(key('tab'))
    view.render(COLUMNS, ROWS)
    view.press(key('end'))
    view.render(COLUMNS, ROWS)
    const drawn = screen(view, COLUMNS, COMPACT_ROWS)
    expect(drawn).toContain('end')
    expect(drawn).toContain('↵ refresh')
    expect(drawn).not.toContain('↵ reopen')
    view.press(key('enter'))
    expect(view.restartCalls()).toBe(1)
    expect(view.loadMoreCalls()).toBe(0)
  })

  it('does not turn the non-selectable loading row into an action', () => {
    const selectedResult = mount({ content: page(3, { more: true, loadingMore: true }) })
    selectedResult.press(key('tab'))
    const withResult = screen(selectedResult, COLUMNS, COMPACT_ROWS)
    expect(withResult).toContain('↵ reopen')
    expect(withResult).not.toContain('↵ load more')

    const noRow = mount({
      content: contentReady([], { returned: 3, matched: 0, more: true, loadingMore: true }),
    })
    noRow.press(key('tab'))
    const stranded = screen(noRow, COLUMNS, COMPACT_ROWS)
    expect(stranded).toContain('loading more')
    expect(stranded).not.toContain('↵ load more')
    expect(stranded).not.toContain('↵ reopen')
  })

  it('keeps a zero-visible result pageable and names Load more', () => {
    // The explanation row is not a session and is not a choice; only the
    // continuation is, so Enter on it must still load.
    const view = mount({
      filters: { ...NO_FILTERS, origin: 'delegated' },
      content: contentReady([], { returned: 3, matched: 0, more: true, revision: 1 }),
    })
    for (const one of typed('needle')) view.press(one)
    view.press(key('tab'))
    const drawn = screen(view, COLUMNS, COMPACT_ROWS)
    expect(drawn).toContain('0 of 3 matched')
    expect(drawn).toContain('more available')
    expect(drawn).toContain('↵ load more')
    view.press(key('enter'))
    expect(view.loadMoreCalls()).toBe(1)
    expect(view.resumed).toEqual([])
  })

  it('degrades at the narrow threshold without saying anything false', () => {
    const view = mount({ content: page(3, { more: true }) })
    view.press(key('tab'))
    view.render(COLUMNS, ROWS)
    view.press(key('end')) // select the Load more action
    view.render(COLUMNS, ROWS)
    for (const columns of [40, 30, 20, 12]) {
      const drawn = view.render(columns, COMPACT_ROWS).map(stripAnsi)
      const line = drawn.join('\n')
      expect(drawn.length, `columns=${String(columns)}`).toBeLessThanOrEqual(COMPACT_ROWS)
      expect(line, `columns=${String(columns)}`).toContain('esc')
      expect(line, `columns=${String(columns)}`).not.toContain('sessions')
      // Load more is selected, so `↵ reopen` would be a lie; when the truthful
      // action cannot fit, the line states no action at all.
      expect(line, `columns=${String(columns)}`).not.toContain('↵ reopen')
    }
    // With a real result under the cursor the same width tells the truth.
    view.press(key('home'))
    const reopened = screen(view, 40, COMPACT_ROWS)
    expect(reopened).toContain('3 results')
    expect(reopened).toContain('↵ reopen')
    expect(reopened).not.toContain('sessions')
  })

  it('leaves ordinary filter-mode compact wording unchanged', () => {
    const view = mount({
      listing: {
        kind: 'ready',
        entries: [entry({ id: 'one' as SessionId }), entry({ id: 'two' as SessionId })],
        truncated: 0,
      },
    })
    // Rows, not columns: height alone forces the fallback while leaving the full
    // filter line room, so this pins the wording rather than the shortening.
    expect(screen(view, COLUMNS, 5)).toBe('2 sessions · ↵ reopen · esc close')
  })
})
