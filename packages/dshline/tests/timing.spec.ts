import { describe, expect, it } from 'vitest'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import type { TurnTiming, TurnSpan } from '../src/timing.ts'
import { REVEAL_TICKS, SpanReveal, timingLines, TurnTimer } from '../src/timing.ts'
import { chromeWidth } from '../src/chrome.ts'

/**
 * One log event, with only the fields the timer reads.
 * @param time - the envelope's timestamp.
 * @param type - the event type.
 * @param data - the event's payload.
 * @returns the event.
 */
function event(time: number, type: string, data: unknown): SessionEvent {
  return { time, type, data } as unknown as SessionEvent
}

/**
 * A streamed delta of one kind, at one moment.
 *
 * Streaming is transient: it reaches the timer as an `agent/assistant-stream`
 * frame, never as a log event. One attempt per `step` here, which is what the
 * loop does — a step holds a second attempt only when the first one failed.
 */
const delta = (time: number, step: number, type: string): AssistantStreamFrame =>
  ({ type: 'chunk', attemptId: `s:${String(step)}`, revision: 1, index: 0, time, chunk: { type, text: 'x' } }) as unknown as AssistantStreamFrame

/** A tool call opening, and the result that closes it. */
const call = (time: number, callId: string, name: string): SessionEvent =>
  event(time, 'tool/call', { turn: 1, step: 0, callId, name, arguments: '{}' })
const result = (time: number, callId: string): SessionEvent =>
  event(time, 'tool/result', { turn: 1, step: 0, message: { content: [{ toolCallId: callId }] } })

/** The event that closes a turn. */
const ends = (time: number, turn = 1): SessionEvent =>
  event(time, 'turn/end', { turn, reason: 'complete' })

/**
 * Feed a whole turn through a fresh timer, routing each input to the feed it
 * really arrives on.
 * @param inputs - the events and stream frames, in order.
 * @returns the profile the closing `turn/end` produced, if any.
 */
function profile(inputs: readonly (SessionEvent | AssistantStreamFrame)[]): TurnTiming | undefined {
  const timer = new TurnTimer()
  for (const one of inputs) observe(timer, one)
  return timer.snapshot()
}

/**
 * Route one input to the timer method the runner would call for it.
 * @param timer - the timer under test.
 * @param input - one log event, or one assistant-stream frame.
 */
function observe(timer: TurnTimer, input: SessionEvent | AssistantStreamFrame): void {
  if ('attemptId' in input) timer.observeFrame(input)
  else timer.observe(input)
}

/** The spans of a profile as a plain label-to-milliseconds map. */
function spans(finished: TurnTiming | undefined): Record<string, number> {
  return Object.fromEntries((finished?.spans ?? []).map(span => [span.label, span.ms]))
}

describe('TurnTimer', () => {
  it('measures the turn against timestamps the log already carries', () => {
    const finished = profile([
      event(1_000, 'turn/start', { turn: 14 }),
      delta(2_000, 0, 'text-delta'),
      delta(4_000, 0, 'text-delta'),
      ends(43_800, 14),
    ])
    expect(finished?.turn).toBe(14)
    expect(finished?.totalMs).toBe(42_800)
  })

  it('pairs a tool result with its own call, not with the newest one', () => {
    // Several calls can be open at once, so the newest result does not belong to
    // the newest call. Paired by order rather than by id, `slow` would be charged
    // the fast call's two seconds and `fast` the slow one's ten.
    const finished = profile([
      event(0, 'turn/start', { turn: 1 }),
      call(0, 'a', 'slow'),
      call(1_000, 'b', 'fast'),
      result(3_000, 'b'),
      result(10_000, 'a'),
      ends(11_000),
    ])
    expect(spans(finished)).toEqual({ slow: 10_000, fast: 2_000 })
  })

  it('counts two overlapping calls in full, rather than dividing the turn between them', () => {
    // These are spans, not shares. Both tools really did run for ten seconds, and
    // their sum exceeding the turn is the information, not an error.
    const finished = profile([
      event(0, 'turn/start', { turn: 1 }),
      call(0, 'a', 'bash'),
      call(0, 'b', 'grep'),
      result(10_000, 'a'),
      result(10_000, 'b'),
      ends(10_000),
    ])
    expect(spans(finished)).toEqual({ bash: 10_000, grep: 10_000 })
    expect(finished?.totalMs).toBe(10_000)
  })

  it('sums repeated calls to one tool under its name', () => {
    const finished = profile([
      event(0, 'turn/start', { turn: 1 }),
      call(0, 'a', 'bash'),
      result(2_000, 'a'),
      call(5_000, 'b', 'bash'),
      result(6_000, 'b'),
      ends(7_000),
    ])
    expect(spans(finished)).toEqual({ bash: 3_000 })
  })

  it('measures reasoning and answering separately, and adds up the steps', () => {
    const finished = profile([
      event(0, 'turn/start', { turn: 1 }),
      delta(1_000, 0, 'reasoning-delta'),
      delta(9_000, 0, 'reasoning-delta'),
      delta(9_500, 0, 'text-delta'),
      delta(11_500, 0, 'text-delta'),
      delta(12_000, 1, 'reasoning-delta'),
      delta(22_000, 1, 'reasoning-delta'),
      ends(23_000),
    ])
    expect(spans(finished)).toEqual({ reasoning: 18_000, output: 2_000 })
  })

  it('charts nothing for a turn it did not see begin', () => {
    // Enabling the timer mid-turn would otherwise report the time since the
    // toggle as though it were the time the turn took.
    const finished = profile([delta(1_000, 0, 'reasoning-delta'), ends(9_000)])
    expect(finished).toBeUndefined()
  })

  it('starts each turn from nothing', () => {
    const timer = new TurnTimer()
    timer.observe(event(0, 'turn/start', { turn: 1 }))
    timer.observe(call(0, 'a', 'bash'))
    timer.observe(result(5_000, 'a'))
    timer.observe(ends(5_000))
    timer.observe(event(6_000, 'turn/start', { turn: 2 }))
    timer.observeFrame(delta(6_000, 0, 'text-delta'))
    timer.observeFrame(delta(8_000, 0, 'text-delta'))
    timer.observe(ends(9_000, 2))
    expect(spans(timer.snapshot())).toEqual({ output: 2_000 })
  })

  it('drops a span that finished inside one timestamp', () => {
    // A bar beside `0.0s` measures nothing a reader can act on.
    const finished = profile([
      event(0, 'turn/start', { turn: 1 }),
      call(0, 'a', 'read'),
      result(0, 'a'),
      delta(0, 0, 'text-delta'),
      delta(3_000, 0, 'text-delta'),
      ends(3_000),
    ])
    expect(spans(finished)).toEqual({ output: 3_000 })
  })

  it('ticks open totals and tools, then keeps their event-derived finish', () => {
    const timer = new TurnTimer()
    timer.observe(event(1_000, 'turn/start', { turn: 3 }))
    timer.observe(call(2_000, 'a', 'bash'))
    expect(timer.snapshot(5_000)).toMatchObject({
      turn: 3,
      totalMs: 4_000,
      running: true,
      spans: [{ label: 'bash', ms: 3_000, running: true }],
    })
    timer.observe(result(6_000, 'a'))
    expect(timer.snapshot(9_000)?.spans).toEqual([{ label: 'bash', ms: 4_000, running: false }])
    timer.observe(ends(10_000, 3))
    expect(timer.snapshot(99_000)).toMatchObject({ totalMs: 9_000, running: false })
  })

  it('observes a whole live turn even when presentation is enabled midway through it', () => {
    const timer = new TurnTimer()
    timer.observe(event(1_000, 'turn/start', { turn: 4 }))
    timer.observeFrame(delta(2_000, 0, 'reasoning-delta'))
    timer.observeFrame(delta(4_000, 0, 'reasoning-delta'))
    expect(timer.snapshot(5_000)).toMatchObject({ turn: 4, totalMs: 4_000, running: true })
    expect(spans(timer.snapshot(5_000))).toEqual({ reasoning: 2_000 })
  })
})

describe('timingLines()', () => {
  /**
   * Render a profile and strip its styling.
   * @param spans - the spans to chart, longest first.
   * @param columns - the terminal width.
   * @returns the lines a person would see.
   */
  function chart(spans: readonly Omit<TurnSpan, 'running'>[], columns = 100): string[] {
    return timingLines({
      turn: 14,
      totalMs: 42_800,
      running: false,
      spans: spans.map(span => ({ ...span, running: false })),
    }, columns).map(stripAnsi)
  }

  /** Cells in a row's bar. */
  const cells = (line: string): number => (/━+/u.exec(line) ?? [''])[0].length

  it('heads the chart with the turn and its wall clock', () => {
    expect(chart([{ label: 'bash', ms: 16_400 }])[0]).toContain('turn 14 · 42.8s')
  })

  it('scales the bars against the longest span, not against the turn', () => {
    // The spans overlap, so they do not partition the turn, and a bar measured
    // against the total would be a picture asserting a partition that is not
    // there. Against this turn's 42.8s these two would each be well under full
    // while together accounting for longer than the turn lasted.
    const lines = chart([{ label: 'bash', ms: 30_000 }, { label: 'edit', ms: 15_000 }])
    expect(cells(lines[1] ?? '')).toBeGreaterThan(0)
    expect(cells(lines[2] ?? '')).toBeCloseTo(cells(lines[1] ?? '') / 2, 0)
  })

  it('fills the longest bar further than any other', () => {
    const lines = chart([{ label: 'bash', ms: 30_000 }, { label: 'edit', ms: 1 }])
    expect(cells(lines[1] ?? '')).toBeGreaterThan(cells(lines[2] ?? ''))
  })

  it('rounds a short span up to a visible bar', () => {
    expect(chart([{ label: 'bash', ms: 100_000 }, { label: 'read', ms: 10 }])[2]).toContain('━')
  })

  it('bounds each bar with a visible track so stacked rows do not read as one slab', () => {
    // A blank remainder gave every row's bar no visible end, and full-height
    // blocks on adjacent lines fused rows of near-equal length into one block
    // wall that read as overlapping bars. The mid-height stroke keeps
    // whitespace between rows however close the durations are, and the track
    // marks where each row's scale ends.
    const lines = chart([{ label: 'bash', ms: 30_000 }, { label: 'edit', ms: 15_000 }])
    expect(lines[1]).toContain('━')
    expect(lines[1]).not.toContain('─')
    expect(lines[2]).toContain('━')
    expect(lines[2]).toContain('─')
  })

  it('reports tenths, which whole seconds would collapse', () => {
    const lines = chart([{ label: 'bash', ms: 3_900 }, { label: 'edit', ms: 3_100 }]).join('\n')
    expect(lines).toContain('3.9s')
    expect(lines).toContain('3.1s')
  })

  it('displays an escape sequence in a tool name rather than obeying it', () => {
    // Tool names come from the model, so they are untrusted like any other model
    // output, and are made safe before anything measures or colors them.
    expect(chart([{ label: '[31mevil', ms: 1_000 }]).join('\n')).toContain('^[[31mevil')
  })

  it('fits the chrome at any width', () => {
    for (const columns of [10, 14, 20, 24, 40, 60, 80, 100, 200]) {
      const lines = chart([
        { label: 'reasoning', ms: 18_200 },
        { label: 'a-very-long-tool-name', ms: 16_400 },
        { label: 'edit', ms: 3_100 },
      ], columns)
      for (const line of lines) {
        expect(displayWidth(line), `${String(columns)} columns: ${JSON.stringify(line)}`)
          .toBeLessThanOrEqual(chromeWidth(columns))
      }
    }
  })

  it('gives up the bars rather than drawing a useless one when the width runs out', () => {
    // One cell beside every row would say every span was the same length, which
    // is the one thing the chart exists to deny.
    const lines = chart([{ label: 'reasoning', ms: 18_200 }, { label: 'edit', ms: 100 }], 24).join('\n')
    expect(lines).not.toContain('━')
    expect(lines).not.toContain('─')
    expect(lines).toContain('18.2s')
  })

  it('keeps a placeholder present before this attachment measures a turn', () => {
    expect(timingLines(undefined, 100).map(stripAnsi)).toEqual(['  timing · no turn measured yet'])
  })

  it('caps span rows and reports how many were elided', () => {
    const lines = chart(Array.from({ length: 9 }, (_, index) => ({
      label: `tool-${String(index)}`,
      ms: 10_000 - index,
    })))
    expect(lines).toHaveLength(6)
    expect(lines.at(-1)).toContain('+5 more')
    expect(lines.at(-1)).toContain('max 10.0s')
  })

  it('reports the longest hidden span behind the elision row', () => {
    // A bare count named rows the panel refused to draw while saying nothing
    // about what they held. The LONGEST hidden span travels with the count,
    // not their sum: these spans overlap, so a sum is work done rather than
    // time passed, and could exceed the very turn printed in the heading.
    const lines = chart(Array.from({ length: 7 }, (_, index) => ({
      label: `tool-${String(index)}`,
      ms: 10_000 - index * 1_000,
    })))
    expect(lines).toHaveLength(6)
    expect(lines.at(-1)).toContain('+3 more')
    expect(lines.at(-1)).toContain('max 6.0s')
    expect(lines.at(-1)).not.toContain('15.0s')
  })

  it('never presents a summed hidden duration, which overlap denies', () => {
    // Three concurrent five-second calls are fifteen seconds of work but five
    // seconds of world time; the elided row reports world time, like every
    // other row on this panel.
    const lines = chart(Array.from({ length: 7 }, (_, index) => ({
      label: `tool-${String(index)}`,
      ms: 5_000,
    })))
    expect(lines.at(-1)).toContain('max 5.0s')
    expect(lines.at(-1)).not.toContain('15.0s')
  })

  it('drops the hidden maximum whole rather than cutting it on a narrow terminal', () => {
    // A total truncated to `· 1…` would read as a broken duration, which is
    // the reason the heading ladder drops facts instead of shortening them.
    const lines = chart(Array.from({ length: 7 }, (_, index) => ({
      label: `tool-${String(index)}`,
      ms: 10_000 - index * 1_000,
    })), 13)
    expect(lines.at(-1)).toBe('  … +3 more')
  })

  it('gives up the word before the count as the terminal narrows further', () => {
    const lines = chart(Array.from({ length: 7 }, (_, index) => ({
      label: `tool-${String(index)}`,
      ms: 10_000 - index * 1_000,
    })), 10)
    expect(lines.at(-1)).toBe('  … +3')
  })

  it('styles the fill cyan and the track dim', () => {
    // The track must read as unspent scale, which a fill-colored track would
    // blur into spent bar.
    const lines = timingLines({
      turn: 14,
      totalMs: 42_800,
      running: false,
      spans: [
        { label: 'bash', ms: 30_000, running: false },
        { label: 'edit', ms: 15_000, running: false },
      ],
    }, 100)
    // The longest row carries no track — it is the full scale — so read the
    // partial row beneath it.
    const fillRow = lines.find(line => line.includes('─')) ?? ''
    const trackAt = fillRow.indexOf('─')
    expect(trackAt).toBeGreaterThan(-1)
    expect(fillRow.slice(0, fillRow.indexOf('━'))).toContain('\u001b[36m')
    expect(fillRow.slice(0, trackAt)).toContain('\u001b[0m')
    // The track's own opening code sits immediately before its first glyph.
    // Checking merely for a dim code anywhere after the track would pass on
    // the strength of the dim duration at the end of the same row.
    expect(fillRow.slice(0, trackAt).endsWith('\u001b[2m')).toBe(true)
  })
})

describe('SpanReveal', () => {
  it('renders a span final when the panel had not been showing', () => {
    // A retained finished turn or a freshly attached session has no arrival
    // to decorate: its first render is its final one.
    const reveal = new SpanReveal(() => 7)
    expect(reveal.progress(['reasoning']).get('reasoning')).toBe(1)
  })

  it('renders every pre-existing span final when timing is switched on', () => {
    const reveal = new SpanReveal(() => 7)
    reveal.setArmed(false)
    reveal.setArmed(true)
    const fractions = reveal.progress(['reasoning', 'bash'])
    expect(fractions.get('reasoning')).toBe(1)
    expect(fractions.get('bash')).toBe(1)
  })

  it('ages a span across heartbeats but holds it steady within one', () => {
    let now = 10
    const reveal = new SpanReveal(() => now)
    reveal.setArmed(true)
    reveal.progress([])
    expect(reveal.progress(['reasoning']).get('reasoning')).toBe(0)
    // Event-driven renders keep arriving inside the same heartbeat — streamed
    // chunks redraw constantly — and none of them may spend reveal progress.
    expect(reveal.progress(['reasoning']).get('reasoning')).toBe(0)
    expect(reveal.progress(['reasoning']).get('reasoning')).toBe(0)
    now += 1
    expect(reveal.progress(['reasoning']).get('reasoning')).toBeCloseTo(1 / REVEAL_TICKS)
    now += 1
    expect(reveal.progress(['reasoning']).get('reasoning')).toBeCloseTo(2 / REVEAL_TICKS)
    now += 1
    expect(reveal.progress(['reasoning']).get('reasoning')).toBe(1)
    expect(reveal.progress(['reasoning']).get('reasoning')).toBe(1)
  })

  it('forgets spans that are no longer measured', () => {
    // A new turn opens with an empty reading, which prunes the tracker, so
    // the new turn's first span eases in again rather than inheriting its
    // predecessor's settled state.
    let now = 10
    const reveal = new SpanReveal(() => now)
    reveal.setArmed(true)
    reveal.progress([])
    reveal.progress(['bash'])
    reveal.progress([])
    now = 14
    expect(reveal.progress(['reasoning']).get('reasoning')).toBe(0)
  })

  it('treats a span observed while hidden as history on re-enable', () => {
    // on -> render -> off -> new span appears while hidden -> on. The span
    // never arrived in front of a visible panel, so there is no arrival to
    // decorate: going hidden must cancel pending reveals and invalidate the
    // armed marker, or the stale marker eases the newcomer in anyway.
    const reveal = new SpanReveal(() => 10)
    reveal.setArmed(true)
    reveal.progress(['reasoning'])
    reveal.setArmed(false)
    reveal.setArmed(true)
    const fractions = reveal.progress(['reasoning', 'bash'])
    expect(fractions.get('bash')).toBe(1)
    expect(fractions.get('reasoning')).toBe(1)
  })
})
