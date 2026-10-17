/**
 * Live Assistant streaming through the real attachment, onto a real terminal.
 *
 * Harness publishes two Assistant contracts and dshline consumes both here:
 * the durable log settles what was said (`assistant/message`, or the log-only
 * `assistant/attempt` for a model attempt that said nothing), and the
 * agent-scoped `agent/assistant-stream` frames carry the transient
 * frame-by-frame presentation. The failures worth guarding are all about how
 * those two agree, so this drives `attachSession` with real frames and real
 * events and reads the terminal's own scroll buffer — not the buffer's internal
 * state, and not a string with its escape sequences removed.
 *
 * `commit` goes through a real `Screen`, and every `draw` recomposes the real
 * slot registry into the bounded live region, exactly as the window's redraw
 * scheduler does. So "the reader saw the reply once" is a claim about cells.
 * @module dshline/tests/assistant-stream
 */

import { describe, expect, it, vi } from 'vitest'
import { Context as RealContext } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { decodeKeys, Screen } from '@dshline/renderer'
import type { Key } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import { RedrawScheduler } from '../src/redraw.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/** Wide enough that no reply in this file wraps for an unrelated reason. */
const COLUMNS = 46

/** Tall enough to hold a short transcript plus the chrome below it. */
const ROWS = 16

/** One attached session wired to a real Screen over a real emulator. */
interface Attached {
  /** The exact Agent the attachment projects. */
  readonly agent: Agent
  /** Publish one committed session event for that Agent's session. */
  readonly event: (type: string, data?: unknown, extra?: Record<string, unknown>) => void
  /** Publish one live assistant-stream frame for that Agent. */
  readonly frame: (frame: AssistantStreamFrame) => void
  /** Publish one live assistant-stream frame for a DIFFERENT Agent. */
  readonly strayFrame: (frame: AssistantStreamFrame) => void
  /** Every row the terminal holds, blank ones dropped. */
  readonly rows: () => Promise<string[]>
  /** Decode terminal bytes and dispatch without submitting probe text. */
  readonly input: (bytes: string) => void
  /** Read the actual viewport, as distinct from native scrollback. */
  readonly viewport: () => Promise<string[]>
  /** Read the actual cursor after queued terminal output has drained. */
  readonly cursor: () => Promise<{ column: number; row: number }>
  /** Number of scheduled compositions, excluding synchronous commit writes. */
  readonly paints: () => number
  /** Retire the attachment through the local /new transition, never an inbox. */
  readonly close: () => Promise<void>
  /** Release the emulator. */
  readonly dispose: () => void
}

/**
 * Attach one live session over a real terminal.
 * @param reasoningVisible - whether reasoning rows are projected.
 * @param scheduled - use the production check-phase scheduler for redraws.
 * @returns the attachment's two publication routes and the terminal's rows.
 */
async function attach(reasoningVisible = true, scheduled = false): Promise<Attached> {
  const ctx = new RealContext()
  await ctx.plugin(TuiSlots)
  ctx.provide('tools', { get: () => undefined })
  ctx.provide('commands', { execute: vi.fn(async () => undefined), list: () => [] } as never)
  ctx.provide('userQuestions', {} as never)

  const emulator = createEmulator(COLUMNS, ROWS)
  const screen = new Screen(emulator.target)
  // The window's own redraw: finished rows are committed once and the bounded
  // live region is recomposed from the registry. Anything wrong about which of
  // the two a streamed line belongs to shows up as a duplicate row below.
  let paints = 0
  const paint = (): void => {
    paints += 1
    const { lines, cursor } = ctx.tuiSlots.compose(COLUMNS, ROWS)
    if (cursor === undefined) screen.setLive(lines)
    else screen.setLive(lines, cursor)
  }
  const redraws = new RedrawScheduler(paint)
  const draw = scheduled ? (): void => { redraws.request() } : paint
  const offRender = scheduled ? ctx.on('tui/render', draw) : (): void => {}
  let dispatch: ((key: Key) => void) | undefined
  const window = {
    ctx,
    terminal: { columns: () => COLUMNS, rows: () => ROWS },
    exit: vi.fn(),
    startup: { cwd: '/workspace', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: undefined },
    modelInfo: { contextWindow: undefined, reasoning: undefined },
    modelCompletionValues: () => Promise.resolve([]),
    prefs: {
      usageMode: 'cost', timing: false, cardDetail: 'compact',
      reasoningVisible, busyEnter: 'queue',
    },
    colorDepth: 0,
    palette: () => ({}),
    setPalette: () => {},
    themeSettings: {},
    busyEnterSettings: { current: () => 'queue', watch: () => () => {}, save: async () => undefined },
    pendingTask: undefined,
    draw,
    paintNow: () => { redraws.now() },
    commit: (lines: readonly string[]) => { if (lines.length > 0) screen.commit([...lines]) },
    clear: () => {},
    refreshModelInfo: () => {},
    setDispatch: (handler: ((key: Key) => void) | undefined) => { dispatch = handler },
    setExit: () => {},
  } as unknown as Window

  const session = { id: 's-stream', header: { cwd: '/workspace' }, events: [] }
  const agent = {
    session,
    status: 'running',
    inbox: { nextStep: [], nextTurn: [] },
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  } as unknown as Agent
  const outcome = {
    target: { kind: 'new', cwd: '/workspace' },
    attached: { handle: { agent, dispose: async () => {} }, reopened: false },
  } as unknown as AttachOutcome
  const attached = attachSession(window, outcome)

  let seq = 0
  return {
    agent,
    event: (type, data = {}, extra = {}) => {
      seq += 1
      ctx.emit('session/event', session as never, {
        type, data, seq, time: seq, ...extra,
      } as unknown as SessionEvent)
    },
    frame: one => { ctx.emit('agent/assistant-stream', { agent, frame: one } as never) },
    strayFrame: one => {
      ctx.emit('agent/assistant-stream', { agent: { session: {} } as Agent, frame: one } as never)
    },
    rows: async () => (await emulator.scrollback()).map(row => row.trimEnd()).filter(row => row !== ''),
    input: bytes => {
      expect(dispatch).toBeDefined()
      for (const key of decodeKeys(bytes)) dispatch?.(key)
    },
    viewport: async () => (await emulator.screen()).map(row => row.trimEnd()),
    cursor: () => emulator.cursor(),
    paints: () => paints,
    close: async () => {
      // Exit requests dispose presentation but do not resolve this fixture's
      // session loop. /new does; make cleanup independent of the busy-key probe.
      Object.assign(agent, { status: 'idle' })
      for (const key of decodeKeys('\u0001\u000b/new\r')) dispatch?.(key)
      await attached
      redraws.stop()
      offRender()
      emulator.dispose()
    },
    dispose: () => { redraws.stop(); offRender(); emulator.dispose() },
  }
}

/** A monotone frame revision, so every published frame is well-formed. */
let revision = 0

/** The opening marker of one attempt. */
function start(attemptId: string, step = 1): AssistantStreamFrame {
  revision += 1
  return { type: 'start', attemptId, revision, turn: 1, step } as AssistantStreamFrame
}

/** One delivered chunk of one attempt. */
function chunk(attemptId: string, one: StreamChunk, index = 0): AssistantStreamFrame {
  revision += 1
  return { type: 'chunk', attemptId, revision, index, time: revision, chunk: one } as AssistantStreamFrame
}

/** A text delta of one attempt. */
function text(attemptId: string, value: string, index = 0): AssistantStreamFrame {
  return chunk(attemptId, { type: 'text-delta', index: 0, text: value }, index)
}

/** A reasoning delta of one attempt. */
function reasoning(attemptId: string, value: string, index = 0): AssistantStreamFrame {
  return chunk(attemptId, { type: 'reasoning-delta', index: 0, text: value }, index)
}

/** The terminal marker of one attempt that committed a durable settlement. */
function committed(
  attemptId: string,
  eventType: 'assistant/message' | 'assistant/attempt',
  index = 1,
): AssistantStreamFrame {
  revision += 1
  return {
    type: 'end', attemptId, revision, index,
    outcome: { kind: 'committed', eventType, seq: revision },
  } as AssistantStreamFrame
}

/** The terminal marker of one attempt with no durable record at all. */
function abandoned(attemptId: string, index = 1): AssistantStreamFrame {
  revision += 1
  return { type: 'end', attemptId, revision, index, outcome: { kind: 'abandoned' } } as AssistantStreamFrame
}

/** A durable assistant message settling one attempt's visible output. */
function message(content: readonly ContentBlock[], interrupted = false): [string, unknown, Record<string, unknown>] {
  return [
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: { id: 'a-1', role: 'assistant', content, source: { kind: 'model' } },
      stream: [],
      ...interrupted ? { interrupted: true } : {},
    },
    { surfaceOp: 'append' },
  ]
}

/** How many held rows end with the given text. */
function occurrences(rows: readonly string[], ending: string): number {
  return rows.filter(row => row.endsWith(ending)).length
}

describe('a reply streamed through the live agent frames', () => {
  it('shows text as it arrives and commits it exactly once', async () => {
    const f = await attach()
    f.event('turn/start', { turn: 1 })
    f.event('step/start', { turn: 1, step: 1 })
    f.frame(start('a1'))
    f.frame(text('a1', 'alpha\nbeta\n'))
    f.frame(text('a1', 'gamma', 1))
    // The unfinished line is live, above the chrome, and not yet in scrollback.
    expect(await f.rows()).toContain('  gamma')
    f.event(...message([{ type: 'text', text: 'alpha\nbeta\ngamma' }]))
    f.frame(committed('a1', 'assistant/message', 2))
    f.event('step/end', { turn: 1, step: 1 })
    f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const rows = await f.rows()
    expect(rows).toContain('● alpha')
    // Once each: the deltas wrote the completed lines, and the settlement
    // contributed only the remainder the stream could not have shown.
    expect(occurrences(rows, 'alpha')).toBe(1)
    expect(occurrences(rows, 'beta')).toBe(1)
    expect(occurrences(rows, 'gamma')).toBe(1)
    f.dispose()
  })

  it('shows reasoning live and keeps it above the reply', async () => {
    const f = await attach()
    f.event('turn/start', { turn: 1 })
    f.frame(start('a1'))
    f.frame(reasoning('a1', 'let me check the file'))
    // Reasoning is visible while it is still an unfinished line.
    expect(await f.rows()).toContain('✻ let me check the file')
    f.frame(text('a1', 'It is empty.', 1))
    f.event(...message([
      { type: 'reasoning', text: 'let me check the file' },
      { type: 'text', text: 'It is empty.' },
    ]))
    f.frame(committed('a1', 'assistant/message', 2))

    const rows = await f.rows()
    expect(rows).toContain('✻ let me check the file')
    expect(rows).toContain('● It is empty.')
    expect(occurrences(rows, 'let me check the file')).toBe(1)
    expect(occurrences(rows, 'It is empty.')).toBe(1)
    f.dispose()
  })

  it('settles an interrupted reply from its own durable message', async () => {
    const f = await attach()
    f.event('turn/start', { turn: 1 })
    f.frame(start('a1'))
    f.frame(text('a1', 'half a th'))
    // ctrl-c: Harness finalizes the delivered prefix as `assistant/message`
    // with `interrupted: true`, and the turn then closes as aborted.
    f.event(...message([{ type: 'text', text: 'half a th' }], true))
    f.frame(committed('a1', 'assistant/message', 1))
    f.event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })

    const rows = await f.rows()
    expect(rows).toContain('● half a th')
    expect(occurrences(rows, 'half a th')).toBe(1)
    // And the transcript says why it stopped.
    expect(rows.some(row => row.includes('interrupted'))).toBe(true)
    f.dispose()
  })

  it('never commits a failed attempt as a reply, and lets the retry answer', async () => {
    const f = await attach()
    f.event('turn/start', { turn: 1 })
    f.event('step/start', { turn: 1, step: 1 })
    // The first attempt streams an unfinished line and then fails. Its stream
    // settles as the log-only `assistant/attempt`: real transient output, but
    // never a model-visible reply.
    f.frame(start('a1'))
    f.frame(text('a1', 'I think the ans'))
    f.event('assistant/attempt', { turn: 1, step: 1, stream: [] })
    f.frame(committed('a1', 'assistant/attempt', 1))
    // The retry answers from the beginning. Nothing of the failed attempt may
    // reach scrollback, and its text must not be treated as a prefix of this
    // reply either — that is how the whole answer would be printed twice.
    f.frame(start('a2', 1))
    f.frame(text('a2', 'The answer is 42.\n'))
    f.event(...message([{ type: 'text', text: 'The answer is 42.\n' }]))
    f.frame(committed('a2', 'assistant/message', 1))
    f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const rows = await f.rows()
    expect(rows).toContain('● The answer is 42.')
    expect(occurrences(rows, 'The answer is 42.')).toBe(1)
    expect(rows.some(row => row.includes('I think the ans'))).toBe(false)
    f.dispose()
  })

  it('ignores a late end from a settled attempt after the retry started', async () => {
    // Cross-attempt frame ordering is an implementation property of the loop,
    // not a published guarantee: a settled attempt's `end` can arrive after the
    // next attempt has already streamed. Resetting on it would empty the retry's
    // buffer, so the durable `assistant/message` would reconcile against nothing
    // and re-emit a reply the reader already saw.
    const f = await attach()
    f.event('turn/start', { turn: 1 })
    f.frame(start('a1'))
    f.frame(text('a1', 'first\n'))
    f.event('assistant/attempt', { turn: 1, step: 1, stream: [] })
    f.frame(committed('a1', 'assistant/attempt', 1))
    f.frame(start('a2', 1))
    f.frame(text('a2', 'The answer is 42.\n'))
    // Late terminal frame, from the attempt that already settled.
    f.frame(abandoned('a1', 2))
    f.event(...message([{ type: 'text', text: 'The answer is 42.\n' }]))
    f.frame(committed('a2', 'assistant/message', 1))
    f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const rows = await f.rows()
    expect(rows).toContain('● The answer is 42.')
    expect(occurrences(rows, 'The answer is 42.')).toBe(1)
    f.dispose()
  })

  it('ignores a stale chunk so it cannot poison the retry prefix', async () => {
    // A late chunk from attempt A pushes text the current attempt never sent, so
    // the assembled settlement no longer starts with the streamed prefix and the
    // whole reply is emitted a second time.
    const f = await attach()
    f.event('turn/start', { turn: 1 })
    f.frame(start('a1'))
    f.frame(text('a1', 'first\n'))
    f.event('assistant/attempt', { turn: 1, step: 1, stream: [] })
    f.frame(committed('a1', 'assistant/attempt', 1))
    f.frame(start('a2', 1))
    f.frame(text('a2', 'The answer is 42.\nB partial'))
    f.frame(chunk('a1', { type: 'text-delta', index: 0, text: 'STALE' }, 2))
    f.event(...message([{ type: 'text', text: 'The answer is 42.\nB partial' }]))
    f.frame(committed('a2', 'assistant/message', 1))
    f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const rows = await f.rows()
    expect(occurrences(rows, 'The answer is 42.')).toBe(1)
    expect(rows.some(row => row.includes('STALE'))).toBe(false)
    f.dispose()
  })

  it('ignores a stale frame after the newer attempt has already ended', async () => {
    // `end` clears the active attempt, but "no active attempt after framing" is
    // not the same state as "the listener attached mid-stream". Treating them
    // alike would adopt the late frame, and a stale chunk that commits a line
    // would enter scrollback with no later reset able to remove it.
    const f = await attach()
    f.event('turn/start', { turn: 1 })
    f.frame(start('a1'))
    f.frame(text('a1', 'first\n'))
    f.frame(start('a2', 1))
    f.frame(text('a2', 'The answer is 42.\n'))
    f.event(...message([{ type: 'text', text: 'The answer is 42.\n' }]))
    f.frame(committed('a2', 'assistant/message', 1))
    f.frame(abandoned('a2', 2))
    // Both attempts have now ended; only a new `start` may resume the stream.
    f.frame(text('a1', 'STALE\n', 2))
    f.frame(abandoned('a1', 3))
    f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const rows = await f.rows()
    expect(rows.some(row => row.includes('STALE'))).toBe(false)
    expect(occurrences(rows, 'The answer is 42.')).toBe(1)
    f.dispose()
  })

  it('ignores a stale chunk after a mid-stream adopted attempt ends', async () => {
    // The listener can attach after `start`, so no `start` frame is ever seen:
    // the first `chunk` adopts the attempt, which must itself count as "an
    // attempt has been adopted". Otherwise `end` returns the state to "nothing
    // adopted yet" and a late chunk looks like another mid-stream adoption,
    // committing a completed stale line into scrollback.
    const f = await attach()
    f.event('turn/start', { turn: 1 })
    f.frame(text('a1', 'first\n'))
    f.frame(abandoned('a1', 1))
    f.frame(text('a1', 'STALE\n', 2))
    f.frame(abandoned('a1', 3))
    f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const rows = await f.rows()
    expect(rows.some(row => row.includes('STALE'))).toBe(false)
    expect(occurrences(rows, 'first')).toBe(1)
    f.dispose()
  })

  it('ignores a late end from a cancelled attempt before the retry answers', async () => {
    // Cancellation can leave a terminal frame in flight; the retry that follows
    // must still reconcile its own stream.
    const f = await attach()
    f.event('turn/start', { turn: 1 })
    f.frame(start('a1'))
    f.frame(text('a1', 'half a th'))
    f.event(...message([{ type: 'text', text: 'half a th' }], true))
    f.frame(committed('a1', 'assistant/message', 1))
    f.frame(start('a2', 1))
    f.frame(text('a2', 'Recovered.\n'))
    f.frame(abandoned('a1', 2))
    f.event(...message([{ type: 'text', text: 'Recovered.\n' }]))
    f.frame(committed('a2', 'assistant/message', 1))
    f.event('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const rows = await f.rows()
    expect(occurrences(rows, 'Recovered.')).toBe(1)
    expect(occurrences(rows, 'half a th')).toBe(1)
    f.dispose()
  })

  it('drops an abandoned attempt without committing or breaking the next turn', async () => {
    const f = await attach()
    f.event('turn/start', { turn: 1 })
    f.frame(start('a1'))
    f.frame(reasoning('a1', 'unfinished '))
    f.frame(reasoning('a1', 'thought', 1))
    // No durable settlement exists for an abandoned attempt at all, so nothing
    // will ever arrive to commit this against.
    f.frame(abandoned('a1', 2))
    f.event('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'E', message: 'gone' } } })

    let rows = await f.rows()
    expect(rows.some(row => row.includes('unfinished thought'))).toBe(false)
    expect(rows.some(row => row.includes('E: gone'))).toBe(true)

    // The next turn answers normally, with nothing carried over.
    f.event('turn/start', { turn: 2 })
    f.frame(start('a2'))
    f.frame(text('a2', 'Recovered.\n'))
    // Verbatim: the assembled message is the concatenation of the deltas, so a
    // reply that streamed its closing newline carries it here too.
    f.event(...message([{ type: 'text', text: 'Recovered.\n' }]))
    f.frame(committed('a2', 'assistant/message', 1))
    f.event('turn/end', { turn: 2, reason: { kind: 'completed' } })

    rows = await f.rows()
    expect(rows).toContain('● Recovered.')
    expect(occurrences(rows, 'Recovered.')).toBe(1)
    f.dispose()
  })

  it('projects one Agent, ignoring another agent\'s frames', async () => {
    // A subagent's frames reach this process too, and one window projects one
    // Agent. Without the identity filter a child's reasoning would appear in
    // the parent's transcript.
    const f = await attach()
    f.event('turn/start', { turn: 1 })
    f.strayFrame(start('b1'))
    f.strayFrame(text('b1', 'a child was thinking\n'))
    f.strayFrame(committed('b1', 'assistant/message', 1))
    // The attached Agent then answers, and only its reply is on screen.
    f.frame(start('a1'))
    f.frame(text('a1', 'mine\n'))
    f.event(...message([{ type: 'text', text: 'mine\n' }]))
    f.frame(committed('a1', 'assistant/message', 1))

    const rows = await f.rows()
    expect(rows.some(row => row.includes('a child was thinking'))).toBe(false)
    expect(rows).toContain('● mine')
    f.dispose()
  })
})

/** Advance to the scheduler's check phase without a wall-clock deadline. */
const nextPaint = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

describe('input during a long synthetic turn with production redraw scheduling', () => {
  it('echoes and edits an unsubmitted marker between stream bursts without losing scrollback', async () => {
    const f = await attach(true, true)
    try {
      f.event('turn/start', { turn: 1 })
      f.event('step/start', { turn: 1, step: 1 })
      f.frame(start('typing'))
      const lines = Array.from({ length: 80 }, (_, index) => `stream row ${String(index).padStart(2, '0')}`)
      for (let burst = 0; burst < 4; burst += 1) {
        for (let index = burst * 20; index < (burst + 1) * 20; index += 1) {
          f.frame(text('typing', `${lines[index]}\n`, index))
        }
        // No Enter: the marker must never reach either Harness inbox verb.
        f.input(burst === 0 ? 'UNSENT-0' : `\u007f${String(burst)}`)
        await nextPaint()
        expect((await f.viewport()).some(row => row.includes(`UNSENT-${String(burst)}`))).toBe(true)
      }
      // Move and edit in the middle, not just an append-only typing assertion.
      f.input('\u001b[D!')
      await nextPaint()
      const viewport = await f.viewport()
      const composerRow = viewport.findIndex(row => row.includes('UNSENT-!3'))
      expect(composerRow).toBeGreaterThanOrEqual(0)
      const cursor = await f.cursor()
      // Anchor the cursor to the actual character, not a hardcoded gutter.
      expect(cursor).toEqual({ column: viewport[composerRow]!.indexOf('3'), row: composerRow })
      expect(f.agent.followup).not.toHaveBeenCalled()
      expect(f.agent.steer).not.toHaveBeenCalled()
      const history = await f.rows()
      for (const line of lines) expect(occurrences(history, line), line).toBe(1)
      expect((await f.viewport()).some(row => row.includes('stream row 00'))).toBe(false)
    } finally {
      await f.close()
    }
  })

  it.each([
    ['legacy', '\u0003'],
    ['enhanced', '\u001b[99;5u'],
  ])('handles %s interrupt before pending repaint and settles the prefix once', async (_encoding, interrupt) => {
    const f = await attach(true, true)
    try {
      f.event('turn/start', { turn: 1 })
      f.event('step/start', { turn: 1, step: 1 })
      f.frame(start('interrupt'))
      f.frame(text('interrupt', 'completed\npartial'))
      f.input('UNSUBMITTED')
      // This whole burst and keypress occupy one task: no paint can have run.
      expect(f.paints()).toBe(0)
      f.input(interrupt)
      expect(f.agent.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' })
      expect(f.paints()).toBe(0)
      // Harness, not the UI, owns cancellation settlement. Publish its delivered
      // prefix and terminal frame only after the handler has already returned.
      f.event(...message([{ type: 'text', text: 'completed\npartial' }], true))
      f.frame(committed('interrupt', 'assistant/message', 1))
      f.event('turn/end', { turn: 1, reason: 'aborted' })
      await nextPaint()
      const history = await f.rows()
      expect(occurrences(history, 'completed')).toBe(1)
      expect(occurrences(history, 'partial')).toBe(1)
      expect((await f.viewport()).some(row => row.includes('UNSUBMITTED'))).toBe(true)
      expect(f.agent.followup).not.toHaveBeenCalled()
      expect(f.agent.steer).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
})
