/** Deterministic direct-FFI differential soak; cannot pass via auto fallback. */
import { deepStrictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { rendererIdentity, loadVerifiedRenderer } from './renderer-identity.mjs'
import { rendererNativeInputsDigest } from './renderer-native-inputs.mjs'
import { BOUNDARY_LENGTHS, BUDGETS, INITIAL_SEED, soakCases } from './renderer-soak-corpus.mjs'
const count = Number(process.argv[2] ?? 10000)
if (process.argv.length > 3 || !Number.isInteger(count) || count < 1 || count > 1000000) throw Error('usage: node tools/renderer-soak.mjs [iterations 1..1000000]')
const addonFile = new URL(`../packages/renderer/native/${process.platform}-${process.arch}.node`, import.meta.url)
const proofFile = new URL(`../packages/renderer/native/${process.platform}-${process.arch}.provenance.json`, import.meta.url)
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const toolIdentity = () => Object.fromEntries(['renderer-soak.mjs', 'renderer-soak-corpus.mjs'].map(name => [name, digest(new URL(name, import.meta.url))]))
const { identity, renderer: reference } = await loadVerifiedRenderer(undefined, { referenceOnly: true })
const nativeInputDigest = await rendererNativeInputsDigest()
const addonSha256 = digest(addonFile)
const toolSha256 = toolIdentity()
const artifactProvenance = JSON.parse(readFileSync(proofFile, 'utf8'))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' }).trim()
deepStrictEqual({ schema: artifactProvenance.schema, commit: artifactProvenance.commit, platform: artifactProvenance.platform, inputDigest: artifactProvenance.inputDigest, cleanInputs: artifactProvenance.cleanInputs, binarySha256: artifactProvenance.binarySha256 }, { schema: 1, commit, platform: `${process.platform}-${process.arch}`, inputDigest: nativeInputDigest, cleanInputs: true, binarySha256: addonSha256 }, 'Soak requires a clean exact-commit addon with matching source-input provenance')
const addon = createRequire(import.meta.url)(fileURLToPath(addonFile))
let comparisons = 0, iterations = 0, finalSeed = INITIAL_SEED
const budgetCases = {}, utf16LengthCases = {}
const ops = ['displayWidth', 'stripAnsi', 'escapeControls', 'sanitizePasted', 'truncateToWidth', 'tailToWidth', 'fitToWidth', 'chunkToWidth', 'wrapToWidth']
for (const { text: source, budget, seed } of soakCases(count)) {
  budgetCases[budget] = (budgetCases[budget] ?? 0) + 1
  utf16LengthCases[source.length] = (utf16LengthCases[source.length] ?? 0) + 1
  for (const op of ops) {
    deepStrictEqual(addon[op](source, budget), reference[op](source, budget), `seed ${seed} iteration ${iterations} ${op}, budget ${budget}`)
    comparisons++
  }
  iterations++
  finalSeed = seed
}
deepStrictEqual(rendererIdentity(), identity, 'Renderer source/build changed during soak')
deepStrictEqual(await rendererNativeInputsDigest(), nativeInputDigest, 'Native inputs changed during soak')
deepStrictEqual(digest(addonFile), addonSha256, 'Native addon changed during soak')
deepStrictEqual(JSON.parse(readFileSync(proofFile, 'utf8')), artifactProvenance, 'Native proof changed during soak')
deepStrictEqual(toolIdentity(), toolSha256, 'Soak tooling changed during soak')
process.stdout.write(JSON.stringify({ randomIterations: count, boundaryIterations: BOUNDARY_LENGTHS.length * BUDGETS.length, iterations, comparisons, initialSeed: `0x${INITIAL_SEED.toString(16)}`, finalSeed, budgetCases, utf16LengthCases, identity, nativeInputDigest, artifactProvenance, toolSha256, addonSha256, node: process.version, platform: process.platform, arch: process.arch }) + '\n')
