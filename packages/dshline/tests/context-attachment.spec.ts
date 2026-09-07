/**
 * Context intelligence through the real attachment.
 *
 * The smallest assembled seam that can prove the claims this feature rests on,
 * built the same way `replay-gate.spec.ts` builds its fixture: a real cordis
 * `Context` with the real `TuiSlots` registry, a fake window whose draw
 * composes that registry exactly as the production scheduler does, and
 * three-line doubles for the services the attachment touches.
 *
 * What is under test here cannot be reached from a unit:
 *
 * - the status line reads the O(1) projection and NEVER the O(surface) meter;
 * - `/context` is what asks for the meter, and only while it is open;
 * - `c` inside `/context` dispatches the REGISTERED `/compact` command, the
 *   same line a person types, rather than a second control path;
 * - a compaction is projected from its own durable event, and the command's own
 *   result does not then say it a second time;
 * - bare `/usage` inspects while `/usage cost` still changes the preference
 *   without opening anything.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context as RealContext } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/** The projection cut the fixture's registry serves. */
const CUT: ProjectionSnapshot = {
  asOfSeq: 4,
  values: {
    contextPressure: { pressureTokens: 184_000, projectedTokens: 184_000, contextWindow: 1_000_000 },
    contextBreakdown: { systemTokens: 12_000, toolsTokens: 48_000, messageTokens: 124_000 },
    tokenUsage: {
      uncachedInputTokens: 317_000,
      cacheReadTokens: 1_980_000,
      cacheWriteTokens: 13_000,
      outputTokens: 42_000,
    },
  },
}

/** A measurement over two surface nodes the fixture's log carries. */
function measurement(): TokenMeasurement {
  return {
    logRevision: 2,
    baseline: { kind: 'none', tokens: 0 },
    surfaceDeltaTokens: 0,
    totalTokens: 999_999,
    surfaceTokens: 50_000,
    nodes: [{ seq: 0, tokens: 42_000 }, { seq: 1, tokens: 8_000 }],
  } as unknown as TokenMeasurement
}

/** The assembled attachment, with every capability this feature reads. */
async function fixture(options: {
  readonly compactRegistered?: boolean
  readonly meter?: boolean
  readonly projections?: boolean
  readonly executeResult?: { commandId: string; result: { kind: 'error'; text: string } | { kind: 'success' } }
  readonly execute?: () => Promise<{ commandId: string; result: { kind: 'error'; text: string } | { kind: 'success' } }>
} = {}): Promise<{
  dispatch: () => ((key: Key) => void) | undefined
  ctx: RealContext
  session: Session
  commands: { execute: ReturnType<typeof vi.fn>; list: () => { name: string; description: string }[] }
  measured: () => number
  commits: string[][]
  frames: Array<{ lines: string[] }>
  draw: () => void
}> {
  const ctx = new RealContext()
  await ctx.plugin(TuiSlots)
  ctx.provide('tools', { get: () => undefined })
  const registered = options.compactRegistered ?? true
  const commands = {
    execute: vi.fn(
      options.execute ?? (async () => options.executeResult ?? { commandId: 'c-1', result: { kind: 'success' } }),
    ),
    list: () => registered ? [{ name: 'compact', description: 'Compact older conversation history' }] : [],
  }
  ctx.provide('commands', commands as never)
  ctx.provide('userQuestions', {} as never)
  if (options.projections !== false) {
    ctx.provide('sessionProjections', {
      snapshot: () => CUT,
      onChanged: () => () => {},
    } as never)
  }
  let measured = 0
  if (options.meter !== false) {
    ctx.provide('tokenMeter', {
      measure: () => {
        measured += 1
        return measurement()
      },
    } as never)
  }

  const commits: string[][] = []
  const frames: Array<{ lines: string[] }> = []
  let dispatch: ((key: Key) => void) | undefined
  const compose = (): void => { frames.push(ctx.tuiSlots.compose(80, 40)) }
  const events: SessionEvent[] = [
    {
      type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
      data: { id: 'm-0', role: 'user', content: [{ type: 'text', text: 'a'.repeat(400) }], source: { kind: 'user' } },
    } as unknown as SessionEvent,
    {
      type: 'user/message', seq: 1, time: 1, surfaceOp: 'append',
      data: { id: 'm-1', role: 'user', content: [{ type: 'text', text: 'short' }], source: { kind: 'user' } },
    } as unknown as SessionEvent,
  ]
  const session = {
    id: 's-1',
    header: { cwd: '/ws' },
    seq: events.length,
    eventAt: (seq: number) => events[seq],
    surface: { nodes: [0, 1], replaceGeneration: 0 },
  } as unknown as Session

  const window = {
    ctx,
    terminal: { columns: () => 80, rows: () => 40 },
    exit: undefined,
    startup: { cwd: '/ws', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    modelInfo: { contextWindow: 1_000_000, reasoning: undefined },
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
    // A fresh session, so nothing waits on a transcript read.
    target: { kind: 'new', cwd: '/ws' },
    attached: { handle: { agent, dispose: async () => {} }, reopened: false },
  } as unknown as AttachOutcome

  void attachSession(window, outcome)
  return {
    dispatch: () => dispatch,
    ctx,
    session,
    commands,
    measured: () => measured,
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

/** The status row of the latest composed frame. */
function status(frames: Array<{ lines: string[] }>): string {
  const lines = frames.at(-1)?.lines ?? []
  return stripAnsi(lines[lines.length - 1] ?? '')
}

/**
 * Submit one line through the real composer.
 * @param dispatch - the window's input route.
 * @param line - the line to type and send.
 */
function submit(dispatch: ((key: Key) => void) | undefined, line: string): void {
  expect(dispatch, 'the window must be routing input').toBeDefined()
  for (const char of [...line]) dispatch?.({ kind: 'text', text: char })
  dispatch?.({ kind: 'key', name: 'enter' })
}

describe('the status line’s context reading', () => {
  it('reads the O(1) projection and never the O(surface) meter', async () => {
    const { frames, draw, measured } = await fixture()
    await flush()
    // Every frame the spinner, a streamed delta, or a tool transition would
    // cause. The old reading called `measure()` — which prices and clones every
    // surface node — once per one of these.
    for (let redraw = 0; redraw < 25; redraw += 1) draw()
    expect(measured()).toBe(0)
    // And the figure on screen is the projection's, not the measurement's
    // `totalTokens` (999,999 above, deliberately unmistakable).
    expect(status(frames)).toContain('184k/1.0M')
    expect(status(frames)).not.toContain('999')
  })

  it('reports no context reading at all when the profile mounts no projections', async () => {
    const { frames, draw } = await fixture({ projections: false, meter: false })
    await flush()
    draw()
    // No numerator, so nothing is drawn — the status line still reports the
    // rest of its facts rather than failing.
    expect(status(frames)).not.toContain('/1.0M')
    expect(status(frames)).toContain('ready')
  })
})

describe('/context', () => {
  it('measures on open, and once for many repaints of the same surface', async () => {
    const { dispatch, frames, draw, measured } = await fixture()
    await flush()
    submit(dispatch(), '/context')
    await flush()

    const body = latest(frames)
    expect(body).toContain('Context')
    expect(body).toContain('184k / 1.0M · 18%')
    expect(body).toContain('Largest entries')
    expect(measured()).toBe(1)

    // The overlay redraws on every projection change and every spinner beat
    // while it is open; the surface has not moved, so nothing is remeasured.
    for (let redraw = 0; redraw < 10; redraw += 1) draw()
    expect(measured()).toBe(1)
  })

  it('resolves an entry against the durable log and previews its content', async () => {
    const { dispatch, frames, draw } = await fixture()
    await flush()
    submit(dispatch(), '/context')
    await flush()
    dispatch()?.({ kind: 'key', name: 'enter' })
    // The overlay asks for a redraw through the registry; the production runner
    // paints on that notification, and this fixture composes on demand.
    draw()
    const detail = latest(frames)
    expect(detail).toContain('Context entry')
    expect(detail).toContain('type       your message')
    expect(detail).toContain('log entry  seq 0')
    // The preview is the content the model carries, read through Harness's own
    // per-node derivation.
    expect(detail).toContain('aaaa')
  })

  it('dispatches the REGISTERED /compact from `c`, with no second control path', async () => {
    const { dispatch, commands } = await fixture()
    await flush()
    submit(dispatch(), '/context')
    await flush()
    dispatch()?.({ kind: 'text', text: 'c' })
    await flush()

    expect(commands.execute).toHaveBeenCalledTimes(1)
    const call = commands.execute.mock.calls[0] as unknown[]
    // The same line a person types, through `ctx.commands` — not `ctx.compaction`.
    expect(call[1]).toBe('/compact')
  })

  it('offers no compaction key when this agent has no registered command', async () => {
    const { dispatch, frames, commands } = await fixture({ compactRegistered: false })
    await flush()
    submit(dispatch(), '/context')
    await flush()
    expect(latest(frames)).not.toContain('c compact')
    dispatch()?.({ kind: 'text', text: 'c' })
    await flush()
    expect(commands.execute).not.toHaveBeenCalled()
  })

  it('surfaces a /compact command error inside the inspector instead of hiding it', async () => {
    const { dispatch, frames, draw } = await fixture({
      executeResult: { commandId: 'c-1', result: { kind: 'error', text: 'Already compacting the session.' } },
    })
    await flush()
    submit(dispatch(), '/context')
    await flush()
    dispatch()?.({ kind: 'text', text: 'c' })
    await flush()
    // The command lifecycle is committed underneath; the overlay re-renders the
    // classified text so a busy or failed compaction is visible without closing.
    draw()
    expect(latest(frames)).toContain('Already compacting the session.')
  })

  it('keeps reporting compaction until the first dispatch settles, even when a second is refused', async () => {
    // Two overlapping typed `/compact` runs: the first is accepted and stays
    // pending while the harness summarizer works; the second is refused `busy`
    // by Harness and settles first. The in-flight counter must keep the status
    // on `compacting` until the FIRST settles.
    let settleFirst!: (execution: { commandId: string; result: { kind: 'success' } }) => void
    const first = new Promise<{ commandId: string; result: { kind: 'success' } }>(resolve => {
      settleFirst = resolve
    })
    let calls = 0
    const { dispatch, frames, draw } = await fixture({
      execute: async () => {
        calls += 1
        if (calls === 1) return first
        return { commandId: 'c-2', result: { kind: 'error', text: 'Already compacting the session.' } }
      },
    })
    await flush()
    submit(dispatch(), '/compact')
    await flush()
    draw()
    expect(status(frames)).toContain('compacting')

    submit(dispatch(), '/compact')
    await flush()
    draw()
    // The second dispatch settled with `busy`; the first is still in flight.
    expect(calls).toBe(2)
    expect(status(frames)).toContain('compacting')

    settleFirst({ commandId: 'c-1', result: { kind: 'success' } })
    await flush()
    await flush()
    draw()
    expect(status(frames)).not.toContain('compacting')
    expect(status(frames)).toContain('ready')
  })

  it('says what it can when no meter is mounted, and still closes', async () => {
    const { dispatch, frames, draw } = await fixture({ meter: false })
    await flush()
    submit(dispatch(), '/context')
    await flush()
    const body = latest(frames)
    // The projections still answer occupancy and composition; only the
    // per-entry X-ray is gone.
    expect(body).toContain('184k / 1.0M')
    expect(body).toContain('Per-entry measurement is unavailable')
    dispatch()?.({ kind: 'key', name: 'escape' })
    draw()
    expect(latest(frames)).not.toContain('Per-entry measurement')
  })
})

describe('compaction presentation', () => {
  /** The trio a backend appends, manual or automatic. */
  const compaction = (manual: boolean): SessionEvent[] => {
    const owner = manual ? { sourceCommandId: 'cmd-1' } : {}
    return [
      { type: 'compaction/start', seq: 10, time: 1, data: { compactionId: 'x', turn: null, ...owner } },
      {
        type: 'compaction/summary', seq: 11, time: 1,
        data: {
          compactionId: 'x', ...owner,
          summary: [{ type: 'text', text: 's' }],
          shadowedRange: { start: 0, end: 1 },
          shadowedSeqs: [0, 1],
          shadowedTokenCount: 95_000,
          provider: 'p', model: 'm',
        },
      },
      { type: 'compaction/end', seq: 12, time: 1, data: { compactionId: 'x', turn: null, ...owner } },
    ] as unknown as SessionEvent[]
  }

  it('projects a manual compaction from its event, and lets the command result stay silent', async () => {
    const { ctx, session, commits } = await fixture()
    await flush()
    ctx.emit('session/event', session, {
      type: 'command/run', seq: 9, time: 1,
      data: { commandId: 'cmd-1', name: 'compact', source: { kind: 'user' } },
    } as unknown as SessionEvent)
    for (const event of compaction(true)) ctx.emit('session/event', session, event)
    ctx.emit('session/event', session, {
      type: 'command/done', seq: 13, time: 1,
      data: {
        commandId: 'cmd-1',
        kind: 'success',
        text: 'Compacted 2 history items (~95000 tokens).',
        sourceEventSeq: 11,
      },
    } as unknown as SessionEvent)

    const transcript = commits.flat().join('\n')
    expect(transcript).toContain('compacted 2 entries · ~95k replaced')
    // Exactly once: the command result cited the event this transcript already
    // presented, so its own prose is not printed on top of it.
    expect(transcript).not.toContain('Compacted 2 history items')
    expect(transcript.match(/replaced/gu)?.length).toBe(1)
  })

  it('reports an automatic compaction, which has no command lifecycle at all', async () => {
    const { ctx, session, commits } = await fixture()
    await flush()
    for (const event of compaction(false)) ctx.emit('session/event', session, event)
    expect(commits.flat().join('\n')).toContain('context compacted automatically · 2 entries · ~95k replaced')
  })

  it('still prints a command result that cites an event this transcript never showed', async () => {
    const { ctx, session, commits } = await fixture()
    await flush()
    ctx.emit('session/event', session, {
      type: 'command/run', seq: 9, time: 1,
      data: { commandId: 'cmd-2', name: 'compact', source: { kind: 'user' } },
    } as unknown as SessionEvent)
    ctx.emit('session/event', session, {
      type: 'command/done', seq: 10, time: 1,
      data: { commandId: 'cmd-2', kind: 'success', text: 'Compacted 2 history items.', sourceEventSeq: 999 },
    } as unknown as SessionEvent)
    // The correlation is honoured only as evidence, never as a promise: a
    // command whose domain event this frontend does not project must still say
    // that it ran.
    expect(commits.flat().join('\n')).toContain('Compacted 2 history items.')
  })
})

describe('/usage', () => {
  it('inspects when bare, reporting Harness buckets beside dshline’s cost', async () => {
    const { dispatch, frames } = await fixture()
    await flush()
    submit(dispatch(), '/usage')
    await flush()
    const body = latest(frames)
    expect(body).toContain('Usage')
    expect(body).toContain('input')
    expect(body).toContain('2.3M')
    expect(body).toContain('cache read')
    expect(body).toContain('cache read share')
    expect(body).toContain('status line')
    expect(body).toContain('s status display · esc close')
  })

  it('changes the preference immediately from an explicit argument, with no overlay', async () => {
    const { dispatch, frames, commits } = await fixture()
    await flush()
    submit(dispatch(), '/usage tokens')
    await flush()
    expect(commits.flat().join('\n')).toContain('usage: tokens')
    expect(latest(frames)).not.toContain('s status display')
    // And the status line follows it: tokens without the money.
    expect(status(frames)).toMatch(/↑\S+ ↓\S+/u)
    expect(status(frames)).not.toContain('$')
  })

  it('rejects an unknown argument by name, offering the ones that exist', async () => {
    const { dispatch, commits } = await fixture()
    await flush()
    submit(dispatch(), '/usage sideways')
    await flush()
    const transcript = commits.flat().join('\n')
    expect(transcript).toContain('no usage setting named sideways')
    expect(transcript).toContain('cost, tokens, off')
  })
})
