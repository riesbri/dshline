/**
 * Terminal display width.
 *
 * Every layout decision in the renderer is a width calculation, and the
 * harness is bilingual — shipped agent presets are named in Chinese and half
 * the documentation is Chinese — so treating a CJK ideograph as one column
 * corrupts every line in the buffer, not just the line holding it. Widths
 * follow Unicode East Asian Width: `W` and `F` occupy two columns, combining
 * marks and format characters occupy none, everything else occupies one.
 *
 * The ranges themselves live in `./width-tables.ts`, generated from the Unicode
 * Character Database by `tools/generate-width-tables.mjs`. They are data, not
 * policy: a terminal draws what its own Unicode release says, so a table that
 * trails the release under-measures code points the terminal widens and shifts
 * every row after them.
 * @module @dshline/renderer/width
 */

import { WIDE_RANGES, ZERO_WIDTH_RANGES } from './width-tables.ts'

/**
 * Whether `code` falls inside one of `ranges`, by binary search. The tables are
 * sorted and non-overlapping, which the width tests assert.
 * @param ranges - sorted inclusive ranges.
 * @param code - the code point to locate.
 * @returns whether a range contains `code`.
 */
function inRanges(ranges: readonly (readonly [number, number])[], code: number): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const range = ranges[mid]
    if (range === undefined) return false
    if (code < range[0]) high = mid - 1
    else if (code > range[1]) low = mid + 1
    else return true
  }
  return false
}

/**
 * Columns one code point occupies.
 * @param code - the code point.
 * @returns 0, 1, or 2 columns.
 */
export function codePointWidth(code: number): number {
  // C0 and C1 controls never reach the terminal through this renderer; callers
  // escape them first, so a stray one is measured as invisible rather than
  // silently shifting the line it appears in.
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  // Printable ASCII occupies one column and appears in neither table, so answer
  // it before the two binary searches. This branch covers only U+0020 through
  // U+007E, so it never captures C0, DEL, or C1 controls; the control branch
  // above remains authoritative for those and must stay first.
  if (code >= 0x20 && code < 0x7f) return 1
  if (inRanges(ZERO_WIDTH_RANGES, code)) return 0
  if (inRanges(WIDE_RANGES, code)) return 2
  return 1
}

/** Matches one CSI or OSC escape sequence, which occupies no columns. */
const ANSI_PATTERN = /\u001b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/gu

/**
 * Strip escape sequences so styled text measures by its visible characters.
 * @param text - possibly styled text.
 * @returns the same text with CSI and OSC sequences removed.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * Columns `text` occupies once rendered, ignoring styling.
 *
 * The same scan the cuts use, for the same reason: `stripAnsi(text)` would copy
 * the whole string just to measure it, and measuring is asked of a lot of text —
 * every row of every box, and every candidate line before it is cut. A scan that
 * carries its own cursor copies nothing, and a bare escape that completes no
 * sequence is still measured as invisible, exactly as stripping left it.
 * @param text - the text to measure.
 * @returns the total column count.
 */
export function displayWidth(text: string): number {
  const scan = new TokenScan(text)
  let total = 0
  while (scan.next()) total += scan.width
  return total
}

/** One unit of a styled string: a zero-width escape, or a visible character. */
interface Token {
  text: string
  width: number
}

/**
 * Whether a zero-width token is an escape sequence rather than a zero-width
 * CHARACTER such as a combining mark, a variation selector, or a ZWJ.
 *
 * The distinction is load-bearing wherever "styling to reopen on the next row"
 * is tracked: an escape is terminal state that must be replayed, while a
 * zero-width character is part of the character it follows and must NOT travel
 * to a continuation row on its own — replayed there it accents the wrong base.
 * @param token - one token from {@link tokenize}.
 * @returns true for an escape sequence.
 */
function isEscape(token: Token): boolean {
  return token.text.startsWith('\u001b')
}

/** An SGR sequence that closes all styling, with or without an explicit zero. */
const RESET_PATTERN = /^\u001b\[0?m$/u

/**
 * One escape sequence, matched AT the cursor rather than searched for.
 *
 * The same grammar as {@link ANSI_PATTERN}, sticky so the scan can ask "is the
 * character here the start of a sequence" once per position instead of collecting
 * every sequence in the string before looking at the first one. `lastIndex` is
 * set immediately before every `exec`, and no two scans interleave — the walk is
 * synchronous and calls nothing that could re-enter it.
 */
const ESCAPE_AT = new RegExp(ANSI_PATTERN.source, 'yu')

/**
 * One step of a styled string, without materializing the string's tokens.
 *
 * A tokenizer that returns a `Token[]` is a decision made before anything is
 * known about how much of the text the caller needs, and every measurement
 * function here was paying for the whole string to answer a question about a
 * prefix of it. This walks the text by index instead, and a caller that stops
 * early never touches the rest of an ordinary line.
 *
 * The cost is BOUNDED, not constant, and the difference is worth stating because
 * a scan is exactly the thing that cannot promise constant time. What a cut pays
 * is the retained prefix, plus whatever it must read to establish where that
 * prefix ends: the zero-width run after the budget belongs to the character
 * before it and is part of the answer, and an escape whose terminator never
 * arrives can only be measured by scanning forward for one. Styled text is full
 * of the first and empty of the second, which is why cutting eighty columns out
 * of a megabyte costs what cutting eighty columns out of a line does; a caller
 * holding an unterminated escape is holding text no terminal can render, and
 * the scan is what proves that.
 *
 * A token's own text is never copied; the caller reads the span it needs through
 * {@link TokenScan.text}, or slices the prefix itself, which is exact because
 * the tokens partition the string in order.
 */
class TokenScan {
  /** Index where the current token starts. */
  start = 0
  /** Index just past the current token. */
  end = 0
  /** Visible columns the current token occupies. */
  width = 0
  /** Whether the current token is an escape rather than a character. */
  escape = false
  /** Index the next token starts at. */
  private index = 0

  /** @param source - the string to walk, which this scan never copies. */
  constructor(private readonly source: string) {}

  /**
   * Advance to the next token.
   * @returns false at the end of the string, leaving the current token as it was.
   */
  next(): boolean {
    const { source } = this
    const at = this.index
    if (at >= source.length) return false
    this.start = at
    if (source.charCodeAt(at) === 0x1b) {
      ESCAPE_AT.lastIndex = at
      const match = ESCAPE_AT.exec(source)
      // A lone escape that completes no sequence is still an escape for the
      // open/closed question — it is what the pattern-based tokenizer produced,
      // because the token's text starts with the escape either way.
      this.end = match === null ? at + 1 : at + match[0].length
      this.width = 0
      this.escape = true
      this.index = this.end
      return true
    }
    // A surrogate pair is one token and one code point, so a supplementary-plane
    // character is never half a token. `codePointAt` reads the pair — or a lone
    // surrogate, exactly as iterating the string does — and the pair test is what
    // decides how many units the token spans.
    const first = source.charCodeAt(at)
    const paired = first >= 0xd800 && first <= 0xdbff
      && source.charCodeAt(at + 1) >= 0xdc00 && source.charCodeAt(at + 1) <= 0xdfff
    this.end = at + (paired ? 2 : 1)
    this.width = codePointWidth(source.codePointAt(at) ?? 0)
    this.escape = false
    this.index = this.end
    return true
  }

  /** @returns the current token's own text. */
  text(): string {
    return this.source.slice(this.start, this.end)
  }

  /**
   * Whether the current token is an escape that closes all styling.
   * @returns true for `\u001b[0m` and `\u001b[m`, and for nothing else.
   */
  closesStyling(): boolean {
    return RESET_PATTERN.test(this.text())
  }
}

/**
 * Split styled text into escape sequences and characters.
 *
 * Measuring and cutting must agree with {@link displayWidth}, which ignores
 * escape sequences — counting `\u001b[90m` as four columns makes every styled
 * line wrap early, and cutting inside a sequence emits a fragment the terminal
 * interprets as garbage.
 *
 * Kept for the two consumers that genuinely need the whole string at once: a
 * wrap walks every token in order and reorders them into rows, and a tail cut
 * starts from the END. Neither can stop early, and both would pay more to be
 * rewritten around a scan than the array costs. Everything that answers a
 * question about a PREFIX uses {@link TokenScan} instead.
 * @param text - possibly styled text.
 * @returns tokens in order; escapes carry width zero.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  ANSI_PATTERN.lastIndex = 0
  for (const match of text.matchAll(ANSI_PATTERN)) {
    const start = match.index
    for (const char of text.slice(index, start)) {
      tokens.push({ text: char, width: codePointWidth(char.codePointAt(0) ?? 0) })
    }
    tokens.push({ text: match[0], width: 0 })
    index = start + match[0].length
  }
  for (const char of text.slice(index)) {
    tokens.push({ text: char, width: codePointWidth(char.codePointAt(0) ?? 0) })
  }
  return tokens
}

/**
 * Longest prefix of `text` that fits `columns`, never splitting a code point,
 * never emitting half of a two-column character, and never cutting inside an
 * escape sequence.
 * @param text - text to cut, styling allowed.
 * @param columns - inclusive column budget.
 * @returns the fitting prefix, empty when the budget is zero or negative.
 */
export function truncateToWidth(text: string, columns: number): string {
  if (columns <= 0) return ''
  const scan = new TokenScan(text)
  let used = 0
  /** Whether the styling seen so far is open rather than closed. */
  let open = false
  while (scan.next()) {
    if (scan.width === 0) {
      // Only an escape changes what is OPEN; a combining mark or ZWJ does not,
      // and treating it as "styling is now open" would append a needless reset.
      //
      // Zero-width tokens are therefore NOT a stopping point, and that is the
      // rule the scan is built around: reaching the budget is not the end of the
      // prefix. Everything zero-width between the last retained character and
      // the first one that does not fit belongs to the output — a combining mark
      // and a variation selector complete the character beside them, and an SGR
      // decides whether a reset is owed. Only a token that would push the total
      // PAST the budget ends the walk, and the first one does.
      if (scan.escape) open = !scan.closesStyling()
      continue
    }
    if (used + scan.width > columns) {
      // The prefix is everything before this token, which is exact because the
      // tokens partition the string: no concatenation is needed, and nothing
      // after this position can change what is retained or whether styling is
      // open.
      const prefix = text.slice(0, scan.start)
      // A cut discards everything after it, INCLUDING the reset that closed the
      // styling — so a truncated coloured row would leave its colour open and
      // the next thing drawn, a gutter or the composer, would inherit it. Closing
      // here rather than at each call site is deliberate: every caller that
      // truncates styled text has the same problem.
      return open ? `${prefix}${RESET}` : prefix
    }
    used += scan.width
  }
  // Nothing was cut, and the tokens partition the string, so the input is the
  // answer — the same bytes, and this time the same object.
  return text
}

/**
 * Longest SUFFIX of `text` that fits `columns`, under the same rules.
 *
 * The twin of {@link truncateToWidth}, for a field whose newest characters are
 * the ones a person is watching: an input line scrolled from the left keeps the
 * cursor in view, while cutting the end hides exactly what was just typed.
 *
 * Intended for text that carries no styling — an input buffer, a query — which
 * is what every caller passes. Zero-width escape sequences inside the kept
 * suffix survive, but styling that OPENED before the cut is not reopened, so a
 * coloured string cut here can lose its colour rather than its content.
 * @param text - text to cut.
 * @param columns - inclusive column budget.
 * @returns the fitting suffix, empty when the budget is zero or negative.
 */
export function tailToWidth(text: string, columns: number): string {
  if (columns <= 0) return ''
  const tokens = tokenize(text)
  let used = 0
  let from = tokens.length
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    if (token === undefined) break
    if (used + token.width > columns) break
    used += token.width
    from = index
  }
  // A cut can land between a base character and the zero-width CHARACTER that
  // belongs to it, leaving an orphaned mark at the head of the suffix. Walk that
  // leading zero-width run: escape sequences are styling state and are retained
  // (an opening SGR may sit between the discarded base and its mark), orphaned
  // zero-width characters are dropped, and the first visible character ends the
  // run. Only a real cut can have orphaned anything.
  if (from > 0) {
    const kept: string[] = []
    let index = from
    while (index < tokens.length) {
      const token = tokens[index]
      if (token === undefined || token.width !== 0) break
      if (isEscape(token)) kept.push(token.text)
      index += 1
    }
    return kept.join('') + tokens.slice(index).map(token => token.text).join('')
  }
  return tokens.slice(from).map(token => token.text).join('')
}

/**
 * Break text into rows at exactly `columns`, never at a word boundary.
 *
 * The property this has and {@link wrapToWidth} does not: chunking is
 * PREFIX-CONSISTENT. The rows for the first half of a string are the first rows for
 * the whole string, because no later character can move an earlier break. Word
 * wrapping breaks that — appending to a word can pull the whole word onto the next
 * row — so anything that must locate a position inside wrapped text, a cursor above
 * all, cannot be computed from a word-wrapped layout without mapping offsets
 * through it.
 *
 * That makes this the right rule for an input field, which is also how a terminal's
 * own line editing behaves: the row break falls where the screen runs out, and the
 * column a character was typed in is the column it appears in.
 * @param text - text to break, styling allowed; may contain newlines.
 * @param columns - column budget per row, values below 1 are treated as 1.
 * @returns the rows, never empty.
 */
export function chunkToWidth(text: string, columns: number): string[] {
  const budget = Math.max(1, columns)
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let row = ''
    let used = 0
    /** Every escape seen so far, replayed so a break does not lose styling. */
    let open = ''
    const scan = new TokenScan(paragraph)
    while (scan.next()) {
      if (scan.width === 0) {
        // A break may not orphan a zero-width CHARACTER: a combining mark stays
        // with the base it follows, so only escape sequences join the set that
        // is replayed onto the next row.
        if (scan.escape) open = scan.closesStyling() ? '' : open + scan.text()
        row += scan.text()
        continue
      }
      if (used + scan.width > budget) {
        out.push(open === '' ? row : `${row}${RESET}`)
        row = open
        used = 0
      }
      row += scan.text()
      used += scan.width
    }
    out.push(open === '' ? row : `${row}${RESET}`)
  }
  return out
}

/**
 * Wrap text to `columns`, breaking at spaces where one exists in the line and
 * mid-character otherwise, which is how CJK runs without spaces wrap.
 *
 * Styling that is open at a break is closed and reopened, so a wrapped line does
 * not lose its color on the continuation rows.
 * @param text - text to wrap, styling allowed; may contain newlines.
 * @param columns - column budget per line, values below 1 are treated as 1.
 * @returns the wrapped lines, never empty.
 */
export function wrapToWidth(text: string, columns: number): string[] {
  const budget = Math.max(1, columns)
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    const tokens = tokenize(paragraph)
    if (tokens.length === 0) {
      out.push('')
      continue
    }
    let row: Token[] = []
    let used = 0
    /** Every escape seen so far, replayed to reopen styling on the next row. */
    let open = ''
    /** Styling carried into the current row from a previous break. */
    let prefix = ''
    /** Token index of the last space in this row, or -1 for a flush break. */
    let lastSpace = -1
    /** Whether this paragraph has already been broken at least once. */
    let broken = false
    const rowText = (cells: readonly Token[]): string => cells.map(cell => cell.text).join('')
    const rowWidth = (cells: readonly Token[]): number => cells.reduce((total, cell) => total + cell.width, 0)
    const emit = (upTo: number): void => {
      const head = upTo < 0 ? row : row.slice(0, upTo)
      // The space the break happened at belongs to neither row.
      const rest = upTo < 0 ? [] : row.slice(row[upTo]?.text === ' ' ? upTo + 1 : upTo)
      out.push(open === '' ? `${prefix}${rowText(head)}` : `${prefix}${rowText(head)}${RESET}`)
      broken = true
      prefix = open
      row = rest
      used = rowWidth(rest)
      lastSpace = -1
    }
    for (const token of tokens) {
      if (token.width === 0) {
        // Only an escape changes what is replayed on the next row, and a full
        // reset ends whatever it opened. A zero-width CHARACTER — a combining
        // mark, a variation selector, a ZWJ — belongs to the base beside it and
        // must not travel. Merely appending every zero-width token would both
        // orphan those marks and make `open` a log of EVERY escape the paragraph
        // carried, so each continuation row replayed all of them: O(escapes x
        // rows) bytes and time on one long styled line.
        if (isEscape(token)) open = RESET_PATTERN.test(token.text) ? '' : open + token.text
        row.push(token)
        continue
      }
      if (used + token.width > budget) {
        // A single character too wide for the whole budget is emitted anyway, so
        // a narrow terminal still makes progress instead of looping.
        if (used === 0) {
          row.push(token)
          emit(-1)
          continue
        }
        emit(lastSpace)
      }
      // A continuation row never starts with a space: the break consumed one, and
      // a row beginning with one would break again at column zero forever. Leading
      // spaces on the FIRST row are deliberate indentation and must survive.
      if (token.text === ' ' && used === 0 && broken) continue
      if (token.text === ' ') lastSpace = row.length
      row.push(token)
      used += token.width
    }
    // What remains may be only reopened styling when a break landed exactly on
    // the budget, which is not a row.
    if (rowWidth(row) > 0 || out.length === 0) {
      out.push(open === '' ? `${prefix}${rowText(row)}` : `${prefix}${rowText(row)}${RESET}`)
    }
  }
  return out.length === 0 ? [''] : out
}

/** Visible columns of already-tokenized text. */
function measure(text: string): number {
  let total = 0
  for (const token of tokenize(text)) total += token.width
  return total
}

/** Ends any styling left open when a line is broken. */
const RESET = '\u001b[0m'

/**
 * Lay out text under a gutter mark, indenting every wrapped row to match.
 *
 * The reason this is not just {@link wrapToWidth}: a marked line is a mark
 * followed by content, so its wrapped rows have no leading whitespace to preserve
 * and land back at column zero. A paragraph of model prose is one long logical
 * line, so without this every reply after its first row loses the gutter it reads
 * under.
 * @param mark - the gutter for the first row, including its trailing space.
 * @param indent - the gutter for continuation rows, the same display width.
 * @param text - the content, which may carry styling and newlines.
 * @param columns - the terminal's width.
 * @returns rows that already fit, so nothing wraps them again.
 */
export function hangingIndent(mark: string, indent: string, text: string, columns: number): string[] {
  // The wrap budget is SHARED by the first row (which carries `mark`) and the
  // continuation rows (which carry `indent`). Reserving only `indent` let a
  // wider `mark` push the first row past the terminal, breaking this function's
  // own promise that its rows need no further wrapping.
  const reserve = Math.max(displayWidth(mark), displayWidth(indent))
  const budget = Math.max(1, columns - reserve)
  return wrapToWidth(text, budget).map((row, index) => {
    const line = `${index === 0 ? mark : indent}${row}`
    // A gutter at least as wide as the terminal leaves no content column at all,
    // so the promise above can only be kept by cutting. This is the one case
    // where the mark itself is what overflows.
    return displayWidth(line) <= columns ? line : truncateToWidth(line, columns)
  })
}
