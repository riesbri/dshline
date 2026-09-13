/**
 * Terminal display width.
 *
 * Every layout decision in the renderer is a width calculation, and the
 * harness is bilingual — shipped agent presets are named in Chinese and half
 * the documentation is Chinese — so treating a CJK ideograph as one column
 * corrupts every line in the buffer, not just the line holding it. Widths
 * follow Unicode East Asian Width: `W` and `F` occupy two columns, combining
 * marks and format characters occupy none, everything else occupies one.
 * @module @dshline/renderer/width
 */

/** Inclusive code-point ranges rendered two columns wide. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK Radicals Supplement .. CJK Symbols and Punctuation
  [0x3041, 0x33ff], // Hiragana .. CJK Compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables and Radicals
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical Forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms .. Small Form Variants
  [0xff00, 0xff60], // Fullwidth ASCII variants
  [0xffe0, 0xffe6], // Fullwidth currency and bracket signs
  [0x16fe0, 0x16fe4], // Tangut and Nushu marks
  [0x17000, 0x18aff], // Tangut .. Khitan Small Script
  [0x1b000, 0x1b16f], // Kana Supplement .. Small Kana Extension
  [0x1f004, 0x1f004], // Mahjong tile red dragon
  [0x1f0cf, 0x1f0cf], // Playing card black joker
  [0x1f18e, 0x1f18e], // Negative squared AB
  [0x1f191, 0x1f19a], // Squared CL .. squared VS
  [0x1f200, 0x1f320], // Enclosed Ideographic Supplement .. shooting star
  [0x1f32d, 0x1f335], // Hot dog .. cactus
  [0x1f337, 0x1f37c], // Tulip .. baby bottle
  [0x1f37e, 0x1f393], // Bottle with popping cork .. graduation cap
  [0x1f3a0, 0x1f3ca], // Carousel horse .. swimmer
  [0x1f3cf, 0x1f3d3], // Cricket bat .. table tennis
  [0x1f3e0, 0x1f3f0], // House .. european castle
  [0x1f3f4, 0x1f3f4], // Waving black flag
  [0x1f3f8, 0x1f43e], // Badminton .. paw prints
  [0x1f440, 0x1f440], // Eyes
  [0x1f442, 0x1f4fc], // Ear .. videocassette
  [0x1f4ff, 0x1f53d], // Prayer beads .. down-pointing small red triangle
  [0x1f54b, 0x1f54e], // Kaaba .. menorah
  [0x1f550, 0x1f567], // Clock faces
  [0x1f57a, 0x1f57a], // Man dancing
  [0x1f595, 0x1f596], // Reversed hand gestures
  [0x1f5a4, 0x1f5a4], // Black heart
  [0x1f5fb, 0x1f64f], // Mount fuji .. person with folded hands
  [0x1f680, 0x1f6c5], // Rocket .. left luggage
  [0x1f6cc, 0x1f6cc], // Person in bed
  [0x1f6d0, 0x1f6d2], // Place of worship .. shopping trolley
  [0x1f6eb, 0x1f6ec], // Airplane departure and arrival
  [0x1f6f4, 0x1f6fc], // Scooter .. roller skate
  [0x1f7e0, 0x1f7eb], // Large coloured circles and squares
  [0x1f90c, 0x1f9ff], // Pinched fingers .. nazar amulet
  [0x1fa70, 0x1faff], // Ballet shoes .. symbols
  [0x20000, 0x2fffd], // CJK Unified Ideographs Extension B and beyond
  [0x30000, 0x3fffd], // CJK Unified Ideographs Extension G and beyond
]

/** Inclusive code-point ranges that advance the cursor not at all. */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x0483, 0x0489], // Cyrillic combining marks
  [0x0591, 0x05bd], // Hebrew points
  [0x0610, 0x061a], // Arabic marks
  [0x064b, 0x065f], // Arabic vowel signs
  [0x0670, 0x0670], // Arabic superscript alef
  [0x06d6, 0x06dc], // Arabic small high marks
  [0x0e31, 0x0e31], // Thai vowel sign mai han akat
  [0x0e34, 0x0e3a], // Thai above/below vowels
  [0x0e47, 0x0e4e], // Thai tone marks
  [0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
  [0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
  [0x200b, 0x200f], // Zero-width space .. right-to-left mark
  [0x2028, 0x202e], // Line/paragraph separators and bidi overrides
  [0x2060, 0x2064], // Word joiner .. invisible plus
  [0x20d0, 0x20f0], // Combining Diacritical Marks for Symbols
  [0xfe00, 0xfe0f], // Variation selectors
  [0xfe20, 0xfe2f], // Combining Half Marks
  [0xfeff, 0xfeff], // Zero-width no-break space
  [0xe0100, 0xe01ef], // Variation Selectors Supplement
]

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
 * @param text - the text to measure.
 * @returns the total column count.
 */
export function displayWidth(text: string): number {
  let total = 0
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0)
    if (code !== undefined) total += codePointWidth(code)
  }
  return total
}

/**
 * Replace code points whose width a terminal might disagree with dshline about.
 *
 * `displayWidth` follows East Asian Width with Ambiguous code points measured
 * narrow. A terminal in ambiguous-width mode draws them two columns wide, so
 * untrusted text carrying one and placed into width-critical chrome — the
 * composer's frame label above all — makes the measured row shorter than the
 * drawn one, and the border wraps a physical row the redraw arithmetic never
 * counts; the stale border then survives every erase.
 *
 * The alternative, treating every East Asian Ambiguous code point as two
 * columns globally, would move geometry for every terminal that keeps them
 * narrow and for the box drawing and punctuation the chrome cannot give up.
 * Narrowing the replacement to the genuine Ambiguous set is not sufficient
 * either: `WIDE_RANGES` trails the current Unicode release, so code points a
 * terminal is entitled to draw wide (U+231A, U+2630, U+4DC0, …) are measured
 * one here, and a text-default emoji widened by VS16 is not Ambiguous at all.
 * An exact unstable set would have to regenerate the wide table and model emoji
 * presentation — a Unicode-width subsystem, not a label fix.
 *
 * So the predicate is deliberately the conservative one: a visible non-ASCII
 * code point that is neither already wide nor zero-width is replaced, whether
 * or not it is genuinely Ambiguous. That is self-healing — anything the model
 * might mis-measure is projected — at the cost of replacing stable narrow
 * scripts (Hebrew, Arabic, Indic, …) too. The projection is therefore LOSSY and
 * not injective; identity survives because the committed banner prints the
 * full, unprojected workspace name, and the composer frame's right title is the
 * only consumer. Wide CJK and kana are kept because terminals agree on their
 * width; ASCII is kept because it is never ambiguous.
 * @param text - possibly styled text.
 * @param placeholder - the width-stable character substituted one for one.
 * @returns the text with width-unstable code points replaced.
 */
export function widthStable(text: string, placeholder = '?'): string {
  let out = ''
  for (const token of tokenize(text)) {
    if (isEscape(token)) {
      out += token.text
      continue
    }
    const code = token.text.codePointAt(0) ?? 0
    out += codePointWidth(code) === 1 && code >= 0x80 ? placeholder : token.text
  }
  return out
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
 * Split styled text into escape sequences and characters.
 *
 * Measuring and cutting must agree with {@link displayWidth}, which ignores
 * escape sequences — counting `\u001b[90m` as four columns makes every styled
 * line wrap early, and cutting inside a sequence emits a fragment the terminal
 * interprets as garbage.
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
  let used = 0
  let out = ''
  /** Whether the last escape emitted opened styling rather than closing it. */
  let open = false
  let cut = false
  for (const token of tokenize(text)) {
    if (token.width === 0) {
      // Only an escape changes what is OPEN; a combining mark or ZWJ does not,
      // and treating it as "styling is now open" would append a needless reset.
      if (isEscape(token)) open = !RESET_PATTERN.test(token.text)
      out += token.text
      continue
    }
    if (used + token.width > columns) {
      cut = true
      break
    }
    used += token.width
    out += token.text
  }
  // A cut discards everything after it, INCLUDING the reset that closed the
  // styling — so a truncated coloured row would leave its colour open and the
  // next thing drawn, a gutter or the composer, would inherit it. Closing here
  // rather than at each call site is deliberate: every caller that truncates
  // styled text has the same problem.
  return cut && open ? `${out}${RESET}` : out
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
  // A cut can land between a base character and the zero-width mark that
  // belongs to it, leaving the mark as the suffix's first token. A mark with no
  // base combines with whatever follows it instead of what preceded it, so it is
  // dropped rather than shown attached to the wrong character.
  while (from < tokens.length && tokens[from]?.width === 0) from += 1
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
    for (const token of tokenize(paragraph)) {
      if (token.width === 0) {
        // A break may not orphan a zero-width CHARACTER: a combining mark stays
        // with the base it follows, so only escape sequences join the set that
        // is replayed onto the next row.
        if (isEscape(token)) open = RESET_PATTERN.test(token.text) ? '' : open + token.text
        row += token.text
        continue
      }
      if (used + token.width > budget) {
        out.push(open === '' ? row : `${row}${RESET}`)
        row = open
        used = 0
      }
      row += token.text
      used += token.width
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
