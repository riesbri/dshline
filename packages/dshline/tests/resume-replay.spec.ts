/**
 * Resumed-transcript replay, exercised through the real attachment.
 *
 * The boundary this pins is WHERE the history comes from. Once
 * `ctx.agents.resume` has returned the owned `AgentHandle`, the attached Agent's
 * live Harness `Session` is the authority for its own log:
 * `agent.session.snapshotEvents()`. The logical-corpus service
 * (`ctx.sessionQuery`) answers for sessions this window does NOT own, so a
 * resumed attachment never consults it — and a deployment that mounts no
 * `sessionQuery` at all still replays everything the Session holds.
 *
 * The smallest assembled seam that can prove that: a real cordis `Context` with
 * the real `TuiSlots` registry mounted, a fake window whose draw/paintNow
 * compose that registry (exactly what the production window's scheduler does),
 * a REAL Harness `Session` carrying representative history, and a fake agent
 * whose `followup`/`steer` record every dispatch. The optional capability
 * services (`jobs`, `subagents`, `goals`, `tokenMeter`, `fs`, projections) are
 * omitted and resolve to undefined, and the three hard services the attachment
 * touches (`tools.get`, `commands.list/execute`, and `userQuestions`) are
 * minimal doubles.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context as RealContext } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import type { Config } from '@deepseek-ai/dsh-permission-presets'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/** One user prompt the replayed history carries, the flood's marker line. */
const PAST_PROMPT = 'first past prompt'

/** The structural slice of a Session the attachment reads. */
interface SessionSource {
  readonly id: unknown
  readonly header: { readonly cwd?: string }
  snapshotEvents(): readonly SessionEvent[]
}

/**
 * A real detached Harness Session carrying one human prompt.
 * @returns the live Session a resumed handle would own.
 */
function sessionWithHistory(): Session {
  const session = Session.create(SessionId('resumed-session'))
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: PAST_PROMPT }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  return session
}

/**
 * A Session stand-in over a fixed event list, for projection cases whose event
 * data is laborious to append through the real format.
 * @param events - the events the snapshot returns.
 * @returns the stand-in.
 */
function overEvents(events: readonly SessionEvent[]): SessionSource {
  return { id: 'stub-session', header: { cwd: '/ws' }, snapshotEvents: () => events }
}

/**
 * A persisted turn whose first model attempt failed before it said anything.
 *
 * The shape a retry leaves behind: one log-only `assistant/attempt` carrying the
 * compacted stream of the attempt that produced no reply, then the
 * `assistant/message` that did. Replaying it must show the reply once — the
 * attempt is not a second copy of it, and no legacy exclusion rule is needed to
 * keep it out.
 */
const REPLAYED_RETRY: SessionEvent[] = [
  { type: 'turn/start', data: { turn: 1 }, time: 1 } as unknown as SessionEvent,
  {
    type: 'assistant/attempt',
    data: {
      turn: 1,
      step: 1,
      stream: [{ type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['a false start'] }],
    },
    time: 2,
  } as unknown as SessionEvent,
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'the settled answer' }] },
      stream: [{ type: 'text-chunks', time0: 3, index: 0, dt: [], texts: ['the settled answer'] }],
    },
    time: 3,
    surfaceOp: 'append',
  } as unknown as SessionEvent,
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 4 } as unknown as SessionEvent,
]

/** A persisted assistant response with reasoning and visible answer text. */
const REPLAYED_REASONING: SessionEvent[] = [{
  type: 'assistant/message',
  data: {
    message: {
      content: [
        { type: 'reasoning', text: 'historical thought' },
        { type: 'text', text: 'historical answer' },
      ],
    },
  },
  time: 2,
  surfaceOp: 'append',
} as unknown as SessionEvent]

/** A recorded command, whose two lifecycle events are the only transcript trace. */
const REPLAYED_COMMAND: SessionEvent[] = [
  {
    type: 'command/run',
    data: { commandId: 'c-1', name: 'permission', args: ' read-only', source: { kind: 'user' } },
    time: 1,
  } as unknown as SessionEvent,
  {
    type: 'command/done',
    data: { commandId: 'c-1', kind: 'success', text: 'permission: read-only' },
    time: 2,
  } as unknown as SessionEvent,
]

/** What one assembled fixture exposes to a test. */
interface Fixture {
  /** The window's current input route. */
  dispatch: () => ((key: Key) => void) | undefined
  /** The fake Agent the attachment drives. */
  agent: { followup: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn> }
  /** The exact Session object the attachment was handed. */
  session: SessionSource
  /**
   * The source Session whose durable log seeded {@link Fixture.session}, when
   * the fixture reconstructed one. Undefined for the ordinary session cases.
   */
  source: SessionSource | undefined
  /** Rows committed to scrollback, one entry per commit. */
  commits: string[][]
  /** Live-region frames composed by draw/paintNow. */
  frames: Array<{ lines: string[] }>
}

/**
 * Assemble the attachment over a real context, a live Session, and an optional
 * corpus service.
 * @param options - the Session to resume and the services to mount.
 * @returns the fixture's observable pieces.
 */
async function fixture(options: {
  readonly session?: SessionSource
  readonly sessionQuery?: { readonly readSession: (id: unknown) => unknown }
  readonly reasoningVisible?: boolean
  readonly busyEnter?: 'queue' | 'steer'
  /**
   * Mount the real permission stack and restore this preset onto the Session's
   * own log, so the footer's value comes from Harness's fold rather than from
   * any dshline-owned permission state.
   */
  readonly resumedPermission?: { readonly config: Config; readonly preset: string }
} = {}): Promise<Fixture> {
  const ctx = new RealContext()
  await ctx.plugin(TuiSlots)
  ctx.provide('tools', { get: () => undefined })
  const commands = { execute: vi.fn(async () => undefined), list: () => [], register: () => () => {} }
  ctx.provide('commands', commands as never)
  ctx.provide('userQuestions', {} as never)
  // Mounted only when a test asks for it: the no-query regression must prove the
  // replay works with the service absent, and the boundary test proves it is
  // never consulted when present.
  if (options.sessionQuery !== undefined) ctx.provide('sessionQuery', options.sessionQuery as never)

  let session = options.session
  let source: Session | undefined
  if (options.resumedPermission !== undefined) {
    const { config, preset } = options.resumedPermission
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(PermissionPresetService, config)
    // Reconstruction, not reuse. The source Session's durable log is captured
    // and a NEW Session is seeded from it through the store's own replay path,
    // so the attached Session is a distinct reconstruction and is not the
    // Session object on which the permission switch was performed.
    source = ctx.sessions.create(SessionId('resumed-source'))
    source.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: PAST_PROMPT }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    ctx.permissionPresets.set(source, preset)
    const seed = source.snapshotEvents()
    session = ctx.sessions.create(SessionId('resumed-session'), { seed })
  }
  if (session === undefined) session = sessionWithHistory()

  const commits: string[][] = []
  const frames: Array<{ lines: string[] }> = []
  let dispatch: ((key: Key) => void) | undefined
  const compose = (): void => { frames.push(ctx.tuiSlots.compose(80, 24)) }
  const window = {
    ctx,
    terminal: { columns: () => 80, rows: () => 24 },
    exit: undefined,
    startup: { cwd: '/ws', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: undefined },
    modelInfo: { contextWindow: undefined, reasoning: undefined },
    prefs: {
      usageMode: 'cost',
      timing: false,
      cardDetail: 'compact',
      reasoningVisible: options.reasoningVisible ?? true,
      busyEnter: options.busyEnter ?? 'queue',
    },
    colorDepth: 0,
    palette: () => ({}),
    setPalette: () => {},
    themeSettings: {},
    busyEnterSettings: { current: () => 'queue', watch: () => () => {}, save: async () => undefined },
    pendingTask: undefined,
    draw: compose,
    paintNow: compose,
    commit: lines => { commits.push([...lines]) },
    clear: () => {},
    refreshModelInfo: () => {},
    requestExit: () => {},
    setDispatch: handler => { dispatch = handler },
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
    target: { kind: 'resume', id: SessionId('resumed-session') },
    attached: { handle: { agent, dispose: async () => {} }, reopened: true },
  } as unknown as AttachOutcome

  // The replay is synchronous, so this runs the whole pre-input block — status
  // paint, snapshot, projection, flood commit, ready paint — before returning.
  void attachSession(window, outcome)

  return {
    dispatch: () => dispatch,
    agent: agent as unknown as Fixture['agent'],
    session,
    source,
    commits,
    frames,
  }
}

/** Let one set of queued promises flush, without waiting time. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

/** The most recent composed frame, as the terminal would show it. */
function latest(frames: Array<{ lines: string[] }>): string {
  return stripAnsi((frames.at(-1)?.lines ?? []).join('\n'))
}

/** The status row of the most recent composed frame. */
function status(frames: Array<{ lines: string[] }>): string {
  const lines = frames.at(-1)?.lines ?? []
  return stripAnsi(lines[lines.length - 1] ?? '')
}

/**
 * Feed one decoded keystroke to the attached window.
 * @param dispatch - the window's current input route.
 * @param key - the keystroke.
 */
function press(dispatch: ((key: Key) => void) | undefined, key: Key): void {
  expect(dispatch, 'the window must be routing input').toBeDefined()
  dispatch?.(key)
}

/**
 * Type one text key at a time, as a terminal delivers individual chars.
 * @param dispatch - the window's current input route.
 * @param text - the characters to type.
 */
function typeText(dispatch: ((key: Key) => void) | undefined, text: string): void {
  for (const char of [...text]) press(dispatch, { kind: 'text', text: char })
}

describe('replaying a resumed transcript from its live Session', () => {
  it('replays the Session log with no sessionQuery service mounted', async () => {
    const { commits, frames, dispatch } = await fixture()

    const transcript = stripAnsi(commits.flat().join('\n'))
    expect(transcript).toContain(PAST_PROMPT)
    expect(transcript).toContain('· resumed — 1 earlier events')
    expect(transcript).not.toContain('resumed an empty session')

    // History is seeded from the same durable events the transcript replayed.
    press(dispatch(), { kind: 'key', name: 'up' })
    expect(latest(frames)).toContain(PAST_PROMPT)

    // And the attachment reports ready rather than a replay that never ended.
    expect(status(frames)).toContain('● ready')
  })

  it('never consults sessionQuery for the attached resumed transcript', async () => {
    const readSession = vi.fn((): never => {
      throw new Error('sessionQuery.readSession must not be consulted for an owned Agent')
    })
    const { commits } = await fixture({ sessionQuery: { readSession } })

    // The corpus service is mounted and would throw if touched; the owned live
    // Session replays regardless.
    expect(stripAnsi(commits.flat().join('\n'))).toContain(PAST_PROMPT)
    expect(readSession).not.toHaveBeenCalled()
  })

  it('keeps the empty-session banner for a genuinely empty live Session', async () => {
    const empty = Session.create(SessionId('empty-session'))
    const { commits, frames } = await fixture({ session: empty })

    expect(stripAnsi(commits.flat().join('\n'))).toContain('· resumed an empty session')
    expect(status(frames)).toContain('● ready')
  })

  it('paints the resuming status before the ready frame', async () => {
    const { frames } = await fixture()
    const texts = frames.map(frame => stripAnsi(frame.lines.join('\n')))

    const resuming = texts.findIndex(text => text.includes('resuming session'))
    expect(resuming).toBeGreaterThanOrEqual(0)
    expect(texts[resuming]).not.toContain('● ready')
    expect(texts.some(text => text.includes('replaying 1 events'))).toBe(true)

    // The synchronous flood ends on the ordinary ready frame.
    expect(texts.at(-1)).toContain('● ready')
    expect(texts.at(-1)).not.toContain('resuming session')
  })

  it('replays a retried turn as one reply, with the failed attempt drawn as nothing', async () => {
    const { commits } = await fixture({ session: overEvents(REPLAYED_RETRY) })
    const rows = commits.flat().map(stripAnsi)
    expect(rows.filter(row => row.includes('the settled answer'))).toHaveLength(1)
    // The failed attempt's compacted stream is history, not a transcript line.
    // Expanding it to draw one would recreate the event model v2 removed.
    expect(rows.some(row => row.includes('a false start'))).toBe(false)
  })

  it('suppresses persisted reasoning while replaying but keeps the answer', async () => {
    const { commits } = await fixture({ session: overEvents(REPLAYED_REASONING), reasoningVisible: false })
    const transcript = commits.flat().join('\n')
    expect(transcript).not.toContain('historical thought')
    expect(transcript).toContain('historical answer')
  })

  it('replays command lifecycle rows and seeds them into input history', async () => {
    const { commits, frames, dispatch } = await fixture({ session: overEvents(REPLAYED_COMMAND) })
    const transcript = stripAnsi(commits.flat().join('\n'))
    expect(transcript).toContain('/permission read-only')
    expect(transcript).toContain('permission: read-only')

    press(dispatch(), { kind: 'key', name: 'up' })
    expect(latest(frames)).toContain('/permission read-only')
  })

  it('replays old compaction and permission events without flashing them', async () => {
    // The load-bearing boundary: the shared projector is also the replay path,
    // so a resumed session's history must rebuild the transcript WITHOUT
    // claiming any of it just happened. Attention is live-only.
    const historical: SessionEvent[] = [
      {
        type: 'compaction/summary',
        seq: 3,
        time: 3,
        data: {
          compactionId: 'old',
          summary: [{ type: 'text', text: 's' }],
          shadowedRange: { start: 0, end: 1 },
          shadowedSeqs: [0, 1],
          shadowedTokenCount: 95_000,
          provider: 'p',
          model: 'm',
        },
      },
      { type: 'permission/preset', seq: 4, time: 4, data: { preset: 'review' } },
    ] as unknown as SessionEvent[]
    const { commits, frames } = await fixture({ session: overEvents(historical) })

    expect(stripAnsi(commits.flat().join('\n'))).toContain('context compacted automatically · 2 entries · ~95k replaced')
    const shown = status(frames)
    expect(shown).toContain('ready')
    expect(shown).not.toContain('context compacted')
    expect(shown).not.toContain('permission →')
  })

  it('shows a resumed Session’s restored permission without dshline-owned state', async () => {
    // Reconstruction, not reuse: the source Session's durable log is captured
    // after its permission switch, and a NEW Session is seeded from that log
    // through the store. The attached Session is a distinct reconstruction, not
    // the object the switch was performed on. The deployment default is
    // `normal`, so a session that silently adopted today's default instead of
    // its own restored state would be caught.
    const permission: Config = {
      presets: {
        review: { sandbox: 'read-only', approval: 'ask' },
        normal: { sandbox: 'workspace-write', approval: 'ask' },
      },
      defaultPreset: 'normal',
    }
    const { commits, frames, session, source } = await fixture({
      resumedPermission: { config: permission, preset: 'review' },
    })

    // The attached Session is a distinct reconstruction of the source's log.
    expect(source).toBeDefined()
    expect(session).not.toBe(source)
    expect(session.id).toBe(SessionId('resumed-session'))
    expect(source?.snapshotEvents().some(event => event.type === 'permission/preset')).toBe(true)

    // The history replays, and the restored permission is the source's switch,
    // not today's `normal` default.
    expect(stripAnsi(commits.flat().join('\n'))).toContain(PAST_PROMPT)
    expect(status(frames)).toContain('review')
    expect(status(frames)).not.toContain('normal')
  })

  it('leaves the attachment usable once the synchronous replay returns', async () => {
    const { agent, dispatch } = await fixture()
    typeText(dispatch(), 'hello')
    press(dispatch(), { kind: 'key', name: 'enter' })
    await flush()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.steer).not.toHaveBeenCalled()
  })
})
