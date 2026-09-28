import { describe, expect, it } from 'vitest'
import { createMarkdownRenderer, escapeControls, paint, renderInline, renderMarkdown, stripAnsi } from '../src/index.ts'

/** Rendered lines with styling removed, so structure is readable in assertions. */
function plain(source: string): string[] {
  return renderMarkdown(source).map(stripAnsi)
}

describe('renderMarkdown()', () => {
  it('renders headings without their markers', () => {
    expect(plain('# Title\n## Section\n### Detail')).toEqual(['Title', 'Section', 'Detail'])
  })

  it('renders bullets with a glyph per nesting depth', () => {
    expect(plain('- one\n  - two\n    - three')).toEqual(['• one', '  ◦ two', '    ‣ three'])
  })

  it('keeps ordered list numbers', () => {
    expect(plain('1. first\n2) second')).toEqual(['1. first', '2. second'])
  })

  it('renders a block quote with a gutter', () => {
    expect(plain('> quoted')).toEqual(['▏ quoted'])
  })

  it('renders a thematic break', () => {
    expect(plain('---')).toEqual(['───'])
  })

  it('drops fence markers and keeps the code, indented', () => {
    expect(plain('```ts\nconst a = 1\n```')).toEqual(['ts', '  const a = 1'])
  })

  it('leaves markdown syntax inside a fence literal', () => {
    // A code block is the one place where **bold** is text, not emphasis.
    expect(plain('```\n**not bold** and `not code`\n```')).toEqual(['  **not bold** and `not code`'])
  })

  it('leaves an unrecognised line as its own text', () => {
    expect(plain('just a sentence.')).toEqual(['just a sentence.'])
  })

  it('preserves blank lines between paragraphs', () => {
    expect(plain('one\n\ntwo')).toEqual(['one', '', 'two'])
  })
})

describe('renderInline()', () => {
  it('strips emphasis markers', () => {
    expect(stripAnsi(renderInline('**bold** and *italic* and ~~struck~~'))).toBe('bold and italic and struck')
  })

  it('strips code span backticks', () => {
    expect(stripAnsi(renderInline('call `readFile` first'))).toBe('call readFile first')
  })

  it('treats emphasis inside a code span as literal', () => {
    // The code pattern is tried first precisely so this stays text.
    expect(stripAnsi(renderInline('`**not bold**`'))).toBe('**not bold**')
  })

  it('renders a link as its text plus target', () => {
    expect(stripAnsi(renderInline('see [docs](https://example.com)'))).toBe('see docs (https://example.com)')
  })

  it('emits an unmatched marker literally rather than swallowing the line', () => {
    // A lone asterisk is common in prose; consuming to end of line would lose it.
    expect(stripAnsi(renderInline('2 * 3 = 6'))).toBe('2 * 3 = 6')
    expect(stripAnsi(renderInline('a **dangling'))).toBe('a **dangling')
  })

  it('applies styling, not only marker removal', () => {
    // stripAnsi is used elsewhere to read structure, so at least one test has to
    // confirm there was styling there to strip.
    expect(renderInline('**bold**')).not.toBe('bold')
    expect(renderInline('**bold**')).toContain('\u001b[1m')
  })
})

describe('delimiter flanking', () => {
  const inline = (source: string): string => stripAnsi(renderInline(source))

  it('leaves snake_case identifiers intact', () => {
    // Underscores inside a word are part of the word. Without this the reply
    // reads "snakecasename" — and italic is invisible in several terminals, so
    // the user sees only the damage, in a name they may need to type.
    expect(inline('snake_case_name')).toBe('snake_case_name')
    expect(inline('MY_CONST_NAME')).toBe('MY_CONST_NAME')
    expect(inline('a_b_c')).toBe('a_b_c')
    expect(inline('some_var and other_var')).toBe('some_var and other_var')
  })

  it('leaves file names intact', () => {
    expect(inline('file_name.ts')).toBe('file_name.ts')
    expect(inline('see src/my_module/index_test.py')).toBe('see src/my_module/index_test.py')
  })

  it('leaves dunder names intact', () => {
    // A deliberate deviation: CommonMark reads __init__ as strong emphasis, but in
    // a reply about code it is a Python dunder far more often.
    expect(inline('__init__')).toBe('__init__')
    expect(inline('__all__ and __name__')).toBe('__all__ and __name__')
  })

  it('leaves arithmetic intact', () => {
    // A delimiter followed by whitespace cannot open emphasis.
    expect(inline('2 * 3 * 4')).toBe('2 * 3 * 4')
    expect(inline('5 ** 2')).toBe('5 ** 2')
    expect(inline('a * b * c')).toBe('a * b * c')
  })

  it('still renders genuine emphasis', () => {
    expect(inline('**bold**')).toBe('bold')
    expect(inline('*italic*')).toBe('italic')
    expect(inline('_italic_')).toBe('italic')
    expect(inline('~~struck~~')).toBe('struck')
    expect(inline('a **b c** d')).toBe('a b c d')
  })

  it('still renders multi-word double-underscore emphasis', () => {
    // The dunder rule keys on the absence of whitespace, so real emphasis works.
    expect(inline('__bold text__')).toBe('bold text')
  })

  it('allows intraword asterisk emphasis, which CommonMark permits', () => {
    expect(inline('x*y*z')).toBe('xyz')
  })

  it('reads the preceding character as a code point, not a UTF-16 unit', () => {
    // A supplementary-plane letter occupies two code units, so indexing by unit
    // returns a lone surrogate, WORD does not match it, and the position reads as
    // non-word — reintroducing exactly the corruption the flanking test prevents.
    expect(inline('\u{10400}_name_')).toBe('\u{10400}_name_')
    expect(inline('\u{1d400}_x_')).toBe('\u{1d400}_x_')
    // A supplementary-plane NON-letter is not a word character, so emphasis still
    // opens after it.
    expect(inline('\u{1f600}_x_')).toBe('\u{1f600}x')
  })

  it('never matches part of a longer delimiter run', () => {
    // A rejected `__` must not let the single `_` form eat one underscore of the
    // pair. That produced `_init_` — mangled differently rather than left alone —
    // so the assertion is that the text survives byte for byte.
    expect(inline('__init__')).toBe('__init__')
    expect(inline('***both***')).toBe('***both***')
    // And nothing was styled, which an equality check on stripped text cannot see.
    expect(renderInline('__init__')).toBe('__init__')
  })
})

/**
 * What each of these rendered before the inline scanner started walking the line
 * by index, captured from the pattern-based implementation and kept byte for byte.
 *
 * The optimisation this replaced matched every construct against the remaining
 * SUFFIX, which is correct and slow: the interesting question is not what changed
 * but whether anything else did, and a table of exact output answers that in one
 * assertion. Escapes are spelled `\e` so a row stays readable; the roles are part
 * of the expectation, because `stripAnsi` hides a role that was applied wrongly.
 */
const EQUIVALENCE: readonly (readonly [string, string])[] = [
  // Prose, arithmetic, and emphasis that closes.
  ['just a sentence.', 'just a sentence.'],
  ['', ''],
  [' ', ' '],
  ['a', 'a'],
  ['2 * 3 = 6', '2 * 3 = 6'],
  ['5 ** 2', '5 ** 2'],
  ['a * b * c', 'a * b * c'],
  ['**bold**', '\\e[1mbold\\e[0m'],
  ['*italic*', '\\e[3mitalic\\e[0m'],
  ['_italic_', '\\e[3mitalic\\e[0m'],
  ['~~struck~~', '\\e[2mstruck\\e[0m'],
  ['a **b c** d', 'a \\e[1mb c\\e[0m d'],
  ['x*y*z', 'x\\e[3my\\e[0mz'],
  ['**bold** and *italic* and ~~struck~~', '\\e[1mbold\\e[0m and \\e[3mitalic\\e[0m and \\e[2mstruck\\e[0m'],
  ['__bold text__', '\\e[1mbold text\\e[0m'],
  ['**a**b**c**', '\\e[1ma\\e[0mb\\e[1mc\\e[0m'],
  ['***both***', '***both***'],
  ['*a*b*c*', '\\e[3ma\\e[0mb\\e[3mc\\e[0m'],
  ['~~a~~b~~', '\\e[2ma\\e[0mb~~'],
  ['a~~b~~c', 'a\\e[2mb\\e[0mc'],
  ['snake_case_name', 'snake_case_name'],

  // Identifiers, paths, and delimiters that must stay literal.
  ['MY_CONST_NAME', 'MY_CONST_NAME'],
  ['a_b_c', 'a_b_c'],
  ['some_var and other_var', 'some_var and other_var'],
  ['file_name.ts', 'file_name.ts'],
  ['src/my_module/index_test.py', 'src/my_module/index_test.py'],
  ['__init__', '__init__'],
  ['__all__ and __name__', '__all__ and __name__'],
  ['_private', '_private'],
  ['a_', 'a_'],
  ['_a', '_a'],
  ['__', '__'],
  ['_', '_'],
  ['2 * 3 * 4', '2 * 3 * 4'],
  ['** 2', '** 2'],
  ['a * b', 'a * b'],
  ['_ ', '_ '],
  [' _ ', ' _ '],
  ['* ', '* '],
  [' *', ' *'],
  ['~~', '~~'],
  ['~~x', '~~x'],
  ['x~~', 'x~~'],
  ['a **dangling', 'a **dangling'],
  ['a *dangling', 'a *dangling'],
  ['a _dangling', 'a _dangling'],
  ['a ~~dangling', 'a ~~dangling'],
  ['**', '**'],
  ['****', '****'],
  ['*****', '*****'],
  ['**_', '**_'],
  ['_**', '_**'],

  // Code spans, including runs that do not match.
  ['`code`', '\\e[36mcode\\e[0m'],
  ['call `readFile` first', 'call \\e[36mreadFile\\e[0m first'],
  ['`**not bold**`', '\\e[36m**not bold**\\e[0m'],
  ['`a` `b`', '\\e[36ma\\e[0m \\e[36mb\\e[0m'],
  ['``a`b``', '`\\e[36ma\\e[0mb``'],
  ['`', '`'],
  ['``', '``'],
  ['```', '```'],
  ['````', '````'],
  ['`unterminated', '`unterminated'],
  ['a `b', 'a `b'],
  ['`a`b`c`', '\\e[36ma\\e[0mb\\e[36mc\\e[0m'],
  ['` `', '\\e[36m \\e[0m'],
  ['`\\e[2J`', '\\e[36m^[[2J\\e[0m'],
  ['`` ` ``', '`\\e[36m \\e[0m ``'],
  ['a``b``c', 'a\\e[36mb\\e[0mc'],
  ['`a``b`', '\\e[36ma\\e[0m\\e[36mb\\e[0m'],

  // Links that close.
  ['[text](target)', '\\e[36mtext\\e[0m\\e[90m (target)\\e[0m'],
  ['see [docs](https://example.com)', 'see \\e[36mdocs\\e[0m\\e[90m (https://example.com)\\e[0m'],
  ['[a](b)c', '\\e[36ma\\e[0m\\e[90m (b)\\e[0mc'],
  ['x[y](z)w', 'x\\e[36my\\e[0m\\e[90m (z)\\e[0mw'],
  ['[a](b) [c](d)', '\\e[36ma\\e[0m\\e[90m (b)\\e[0m \\e[36mc\\e[0m\\e[90m (d)\\e[0m'],
  ['[nested [x]](y)', '[nested [x]](y)'],
  ['[a](b(c))', '\\e[36ma\\e[0m\\e[90m (b(c)\\e[0m)'],

  // Links that do not, for one reason or another.
  ['[a]( )', '[a]( )'],
  ['[a](b c)', '[a](b c)'],
  ['[](x)', '[](x)'],
  ['[]()', '[]()'],
  ['[a]()', '[a]()'],
  ['[a](b', '[a](b'],
  ['[', '['],
  ['[]', '[]'],
  ['[a', '[a'],
  ['[a]', '[a]'],
  ['[a](', '[a]('],
  ['[a](b', '[a](b'],
  ['[a](b ', '[a](b '],
  ['[a]b](c)', '[a]b](c)'],
  ['[[', '[['],
  ['[[a', '[[a'],
  ['[[[a]]', '[[[a]]'],
  ['[a[b](c)', '\\e[36ma[b\\e[0m\\e[90m (c)\\e[0m'],
  ['[a](b)[c', '\\e[36ma\\e[0m\\e[90m (b)\\e[0m[c'],
  ['][', ']['],
  ['a[b]c(d)e', 'a[b]c(d)e'],
  ['[a](b)]', '\\e[36ma\\e[0m\\e[90m (b)\\e[0m]'],
  ['[a]]](b)', '[a]]](b)'],
  ['[[a]](b)', '[[a]](b)'],

  // Delimiters mixed inside one another: none of them nest.
  ['[a](<b>)', '\\e[36ma\\e[0m\\e[90m (<b>)\\e[0m'],
  ['[a](b"c")', '\\e[36ma\\e[0m\\e[90m (b"c")\\e[0m'],
  ['[**a**](b)', '\\e[36m**a**\\e[0m\\e[90m (b)\\e[0m'],
  ['[`a`](b)', '\\e[36m`a`\\e[0m\\e[90m (b)\\e[0m'],
  ['*[a](b)*', '\\e[3m[a](b)\\e[0m'],
  ['`[a](b)`', '\\e[36m[a](b)\\e[0m'],
  ['[a](b)*c*', '\\e[36ma\\e[0m\\e[90m (b)\\e[0m\\e[3mc\\e[0m'],
  ['_[a](b)_', '\\e[3m[a](b)\\e[0m'],
  ['~~[a](b)~~', '\\e[2m[a](b)\\e[0m'],
  ['[a](b`c`d)', '\\e[36ma\\e[0m\\e[90m (b`c`d)\\e[0m'],
  ['[a](**b**)', '\\e[36ma\\e[0m\\e[90m (**b**)\\e[0m'],
  ['[*a*](b)', '\\e[36m*a*\\e[0m\\e[90m (b)\\e[0m'],
  ['[a[b](c)d](e)', '\\e[36ma[b\\e[0m\\e[90m (c)\\e[0md](e)'],

  // Supplementary-plane and non-Latin text around a delimiter.
  ['`[a](', '`[a]('],
  ['\u{10400}_name_', '\u{10400}_name_'],
  ['\u{1d400}_x_', '\u{1d400}_x_'],
  ['\u{1f600}_x_', '\u{1f600}\\e[3mx\\e[0m'],
  ['**\u{10400}**', '\\e[1m\u{10400}\\e[0m'],
  ['[café](naïve)', '\\e[36mcafé\\e[0m\\e[90m (naïve)\\e[0m'],
  ['`\u{1f600}`', '\\e[36m\u{1f600}\\e[0m'],
  ['\u{10400}[a](b)', '\u{10400}\\e[36ma\\e[0m\\e[90m (b)\\e[0m'],
  ['[a](b)\u{10400}', '\\e[36ma\\e[0m\\e[90m (b)\\e[0m\u{10400}'],
  ['é**a**é', 'é\\e[1ma\\e[0mé'],
  ['中文**粗体**', '中文\\e[1m粗体\\e[0m'],

  // Control characters, which are shown rather than obeyed.
  ['a b', 'a b'],
  ['before \\e[2J after', 'before ^[[2J after'],
  ['a\rb', 'a^Mb'],
  ['a\u{0}b', 'a^@b'],
  ['[t\\e[2J](u\\e[2J)', '\\e[36mt^[[2J\\e[0m\\e[90m (u^[[2J)\\e[0m'],
  ['`\\e[2J`', '\\e[36m^[[2J\\e[0m'],
  ['**\\e[1m**', '\\e[1m^[[1m\\e[0m'],

  // Whitespace at the edges of a construct.
  ['[a] (b)', '[a] (b)'],
  ['*  a  *', '*  a  *'],
  ['**  **', '**  **'],
  ['`  `', '\\e[36m  \\e[0m'],
  ['[ a ]( b )', '[ a ]( b )'],
  [' \n ', ' \n '],
  ['a\nb', 'a\nb'],
]

describe('inline equivalence', () => {
  /**
   * Put the SGR bytes back. Both columns of the table spell them `\e`, because a
   * literal escape in a test file is invisible in a diff and invisible in a
   * failure message, and `\e` is not a JavaScript escape either — it is the
   * letter e, which is how a table full of styling becomes a table full of `e`.
   */
  const bytes = (row: string): string => row.replace(/\\e/g, '\u001b')

  /**
   * Whether the block layer may claim a line for itself — a heading, quote, bullet,
   * ordered marker, fence, or rule — in which case the row it produces is
   * deliberately not the inline rendering and the table says nothing about it.
   *
   * Deliberately conservative. A line this wrongly calls a block construct is
   * merely left uncovered by the check below; it is still covered inline, and
   * every block branch has its own test where a heading or a list really belongs.
   */
  const claimedByTheBlockLayer = (source: string): boolean =>
    /^[\s#>\-+*~`\d]/u.test(source) || /^[-*_ \t]+$/u.test(source)

  it.each(EQUIVALENCE)('renders %j exactly as it did', (source, expected) => {
    expect(renderInline(bytes(source))).toBe(bytes(expected))
  })

  it('reaches the same rows through the block renderer', () => {
    // The same sources through `line()`, so the whole path a reply takes is
    // covered rather than only the inline half of it.
    let checked = 0
    for (const [source, expected] of EQUIVALENCE) {
      if (claimedByTheBlockLayer(source)) continue
      const rows = createMarkdownRenderer().line(bytes(source))
      expect(rows, source).toHaveLength(1)
      expect(rows[0], source).toBe(bytes(expected))
      checked += 1
    }
    // A guard on the guard: if the block layer ever claims nearly everything, this
    // stops being an equivalence check and starts being a loop over nothing.
    expect(checked).toBeGreaterThan(EQUIVALENCE.length / 2)
  })
})

describe('malformed inline markdown', () => {
  const inline = (source: string): string => stripAnsi(renderInline(source))

  /**
   * Lines that must come back as the characters they went in as.
   *
   * The property is exact on purpose: escaping and nothing else. A matcher that is
   * both faster and more willing is the obvious way to break this file, because
   * "be permissive about a closing bracket" and "stop rescanning" look like the
   * same change. Every one of these was already literal before the inline scanner
   * became index-based, and has to stay literal after it.
   */
  const LITERAL: readonly (readonly [string, string])[] = [
    ['a run of opening brackets', '['.repeat(64)],
    ['a run of opening brackets and the tail behind them', `${'['.repeat(64)}tail`],
    ['closing brackets with nothing opening them', ']'.repeat(64)],
    ['link text that never closes', '[text'.repeat(16)],
    ['a closed link followed by a paren and no target', '[text]('.repeat(16)],
    ['brackets that never enclose a character', '[](('.repeat(16)],
    ['a rejected bracket in front of one that would close', '[a]b]('.repeat(16)],
    ['a rejected bracket in front of a complete link', '[a]b](c)'.repeat(16)],
    ['a bracket run closed only at the end of the line', `${'['.repeat(32)}](x`],
    ['an empty target', '[a]()'],
    ['a target stopped by a space', '[a](b c)'.repeat(8)],
    ['no text between the brackets', '[](a)'.repeat(8)],
    ['an unterminated backtick run', '`'.repeat(64)],
    ['an unterminated backtick run and its tail', `${'`'.repeat(30)}tail`],
    ['a backtick run of two that never closes', '``'.repeat(20)],
    ['a run of asterisks', '*'.repeat(64)],
    ['a run of underscores', '_'.repeat(64)],
    ['a run of double tildes', '~~'.repeat(24)],
    ['underscores whose closers all touch a word', '_a_x '.repeat(16)],
    ['dunder-shaped runs whose closers all touch a word', '__a_ '.repeat(16)],
    ['an escape sequence inside a link that never closes', '[a\u001b[2J](b'],
    ['a supplementary letter in front of an unfinished link', '\u{10400}[a]('],
  ]

  it.each(LITERAL)('keeps %s literal', (_name, source) => {
    expect(renderInline(source)).toBe(escapeControls(source))
  })

  it('stops at the first bracket that closes, rather than looking for a later one', () => {
    // The one place a faster search could have become a more willing parser: the
    // closer is the first `]` because the link text may not contain one, so a
    // scan that skipped a rejected candidate would find the `]` at the end and
    // render a link out of `[a]b](c)`. It stayed literal before; it must now too.
    expect(inline('[a]b](c)')).toBe('[a]b](c)')
    expect(inline('[a](b)')).toBe('a (b)')
  })

  it('finds the link that a long run of brackets does end with', () => {
    // The same shape as the literal case above, one closing bracket later. The
    // bracket run is the link text here, so this is a link and has to read as one.
    const brackets = '['.repeat(32)
    expect(inline(`${brackets}](x)`)).toBe(`${brackets.slice(1)} (x)`)
  })

  it('lets a shorter backtick run close a longer one that cannot', () => {
    // A closing run SHORTER than the opening one does not close it, so the span
    // opens one character later. The point is that giving up on the long run does
    // not lose the code span, which is what a "no equal-length run, so nothing
    // here" shortcut would have done.
    const opening = '`'.repeat(20)
    const content = 'a'.repeat(20)
    expect(renderInline(`${opening}${content}\``)).toBe(
      `${opening.slice(1)}${paint(content, 'code')}`,
    )
  })

  it('keeps a control sequence readable inside malformed markdown', () => {
    // Escaping happens as the text is emitted, so an unterminated construct cannot
    // become a hole in it — the one place a scanner that emitted spans lazily
    // would be tempted to leave a gap.
    const source = `[\u001b[2J${'('.repeat(32)}`
    expect(inline(source)).toBe(`[^[[2J${'('.repeat(32)}`)
    expect(renderInline(source)).not.toContain('\u001b')
  })

  it('leaves a supplementary-plane character before a delimiter literal', () => {
    // The flanking test reads a whole code point, and a scan that indexed by UTF-16
    // unit would see a lone surrogate there and decide the position was not a word.
    expect(inline('\u{10400}_name_')).toBe('\u{10400}_name_')
    expect(inline('\u{10400}_a_x_')).toBe('\u{10400}_a_x_')
  })
})

describe('fenced blocks', () => {
  const fence = '```'
  const longer = '````'

  it('keeps a shorter fence inside a longer one as content', () => {
    // The shape a model produces when showing fenced examples inside a fenced
    // answer. Closing on the inner run inverted every block after it.
    expect(plain([longer + 'md', 'before', fence, 'inside', fence, 'after', longer, 'outside'].join('\n')))
      .toEqual(['md', '  before', '  ' + fence, '  inside', '  ' + fence, '  after', 'outside'])
  })

  it('does not let a closing fence carry an info string', () => {
    expect(plain([fence + 'js', 'code', fence + 'python', 'still code', fence].join('\n')))
      .toEqual(['js', '  code', '  ' + fence + 'python', '  still code'])
  })

  it('treats a deeply indented fence inside a block as content', () => {
    // CommonMark allows at most three spaces of indent for a fence.
    expect(plain([fence, '        ' + fence, 'still inside', fence].join('\n')))
      .toEqual(['          ' + fence, '  still inside'])
  })
})

describe('untrusted content', () => {
  it('neutralizes an escape sequence in prose', () => {
    // A model can emit a control sequence anywhere, not only inside code spans.
    expect(stripAnsi(renderInline('before \u001b[2J after'))).toBe('before ^[[2J after')
  })

  it('neutralizes an escape sequence inside a code span', () => {
    expect(stripAnsi(renderInline('`\u001b[2J`'))).toBe('^[[2J')
  })

  it('neutralizes an escape sequence inside a fenced block', () => {
    expect(plain('```\n\u001b[2Jwiped\n```')).toEqual(['  ^[[2Jwiped'])
  })

  it('neutralizes an escape sequence in a heading, a bullet, and a link', () => {
    expect(plain('# \u001b[2Jtitle')).toEqual(['^[[2Jtitle'])
    expect(plain('- \u001b[2Jitem')).toEqual(['• ^[[2Jitem'])
    expect(stripAnsi(renderInline('[t\u001b[2J](u\u001b[2J)'))).toBe('t^[[2J (u^[[2J)')
  })

  it('neutralizes a carriage return, which would reposition the cursor', () => {
    expect(stripAnsi(renderInline('a\rb'))).toBe('a^Mb')
  })

  it('leaves no raw escape byte anywhere in rendered output', () => {
    const hostile = '# h\u001b[2J\n- b\u001b[2J\n> q\u001b[2J\n`c\u001b[2J`\n```\nf\u001b[2J\n```\n**e\u001b[2J**'
    for (const line of renderMarkdown(hostile)) {
      // Styling introduces its own escapes, so the check is that no escape
      // survives from the SOURCE — every one is followed by a styling parameter.
      expect(stripAnsi(line)).not.toContain('\u001b')
    }
  })
})

describe('pathological input', () => {
  /**
   * Time one line through the line renderer, which is where the patterns run.
   *
   * renderMarkdown splits on newlines first, so it can never hand a pattern a line
   * containing one — and a trailing newline is exactly the input that makes an
   * end-anchored marker pattern quadratic. The renderer is public, so the guard
   * belongs at the level a consumer can actually reach.
   * @param line - the line to render.
   * @returns elapsed milliseconds.
   */
  function elapsed(line: string): number {
    const renderer = createMarkdownRenderer()
    const started = performance.now()
    renderer.line(line)
    return performance.now() - started
  }

  /**
   * The fastest of several renders of one line.
   *
   * Best-of-N rather than mean, because the question is how the COST grows and a
   * GC pause or a scheduling hiccup on a shared runner adds to a sample without
   * saying anything about the shape of the curve. The first run also carries the
   * cost of the code not being warm yet, which would otherwise be read as the
   * price of the smallest line in the series.
   *
   * The line must already exist. Building a megabyte of input is itself
   * super-linear under memory pressure, so a caller that passes a builder here
   * measures the allocator and reports a green implementation as quadratic.
   * @param line - the line to render.
   * @param runs - how many times to render it.
   * @returns elapsed milliseconds.
   */
  function fastest(line: string, runs = 5): number {
    let best = Infinity
    for (let run = 0; run < runs; run += 1) {
      best = Math.min(best, elapsed(line))
    }
    return best
  }

  // Generous on purpose: the point is the difference between linear and quadratic,
  // not a benchmark. Before the patterns were bounded, 40k spaces took seconds;
  // after, it is sub-millisecond, so anything under this bound proves the class of
  // behaviour without being sensitive to the machine.
  const BUDGET_MS = 500

  it('renders a long run of spaces in linear time', () => {
    // The shape that made it quadratic: an unbounded indent in front of a marker
    // is ambiguous with the whitespace that follows it, so on a line the pattern
    // ultimately rejects, the engine retries at every split. A model emits rows of
    // spaces routinely, so this was reachable from model output.
    expect(elapsed(' '.repeat(40_000))).toBeLessThan(BUDGET_MS)
  })

  it('renders a long run of spaces after a list marker in linear time', () => {
    expect(elapsed(`* ${' '.repeat(40_000)}`)).toBeLessThan(BUDGET_MS)
    expect(elapsed(`9) ${' '.repeat(40_000)}`)).toBeLessThan(BUDGET_MS)
    expect(elapsed(`- ${'\t'.repeat(20_000)}`)).toBeLessThan(BUDGET_MS)
  })

  it('renders a long run of rule characters in linear time', () => {
    expect(elapsed('- '.repeat(20_000))).toBeLessThan(BUDGET_MS)
    expect(elapsed(`${'_ '.repeat(20_000)}x`)).toBeLessThan(BUDGET_MS)
  })

  it('renders a line ending in a newline in linear time', () => {
    // The case an earlier fix here got backwards. `\s` matches a newline, so a
    // greedy `\s+` swallows a trailing one and the first attempt succeeds;
    // narrowing the separator to `[ \t]` meant every split got tried instead, and
    // a 16k line went from 0.1 ms to 2367 ms. Matching the marker as a prefix, with
    // no end anchor to fail against, is what removes the ambiguity for good.
    for (const line of [
      `9) ${'  '.repeat(8_000)}\n`,
      `* ${'  '.repeat(8_000)}\n`,
      `# ${'  '.repeat(8_000)}\n`,
      `> ${'  '.repeat(8_000)}\n`,
      `${' '.repeat(16_000)}\n`,
      `${'- '.repeat(8_000)}\n`,
    ]) {
      expect(elapsed(line), JSON.stringify(line.slice(0, 4))).toBeLessThan(BUDGET_MS)
    }
  })

  /** A backtick, named so the shapes below read as shapes rather than as quoting. */
  const TICK = '`'

  /**
   * Malformed shapes that used to rescan the remaining suffix on every character.
   *
   * Eight of these were quadratic before the inline scanner became index-based,
   * measured at 2 ms to 250 ms for 20k characters and growing by four whenever
   * the input doubled — which is the whole defect: the anchored link, code, and
   * emphasis patterns were asked about a suffix already proved to hold nothing,
   * once per character, while the loop moved on by one. A model emits half a link
   * more often than it emits malformed markdown on purpose.
   *
   * The bracketed one is the exception, and it is here for the opposite reason.
   * It was already linear, and it stays that way only as long as the link search
   * does not skip a rejected `]` to find a later one — which is both the obvious
   * way to make this search faster and the one that would also make the renderer
   * more willing, so it is worth a timing test of its own.
   */
  const RESCANS: readonly (readonly [string, (size: number) => string])[] = [
    ['a run of opening brackets', size => '['.repeat(size)],
    ['a bracket run closed only at the very end', size => `${'['.repeat(size)}]`],
    ['link text with no target', size => '[text'.repeat(Math.ceil(size / 5))],
    ['a bracket, a paren, and no target', size => '[a]('.repeat(Math.ceil(size / 4))],
    ['a bracket run followed by a broken target', size => `${'['.repeat(size / 2)}](x`],
    ['rejected brackets in front of one that would close', size => '[a]b]('.repeat(Math.ceil(size / 6))],
    ['an unterminated backtick run', size => `x${TICK.repeat(size)}`],
    ['a backtick run no closing run can match', size => `x${TICK.repeat(size / 2)}${'a'.repeat(size / 2)}${TICK}`],
    ['underscores that never close', size => '_a_x '.repeat(Math.ceil(size / 5))],
  ]

  /** Line length the growth check starts from. */
  const GROWTH_BASE = 65_536

  /**
   * The largest line either check renders, 256k characters.
   *
   * Chosen so that a REGRESSION fails instead of hanging. A quadratic render of
   * this length is about six seconds, comfortably inside a test run, while a
   * quadratic render of a million is about six MINUTES — and a synchronous one
   * cannot be interrupted, because a blocked event loop cannot run the timeout
   * that would report it. So a million here would not fail CI, it would park the
   * job. The margin the scan needs is the other way round anyway: at 256k it
   * finishes in microseconds, which is five orders of magnitude under the budget,
   * while a restored rescan is twelve times over it.
   */
  const LARGEST = GROWTH_BASE * 4

  /**
   * Slack in the growth check, in milliseconds.
   *
   * It is a millisecond against samples that are either microseconds — where it
   * is everything, and a GC pause on a shared runner must not read as growth — or
   * seconds, where it is nothing and a quadratic step cannot hide behind it. That
   * is the shape worth having: the allowance only dilutes the check when there is
   * no signal left to read.
   */
  const GROWTH_SLACK_MS = 1

  /**
   * The fastest of several INLINE renders of one line, timed on their own.
   *
   * Separate from {@link fastest} because the growth check needs the scan and
   * nothing else; see there.
   * @param line - the line to render.
   * @param runs - how many times to render it.
   * @returns elapsed milliseconds.
   */
  function fastestInline(line: string, runs = 2): number {
    let best = Infinity
    for (let run = 0; run < runs; run += 1) {
      const started = performance.now()
      renderInline(line)
      best = Math.min(best, performance.now() - started)
    }
    return best
  }

  it.each(RESCANS)('renders %s in linear time', (name, build) => {
    // Through the real entry point, so this covers the block layer too, which
    // stays linear in the length of a line. On the slowest runner these shapes
    // measured 30 ms at 256k; a restored rescan measures 25 401 ms at the same
    // size, and the budget is 500.
    const line = build(LARGEST)
    expect(fastest(line, 2), name).toBeLessThan(BUDGET_MS)
  })

  it.each(RESCANS)('scales %s with the length of the line, not its square', (name, build) => {
    // Each doubling may cost at most three times the last. Linear doubling is two
    // and so keeps half the allowance in hand; rescanning the suffix is four and
    // spends the whole step past it.
    //
    // The inline scan is timed on its OWN, which is the whole point of the
    // difference: `line()` stays linear in the length of a line, because the
    // block layer rewrites the whole line looking for a thematic break and the
    // escaper walks all of it. Measuring that growth forbids work the renderer is
    // right to do, and this check failed on CI for exactly that before it was
    // measuring the scan the change was about.
    //
    // Every line is built BEFORE it is timed, and that is load-bearing too:
    // building 256k of brackets is itself super-linear under a shared runner's
    // memory pressure, so a check that times `build(size)` measures the
    // allocator instead of the renderer — and reports a green implementation as
    // quadratic. Both mistakes failed the first two runs of this file on CI.
    let previous = fastestInline(build(GROWTH_BASE))
    for (const size of [GROWTH_BASE * 2, LARGEST]) {
      const current = fastestInline(build(size))
      expect(current, `${name} at ${size}`).toBeLessThan(3 * previous + GROWTH_SLACK_MS)
      previous = current
    }
  })

  it('still reads a deeply indented list item as a list item', () => {
    // The indent bound has to be generous enough that real nesting still works.
    expect(plain(`${' '.repeat(20)}- deep`)).toEqual([`${' '.repeat(20)}\u2023 deep`])
  })

  it('treats an indent past the bound as prose, not a list', () => {
    const far = ' '.repeat(200)
    expect(plain(`${far}- not a bullet`)).toEqual([`${far}- not a bullet`])
  })

  it('requires a rule to repeat one character, per CommonMark', () => {
    // Stripping the separators and testing the remainder is what made this linear,
    // and it corrects the rule at the same time: `-*_` was never a thematic break.
    expect(plain('---')).toEqual(['\u2500\u2500\u2500'])
    expect(plain('* * *')).toEqual(['\u2500\u2500\u2500'])
    expect(plain('___')).toEqual(['\u2500\u2500\u2500'])
    expect(plain('-*_')).toEqual(['-*_'])
  })

  it('caps an ordered marker at nine digits, per CommonMark', () => {
    expect(plain('1234567890. not a list')).toEqual(['1234567890. not a list'])
    expect(plain('123456789. a list')).toEqual(['123456789. a list'])
  })
})

describe('partial lines (the live region)', () => {
  it('styles an inline span the moment its markers arrive', () => {
    const renderer = createMarkdownRenderer()
    const row = renderer.partial('the **bold** tail')
    expect(stripAnsi(row)).toBe('the bold tail')
    expect(row).toContain('\u001b[1m')
  })

  it('leaves an unfinished span literal until it closes', () => {
    // A model can stream `**bo` and stop there; showing the syntax is better
    // than guessing at emphasis that never arrives.
    const renderer = createMarkdownRenderer()
    expect(stripAnsi(renderer.partial('the **bo'))).toBe('the **bo')
  })

  it('renders a heading as soon as its marker arrives', () => {
    const renderer = createMarkdownRenderer()
    expect(stripAnsi(renderer.partial('# Hea'))).toBe('Hea')
    expect(renderer.partial('# Hea')).toContain('\u001b[1;36m')
  })

  it('does not advance block state', () => {
    // The partial tail of a fence opener must not OPEN the fence: the newline
    // decides that, and only the committed line may advance state. Otherwise a
    // streamed opener would leave the renderer inside a fence that never opened.
    const renderer = createMarkdownRenderer()
    expect(renderer.partial('```')).toBe('')
    // Still read as an opener (its info line is emitted), not as fence content —
    // which is what a fence left open by the partial would have produced.
    expect(renderer.line('```ts').map(stripAnsi)).toEqual(['ts'])
    // The committed opener did advance state: the next partial is inside a fence.
    expect(stripAnsi(renderer.partial('not code'))).toBe('  not code')
  })

  it('reads the current fence state, so a partial line inside a fence is code', () => {
    const renderer = createMarkdownRenderer()
    renderer.line('```')
    const row = renderer.partial('**raw**')
    expect(stripAnsi(row)).toBe('  **raw**')
    // Never parsed for emphasis: a code block is the one place **bold** is text.
    expect(row).not.toContain('\u001b[1m')
  })

  it('neutralizes an escape sequence in a partial line', () => {
    const renderer = createMarkdownRenderer()
    const row = renderer.partial('before \u001b[2J after')
    expect(stripAnsi(row)).toBe('before ^[[2J after')
    expect(stripAnsi(row)).not.toContain('\u001b')
  })

  it('keeps a clipped suffix literal without line-start or delimiter context', () => {
    const renderer = createMarkdownRenderer()
    // The source before this suffix ended with a word character. Reading the
    // suffix as a fresh line would turn its underscores into emphasis and remove
    // them, although `name_` is part of the identifier in the real source.
    const row = renderer.partial('_name_ and ``` not a fence', false)
    expect(stripAnsi(row)).toBe('_name_ and ``` not a fence')
    expect(row).not.toContain('\u001b[3m')
  })

  it('keeps a clipped fence-looking suffix as code without closing the fence', () => {
    const renderer = createMarkdownRenderer()
    renderer.line('```')
    const row = renderer.partial('```', false)
    expect(stripAnsi(row)).toBe('  ```')
    expect(row).toContain('\u001b[36m')
    expect(stripAnsi(renderer.partial('still code'))).toBe('  still code')
  })
})
