/**
 * The replay input gate, exercised through the real attachment.
 *
 * The smallest assembled seam that can prove the contract: a real cordis
 * `Context` with the real `TuiSlots` registry mounted, a fake window whose
 * draw/paintNow compose that registry (exactly what the production window's
 * scheduler does at the check phase), a fake agent whose `followup`/`steer`
 * record every dispatch, and a `sessionQuery` whose `readSession` is HELD
 * pending by the test. Everything up to `attachSession`'s first await runs
 * synchronously, so after the call the window is attached, the composer is
 * registered, and the transcript read has not settled — which is precisely the
 * state a resumed session is in during its replay.
 *
 * The harness runtime itself is not required: the capability services it would
 * provide (`jobs`, `subagents`, `goals`, `tokenMeter`, `fs`, projections) are
 * all optional `ctx.get(...)` seams that resolve to undefined, and the three
 * hard services the attachment touches (`tools.get`, `commands.list/execute`,
 * and `userQuestions`, whose presence alone satisfies the inject) are
 * three-line doubles. Mounting the real
 * subagent/jobs/tools stack would add a full harness tree for behavior this
 * seam already resolves.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context as RealContext } from '@deepseek-ai/cordis'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/** One user prompt the fake transcript replays, the flood's marker line. */
const PAST_PROMPT = 'first past prompt'

/** The line the gate parks in the transcript after a refused enter. */
const REFUSAL_NOTE = 'nothing was sent'

/**
 * A deferred the test resolves by hand, standing in for the session read.
 * @returns the pending promise and its resolver.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolved => { resolve = resolved })
  return { promise, resolve }
}

/** One replayed user prompt, minimal but valid for the projection. */
const REPLAYED_EVENTS: SessionEvent[] = [{
  type: 'user/message',
  data: { content: [{ type: 'text', text: PAST_PROMPT }], source: { kind: 'user' } },
  time: 1,
  surfaceOp: 'append',
} as unknown as SessionEvent]

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

/**
 * The assembled attachment fixture: real context + registry, controlled read.
 * @returns the dispatch, the agent, the transcript read resolver, and helpers.
 */
async function fixture(options: {
  readonly reasoningVisible?: boolean
  readonly busyEnter?: 'queue' | 'steer'
} = {}): Promise<{
  dispatch: () => ((key: Key) => void) | undefined
  agent: { followup: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn> }
  commands: { execute: ReturnType<typeof vi.fn> }
  resolveRead: (events?: SessionEvent[]) => void
  commits: string[][]
  frames: Array<{ lines: string[] }>
  /** Publish one assistant-stream frame, by default from the attached agent. */
  stream: (frame: unknown, from?: unknown) => void
}> {
  const ctx = new RealContext()
  await ctx.plugin(TuiSlots)
  ctx.provide('tools', { get: () => undefined })
  const commands = { execute: vi.fn(async () => undefined), list: () => [] }
  ctx.provide('commands', commands as never)
  ctx.provide('userQuestions', {} as never)
  const read = deferred<{ events: SessionEvent[] }>()
  ctx.provide('sessionQuery', { readSession: (): Promise<{ events: SessionEvent[] }> => read.promise } as never)

  const commits: string[][] = []
  const frames: Array<{ lines: string[] }> = []
  let dispatch: ((key: Key) => void) | undefined
  const compose = (): void => {
    frames.push(ctx.tuiSlots.compose(80, 24))
  }
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
    setDispatch: handler => { dispatch = handler },
  } as unknown as Window

  const agent = {
    session: { id: 's-1', header: { cwd: '/ws' }, events: [] },
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
  const outcome = {
    target: { kind: 'resume', id: SessionId('s-1') },
    attached: { handle: { agent, dispose: async () => {} }, reopened: true },
  } as unknown as AttachOutcome

  // Runs synchronously to the pending transcript read: dispatch installed,
  // banner committed, first frame painted.
  void attachSession(window, outcome)

  return {
    dispatch: () => dispatch,
    agent,
    commands,
    resolveRead: events => read.resolve({ events: events ?? REPLAYED_EVENTS }),
    commits,
    frames,
    stream: (frame, from) => {
      ctx.emit('agent/assistant-stream', { agent: (from ?? agent) as never, frame: frame as AssistantStreamFrame })
    },
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

describe('the replay input gate', () => {
  it('holds the composer open during the transcript read and gates enter until the replay lands', async () => {
    const { dispatch, agent, commands, resolveRead, commits, frames } = await fixture()

    // The real composer/status frame is painted BEFORE the transcript read
    // settles, and the status does not claim ready while history is missing.
    expect(latest(frames)).toContain('ask anything')
    expect(status(frames)).toContain('resuming session')
    expect(status(frames)).not.toContain('● ready')

    // Typing during the window updates the composer normally.
    typeText(dispatch(), 'hi')
    expect(latest(frames)).toContain('hi')

    // Enter during replay restores the submitted text immediately...
    press(dispatch(), { kind: 'key', name: 'enter' })
    expect(latest(frames)).toContain('hi')
    // ...and dispatches nothing: no model turn, no steer, no command, no
    // transcript echo (submit() is the only writer of submitted text, and it
    // never ran — so submission history is untouched too).
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.steer).not.toHaveBeenCalled()
    expect(commands.execute).not.toHaveBeenCalled()
    expect(commits.flat().join('\n')).not.toContain('hi')
    expect(status(frames)).not.toContain('● ready')

    // Continued typing after the refused enter is preserved.
    typeText(dispatch(), '!')
    expect(latest(frames)).toContain('hi!')

    // The replay settles: history commits first, the parked refusal note
    // second — never a live line above the flood it belongs under.
    resolveRead()
    await flush()
    const transcript = commits.flat().join('\n')
    const atFlood = transcript.indexOf(PAST_PROMPT)
    const atNote = transcript.indexOf(REFUSAL_NOTE)
    expect(atFlood).toBeGreaterThanOrEqual(0)
    expect(atNote).toBeGreaterThan(atFlood)

    // Readiness becomes normal only after the replay completes, and the draft
    // typed during the window survived the flood untouched.
    expect(status(frames)).toContain('● ready')
    expect(status(frames)).not.toContain('resuming session')
    expect(latest(frames)).toContain('hi!')

    // Enter afterwards dispatches the preserved final draft exactly once.
    press(dispatch(), { kind: 'key', name: 'enter' })
    await flush()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.steer).not.toHaveBeenCalled()
    const message = agent.followup.mock.calls[0]?.[0] as { content?: Array<{ text?: string }> }
    expect(message.content?.[0]?.text).toBe('hi!')
  })

  it('suppresses persisted reasoning while replaying but keeps the answer', async () => {
    const { resolveRead, commits } = await fixture({ reasoningVisible: false })
    resolveRead(REPLAYED_REASONING)
    await flush()
    const transcript = commits.flat().join('\n')
    expect(transcript).not.toContain('historical thought')
    expect(transcript).toContain('historical answer')
  })

  it('gates the accelerated gesture exactly as it gates enter', async () => {
    // The gate sits on the submit ACTION rather than on the key, so a second
    // submitting gesture is covered by construction — this pins that, because a
    // gate keyed on the key name would have let ctrl-enter interleave a turn
    // above the historical flood that is about to land.
    const { dispatch, agent, resolveRead, frames, commands, commits } = await fixture({ busyEnter: 'queue' })
    typeText(dispatch(), 'while replaying')
    press(dispatch(), { kind: 'key', name: 'ctrl-enter' })
    await flush()
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.steer).not.toHaveBeenCalled()
    expect(commands.execute).not.toHaveBeenCalled()
    // And the draft came back, so the refused press cost nothing.
    expect(latest(frames)).toContain('while replaying')

    // The reason is parked, not printed, so it lands UNDER the flood it belongs
    // beneath — the same ordering the plain gesture follows.
    resolveRead()
    await flush()
    expect(commits.flat().join('\n')).toContain(REFUSAL_NOTE)

    // Once the replay lands, the same gesture delivers once — and, being the
    // accelerated one under the queue preference with nothing running, still a
    // follow-up: idle has no steering to invert into.
    press(dispatch(), { kind: 'key', name: 'ctrl-enter' })
    await flush()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('never records a refused enter in submission history', async () => {
    const { dispatch, resolveRead, frames } = await fixture()
    typeText(dispatch(), 'quick')
    press(dispatch(), { kind: 'key', name: 'enter' })
    resolveRead()
    await flush()

    // History is seeded from the durable events only. Up from the draft must walk
    // the seeded entries and then end — never reach the line whose enter was
    // refused, which would sit between the seed and the draft if submit had
    // recorded it during the window.
    press(dispatch(), { kind: 'key', name: 'up' })
    expect(latest(frames)).toContain(PAST_PROMPT)
    press(dispatch(), { kind: 'key', name: 'up' })
    expect(latest(frames)).toContain(PAST_PROMPT)
    expect(latest(frames)).not.toContain('quick')
  })

  it('commits streamed text from the transient stream feed, for this agent only', async () => {
    // Streaming reaches the frontend as `agent/assistant-stream` frames, never
    // as log events — which is why the replay above can carry a whole session
    // and still produce no streamed line. The durable settlement that follows
    // is what the replay reads, so a chunk delivered here must reach scrollback
    // through the frame listener or it reaches it nowhere.
    const { resolveRead, commits, stream } = await fixture()
    resolveRead([])
    await flush()
    const before = commits.length

    stream({ type: 'start', attemptId: 's-1:1', revision: 1, turn: 1, step: 1 })
    stream({
      type: 'chunk',
      attemptId: 's-1:1',
      revision: 2,
      index: 0,
      time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'streamed answer\n' },
    })
    expect(commits.slice(before).flat().map(stripAnsi).join('\n')).toContain('streamed answer')

    // Another agent's attempt is another window's business. The listener is
    // context-wide, so identity is the only thing keeping two attachments from
    // writing into each other's scrollback.
    const after = commits.length
    stream({
      type: 'chunk',
      attemptId: 'other:1',
      revision: 1,
      index: 0,
      time: 2,
      chunk: { type: 'text-delta', index: 0, text: 'someone else\n' },
    }, { session: { id: 'other' } })
    expect(commits.slice(after).flat().map(stripAnsi).join('\n')).not.toContain('someone else')
  })
})
