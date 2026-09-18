import { describe, expect, it } from 'vitest'
import { chunkToWidth, codePointWidth, displayWidth, escapeControls, hangingIndent, stripAnsi, style, tailToWidth, truncateToWidth, wrapToWidth } from '../src/index.ts'
import { WIDE_RANGES, ZERO_WIDTH_RANGES } from '../src/width-tables.ts'


describe('displayWidth()', () => {
  it('counts CJK ideographs as two columns', () => {
    // The shipped `standard` agent preset is named 标准模式; four ideographs
    // occupy eight columns, and a one-column assumption would corrupt the line.
    expect(displayWidth('标准模式')).toBe(8)
    expect(displayWidth('abcd')).toBe(4)
  })

  it('counts fullwidth punctuation and kana as two columns', () => {
    expect(displayWidth('，')).toBe(2)
    expect(displayWidth('ひらがな')).toBe(8)
    expect(displayWidth('한글')).toBe(4)
  })

  it('ignores combining marks and variation selectors', () => {
    expect(displayWidth('e\u0301')).toBe(1)
    expect(displayWidth('\u200b')).toBe(0)
  })

  it('ignores styling', () => {
    expect(displayWidth(style('标准', 'bold'))).toBe(4)
    expect(displayWidth(style('abc', 'red', 'bold'))).toBe(3)
  })
})

describe('truncateToWidth()', () => {
  it('never emits half of a two-column character', () => {
    // A three-column budget fits one ideograph and must not split the second.
    expect(truncateToWidth('标准模式', 3)).toBe('标')
    expect(truncateToWidth('标准模式', 4)).toBe('标准')
  })

  it('returns nothing for a non-positive budget', () => {
    expect(truncateToWidth('abc', 0)).toBe('')
    expect(truncateToWidth('abc', -1)).toBe('')
  })
})

describe('tailToWidth()', () => {
  it('keeps the end, which is where the cursor of an input line is', () => {
    // The reason it exists: cutting the end of a field hides exactly the
    // characters the person is typing.
    expect(tailToWidth('abcdef', 3)).toBe('def')
    expect(tailToWidth('abc', 10)).toBe('abc')
  })

  it('never emits half of a two-column character', () => {
    expect(tailToWidth('标准模式', 3)).toBe('式')
    expect(tailToWidth('标准模式', 4)).toBe('模式')
  })

  it('returns nothing for a non-positive budget', () => {
    expect(tailToWidth('abc', 0)).toBe('')
    expect(tailToWidth('abc', -1)).toBe('')
  })

  it('agrees with displayWidth about what it produced', () => {
    for (const columns of [1, 2, 3, 5, 8]) {
      expect(displayWidth(tailToWidth('ab标准cd模式', columns))).toBeLessThanOrEqual(columns)
    }
  })

  it('keeps a leading escape sequence, which is styling rather than an orphan', () => {
    // The whole string fits, so nothing is cut and the SGR must survive intact.
    const whole = '\u001b[31mabc\u001b[0m'
    expect(tailToWidth(whole, 3)).toBe(whole)
    // A real cut whose surviving suffix STARTS with an opening SGR: no characters
    // are orphaned, so the escape is kept even though its width is zero.
    expect(tailToWidth('abcdef\u001b[31mxy', 2)).toBe('\u001b[31mxy')
  })

  it('keeps an opening SGR while dropping the orphaned mark it precedes', () => {
    const RED = '\u001b[31m'
    // The cut discarded the base `a`; the SGR opened after it is styling that
    // must survive, and the combining acute the cut orphaned must not — even
    // though the escape sits between them in the retained run.
    expect(tailToWidth(`a${RED}\u0301b`, 1)).toBe(`${RED}b`)
    // The same shape with the mark before the escape: both orders drop only the
    // mark.
    expect(tailToWidth(`a\u0301${RED}b`, 1)).toBe(`${RED}b`)
  })

  it('drops a leading zero-width character only when a cut orphaned it', () => {
    // A zero-width space that lost its preceding content is as orphaned as a
    // combining mark, and both are dropped after a cut...
    expect(tailToWidth('abc\u200bd', 1)).toBe('d')
    expect(tailToWidth('a\u0301b', 1)).toBe('b')
    // ...but a string that FITS keeps a legitimate leading zero-width character,
    // because nothing was cut.
    expect(tailToWidth('\u200bab', 5)).toBe('\u200bab')
  })
})

describe('wrapToWidth()', () => {
  it('breaks Latin text at spaces', () => {
    expect(wrapToWidth('the quick brown fox', 10)).toEqual(['the quick', 'brown fox'])
  })

  it('breaks a space-free CJK run flush at the column budget', () => {
    expect(wrapToWidth('标准模式标准模式', 8)).toEqual(['标准模式', '标准模式'])
  })

  it('preserves blank lines so paragraph spacing survives', () => {
    expect(wrapToWidth('a\n\nb', 10)).toEqual(['a', '', 'b'])
  })

  it('keeps deliberate leading indentation on the first row', () => {
    // Transcript lines indent to hang under a gutter mark; stripping those spaces
    // as if they were a wrap artifact flattens the whole layout.
    expect(wrapToWidth('  indented', 20)).toEqual(['  indented'])
  })

  it('does not start a continuation row with a space', () => {
    expect(wrapToWidth('aaaa bbbb', 4)).toEqual(['aaaa', 'bbbb'])
  })

  it('never returns an empty list', () => {
    expect(wrapToWidth('', 10)).toEqual([''])
  })

  it('makes progress at a one-column budget', () => {
    expect(wrapToWidth('ab', 1)).toEqual(['a', 'b'])
    // A two-column character cannot fit one column; it must still not loop.
    expect(wrapToWidth('标', 1)).toEqual(['标'])
  })
})

describe('wrapping styled text', () => {
  it('measures a styled line by its visible columns, not its escape bytes', () => {
    // A gray border is 7 bytes of escape plus its glyphs; counting those bytes as
    // columns wrapped every framed row seven columns early.
    const border = style('-'.repeat(20), 'gray')
    expect(displayWidth(border)).toBe(20)
    expect(wrapToWidth(border, 20)).toHaveLength(1)
  })

  it('never cuts inside an escape sequence', () => {
    const styled = style('abcdef', 'red')
    for (const line of wrapToWidth(styled, 3)) {
      // A fragment of a sequence would leave a stray '[31' in the visible text.
      expect(stripAnsi(line)).not.toContain('[')
    }
  })

  it('reopens styling on a continuation row so color survives a break', () => {
    const rows = wrapToWidth(style('aaaa bbbb', 'red'), 4)
    expect(rows).toHaveLength(2)
    expect(rows.map(stripAnsi)).toEqual(['aaaa', 'bbbb'])
    for (const row of rows) expect(row).toContain('[31m')
  })

  it('truncates styled text by visible columns', () => {
    expect(stripAnsi(truncateToWidth(style('abcdef', 'bold'), 3))).toBe('abc')
  })
})

describe('escapeControls()', () => {
  it('neutralizes an escape sequence hidden in untrusted output', () => {
    // Tool output carrying a clear-screen sequence must be shown, not executed.
    expect(escapeControls('before\u001b[2Jafter')).toBe('before^[[2Jafter')
  })

  it('neutralizes a carriage return, which would reposition the cursor', () => {
    expect(escapeControls('a\rb')).toBe('a^Mb')
  })

  it('keeps a newline, which is layout the caller has already handled', () => {
    expect(escapeControls('a\nc')).toBe('a\nc')
  })

  it('expands a tab to the next tab stop, because a tab cannot be measured', () => {
    // displayWidth counts a tab as zero while the terminal advances it, so leaving
    // one in place makes a box pad its row to the wrong width and shift its border.
    expect(escapeControls('a\tb')).toBe(`a${' '.repeat(7)}b`)
    expect(displayWidth(escapeControls('a\tb'))).toBe(9)
  })

  it('counts tab stops from the start of each line', () => {
    // A newline returns the terminal to column zero, so the stops restart with it.
    expect(escapeControls('abcdefghij\tx\nab\tx')).toBe(`abcdefghij${'      '}x\nab${'      '}x`)
  })

  it('leaves no tab anywhere in escaped output, so every row can be measured', () => {
    for (const source of ['\t', 'a\t', '\ta', 'a\tb\tc', '\t\t\t', 'x\n\ty']) {
      expect(escapeControls(source), JSON.stringify(source)).not.toContain('\t')
    }
  })

  it('spells C1 controls that have no caret notation', () => {
    expect(escapeControls('\u009b')).toBe('\\u{9b}')
  })
})

describe('stripAnsi()', () => {
  it('removes CSI and OSC sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
    expect(stripAnsi('\u001b]0;title\u0007body')).toBe('body')
  })
})

describe('codePointWidth()', () => {
  it('treats controls as invisible rather than shifting a line', () => {
    expect(codePointWidth(0x1b)).toBe(0)
    expect(codePointWidth(0x7f)).toBe(0)
  })

  it('pins every boundary of the printable-ASCII fast path', () => {
    // Printable ASCII is answered as one column before the Unicode tables are
    // consulted. An off-by-one bound (`<= 0x7f` or `< 0x80`) would measure DEL
    // or a C1 control as one column and shift every row after it, so each edge
    // is pinned by name.
    for (const [code, width] of [
      [0x00, 0], [0x09, 0], [0x0a, 0], [0x1f, 0],
      [0x20, 1], [0x21, 1], [0x7e, 1],
      [0x7f, 0], [0x80, 0], [0x9f, 0], [0xa0, 1],
    ] as const) {
      expect(codePointWidth(code), `U+${code.toString(16)}`).toBe(width)
    }
  })

  it('measures every printable ASCII code point as one column', () => {
    // The fast path's whole domain: space through `~`, covering letters, digits,
    // and punctuation.
    for (let code = 0x20; code <= 0x7e; code += 1) {
      expect(codePointWidth(code), `U+${code.toString(16)}`).toBe(1)
    }
  })

  it('keeps its fallback for out-of-range and surrogate code points', () => {
    // The primitive is exported and accepts any number; the fast path must not
    // change what it did with values no Unicode character has.
    expect(codePointWidth(-1)).toBe(0)
    expect(codePointWidth(0x110000)).toBe(1)
    expect(codePointWidth(0xd800)).toBe(1)
    expect(codePointWidth(0xdc00)).toBe(1)
    expect(displayWidth('\ud800')).toBe(1)
  })
})

describe('the generated wide table', () => {
  it('counts code points the previous hand table trailed as two columns', () => {
    // Emoji that are East Asian Wide, and the non-emoji script blocks the old
    // table never listed. A terminal draws each two cells, so measuring one
    // shifted every character after it.
    for (const wide of [0x231a, 0x2630, 0x4dc0, 0x18b00, 0x1b170, 0x1d300, 0x1f6d5]) {
      expect(codePointWidth(wide), `U+${wide.toString(16)}`).toBe(2)
    }
  })

  it('carries a code point added to Wide in the current final Unicode release', () => {
    // U+1F6D8 LANDSLIDE is Wide from Unicode 17.0.0. A table that quietly fell
    // back to an older release would measure it one while a 17.0 terminal draws
    // it two, which is exactly the stale-table bug this change removes.
    expect(codePointWidth(0x1f6d8)).toBe(2)
    expect(displayWidth('\u{1F6D8}')).toBe(2)
  })

  it('counts CJK and kana as two columns', () => {
    expect(codePointWidth(0x4e2d)).toBe(2)
    expect(codePointWidth(0x3042)).toBe(2)
    expect(displayWidth('标准模式')).toBe(8)
  })

  it('stops over-measuring assigned code points that are not Wide or Fullwidth', () => {
    // U+3248..U+324F are East Asian Ambiguous and U+1F93B/U+1F946 are Neutral;
    // the old blanket CJK range drew all of them two columns wide.
    for (const narrow of [0x3248, 0x324f, 0x1f93b, 0x1f946]) {
      expect(codePointWidth(narrow), `U+${narrow.toString(16)}`).toBe(1)
    }
  })
})

describe('the zero-width policy', () => {
  it('counts nonspacing and enclosing marks from several scripts as zero', () => {
    // Mn/Me are the marks a terminal advances no cell for. The old table
    // covered a handful of ranges, so a missing mark measured one and shifted
    // its row. These are Latin, Hebrew, Arabic, Devanagari, Tamil, and a
    // combining mark for symbols.
    for (const zero of [0x0301, 0x05bf, 0x0610, 0x0900, 0x093c, 0x094d, 0x0bcd, 0x20d0]) {
      expect(codePointWidth(zero), `U+${zero.toString(16)}`).toBe(0)
    }
    expect(displayWidth('a\u0301')).toBe(1)
    expect(displayWidth('\u0928\u092e\u0938\u094d\u0924\u0947')).toBe(4)
  })

  it('counts an explicit allowlist of format controls as zero', () => {
    // The zero-width format policy is a positive list, not General_Category Cf.
    // These are the controls real terminals do not advance for.
    for (const zero of [0x061c, 0x180e, 0x200b, 0x200d, 0x2060, 0x2066, 0xfeff, 0xfff9, 0xe0020]) {
      expect(codePointWidth(zero), `U+${zero.toString(16)}`).toBe(0)
    }
  })

  it('measures format characters whose advance is disputed or sequence-dependent as one', () => {
    // A false zero is the dangerous direction: it under-counts a row the
    // terminal may draw wider. U+00AD is non-zero-width in GLib and
    // mode-dependent in xterm; the prepended marks attach to following text;
    // the separators can start a physical row. All are measured one.
    for (const one of [0x00ad, 0x0600, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x110bd, 0x110cd, 0x2028, 0x2029]) {
      expect(codePointWidth(one), `U+${one.toString(16)}`).toBe(1)
    }
  })

  it('leaves Hangul conjoining Jamo to East Asian Width rather than declaring them zero', () => {
    // A terminal may draw a decomposed syllable as one wide glyph or as its
    // Jamo parts; a global Jamo-zero rule would under-measure the latter. The
    // label composes the syllable with NFC instead. Leading Jamo is Wide;
    // medial and final Jamo are Neutral and measured one.
    expect(codePointWidth(0x1112)).toBe(2)
    expect(codePointWidth(0x1161)).toBe(1)
    expect(codePointWidth(0x11ab)).toBe(1)
    expect(displayWidth('\u1112\u1161\u11ab')).toBe(4)
    expect(displayWidth('\ud55c')).toBe(2)
  })
})

describe('the generated width tables', () => {
  /** A generated table and its name, for the shared integrity checks. */
  const tables = [
    ['WIDE_RANGES', WIDE_RANGES],
    ['ZERO_WIDTH_RANGES', ZERO_WIDTH_RANGES],
  ] as const

  it('are sorted, non-overlapping, and in bounds', () => {
    // `inRanges` binary-searches these arrays, so an unsorted or overlapping
    // table silently returns the wrong width for every code point after the
    // mistake. A generated file is only as good as the invariant it keeps.
    for (const [name, ranges] of tables) {
      expect(ranges.length, name).toBeGreaterThan(0)
      for (let index = 0; index < ranges.length; index += 1) {
        const [start, end] = ranges[index] ?? [0, 0]
        expect(start, `${name} range ${String(index)} start`).toBeLessThanOrEqual(end)
        expect(start, `${name} range ${String(index)} bounds`).toBeGreaterThanOrEqual(0)
        expect(end, `${name} range ${String(index)} bounds`).toBeLessThanOrEqual(0x10ffff)
        const previous = ranges[index - 1]
        if (previous !== undefined) {
          expect(start, `${name} range ${String(index)} order`).toBeGreaterThan(previous[1])
        }
      }
    }
  })

  it('measures a combining mark as zero even where it is also East Asian Wide', () => {
    // U+3099 is a nonspacing mark with East Asian Width W. The zero table is
    // consulted first, because a terminal advances no cell for it and widening
    // the row would shift everything after the base it accents.
    expect(codePointWidth(0x3099)).toBe(0)
  })
})

describe('hangingIndent()', () => {
  it('indents every wrapped row to match the gutter', () => {
    // A marked line has no leading whitespace to preserve, so wrapping it alone
    // drops continuation rows back to column zero, which is what a reply looked
    // like: one gutter, then ragged rows beneath it.
    expect(hangingIndent('\u25cf ', '  ', 'aaa bbb ccc ddd eee', 10))
      .toEqual(['\u25cf aaa bbb', '  ccc ddd', '  eee'])
  })

  it('measures the indent in display columns, not characters', () => {
    // The mark may be a wide glyph; budgeting by character count would let a row
    // overflow by exactly the columns the glyph adds.
    const rows = hangingIndent('\u4f60 ', '   ', 'aaaa bbbb', 8)
    expect(rows.every(row => displayWidth(row) <= 8)).toBe(true)
  })

  it('returns rows that need no further wrapping', () => {
    const rows = hangingIndent('\u23fa ', '  ', 'x'.repeat(50), 20)
    expect(rows.every(row => displayWidth(row) <= 20)).toBe(true)
  })

  it('keeps styling open across a wrapped row', () => {
    const rows = hangingIndent('\u25cf ', '  ', `\u001b[31m${'red '.repeat(10)}\u001b[0m`, 14)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows[1]).toContain('\u001b[31m')
  })
})

describe('truncateToWidth() and open styling', () => {
  const RED = '\u001b[31m'
  const RESET = '\u001b[0m'

  it('closes styling the cut discarded', () => {
    // The cut throws away everything after it, including the reset that closed the
    // colour, so without this the colour leaks into whatever is drawn next: for a
    // gutter or the composer that means every row after it changes colour.
    const truncated = truncateToWidth(`${RED}abcdef${RESET}`, 3)
    expect(stripAnsi(truncated)).toBe('abc')
    expect(truncated.endsWith(RESET)).toBe(true)
  })

  it('leaves an untruncated string byte for byte', () => {
    const styled = `${RED}abc${RESET}`
    expect(truncateToWidth(styled, 10)).toBe(styled)
    expect(truncateToWidth(styled, 3)).toBe(styled)
  })

  it('adds no closer when the cut text carried no styling', () => {
    expect(truncateToWidth('abcdef', 3)).toBe('abc')
  })

  it('adds no closer when the styling was already closed before the cut', () => {
    const truncated = truncateToWidth(`${RED}ab${RESET}cdef`, 3)
    expect(stripAnsi(truncated)).toBe('abc')
    expect(truncated.match(/\[0m/gu)).toHaveLength(1)
  })

  it('closes a wide glyph cut, where the discarded character is two columns', () => {
    const truncated = truncateToWidth(`${RED}你好${RESET}`, 3)
    expect(stripAnsi(truncated)).toBe('你')
    expect(truncated.endsWith(RESET)).toBe(true)
  })
})

describe('chunkToWidth()', () => {
  it('breaks where the row runs out, not at a word boundary', () => {
    expect(chunkToWidth('aaaa bbbbbbbbb', 11)).toEqual(['aaaa bbbbbb', 'bbb'])
  })

  it('is prefix-consistent, which word wrapping is not', () => {
    // The property the composer's cursor depends on: the rows for the text before a
    // position are the first rows for the whole text, because no later character can
    // move an earlier break.
    const text = 'aaaa bbbbbbbbb cccc dddddddd eeee'
    for (let cut = 0; cut <= text.length; cut += 1) {
      const prefix = chunkToWidth(text.slice(0, cut), 11)
      const whole = chunkToWidth(text, 11)
      expect(whole.slice(0, prefix.length - 1), `cut ${String(cut)}`)
        .toEqual(prefix.slice(0, prefix.length - 1))
    }
  })

  it('never splits a wide character across two rows', () => {
    expect(chunkToWidth('你好世界', 5)).toEqual(['你好', '世界'])
    for (const row of chunkToWidth('你'.repeat(20), 7)) expect(displayWidth(row)).toBeLessThanOrEqual(7)
  })

  it('keeps every row within the budget', () => {
    for (const columns of [1, 2, 3, 7, 40]) {
      for (const row of chunkToWidth('mixed 你好 text 世界 here', columns)) {
        expect(displayWidth(row), `${String(columns)} columns`).toBeLessThanOrEqual(Math.max(columns, 2))
      }
    }
  })

  it('reopens styling on a continuation row and closes it on the one it left', () => {
    const rows = chunkToWidth('\u001b[31maaaaaaaaaa\u001b[0m', 4)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows[0]).toContain('\u001b[31m')
    expect(rows[0]?.endsWith('\u001b[0m')).toBe(true)
    expect(rows[1]).toContain('\u001b[31m')
  })

  it('keeps newlines as row boundaries', () => {
    expect(chunkToWidth('ab\ncd', 10)).toEqual(['ab', 'cd'])
  })

  it('returns one empty row for empty text', () => {
    expect(chunkToWidth('', 10)).toEqual([''])
  })
})

describe('zero-width characters in wrapping', () => {
  const COMBINING_ACUTE = '\u0301'

  it('keeps a combining mark with its base instead of replaying it', () => {
    // The mark is zero width but is NOT styling: replayed as an "open style" it
    // would be prepended to the next row and accent the wrong character.
    expect(wrapToWidth(`e${COMBINING_ACUTE}abc`, 2).map(stripAnsi))
      .toEqual([`e${COMBINING_ACUTE}a`, 'bc'])
    expect(chunkToWidth(`e${COMBINING_ACUTE}abc`, 2).map(stripAnsi))
      .toEqual([`e${COMBINING_ACUTE}a`, 'bc'])
  })

  it('does not carry a ZWJ joiner onto a continuation row', () => {
    const rows = wrapToWidth('\u{1F469}\u200D\u{1F4BB}x', 2).map(stripAnsi)
    expect(rows.slice(1).some(row => row.startsWith('\u200D'))).toBe(false)
  })

  it('drops an orphaned combining mark from a tail cut', () => {
    // The cut landed between the base and its mark; the mark alone would combine
    // with whatever follows it instead of the character it belongs to.
    expect(tailToWidth(`a${COMBINING_ACUTE}b`, 1)).toBe('b')
  })

  it('does not amplify escapes across a long styled line', () => {
    // `open` must reset on a full reset, or every continuation row replays every
    // escape seen so far and output grows with (escapes x rows).
    const pieces: string[] = []
    for (let index = 0; index < 2000; index += 1) {
      pieces.push(index % 2 === 0 ? '\u001b[31m' : '\u001b[0m', 'x')
    }
    const source = pieces.join('')
    const rendered = wrapToWidth(source, 20).join('')
    expect(rendered.length).toBeLessThan(source.length * 4)
  })
})

describe('hangingIndent() reserve', () => {
  it('reserves the wider of the mark and the indent', () => {
    // `你 ` is three columns while the indent is two, so budgeting by the indent
    // alone let the first row overrun the terminal it promised to fit.
    for (const row of hangingIndent('\u4f60 ', '  ', 'x'.repeat(10), 5)) {
      expect(displayWidth(row), JSON.stringify(row)).toBeLessThanOrEqual(5)
    }
  })

  it('keeps every row inside the terminal down to one column', () => {
    for (let columns = 1; columns <= 12; columns += 1) {
      for (const [mark, indent] of [['\u25cf ', '  '], ['\u4f60 ', '  '], ['\u00b7 ', '  ']] as const) {
        for (const row of hangingIndent(mark, indent, 'aaaa bbbb cccc', columns)) {
          expect(displayWidth(row), `columns=${String(columns)} row=${JSON.stringify(row)}`)
            .toBeLessThanOrEqual(columns)
        }
      }
    }
  })
})

describe('variation selectors and escapes mixed with zero-width characters', () => {
  it('keeps a variation selector with the emoji it presents', () => {
    const rows = wrapToWidth(`\u263a\ufe0f${'x'.repeat(10)}`, 4).map(stripAnsi)
    expect(rows.some(row => row.startsWith('\ufe0f'))).toBe(false)
  })

  it('replays an escape without replaying the mark beside it', () => {
    const source = `\u001b[31m${'a'.repeat(3)}\u0301${'b'.repeat(6)}\u001b[0m`
    const rows = wrapToWidth(source, 4)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      // Continuation rows reopen the colour they were drawn under...
      expect(row).toContain('\u001b[31m')
      // ...but never start with the combining mark, which belongs to its base.
      expect(stripAnsi(row).startsWith('\u0301')).toBe(false)
    }
    // Every visible character survives exactly once, in order.
    expect(stripAnsi(rows.join('')).replace(/\s+/gu, '')).toBe('aaa\u0301bbbbbb')
  })
})
