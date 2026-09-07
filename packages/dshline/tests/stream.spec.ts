import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { StreamBuffer } from '../src/stream.ts'

/** Wide enough that nothing under test wraps, so the assertions read as content. */
const COLUMNS = 200

/** Strip styling, so assertions read as what a person would see. */
function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi)
}

/** A text content block, as the assembler produces one. */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * Feed a reply in fragments and collect everything that reached scrollback.
 * @param fragments - the deltas, in order.
 * @param settle - whether the assembled message lands afterwards.
 * @returns the committed lines, styling removed.
 */
function stream(fragments: readonly string[], settle = true): string[] {
  const buffer = new StreamBuffer()
  const out: string[] = []
  for (const fragment of fragments) out.push(...buffer.push('text', fragment, COLUMNS))
  if (settle) out.push(...buffer.settle(text(fragments.join('')), COLUMNS))
  return plain(out)
}

describe('incremental commit', () => {
  it('commits a completed line as soon as its newline arrives', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.push('text', 'first', COLUMNS))).toEqual([])
    expect(plain(buffer.push('text', '\nsec', COLUMNS))).toEqual(['', '● first'])
    expect(plain(buffer.push('text', 'ond\n', COLUMNS))).toEqual(['  second'])
  })

  it('keeps only the unfinished line live, however long the reply runs', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\npartial', COLUMNS)
    // Every complete line is in scrollback; the live region does not grow with
    // the reply, which is the whole point of committing as lines finish.
    expect(plain(buffer.live(80))).toEqual(['  partial'])
  })

  it('produces exactly what a single full render produces', () => {
    // The guarantee that makes incremental commit safe: chunking must not change
    // the transcript. A one-shot settle is the non-incremental path.
    const source = '# Title\n\nsome **bold** text\n\n- a\n- b\n\n```ts\nconst a = 1\n```\n\ndone'
    const whole = stream([source])
    for (const size of [1, 3, 7, 40]) {
      const fragments = source.match(new RegExp(`.{1,${String(size)}}`, 'gsu')) ?? []
      expect(stream(fragments), `fragment size ${String(size)}`).toEqual(whole)
    }
  })

  it('keeps a fenced block styled as code across separately committed lines', () => {
    // Each committed line is rendered on its own, so without block state carried
    // between them the fence reopens per line and code is styled as prose.
    const buffer = new StreamBuffer()
    const committed: string[] = []
    for (const fragment of ['```ts\n', '- not a bullet\n', '# not a heading\n', '```\n']) {
      committed.push(...buffer.push('text', fragment, COLUMNS))
    }
    expect(plain(committed)).toEqual(['', '● ts', '    - not a bullet', '    # not a heading'])
  })

  it('renders blank lines the same whether the provider chunked the reply or not', () => {
    // The asymmetry this closes: a reply beginning with a newline used to open with
    // an empty marked row when streamed, because the blank was committed before
    // anything proved it was leading. The assembled path trims, so identical
    // content rendered differently depending on the provider.
    const source = '\n\nHello\n\n\nWorld\n\n'
    const whole = plain(new StreamBuffer().settle(text(source), COLUMNS))
    expect(whole).toEqual(['', '\u25cf Hello', '', '', '  World'])
    for (const size of [1, 2, 5, 40]) {
      expect(stream(source.match(new RegExp(`.{1,${String(size)}}`, 'gsu')) ?? []), `chunks of ${String(size)}`)
        .toEqual(whole)
    }
  })

  it('holds a blank row until a later line proves it internal', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'first\n', COLUMNS)
    // The blank has arrived but cannot be placed yet: it is a paragraph break only
    // if more text follows, and padding otherwise.
    expect(plain(buffer.push('text', '\n', COLUMNS))).toEqual([])
    expect(buffer.heldBlanks('text')).toBe(1)
    expect(plain(buffer.push('text', 'second\n', COLUMNS))).toEqual(['', '  second'])
  })

  it('discards a trailing blank rather than padding the composer down', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'only\n\n\n', COLUMNS)
    expect(buffer.heldBlanks('text')).toBe(2)
    expect(plain(buffer.settle(text('only\n\n\n'), COLUMNS))).toEqual([])
  })

  it('keeps a blank line inside a fenced block, which is code rather than nothing', () => {
    // Judged on the rendered row: inside a fence a blank source line renders as
    // indented code and must not be held back as if it were a paragraph break.
    const buffer = new StreamBuffer()
    expect(plain(buffer.settle(text('```\na\n\nb\n```'), COLUMNS)))
      // Indented twice: the fence's own two columns inside the gutter's two.
      .toEqual(['', '\u25cf   a', '    ', '    b'])
  })

  it('indents a wrapped row under the gutter, so a paragraph reads as one block', () => {
    // Model prose is one long logical line. Letting the screen wrap it dropped
    // every row after the first back to column zero, which is what made a reply
    // look ragged at any real terminal width.
    const buffer = new StreamBuffer()
    expect(plain(buffer.settle(text('aaa bbb ccc ddd eee fff'), 12)))
      .toEqual(['', '\u25cf aaa bbb', '  ccc ddd', '  eee fff'])
  })

  it('commits the last unterminated line when the assembled message lands', () => {
    expect(stream(['done ', 'at last'])).toEqual(['', '● done at last'])
  })

  it('never prints the reply twice', () => {
    const committed = stream(['alpha\n', 'beta\n', 'gamma'])
    expect(committed).toEqual(['', '● alpha', '  beta', '  gamma'])
  })

  it('commits the whole reply when the provider streamed nothing', () => {
    // A non-streaming adapter emits no chunks at all, so the assembled message is
    // the only source and must still print in full.
    const buffer = new StreamBuffer()
    expect(plain(buffer.settle(text('first\nsecond'), COLUMNS))).toEqual(['', '● first', '  second'])
  })

  it('commits the assembled reply whole when it does not extend what streamed', () => {
    // The forms cannot be aligned, and the lines already on screen cannot be
    // taken back: a duplicated reply is visible, a dropped one is not.
    const buffer = new StreamBuffer()
    buffer.push('text', 'streamed\n', COLUMNS)
    expect(plain(buffer.settle(text('something else'), COLUMNS))).toEqual(['  something else'])
  })

  it('drops the trailing newline a reply usually ends with', () => {
    expect(stream(['answer\n'])).toEqual(['', '● answer'])
  })

  it('commits an interrupted reply instead of losing it with the live region', () => {
    // ctrl-c during a turn: the loop throws before appending a message, so this
    // is the only chance to keep what the user watched arrive.
    const buffer = new StreamBuffer()
    buffer.push('text', 'half a th', COLUMNS)
    expect(plain(buffer.finish(COLUMNS))).toEqual(['', '● half a th'])
    expect(plain(buffer.live(80))).toEqual([])
  })
})

describe('reasoning', () => {
  it('hides reasoning rows while continuing to reconcile the assembled message', () => {
    const buffer = new StreamBuffer(false)
    expect(buffer.push('reasoning', 'hidden prefix', COLUMNS)).toEqual([])
    expect(buffer.live(COLUMNS)).toEqual([])
    expect(plain(buffer.settle([
      { type: 'reasoning', text: 'hidden prefix' },
      { type: 'text', text: 'visible answer' },
    ], COLUMNS))).toEqual(['', '● visible answer'])
  })

  it('does not replay hidden reasoning when visibility is enabled mid-turn', () => {
    const buffer = new StreamBuffer(false)
    buffer.push('reasoning', 'hidden prefix', COLUMNS)
    buffer.setReasoningVisible(true)
    expect(buffer.live(COLUMNS)).toEqual([])
    expect(plain(buffer.push('reasoning', ' future', COLUMNS))).toEqual([])
    expect(plain(buffer.live(COLUMNS))).toEqual(['', '✻  future'])
    expect(plain(buffer.settle([
      { type: 'reasoning', text: 'hidden prefix future' },
      { type: 'text', text: 'answer' },
    ], COLUMNS))).toEqual(['', '✻ future', '', '● answer'])
  })

  it('keeps committed reasoning while hiding its live tail and future output', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.push('reasoning', 'committed\npartial', COLUMNS))).toEqual(['', '✻ committed'])
    buffer.setReasoningVisible(false)
    expect(buffer.live(COLUMNS)).toEqual([])
    expect(plain(buffer.push('reasoning', ' future\n', COLUMNS))).toEqual([])
    expect(plain(buffer.finish(COLUMNS))).toEqual([])
  })

  it('hides assembled-only reasoning and leaves assistant text untouched', () => {
    const buffer = new StreamBuffer(false)
    expect(plain(buffer.settle([
      { type: 'reasoning', text: 'assembled thought' },
      { type: 'text', text: 'assembled answer' },
    ], COLUMNS))).toEqual(['', '● assembled answer'])
  })

  it('suppresses a divergent assembled reasoning fallback when hidden', () => {
    const buffer = new StreamBuffer(false)
    buffer.push('reasoning', 'streamed thought', COLUMNS)
    expect(plain(buffer.settle([
      { type: 'reasoning', text: 'different thought' },
      { type: 'text', text: 'answer' },
    ], COLUMNS))).toEqual(['', '● answer'])
  })

  it('does not reconstruct hidden reasoning when a later visible epoch diverges', () => {
    const buffer = new StreamBuffer(false)
    buffer.push('reasoning', 'secret prefix', COLUMNS)
    buffer.setReasoningVisible(true)
    buffer.push('reasoning', ' visible suffix', COLUMNS)

    const lines = plain(buffer.settle([
      { type: 'reasoning', text: 'assembled form from another source' },
      { type: 'text', text: 'final answer' },
    ], COLUMNS))

    expect(lines).toEqual(['', '✻  visible suffix', '', '● final answer'])
    expect(lines.join('\n')).not.toContain('secret prefix')
    expect(lines.join('\n')).not.toContain('assembled form from another source')
  })

  it('keeps committed visible reasoning unique across a hidden epoch divergence', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.push('reasoning', 'already visible\n', COLUMNS)))
      .toEqual(['', '✻ already visible'])
    buffer.setReasoningVisible(false)
    buffer.push('reasoning', 'secret prefix', COLUMNS)
    buffer.setReasoningVisible(true)
    buffer.push('reasoning', ' visible suffix', COLUMNS)

    const lines = plain(buffer.settle([
      { type: 'reasoning', text: 'divergent assembled reasoning' },
      { type: 'text', text: 'answer after divergence' },
    ], COLUMNS))

    expect(lines).toEqual(['', '✻  visible suffix', '', '● answer after divergence'])
    expect(lines.filter(line => line.includes('already visible'))).toHaveLength(0)
    expect(lines.join('\n')).not.toContain('secret prefix')
    expect(lines.join('\n')).not.toContain('divergent assembled reasoning')
  })

  it('preserves the authoritative reasoning fallback when no content was hidden', () => {
    const buffer = new StreamBuffer()
    buffer.push('reasoning', 'streamed thought', COLUMNS)
    expect(plain(buffer.settle([
      { type: 'reasoning', text: 'authoritative assembled thought' },
      { type: 'text', text: 'answer' },
    ], COLUMNS))).toEqual(['', '✻ authoritative assembled thought', '', '● answer'])
  })

  it('does not replay reasoning when assembly only omits its streamed line break', () => {
    // Codex can finish a commentary item without the newline that its streamed
    // deltas carried. The content is already committed; treating that harmless
    // boundary difference as divergence printed the same thought twice.
    const buffer = new StreamBuffer()
    expect(plain(buffer.push('reasoning', '**Preparing to export current index**\n', COLUMNS)))
      .toEqual(['', '✻ **Preparing to export current index**'])
    expect(plain(buffer.settle([
      { type: 'reasoning', text: '**Preparing to export current index**' },
    ], COLUMNS))).toEqual([])
  })

  it('clears hidden-epoch divergence state when a turn resets', () => {
    const buffer = new StreamBuffer(false)
    buffer.push('reasoning', 'old hidden thought', COLUMNS)
    buffer.setReasoningVisible(true)
    buffer.push('reasoning', 'old visible thought', COLUMNS)
    buffer.settle([
      { type: 'reasoning', text: 'old divergent thought' },
      { type: 'text', text: 'old answer' },
    ], COLUMNS)
    buffer.reset()
    expect(plain(buffer.push('reasoning', 'new streamed thought', COLUMNS))).toEqual([])
    expect(plain(buffer.settle([
      { type: 'reasoning', text: 'new assembled thought' },
      { type: 'text', text: 'new answer' },
    ], COLUMNS))).toEqual(['', '✻ new assembled thought', '', '● new answer'])
  })

  it('shows reasoning while it streams, so the UI is never just a spinner', () => {
    const buffer = new StreamBuffer()
    buffer.push('reasoning', 'weighing the options', COLUMNS)
    expect(plain(buffer.live(80))).toEqual(['', '✻ weighing the options'])
  })

  it('keeps showing reasoning even when its visible slice has zero display width', () => {
    // The markdown partial's own zero-width guard (a bare fence marker) does not
    // apply here: reasoning is only escaped and styled, never parsed, so a lone
    // zero-width character is real content, not something to hide the row for.
    const buffer = new StreamBuffer()
    buffer.push('reasoning', '​', COLUMNS)
    expect(buffer.live(80)).not.toEqual([])
  })

  it('styles reasoning apart from the reply', () => {
    const buffer = new StreamBuffer()
    const live = buffer.push('reasoning', 'thinking\n', COLUMNS)
    // Dim and italic together, so reasoning recedes behind the answer.
    expect(live.join('')).toContain('\u001b[2;3m')
    expect(plain(buffer.settle(text('the answer'), COLUMNS)).join('')).toContain('the answer')
  })

  it('closes reasoning when the first reply delta arrives', () => {
    // Nothing in the log marks the end of reasoning; the first text delta is it.
    const buffer = new StreamBuffer()
    buffer.push('reasoning', 'a thought with no newline', COLUMNS)
    expect(plain(buffer.push('text', 'The answer', COLUMNS))).toEqual(['', '✻ a thought with no newline'])
    expect(plain(buffer.live(80))).toEqual(['', '● The answer'])
  })

  it('commits reasoning before the reply when the message lands', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.settle([
      { type: 'reasoning', text: 'because' },
      { type: 'text', text: 'therefore' },
    ], COLUMNS))).toEqual(['', '✻ because', '', '● therefore'])
  })

  it('leaves reasoning unparsed, since a half-formed thought is not a document', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.settle([{ type: 'reasoning', text: '# not a heading' }], COLUMNS)))
      .toEqual(['', '✻ # not a heading'])
  })
})

describe('live region', () => {
  it('bounds itself when one line wraps past the region', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'x'.repeat(4000), COLUMNS)
    const live = buffer.live(20)
    // Taller than the terminal would leave the cursor unable to reach the
    // region's first row, corrupting every later redraw.
    expect(live.length).toBeLessThanOrEqual(5)
    expect(plain(live).join('\n')).toContain('…')
  })

  it('bounds itself for wide characters too, which fill two columns each', () => {
    // The character cut alone cannot bound the rows: it keeps a fixed number of
    // characters, and a full-width character occupies two columns, so the same
    // cut wraps to twice as many rows.
    const buffer = new StreamBuffer()
    buffer.push('text', '\u4f60'.repeat(4000), COLUMNS)
    expect(buffer.live(20).length).toBeLessThanOrEqual(5)
  })

  it('never returns a row wider than the terminal', () => {
    // A row wider than the terminal is wrapped again by the screen, so four nominal
    // rows become however many the overflow demands — and past the screen height the
    // redraw can no longer climb to the region's first row.
    //
    // The wide-glyph case is the one that needs the cut: wrapToWidth must emit a
    // two-column character even when the budget is one column, because refusing
    // would make no progress and never terminate. So at three columns a CJK
    // character arrives wider than the row it was wrapped for.
    for (const columns of [3, 4, 5, 8, 12, 20, 41]) {
      for (const filler of ['x', '\u4f60', '\u{1f600}']) {
        const buffer = new StreamBuffer()
        buffer.push('text', filler.repeat(2000), columns)
        for (const row of buffer.live(columns)) {
          expect(displayWidth(row), `${String(columns)} columns of ${JSON.stringify(filler)}`)
            .toBeLessThanOrEqual(columns)
        }
      }
    }
  })

  it('reserves a column for the elision marker', () => {
    // The first shown row is already exactly as wide as the budget allows, so the
    // marker has to come out of its content rather than be added beside it.
    const buffer = new StreamBuffer()
    buffer.push('text', 'x'.repeat(4000), 20)
    const rows = buffer.live(20)
    expect(plain(rows).some(row => row.includes('\u2026'))).toBe(true)
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(20)
  })

  it('draws nothing at all in a terminal too narrow for one content column', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'text', 2)
    expect(buffer.live(2)).toEqual([])
  })

  it('shows the end of the unfinished line, which is what just arrived', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', `${'x'.repeat(4000)}NEWEST`, COLUMNS)
    expect(plain(buffer.live(20)).join('')).toContain('NEWEST')
  })

  it('does not read a clipped suffix as the start of a markdown line', () => {
    // The live region only keeps four rows. This suffix begins at the cut, not
    // at the source-line start, so its fence-looking text is literal; parsing it
    // would hide the backticks until the line finally committed.
    const columns = 80
    const capacity = (columns - 2) * 4
    const prefix = '```'
    const suffix = `${prefix}${'x'.repeat(capacity - prefix.length)}`
    const buffer = new StreamBuffer()
    buffer.push('text', `before the cut ${suffix}`, columns)
    // Elision replaces the first visible column, leaving the other two ticks.
    expect(plain(buffer.live(columns)).join('\n')).toContain('``x')
  })

  it('attaches its rows to the committed lines above once the mark is written', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'committed\nlive part', COLUMNS)
    // No blank spacer: a blank here would detach the live rows from the lines
    // they continue.
    expect(plain(buffer.live(80))).toEqual(['  live part'])
  })

  it('shows nothing between a completed line and the next delta', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'complete\n', COLUMNS)
    expect(plain(buffer.live(80))).toEqual([])
  })

  it('escapes a control sequence in the unfinished line', () => {
    // The live region is the one place a delta reaches the terminal before any
    // committed rendering has escaped it.
    const buffer = new StreamBuffer()
    buffer.push('text', 'before \u001b[2J after', COLUMNS)
    expect(plain(buffer.live(80))).toEqual(['', '\u25cf before ^[[2J after'])
  })

  it('escapes a control sequence in streamed reasoning', () => {
    const buffer = new StreamBuffer()
    buffer.push('reasoning', 'hmm \u001b[2J', COLUMNS)
    expect(plain(buffer.live(80))).toEqual(['', '\u273b hmm ^[[2J'])
  })

  it('starts clean after a reset, keeping no state from the previous turn', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', '```\ncode\n', COLUMNS)
    buffer.reset()
    expect(plain(buffer.push('text', '# heading\n', COLUMNS))).toEqual(['', '● heading'])
  })
})

describe('live markdown', () => {
  it('styles a streamed span the moment its markers arrive', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'the **bold** part', COLUMNS)
    const rows = buffer.live(80)
    expect(rows.join('')).toContain('\u001b[1m')
    expect(plain(rows)).toEqual(['', '\u25cf the bold part'])
  })

  it('leaves a partial span literal until it closes', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', 'the **bo', COLUMNS)
    expect(plain(buffer.live(80))).toEqual(['', '\u25cf the **bo'])
  })

  it('commits the styled live line unchanged', () => {
    // The live region is the same text, one newline earlier: the moment the line
    // commits, only the mark is written and the row must not change shape.
    const buffer = new StreamBuffer()
    buffer.push('text', '**bold**', COLUMNS)
    const live = plain(buffer.live(80))
    const committed = plain(buffer.push('text', '\n', COLUMNS))
    expect(live).toEqual(['', '\u25cf bold'])
    expect(committed).toEqual(['', '\u25cf bold'])
  })

  it('renders a partial line inside a fence as code, not prose', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', '```\n', COLUMNS)
    buffer.push('text', '**raw**', COLUMNS)
    const rows = buffer.live(80)
    // Never parsed for emphasis inside a code block.
    expect(rows.join('')).not.toContain('\u001b[1m')
    expect(plain(rows)).toEqual(['', '\u25cf   **raw**'])
  })

  it('shows nothing for the bare tail of a fence marker', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', '```', COLUMNS)
    expect(buffer.live(80)).toEqual([])
  })

  it('escapes a control sequence inside a styled live span', () => {
    const buffer = new StreamBuffer()
    buffer.push('text', '**b\u001b[2J**', COLUMNS)
    const rows = buffer.live(80)
    // Styling survived the escape: the span is bold AND the control is caret
    // notation, which is exactly the escape-before-style order.
    expect(rows.join('')).toContain('\u001b[1m')
    expect(stripAnsi(rows.join(''))).toBe('\u25cf b^[[2J')
  })

  it('keeps a long streamed line bounded, however fast it arrives', () => {
    // The live region slices the pending tail before rendering, so a reply that
    // never emits a newline cannot grow the per-delta cost — this is the
    // quadratic term the class exists to remove, and the slice is the guarantee.
    const buffer = new StreamBuffer()
    buffer.push('text', `${'word '.repeat(10_000)}tail`, COLUMNS)
    const started = performance.now()
    const rows = buffer.live(80)
    const elapsedMs = performance.now() - started
    expect(rows.length).toBeLessThanOrEqual(5)
    expect(elapsedMs).toBeLessThan(100)
  })
})
