/** Fixed seed makes every failed direct-addon comparison reproducible. */
export const INITIAL_SEED = 0x71c3a019
/** Negative/zero dimensions exercise the reference's non-positive-width rules. */
export const BUDGETS = Object.freeze([-256, -1, 0, 1, 8, 40, 120, 256])
/** Include both sides of dispatch thresholds and the native UTF-16 admission ceiling. */
export const BOUNDARY_LENGTHS = Object.freeze([0, 1, 2, 23, 24, 63, 64, 65, 95, 96, 191, 192, 511, 512, 513, 2047, 2048])
const ATOMS = ['a', ' ', '\n', '\t', '\0', '\ud800', '\udfff', '中', '😀', '👩‍💻', 'é', '\u001b', '\u001b[0m', '\u001b[31m', '\u001b]unterminated', '\u001b]link\u0007', '\u001b[1:2m']
const RANDOM_ATOM_LIMIT = 80 // Keep random cases small; the explicit matrix covers large inputs.

/**
 * Produce a full width/length boundary matrix followed by balanced random cases.
 * @param {number} count - Number of additional random cases.
 * @returns {Generator<{text: string, budget: number, kind: string, seed: number}>} Reproducible admitted inputs.
 */
export function* soakCases(count) {
  let seed = INITIAL_SEED
  const pick = length => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    // Low LCG bits correlate with variable draw counts; never use them for coverage.
    return (seed >>> 8) % length
  }
  for (const budget of BUDGETS) for (const length of BOUNDARY_LENGTHS) {
    let text = ''
    while (text.length < length) text += ATOMS[pick(ATOMS.length)]
    // Slicing through surrogate pairs is intentional malformed-UTF16 coverage.
    yield { text: text.slice(0, length), budget, kind: 'boundary', seed }
  }
  for (let i = 0; i < count; i++) {
    let text = ''
    const length = pick(RANDOM_ATOM_LIMIT)
    for (let j = 0; j < length; j++) text += ATOMS[pick(ATOMS.length)]
    yield { text, budget: BUDGETS[i % BUDGETS.length], kind: 'random', seed }
  }
}
