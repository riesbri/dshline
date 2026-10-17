/** Verify and summarize same-run guard-fix controls on the three actual machines. */
import { deepStrictEqual, ok } from 'node:assert'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rendererIdentity } from './renderer-identity.mjs'
import { rendererNativeInputsDigest } from './renderer-native-inputs.mjs'

const identity = rendererIdentity(), currentInputDigest = await rendererNativeInputsDigest()
const initial = process.argv[2] === '--initial', guardOnly = process.argv[2] === '--guard-only', retained = initial || guardOnly
const suffix = initial ? '-initial' : guardOnly ? '-guard-only' : ''
ok(process.argv.length === 2 || retained && process.argv.length === 3, 'usage: renderer-guard-fix-report.mjs [--initial|--guard-only]')
// Earlier matrices bind the old kernel's committed clean-input proof, never
// today's changed Rust input digest. Both retained phases used that same kernel.
const oldProof = JSON.parse(execFileSync('git', ['show', 'ad4a81f5ae9c846cc2582640de3d956276761b38:benchmarks/renderer-guard-fix-linux-arm64-initial.json'])).proof
const inputDigest = retained ? oldProof.inputDigest : currentInputDigest
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const toolSha256 = retained ? createHash('sha256').update(execFileSync('git', ['show', `${initial ? '4ba66c1e273a1dd3d44a23d039ac7194377caf1c' : 'ad4a81f5ae9c846cc2582640de3d956276761b38'}:tools/renderer-guard-audit.mjs`])).digest('hex') : sha(new URL('./renderer-guard-audit.mjs', import.meta.url))
const median = samples => samples.map(value => value.medianNs).sort((a, b) => a - b)[Math.floor(samples.length / 2)] / 1000
const defects = ['width-two-cjk-far-apart', 'width-short-two-cjk-far-apart', 'tail-late-cjk', 'chunk-late-cjk']
const controls = ['width-long-ascii', 'width-dense-cjk', 'width-short-dense-cjk', 'tail-dense-cjk', 'chunk-dense-cjk', 'wrap-long-ascii-admitted', 'wrap-dense-cjk', 'fit-ascii-no-guard']
const rows = [], sources = [], equivalence = [], ptyChecks = [], slowerControls = []
const ptyToolSha256 = createHash('sha256').update(readFileSync(new URL('./renderer-pty-bench.mjs', import.meta.url))).update(readFileSync(new URL('./renderer-pty-worker.mjs', import.meta.url))).digest('hex')
for (const platform of ['linux-arm64', 'darwin-arm64', 'darwin-x64']) {
  const path = new URL(`../benchmarks/renderer-guard-fix-${platform}${suffix}.json`, import.meta.url)
  const data = JSON.parse(readFileSync(path))
  deepStrictEqual(data.platform, platform)
  deepStrictEqual(data.identity, identity)
  deepStrictEqual(data.proof.inputDigest, inputDigest)
  ok(data.proof.cleanInputs)
  deepStrictEqual(data.toolSha256, toolSha256)
  deepStrictEqual(data.legacyCommit, '25a2501bcabada5832860546d225063a5af0b7d3')
  deepStrictEqual(data.legacyIdentity, JSON.parse(readFileSync(new URL('../benchmarks/renderer-guard-audit-linux-arm64.json', import.meta.url))).identity)
  if (!retained) {
    deepStrictEqual(data.legacyNativeProof.commit, data.legacyCommit)
    ok(data.legacyNativeProof.cleanInputs)
    deepStrictEqual(data.legacyNativeProof.inputDigest, JSON.parse(readFileSync(new URL('../benchmarks/renderer-guard-audit-linux-arm64.json', import.meta.url))).proof.inputDigest)
  }
  deepStrictEqual(data.equivalence.totalComparisons, 16796982)
  deepStrictEqual(data.equivalence.codePointComparisons, 16711680)
  deepStrictEqual(data.equivalence.boundaries.comparisons, 85302)
  deepStrictEqual(data.equivalence.boundaries.texts, 677)
  deepStrictEqual(data.mutations.map(value => [value.guard, value.status]), [[null, 0], ...['ascii-short-width', 'ascii-dominant-width', 'ascii-tail', 'ascii-chunk', 'ascii-wrap'].map(name => [name, 1])])
  deepStrictEqual(data.rows.length, 26)
  if (!initial) deepStrictEqual(data.protocol, { interleaved: true, passes: 11, batchesPerPass: 5, targetBatchNs: 1e7 })
  for (const row of data.rows) {
    deepStrictEqual(row.calls.guarded, row.calls.legacyGuarded)
    deepStrictEqual(row.calls.typescript, 0)
    for (const samples of Object.values(row.timings)) { deepStrictEqual(samples.length, initial ? 5 : 11); for (const sample of samples) deepStrictEqual(sample.means.length, 5) }
    const before = median(row.timings.legacyGuarded), fixed = median(row.timings.guarded)
    if (!defects.includes(row.id) && fixed > before * 1.1) {
      const pairedRatios = row.timings.guarded.map((sample, i) => sample.medianNs / row.timings.legacyGuarded[i].medianNs)
      slowerControls.push({ platform, id: row.id, beforeUs: before, fixedUs: fixed, ratioOfMedians: fixed / before, pairedRatios, medianPairedRatio: [...pairedRatios].sort((a, b) => a - b)[Math.floor(pairedRatios.length / 2)] })
    }
  }
  sources.push({ platform, commit: data.commit, node: data.node, cpu: data.cpu, sha256: sha(path), binarySha256: data.proof.binarySha256, beforeNativeProof: data.legacyNativeProof })
  equivalence.push({ platform, ...data.equivalence })
  const ptyPath = new URL(`../benchmarks/renderer-pty-guard-fix-${platform}${suffix}.json`, import.meta.url)
  const pty = JSON.parse(readFileSync(ptyPath))
  deepStrictEqual(pty.identity, identity)
  deepStrictEqual(pty.toolSha256, ptyToolSha256)
  deepStrictEqual(pty.proof.inputDigest, inputDigest)
  deepStrictEqual(pty.proof.binarySha256, data.proof.binarySha256)
  deepStrictEqual(pty.rows.length, 10)
  for (const [name, ready] of Object.entries(pty.ready)) {
    deepStrictEqual({ tty: ready.tty, columns: ready.columns, rows: ready.rows, outputProcessing: ready.outputProcessing, unicode: ready.unicode, compiledUnicode: ready.compiledUnicode, backend: ready.backend }, { tty: true, columns: 80, rows: 24, outputProcessing: 'disabled', unicode: '17.0', compiledUnicode: '17.0', backend: name === 'typescript' ? 'typescript' : 'auto' })
  }
  for (const kind of ['ascii', 'cjk']) deepStrictEqual(pty.rows.filter(row => row.kind === kind).map(row => row.pass), [0, 1, 2, 3, 4])
  for (const { timings } of pty.rows) {
    const { typescript: ts, admittedRust: native } = timings
    for (const value of [ts, native]) {
      deepStrictEqual(value.inputUnits, 65536)
      deepStrictEqual(value.deltas, 512)
      deepStrictEqual(value.outputBytes, value.renderedBytes)
      deepStrictEqual(value.outputSha256, value.renderedSha256)
    }
    for (const field of ['inputUnits', 'inputBytes', 'inputSha256', 'deltas', 'outputBytes', 'outputSha256', 'snapshotSha256', 'cursor']) deepStrictEqual(native[field], ts[field])
    deepStrictEqual(ts.calls, {})
    ok(native.calls.wrapToWidth > 0 && native.calls.displayWidth > 0 && !native.calls.execute)
  }
  ptyChecks.push({ platform, sha256: sha(ptyPath), turns: 20, producingReceivedAndEmulatorParity: true })
  for (const id of [...defects, ...controls]) {
    const row = data.rows.find(value => value.id === id)
    ok(row, id)
    const timingsUs = Object.fromEntries(Object.entries(row.timings).map(([name, values]) => [name, median(values)]))
    if (defects.includes(id)) {
      deepStrictEqual(row.guard, null, 'defect inputs must remain admitted, not get another TS gate')
      deepStrictEqual(row.calls.guarded, 8, 'fixed measurement must really execute Rust')
      deepStrictEqual(row.calls.withoutGuards, 8)
    }
    rows.push({ platform, id, guard: row.guard, calls: row.calls, timingsUs, beforeOverFixed: timingsUs.legacyGuarded / timingsUs.guarded, guardedAtMostTS: timingsUs.guarded <= timingsUs.typescript, isDefect: defects.includes(id) })
  }
}
const acceptance = rows.filter(row => row.isDefect).every(row => row.guardedAtMostTS)
const result = { identity, inputDigest, initial, guardOnly, reportToolSha256: sha(fileURLToPath(import.meta.url)), auditToolSha256: toolSha256, procedure: 'Medians recomputed from pass medians of five calibrated batch means; initial=5 whole-variant rotated passes, repeat/final=11 passes with order rotated after every batch, >=10ms calibration. No trimming/filtering and no switch to ratio-of-paired medians for acceptance. Before is freshly compiled 25a2501; retained phases reused same Rust, final phase builds its actual original addon with a clean proof because current chunk allocation changed. Current/no-guard share current native bytes. Source identities, phase-specific native proofs, equivalence and individual mutation results checked. No-guard and legacy graphs are benchmark-only. All four defect inputs must remain native-admitted and fixed guarded must not lose to explicit TS on any measured platform. Fresh PTY records require exact producing/received bytes and emulator parity with actual native reachability. Retain every non-defect control whose guarded median is >10% slower than before, without reclassifying it as a pass.', sources, equivalence, ptyChecks, allTwelveDefectCellsPass: acceptance, slowerControls, rows }
writeFileSync(new URL(`../benchmarks/renderer-guard-fix-summary${suffix}.json`, import.meta.url), JSON.stringify(result, null, 2) + '\n')
for (const row of rows.filter(row => row.isDefect)) {
  const t = row.timingsUs
  console.log(`${row.platform} ${row.id}: before ${t.legacyGuarded.toFixed(3)} / fixed ${t.guarded.toFixed(3)} / no-guards ${t.withoutGuards.toFixed(3)} / TS ${t.typescript.toFixed(3)} us; probe ${t.legacyGuardOnly.toFixed(3)} -> ${t.guardOnly.toFixed(3)} us`)
}
ok(acceptance, 'A fixed guarded defect case still loses to TS; inspect retained raw evidence')
