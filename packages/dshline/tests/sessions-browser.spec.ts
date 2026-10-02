/**
 * What the Sessions browser shows before the reader has chosen anything.
 *
 * The catalog tests pin how a filter VALUE behaves once one exists. This file
 * pins the value the browser starts with, because that is a decision a human
 * inherits rather than makes: `browseSessions` opens the human picker with the
 * conversations a person started, and the reader widens from there.
 *
 * Everything below drives the real composition root over the real catalog and
 * the real overlay, so the assertion is the rows a reader would see rather than
 * the constant that produced them.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventSearchPage,
  SessionRecord,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
  SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import type { SessionQueryReads } from '../src/sessions/catalog.ts'
import { DEFAULT_SESSION_FILTERS, NO_FILTERS } from '../src/sessions/filters.ts'
import { browseSessions, type BrowseSpec } from '../src/sessions/index.ts'

/** Let the catalog's own awaits settle before reading its state. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
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
 * A fulfilled title observation.
 *
 * The observation carries the session's OWN header, because that is what the
 * pinned title read returns and what `classifyOrigin` treats as authoritative:
 * a content hit whose header omitted `origin` still recovers it from here.
 * @param id - the session id.
 * @param source - the record whose header the observation folds from.
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

/** The session whose log holds the only content match in this corpus. */
const ONLY_MATCH = 'child'

/**
 * One root, one ordinary fork, one delegated child, one delegated grandchild.
 * @returns the authoritative corpus, newest first.
 */
function corpus(): SessionRecord[] {
  return [
    record('root', { createdAt: NOW - HOUR }),
    record('fork', { parentSession: 'root' as SessionId, isSeeded: true, createdAt: NOW - 2 * HOUR }),
    record('child', { origin: 'subagent', parentSession: 'root' as SessionId, delegationDepth: 1, createdAt: NOW - 3 * HOUR }),
    record('grandchild', {
      origin: 'subagent',
      parentSession: 'child' as SessionId,
      delegationDepth: 2,
      createdAt: NOW - 4 * HOUR,
    }),
  ]
}

/**
 * A session-query engine over one fixed corpus.
 *
 * The content-search hit is built from the SAME record the listing serves, so a
 * delegated session is delegated on both paths — a hit projection that invented
 * its own `own` header would be testing the fixture rather than the scope.
 * @param records - the authoritative listing.
 * @returns the narrowed query surface.
 */
function engine(records: readonly SessionRecord[]): SessionQueryReads {
  const hit: SessionSearchHit = {
    ...(records.find(item => item.header.id === ONLY_MATCH) ?? record(ONLY_MATCH)),
    bestMatch: {
      sessionId: ONLY_MATCH as SessionId,
      seq: 4,
      type: 'user/message',
      time: NOW,
      surface: 'current',
      snippet: '…the one sentence only a child said…',
    },
  }
  return {
    listSessions: async () => [...records],
    filterSessions: async () => [...records],
    readTitleSnapshots: async ids => ids.map(id =>
      titled(id, records.find(item => item.header.id === id) ?? record(id as string))),
    listEvents: async () => [],
    searchSessions: async (request: SessionSearchRequest) =>
      ({ items: [hit] } as SessionSearchPage<SessionSearchHit>),
    searchEvents: async request => ({
      session: header(request.sessionId),
      items: [],
    } as SessionEventSearchPage),
    readEvent: async () => { throw new Error('not exercised') },
    traceSession: async sessionId => ({
      target: record(sessionId as string),
      ancestors: [],
      descendants: [],
      complete: true,
      root: record(sessionId as string),
    }),
  }
}

/** The mounted overlay surface a test drives. */
interface Overlay {
  render(columns: number, rows?: number): readonly string[]
  handleKey(key: Key): void
}

/** The browser, as a test drives it. */
interface Opened {
  /** Render a frame and read it as plain text rows. */
  frame(columns?: number, rows?: number): string[]
  /** Press keys, redrawing between each one exactly as the real window does. */
  press(...keys: readonly Key[]): void
  /** Type printable text into the local query line. */
  type(text: string): void
  /** The whole frame as one string. */
  text(): string
  /** Settles once the browser has chosen a session or been dismissed. */
  readonly answer: Promise<SessionId | undefined>
}

/**
 * Open the real browser over a fake host context and let its listing land.
 *
 * The fake slot registry is a STACK, because the browser is not one surface:
 * `ctrl-f` pushes the filter panel and `tab` reaches the child panels, and a
 * test that only ever saw the root would be testing a browser that cannot open
 * anything.
 * @param records - the authoritative corpus.
 * @param overrides - the caller-side browser spec fields to replace.
 * @returns the driver and the promise the browser resolves with.
 */
async function open(
  records: readonly SessionRecord[],
  overrides: Partial<BrowseSpec> = {},
): Promise<Opened> {
  const stack: Overlay[] = []
  const ctx = {
    get: (name: string) => (name === 'sessionQuery' ? engine(records) : undefined),
    tuiSlots: {
      invalidate: () => {},
      pushOverlay: (overlay: Overlay) => {
        stack.push(overlay)
        return () => {
          const index = stack.indexOf(overlay)
          if (index >= 0) stack.splice(index, 1)
        }
      },
    },
  } as unknown as Context
  const answer = browseSessions({
    ctx,
    currentSessionId: undefined,
    busy: () => false,
    activeWork: () => 0,
    home: '/home/dev',
    now: () => NOW,
    ...overrides,
  })
  const top = (): Overlay | undefined => stack.at(-1)
  const frame = (columns = 90, rows = 24): string[] =>
    [...(top()?.render(columns, rows) ?? [])].map(row => stripAnsi(row))
  const draw = (): void => { frame() }
  await settled()
  draw()
  return {
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
    answer,
  }
}

/** `down`, `up`, `enter`, `tab`, `ctrl-f`, `escape` as the overlay decodes them. */
const DOWN: Key = { kind: 'key', name: 'down' }
const ENTER: Key = { kind: 'key', name: 'enter' }
const TAB: Key = { kind: 'key', name: 'tab' }
const CTRL_F: Key = { kind: 'key', name: 'ctrl-f' }
const ESCAPE: Key = { kind: 'key', name: 'escape' }
/** Open the filter panel, move to Origin, and cycle it two steps to `all`. */
const WIDEN_TO_ALL: readonly Key[] = [CTRL_F, DOWN, { kind: 'key', name: 'right' }, { kind: 'key', name: 'right' }, ENTER]

/**
 * The session rows one frame draws, in order.
 *
 * Read from the titles rather than from the whole frame: a frame carries the
 * chrome, the counter and the footer too, and comparing those would assert
 * that two browsers are literally the same surface rather than that they
 * answer the same question.
 * @param frame - the rendered frame, as plain text rows.
 * @returns each session row's title.
 */
function titlesOf(frame: string): string[] {
  return [...frame.matchAll(/Title [\w-]+/gu)].map(match => match[0])
}

describe('the scope the Sessions browser opens with', () => {
  it('shows the conversations a person started and not the delegated children', async () => {
    // An ordinary fork is a conversation the reader started, so it stays; only
    // `origin: 'subagent'` is the navigation classification, and a recorded
    // parent alone never makes a row delegated.
    const browser = await open(corpus())
    const text = browser.text()
    expect(text).toContain('Title root')
    expect(text).toContain('Title fork')
    expect(text).not.toContain('Title child')
    expect(text).not.toContain('Title grandchild')
    // The scope in effect is stated, so a reader who expected the whole corpus
    // is told where the rest went instead of guessing.
    expect(text).toContain('filtered')
    browser.press(ESCAPE)
    await expect(browser.answer).resolves.toBeUndefined()
  })

  it('reaches every delegated child, at any depth, through the origin filter', async () => {
    // The default is a scope the reader widens, not a hiding rule. Four
    // keystrokes and the whole Harness corpus is back, in Harness order.
    const browser = await open(corpus())
    browser.press(...WIDEN_TO_ALL)
    await settled()
    const text = browser.text()
    expect(text).toContain('Title child')
    expect(text).toContain('Title grandchild')
    browser.press(ESCAPE)
    await browser.answer
  })

  it('opens the filter panel on the value actually in force', async () => {
    // Cycling from a neutral default would make the reader discover the scope
    // by accident; the panel has to start where the list already is.
    const browser = await open(corpus())
    browser.press(CTRL_F)
    const panel = browser.text()
    expect(panel).toContain('Sessions · filters')
    expect(panel).toMatch(/Origin · own/u)
    browser.press(ESCAPE, ESCAPE)
    await browser.answer
  })

  it('opens the same way at launch, where there is no current session to keep', async () => {
    // `--resume` with no id and in-session `/sessions` are the same browser by
    // design, so they must not disagree about what a session list contains.
    const launched = await open(corpus())
    const inside = await open(corpus(), { currentSessionId: 'root' as SessionId })
    // The same conversations, in the same order, at launch and in-session. The
    // `open` badge is the only difference, and it exists because at launch no
    // session is open for anybody.
    expect(titlesOf(inside.text())).toEqual(titlesOf(launched.text()))
    expect(titlesOf(launched.text())).toEqual(['Title root', 'Title fork'])
    expect(inside.text()).toContain('open ·')
    expect(launched.text()).not.toContain('open · 1h ago')
    launched.press(ESCAPE)
    inside.press(ESCAPE)
    await Promise.all([launched.answer, inside.answer])
  })

  it('still resumes whichever scoped row the reader chooses', async () => {
    // A narrower default is only safe if the rows it keeps are fully usable.
    const browser = await open(corpus(), { currentSessionId: 'root' as SessionId })
    browser.press(DOWN, ENTER)
    await expect(browser.answer).resolves.toBe('fork' as SessionId)
  })

  it('never reinterprets NO_FILTERS, which another surface genuinely means', async () => {
    // `/worktrees` mounts the same catalog and really does want every session.
    // A default written into the filter vocabulary instead of the composition
    // root would silently cost that surface its delegated rows too.
    expect(DEFAULT_SESSION_FILTERS.origin).toBe('own')
    expect(DEFAULT_SESSION_FILTERS.workspace).toBe(NO_FILTERS.workspace)
    expect(DEFAULT_SESSION_FILTERS.age).toBe(NO_FILTERS.age)
    expect(NO_FILTERS.origin).toBe('all')
    expect(DEFAULT_SESSION_FILTERS).not.toEqual(NO_FILTERS)
  })
})

describe('content search under the human default', () => {
  it('withholds a delegated-only match and says the filters dropped it', async () => {
    // The honest case matters more than the narrowing: Harness returned a real
    // hit, and the sentence must not claim nothing matches anywhere.
    const browser = await open(corpus())
    browser.type('needle')
    browser.press(TAB)
    await settled()
    const text = browser.text()
    expect(text).not.toContain('the one sentence only a child said')
    expect(text).toContain('No returned results match the active filters')
    // In content mode `esc` clears the query first and only then leaves.
    browser.press(ESCAPE, ESCAPE)
    await browser.answer
  })

  it('shows the same match, with Harness’s excerpt, once the reader widens', async () => {
    const browser = await open(corpus())
    browser.press(...WIDEN_TO_ALL)
    await settled()
    browser.type('needle')
    browser.press(TAB)
    await settled()
    const text = browser.text()
    expect(text).toContain('the one sentence only a child said')
    // The scope narrows what is shown; it never re-ranks a hit or rewrites the
    // evidence Harness attached to it.
    expect(text).toContain('1 result')
    browser.press(ESCAPE, ESCAPE)
    await browser.answer
  })
})