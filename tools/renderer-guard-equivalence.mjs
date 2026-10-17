/** Frozen guard oracle from reviewed 25a2501; never update it with the candidate. */
const NON_ASCII = /[^\x00-\x7f]/u
/** Replay the exact pre-fix decision, including raw below-threshold labels.
 * @param op - Leaf name. @param source - Text. @param columns - Budget.
 * @returns The pre-fix guard name, or undefined.
 */
export function legacyGuard(op, source, columns = 0) {
    // Do not replace the existing thresholds. These additional exclusions keep
    // the measured losing families on TS, including ANSI-encoded ASCII text.
    if (op === 'displayWidth') {
        // The long sparse-Unicode regression is a late suffix. Do not add a full
        // JS scan to ordinary long ASCII just to decide whether Rust may scan it.
        if (source.length > 512 && source.charCodeAt(source.length - 1) < 128 && source.charCodeAt(source.length - 2) < 128)
            return undefined;
        // A greedy whole-string dominance expression backtracks over long ASCII
        // and costs more than the leaf itself. A first-non-ASCII search avoids that.
        const first = source.search(NON_ASCII);
        if (first < 0)
            return source.length <= 512 ? 'ascii-short-width' : undefined;
        const head = source.charCodeAt(first), next = source.charCodeAt(first + 1);
        const units = head >= 0xd800 && head <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
        if (!NON_ASCII.test(source.slice(first + units)))
            return 'ascii-dominant-width';
    }
    if (op === 'tailToWidth' && source.length >= 512 && !NON_ASCII.test(source))
        return 'ascii-tail';
    if (op === 'chunkToWidth' && !NON_ASCII.test(source))
        return 'ascii-chunk';
    if (op === 'wrapToWidth' && (source.length <= 512 || columns >= 256 || source.includes('\x1b')) && !NON_ASCII.test(source))
        return 'ascii-wrap';
    return undefined;
}

const GUARDED_OPS = ['displayWidth', 'tailToWidth', 'chunkToWidth', 'wrapToWidth', 'fitToWidth']
function compare(actual, text, columns, ops) {
  for (const op of ops) {
    const expected = legacyGuard(op, text, columns), value = actual(op, text, columns)
    if (value !== expected) throw Error(JSON.stringify({ op, text, columns, expected, actual: value }))
  }
  return ops.length
}
/** Cross every code point (including surrogate units) with raw guard families.
 * @param actual - Candidate guard. @param start - Inclusive code point.
 * @param end - Inclusive code point. @returns Observed comparison count.
 */
export function compareCodePoints(actual, start, end) {
  let comparisons = 0
  for (let code = start; code <= end; code++) {
    const point = String.fromCodePoint(code)
    for (const text of [point, 'a' + point + 'a', '\x1b[32m' + point + '\x1b[0m']) comparisons += compare(actual, text, 80, GUARDED_OPS)
  }
  return comparisons
}
/** Cross positional UTF-16/ANSI edge cases with old width/column boundaries.
 * @param actual - Candidate guard. @returns Observed coverage, not inferred totals.
 */
export function compareBoundaries(actual) {
  const lengths = [0, 1, 2, 3, 63, 64, 65, 511, 512, 513, 2047, 2048, 2049]
  const columns = [-257, -256, -1, 0, 1, 31, 32, 33, 63, 64, 65, 255, 256, 257]
  const tokens = ['\0', '\x7f', '\x80', '中', '😀', '\ud800', '\udc00', '\ud800x', '\udc00\ud800', '\ud800\ud800', '\udc00\udc00', '\x1b[32m', '\x1b]8;;x\x07', '\r\n']
  const ops = [...GUARDED_OPS, 'stripAnsi', 'truncateToWidth', 'escapeControls', 'sanitizePasted']
  let comparisons = 0, texts = 0
  const byLength = {}, byColumn = {}, guards = {}
  for (const length of lengths) {
    const base = 'a'.repeat(length), corpus = new Set([base])
    for (const token of tokens) for (const offset of new Set([0, Math.min(1, length), Math.floor(length / 2), Math.max(0, length - 2), Math.max(0, length - 1)])) {
      corpus.add(base.slice(0, offset) + token.slice(0, length - offset) + base.slice(offset + token.length))
    }
    if (length >= 3) corpus.add('a中' + 'a'.repeat(length - 3) + '中')
    for (const text of corpus) {
      texts++; byLength[length] = (byLength[length] ?? 0) + 1
      for (const budget of columns) {
        comparisons += compare(actual, text, budget, ops)
        byColumn[budget] = (byColumn[budget] ?? 0) + ops.length
        for (const op of ops) { const name = actual(op, text, budget) ?? 'admitted'; guards[name] = (guards[name] ?? 0) + 1 }
      }
    }
  }
  return { comparisons, texts, byLength, byColumn, guards }
}
