/**
 * The lazy width scan: the same measurements, read only as far as the answer.
 *
 * `truncateToWidth()` was bounded in one sense only. Its loop broke at the column
 * limit, but the tokens it looped over were built first, for the WHOLE string —
 * so retaining eighty columns of a million-character line cost a million
 * `Token` objects and sixty-odd megabytes of garbage. The scan that replaced it
 * walks the text by index, which makes the work follow the retained prefix, and
 * this file is what holds that property in place.
 *
 * Three things are therefore pinned here, and the third is the one a faster scan
 * gets wrong first:
 *
 * - EQUIVALENCE. A table of every terminal-visible shape at every boundary
 *   budget, captured from the pattern-based implementation. The styles are part
 *   of each expectation, because a cut that loses its colour is still the right
 *   characters.
 * - THE STOPPING RULE. Reaching the budget is NOT where the scan may stop. A
 *   combining mark, a variation selector, a ZWJ, or an SGR that follows the
 *   budget all belong to the answer, and the first one decides whether a reset is
 *   owed. Only a token that would push the total PAST the budget ends the walk.
 * - THE COST. A counted string proves the scan never reads past the prefix, which
 *   is a claim about work rather than about milliseconds, so it cannot be
 *   satisfied by a fast machine.
 * @module dshline/renderer/tests/width-scanner
 */

import { describe, expect, it } from 'vitest'
import { chunkToWidth, displayWidth, stripAnsi, style, truncateToWidth, wrapToWidth } from '../src/index.ts'

/** The escape this module spells `\e`, because a JavaScript string cannot. */
const ESCAPE = '\u001b'

/**
 * Put the bytes a table row spells back.
 *
 * The table spells the escape byte `\e` and the bell `\a`, and this is where they
 * become bytes again. Neither is a JavaScript escape — `'\e'` is the letter `e` —
 * so the table writes each as a backslash and a letter and decodes it here; a
 * raw byte in a table is invisible in a diff and in a failure message, and a
 * table of styling written as a table of `e` is worse than no table at all.
 * `\xNN` and `\u{…}` need nothing: those really are JavaScript escapes, so the
 * parser has already produced the character by the time the string exists.
 * @param row - one table string, before decoding.
 * @returns the string it spells.
 */
function bytes(row: string): string {
  return row
    .replace(/\\e/g, ESCAPE)
    .replace(/\\a/g, '\u0007')
}

/** Columns every scaling case retains, and the budget the tables bracket. */
const RETAINED = 80

/**
 * A string that records how far into it a caller read.
 *
 * `charCodeAt`, `slice`, and string iteration are the three ways this module
 * touches a string, so all three are instrumented: a scan that stops at the
 * retained prefix cannot reach past it through any of them. This measures WORK,
 * so it fails on a return to eager whole-string tokenization on any machine, in
 * any amount of time available.
 */
class CountedString extends String {
  /** The farthest index any instrumented read reached. */
  farthest = -1
  /** Characters yielded by string iteration. */
  yielded = 0

  override charCodeAt(index: number): number {
    this.note(index)
    return super.charCodeAt(index)
  }

  override slice(start?: number, end?: number): string {
    this.note(typeof end === 'number' ? end : this.length)
    this.note(typeof start === 'number' ? start : 0)
    return super.slice(start, end)
  }

  override [Symbol.iterator](): Iterator<string> {
    const parent = super[Symbol.iterator]()
    const counted = this
    let seen = 0
    return {
      next: (): IteratorResult<string> => {
        const step = parent.next()
        if (step.done !== true) {
          seen += 1
          counted.yielded += 1
          counted.note(seen)
        }
        return step
      },
      [Symbol.iterator](): Iterator<string> { return this },
    }
  }

  /** @param index - an index a read just reached. */
  private note(index: number): void {
    if (index > this.farthest) this.farthest = index
  }
}

/**
 * What the pattern-based implementation returned for every shape below, at every
 * budget: ASCII, CJK, emoji, supplementary-plane characters, combining marks,
 * variation selectors, ZWJ sequences, SGR styling and resets, CSI variants, OSC
 * with both terminators, malformed and bare escapes, C0/C1 controls, and
 * mixtures. Captured from the implementation this scan replaced, not written by
 * hand, so it records what the renderer DID rather than what it was meant to do —
 * and the styling is part of each expectation, because a cut that loses its
 * colour is still the right characters.
 */
const EQUIVALENCE: readonly (readonly [string, readonly (readonly [number, string])[]])[] = [
  ['', [[0, ''], [1, ''], [2, ''], [3, ''], [4, ''], [5, ''], [6, ''], [8, ''], [12, '']]] as const,
  [' ', [[0, ''], [1, ' '], [2, ' '], [3, ' '], [4, ' '], [5, ' '], [6, ' '], [8, ' '], [12, ' ']]] as const,
  ['a', [[0, ''], [1, 'a'], [2, 'a'], [3, 'a'], [4, 'a'], [5, 'a'], [6, 'a'], [8, 'a'], [12, 'a']]] as const,
  ['abcdefghij', [[0, ''], [1, 'a'], [2, 'ab'], [3, 'abc'], [4, 'abcd'], [5, 'abcde'], [6, 'abcdef'], [8, 'abcdefgh'], [12, 'abcdefghij']]] as const,
  ['the quick brown fox jumps over the lazy dog', [[0, ''], [1, 't'], [2, 'th'], [3, 'the'], [4, 'the '], [5, 'the q'], [6, 'the qu'], [8, 'the quic'], [12, 'the quick br']]] as const,
  ['标', [[0, ''], [1, ''], [2, '标'], [3, '标'], [4, '标'], [5, '标'], [6, '标'], [8, '标'], [12, '标']]] as const,
  ['标准模式', [[0, ''], [1, ''], [2, '标'], [3, '标'], [4, '标准'], [5, '标准'], [6, '标准模'], [8, '标准模式'], [12, '标准模式']]] as const,
  ['，', [[0, ''], [1, ''], [2, '，'], [3, '，'], [4, '，'], [5, '，'], [6, '，'], [8, '，'], [12, '，']]] as const,
  ['한글', [[0, ''], [1, ''], [2, '한'], [3, '한'], [4, '한글'], [5, '한글'], [6, '한글'], [8, '한글'], [12, '한글']]] as const,
  ['中中中中中', [[0, ''], [1, ''], [2, '中'], [3, '中'], [4, '中中'], [5, '中中'], [6, '中中中'], [8, '中中中中'], [12, '中中中中中']]] as const,
  ['😀', [[0, ''], [1, ''], [2, '😀'], [3, '😀'], [4, '😀'], [5, '😀'], [6, '😀'], [8, '😀'], [12, '😀']]] as const,
  ['😀😀', [[0, ''], [1, ''], [2, '😀'], [3, '😀'], [4, '😀😀'], [5, '😀😀'], [6, '😀😀'], [8, '😀😀'], [12, '😀😀']]] as const,
  ['❤️', [[0, ''], [1, '❤️'], [2, '❤️'], [3, '❤️'], [4, '❤️'], [5, '❤️'], [6, '❤️'], [8, '❤️'], [12, '❤️']]] as const,
  ['❤', [[0, ''], [1, '❤'], [2, '❤'], [3, '❤'], [4, '❤'], [5, '❤'], [6, '❤'], [8, '❤'], [12, '❤']]] as const,
  ['❤️❤️', [[0, ''], [1, '❤️'], [2, '❤️❤️'], [3, '❤️❤️'], [4, '❤️❤️'], [5, '❤️❤️'], [6, '❤️❤️'], [8, '❤️❤️'], [12, '❤️❤️']]] as const,
  ['👨\u200d👩\u200d👧\u200d👦', [[0, ''], [1, ''], [2, '👨\u200d'], [3, '👨\u200d'], [4, '👨\u200d👩\u200d'], [5, '👨\u200d👩\u200d'], [6, '👨\u200d👩\u200d👧\u200d'], [8, '👨\u200d👩\u200d👧\u200d👦'], [12, '👨\u200d👩\u200d👧\u200d👦']]] as const,
  ['👍🏽', [[0, ''], [1, ''], [2, '👍'], [3, '👍'], [4, '👍🏽'], [5, '👍🏽'], [6, '👍🏽'], [8, '👍🏽'], [12, '👍🏽']]] as const,
  ['🇯🇵', [[0, ''], [1, '🇯'], [2, '🇯🇵'], [3, '🇯🇵'], [4, '🇯🇵'], [5, '🇯🇵'], [6, '🇯🇵'], [8, '🇯🇵'], [12, '🇯🇵']]] as const,
  ['𐐀', [[0, ''], [1, '𐐀'], [2, '𐐀'], [3, '𐐀'], [4, '𐐀'], [5, '𐐀'], [6, '𐐀'], [8, '𐐀'], [12, '𐐀']]] as const,
  ['𝐀', [[0, ''], [1, '𝐀'], [2, '𝐀'], [3, '𝐀'], [4, '𝐀'], [5, '𝐀'], [6, '𝐀'], [8, '𝐀'], [12, '𝐀']]] as const,
  ['😀', [[0, ''], [1, ''], [2, '😀'], [3, '😀'], [4, '😀'], [5, '😀'], [6, '😀'], [8, '😀'], [12, '😀']]] as const,
  ['a𐐀b', [[0, ''], [1, 'a'], [2, 'a𐐀'], [3, 'a𐐀b'], [4, 'a𐐀b'], [5, 'a𐐀b'], [6, 'a𐐀b'], [8, 'a𐐀b'], [12, 'a𐐀b']]] as const,
  ['é', [[0, ''], [1, 'é'], [2, 'é'], [3, 'é'], [4, 'é'], [5, 'é'], [6, 'é'], [8, 'é'], [12, 'é']]] as const,
  ['à́̂b', [[0, ''], [1, 'à́̂'], [2, 'à́̂b'], [3, 'à́̂b'], [4, 'à́̂b'], [5, 'à́̂b'], [6, 'à́̂b'], [8, 'à́̂b'], [12, 'à́̂b']]] as const,
  ['áb', [[0, ''], [1, 'á'], [2, 'áb'], [3, 'áb'], [4, 'áb'], [5, 'áb'], [6, 'áb'], [8, 'áb'], [12, 'áb']]] as const,
  ['́ab', [[0, ''], [1, '́a'], [2, '́ab'], [3, '́ab'], [4, '́ab'], [5, '́ab'], [6, '́ab'], [8, '́ab'], [12, '́ab']]] as const,
  ['abć', [[0, ''], [1, 'a'], [2, 'ab'], [3, 'abć'], [4, 'abć'], [5, 'abć'], [6, 'abć'], [8, 'abć'], [12, 'abć']]] as const,
  ['abćdef', [[0, ''], [1, 'a'], [2, 'ab'], [3, 'abć'], [4, 'abćd'], [5, 'abćde'], [6, 'abćdef'], [8, 'abćdef'], [12, 'abćdef']]] as const,
  ['a️b', [[0, ''], [1, 'a️'], [2, 'a️b'], [3, 'a️b'], [4, 'a️b'], [5, 'a️b'], [6, 'a️b'], [8, 'a️b'], [12, 'a️b']]] as const,
  ['a​b', [[0, ''], [1, 'a​'], [2, 'a​b'], [3, 'a​b'], [4, 'a​b'], [5, 'a​b'], [6, 'a​b'], [8, 'a​b'], [12, 'a​b']]] as const,
  ['a\u200db', [[0, ''], [1, 'a\u200d'], [2, 'a\u200db'], [3, 'a\u200db'], [4, 'a\u200db'], [5, 'a\u200db'], [6, 'a\u200db'], [8, 'a\u200db'], [12, 'a\u200db']]] as const,
  ['a\u0000b', [[0, ''], [1, 'a\u0000'], [2, 'a\u0000b'], [3, 'a\u0000b'], [4, 'a\u0000b'], [5, 'a\u0000b'], [6, 'a\u0000b'], [8, 'a\u0000b'], [12, 'a\u0000b']]] as const,
  ['a\u009bb', [[0, ''], [1, 'a\u009b'], [2, 'a\u009bb'], [3, 'a\u009bb'], [4, 'a\u009bb'], [5, 'a\u009bb'], [6, 'a\u009bb'], [8, 'a\u009bb'], [12, 'a\u009bb']]] as const,
  ['\u001b[31mabc\u001b[0m', [[0, ''], [1, '\u001b[31ma\u001b[0m'], [2, '\u001b[31mab\u001b[0m'], [3, '\u001b[31mabc\u001b[0m'], [4, '\u001b[31mabc\u001b[0m'], [5, '\u001b[31mabc\u001b[0m'], [6, '\u001b[31mabc\u001b[0m'], [8, '\u001b[31mabc\u001b[0m'], [12, '\u001b[31mabc\u001b[0m']]] as const,
  ['\u001b[1m\u001b[31mabc\u001b[0m', [[0, ''], [1, '\u001b[1m\u001b[31ma\u001b[0m'], [2, '\u001b[1m\u001b[31mab\u001b[0m'], [3, '\u001b[1m\u001b[31mabc\u001b[0m'], [4, '\u001b[1m\u001b[31mabc\u001b[0m'], [5, '\u001b[1m\u001b[31mabc\u001b[0m'], [6, '\u001b[1m\u001b[31mabc\u001b[0m'], [8, '\u001b[1m\u001b[31mabc\u001b[0m'], [12, '\u001b[1m\u001b[31mabc\u001b[0m']]] as const,
  ['\u001b[mabc\u001b[0m', [[0, ''], [1, '\u001b[ma'], [2, '\u001b[mab'], [3, '\u001b[mabc\u001b[0m'], [4, '\u001b[mabc\u001b[0m'], [5, '\u001b[mabc\u001b[0m'], [6, '\u001b[mabc\u001b[0m'], [8, '\u001b[mabc\u001b[0m'], [12, '\u001b[mabc\u001b[0m']]] as const,
  ['\u001b[31mabc', [[0, ''], [1, '\u001b[31ma\u001b[0m'], [2, '\u001b[31mab\u001b[0m'], [3, '\u001b[31mabc'], [4, '\u001b[31mabc'], [5, '\u001b[31mabc'], [6, '\u001b[31mabc'], [8, '\u001b[31mabc'], [12, '\u001b[31mabc']]] as const,
  ['ab\u001b[31mc', [[0, ''], [1, 'a'], [2, 'ab\u001b[31m\u001b[0m'], [3, 'ab\u001b[31mc'], [4, 'ab\u001b[31mc'], [5, 'ab\u001b[31mc'], [6, 'ab\u001b[31mc'], [8, 'ab\u001b[31mc'], [12, 'ab\u001b[31mc']]] as const,
  ['a\u001b[31m', [[0, ''], [1, 'a\u001b[31m'], [2, 'a\u001b[31m'], [3, 'a\u001b[31m'], [4, 'a\u001b[31m'], [5, 'a\u001b[31m'], [6, 'a\u001b[31m'], [8, 'a\u001b[31m'], [12, 'a\u001b[31m']]] as const,
  ['\u001b[31ḿabc', [[0, ''], [1, '\u001b[31ḿa\u001b[0m'], [2, '\u001b[31ḿab\u001b[0m'], [3, '\u001b[31ḿabc'], [4, '\u001b[31ḿabc'], [5, '\u001b[31ḿabc'], [6, '\u001b[31ḿabc'], [8, '\u001b[31ḿabc'], [12, '\u001b[31ḿabc']]] as const,
  ['a\u001b[31ḿbc', [[0, ''], [1, 'a\u001b[31ḿ\u001b[0m'], [2, 'a\u001b[31ḿb\u001b[0m'], [3, 'a\u001b[31ḿbc'], [4, 'a\u001b[31ḿbc'], [5, 'a\u001b[31ḿbc'], [6, 'a\u001b[31ḿbc'], [8, 'a\u001b[31ḿbc'], [12, 'a\u001b[31ḿbc']]] as const,
  ['á\u001b[31mbc', [[0, ''], [1, 'á\u001b[31m\u001b[0m'], [2, 'á\u001b[31mb\u001b[0m'], [3, 'á\u001b[31mbc'], [4, 'á\u001b[31mbc'], [5, 'á\u001b[31mbc'], [6, 'á\u001b[31mbc'], [8, 'á\u001b[31mbc'], [12, 'á\u001b[31mbc']]] as const,
  ['ab\u001b[31ḿc', [[0, ''], [1, 'a'], [2, 'ab\u001b[31ḿ\u001b[0m'], [3, 'ab\u001b[31ḿc'], [4, 'ab\u001b[31ḿc'], [5, 'ab\u001b[31ḿc'], [6, 'ab\u001b[31ḿc'], [8, 'ab\u001b[31ḿc'], [12, 'ab\u001b[31ḿc']]] as const,
  ['\u001b[?25labc', [[0, ''], [1, '\u001b[?25la\u001b[0m'], [2, '\u001b[?25lab\u001b[0m'], [3, '\u001b[?25labc'], [4, '\u001b[?25labc'], [5, '\u001b[?25labc'], [6, '\u001b[?25labc'], [8, '\u001b[?25labc'], [12, '\u001b[?25labc']]] as const,
  ['\u001b[2Jabc', [[0, ''], [1, '\u001b[2Ja\u001b[0m'], [2, '\u001b[2Jab\u001b[0m'], [3, '\u001b[2Jabc'], [4, '\u001b[2Jabc'], [5, '\u001b[2Jabc'], [6, '\u001b[2Jabc'], [8, '\u001b[2Jabc'], [12, '\u001b[2Jabc']]] as const,
  ['\u001b[>0c', [[0, ''], [1, '\u001b[\u001b[0m'], [2, '\u001b[>\u001b[0m'], [3, '\u001b[>0\u001b[0m'], [4, '\u001b[>0c'], [5, '\u001b[>0c'], [6, '\u001b[>0c'], [8, '\u001b[>0c'], [12, '\u001b[>0c']]] as const,
  ['\u001b]0;title\u0007abc', [[0, ''], [1, '\u001b]0;title\u0007a\u001b[0m'], [2, '\u001b]0;title\u0007ab\u001b[0m'], [3, '\u001b]0;title\u0007abc'], [4, '\u001b]0;title\u0007abc'], [5, '\u001b]0;title\u0007abc'], [6, '\u001b]0;title\u0007abc'], [8, '\u001b]0;title\u0007abc'], [12, '\u001b]0;title\u0007abc']]] as const,
  ['\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007', [[0, ''], [1, '\u001b]8;;https://example.com\u0007l\u001b[0m'], [2, '\u001b]8;;https://example.com\u0007li\u001b[0m'], [3, '\u001b]8;;https://example.com\u0007lin\u001b[0m'], [4, '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007'], [5, '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007'], [6, '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007'], [8, '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007'], [12, '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007']]] as const,
  ['\u001b]0;t\u001b\\abc', [[0, ''], [1, '\u001b]0;t\u001b\\a\u001b[0m'], [2, '\u001b]0;t\u001b\\ab\u001b[0m'], [3, '\u001b]0;t\u001b\\abc'], [4, '\u001b]0;t\u001b\\abc'], [5, '\u001b]0;t\u001b\\abc'], [6, '\u001b]0;t\u001b\\abc'], [8, '\u001b]0;t\u001b\\abc'], [12, '\u001b]0;t\u001b\\abc']]] as const,
  ['\u001b', [[0, ''], [1, '\u001b'], [2, '\u001b'], [3, '\u001b'], [4, '\u001b'], [5, '\u001b'], [6, '\u001b'], [8, '\u001b'], [12, '\u001b']]] as const,
  ['\u001bx', [[0, ''], [1, '\u001bx'], [2, '\u001bx'], [3, '\u001bx'], [4, '\u001bx'], [5, '\u001bx'], [6, '\u001bx'], [8, '\u001bx'], [12, '\u001bx']]] as const,
  ['\u001b[3', [[0, ''], [1, '\u001b[\u001b[0m'], [2, '\u001b[3'], [3, '\u001b[3'], [4, '\u001b[3'], [5, '\u001b[3'], [6, '\u001b[3'], [8, '\u001b[3'], [12, '\u001b[3']]] as const,
  ['\u001b\u001b[31mabc', [[0, ''], [1, '\u001b\u001b[31ma\u001b[0m'], [2, '\u001b\u001b[31mab\u001b[0m'], [3, '\u001b\u001b[31mabc'], [4, '\u001b\u001b[31mabc'], [5, '\u001b\u001b[31mabc'], [6, '\u001b\u001b[31mabc'], [8, '\u001b\u001b[31mabc'], [12, '\u001b\u001b[31mabc']]] as const,
  ['\u001b[31mabc\u001b', [[0, ''], [1, '\u001b[31ma\u001b[0m'], [2, '\u001b[31mab\u001b[0m'], [3, '\u001b[31mabc\u001b'], [4, '\u001b[31mabc\u001b'], [5, '\u001b[31mabc\u001b'], [6, '\u001b[31mabc\u001b'], [8, '\u001b[31mabc\u001b'], [12, '\u001b[31mabc\u001b']]] as const,
  ['\u001b[36m中a😀é\u001b[0m', [[0, ''], [1, '\u001b[36m\u001b[0m'], [2, '\u001b[36m中\u001b[0m'], [3, '\u001b[36m中a\u001b[0m'], [4, '\u001b[36m中a\u001b[0m'], [5, '\u001b[36m中a😀\u001b[0m'], [6, '\u001b[36m中a😀é\u001b[0m'], [8, '\u001b[36m中a😀é\u001b[0m'], [12, '\u001b[36m中a😀é\u001b[0m']]] as const,
  ['\u001b[90m(\u001b[0m\u001b[32m标准\u001b[0m)', [[0, ''], [1, '\u001b[90m(\u001b[0m\u001b[32m\u001b[0m'], [2, '\u001b[90m(\u001b[0m\u001b[32m\u001b[0m'], [3, '\u001b[90m(\u001b[0m\u001b[32m标\u001b[0m'], [4, '\u001b[90m(\u001b[0m\u001b[32m标\u001b[0m'], [5, '\u001b[90m(\u001b[0m\u001b[32m标准\u001b[0m'], [6, '\u001b[90m(\u001b[0m\u001b[32m标准\u001b[0m)'], [8, '\u001b[90m(\u001b[0m\u001b[32m标准\u001b[0m)'], [12, '\u001b[90m(\u001b[0m\u001b[32m标准\u001b[0m)']]] as const,
  ['见 [docs](https://example.com) — 中文 **粗体** `code`', [[0, ''], [1, ''], [2, '见'], [3, '见 '], [4, '见 ['], [5, '见 [d'], [6, '见 [do'], [8, '见 [docs'], [12, '见 [docs](ht']]] as const,
]

describe('truncateToWidth() equivalence', () => {
  it.each(EQUIVALENCE)('cuts %j at every boundary exactly as it did', (source, budgets) => {
    for (const [columns, expected] of budgets) {
      expect(truncateToWidth(source, columns), `${JSON.stringify(source)} at ${String(columns)} columns`)
        .toBe(expected)
    }
  })

  it('returns the same string object when nothing was cut', () => {
    // Not a style choice: the tokens partition the string, so an uncut answer IS
    // the input, and a copy of a megabyte nobody cut it from is the allocation
    // this scan exists to avoid.
    const whole = `${ESCAPE}[1m${style('标准模式', 'bold')}${ESCAPE}[0m`
    expect(truncateToWidth(whole, 1000)).toBe(whole)
  })
})

describe('the stopping rule', () => {
  it('stops at the first character that would overflow, and not at the budget', () => {
    // An exact fit is not a cut: nothing is discarded, so nothing is appended.
    expect(truncateToWidth('abc', 3)).toBe('abc')
    // One column short of the next character ends the walk at that character.
    expect(truncateToWidth('abcdef', 3)).toBe('abc')
  })

  it('keeps a zero-width character that follows the budget, because it belongs to the one before it', () => {
    // The case a `used === columns` stopping rule gets wrong: the budget is full,
    // the next token is zero-width, and the answer still grows. The mark completes
    // `c`, so dropping it would render `abc` as three unaccented letters.
    expect(truncateToWidth('abćdef', 3)).toBe('abć')
    // The very next character fits, so the walk continues and takes it too.
    expect(truncateToWidth('abćdef', 4)).toBe('abćd')
  })

  it('drops a zero-width character that precedes the character that did not fit', () => {
    // The other side of the same rule, and the reason the rule cannot be "keep
    // every zero-width character": the mark belongs to the heart, and the heart is
    // what overflowed, so neither the mark nor the base is part of the answer.
    expect(truncateToWidth('ab❤️x', 2)).toBe('ab')
  })

  it('excludes a two-column character that does not fit, whole', () => {
    expect(truncateToWidth('a中', 2)).toBe('a')
    expect(truncateToWidth('a中', 3)).toBe('a中')
    // A budget of one column fits no wide character at all.
    expect(truncateToWidth('中中', 1)).toBe('')
  })

  it('never emits half of a code point', () => {
    // A supplementary-plane character is two UTF-16 units and one token. Half of
    // one is not a character, and a terminal renders it as a replacement glyph.
    const cut = truncateToWidth('\u{10400}\u{10400}\u{10400}', 1)
    expect(cut).toBe('\u{10400}')
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(cut)).toBe(false)
    const wide = truncateToWidth('\u{1f600}\u{1f600}', 2)
    expect(wide).toBe('\u{1f600}')
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(wide)).toBe(false)
  })

  it('reads through a zero-width run that follows the budget, because all of it is the answer', () => {
    // The limit of the rule, stated as a test. Nothing here can stop at the budget:
    // every mark after it is retained output, so the scan has to reach the `y` to
    // know the prefix is complete. A change that dropped them would be faster and
    // wrong, and this is the assertion that would say so.
    const marks = '\u0301'.repeat(100)
    expect(truncateToWidth(`x`.repeat(RETAINED) + marks + 'y', RETAINED))
      .toBe('x'.repeat(RETAINED) + marks)
  })
})

describe('styling across a cut', () => {
  it('closes styling the cut left open, exactly once', () => {
    // The discarded tail took the reset with it, so a truncated coloured row
    // would otherwise hand its colour to whatever is drawn next.
    expect(truncateToWidth(`${ESCAPE}[31mabc`, 2)).toBe(`${ESCAPE}[31mab${ESCAPE}[0m`)
  })

  it('adds no reset when the styling was already closed before the cut', () => {
    // The retained reset is the input's own; appending another would be a second
    // close for one open, which is how a row ends up with a stray code in it.
    expect(truncateToWidth(`${ESCAPE}[31mab${ESCAPE}[0mcd`, 2)).toBe(`${ESCAPE}[31mab${ESCAPE}[0m`)
  })

  it('adds no reset when nothing was cut', () => {
    expect(truncateToWidth(`${ESCAPE}[31mabc${ESCAPE}[0m`, 10)).toBe(`${ESCAPE}[31mabc${ESCAPE}[0m`)
    expect(truncateToWidth(`${ESCAPE}[31mabc${ESCAPE}[0m`, 3)).toBe(`${ESCAPE}[31mabc${ESCAPE}[0m`)
  })

  it('keeps an escape that follows the budget, and closes what it opens', () => {
    // The reason the scan may not stop when the budget is full: this SGR is part
    // of the answer, and it decides the reset as well.
    const line = 'x'.repeat(RETAINED) + `${ESCAPE}[31m` + 'y'.repeat(10)
    expect(truncateToWidth(line, RETAINED))
      .toBe('x'.repeat(RETAINED) + `${ESCAPE}[31m${ESCAPE}[0m`)
  })

  it('keeps an OSC sequence that follows the budget whole', () => {
    // Never cut inside one, for either terminator — and an OSC is not a reset, so
    // one after the budget still leaves styling open.
    const line = 'x'.repeat(RETAINED) + `${ESCAPE}]0;title\u0007` + 'y'.repeat(5)
    expect(truncateToWidth(line, RETAINED))
      .toBe('x'.repeat(RETAINED) + `${ESCAPE}]0;title\u0007${ESCAPE}[0m`)
  })

  it('treats a bare escape that completes no sequence as open styling', () => {
    // What the pattern-based tokenizer produced, and therefore what a terminal
    // reading the same bytes is owed: a truncated sequence leaves the row in an
    // unknown state, so the reset is appended.
    expect(truncateToWidth(`${ESCAPE}abc`, 1)).toBe(`${ESCAPE}a${ESCAPE}[0m`)
    // With nothing cut there is nothing to close.
    expect(truncateToWidth(`${ESCAPE}abc`, 10)).toBe(`${ESCAPE}abc`)
  })
})

describe('a discarded tail', () => {
  /**
   * The shapes whose tails are thrown away: plain, styled, and mixed Unicode.
   * Each is one megabyte of input for an eighty-column answer.
   */
  const TAILS: readonly (readonly [string, (size: number) => string])[] = [
    ['plain ASCII', size => 'x'.repeat(size)],
    ['styled ASCII', size => `${ESCAPE}[31m${'y'.repeat(size)}${ESCAPE}[0m`],
    ['unicode', size => ('中\u{1f600}é\u{1d400}').repeat(Math.ceil(size / 8)).slice(0, size)],
  ]

  it.each(TAILS)('reads no further into a %s line than the answer needs', (_name, build) => {
    const line = new CountedString(build(1_000_000))
    const kept = truncateToWidth(line, RETAINED)
    expect(displayWidth(kept)).toBe(RETAINED)
    // A generous multiple of the budget: the prefix is eighty columns plus the
    // escapes inside it, and a scan that reads one kilobyte of a megabyte is
    // still lazy. The eager implementation reached the last character.
    expect(line.farthest).toBeLessThan(RETAINED * 12)
    // Nor did it walk the string character by character, which is the other way
    // a whole-input pass can happen without a single far-flung read.
    expect(line.yielded).toBeLessThan(RETAINED * 12)
  })

  it.each(TAILS)('keeps the same eighty columns whatever the tail holds', (_name, build) => {
    // Ten thousand columns of the same content and a million of it must cut to
    // the same eighty: a cut may depend on nothing after its prefix. Compared in
    // COLUMNS rather than characters, because eighty characters of CJK is far
    // more than eighty columns and the two answers are then not the same.
    const long = truncateToWidth(build(1_000_000), RETAINED)
    expect(truncateToWidth(build(10_000), RETAINED)).toBe(long)
    // The retained text is a prefix of what it cut. The closing reset a cut
    // appends is the one part of an answer that is by definition not in the
    // input, so it is taken off before the comparison.
    const reset = `${ESCAPE}[0m`
    const retained = long.endsWith(reset) ? long.slice(0, -reset.length) : long
    expect(build(1_000_000).startsWith(retained)).toBe(true)
  })

  it.each(TAILS)('measures a %s line as the cut says it fits', (_name, build) => {
    // The cross-check the module rests on: one scan, so a measurement and a cut
    // cannot disagree about what fits. A whole line measures wider than the budget
    // it is cut to, and cutting at more columns than the line needs changes
    // nothing at all.
    const line = build(1_000_000)
    expect(displayWidth(line)).toBeGreaterThan(RETAINED)
    expect(displayWidth(truncateToWidth(line, RETAINED))).toBe(RETAINED)
    expect(truncateToWidth(line, line.length + 1)).toBe(line)
  })
})

describe('the rest of the width module', () => {
  it('chunks text without losing a visible character or splitting an escape', () => {
    // `chunkToWidth` was re-pointed at the scan: it walks tokens in order and never
    // needed an array of them. The invariants it must keep are the ones a row
    // depends on — every visible character survives, in order, and each row is
    // measured by the same scan that measures a cut, or the two would disagree
    // about where a row ends.
    const styled = `${ESCAPE}[36m标准模式 and ${ESCAPE}[1mbold${ESCAPE}[0m text`
    for (const columns of [1, 2, 3, 5, 8, 13, 80]) {
      const rows = chunkToWidth(styled, columns)
      expect(stripAnsi(rows.join('')), `${String(columns)} columns`).toBe(stripAnsi(styled))
      // A single two-column character cannot fit a one-column budget, and chunking
      // emits it anyway rather than looping forever — the same progress rule a
      // terminal's own line editing uses.
      for (const row of rows) {
        expect(displayWidth(row), `${String(columns)} columns: ${JSON.stringify(row)}`)
          .toBeLessThanOrEqual(Math.max(columns, 2))
      }
    }
  })

  it('wraps text without losing a visible character, measured by the same scan', () => {
    // `wrapToWidth` is deliberately NOT re-pointed: it reorders tokens into rows,
    // so the array is its data structure. What the shared scan has to preserve is
    // the measurement it shares with everything else, which is why a wrapped row
    // and a chunked row of the same budget agree on what fits.
    const styled = `${ESCAPE}[36m标准模式${ESCAPE}[0m\u{1f600}é\u{1d400}`
    for (const columns of [2, 3, 5, 8, 13]) {
      const rows = wrapToWidth(styled, columns)
      expect(stripAnsi(rows.join('')), `${String(columns)} columns`).toBe(stripAnsi(styled))
      for (const row of rows) {
        expect(displayWidth(row), `${String(columns)} columns: ${JSON.stringify(row)}`)
          .toBeLessThanOrEqual(columns)
      }
    }
  })
})
