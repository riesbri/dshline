/**
 * `/session` through the real attachment.
 *
 * The hub's claims are about authority and laziness, and neither is reachable
 * from a unit: which exact Session object it identifies, that opening it reads
 * no corpus, that Find/Lineage only query once a person activates them, and
 * that Rename goes through `ctx.sessionTitle` on the attached live Session.
 * This assembles the same fixture shape as `context-attachment.spec.ts` — a
 * real cordis Context, the real `TuiSlots` registry, a fake window that
 * composes exactly as the production scheduler does — and drives every claim
 * through the real composer.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context as RealContext } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/** The projection cut the fixture's registry serves: stats and an empty outline. */
const CUT: ProjectionSnapshot = {
  asOfSeq: 4,
  values: {
    // `turns`/`steps` are the only fields the hub reads; the rest of the unit's
    // shape is irrelevant to a presentation test.
    sessionStats: { turns: 7, steps: 12 } as never,
    turnOutline: [],
  },
}

/** The query spies and title authority the attachment consumes. */
interface HubFixture {
  readonly dispatch: () => ((key: Key) => void) | undefined
  readonly session: Session
  readonly commands: { readonly execute: ReturnType<typeof vi.fn> }
  readonly query: {
    readonly listSessions: ReturnType<typeof vi.fn>
    readonly filterSessions: ReturnType<typeof vi.fn>
    readonly readTitleSnapshots: ReturnType<typeof vi.fn>
    readonly searchSessions: ReturnType<typeof vi.fn>
    readonly listEvents: ReturnType<typeof vi.fn>
    readonly readSession: ReturnType<typeof vi.fn>
    readonly readSurface: ReturnType<typeof vi.fn>
    readonly searchEvents: ReturnType<typeof vi.fn>
    readonly readEvent: ReturnType<typeof vi.fn>
    readonly traceSession: ReturnType<typeof vi.fn>
  }
  readonly titleService: {
    readonly get: ReturnType<typeof vi.fn>
    readonly rename: ReturnType<typeof vi.fn>
    current: () => string | undefined
  }
  readonly commits: string[][]
  readonly frames: Array<{ lines: string[] }>
  readonly draw: () => void
}

/** One search hit page for the fixture's session. */
function hitPage(sessionId: string, seq: number) {
  return {
    session: { id: sessionId },
    items: [{ sessionId, seq, type: 'user/message', time: 1, surface: 'current', snippet: 'needle' }],
    nextCursor: undefined,
  }
}

/** The assembled attachment with every capability `/session` reads. */
async function fixture(options: {
  readonly titleService?: boolean
  readonly stats?: boolean
  readonly outline?: boolean
  readonly title?: string | null
  readonly harnessSession?: boolean
} = {}): Promise<HubFixture> {
  const ctx = new RealContext()
  await ctx.plugin(TuiSlots)
  ctx.provide('tools', { get: () => undefined })
  const harnessCommands = {
    execute: vi.fn(),
    list: () => options.harnessSession === true
      ? [{ name: 'session', description: 'Harness session command' }]
      : [],
  }
  ctx.provide('commands', harnessCommands as never)
  ctx.provide('userQuestions', {} as never)
  ctx.provide('sessionProjections', {
    snapshot: () => {
      if (options.stats === false) return { asOfSeq: 0, values: { turnOutline: [] } }
      if (options.outline === false) return { asOfSeq: 0, values: {} }
      return CUT
    },
    onChanged: () => () => {},
  } as never)

  const query = {
    listSessions: vi.fn(async () => []),
    filterSessions: vi.fn(async () => []),
    readTitleSnapshots: vi.fn(async () => []),
    searchSessions: vi.fn(async () => ({ hits: [], nextCursor: undefined })),
    listEvents: vi.fn(async () => []),
    readSession: vi.fn(async () => ({ events: [] })),
    readSurface: vi.fn(async () => ({ nodes: [] })),
    searchEvents: vi.fn(async () => hitPage('s-1', 3)),
    readEvent: vi.fn(async () => ({ target: { seq: 3 }, before: [], after: [] })),
    traceSession: vi.fn(async () => ({
      target: { header: { id: 's-1' } }, ancestors: [], descendants: [], complete: true, root: { header: { id: 's-1' } },
    })),
  }
  ctx.provide('sessionQuery', query as never)

  // `null` is the explicit "no folded title yet" fixture; omitting it keeps the
  // ordinary titled session.
  let title: string | undefined = options.title === null ? undefined : (options.title ?? 'Fix OAuth flow')
  const titleService = {
    get: vi.fn(() => title === undefined ? undefined : { title }),
    rename: vi.fn((_session: Session, draft: string) => {
      title = draft.trim().replace(/\s+/gu, ' ')
      return { title }
    }),
    current: () => title,
  }
  if (options.titleService !== false) ctx.provide('sessionTitle', titleService as never)

  const commits: string[][] = []
  const frames: Array<{ lines: string[] }> = []
  let dispatch: ((key: Key) => void) | undefined
  const compose = (): void => { frames.push(ctx.tuiSlots.compose(80, 40)) }
  const events: SessionEvent[] = []
  const session = {
    id: 's-1',
    header: {
      id: 's-1',
      cwd: '/ws',
      createdAt: Date.now() - 18 * 60 * 1_000,
      agentPreset: 'standard',
      parentSession: 'parent-8c2f',
    },
    seq: events.length,
    eventAt: (seq: number) => events[seq],
    surface: { nodes: [], replaceGeneration: 0 },
  } as unknown as Session

  const window = {
    ctx,
    terminal: { columns: () => 80, rows: () => 40 },
    exit: undefined,
    startup: { cwd: '/startup-must-not-leak', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    modelInfo: { contextWindow: 1_000_000, reasoning: undefined },
    modelCompletionValues: () => Promise.resolve([]),
    prefs: { usageMode: 'cost', timing: false, cardDetail: 'compact' },
    colorDepth: 0,
    palette: () => ({}),
    setPalette: () => {},
    themeSettings: {},
    pendingTask: undefined,
    draw: compose,
    paintNow: compose,
    commit: (lines: readonly string[]) => { commits.push([...lines]) },
    clear: () => {},
    refreshModelInfo: () => {},
    setDispatch: (handler?: (key: Key) => void) => { dispatch = handler },
    setExit: () => {},
  } as unknown as Window

  const agent = {
    session,
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
  const outcome = {
    target: { kind: 'new', cwd: '/ws' },
    attached: { handle: { agent, dispose: async () => {} }, reopened: false },
  } as unknown as AttachOutcome

  void attachSession(window, outcome)
  return {
    dispatch: () => dispatch,
    session,
    commands: harnessCommands,
    query,
    titleService,
    commits,
    frames,
    draw: compose,
  }
}

/** Let queued promises flush without waiting time. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

/** The latest composed frame, as a person would read it. */
function latest(frames: Array<{ lines: string[] }>): string {
  return stripAnsi((frames.at(-1)?.lines ?? []).join('\n'))
}

/** Submit one line through the real composer. */
function submit(dispatch: ((key: Key) => void) | undefined, line: string): void {
  expect(dispatch, 'the window must be routing input').toBeDefined()
  for (const char of [...line]) dispatch?.({ kind: 'text', text: char })
  dispatch?.({ kind: 'key', name: 'enter' })
}

/** Every session-query spy, for the zero-read assertion. */
function querySpies(fixtureValue: HubFixture): ReturnType<typeof vi.fn>[] {
  const { query } = fixtureValue
  return [
    query.listSessions,
    query.filterSessions,
    query.readTitleSnapshots,
    query.searchSessions,
    query.listEvents,
    query.readSession,
    query.readSurface,
    query.searchEvents,
    query.readEvent,
    query.traceSession,
  ]
}

describe('/session identity, facts, and laziness', () => {
  it('paints the attached session from its header and title with zero query reads', async () => {
    const f = await fixture()
    await flush()
    submit(f.dispatch(), '/session')
    await flush()
    f.draw()

    const body = latest(f.frames)
    expect(body).toContain('Fix OAuth flow')
    expect(body).toContain('/ws')
    expect(body).toContain('standard')
    expect(body).toContain('7 turns · 12 steps')
    expect(body).toContain('parent-8c2f')
    expect(body).toContain('s-1')
    // Opening the hub is a pure presentation read: no corpus lookup, no trace,
    // no event history of any kind.
    expect(querySpies(f).every(spy => spy.mock.calls.length === 0)).toBe(true)
  })

  it('never substitutes the startup cwd when the header records none', async () => {
    const f = await fixture()
    await flush()
    // Rewrite the header to the cwd-less legacy shape the fallback exists for.
    ;(f.session as unknown as { header: Record<string, unknown> }).header.cwd = undefined
    submit(f.dispatch(), '/session')
    await flush()
    f.draw()
    expect(latest(f.frames)).not.toContain('startup-must-not-leak')
  })

  it('reports a usage error for a leftover argument instead of swallowing it', async () => {
    const f = await fixture()
    await flush()
    submit(f.dispatch(), '/session anything')
    await flush()
    expect(f.commits.flat().join('\n')).toContain('usage: /session')
    expect(latest(f.frames)).not.toContain('Find in conversation')
  })

  it('shows no activity row when sessionStats is not registered', async () => {
    const f = await fixture({ stats: false })
    await flush()
    submit(f.dispatch(), '/session')
    await flush()
    f.draw()
    const body = latest(f.frames)
    expect(body).not.toContain('Activity')
    expect(body).not.toContain('7 turns')
    // A missing projection key is an absence, never a frontend recount.
    expect(body).toContain('Session      s-1')
  })

  it('degrades to a presentation-only fallback when the session has no title', async () => {
    const f = await fixture({ title: null })
    await flush()
    submit(f.dispatch(), '/session')
    await flush()
    f.draw()
    expect(latest(f.frames)).toContain('Current session')
    expect(latest(f.frames)).toContain('Find in conversation')
  })

  it('offers /session in the slash completion list', async () => {
    const f = await fixture()
    await flush()
    for (const char of [...'/sess']) f.dispatch()?.({ kind: 'text', text: char })
    await flush()
    f.draw()
    expect(latest(f.frames)).toContain('session')
  })

  it('writes nothing into committed scrollback while opening and closing', async () => {
    const f = await fixture()
    await flush()
    const before = f.commits.flat().join('\n')
    submit(f.dispatch(), '/session')
    await flush()
    f.dispatch()?.({ kind: 'key', name: 'escape' })
    await flush()
    expect(f.commits.flat().join('\n')).toBe(before)
  })

  it('aborts in-flight Find work when the hub closes', async () => {
    const f = await fixture()
    await flush()
    let signal: AbortSignal | undefined
    f.query.searchEvents.mockImplementation(async (_request: unknown, exec?: { signal?: AbortSignal }) => {
      signal = exec?.signal
      // Never settles: only the hub's own close can end this read.
      return new Promise(() => {})
    })
    submit(f.dispatch(), '/session')
    await flush()
    f.dispatch()?.({ kind: 'text', text: 'f' })
    for (const char of [...'auth']) f.dispatch()?.({ kind: 'text', text: char })
    f.dispatch()?.({ kind: 'key', name: 'tab' })
    await flush()
    expect(signal?.aborted).toBe(false)
    // Escape clears the non-empty query, a second returns to the hub, and the
    // third closes it; the read belongs to the hub.
    f.dispatch()?.({ kind: 'key', name: 'escape' })
    f.dispatch()?.({ kind: 'key', name: 'escape' })
    f.dispatch()?.({ kind: 'key', name: 'escape' })
    await flush()
    expect(signal?.aborted).toBe(true)
  })
})

describe('/session actions', () => {
  it('opens the shared Turns presenter from `t` without reading the corpus', async () => {
    const f = await fixture()
    await flush()
    submit(f.dispatch(), '/session')
    await flush()
    f.dispatch()?.({ kind: 'text', text: 't' })
    f.draw()
    expect(latest(f.frames)).toContain('Session outline')
    expect(querySpies(f).every(spy => spy.mock.calls.length === 0)).toBe(true)
  })

  it('searches only after the Find query is submitted, on the attached id', async () => {
    const f = await fixture()
    await flush()
    submit(f.dispatch(), '/session')
    await flush()
    f.dispatch()?.({ kind: 'text', text: 'f' })
    f.draw()
    // Opening the panel performs no search.
    expect(f.query.searchEvents).not.toHaveBeenCalled()

    for (const char of [...'auth']) f.dispatch()?.({ kind: 'text', text: char })
    // `tab` submits the event query, exactly as it does in `/sessions`.
    f.dispatch()?.({ kind: 'key', name: 'tab' })
    await flush()
    expect(f.query.searchEvents).toHaveBeenCalledTimes(1)
    expect(f.query.searchEvents.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's-1', query: 'auth' })
    // Listing a hit is not reading it.
    expect(f.query.readEvent).not.toHaveBeenCalled()

    f.draw()
    f.dispatch()?.({ kind: 'key', name: 'enter' })
    await flush()
    expect(f.query.readEvent).toHaveBeenCalledTimes(1)
    expect(f.query.readEvent.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's-1', seq: 3, before: 8, after: 8 })
  })

  it('traces Lineage only on activation, against the attached id', async () => {
    const f = await fixture()
    await flush()
    submit(f.dispatch(), '/session')
    await flush()
    expect(f.query.traceSession).not.toHaveBeenCalled()
    f.dispatch()?.({ kind: 'text', text: 'l' })
    await flush()
    expect(f.query.traceSession).toHaveBeenCalledTimes(1)
    expect(f.query.traceSession.mock.calls[0]?.[0]).toBe('s-1')
  })

  it('renames the exact attached session through ctx.sessionTitle and shows its title', async () => {
    const f = await fixture()
    await flush()
    submit(f.dispatch(), '/session')
    await flush()
    f.dispatch()?.({ kind: 'text', text: 'r' })
    await flush()
    // Clear the prefilled title, then submit a raw draft whose spacing only
    // Harness normalizes: the hub must show the accepted form, not this text.
    f.dispatch()?.({ kind: 'key', name: 'ctrl-u' })
    for (const char of [...'  New   Name  ']) f.dispatch()?.({ kind: 'text', text: char })
    f.dispatch()?.({ kind: 'key', name: 'enter' })
    await flush()
    expect(f.titleService.rename).toHaveBeenCalledTimes(1)
    expect(f.titleService.rename.mock.calls[0]?.[0]).toBe(f.session)
    f.draw()
    // The hub shows Harness's accepted, normalized title, not the raw draft.
    expect(latest(f.frames)).toContain('New Name')
    expect(latest(f.frames)).not.toContain('  New   Name  ')
  })

  it('omits Rename when the profile mounts no title service, and still opens', async () => {
    const f = await fixture({ titleService: false })
    await flush()
    submit(f.dispatch(), '/session')
    await flush()
    const body = latest(f.frames)
    expect(body).toContain('Find in conversation')
    expect(body).not.toContain('Rename')
  })

  it('omits Turns when the turn-outline projection is not registered', async () => {
    const f = await fixture({ outline: false })
    await flush()
    submit(f.dispatch(), '/session')
    await flush()
    const body = latest(f.frames)
    expect(body).toContain('Lineage')
    expect(body).not.toContain('Turns')
    expect(body).not.toContain('t turns')
  })

  it('resolves the local /session before a registered command under current precedence', async () => {
    // The adopted Harness generation registers no `/session`; this synthetic
    // registration pins only today's LocalCommandRegistry precedence — a local
    // name is resolved first and `ctx.commands.execute` is never reached. It is
    // not a promise that dshline shadows a future upstream `/session` forever:
    // an upstream command of the same name must trigger a deliberate review of
    // the collision, not be silently absorbed by this test.
    const f = await fixture({ harnessSession: true })
    await flush()
    submit(f.dispatch(), '/session')
    await flush()
    expect(latest(f.frames)).toContain('Find in conversation')
    expect(f.commands.execute).not.toHaveBeenCalled()
  })
})
