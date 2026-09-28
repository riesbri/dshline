/**
 * Markdown to styled terminal text.
 *
 * A deliberately small subset — headings, emphasis, inline and fenced code,
 * lists, block quotes, rules, and links — because that is what a model's reply
 * actually contains, and because a parser dependency would cost the property this
 * renderer is built around: it declares no dependencies at all.
 *
 * The security rule is the ordering. Every piece of source text is escaped BEFORE
 * any styling is added, never after: {@link escapeControls} neutralises the escape
 * character itself, so running it over already-styled output would destroy the
 * styling, and running it only over some spans would let a control sequence
 * through anywhere else. Untrusted content is therefore escaped as it is emitted,
 * and styling is applied to text this module has already made safe.
 * @module @dshline/renderer/markdown
 */

import { escapeControls } from './text.ts'
import { paint } from './theme.ts'
import type { Role } from './theme.ts'

/** Bullet drawn for a list item, by nesting depth. */
const BULLETS = ['•', '◦', '‣'] as const

/** Columns of indent per nesting level. */
const INDENT = 2

/**
 * Widest leading indent a block marker is recognised behind. Past this a line is
 * prose, which is also true of real markdown: nesting this deep does not occur.
 */
const MAX_INDENT = 64

/** Digits an ordered-list number is recognised in, per CommonMark. */
const MAX_ORDINAL_DIGITS = 9

/** Render one line of fenced-code content: indented, escaped, never parsed. */
function renderFenceLine(line: string): string {
  return `  ${paint(escapeControls(line), 'code')}`
}

/**
 * One emphasis form: its delimiter, the styling it applies, and whether the
 * delimiter is allowed to sit inside a word.
 */
interface Emphasis {
  readonly delimiter: string
  readonly styles: readonly Role[]
  /**
   * Whether the delimiter may open or close with a word character on the outside.
   *
   * False for `_` and `__`, following CommonMark: an underscore inside a word is
   * part of the word. Without this rule `snake_case_name` renders as
   * `snakecasename`, which silently corrupts identifiers, file paths, and
   * environment variable names in a reply — and italic is invisible in several
   * terminals, so the user sees only the damage.
   */
  readonly intraword: boolean
  /**
   * Whether content that reads as a single identifier vetoes this form.
   *
   * True only for `__`, and a deliberate deviation from CommonMark, which reads
   * `__init__` as strong emphasis. In a reply about code that string is a Python
   * dunder far more often, and the cost of guessing wrong is asymmetric:
   * rendering it as `init` corrupts a name the reader may need to type, while
   * leaving `__bold__` unstyled loses only emphasis. Multi-word `__bold text__`
   * is unaffected, and single `_italic_` keeps CommonMark behaviour.
   */
  readonly vetoIdentifier?: true
}

/** Emphasis forms, longest delimiter first so `**` wins over `*`. */
const EMPHASIS: readonly Emphasis[] = [
  { delimiter: '**', styles: ['strong'], intraword: true },
  { delimiter: '__', styles: ['strong'], intraword: false, vetoIdentifier: true },
  { delimiter: '~~', styles: ['strike'], intraword: true },
  { delimiter: '*', styles: ['emphasis'], intraword: true },
  { delimiter: '_', styles: ['emphasis'], intraword: false },
]

/** A word character, for the intraword test. */
const WORD = /[\p{L}\p{N}]/u

/** Whitespace: an opener may not be followed by one, and a closer may not precede one. */
const WHITESPACE = /\s/u

/** Content that reads as one identifier rather than a phrase. */
const IDENTIFIER = /^[\p{L}\p{N}_]+$/u

/**
 * Block markers, matched as a PREFIX and never anchored at the end.
 *
 * This form is the whole defence against a quadratic match, and the reasoning is
 * worth stating because the obvious alternatives are both wrong. A pattern shaped
 * `^(\s*)MARKER\s+(.*)$` has two unbounded runs that can both consume a space, so
 * whenever the tail fails the engine redistributes the separator across every
 * split — O(n²) in the line's length, which is `js/polynomial-redos`. Replacing
 * `\s` with `[ \t]` makes it strictly WORSE rather than better: `\s` matches a
 * newline, so a greedy `\s+` swallows a trailing one and the first attempt
 * succeeds, while `[ \t]+` cannot, and every split then gets tried. Measured, that
 * swap took a 16k-character line from 0.1 ms to 2367 ms.
 *
 * Matching only the marker removes the ambiguity instead of moving it: there is no
 * `$` to fail against and no trailing group to compete with the separator, so the
 * greedy run is taken once and never revisited. The caller takes the content with
 * `slice`, which is linear by construction.
 */
const RULE_SEPARATORS = /[ \t]/gu
const RULE_BODY = /^(?:-{3,}|\*{3,}|_{3,})$/u
const QUOTE = new RegExp(`^[ \\t]{0,${String(MAX_INDENT)}}>[ \\t]?`, 'u')
const HEADING = /^(#{1,6})[ \t]+/u
const BULLET = new RegExp(`^([ \\t]{0,${String(MAX_INDENT)}})[-*+][ \\t]+`, 'u')
const ORDERED = new RegExp(
  `^([ \\t]{0,${String(MAX_INDENT)}})(\\d{1,${String(MAX_ORDINAL_DIGITS)}})[.)][ \\t]+`,
  'u',
)

/**
 * Whether a line is a thematic break.
 *
 * Stripping the separators first and then testing the remainder is linear, where a
 * single pattern with a repeated group around an optional run backtracks. It also
 * corrects the rule: CommonMark requires the three-or-more characters to be the
 * SAME one, so `-*_` was never a break.
 * @param line - one line of source.
 * @returns whether it renders as a rule.
 */
function isRule(line: string): boolean {
  return RULE_BODY.test(line.replace(RULE_SEPARATORS, ''))
}

/**
 * Render one line of inline markdown.
 *
 * Consumes the line left to right, so an unmatched marker is emitted as the
 * literal character it is rather than swallowing the rest of the line — a reply
 * containing a lone asterisk is common and must not lose its tail.
 *
 * The INDEX is as much a part of that contract as the order is. Matching each
 * construct against the remaining suffix — the shape every regex here started
 * with — made every failed attempt cost a rescan of everything after it while
 * the loop advanced a single character, so a line of unmatched `[` was quadratic
 * in its own length. A model writes half a link more often than it writes
 * malformed markdown on purpose, and the line was reachable from its reply
 * alone. So each construct is asked only at the characters that can open it, and
 * the searches that find its closer never look back: see {@link createInlineScan}.
 * @param source - one line of untrusted markdown source.
 * @returns styled, escaped text.
 */
export function renderInline(source: string): string {
  const scan = createInlineScan(source)
  let out = ''
  /**
   * Where the run of plain text after the last match begins.
   *
   * An index rather than an accumulated string, and that is not a style choice.
   * `out += char` once per character builds a rope of one segment per character,
   * and flattening it later is what made a quarter-megabyte line cost 21 ms on
   * Node 22.19 — four times what twice the input costs, on a line with no
   * markup in it at all. Slicing the run once when it ends gives the same string
   * with one segment, and the same output byte for byte.
   */
  let plainFrom = 0
  let at = 0
  while (at < source.length) {
    const char = source[at] ?? ''
    // Only the characters that can OPEN something are asked about it: a `b`
    // cannot begin a link, a code span, or emphasis, and asking anyway would be a
    // pattern run whose failure is certain.
    let match: InlineMatch | undefined
    if (char === '[') match = scan.link(at)
    else if (char === '`') match = scan.code(at)
    else if (char === '*' || char === '_' || char === '~') match = scan.emphasis(at)
    if (match !== undefined) {
      if (plainFrom < at) out += escapeControls(source.slice(plainFrom, at))
      out += match.styled
      at = match.end
      plainFrom = at
      continue
    }
    at += 1
  }
  if (plainFrom < source.length) out += escapeControls(source.slice(plainFrom, source.length))
  return out
}

/** One construct recognised at a position in a line. */
interface InlineMatch {
  /** The construct's own text, already styled and escaped. */
  readonly styled: string
  /** The source index just past the construct. */
  readonly end: number
}

/** The constructs one line can hold, each asked only where it can begin. */
interface InlineScan {
  /**
   * Match a link opening at a `[`.
   * @param at - the index of the `[`.
   * @returns the match, or undefined when the brackets do not close into a link.
   */
  link(at: number): InlineMatch | undefined
  /**
   * Match a code span opening at a backtick.
   * @param at - the index of the first backtick of the opening run.
   * @returns the match, or undefined when no equal-length run closes it.
   */
  code(at: number): InlineMatch | undefined
  /**
   * Match an emphasis run opening at a `*`, `_`, or `~`.
   * @param at - the index of the first delimiter character.
   * @returns the match, or undefined when no form applies here.
   */
  emphasis(at: number): InlineMatch | undefined
}

/**
 * Build the per-line scanner {@link renderInline} walks a line with.
 *
 * Each construct is still recognised by the same pattern it always was, but the
 * pattern's shape is now read out by hand once per position instead of being
 * handed to the engine as a whole. That is the whole point: an anchored pattern
 * is asked "does this match HERE" and says no without saying why, so the caller
 * has to ask again one character later, against a suffix it has already proved
 * contains nothing — and on malformed input that is quadratic. Knowing why a
 * match failed is what lets the answer be remembered: a closer that is not there
 * cannot appear later, and one that was rejected on the grounds of the character
 * beside it will be rejected again for every opener behind it.
 *
 * The searches below therefore run FORWARD only, and each is memoised by
 * {@link forwardOnly}. A link's closer is the first `]` after the `[`; an
 * emphasis closer is the first occurrence not ruled out by the character before
 * it or, for the non-intraword forms, the one after it — both properties of the
 * POSITION alone, which is exactly what makes an answer reusable by the next
 * opener further along the line.
 * @param source - one line of untrusted markdown, with no newline.
 * @returns the scanner, which answers only about this line.
 */
function createInlineScan(source: string): InlineScan {
  const length = source.length

  /**
   * Make a "next occurrence at or after" search answer from what it already knows.
   *
   * Every question these searches are asked is asked further along the line than
   * the last: the main loop only moves forward, and the closer of a construct is
   * always past the opener currently being examined. So a question that lands
   * inside a range already covered is the same question the answer was found for,
   * and a question landing past the last answer cannot be answered by it. That
   * is what makes each character examined at most once per search, and it is the
   * difference between linear and quadratic on `_a_x _a_x …`, where every `_` used
   * to rescan the whole remaining line looking for a closer it never found.
   * @param next - finds the next raw occurrence at or after a position, or -1.
   * @returns the same search, remembering where its last answer applies.
   */
  const forwardOnly = (next: (from: number) => number): ((from: number) => number) => {
    /** Positions below this have been examined and hold no occurrence. */
    let ruled = 0
    /** The first occurrence at or after {@link ruled}, or -1 for none left. */
    let found = -1
    /** Whether {@link found} is an answer yet rather than its initial -1. */
    let searched = false
    return (from: number): number => {
      if (searched && from >= ruled && (found < 0 || found >= from)) return found
      searched = true
      ruled = from
      found = next(from)
      return found
    }
  }

  /**
   * The character just before a position, for the flanking test.
   *
   * A whole code point, not a UTF-16 code unit. Indexing by unit returns a lone
   * surrogate for a supplementary-plane letter, `WORD` does not match it, and the
   * flanking test then reads the position as non-word — so `𐐀_name_` rendered as
   * `𐐀name`, which is the identifier corruption the test exists to prevent.
   * @param at - the position being examined.
   * @returns the character before it, or empty at the line start.
   */
  const before = (at: number): string => {
    if (at === 0) return ''
    const code = source.codePointAt(at - 2)
    // A high surrogate at at - 2 means the character spans both units.
    if (code !== undefined && code > 0xffff) return String.fromCodePoint(code)
    return source[at - 1] ?? ''
  }

  /**
   * The `]` that closes a link: the first one after the `[`, with nothing skipped.
   *
   * Unfiltered, unlike the emphasis searches. The text between the brackets may
   * not contain a `]`, so the first one IS the closer the pattern would use, and
   * if that one does not lead to `(` the attempt fails outright — looking further
   * would find a link the pattern never matches, and `[a]b](c)` would stop being
   * the literal text it has always been.
   */
  const nextLinkClose = forwardOnly(from => source.indexOf(']', from))

  /**
   * Where a link target ends: the first `)` or whitespace, either of which stops
   * the run a target is made of, and -1 when neither follows.
   */
  const nextTargetEnd = forwardOnly(from => {
    for (let at = from; at < length; at += 1) {
      const char = source[at] ?? ''
      if (char === ')' || WHITESPACE.test(char)) return at
    }
    return -1
  })

  /** The next backtick, for the run that closes a code span. */
  const nextBacktick = forwardOnly(from => source.indexOf('`', from))

  /**
   * The end of the run of backticks containing a position.
   *
   * Opening and closing runs are two questions asked in an interleaved order: a
   * rejected opener partway along a long run is followed by the next candidate
   * closer, which sits EARLIER than the following opener. One search asked for
   * both would be asked to go backwards, and answering that correctly means
   * discarding everything it had already proved.
   */
  const backtickRunEnd = (from: number): number => {
    let at = from
    while (source[at] === '`') at += 1
    return at
  }

  /** Where the run OPENING at a position ends. */
  const nextOpeningRunEnd = forwardOnly(backtickRunEnd)
  /** Where the run CLOSING at a candidate ends — a second search, on purpose. */
  const nextClosingRunEnd = forwardOnly(backtickRunEnd)

  /**
   * A link at a `[`: its text, then its target.
   *
   * The pattern this replaces was `^\[([^\]]+)\]\(([^)\s]+)\)`, and the shape it
   * encoded is still what decides the answer — a character is required inside the
   * brackets, and the target is the run up to the `)` that must follow it.
   * @param at - the index of the `[`.
   * @returns the match, or undefined when this is not a link.
   */
  const link = (at: number): InlineMatch | undefined => {
    // `[]` has no text, so there is no closer to look for: the character straight
    // after the `[` being a `]` is the one case where the first `]` is too early,
    // and searching from the one after it is otherwise the same first `]`.
    if (source[at + 1] === ']') return undefined
    const close = nextLinkClose(at + 2)
    if (close < 0 || source[close + 1] !== '(') return undefined
    const targetEnd = nextTargetEnd(close + 2)
    // A target is one or more characters and is closed by a `)`; whitespace ends
    // the run early, and -1 means the line ran out before either did.
    if (targetEnd <= close + 2 || source[targetEnd] !== ')') return undefined
    const text = escapeControls(source.slice(at + 1, close))
    const target = escapeControls(source.slice(close + 2, targetEnd))
    return { styled: paint(text, 'link') + paint(` (${target})`, 'link-target'), end: targetEnd + 1 }
  }

  /**
   * A code span at a backtick run: everything up to a run of equal length, taken
   * literally — emphasis markers inside it are text, not formatting.
   *
   * The pattern this replaces was `^(`+)([^`]+)\1`, and its backreference is why
   * the opening run has to be taken whole: the content may not contain a backtick,
   * so a shorter opener would have to match inside its own run and cannot.
   * @param at - the index of the first backtick of the opening run.
   * @returns the match, or undefined when no equal-length run closes it.
   */
  const code = (at: number): InlineMatch | undefined => {
    const opening = nextOpeningRunEnd(at) - at
    const contentStart = at + opening
    const close = nextBacktick(contentStart)
    if (close <= contentStart) return undefined
    // A closing run SHORTER than the opening one is not a closer, and the run it
    // sits in continues past the match — only the opening run's worth is consumed.
    if (nextClosingRunEnd(close) - close < opening) return undefined
    return {
      styled: paint(escapeControls(source.slice(contentStart, close)), 'code'),
      end: close + opening,
    }
  }

  /**
   * Whether a run of one form's delimiter may CLOSE at a position.
   *
   * A closer preceded by whitespace is not a closer, and for the non-intraword
   * forms it may not touch a word either. Both tests read the source AROUND the
   * position and never the content before it, so a run rejected here is rejected
   * for every opener behind it — which is what lets the answer be kept.
   * @param form - the emphasis form the run belongs to.
   * @param at - where the run starts.
   * @returns whether it may close there.
   */
  const closesEmphasis = (form: Emphasis, at: number): boolean => {
    if (WHITESPACE.test(source[at - 1] ?? '')) return false
    const after = source[at + form.delimiter.length] ?? ''
    return form.intraword || after === '' || !WORD.test(after)
  }

  /**
   * Each emphasis form paired with the closer search that belongs to it.
   *
   * One search per form, because the forms are told apart by the characters
   * around a run and not by the run itself: `*` may close against a word and `_`
   * may not, so one search shared between them would answer for the wrong form.
   */
  const forms = EMPHASIS.map(form => ({
    form,
    closer: forwardOnly(from => {
      let close = source.indexOf(form.delimiter, from)
      while (close >= 0 && !closesEmphasis(form, close)) {
        close = source.indexOf(form.delimiter, close + 1)
      }
      return close
    }),
  }))

  /**
   * An emphasis run at a `*`, `_`, or `~`, if any form opens and closes here.
   *
   * Delimiters must FLANK their content, which is what separates emphasis from
   * arithmetic and identifiers. An opening run may not be followed by whitespace
   * and a closing run may not be preceded by it, so `2 * 3 * 4` stays arithmetic;
   * `_` additionally may not touch a word character on the outside, so
   * `snake_case_name` stays an identifier.
   * @param at - the index of the first delimiter character.
   * @returns the match, or undefined when no form applies here.
   */
  const emphasis = (at: number): InlineMatch | undefined => {
    const char = source[at] ?? ''
    const preceding = before(at)
    for (const { form, closer } of forms) {
      const { delimiter, styles, intraword, vetoIdentifier } = form
      if (delimiter[0] !== char) continue
      if (delimiter.length === 2 && source[at + 1] !== delimiter[1]) continue
      // Never match part of a longer delimiter run. Without this, a rejected `__`
      // lets the single `_` form consume one underscore of the pair and render
      // `__init__` as `_init_` — mangled differently rather than left alone.
      if (preceding === char) continue
      if (source[at + delimiter.length] === char) continue
      if (!intraword && preceding !== '' && WORD.test(preceding)) continue
      const contentStart = at + delimiter.length
      // An opener followed by whitespace is not an opener.
      if (contentStart >= length || WHITESPACE.test(source[contentStart] ?? '')) continue
      const close = closer(contentStart + 1)
      if (close < 0) continue
      const content = source.slice(contentStart, close)
      // The identifier veto is different from the flanking tests: this IS the
      // closer CommonMark would pick, so the form is abandoned rather than
      // searched past — continuing would find a distant closer and turn
      // `__all__ and __name__` into `all__ and __name`.
      if (vetoIdentifier === true && IDENTIFIER.test(content)) continue
      return { styled: paint(escapeControls(content), ...styles), end: close + delimiter.length }
    }
    return undefined
  }

  return { link, code, emphasis }
}

/** Heading roles by level; deeper headings are quieter. */
const HEADING_STYLES: readonly (readonly Role[])[] = [
  ['heading-1'],
  ['heading-2'],
  ['heading-3'],
]

/**
 * A renderer that keeps block state between separately rendered lines.
 *
 * Fenced blocks are the only structure here that spans lines, and a caller that
 * receives markdown a line at a time — a streaming reply, committed as each line
 * completes — needs that state to survive between calls. Rendering each line with
 * a fresh {@link renderMarkdown} would reopen the fence on every line and style a
 * code block as prose.
 */
export interface MarkdownRenderer {
  /**
   * Render one source line, advancing block state.
   * @param source - one line of untrusted markdown, with no newline.
   * @returns styled, escaped lines: none for a fence marker, two for a fence
   *   opener carrying an info string, one otherwise.
   */
  line(source: string): string[]
  /**
   * Render the unfinished tail of a line as it streams.
   *
   * The live region holds the last line of a reply before its newline arrives,
   * and that line is still in flight: it may yet become a heading, a fence, or
   * plain prose. This renders it the way {@link line} will once it completes,
   * against the CURRENT block state — a partial line inside a fence reads as
   * code — without advancing that state. The fence a partial line opens or
   * closes is decided by its own newline, not by the text seen so far, which is
   * why this exists beside {@link line} rather than as a second call to it.
   *
   * A bounded live region can receive only a suffix of the source line. That
   * suffix has neither line-start nor inline-delimiter context, so it is kept
   * literal rather than treating an ordinary `#`, fence, or underscore at the
   * cut as markdown syntax.
   * @param source - the partial line, with no newline.
   * @param startsLine - whether `source` begins at the real source-line start.
   * @returns the styled, escaped row, or empty when the partial renders nothing.
   */
  partial(source: string, startsLine?: boolean): string
}

/**
 * Create a renderer that holds fence state across calls.
 * @returns the renderer; each instance is one independent document.
 */
export function createMarkdownRenderer(): MarkdownRenderer {
  /** The opening fence run, kept whole so only an equal-or-longer run closes it. */
  let fence: string | undefined
  return {
    line: source => renderLine(source, () => fence, next => { fence = next }),
    // A no-op setter: the partial line is the live region's view of a line whose
    // newline has not arrived, so nothing about block state may change yet.
    partial: (source, startsLine = true) => {
      if (!startsLine) {
        // A clipped suffix cannot tell whether its first character follows a word
        // or whether it started after earlier markdown syntax. Parsing it would
        // turn literal source into formatting; known fence state is the one fact
        // that survives the cut, so code remains recognisable without letting a
        // suffix close it.
        return fence === undefined
          ? escapeControls(source)
          : renderFenceLine(source)
      }
      return renderLine(source, () => fence, () => {}).join('')
    },
  }
}

/**
 * Render markdown to styled lines.
 *
 * Structure is recognised line by line, which is what a terminal transcript
 * needs: there is no document to reflow, only a reply to read. Anything
 * unrecognised falls through as inline-rendered text, so malformed input degrades
 * to what it already looks like today rather than disappearing.
 * @param source - untrusted markdown, typically a model reply.
 * @returns styled lines, each already escaped.
 */
export function renderMarkdown(source: string): string[] {
  const renderer = createMarkdownRenderer()
  return source.split('\n').flatMap(line => renderer.line(line))
}

/**
 * Render one line against externally held fence state.
 * @param line - one line of untrusted markdown.
 * @param getFence - reads the currently open fence run, if any.
 * @param setFence - records the fence run this line opens or closes.
 * @returns the styled lines this source line produced.
 */
function renderLine(
  line: string,
  getFence: () => string | undefined,
  setFence: (fence: string | undefined) => void,
): string[] {
  const out: string[] = []
  const fence = getFence()
  // At most three spaces of indent, per CommonMark: a deeper indent inside a
  // block is content, not a fence.
  const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
  if (fenceMatch !== null) {
    const marker = fenceMatch[1] ?? ''
    const info = (fenceMatch[2] ?? '').trim()
    if (fence === undefined) {
      setFence(marker)
      if (info !== '') out.push(paint(escapeControls(info), 'muted'))
      return out
    }
    // A closer must use the same character, be at least as long, and carry no
    // info string. Keeping only the character meant any run closed any block,
    // so a three-backtick line inside a four-backtick block ended it early and
    // inverted every block after it — which is exactly the shape a model
    // produces when it shows fenced examples inside a fenced answer.
    if (marker[0] === fence[0] && marker.length >= fence.length && info === '') {
      setFence(undefined)
      return out
    }
  }
  if (fence !== undefined) {
    // Inside a fence everything is literal: escaped, indented, never parsed for
    // emphasis. This is where a model is most likely to emit an escape sequence.
    out.push(renderFenceLine(line))
    return out
  }

  const heading = HEADING.exec(line)
  if (heading !== null) {
    const level = (heading[1] ?? '#').length
    const styles = HEADING_STYLES[Math.min(level, HEADING_STYLES.length) - 1] ?? HEADING_STYLES[0]
    out.push(paint(escapeControls(line.slice(heading[0].length)), ...styles ?? []))
    return out
  }

  if (isRule(line)) {
    out.push(paint('───', 'rule'))
    return out
  }

  const quote = QUOTE.exec(line)
  if (quote !== null) {
    out.push(`${paint('▏', 'quote-bar')} ${paint(renderInline(line.slice(quote[0].length)), 'quote')}`)
    return out
  }

  const bullet = BULLET.exec(line)
  if (bullet !== null) {
    const depth = Math.floor((bullet[1] ?? '').length / INDENT)
    const glyph = BULLETS[Math.min(depth, BULLETS.length - 1)] ?? BULLETS[0]
    out.push(`${' '.repeat(depth * INDENT)}${paint(glyph, 'bullet')} ${renderInline(line.slice(bullet[0].length))}`)
    return out
  }

  const ordered = ORDERED.exec(line)
  if (ordered !== null) {
    const depth = Math.floor((ordered[1] ?? '').length / INDENT)
    const content = renderInline(line.slice(ordered[0].length))
    out.push(`${' '.repeat(depth * INDENT)}${paint(`${ordered[2] ?? ''}.`, 'bullet')} ${content}`)
    return out
  }

  out.push(renderInline(line))
  return out
}
