/**
 * The `ctrl-r` search model: a query, the positions it matched, and a selection.
 *
 * The assertions are about POSITIONS rather than text wherever a duplicate could
 * hide a bug, because identifying a result by its text is precisely the mistake
 * that would make history navigation continue from the wrong entry after a
 * recall.
 */

import { describe, expect, it } from 'vitest'
import { HistorySearch } from '../src/history-search.ts'
import { InputHistory } from '../src/history.ts'

/**
 * An {@link InputHistory} holding the given submissions, in order.
 * @param lines - the lines to record.
 * @returns the populated history.
 */
function recorded(...lines: string[]): InputHistory {
  const history = new InputHistory()
  for (const line of lines) history.record(line)
  return history
}

/**
 * Type a whole query one character at a time, as a reader does.
 * @param search - the search to type into.
 * @param query - the text to type.
 */
function type(search: HistorySearch, query: string): void {
  for (const character of query) search.append(character)
}

describe('HistorySearch', () => {
  it('offers nothing when the history is empty', () => {
    const search = new HistorySearch(recorded())

    expect(search.matches).toEqual([])
    expect(search.selected).toBe(undefined)
    expect(search.selectedText).toBe(undefined)
    expect(search.position).toBe(0)
    expect(search.corpusSize).toBe(0)
  })

  it('offers the whole history newest first on an empty query, selecting the newest', () => {
    const search = new HistorySearch(recorded('oldest', 'middle', 'newest'))

    expect(search.query).toBe('')
    expect(search.matches).toEqual([2, 1, 0])
    expect(search.selected).toBe(2)
    expect(search.selectedText).toBe('newest')
    expect(search.position).toBe(1)
  })

  it('matches a literal substring anywhere in the entry', () => {
    const search = new HistorySearch(recorded('run the tests', 'explain this', 'test the runner'))
    type(search, 'test')

    expect(search.matches).toEqual([2, 0])
    expect(search.selectedText).toBe('test the runner')
  })

  it('matches without regard to case, in either direction', () => {
    const search = new HistorySearch(recorded('Fix The AUTH middleware', 'unrelated'))
    type(search, 'auth')
    expect(search.matches).toEqual([0])

    const upper = new HistorySearch(recorded('fix the auth middleware'))
    type(upper, 'AUTH')
    expect(upper.matches).toEqual([0])
  })

  it('does not add smart case: an upper-case query still matches lower-case text', () => {
    const search = new HistorySearch(recorded('deploy staging'))
    type(search, 'Deploy')

    // Smart case would treat the capital as a demand for an exact match and
    // find nothing, which is a rule a reader has to learn before they can
    // predict the list.
    expect(search.matches).toEqual([0])
  })

  it('keeps whitespace inside the query meaningful', () => {
    const search = new HistorySearch(recorded('run tests', 'runtests'))
    type(search, 'run t')

    expect(search.matches).toEqual([0])
  })

  it('offers one match when only one entry contains the query', () => {
    const search = new HistorySearch(recorded('alpha', 'beta', 'gamma'))
    type(search, 'bet')

    expect(search.matches).toEqual([1])
    expect(search.position).toBe(1)
  })

  it('offers nothing, and selects nothing, when no entry contains the query', () => {
    const search = new HistorySearch(recorded('alpha', 'beta'))
    type(search, 'zzz')

    expect(search.matches).toEqual([])
    expect(search.selected).toBe(undefined)
    expect(search.position).toBe(0)
    // The corpus is still there; only the query left nothing of it. The overlay
    // reads this to tell "nothing matched" apart from "nothing was ever sent".
    expect(search.corpusSize).toBe(2)
  })

  it('orders many matches newest first, deterministically', () => {
    const search = new HistorySearch(recorded('log a', 'log b', 'other', 'log c', 'log d'))
    type(search, 'log')

    expect(search.matches).toEqual([4, 3, 1, 0])
    expect([...search.matches]).toEqual([4, 3, 1, 0])
  })

  it('steps to the next older match on each repeated ctrl-r', () => {
    const search = new HistorySearch(recorded('log a', 'log b', 'log c'))
    type(search, 'log')

    expect(search.selectedText).toBe('log c')
    expect(search.older()).toBe(true)
    expect(search.selectedText).toBe('log b')
    expect(search.older()).toBe(true)
    expect(search.selectedText).toBe('log a')
  })

  it('does not wrap at the oldest match', () => {
    const search = new HistorySearch(recorded('log a', 'log b'))
    type(search, 'log')
    search.older()

    expect(search.selectedText).toBe('log a')
    // Wrapping here would put the reader back at the newest entry exactly when
    // they were trying to leave the list, which is why InputHistory.previous()
    // stops too.
    expect(search.older()).toBe(false)
    expect(search.selectedText).toBe('log a')
    expect(search.position).toBe(2)
  })

  it('does not wrap at the newest match', () => {
    const search = new HistorySearch(recorded('log a', 'log b'))
    type(search, 'log')

    expect(search.newer()).toBe(false)
    expect(search.selectedText).toBe('log b')
  })

  it('moves toward newer matches, which is the visual list direction', () => {
    const search = new HistorySearch(recorded('log a', 'log b', 'log c'))
    type(search, 'log')
    search.older()
    search.older()

    expect(search.selectedText).toBe('log a')
    expect(search.newer()).toBe(true)
    expect(search.selectedText).toBe('log b')
  })

  it('jumps to the newest and oldest match, and reports when it did not move', () => {
    const search = new HistorySearch(recorded('log a', 'log b', 'log c'))
    type(search, 'log')

    expect(search.last()).toBe(true)
    expect(search.selectedText).toBe('log a')
    expect(search.last()).toBe(false)
    expect(search.first()).toBe(true)
    expect(search.selectedText).toBe('log c')
    expect(search.first()).toBe(false)
  })

  it('jumps nowhere when nothing matched', () => {
    const search = new HistorySearch(recorded('alpha'))
    type(search, 'zzz')

    expect(search.first()).toBe(false)
    expect(search.last()).toBe(false)
    expect(search.older()).toBe(false)
    expect(search.newer()).toBe(false)
  })

  it('re-aims at the newest match after every query edit', () => {
    const search = new HistorySearch(recorded('log a', 'log b', 'log c'))
    type(search, 'log')
    search.older()
    search.older()
    expect(search.selectedText).toBe('log a')

    // The list the reader was moving through has been replaced, and there is no
    // honest way to carry a position across a narrowing that may have removed it.
    search.append(' ')
    expect(search.selectedText).toBe('log c')
    expect(search.position).toBe(1)
  })

  it('widens again on backspace, one code point at a time', () => {
    const search = new HistorySearch(recorded('alpha', 'beta'))
    type(search, 'alphax')
    expect(search.matches).toEqual([])

    search.backspace()
    expect(search.query).toBe('alpha')
    expect(search.matches).toEqual([0])
  })

  it('deletes one whole astral code point on backspace', () => {
    const search = new HistorySearch(recorded('ship it 🚀 now'))
    type(search, '🚀')
    expect(search.matches).toEqual([0])

    search.backspace()
    // A UTF-16 delete would leave a lone surrogate behind, which matches nothing
    // and cannot be typed away either.
    expect(search.query).toBe('')
    expect([...search.query]).toEqual([])
  })

  it('deletes an astral code point that follows ordinary text', () => {
    const search = new HistorySearch(recorded('anything'))
    type(search, 'a🚀')

    search.backspace()
    expect(search.query).toBe('a')
  })

  it('clears the whole query on ctrl-u', () => {
    const search = new HistorySearch(recorded('alpha', 'beta'))
    type(search, 'alp')
    search.clear()

    expect(search.query).toBe('')
    expect(search.matches).toEqual([1, 0])
  })

  it('deletes the previous word on ctrl-w, leaving the separator', () => {
    const search = new HistorySearch(recorded('run the tests'))
    type(search, 'run the')
    search.deleteWord()

    // The composer's own ctrl-w rule, which the query row follows because it is
    // a field edited with the same keys.
    expect(search.query).toBe('run ')
    expect(search.matches).toEqual([0])
  })

  it('deletes trailing whitespace and the word before it in one ctrl-w', () => {
    const search = new HistorySearch(recorded('anything'))
    type(search, 'run the  ')
    search.deleteWord()

    // One press, not two: spending the first on whitespace the reader had just
    // typed would read as the key having done nothing.
    expect(search.query).toBe('run ')
  })

  it('changes nothing when ctrl-w or ctrl-u has nothing to delete', () => {
    const search = new HistorySearch(recorded('alpha'))

    search.deleteWord()
    expect(search.query).toBe('')
    search.clear()
    expect(search.query).toBe('')
    search.backspace()
    expect(search.query).toBe('')
  })

  it('searches submitted commands exactly as it searches prompts', () => {
    const search = new HistorySearch(recorded('/permission read-only', 'a prompt', '/model deepseek-v4-pro'))
    type(search, '/')

    expect(search.matches).toEqual([2, 0])
    expect(search.selectedText).toBe('/model deepseek-v4-pro')
  })

  it('sees one entry where InputHistory collapsed consecutive duplicates', () => {
    const search = new HistorySearch(recorded('run tests', 'run tests', 'run tests'))
    type(search, 'run')

    expect(search.matches).toEqual([0])
  })

  it('keeps non-adjacent duplicates as distinct results at distinct positions', () => {
    const search = new HistorySearch(recorded('run tests', 'run the build', 'run tests'))
    type(search, 'run tests')

    // Same text, different history entries. Collapsing them here would make
    // `↑` after a recall continue from whichever one the matcher happened to
    // keep rather than from the one the reader chose.
    expect(search.matches).toEqual([2, 0])
    expect(search.entry(2)).toBe('run tests')
    expect(search.entry(0)).toBe('run tests')
    expect(search.selected).toBe(2)
    search.older()
    expect(search.selected).toBe(0)
    expect(search.selectedText).toBe('run tests')
  })

  it('matches CJK text by substring', () => {
    const search = new HistorySearch(recorded('请修复失败的测试', '解释这个函数', '再次运行测试'))
    type(search, '测试')

    expect(search.matches).toEqual([2, 0])
    expect(search.selectedText).toBe('再次运行测试')
  })

  it('matches an emoji query against an entry containing it', () => {
    const search = new HistorySearch(recorded('ship it 🚀', 'hold on'))
    type(search, '🚀')

    expect(search.matches).toEqual([0])
  })

  it('reads no entry the corpus does not hold', () => {
    const search = new HistorySearch(recorded('only one'))

    expect(search.entry(-1)).toBe(undefined)
    expect(search.entry(1)).toBe(undefined)
  })
})

describe('HistorySearch: a query means the same thing however it was typed', () => {
  /**
   * A word whose lowercasing is CONTEXT-SENSITIVE.
   *
   * `ΟΣΑ` folds to `οσα`, but the prefix `ΟΣ` folds to `ος` — a FINAL sigma,
   * because the sigma now ends the string. So the entry matches `Ο`, does not
   * match `ΟΣ`, and matches `ΟΣΑ` again.
   */
  const SIGMA = 'ΟΣΑ'

  it('lets a result disappear and come back as the query grows', () => {
    const search = new HistorySearch(recorded(SIGMA))

    search.append('Ο')
    expect(search.matches).toEqual([0])
    search.append('Σ')
    // Not a bug in this expectation: `ος` really is not in `οσα`. What matters
    // is that the entry is recoverable, which filtering the previous (now empty)
    // match set could never do.
    expect(search.matches).toEqual([])
    search.append('Α')
    expect(search.matches).toEqual([0])
    expect(search.selectedText).toBe(SIGMA)
  })

  it('reaches the same matches whatever path the query took', () => {
    const corpus = [SIGMA, 'unrelated', 'ΟΣΑ ΚΑΙ ΑΛΛΑ']

    const typed = new HistorySearch(recorded(...corpus))
    for (const character of 'ΟΣΑ') typed.append(character)

    const pasted = new HistorySearch(recorded(...corpus))
    pasted.append('ΟΣΑ')

    const backspaced = new HistorySearch(recorded(...corpus))
    backspaced.append('ΟΣΑΧ')
    backspaced.backspace()

    const cleared = new HistorySearch(recorded(...corpus))
    cleared.append('nothing at all')
    cleared.clear()
    cleared.append('ΟΣΑ')

    // The invariant: matches are a function of the corpus and the query as it
    // now reads, never of the keystrokes that produced it.
    expect(typed.matches).toEqual(pasted.matches)
    expect(backspaced.matches).toEqual(pasted.matches)
    expect(cleared.matches).toEqual(pasted.matches)
    expect(pasted.matches).toEqual([2, 0])
  })

  it('agrees with a fresh search after ctrl-w has cut the query back', () => {
    const corpus = ['ΟΣΑ here', 'nothing']

    const edited = new HistorySearch(recorded(...corpus))
    edited.append('ΟΣΑ here')
    edited.deleteWord()

    const fresh = new HistorySearch(recorded(...corpus))
    fresh.append(edited.query)

    expect(edited.query).toBe('ΟΣΑ ')
    expect(edited.matches).toEqual(fresh.matches)
    expect(edited.matches).toEqual([0])
  })
})
