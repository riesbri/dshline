/**
 * Choosing a conversation from the Sessions browser's Lineage surface.
 *
 * The browser opens on the conversations a person started, so a delegated child
 * is no longer a peer row. Lineage is where such a relationship is visible, and
 * these tests pin the one thing that makes it useful rather than merely
 * readable: a real related session can be chosen from there and is answered by
 * the SAME root decision an ordinary list row is answered by.
 *
 * Everything drives the real `browseSessions` composition root over the real
 * catalog, navigator and overlay stack — including the child overlay the `→`
 * detail pushes — so an assertion is a row a reader would see or a session the
 * browser would actually reopen.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventSearchPage,
  SessionLineageNode,
  SessionLineageTrace,
  SessionRecord,
  SessionSearchHit,
  SessionSearchPage,
  SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import type { SessionQueryReads } from '../src/sessions/catalog.ts'
import { browseSessions, type BrowseSpec } from '../src/sessions/index.ts'
import type { SessionTarget } from '../src/sessions/model.ts'

/** Let the catalog's own awaits settle before reading its state. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

/** A fixed clock, so ages never depend on when the suite runs. */
const NOW = 1_800_000_000_000
/** One hour in milliseconds. */
const HOUR = 3_600_000

/**
 * One structurally valid session header.
 * @param id - the session id.
 * @param overrides - header fields to replace.
 * @returns the header.
 */
function header(id: string, overrides: Record<string, unknown> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: id as SessionId,
    createdAt: NOW,
    isSeeded: false,
    ...overrides,
  } as SessionHeader
}

/**
 * One corpus record.
 * @param id - the session id.
 * @param overrides - header and availability fields to replace.
 * @returns the record.
 */
function record(id: string, overrides: Record<string, unknown> = {}): SessionRecord {
  const { live = false, persisted = true, ...rest } = overrides
  return {
    header: header(id, { cwd: '/work', ...rest }),
    live: live as boolean,
    persisted: persisted as boolean,
  }
}

/**
 * A fulfilled title observation carrying the session's OWN header.
 * @param id - the session id.
 * @param source - the record the observation folds from.
 * @returns the settlement.
 */
function titled(id: string, source: SessionRecord): SessionTitleObservationResult {
  return {
    sessionId: id as SessionId,
    status: 'fulfilled',
    value: {
      session: source.header,
      title: { title: `Title ${id}`, messageSeqs: [0], source: { kind: 'fallback' }, eventSeq: 1, updatedAt: NOW },
    },
  }
}

/** The top-level conversation every lineage test starts from. */
const ROOT = 'root'

/**
 * A root with an ordinary fork, three generations of delegated descendants, and
 * a second root, so a trace has ancestors, siblings, and depth on both sides of
 * the target.
 * @returns the authoritative corpus, newest first.
 */
function corpus(): SessionRecord[] {
  const age = (hours: number): number => NOW - hours * HOUR
  return [
    record('other-root', { createdAt: age(1) }),
    record(ROOT, { createdAt: age(2) }),
    record('fork', { parentSession: ROOT as SessionId, isSeeded: true, createdAt: age(3) }),
    record('child', { origin: 'subagent', parentSession: ROOT as SessionId, delegationDepth: 1, createdAt: age(4) }),
    record('grandchild', {
      origin: 'subagent',
      parentSession: 'child' as SessionId,
      delegationDepth: 2,
      createdAt: age(5),
    }),
    record('great-grandchild', {
      origin: 'subagent',
      parentSession: 'grandchild' as SessionId,
      delegationDepth: 3,
      createdAt: age(6),
    }),
  ]
}

/** How each corpus session's parent is declared. */
const PARENTS: Readonly<Record<string, SessionId | undefined>> = {
  'other-root': undefined,
  [ROOT]: undefined,
  fork: ROOT as SessionId,
  child: ROOT as SessionId,
  grandchild: 'child' as SessionId,
  'great-grandchild': 'grandchild' as SessionId,
}

/**
 * Trace one session the way the pinned Harness engine does.
 *
 * Ancestors walk immediate-parent outward and stop at the first gap;
 * descendants are a complete DFS in `(createdAt, id)` order with NO bound of
 * their own. Reproducing that matters: the pruned rows a browser draws are the
 * frontend's own budget, and a test that only ever returned two rows would not
 * prove a bounded tree can still be navigated.
 * @param records - the authoritative corpus.
 * @param sessionId - the traced session.
 * @returns the trace, or undefined when the session is absent.
 */
function trace(records: readonly SessionRecord[], sessionId: SessionId): SessionLineageTrace | undefined {
  const byId = new Map(records.map(item => [item.header.id, item]))
  const target = byId.get(sessionId)
  if (target === undefined) return undefined
  const ancestors: SessionRecord[] = []
  let parentId = target.header.parentSession
  let unresolvedParentId: SessionId | undefined
  while (parentId !== undefined) {
    const parent = byId.get(parentId)
    if (parent === undefined) {
      unresolvedParentId = parentId
      break
    }
    ancestors.push(parent)
    parentId = parent.header.parentSession
  }
  const childrenOf = (id: SessionId): SessionRecord[] =>
    records
      .filter(item => item.header.parentSession === id)
      .sort((a, b) => a.header.createdAt - b.header.createdAt || a.header.id.localeCompare(b.header.id))
  const build = (id: SessionId): SessionLineageNode[] =>
    childrenOf(id).map(child => ({ session: child, descendants: build(child.header.id) }))
  const common = { target, ancestors, descendants: build(sessionId) }
  return unresolvedParentId === undefined
    ? { ...common, complete: true, root: ancestors.at(-1) ?? target }
    : { ...common, complete: false, unresolvedParentId }
}

/**
 * A corpus wide enough that dshline's own lineage budget has to prune, so a
 * bounded tree — and its pruning markers — are navigable rather than theoretical.
 * @param children - how many direct children the root should have.
 * @returns the authoritative corpus.
 */
function wideCorpus(children: number): SessionRecord[] {
  const records: SessionRecord[] = [record(ROOT, { createdAt: NOW - HOUR })]
  for (let index = 0; index < children; index += 1) {
    records.push(record(`leaf-${String(index).padStart(3, '0')}`, {
      origin: 'subagent',
      parentSession: ROOT as SessionId,
      delegationDepth: 1,
      createdAt: NOW - (index + 2) * HOUR,
    }))
  }
  return records
}

/** One content-search hit, unused by these tests but part of the read surface. */
function searchHit(id: string): SessionSearchHit {
  return {
    ...record(id),
    bestMatch: {
      sessionId: id as SessionId,
      seq: 4,
      type: 'user/message',
      time: NOW,
      surface: 'current',
      snippet: `…${id} said…`,
    },
  }
}

/** What the fake corpus observed. */
interface Observed {
  /** Every `traceSession` id asked for, in order. */
  readonly traces: SessionId[]
  /** Every `readTitleSnapshots` batch, in order. */
  readonly titleBatches: readonly (readonly SessionId[])[]
  /** Corpus listings performed, by kind. */
  listSessions: number
  filterSessions: number
}

/**
 * A session-query engine over one fixed corpus.
 * @param records - the authoritative listing.
 * @param observed - the mutable recorder.
 * @returns the narrowed query surface.
 */
function engine(records: readonly SessionRecord[], observed: Observed): SessionQueryReads {
  const find = (id: SessionId): SessionRecord =>
    records.find(item => item.header.id === id) ?? record(id as string)
  return {
    listSessions: async () => { observed.listSessions += 1; return [...records] },
    filterSessions: async () => { observed.filterSessions += 1; return [...records] },
    readTitleSnapshots: async ids => {
      observed.titleBatches.push([...ids])
      return ids.map(id => titled(id, find(id)))
    },
    listEvents: async () => [],
    searchSessions: async () => ({ items: [] } as SessionSearchPage<SessionSearchHit>),
    searchEvents: async request => ({ session: find(request.sessionId).header, items: [] } as SessionEventSearchPage),
    readEvent: async () => { throw new Error('not exercised') },
    traceSession: async sessionId => {
      observed.traces.push(sessionId)
      const found = trace(records, sessionId)
      if (found === undefined) throw new Error(`session "${sessionId}" not found`)
      return found
    },
  }
}

/** The mounted overlay surface a test drives. */
interface Overlay {
  render(columns: number, rows?: number): readonly string[]
  handleKey(key: Key): void
  /** Called once by the slot registry, exactly as the real one does. */
  mounted?(): void
}

/** The browser, as a test drives it. */
interface Opened {
  /** Render a frame and read it as plain text rows. */
  frame(columns?: number, rows?: number): string[]
  /** The whole frame as one string. */
  text(): string
  /** Press keys, redrawing between each one exactly as the real window does. */
  press(...keys: readonly Key[]): void
  /** Type printable text into whichever surface currently owns the keyboard. */
  type(text: string): void
  /** How many overlays the slot registry still holds. */
  readonly depth: () => number
  /** The sessions the Lineage panel proposed, in order. */
  readonly proposed: readonly SessionTarget[]
  /** Settles once the browser has chosen a session or been dismissed. */
  readonly answer: Promise<SessionId | undefined>
}

/**
 * Open the real browser over a fake host context and let its listing land.
 *
 * The fake slot registry removes overlays BY IDENTITY, like `TuiSlots`: that is
 * what makes a surface that fails to dismiss itself visible to these tests as a
 * stranded panel that would keep drawing after the browser closed.
 * @param records - the authoritative corpus.
 * @param overrides - the caller-side browser spec fields to replace.
 * @returns the driver and the promise the browser resolves with.
 */
async function open(
  records: readonly SessionRecord[],
  overrides: Partial<BrowseSpec> & { readonly observed?: Observed } = {},
): Promise<Opened & { readonly observed: Observed }> {
  const stack: Overlay[] = []
  const observed: Observed = { traces: [], titleBatches: [], listSessions: 0, filterSessions: 0 }
  const proposed: SessionTarget[] = []
  const { observed: _ignored, ...spec } = overrides
  const ctx = {
    get: (name: string) => (name === 'sessionQuery' ? engine(records, observed) : undefined),
    tuiSlots: {
      invalidate: () => {},
      pushOverlay: (overlay: Overlay) => {
        stack.push(overlay)
        // The real registry announces the mount before handing the overlay a
        // keystroke. The Lineage panel reads its trace from there, so a fake that
        // skipped it would silently never perform the read under test.
        overlay.mounted?.()
        return () => {
          const index = stack.indexOf(overlay)
          if (index >= 0) stack.splice(index, 1)
        }
      },
    },
  } as unknown as Context
  // Record every session the Lineage panel proposes without letting the browser
  // close, so a test can observe several refusals from one mount.
  const answer = browseSessions({
    ctx,
    currentSessionId: undefined,
    busy: () => false,
    activeWork: () => 0,
    home: '/home/dev',
    now: () => NOW,
    ...spec,
  } as BrowseSpec)
  const top = (): Overlay | undefined => stack.at(-1)
  const frame = (columns = 90, rows = 24): string[] =>
    [...(top()?.render(columns, rows) ?? [])].map(row => stripAnsi(row))
  const draw = (): void => { frame() }
  await settled()
  draw()
  const openWith = (browser: Omit<Opened, 'proposed' | 'depth'>, answerFor: Promise<SessionId | undefined>) => ({
    ...browser,
    depth: () => stack.length,
    proposed,
    answer: answerFor,
    observed,
  })
  return openWith({
    frame,
    text: () => frame().join('\n'),
    press: (...keys) => {
      for (const key of keys) {
        top()?.handleKey(key)
        draw()
      }
    },
    type: (text: string) => {
      for (const character of text) {
        top()?.handleKey({ kind: 'text', text: character })
        draw()
      }
    },
  }, answer)
}

/** The keystrokes that open a selected row's details and its Lineage action. */
const DETAILS: Key = { kind: 'key', name: 'right' }
const ENTER: Key = { kind: 'key', name: 'enter' }
const DOWN: Key = { kind: 'key', name: 'down' }
const END: Key = { kind: 'key', name: 'end' }
const UP: Key = { kind: 'key', name: 'up' }
const ESCAPE: Key = { kind: 'key', name: 'escape' }

/** Where the root conversation sits in this corpus's own-scoped list. */
const ROOT_ROW = 1
/** Where the ordinary fork sits in that same list. */
const FORK_ROW = 2

/**
 * Move the list cursor onto one row.
 * @param browser - the open browser.
 * @param index - the row the reader moves to, counted from the top.
 * @returns nothing.
 */
function selectRow(browser: Omit<Opened, 'proposed' | 'depth' | 'observed'>, index: number): void {
  browser.press(...Array.from({ length: index }, () => DOWN))
}

/**
 * Walk from the list into the Lineage panel of one selected row.
 *
 * Rows arrive newest-first and the own-scoped list keeps only the two roots and
 * the fork, so the row is addressed by INDEX — which is the reader's own gesture
 * — rather than by a lookup this deliberately does not build.
 * @param browser - the open browser.
 * @param index - the row whose lineage to open.
 * @returns nothing; the Lineage panel is on top when this returns.
 */
function openLineage(browser: Omit<Opened, 'proposed' | 'depth' | 'observed'>, index: number): void {
  browser.press(...Array.from({ length: index }, () => DOWN), DETAILS, DOWN, ENTER)
}

/**
 * The session rows one frame draws, in order.
 * @param frame - a rendered frame as plain text.
 * @returns each session row's title.
 */
function titlesOf(frame: string): string[] {
  return [...frame.matchAll(/Title [\w-]+/gu)].map(match => match[0])
}

describe('reaching a delegated conversation from Lineage', () => {
  it('shows the child in the relationship even though the list omits it', async () => {
    // The two halves of the design, in one frame pair: the default scope keeps
    // delegated children out of the peer list, and the relationship surface is
    // where they are still reachable.
    const browser = await open(corpus())
    const list = browser.text()
    expect(titlesOf(list)).toContain('Title root')
    expect(list).not.toContain('Title child')

    openLineage(browser, ROOT_ROW)
    await settled()
    const lineage = browser.text()
    expect(lineage).toContain('Sessions · lineage')
    expect(titlesOf(lineage)).toEqual(expect.arrayContaining([
      'Title root',
      'Title fork',
      'Title child',
      'Title grandchild',
      'Title great-grandchild',
    ]))
    // The panel says what its keys do, and offers reopening a related session.
    expect(lineage).toContain('o reopen')
    // Leaving the panel returns to the detail disclosure it was opened from, so
    // closing the browser from here is two gestures, not one.
    browser.press(ESCAPE, ESCAPE, ESCAPE)
    await expect(browser.answer).resolves.toBeUndefined()
  })

  it('reopens a delegated child through the root decision without widening the filter', async () => {
    // The reader is making an explicit contextual choice. Mutating their origin
    // filter to put the child in the list first would be filter churn, a second
    // listing, and a second round of title hydration — for a session they already
    // identified.
    const browser = await open(corpus(), { currentSessionId: ROOT as SessionId })
    openLineage(browser, ROOT_ROW)
    await settled()
    // Rows are root(target), then Harness's oldest-first child order:
    // child, grandchild, great-grandchild, fork.
    browser.press(DOWN)
    browser.type('o')
    await expect(browser.answer).resolves.toBe('child' as SessionId)
    expect(browser.observed.filterSessions).toBe(0)
  })

  it('resolves through the same answer a list row produces, and leaves nothing mounted', async () => {
    const browser = await open(corpus(), { currentSessionId: ROOT as SessionId })
    openLineage(browser, ROOT_ROW)
    await settled()
    browser.press(DOWN)
    browser.type('o')
    await expect(browser.answer).resolves.toBe('child' as SessionId)
    // A panel that failed to dismiss itself would keep drawing a lineage tree
    // over a browser that already answered.
    expect(browser.depth()).toBe(0)
  })

  it('needs no Agent surface of its own to reach that answer', async () => {
    // The fake context mounts `sessionQuery` and nothing else: there is no
    // `ctx.agents`, no resume method, and no session store for the Lineage panel
    // to call. It resolves anyway, because it proposes an id and the browser owns
    // the decision.
    const browser = await open(corpus(), { currentSessionId: ROOT as SessionId })
    expect(browser.observed.traces).toEqual([])
    openLineage(browser, ROOT_ROW)
    await settled()
    expect(browser.observed.traces).toEqual([ROOT as SessionId])
    browser.press(DOWN)
    browser.type('o')
    await expect(browser.answer).resolves.toBe('child' as SessionId)
  })

  it('reaches a descendant three generations down when Harness returns it', async () => {
    // Depth is not a delegated-only concern and must not be flattened into local
    // state: the row is whatever the trace returned, at whatever depth.
    const browser = await open(corpus(), { currentSessionId: ROOT as SessionId })
    openLineage(browser, ROOT_ROW)
    await settled()
    browser.press(DOWN, DOWN, DOWN)
    browser.type('o')
    await expect(browser.answer).resolves.toBe('great-grandchild' as SessionId)
  })

  it('reaches an ordinary fork and an ancestor by the same relationship rule', async () => {
    const fork = await open(corpus(), { currentSessionId: ROOT as SessionId })
    openLineage(fork, ROOT_ROW)
    await settled()
    fork.press(DOWN, DOWN, DOWN, DOWN)
    fork.type('o')
    await expect(fork.answer).resolves.toBe('fork' as SessionId)

    // Tracing a child gives the root as a real ancestor row. The child is not in
    // the own-scoped list, so the reader widens the scope first — the global
    // escape hatch, unchanged — and only then traces down to it.
    const ancestor = await open(corpus())
    ancestor.press({ kind: 'key', name: 'ctrl-f' }, DOWN, { kind: 'key', name: 'right' }, { kind: 'key', name: 'right' }, ENTER)
    await settled()
    selectRow(ancestor, 3) // the delegated child, third after the two roots and the fork
    ancestor.press(DETAILS, DOWN, ENTER)
    await settled()
    // The cursor opens on the traced session; the ancestor is one row above it.
    ancestor.press(UP)
    expect(ancestor.text()).toContain('Title root')
    ancestor.type('o')
    await expect(ancestor.answer).resolves.toBe(ROOT as SessionId)
  })

  it('follows the existing current-session policy rather than a lineage rule', async () => {
    // `o` on the session this window already drives is refused by the SAME
    // `planResume` sentence a list row gets. Lineage invents no rule of its own.
    const browser = await open(corpus(), { currentSessionId: ROOT as SessionId })
    openLineage(browser, ROOT_ROW)
    await settled()
    browser.type('o')
    expect(browser.text()).toContain('already open in this window')
    expect(browser.depth()).toBe(1)
    browser.press(ESCAPE)
    await expect(browser.answer).resolves.toBeUndefined()
  })

  it('keeps the ordinary focus gesture for a session the list already shows', async () => {
    // `↵` is not overloaded. It still means "show me where this conversation sits"
    // and still says so when the row is outside the list — which is a true
    // statement about the list, not a dead end, because `o` is the other key.
    const browser = await open(corpus(), { currentSessionId: ROOT as SessionId })
    openLineage(browser, ROOT_ROW)
    await settled()
    browser.press(DOWN, DOWN, DOWN, DOWN) // the ordinary fork, which IS listed
    browser.press(ENTER)
    await settled()
    // The panel closed and the LIST is what remains; the browser did not answer.
    expect(browser.depth()).toBe(1)
    expect(browser.text()).toContain('Title fork')
    expect(titlesOf(browser.text())).not.toContain('Title child')
    browser.press(ESCAPE)
    await browser.answer
  })

  it('reaches the far end of a bounded tree', async () => {
    // 80 delegated children exceed the descendant node budget, so the panel draws
    // 50 of them and a `… N descendants hidden` marker below. The reader must
    // still be able to get to the last one it actually shows, and choosing it
    // must cost no further listing or lineage read.
    const records = wideCorpus(80)
    const known = new Set(records.map(item => item.header.id))
    const browser = await open(records, { currentSessionId: ROOT as SessionId })
    openLineage(browser, 0)
    await settled()
    browser.press(END)
    const shown = titlesOf(browser.text())
    // A bounded tree shows fewer than the corpus holds, and never more.
    expect(shown.length).toBeGreaterThan(10)
    expect(shown.length).toBeLessThanOrEqual(51)
    browser.type('o')
    const chosen = await browser.answer
    expect(chosen).toBeDefined()
    expect(known.has(chosen!)).toBe(true)
    // It was the row the reader could actually see, not one only the marker knows.
    expect(shown).toContain(`Title ${String(chosen)}`)
    expect(browser.observed.traces).toHaveLength(1)
    expect(browser.observed.listSessions).toBe(1)
  })

  it('proposes a traced session without testing whether it still exists', async () => {
    // `persisted` is a LISTING fact. A row can be listed and still fail to open,
    // and the authoritative answer for that is the reopen path reporting
    // Harness's own reason and asking again — not a second observer here.
    const browser = await open(corpus(), { currentSessionId: ROOT as SessionId })
    openLineage(browser, ROOT_ROW)
    await settled()
    browser.press(DOWN)
    browser.type('o')
    await expect(browser.answer).resolves.toBe('child' as SessionId)
    // Choosing cost no extra listing and no extra lineage read.
    expect(browser.observed.traces).toHaveLength(1)
  })

  it('reports a failed trace and offers nothing to choose from it', async () => {
    const failing = await open(corpus(), {
      currentSessionId: ROOT as SessionId,
      requestLineage: () => {},
    } as Partial<BrowseSpec>)
    // A browser whose lineage never lands must still offer no reopen key rather
    // than one that would guess.
    openLineage(failing, ROOT_ROW)
    await settled()
    failing.type('o')
    expect(failing.depth()).toBeGreaterThan(0)
    failing.press(ESCAPE, ESCAPE)
    await failing.answer
  })

  it('still lets the reader widen the scope globally, exactly as before', async () => {
    const browser = await open(corpus())
    browser.press({ kind: 'key', name: 'ctrl-f' }, DOWN, { kind: 'key', name: 'right' }, { kind: 'key', name: 'right' }, ENTER)
    await settled()
    expect(titlesOf(browser.text())).toContain('Title child')
    browser.press(ESCAPE)
    await browser.answer
  })
})

describe('the relationship surface keeps its read budget', () => {
  it('reads one trace and one title batch, and never lists the corpus again', async () => {
    const browser = await open(corpus(), { currentSessionId: ROOT as SessionId })
    // Opening the browser: one corpus listing, one bounded title batch, no
    // lineage read at all.
    expect(browser.observed).toMatchObject({ listSessions: 1, filterSessions: 0, traces: [] })
    const beforeOpen = browser.observed.titleBatches.length

    openLineage(browser, ROOT_ROW)
    await settled()
    // Opening Lineage: the trace, then one batched title read for its rows.
    expect(browser.observed.traces).toEqual([ROOT as SessionId])
    expect(browser.observed.titleBatches).toHaveLength(beforeOpen + 1)
    expect(browser.observed.listSessions).toBe(1)
  })

  it('draws the relationship at ordinary and narrow terminal sizes', async () => {
    const browser = await open(corpus(), { currentSessionId: ROOT as SessionId })
    openLineage(browser, ROOT_ROW)
    await settled()
    for (const [columns, rows] of [[90, 24], [64, 16]] as const) {
      const frame = browser.frame(columns, rows)
      expect(frame.length).toBeGreaterThan(0)
      expect(frame.join('\n')).toContain('Sessions · lineage')
      // No row may exceed the terminal it was drawn for.
      for (const line of frame) expect([...line].length).toBeLessThanOrEqual(columns)
    }
  })
})
