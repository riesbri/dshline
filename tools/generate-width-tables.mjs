/**
 * Generate the committed Unicode width tables from pinned UCD data files.
 *
 * The renderer must not gain a dependency, so the data is INLINED as source
 * rather than imported at runtime. This dev-only script is the one owner of the
 * fact those tables encode: it fetches the exact Unicode Character Database
 * files for one release, verifies their bytes against the hashes recorded here,
 * and rewrites two generated source files. A hand edit to either generated file
 * is therefore a diff that regenerating would erase, which is what keeps the
 * table's Unicode release and its content from drifting apart.
 *
 * `EastAsianWidth.txt` supplies W/F (two columns). `DerivedGeneralCategory.txt`
 * supplies Mn/Me and the Cf candidate set. `emoji/emoji-data.txt` supplies the
 * emoji properties a terminal may draw as a two-column picture even when the
 * East Asian Width property says otherwise, so the presentation layer knows
 * which narrow-looking code points are still unsafe in width-critical chrome.
 *
 * General_Category describes character semantics, not a terminal `wcwidth`
 * function, so the zero-width table is Mn/Me plus an explicit allowlist:
 * `ZERO_WIDTH_FORMAT_RANGES`, below. Every other format character is measured
 * one cell — the over-measuring direction, which cannot under-count a row — and
 * the presentation layer projects it from a width-critical label.
 *
 * Run with `pnpm generate-width-tables`. It needs the network; the generated
 * files are committed, so a normal build and test never does.
 * @module tools/generate-width-tables
 */

import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const UNICODE_VERSION = '17.0.0'
const BASE = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`

/**
 * The exact inputs, each pinned to the bytes it had when the committed tables
 * were generated. A checksum mismatch fails the run rather than silently
 * producing tables from a different UCD revision.
 */
const INPUTS = [
  { name: 'EastAsianWidth.txt', sha256: 'ea7ce50f3444a050333448dffef1cadd9325af55cbb764b4a2280faf52170a33', url: `${BASE}/EastAsianWidth.txt` },
  { name: 'DerivedGeneralCategory.txt', sha256: 'd62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e', url: `${BASE}/extracted/DerivedGeneralCategory.txt` },
  { name: 'emoji-data.txt', sha256: '2cb2bb9455cda83e8481541ecf5b6dfda66a3bb89efa3fa7c5297eccf607b72b', url: `${BASE}/emoji/emoji-data.txt` },
]

/**
 * General_Category Cf ranges this renderer treats as zero-width: the explicit
 * terminal-width policy for format characters.
 *
 * The list is POSITIVE rather than "all of Cf". A future Unicode release may
 * assign a Cf code point this policy has never seen, and an unlisted character
 * must fall back to one measured cell (the safe, over-counting direction) and
 * to projection in a width-critical label, never to a zero nobody chose.
 *
 * Every range here is a control a terminal does not advance for: bidirectional
 * controls and isolates, the zero-width space and the joiners (handled
 * separately where they join a sequence), the word joiner and invisible
 * operators, the interlinear annotation and other format controls real
 * terminals ignore, and the tag block, which is invisible by design. The
 * evidence is the tables and policy comments in xterm's `wcwidth.c` and GLib's
 * `g_unichar_iszerowidth`, both of which advance no cell for these.
 *
 * Deliberately ABSENT, and therefore measured one cell:
 * - U+00AD SOFT HYPHEN. GLib returns non-zero-width for it and xterm switches
 *   its width on a Latin-1/Unicode mode flag; a zero the terminal does not
 *   honor under-measures a row, so the renderer takes the non-zero default and
 *   the label projects it.
 * - U+0600..U+0605, U+06DD, U+070F, U+0890..U+0891, U+08E2, U+110BD, U+110CD.
 *   Prepended and spanning marks that attach to following text, so their own
 *   advance is sequence-dependent; the renderer takes the over-measuring
 *   default and the label projects them.
 * - U+2028..U+2029. Line and paragraph separators: they can start a physical
 *   row, which no horizontal width models, so they are measured one cell and
 *   projected from a width-critical label.
 */
const ZERO_WIDTH_FORMAT_RANGES = [
  [0x061c, 0x061c], // ARABIC LETTER MARK
  [0x180e, 0x180e], // MONGOLIAN VOWEL SEPARATOR
  [0x200b, 0x200f], // ZERO WIDTH SPACE .. RIGHT-TO-LEFT MARK
  [0x202a, 0x202e], // bidirectional embeddings and overrides
  [0x2060, 0x2064], // WORD JOINER .. INVISIBLE PLUS
  [0x2066, 0x206f], // bidirectional isolates and deprecated format controls
  [0xfeff, 0xfeff], // ZERO WIDTH NO-BREAK SPACE
  [0xfff9, 0xfffb], // INTERLINEAR ANNOTATION controls
  [0x13430, 0x1343f], // Egyptian hieroglyph format controls
  [0x1bca0, 0x1bca3], // shorthand format controls
  [0x1d173, 0x1d17a], // musical symbol format controls
  [0xe0001, 0xe0001], // LANGUAGE TAG
  [0xe0020, 0xe007f], // tag characters
]

/**
 * The code points in `ranges`, as a set.
 * @param ranges - inclusive `[start, end]` pairs.
 * @returns every code point the ranges cover.
 */
function expandRanges(ranges) {
  const set = new Set()
  for (const [start, end] of ranges) {
    for (let code = start; code <= end; code += 1) set.add(code)
  }
  return set
}

/** Code points reserved for UTF-16 surrogate pairs, never valid characters. */
const SURROGATE_START = 0xd800
const SURROGATE_END = 0xdfff
const MAX_CODE_POINT = 0x10ffff

/**
 * Whether `code` is a surrogate that no character can hold.
 * @param code - a code point.
 * @returns true inside the surrogate block.
 */
function isSurrogate(code) {
  return code >= SURROGATE_START && code <= SURROGATE_END
}

/**
 * Parse one UCD data file into `[start, end, property]` records.
 *
 * The files share the `range ; value # comment` shape. Property names are kept
 * verbatim; the caller selects the ones it needs.
 * @param text - the file's contents.
 * @returns every listed range with its property.
 */
function parseUcd(text) {
  const records = []
  for (const raw of text.split('\n')) {
    const line = (raw.split('#')[0] ?? '').trim()
    if (line === '') continue
    const [rangePart, valuePart] = line.split(';')
    if (rangePart === undefined || valuePart === undefined) continue
    const [startText, endText = startText] = rangePart.trim().split('..')
    records.push({
      start: Number.parseInt(startText, 16),
      end: Number.parseInt(endText, 16),
      value: valuePart.trim(),
    })
  }
  return records
}

/**
 * Expand records whose property one of `wanted` into a set of code points.
 * @param records - parsed UCD records.
 * @param wanted - the property values to collect.
 * @returns the selected code points.
 */
function collect(records, wanted) {
  const set = new Set()
  for (const { start, end, value } of records) {
    if (!wanted.has(value)) continue
    for (let code = start; code <= end; code += 1) {
      if (!isSurrogate(code)) set.add(code)
    }
  }
  return set
}

/**
 * Collapse a code-point set into sorted, merged, inclusive ranges.
 * @param points - the code points.
 * @returns merged ranges, each `[start, end]`.
 */
function toRanges(points) {
  const sorted = [...points].sort((a, b) => a - b)
  const ranges = []
  for (const code of sorted) {
    const last = ranges.at(-1)
    if (last !== undefined && code === last[1] + 1) last[1] = code
    else ranges.push([code, code])
  }
  return ranges
}

/**
 * Render a range array as a TypeScript literal.
 * @param ranges - inclusive ranges.
 * @param indent - leading whitespace for each entry.
 * @returns the literal body, newline-terminated.
 */
function emitRanges(ranges, indent = '  ') {
  return ranges.map(([start, end]) => `${indent}[0x${start.toString(16)}, 0x${end.toString(16)}],`).join('\n')
}

/**
 * Fetch and verify one pinned input.
 * @param input - the input's name, URL, and expected SHA-256.
 * @returns the file's text.
 */
async function fetchPinned(input) {
  const response = await fetch(input.url)
  if (!response.ok) throw new Error(`${input.name}: HTTP ${String(response.status)}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== input.sha256) {
    throw new Error(`${input.name}: expected sha256 ${input.sha256}, got ${digest}`)
  }
  return bytes.toString('utf8')
}

/**
 * The shared provenance header a generated table file carries.
 * @param what - one line naming what the file holds.
 * @returns the file's comment block.
 */
function header(what) {
  const hashes = INPUTS.map(input => ` * - ${input.name} ${input.sha256}`).join('\n')
  return `/**
 * ${what}
 *
 * Generated from the Unicode Character Database ${UNICODE_VERSION} by
 * tools/generate-width-tables.mjs. Do not edit by hand: re-run
 * \`pnpm generate-width-tables\` and review the diff instead.
 *
 * Pinned input files:
${hashes}
 *
 * Unicode data is copyright © Unicode, Inc.; see https://www.unicode.org/license.txt.
 */
`
}

const eastAsian = parseUcd(await fetchPinned(INPUTS[0]))
const generalCategory = parseUcd(await fetchPinned(INPUTS[1]))
const emojiData = parseUcd(await fetchPinned(INPUTS[2]))

const wide = toRanges(collect(eastAsian, new Set(['W', 'F'])))
// Mn and Me are nonspacing/enclosing marks, which a terminal never advances
// for. The format controls are the explicit allowlist above, not all of Cf:
// General_Category is semantics, and a false zero lets a terminal draw a row
// wider than the renderer modeled.
const zero = toRanges(new Set([
  ...collect(generalCategory, new Set(['Mn', 'Me'])),
  ...expandRanges(ZERO_WIDTH_FORMAT_RANGES),
]))
const zeroFormat = expandRanges(ZERO_WIDTH_FORMAT_RANGES)
// The presentation layer's unsafe set: everything whose drawn width a terminal
// may not match a narrow measurement. W/F joins it so a stale renderer table
// still projects rather than under-measures; A is the genuinely ambiguous set;
// the emoji properties cover sequences no per-code-point width rule can see;
// the format characters outside the allowlist are projected even though the
// renderer measures them one; and the line and paragraph separators can start
// a physical row that no horizontal width models.
const unsafePoints = new Set()
for (const code of collect(eastAsian, new Set(['A', 'W', 'F']))) if (code >= 0x80) unsafePoints.add(code)
for (const code of collect(emojiData, new Set(['Emoji', 'Emoji_Presentation', 'Emoji_Modifier', 'Regional_Indicator', 'Extended_Pictographic']))) {
  if (code >= 0x80) unsafePoints.add(code)
}
for (const code of collect(generalCategory, new Set(['Cf']))) {
  if (code >= 0x80 && !zeroFormat.has(code)) unsafePoints.add(code)
}
unsafePoints.add(0x2028)
unsafePoints.add(0x2029)
const unsafe = toRanges(unsafePoints)

const rendererPath = join(root, 'packages', 'renderer', 'src', 'width-tables.ts')
const dshlinePath = join(root, 'packages', 'dshline', 'src', 'width-stable-tables.ts')

const rendererSource = `${header('Unicode code-point ranges for terminal display width.')}
/** Inclusive code-point ranges a terminal advances two cells for (East_Asian_Width W or F). */
export const WIDE_RANGES: readonly (readonly [number, number])[] = [
${emitRanges(wide)}
]

/** Inclusive code-point ranges a terminal advances no cell for: General_Category Mn and Me, plus the explicit format-control allowlist. */
export const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
${emitRanges(zero)}
]
`

const dshlineSource = `${header('Code points a width-critical terminal label cannot carry unchanged.')}
/**
 * Inclusive code-point ranges whose drawn width is not guaranteed to match a
 * narrow per-code-point measurement: East_Asian_Width A (which a terminal may
 * widen), W/F (safe only once the renderer measures them two), the emoji
 * properties (whose sequences a terminal may draw as one picture), the format
 * characters outside the renderer's explicit zero-width allowlist (whose
 * advance is sequence-dependent or disputed), and the line and paragraph
 * separators (which can start a physical row). The presentation layer projects
 * a code point in this set rather than trust that its cell count matches the
 * terminal's.
 */
export const LABEL_UNSAFE_RANGES: readonly (readonly [number, number])[] = [
${emitRanges(unsafe)}
]
`

await writeFile(rendererPath, rendererSource)
await writeFile(dshlinePath, dshlineSource)
process.stdout.write(
  `generate-width-tables: Unicode ${UNICODE_VERSION}`
  + ` (${String(wide.length)} wide, ${String(zero.length)} zero, ${String(unsafe.length)} unsafe ranges)\n`,
)
