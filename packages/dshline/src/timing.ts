/**
 * Where the current or most recently measured turn's time went.
 *
 * Finished durations come from timestamps carried by the live session events,
 * not from clock reads taken while drawing. An open turn has no closing event,
 * so its wall clock and any running tools advance against the current clock;
 * once they finish, their event timestamps replace that provisional reading.
 *
 * The one thing this deliberately does NOT claim is that the parts add up to the
 * whole. Tool calls in a step run concurrently and reasoning interleaves with
 * them across steps, so these are overlapping spans: their sum can exceed the
 * turn, and the difference is not idle time. That is why the bars are scaled
 * against the LARGEST span rather than against the turn's wall clock.
 * @module dshline/timing
 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { displayWidth, escapeControls, formatElapsed, paint, truncateToWidth } from '@dshline/renderer'
import type { TuiSlotView } from './slots.ts'
import { chromeWidth } from './chrome.ts'

/** One measured span within a turn. */
export interface TurnSpan {
  /** What was running: `reasoning`, `output`, or a tool's name. */
  readonly label: string
  /** Milliseconds the span covered. */
  readonly ms: number
  /** Whether at least one call represented by this row is still open. */
  readonly running: boolean
  /**
   * Presentation-only reveal fraction for a freshly arrived live span, 0 just
   * arrived through 1 settled; absent means fully revealed. Derived from the
   * redraw count, never from a clock, and never written back into a
   * measurement.
   */
  readonly reveal?: number
}

/** A live or finished turn, as the panel draws it. */
export interface TurnTiming {
  /** The turn's number, as the session log counts it. */
  readonly turn: number
  /** Wall clock from `turn/start` to the current or closing timestamp. */
  readonly totalMs: number
  /** Whether the closing `turn/end` has not arrived yet. */
  readonly running: boolean
  /** Spans worth drawing, longest first. */
  readonly spans: readonly TurnSpan[]
}

/** Widest a label column grows before names are cut; beyond this the bars starve. */
const LABEL_COLUMNS = 14

/** Columns between fields, so a label, bar, and duration never read as one word. */
const FIELD_GAP = 2

/** Left indent, matching the status line's. */
const INDENT = '  '

/** Fewest cells the bar area is worth drawing in at all. */
const MIN_BAR_CELLS = 4

/**
 * The bar's fill glyph.
 *
 * A mid-height stroke rather than a full block. Full-height glyphs stacked on
 * adjacent lines fused rows of near-equal length into one slab, which read as
 * overlapping bars; the stroke leaves the top and bottom of each cell empty,
 * so rows keep whitespace between them however close their durations are.
 */
const BAR_FULL = '━'

/**
 * The track glyph marking where a row's scale ends, drawn from the same
 * box-drawing family as the frames.
 *
 * The remainder used to be blank, and a blank remainder is invisible: nothing
 * showed where a partial row's scale ended, so the bar read as floating
 * inside its row rather than bounded by it.
 */
const BAR_EMPTY = '─'

/** Under a minute, tenths — a turn's steps are often seconds apart. */
const TENTHS_BELOW_MS = 60_000

/**
 * Presentation steps a freshly arrived live bar spends growing to its target.
 *
 * Three heartbeats keep the ease at the edge of notice while the working
 * spinner redraws the live area anyway. It counts heartbeat ticks, never time
 * and never renders, so nothing here can alter what a duration says.
 */
export const REVEAL_TICKS = 3

/**
 * Presentation-only tracker easing newly appeared bars into their scale.
 *
 * A bar fed purely by measurement announces itself at full width whenever it
 * is the only span so far, which reads as a flash rather than an arrival. This
 * tracker lets such a bar grow over the next few working heartbeats. Progress
 * follows those heartbeat ticks, never render counts and never time: streamed
 * chunks redraw the panel many times inside one heartbeat, and measurement
 * must react to every one of them while the ease spends nothing until the
 * heartbeat itself moves. The tracker holds no state outside the view that
 * owns it. Spans that were already folded when the panel appeared — a
 * preference toggled on mid-turn, a retained finished turn — draw at their
 * final width at once, because decoration must never replay history.
 */
export class SpanReveal {
  /** Birth tick per label; a label absent here is history, born unbounded past. */
  private readonly born = new Map<string, number>()
  private armed = false
  private armedAtPreviousRender = false
  private rendered = false

  /**
   * @param tick - reads the attachment's working-heartbeat counter, the one
   *   cadence reveal progress is allowed to follow.
   */
  constructor(private readonly tick: () => number) {}

  /**
   * Mirror the display preference.
   *
   * Going hidden also cancels decorative reveal state: a span that arrives
   * while the panel is off never arrived in front of a visible panel, so the
   * next enabled render must treat it as settled history. Leaving pending
   * reveals or the previous armed marker standing would ease such a span in
   * on re-enable, replaying an arrival nobody saw.
   * @param on - whether the timing view is currently contributing rows.
   */
  setArmed(on: boolean): void {
    this.armed = on
    if (!on) {
      this.born.clear()
      this.armedAtPreviousRender = false
    }
  }

  /**
   * Discard every pending reveal.
   *
   * Called when a measurement becomes history: a finished turn stops the
   * working heartbeat that would otherwise age its bars to full width, so a
   * partially revealed span could freeze mid-reveal forever in the retained
   * panel. Clearing here also hands the next turn's arrivals a clean tracker,
   * whatever labels they share with the turn just ended.
   */
  reset(): void {
    this.born.clear()
  }

  /**
   * Report each span's reveal fraction for this render.
   *
   * Renders sharing one heartbeat tick report identical fractions: only the
   * tick moving ages a span toward its final width.
   * @param labels - labels currently measured, longest first.
   * @returns fraction per label, 0 just arrived through 1 fully revealed.
   */
  progress(labels: readonly string[]): Map<string, number> {
    const now = this.tick()
    const established = this.rendered && this.armed && this.armedAtPreviousRender
    const out = new Map<string, number>()
    for (const label of labels) {
      if (!this.born.has(label)) {
        // First seen by a visible panel: born now. Anything else is history,
        // and a birth infinitely far in the past clamps its fraction to 1.
        this.born.set(label, established ? now : Number.NEGATIVE_INFINITY)
      }
      out.set(label, Math.min(1, (now - this.born.get(label)!) / REVEAL_TICKS))
    }
    for (const label of this.born.keys()) {
      if (!labels.includes(label)) this.born.delete(label)
    }
    this.rendered = true
    this.armedAtPreviousRender = this.armed
    return out
  }
}

/**
 * Maximum logical rows the persistent panel may claim.
 *
 * Six keeps four named spans plus an honest elision row visible without letting
 * a tool-heavy turn crowd the composer out of an ordinary 24-row terminal.
 */
const PANEL_ROWS = 6

/** The status line is the one fixed row below the timing slot. */
const STATUS_ROWS = 1

/**
 * A span's duration, at a precision that keeps distinct spans distinct.
 *
 * `formatElapsed` floors to whole seconds, which is right for a status line
 * counting a turn up but wrong here: most tool calls finish in single-digit
 * seconds, and rounding them all to `3s` collapses the differences the panel
 * exists to show.
 * @param milliseconds - the span.
 * @returns e.g. `18.2s`, `1m 04s`.
 */
function formatSpan(milliseconds: number): string {
  const value = Math.max(0, milliseconds)
  if (value >= TENTHS_BELOW_MS) return formatElapsed(value)
  return `${(value / 1000).toFixed(1)}s`
}

/** One streamed kind within one model attempt. */
interface StreamSpan {
  readonly kind: 'reasoning' | 'output'
  first: number
  last: number
}

/** One tool call awaiting its result. */
interface PendingTool {
  readonly name: string
  readonly at: number
}

/**
 * Collects timings for the live turn and retains the most recent finished one.
 *
 * Fed from the runner's LIVE feeds rather than from its shared projection, and
 * that is not an oversight. Streaming is transient: the durable log stores one
 * settled `assistant/message` per attempt and no per-delta record at all, so a
 * timer fed from a resumed session's replay would chart every historical turn
 * as though the model had thought for no time. Turn and tool boundaries come
 * from {@link observe}; the deltas between them come from {@link observeFrame}.
 */
export class TurnTimer {
  /** When the open turn began, or undefined when no turn is being measured. */
  private startedAt: number | undefined
  private turn = 0
  /** First and last delta of one kind within one attempt, keyed `kind:attemptId`. */
  private readonly streams = new Map<string, StreamSpan>()
  /** Calls awaiting their result, keyed by call id. */
  private readonly pending = new Map<string, PendingTool>()
  /** Finished milliseconds for each tool name in the open turn. */
  private readonly tools = new Map<string, number>()
  /** The last complete measurement, retained while the attachment is idle. */
  private finished: TurnTiming | undefined

  /** Forget only the open turn; a completed panel remains useful while idle. */
  private resetOpen(): void {
    this.startedAt = undefined
    this.streams.clear()
    this.pending.clear()
    this.tools.clear()
  }

  /**
   * Fold one live event into the current measurement.
   *
   * Observation is intentionally not gated by the display preference. Toggling
   * a presentation should not fabricate a partial turn beginning at the toggle,
   * and the event fold is cheap enough to keep the view immediately truthful.
   * @param event - one committed live session event.
   * @returns nothing; read the current result through {@link snapshot}.
   */
  observe(event: SessionEvent): void {
    if (event.type === 'turn/start') {
      this.resetOpen()
      this.startedAt = event.time
      this.turn = event.data.turn
      return
    }
    if (this.startedAt === undefined) return
    if (event.type === 'tool/call') {
      this.pending.set(event.data.callId, { name: event.data.name, at: event.time })
      return
    }
    if (event.type === 'tool/result') {
      // Paired by call id, exactly as the tool cards pair them: several calls can
      // be open at once, so the newest result does not belong to the newest call.
      const block = event.data.message.content[0]
      const call = this.pending.get(block.toolCallId)
      if (call === undefined) return
      this.pending.delete(block.toolCallId)
      this.tools.set(call.name, (this.tools.get(call.name) ?? 0) + Math.max(0, event.time - call.at))
      return
    }
    if (event.type !== 'turn/end') return
    this.finished = this.reading(event.time, false)
    this.resetOpen()
  }

  /**
   * Fold one live assistant-stream frame into the current measurement.
   *
   * Spans are keyed by ATTEMPT rather than by step, because an attempt is
   * exactly one contiguous model stream: a step that retried after a stream
   * error holds two of them, and one span stretched across both would report
   * the gap between them as time the model spent producing text.
   * @param frame - one ordered frame from the agent's assistant stream.
   * @returns nothing; read the current result through {@link snapshot}.
   */
  observeFrame(frame: AssistantStreamFrame): void {
    if (this.startedAt === undefined || frame.type !== 'chunk') return
    const { chunk } = frame
    const kind = chunk.type === 'reasoning-delta' ? 'reasoning' : chunk.type === 'text-delta' ? 'output' : undefined
    if (kind === undefined) return
    const key = `${kind}:${frame.attemptId}`
    const span = this.streams.get(key)
    if (span === undefined) this.streams.set(key, { kind, first: frame.time, last: frame.time })
    else span.last = frame.time
  }

  /**
   * Current live measurement, or the most recent completed turn while idle.
   * @param now - current wall clock, used only for values whose closing event has
   *   not arrived; defaults to the clock at render time.
   * @returns the current or retained measurement, or undefined in a fresh attachment.
   */
  snapshot(now = Date.now()): TurnTiming | undefined {
    return this.startedAt === undefined ? this.finished : this.reading(now, true)
  }

  /** Build one immutable reading without mutating the fold. */
  private reading(at: number, running: boolean): TurnTiming {
    const startedAt = this.startedAt ?? at
    const spans = new Map<string, { ms: number; running: boolean }>()
    for (const span of this.streams.values()) {
      const current = spans.get(span.kind)
      const ms = Math.max(0, span.last - span.first)
      spans.set(span.kind, { ms: (current?.ms ?? 0) + ms, running: false })
    }
    for (const [name, ms] of this.tools) spans.set(name, {
      ms: (spans.get(name)?.ms ?? 0) + ms,
      running: spans.get(name)?.running ?? false,
    })
    for (const call of this.pending.values()) spans.set(call.name, {
      ms: (spans.get(call.name)?.ms ?? 0) + Math.max(0, at - call.at),
      running,
    })
    return {
      turn: this.turn,
      totalMs: Math.max(0, at - startedAt),
      running,
      spans: [...spans]
        .map(([label, span]) => ({ label, ...span }))
        // A live zero says the span has begun. Once finished, a row beside 0.0s
        // measures nothing a reader can act on and is dropped as before.
        .filter(span => running || span.ms > 0)
        .sort((left, right) => right.ms - left.ms),
    }
  }
}

/**
 * The bounded timing panel as live-region lines.
 * @param profile - current or retained timing, or undefined before a live turn.
 * @param columns - the terminal's current width.
 * @param rows - maximum rows this panel may spend.
 * @returns lines for the live region, including a placeholder when no turn exists.
 */
export function timingLines(profile: TurnTiming | undefined, columns: number, rows = PANEL_ROWS): string[] {
  const height = Math.max(0, Math.min(PANEL_ROWS, rows))
  if (height === 0) return []
  const width = Math.max(1, Math.min(columns, chromeWidth(columns)))
  const headings = profile === undefined
    ? ['timing · no turn measured yet', 'timing · no turn yet', 'timing']
    : [
      `timing · turn ${String(profile.turn)} · ${formatSpan(profile.totalMs)}${profile.running ? ' · live' : ''}`,
      `timing · turn ${String(profile.turn)} · ${formatSpan(profile.totalMs)}`,
      `timing · turn ${String(profile.turn)}`,
      'timing',
    ]
  // Whole facts are dropped before the final fallback is cut. A heading ending
  // in `· 4` reads as a broken duration, not as a narrower version of one.
  const heading = headings.find(candidate => displayWidth(INDENT + candidate) <= width) ?? 'timing'
  const lines = [paint(truncateToWidth(`${INDENT}${heading}`, width), 'selection')]
  if (profile === undefined || profile.spans.length === 0 || height === 1) return lines

  const bodyRows = height - 1
  const needsElision = profile.spans.length > bodyRows
  const shownCount = needsElision ? Math.max(0, bodyRows - 1) : bodyRows
  const shown = profile.spans.slice(0, shownCount)
  if (shown.length > 0) lines.push(...spanLines(shown, width))
  if (needsElision) {
    // The count alone named rows this panel refused to draw while staying
    // silent about what they held. The LONGEST hidden span travels with the
    // count rather than their sum: these spans overlap, so a sum is work done
    // rather than time passed, and could exceed the very turn printed in the
    // heading. Facts are still given up whole, widest first, for the reason
    // the heading ladder above gives facts up — a figure cut to `· m…` would
    // read as a broken duration, not as a narrower truth.
    const hidden = profile.spans.slice(shown.length)
    const count = String(hidden.length)
    const label = `… +${count} more`
    const longestHiddenMs = Math.max(...hidden.map(span => span.ms))
    const candidates = [`${label} · max ${formatSpan(longestHiddenMs)}`, label, `… +${count}`, '…']
    const text = candidates.find(candidate => displayWidth(`${INDENT}${candidate}`) <= width) ?? '…'
    lines.push(paint(truncateToWidth(`${INDENT}${text}`, width), 'subdued'))
  }
  return lines
}

/** Render measured rows after every untrusted label has been made safe. */
function spanLines(spans: readonly TurnSpan[], width: number): string[] {
  const safe = spans.map(span => escapeControls(span.label))
  const durations = spans.map(span => formatSpan(span.ms))
  const durationWidth = Math.max(...durations.map(displayWidth))
  const indentWidth = displayWidth(INDENT)
  const gap = Math.max(1, Math.min(FIELD_GAP, width - indentWidth - durationWidth - 1))
  const labelWidth = Math.max(1, Math.min(
    LABEL_COLUMNS,
    Math.max(...safe.map(displayWidth)),
    width - indentWidth - gap - durationWidth,
  ))
  const barCells = width - indentWidth - labelWidth - durationWidth - gap * 2
  const longest = Math.max(...spans.map(span => span.ms), 1)

  return spans.map((span, index) => {
    const cut = truncateToWidth(safe[index] ?? '', labelWidth)
    // Padded by DISPLAY width, not by string length: a label with a wide
    // character measures two columns per unit, and `padEnd` counts units.
    const label = `${cut}${' '.repeat(labelWidth - displayWidth(cut))}`
    const durationText = durations[index] ?? ''
    const duration = `${' '.repeat(durationWidth - displayWidth(durationText))}${durationText}`
    if (barCells < MIN_BAR_CELLS) {
      return `${INDENT}${paint(label, 'subdued')}${' '.repeat(gap)}${paint(duration, span.running ? 'timing-active' : 'subdued')}`
    }
    // Any measured span rounds up to one cell, for the reason the context bar
    // does: a blank row beside a real duration reads as a drawing fault. A
    // freshly arrived bar starts from that same single cell and grows to its
    // target over its first few redraws.
    const targetCells = Math.max(1, Math.round((span.ms / longest) * barCells))
    const cells = Math.max(1, Math.round((span.reveal ?? 1) * targetCells))
    // Fill and track are styled separately: a track colored like its fill
    // reads as spent bar rather than unspent scale.
    const fill = paint(BAR_FULL.repeat(cells), 'timing-active')
    const track = cells < barCells ? paint(BAR_EMPTY.repeat(barCells - cells), 'subdued') : ''
    return `${INDENT}${paint(label, 'subdued')}${' '.repeat(gap)}${fill}${track}${' '.repeat(gap)}${paint(duration, span.running ? 'timing-active' : 'subdued')}`
  })
}

/**
 * Create the persistent timing slot.
 *
 * The slot owns the reveal tracker, so easing a new bar in is presentation
 * state of this view alone: it ages on the heartbeat ticks read from
 * `getTick`, adds no timer, and never reaches Harness or session state.
 * @param timer - live event fold owned by this attachment.
 * @param enabled - window preference deciding whether the view contributes rows.
 * @param getTick - reads the working spinner's heartbeat counter, which is the
 *   only thing allowed to advance a reveal.
 * @returns a view that leaves the fixed status row beneath it.
 */
export function createTimingView(
  timer: TurnTimer,
  enabled: () => boolean,
  getTick: () => number,
): TuiSlotView {
  const reveal = new SpanReveal(getTick)
  return {
    render(columns, rows = 24) {
      reveal.setArmed(enabled())
      if (!enabled()) return []
      const profile = timer.snapshot()
      if (profile === undefined) return timingLines(undefined, columns, Math.max(0, rows - STATUS_ROWS))
      if (!profile.running) {
        // A finished turn is history even when its last arrival was still
        // easing: the working heartbeat stops with it, so a partially revealed
        // bar could otherwise freeze mid-reveal forever. Draw the real widths
        // and hand the next turn's arrivals a clean tracker.
        reveal.reset()
        return timingLines(profile, columns, Math.max(0, rows - STATUS_ROWS))
      }
      // Reveal is annotation laid over measurement. Every span takes its
      // fraction from the tracker, which yields 1 for anything the panel has
      // no arrival to decorate — a toggled-on preference, a retained panel —
      // so history always draws at its real width.
      const fractions = reveal.progress(profile.spans.map(span => span.label))
      const annotated: TurnSpan[] = profile.spans.map(span => ({
        ...span,
        reveal: fractions.get(span.label) ?? 1,
      }))
      return timingLines({ ...profile, spans: annotated }, columns, Math.max(0, rows - STATUS_ROWS))
    },
  }
}
