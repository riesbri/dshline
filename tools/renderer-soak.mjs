/** Deterministic direct-FFI differential soak; cannot pass via auto fallback. */
import { deepStrictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as width from '../packages/renderer/lib/width.js'
import * as text from '../packages/renderer/lib/text.js'
import * as box from '../packages/renderer/lib/box.js'
const count = Number(process.argv[2] ?? 10000)
if (process.argv.length > 3 || !Number.isInteger(count) || count < 1 || count > 1000000) throw Error('usage: node tools/renderer-soak.mjs [iterations 1..1000000]')
const addonFile = new URL(`../packages/renderer/native/${process.platform}-${process.arch}.node`, import.meta.url)
const addon = createRequire(import.meta.url)(addonFile.pathname)
const reference = { ...width, ...text, ...box }
let seed = 0x71c3a019, comparisons = 0
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
const atoms = ['a', ' ', '\n', '\t', '\0', '\ud800', '\udfff', '中', '😀', '👩‍💻', 'é', '\u001b', '\u001b[0m', '\u001b[31m', '\u001b]unterminated', '\u001b]link\u0007', '\u001b[1:2m']
const ops = ['displayWidth', 'stripAnsi', 'escapeControls', 'sanitizePasted', 'truncateToWidth', 'tailToWidth', 'fitToWidth', 'chunkToWidth', 'wrapToWidth']
const budgets = [-256, -1, 0, 1, 8, 40, 120, 256]
for (let i = 0; i < count; i++) {
  let source = ''
  const length = random() % 80
  for (let j = 0; j < length; j++) source += atoms[random() % atoms.length]
  const budget = budgets[random() % budgets.length]
  for (const op of ops) {
    deepStrictEqual(addon[op](source, budget), reference[op](source, budget), `seed ${seed} iteration ${i} ${op}`)
    comparisons++
  }
}
process.stdout.write(JSON.stringify({ iterations: count, comparisons, initialSeed: '0x71c3a019', finalSeed: seed, addonSha256: createHash('sha256').update(readFileSync(addonFile)).digest('hex'), node: process.version, platform: process.platform, arch: process.arch }) + '\n')
