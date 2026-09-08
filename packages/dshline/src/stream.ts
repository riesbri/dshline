/**
 * The assistant's own output: reasoning, then reply, as it arrives.
 *
 * This module owns every line the assistant produces, both the streamed form and
 * the committed one, because they represent one response and only one
 * presentation may reach the screen. A reply arrives as deltas, is written into
 * scrollback one completed line at a time, and only its unfinished trailing line
 * stays in the live region. `assistant/message` then contributes what streaming
 * could not have shown — the last partial line, or the whole reply from a
 * provider that does not stream at all. The assembled assistant message is
 * authoritative, and streamed content normally corresponds to its prefix. The
 * only reasoning mismatch treated as presentation-equivalent is trailing
 * whitespace at the stream boundary; substantive or internal divergence is not
 * equivalent and falls back to the assembled form. Native scrollback already
 * committed from the stream cannot be retracted.
 *
 * Committing as lines complete is what keeps the cost flat. Holding the whole
 * reply live meant re-escaping, re-splitting, and retransmitting all of it on
 * every delta, so an 11 KB answer cost 2.6 MB of terminal writes and grew
 * quadratically; a completed line is written once and never revisited, and the
 * live region stays one unfinished line regardless of how long the answer runs.
 *
 * Every string here came from a model, so every string is escaped before it is
 * returned. Reasoning and reply are separate channels because they are separate
 * content: the model's own working notes are styled apart from its answer, and
 * emitting the first reply delta is what marks the reasoning finished.
 * @module dshline/stream
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MarkdownRenderer } from '@dshline/renderer'
import {
  createMarkdownRenderer,
  displayWidth,
  escapeControls,
  hangingIndent,
  paint,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'

/**
 * The two kinds of assistant output, in the order a model emits them.
 *
 * `reasoning` arrives first when the model produces any, and the first `text`
 * delta is the signal that it stopped — the log carries no separate marker.
 */
export type StreamChannel = 'reasoning' | 'text'

/**
 * Rows of the unfinished line kept in the live region.
 *
 * The live region is redrawn by climbing rows, so it must stay shorter than the
 * screen: a region taller than the terminal leaves the cursor unable to reach its
 * first row, which corrupts every later redraw. One logical line can still wrap
 * past this, so it is shown from its end — the interesting part while text is
 * being appended is the part that just arrived.
 */
const LIVE_ROWS = 4

/**
 * Marks the elision when the unfinished line is longer than the live region.
 *
 * It costs a column, and that column has to come out of the row's content budget:
 * a full wrapped row is already exactly as wide as the space available, so
 * prepending this without reserving room makes the row one column too wide, and
 * the screen wraps it into two. Four nominal rows become six, which is how a
 * bounded live region stops being bounded.
 */
const ELLIPSIS = '…'

/** Gutter marks: one for the model's working notes, one for its answer. */
const MARK = {
  reasoning: '✻',
  text: '●',
} as const

/** Gutter for a continuation row, aligning it under the mark. */
const CONTINUATION = '  '

/** What one channel has produced so far. */
interface ChannelState {
  /**
   * Everything pushed on this channel, kept to reconcile with the assembled
   * message. Normally the assembled text starts with it. For reasoning, only
   * trailing whitespace at the stream boundary is presentation-equivalent;
   * substantive or internal divergence is handled by the assembled fallback.
   */
  pushed: string
  /** The unfinished trailing line, which has not been committed. */
  pending: string
  /** Whether this channel's gutter mark has already been written. */
  opened: boolean
  /**
   * Blank rows produced but not yet committed.
   *
   * A blank line's meaning depends on what follows it. Leading blanks are not part
   * of the reply and trailing ones only pad the composer down, but a blank BETWEEN
   * paragraphs is content — and while streaming, there is no way to tell which kind
   * has arrived until a later non-blank line proves it internal. Committing
   * eagerly made an identical reply render differently depending on whether the
   * provider chunked it: a reply beginning with a newline opened with an empty
   * marked row, where the assembled path trims it away.
   */
  blanks: number
  /** Block state, so a fenced block spanning committed lines stays a code block. */
  markdown: MarkdownRenderer
}

/** A fresh, empty channel. */
function emptyChannel(): ChannelState {
  return { pushed: '', pending: '', opened: false, blanks: 0, markdown: createMarkdownRenderer() }
}

/**
 * The text of every block of one type, concatenated.
 * @param content - message content blocks.
 * @param type - the block type to keep.
 * @returns the joined text, empty when the message carries no such block.
 */
function textOfType(content: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' | 'reasoning' }> => block.type === type)
    .map(block => block.text)
    .join('')
}

/**
 * Accumulates one assistant attempt's output and hands back lines to commit.
 *
 * One instance spans one model attempt: {@link settle} commits its remainder
 * against the durable `assistant/message` that ends it, and {@link reset}
 * returns the buffer to its initial state for the next one.
 *
 * There is deliberately no "commit whatever is pending" escape. Every attempt
 * settles durably — a visible reply as `assistant/message`, an interrupted
 * prefix as the same event with `interrupted: true`, and an attempt that
 * produced no reply at all as the log-only `assistant/attempt` — so an
 * unfinished line either belongs to a message that is about to settle it, or
 * belongs to no reply and must not be committed as one.
 */
export class StreamBuffer {
  private readonly channels: Record<StreamChannel, ChannelState> = {
    reasoning: emptyChannel(),
    text: emptyChannel(),
  }

  /** Whether reasoning rows are projected into the terminal. */
  private reasoningVisible: boolean

  /** Whether hidden reasoning has entered this turn's authoritative stream. */
  private reasoningHadHiddenContent = false

  /** The channel currently receiving deltas, or none before the first one. */
  private current: StreamChannel | undefined

  /**
   * @param reasoningVisible - whether reasoning should be rendered initially.
   */
  constructor(reasoningVisible = true) {
    this.reasoningVisible = reasoningVisible
  }

  /**
   * Change reasoning projection without dropping its reconciliation prefix.
   *
   * The received prefix stays in `pushed` so an assembled message can still settle
   * against every delta, while the unfinished presentation tail is discarded at
   * the visibility boundary. This prevents a later show from replaying hidden text
   * and prevents a later hide from leaving a live row behind.
   * @param visible - whether future reasoning should be rendered.
   */
  setReasoningVisible(visible: boolean): void {
    if (this.reasoningVisible === visible) return
    this.reasoningVisible = visible
    this.clearPresentation(this.channels.reasoning)
  }

  /**
   * Take one delta and return whatever it completed.
   *
   * Only whole lines are committed. A delta that adds no newline changes the live
   * region alone, which is the common case and costs one short redraw. Hidden
   * reasoning still advances the received prefix, but contributes no rows.
   * @param channel - which kind of output this delta belongs to.
   * @param delta - the text fragment, exactly as the model sent it.
   * @param columns - the terminal's current width, for the gutter's hanging indent.
   * @returns rows to write into scrollback, in order.
   */
  push(channel: StreamChannel, delta: string, columns: number): string[] {
    const out: string[] = []
    // Answering closes reasoning, but a reasoning delta arriving between answer
    // deltas must not close the answer. Flushing in both directions commits an
    // unfinished answer prefix before the reasoning, so the resumed suffix lands
    // below it and the two channels visibly interlace.
    if (channel === 'text' && this.current === 'reasoning') out.push(...this.flush('reasoning', columns))
    this.current = channel
    const state = this.channels[channel]
    state.pushed += delta
    if (channel === 'reasoning' && !this.reasoningVisible) {
      if (delta !== '') this.reasoningHadHiddenContent = true
      return out
    }
    state.pending += delta
    const cut = state.pending.lastIndexOf('\n')
    if (cut < 0) return out
    const complete = state.pending.slice(0, cut)
    state.pending = state.pending.slice(cut + 1)
    out.push(...this.emit(channel, complete.split('\n'), columns))
    return out
  }

  /**
   * Reconcile the streamed presentation with the assembled assistant message.
   *
   * The assembled assistant message is authoritative. Streamed content normally
   * corresponds to its prefix, so the assembled message contributes only the
   * remainder — the last unterminated line for a streamed reply, or the whole
   * reply for a provider that does not stream. Only a reasoning mismatch made of
   * trailing whitespace at the stream boundary is presentation-equivalent and
   * contributes no duplicate rows. Substantive, internal, or other content
   * divergence is not equivalent and falls back to the authoritative assembled
   * form. Already committed native scrollback cannot be retracted, so preserving
   * the assembled form is safer than silently dropping it.
   * @param content - the assembled assistant message's content blocks.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback, reasoning before reply.
   */
  settle(content: readonly ContentBlock[], columns: number): string[] {
    return [
      ...this.settleChannel('reasoning', textOfType(content, 'reasoning'), columns),
      ...this.settleChannel('text', textOfType(content, 'text'), columns),
    ]
  }

  /** Return to the initial state, discarding channel and block state. */
  reset(): void {
    this.channels.reasoning = emptyChannel()
    this.channels.text = emptyChannel()
    this.reasoningHadHiddenContent = false
    this.current = undefined
  }

  /**
   * Blank rows held for a channel, for tests that assert nothing is left pending.
   * @param channel - the channel to read.
   * @returns how many blank rows are held back.
   */
  heldBlanks(channel: StreamChannel): number {
    return this.channels[channel].blanks
  }

  /**
   * The live-region rows for the unfinished line, or none when there is none.
   *
   * While a turn is running this is the only moving part of the screen, so it is
   * deliberately small: everything already complete is in scrollback, above and
   * behind it.
   * @param columns - the terminal's current width.
   * @returns rows for the live region.
   */
  live(columns: number): string[] {
    const channel = this.current
    if (channel === undefined) return []
    if (channel === 'reasoning' && !this.reasoningVisible) return []
    const state = this.channels[channel]
    if (state.pending === '') return []
    // The budget is what is left after the gutter, and it may NOT exceed that: a
    // wider budget produces rows wider than the terminal, the screen wraps each of
    // them again, and the nominal four rows become as many physical ones as the
    // overflow demands. Past that point the region can be taller than the screen,
    // and the redraw can no longer climb to its first row. A terminal too narrow
    // for even one content column gets no stream region rather than a broken one.
    const budget = columns - CONTINUATION.length
    if (budget < 1) return []
    // Cut the source before wrapping. A reply that never emits a newline would
    // otherwise make each redraw cost the whole reply again, which is the
    // quadratic term this class exists to remove; two columns per character is
    // the widest any character gets, so this keeps every row that can be shown.
    const visible = state.pending.slice(-budget * LIVE_ROWS)
    // The unfinished line is markdown too: it is the same text the committed
    // path renders, one newline earlier, so it is drawn through the same inline
    // formatter against the same block state. A closed span is styled the moment
    // it closes instead of flipping when the line commits, and a partial line
    // inside a fence reads as code. Only the reply is parsed: reasoning is the
    // model's working notes, shown as written.
    const rendered = channel === 'reasoning'
      ? paint(escapeControls(visible), 'reasoning')
      : state.markdown.partial(visible, visible.length === state.pending.length)
    // A markdown partial that renders to nothing — the tail of a bare fence
    // marker — has no rows to show, and a head mark with no content after it
    // would read as a bug rather than as nothing. Reasoning is never empty this
    // way: it is only escaped and styled, so it keeps whatever width it arrived
    // with, even a lone zero-width character, rather than vanishing for a redraw.
    if (channel !== 'reasoning' && displayWidth(rendered) === 0) return []
    const rows = wrapToWidth(rendered, budget)
    const shown = rows.slice(-LIVE_ROWS)
    const elided = shown.length < rows.length || visible.length < state.pending.length
    const [first = '', ...rest] = shown
    const head = state.opened ? CONTINUATION : `${this.mark(channel)} `
    // Every row is cut to the budget, not just the elided one. `wrapToWidth` must
    // emit a two-column glyph even when the budget is one column — refusing would
    // make no progress and never terminate — so at a three-column terminal a CJK
    // character comes back wider than the row it was wrapped for. Cutting here is
    // what makes "no row exceeds the terminal" true for every input rather than
    // for the common ones.
    return [
      // The blank spacer belongs to the mark: once the mark is committed, the
      // live rows continue lines directly above them and must stay attached.
      ...state.opened ? [] : [''],
      elided
        ? `${head}${paint(ELLIPSIS, 'muted')}${truncateToWidth(first, budget - 1)}`
        : `${head}${truncateToWidth(first, budget)}`,
      ...rest.map(row => `${CONTINUATION}${truncateToWidth(row, budget)}`),
    ]
  }

  /**
   * Commit one channel's remainder against the assembled text.
   * @param channel - the channel to settle.
   * @param full - the assembled text for that channel, possibly empty.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private settleChannel(channel: StreamChannel, full: string, columns: number): string[] {
    const state = this.channels[channel]
    if (channel === 'reasoning' && !this.reasoningVisible) {
      // Reconciliation still records the assembled authority, but no assembled
      // reasoning may leak after a hidden stream or a provider mismatch.
      state.pushed = full
      this.clearPresentation(state)
      return []
    }
    if (full === '' && state.pending === '') return []
    // Some providers close a reasoning item without preserving the trailing line
    // break that arrived in its deltas. The bytes are the same content for a
    // reader, but a strict prefix check would fall into the divergence fallback
    // and append that content a second time. Ignore only trailing whitespace here;
    // substantive, internal, or other content divergence still uses the
    // authoritative assembled fallback below.
    const reasoningMatchesWithoutTrailingWhitespace = channel === 'reasoning'
      && full.trimEnd() === state.pushed.trimEnd()
    if (!full.startsWith(state.pushed) && !reasoningMatchesWithoutTrailingWhitespace) {
      if (channel === 'reasoning' && this.reasoningHadHiddenContent) {
        // Once hidden and visible epochs share one assembled block, divergence
        // makes its origin unknowable. Keep only the current visible tail, which
        // is already known to have come from this presentation epoch.
        const visible = this.flush(channel, columns)
        state.pushed = full
        return visible
      }
      // The forms diverged, so nothing about the streamed copy can be trusted to
      // align: render the assembled text from the start, with its own block state.
      state.markdown = createMarkdownRenderer()
      state.pending = ''
      state.pushed = full
      return this.emit(channel, full.trim().split('\n'), columns)
    }
    const remainder = state.pending + full.slice(state.pushed.length)
    state.pushed = full
    state.pending = ''
    // A reply commonly ends in a newline, and trailing blank lines would push the
    // composer down for nothing. Leading whitespace is only trimmed when nothing
    // streamed, because otherwise it was already committed as it arrived.
    // trimEnd rather than a `/\s+$/` replace: that pattern retries at every
    // position on a long run of trailing whitespace, which is the same quadratic
    // blow-up the bounded patterns in the markdown renderer exist to avoid, and
    // this input comes straight from a model.
    const body = state.opened ? remainder.trimEnd() : remainder.trim()
    if (body === '') return []
    return this.emit(channel, body.split('\n'), columns)
  }

  /**
   * Commit a channel's unfinished line, if it has one.
   * @param channel - the channel to flush.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private flush(channel: StreamChannel, columns: number): string[] {
    const state = this.channels[channel]
    if (channel === 'reasoning' && !this.reasoningVisible) {
      this.clearPresentation(state)
      return []
    }
    if (state.pending === '') return []
    const pending = state.pending
    state.pending = ''
    return this.emit(channel, [pending], columns)
  }

  /**
   * Drop only the currently drawable remainder of a channel.
   * @param state - the channel whose presentation epoch is ending.
   */
  private clearPresentation(state: ChannelState): void {
    state.pending = ''
    state.opened = false
    state.blanks = 0
    state.markdown = createMarkdownRenderer()
  }

  /**
   * Style and gutter complete source lines.
   * @param channel - the channel they belong to.
   * @param sources - complete source lines, without newlines.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private emit(channel: StreamChannel, sources: readonly string[], columns: number): string[] {
    const state = this.channels[channel]
    const rendered = sources.flatMap(source => (channel === 'reasoning'
      // Reasoning is the model's working notes, not its answer: it is shown as
      // written, quietly, and never parsed as markdown — a half-formed thought is
      // not a document, and styling it like one competes with the reply.
      ? [paint(escapeControls(source), 'reasoning')]
      : state.markdown.line(source)))
    if (rendered.length === 0) return []
    const out: string[] = []
    for (const line of rendered) {
      // Judged on the RENDERED row, not the source: a blank line inside a fenced
      // block renders as indented code and is content, while a blank line in prose
      // renders to nothing at all.
      if (displayWidth(line) === 0) {
        // Before the mark exists there is nothing for a blank row to separate, so a
        // leading blank is dropped rather than held.
        if (state.opened) state.blanks += 1
        continue
      }
      const held = state.blanks
      state.blanks = 0
      for (let index = 0; index < held; index += 1) out.push('')
      const mark = state.opened ? CONTINUATION : `${this.mark(channel)} `
      if (!state.opened) out.push('')
      state.opened = true
      out.push(...hangingIndent(mark, CONTINUATION, line, columns))
    }
    return out
  }

  /**
   * The gutter mark for one channel, styled.
   * @param channel - the channel.
   * @returns the styled mark, without its trailing space.
   */
  private mark(channel: StreamChannel): string {
    return paint(MARK[channel], channel === 'reasoning' ? 'reasoning-mark' : 'assistant')
  }
}
