import { studyDirectory } from './study-path.mjs'
/** Exhaustive widths and bounded differential stress against unchanged TS. */
import { deepStrictEqual, throws } from 'node:assert'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { loadVerifiedRenderer, rendererIdentity } from '../../tools/renderer-identity.mjs'
import { soakCases } from '../../tools/renderer-soak-corpus.mjs'
import { fixtures, inputOf, validateCorpus } from '../../tools/renderer-parity.mjs'
import { capture } from '../../tools/renderer-capture.mjs'
import { runRustHost } from '../../tools/renderer-rust-host.mjs'
const scratch = studyDirectory(process.argv[2])
const count = Number(process.argv[3] ?? 30000)
if (!Number.isInteger(count) || count < 1 || count > 1000000) throw Error('Invalid count')
const variants = process.argv.slice(4)
const builds = JSON.parse(readFileSync(join(scratch, 'builds.json')))
const names = variants.length ? variants : Object.keys(builds.variants)
const { renderer: reference, identity } = await loadVerifiedRenderer(undefined, { referenceOnly: true })
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const require = createRequire(import.meta.url)
const ops = ['displayWidth', 'stripAnsi', 'escapeControls', 'sanitizePasted', 'truncateToWidth', 'tailToWidth', 'fitToWidth', 'chunkToWidth', 'wrapToWidth']
const result = { identity, buildEvidence: builds, variants: {} }
const recorded = await fixtures()
validateCorpus(recorded)
for (const fixture of recorded) deepStrictEqual(capture(inputOf(fixture)), fixture, 'Fresh TS golden identity/output')
for (const name of names) {
  const addonPath = join(scratch, name, 'renderer.node')
  deepStrictEqual(hash(addonPath), builds.variants[name].addonSha256)
  const addon = require(addonPath)
  let goldenCases = 0
  for (const fixture of recorded) {
    const native = await runRustHost(inputOf(fixture), undefined, request => addon.execute(request))
    deepStrictEqual(native.value.cases, fixture.cases.map(({ id, output }) => ({ id, output })), `${name}: golden ${fixture.cases[0].id}`)
    if (!native.execution.nativeCalls) throw Error('Golden made no actual native calls')
    goldenCases++
  }
  let widths = 0, comparisons = 0, cases = 0
  for (let code = 0; code <= 0x10ffff; code++) {
    deepStrictEqual(addon.codePointWidth(code), reference.codePointWidth(code), `${name}: code point ${code}`)
    widths++
  }
  const budgets = {}, lengths = {}
  for (const { text, budget, seed } of soakCases(count)) {
    for (const op of ops) {
      deepStrictEqual(addon[op](text, budget), reference[op](text, budget), `${name}: ${op} seed ${seed} budget ${budget} source ${JSON.stringify(text)}`)
      comparisons++
    }
    budgets[budget] = (budgets[budget] ?? 0) + 1
    lengths[text.length] = (lengths[text.length] ?? 0) + 1
    cases++
  }
  // Target source-span holes: skipped spaces must not discard preceding marks/escapes.
  for (const text of ['ab\u0301  cd', 'ab\x1b[31m  cd', 'ab  \u0301 cd', '\u0301 a b ', '中 \x1b[31m  x', 'a\n\u0301 \n']) {
    for (const budget of [-1, 0, 1, 2, 3, 4, 8]) for (const op of ['wrapToWidth', 'tailToWidth']) {
      deepStrictEqual(addon[op](text, budget), reference[op](text, budget), `${name}: span gap ${op} ${JSON.stringify(text)} / ${budget}`)
      comparisons++
    }
  }
  // The mixed hostile corpus usually preselects the original wrap kernel. Stress
  // the ASCII-specialized path independently rather than count fallback as coverage.
  let asciiSeed = 0x419b072d, asciiCases = 0
  const pick = size => { asciiSeed ^= asciiSeed << 13; asciiSeed ^= asciiSeed >>> 17; asciiSeed ^= asciiSeed << 5; return (asciiSeed >>> 0) % size }
  const asciiBudgets = [-256, -1, 0, 1, 8, 40, 120, 256]
  const asciiBudgetCases = {}
  for (let i = 0; i < 4000; i++) {
    const length = pick(2049), budget = asciiBudgets[i % asciiBudgets.length]
    let text = ''
    for (let j = 0; j < length; j++) text += pick(8) === 0 ? '\n' : pick(4) === 0 ? ' ' : String.fromCharCode(32 + pick(95))
    for (const op of ['wrapToWidth', 'tailToWidth']) {
      deepStrictEqual(addon[op](text, budget), reference[op](text, budget), `${name}: ASCII ${i} budget ${budget}`)
      comparisons++
    }
    asciiBudgetCases[budget] = (asciiBudgetCases[budget] ?? 0) + 1
    asciiCases++
  }
  for (const op of ops) throws(() => addon[op]('x'.repeat(2049), 40), /RESOURCE_LIMIT/)
  for (const op of ops.filter(op => op.includes('ToWidth'))) for (const budget of [NaN, Infinity, 1.5, -257, 257]) throws(() => addon[op]('abc', budget), /INVALID_INPUT/)
  deepStrictEqual(hash(addonPath), builds.variants[name].addonSha256)
  result.variants[name] = { goldenCases, widths, comparisons, cases, budgetCases: budgets, utf16LengthCases: lengths, asciiCases, asciiBudgetCases, limits: 'pass' }
  console.log(`${name}: ${widths} widths, ${comparisons} exact transforms, limits pass`)
}
deepStrictEqual(rendererIdentity(), identity)
writeFileSync(join(scratch, 'checks.json'), JSON.stringify(result, null, 2) + '\n')
