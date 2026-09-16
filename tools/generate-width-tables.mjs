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
 * supplies Mn/Me/Cf/Zl/Zp (no columns). `emoji/emoji-data.txt` supplies the
 * emoji properties a terminal may draw as a two-column picture even when the
 * East Asian Width property says otherwise, so the presentation layer knows
 * which narrow-looking code points are still unsafe in width-critical chrome.
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
const UNICODE_VERSION = '16.0.0'
const BASE = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`

/**
 * The exact inputs, each pinned to the bytes it had when the committed tables
 * were generated. A checksum mismatch fails the run rather than silently
 * producing tables from a different UCD revision.
 */
const INPUTS = [
  { name: 'EastAsianWidth.txt', sha256: '43adc76c0686a42cb370764eb8cfe2b2a45b10b855e5572a2db4a0eecce15d5b', url: `${BASE}/EastAsianWidth.txt` },
  { name: 'DerivedGeneralCategory.txt', sha256: '7676ab755a41ef82108460238569e60ad65c191ddafe61b36c6765ec1353f293', url: `${BASE}/extracted/DerivedGeneralCategory.txt` },
  { name: 'emoji-data.txt', sha256: 'f1365a5173eee18e1f98b240cdc492e84a25f1ce7e0c9d1094eb29c41a22696a', url: `${BASE}/emoji/emoji-data.txt` },
]

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
// Mn and Me are nonspacing/enclosing marks; Cf is a format character; Zl/Zp are
// the line and paragraph separators. Terminals advance no cell for any of them,
// and the renderer must not either or a combining mark shifts the row it sits on.
const zero = toRanges(collect(generalCategory, new Set(['Mn', 'Me', 'Cf', 'Zl', 'Zp'])))
// The presentation layer's unsafe set: everything whose drawn width a terminal
// may not match a narrow measurement. W/F joins it so a stale renderer table
// still projects rather than under-measures; A is the genuinely ambiguous set;
// the emoji properties cover sequences no per-code-point width rule can see.
const unsafePoints = new Set()
for (const code of collect(eastAsian, new Set(['A', 'W', 'F']))) if (code >= 0x80) unsafePoints.add(code)
for (const code of collect(emojiData, new Set(['Emoji', 'Emoji_Presentation', 'Emoji_Modifier', 'Regional_Indicator', 'Extended_Pictographic']))) {
  if (code >= 0x80) unsafePoints.add(code)
}
const unsafe = toRanges(unsafePoints)

const rendererPath = join(root, 'packages', 'renderer', 'src', 'width-tables.ts')
const dshlinePath = join(root, 'packages', 'dshline', 'src', 'width-stable-tables.ts')

const rendererSource = `${header('Unicode code-point ranges for terminal display width.')}
/** Inclusive code-point ranges a terminal advances two cells for (East_Asian_Width W or F). */
export const WIDE_RANGES: readonly (readonly [number, number])[] = [
${emitRanges(wide)}
]

/** Inclusive code-point ranges a terminal advances no cell for (General_Category Mn, Me, Cf, Zl, Zp). */
export const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
${emitRanges(zero)}
]
`

const dshlineSource = `${header('Code points a width-critical terminal label cannot carry unchanged.')}
/**
 * Inclusive code-point ranges whose drawn width is not guaranteed to equal a
 * narrow per-code-point measurement: East_Asian_Width A (which a terminal may
 * widen), W/F (safe only once the renderer measures them two), and the emoji
 * properties (whose sequences a terminal may draw as one picture). The
 * presentation layer projects a width-one code point in this set rather than
 * trust that its cell count matches the terminal's.
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
