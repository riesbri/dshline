/**
 * Chunk-boundary behavior of the incremental stream accumulator.
 *
 * `StreamBuffer.push` commits a line the moment its newline arrives, so the rows
 * a reply produces are a function of its logical content rather than of how a
 * provider happened to split it. These specs pin that across the boundaries the
 * split can land on: a newline as a delta of its own, several newlines in one
 * delta, a delta ending exactly on a newline, a partial line carried into the
 * next delta, blank lines held or released, and an unterminated suffix committed
 * by the assembled message.
 *
 * They also guard the optimization that lets `push` search only the incoming
 * delta for its final newline. That relies on `pending` never holding a newline
 * between calls, which no output-equivalence spec can detect: the old and new
 * rows are identical, only the work differs. The scan-count spec observes the
 * spelling the optimization replaced — a search over the accumulated line —
 * while the equivalence specs above are what guard the rows themselves.
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { StreamBuffer } from '../src/stream.ts'

/** Wide enough that nothing under test wraps, so assertions read as content. */
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
 * Split `source` into fixed-size chunks by code point.
 *
 * A UTF-16 index split would cut a surrogate pair in half, so the split has to
 * walk code points: the accumulator must see the characters a provider would
 * send, not broken halves of one.
 * @param source - the text to divide.
 * @param size - code points per chunk.
 * @returns the chunks, in order.
 */
function fragmentByPoints(source: string, size: number): string[] {
  const points = [...source]
  const out: string[] = []
  for (let index = 0; index < points.length; index += size) {
    out.push(points.slice(index, index + size).join(''))
  }
  return out
}

/**
 * Split `source` after each newline, so every chunk ends with one.
 *
 * The newline that completes a line arrives attached to the text it closes,
 * which is one of the two boundaries a provider can put it on.
 * @param source - the text to divide.
 * @returns the chunks, in order.
 */
function afterNewlines(source: string): string[] {
  return source.split(/(?<=\n)/u).filter(part => part !== '')
}

/**
 * Split `source` before each newline, so every chunk starts with one.
 *
 * The other boundary: the completing newline leads its chunk, with all earlier
 * text already pending in the accumulator.
 * @param source - the text to divide.
 * @returns the chunks, in order.
 */
function beforeNewlines(source: string): string[] {
  return source.split(/(?=\n)/u).filter(part => part !== '')
}

/** The one-shot, non-incremental rendering of a reply. */
function whole(source: string): string[] {
  return plain(new StreamBuffer().settle(text(source), COLUMNS))
}

describe('newline boundaries in an incremental stream', () => {
  it('holds every unterminated delta live until the assembled message finalizes it', () => {
    const buffer = new StreamBuffer()
    const out: string[] = []
    for (let index = 0; index < 200; index += 1) out.push(...buffer.push('text', 'x', COLUMNS))

    // No line ever completed, so nothing reached scrollback...
    expect(plain(out)).toEqual([])
    // ...and the live region stayed bounded instead of growing with the line.
    const live = buffer.live(80)
    expect(live.length).toBeLessThanOrEqual(5)
    for (const row of live) expect(displayWidth(row)).toBeLessThanOrEqual(80)

    // The assembled message commits the whole line through the non-incremental
    // path, and the incrementally accumulated buffer contributes it exactly once.
    expect(plain(buffer.settle(text('x'.repeat(200)), COLUMNS))).toEqual(whole('x'.repeat(200)))
  })

  it('commits a line when its newline arrives as a delta of its own', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.push('text', 'hello', COLUMNS))).toEqual([])
    expect(plain(buffer.push('text', '\n', COLUMNS))).toEqual(['', '\u25cf hello'])
    expect(plain(buffer.push('text', 'world', COLUMNS))).toEqual([])

    // The same content in one delta reaches the same committed line.
    expect(plain(new StreamBuffer().push('text', 'hello\nworld', COLUMNS)))
      .toEqual(['', '\u25cf hello'])
  })

  it('commits every completed line when one delta carries several newlines', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.push('text', 'a\nb\nc\ntail', COLUMNS)))
      .toEqual(['', '\u25cf a', '  b', '  c'])
    expect(plain(buffer.live(80))).toEqual(['  tail'])
  })

  it('holds blank rows from a multi-newline delta until a later line places them', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.push('text', 'a\n\n\nb', COLUMNS))).toEqual(['', '\u25cf a'])
    // The two blanks are internal only if more content follows; until then they
    // are held rather than committed, and `b` is still the unfinished line.
    expect(buffer.heldBlanks('text')).toBe(2)
    expect(plain(buffer.live(80))).toEqual(['  b'])
    expect(plain(buffer.settle(text('a\n\n\nb'), COLUMNS))).toEqual(['', '', '  b'])
  })

  it('carries pending text across several completed lines and keeps only the new suffix', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.push('text', 'first partial', COLUMNS))).toEqual([])
    // The newline that completes `first partial` is in THIS delta, so the search
    // has to find it while `pending` still holds the earlier text.
    expect(plain(buffer.push('text', '\nline two\nline three\ntail', COLUMNS)))
      .toEqual(['', '\u25cf first partial', '  line two', '  line three'])
    expect(plain(buffer.live(80))).toEqual(['  tail'])
  })

  it('leaves nothing pending when a delta ends exactly in a newline', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.push('text', 'ends with newline\n', COLUMNS)))
      .toEqual(['', '\u25cf ends with newline'])
    expect(buffer.heldBlanks('text')).toBe(0)
    expect(buffer.live(80)).toEqual([])
  })

  it('holds trailing blank lines identically whether they arrive joined or split', () => {
    const joined = new StreamBuffer()
    const joinedRows: string[] = []
    joinedRows.push(...joined.push('text', 'one\n', COLUMNS))
    joinedRows.push(...joined.push('text', '\n\n', COLUMNS))
    expect(joined.heldBlanks('text')).toBe(2)
    joinedRows.push(...joined.push('text', 'three\n', COLUMNS))

    const split = new StreamBuffer()
    const splitRows: string[] = []
    splitRows.push(...split.push('text', 'one\n', COLUMNS))
    splitRows.push(...split.push('text', '\n', COLUMNS))
    expect(split.heldBlanks('text')).toBe(1)
    splitRows.push(...split.push('text', '\n', COLUMNS))
    expect(split.heldBlanks('text')).toBe(2)
    splitRows.push(...split.push('text', 'three\n', COLUMNS))

    // Both spellings hold the blanks rather than committing them eagerly; a
    // rewrite that sliced the delta without rejoining `pending` would place them
    // before `three` and change the row sequence here while the settlement specs
    // above still passed.
    expect(plain(joinedRows)).toEqual(['', '\u25cf one', '', '', '  three'])
    expect(plain(splitRows)).toEqual(plain(joinedRows))
    expect(joined.heldBlanks('text')).toBe(0)
    expect(split.heldBlanks('text')).toBe(0)
  })

  it('commits a remaining partial line when the assembled message finalizes', () => {
    const buffer = new StreamBuffer()
    expect(plain(buffer.push('text', 'committed\nfinal partial', COLUMNS)))
      .toEqual(['', '\u25cf committed'])
    expect(plain(buffer.live(80))).toEqual(['  final partial'])
    expect(plain(buffer.settle(text('committed\nfinal partial'), COLUMNS)))
      .toEqual(['  final partial'])
    expect(plain(buffer.live(80))).toEqual([])
  })
})

describe('chunking equivalence', () => {
  it('produces identical rows across fixed-size, newline-aligned, and per-character chunkings', () => {
    const sources = [
      'a\nb\nc\ntail',
      'one\n\n\nthree\n',
      'hello',
      'x\n\ny\n',
      '\n\nHello\n\n\nWorld\n\n',
      '```ts\nconst a = 1\n```\n\ndone',
    ]
    for (const source of sources) {
      const reference = whole(source)
      const chunkings: string[][] = [
        ...[1, 2, 3, 4, 5, 7, 8].map(size => fragmentByPoints(source, size)),
        afterNewlines(source),
        beforeNewlines(source),
        [...source],
      ]
      for (const chunks of chunkings) {
        const buffer = new StreamBuffer()
        const out: string[] = []
        for (const chunk of chunks) {
          out.push(...buffer.push('text', chunk, COLUMNS))
          // Committed rows are append-only: whatever a boundary has emitted is
          // the exact prefix of the final rows, so nothing was dropped,
          // duplicated, or reordered mid-stream.
          expect(plain(out), `${JSON.stringify(source)} chunked as ${JSON.stringify(chunks)}`)
            .toEqual(reference.slice(0, out.length))
        }
        out.push(...buffer.settle(text(source), COLUMNS))
        expect(plain(out), `${JSON.stringify(source)} chunked as ${JSON.stringify(chunks)}`)
          .toEqual(reference)
      }
    }
  })
})

describe('the accumulator does not rescan its pending line', () => {
  it('scans only each incoming delta for the final newline', () => {
    // No output-equivalence case can catch the difference: the old and new rows
    // are identical, only the work is not. So observe the work directly. The
    // implementation this replaced asked the whole accumulated line for its last
    // newline on every delta, which is quadratic; the optimized one asks the
    // delta. Counting the receiver length of the string searches in the loop is
    // the closest read available without a production hook, so it pins the
    // spelling the optimization removed rather than the invariant itself.
    const lastIndexOf = String.prototype.lastIndexOf
    const indexOf = String.prototype.indexOf
    let scanned = 0
    let searches = 0
    String.prototype.lastIndexOf = function (this: string, ...args: [string, number?]): number {
      scanned += this.length
      searches += 1
      return lastIndexOf.apply(this, args)
    }
    String.prototype.indexOf = function (this: string, ...args: [string, number?]): number {
      scanned += this.length
      searches += 1
      return indexOf.apply(this, args)
    }
    try {
      const buffer = new StreamBuffer()
      scanned = 0
      searches = 0
      for (let index = 0; index < 4000; index += 1) buffer.push('text', 'x', COLUMNS)
    } finally {
      String.prototype.lastIndexOf = lastIndexOf
      String.prototype.indexOf = indexOf
    }

    // One search per delta, each over the one character just received. The old
    // form scanned 1 + 2 + … + 4000 ≈ 8,000,000 characters over the same loop.
    expect(searches).toBe(4000)
    expect(scanned).toBeLessThan(4000 * 4)
  })
})
