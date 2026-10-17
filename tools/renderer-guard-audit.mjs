/** Review-only guard overhead and individual removal experiments; no shipped policy edits. */
import { deepStrictEqual, ok } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rendererIdentity } from './renderer-identity.mjs'
import { rendererNativeInputsDigest } from './renderer-native-inputs.mjs'
import { legacyGuard, compareCodePoints, compareBoundaries } from './renderer-guard-equivalence.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = process.argv[2]
const interleaved = process.argv[3] === '--interleaved'
ok(output && (process.argv.length === 3 || process.argv.length === 4 && interleaved), 'usage: node tools/renderer-guard-audit.mjs output.json [--interleaved]')
const identity = rendererIdentity(), platform = `${process.platform}-${process.arch}`
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const binary = join(root, `packages/renderer/native/${platform}.node`)
const proof = JSON.parse(readFileSync(join(root, `packages/renderer/native/${platform}.provenance.json`)))
deepStrictEqual(proof.inputDigest, await rendererNativeInputsDigest(), 'stale native proof')
deepStrictEqual(proof.binarySha256, sha(readFileSync(binary)))
ok(proof.cleanInputs, 'benchmark requires committed native inputs')
const compiledFile = join(root, 'packages/renderer/lib/native-primitives.js')
const compiled = readFileSync(compiledFile, 'utf8')
const names = ['ascii-short-width', 'ascii-dominant-width', 'ascii-tail', 'ascii-chunk', 'ascii-wrap']
const mutations = []
// Run the existing historical regression test, not a copied implementation of
// its assertions. Mutate only untracked emission and restore even on failure.
// This phase must not overlap another build, test or timing process.
try {
  for (const guard of [null, ...names]) {
    const literal = `'${guard}'`
    if (guard) deepStrictEqual(compiled.split(literal).length, 2, 'mutation must remove exactly one named return')
    writeFileSync(compiledFile, guard ? compiled.replace(literal, 'undefined') : compiled)
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', 'tools/renderer-leaf.spec.mjs', '-t', 'gates every recorded ASCII regression'], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
    const transcript = result.stdout + result.stderr
    ok(!result.error && !result.signal, 'test must run, not fail to launch')
    if (guard) {
      ok(result.status !== 0 && transcript.includes('must stay TS') && transcript.includes('BACKEND_FAILURE'), `${guard}: guard removal must reach the forbidden native transformation`)
    } else deepStrictEqual(result.status, 0, transcript)
    const witness = transcript.split('\n').filter(line => /must stay TS|BACKEND_FAILURE|Test Files|Tests\s|FAIL.*gates every/u.test(line)).map(line => line.slice(0, 240)).slice(-10)
    mutations.push({ guard, status: result.status, transcriptSha256: sha(transcript), witness })
    console.error(`Historical test: ${guard ?? 'unmodified'} => ${result.status}`)
  }
} finally { writeFileSync(compiledFile, compiled) }

const scratch = mkdtempSync(join(tmpdir(), 'renderer-guard-audit-'))
const require = createRequire(import.meta.url)
const rows = []
let legacyRoot
let legacyWorktree = false
try {
  // Recompile the actual reviewed tree, not a hand-maintained approximation.
  // Build its own exact old addon as well: the final candidate also removes
  // repeated row reallocations. Do not relabel today's Rust as the old kernel.
  const legacyCommit = '25a2501bcabada5832860546d225063a5af0b7d3'
  const rustSourceUnchanged = execFileSync('git', ['diff', legacyCommit, '--', 'crates/dshline-renderer', 'crates/dshline-renderer-node'], { cwd: root, encoding: 'utf8' }) === ''
  legacyRoot = join(scratch, 'reviewed')
  execFileSync('git', ['worktree', 'add', '--detach', legacyRoot, legacyCommit], { cwd: root, stdio: 'pipe' })
  legacyWorktree = true
  symlinkSync(join(root, 'node_modules'), join(legacyRoot, 'node_modules'), 'dir')
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(legacyRoot, 'packages/renderer/tsconfig.json')], { stdio: 'pipe' })
  const legacyIdentity = rendererIdentity(legacyRoot)
  deepStrictEqual(legacyIdentity, JSON.parse(readFileSync(join(root, 'benchmarks/renderer-guard-audit-linux-arm64.json'))).identity, 'before graph must match reviewed source/build/compiler')
  execFileSync(process.execPath, [join(legacyRoot, 'tools/build-renderer-native.mjs'), '--required'], { cwd: legacyRoot, stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 })
  const legacyBinary = join(legacyRoot, `packages/renderer/native/${platform}.node`)
  const legacyNativeProof = JSON.parse(readFileSync(join(legacyRoot, `packages/renderer/native/${platform}.provenance.json`)))
  deepStrictEqual(legacyNativeProof.commit, legacyCommit)
  ok(legacyNativeProof.cleanInputs)
  deepStrictEqual(legacyNativeProof.binarySha256, sha(readFileSync(legacyBinary)))
  deepStrictEqual(legacyNativeProof.inputDigest, JSON.parse(readFileSync(join(root, 'benchmarks/renderer-guard-audit-linux-arm64.json'))).proof.inputDigest)
  const graphs = {}
  for (const name of ['guarded', 'withoutGuards', 'typescript', 'legacyGuarded']) {
    const directory = name === 'legacyGuarded' ? join(legacyRoot, 'packages/renderer') : join(scratch, name)
    if (name !== 'legacyGuarded') {
      mkdirSync(directory)
      cpSync(join(root, 'packages/renderer/lib'), join(directory, 'lib'), { recursive: true })
    }
    if (name !== 'legacyGuarded') {
      mkdirSync(join(directory, 'native'))
      cpSync(binary, join(directory, 'native', `${platform}.node`))
      writeFileSync(join(directory, 'package.json'), '{"type":"module"}')
    }
    if (name === 'withoutGuards') {
      const pattern = /export function regressionGuard\([\s\S]*?\n\}/u
      ok(pattern.test(compiled), 'locate the whole guard function exactly once')
      writeFileSync(join(directory, 'lib/native-primitives.js'), compiled.replace(pattern, 'export function regressionGuard() { return undefined; }'))
    }
    const primitives = await import(pathToFileURL(join(directory, 'lib/native-primitives.js')).href)
    const api = await import(pathToFileURL(join(directory, 'lib/index.js')).href)
    const addon = require(join(directory, 'native', `${platform}.node`))
    deepStrictEqual(addon.unicodeVersion(), process.versions.unicode)
    api.setRendererBackend(name === 'typescript' ? 'typescript' : 'auto')
    graphs[name] = { primitives, api, addon }
  }
  deepStrictEqual(legacyGuard.toString().replace('legacyGuard', 'regressionGuard'), graphs.legacyGuarded.primitives.regressionGuard.toString(), 'frozen test oracle must be the actual reviewed guard')
  const equivalence = { codePointComparisons: compareCodePoints(graphs.guarded.primitives.regressionGuard, 0, 0x10ffff), boundaries: compareBoundaries(graphs.guarded.primitives.regressionGuard) }
  equivalence.totalComparisons = equivalence.codePointComparisons + equivalence.boundaries.comparisons
  deepStrictEqual(equivalence.totalComparisons, 16796982)
  const add = (id, op, text, columns = 80) => {
    // Preserve the exact Unicode/ESC positions and vary only one code unit of
    // the initial ASCII or dense-CJK run; flatten to avoid accidental ropes.
    const corpus = Array.from({ length: 8 }, (_, i) => {
      const units = Array.from({ length: text.length }, (_, j) => text.charCodeAt(j))
      units[0] = text.charCodeAt(0) < 128 ? 48 + i : 0x4e00 + i
      return String.fromCharCode(...units)
    })
    rows.push({ id, op, columns, length: text.length, source: text, corpus, timings: {} })
  }
  add('short-width-64', 'displayWidth', 'a'.repeat(64))
  add('short-width-512', 'displayWidth', 'a'.repeat(512))
  add('dominant-width-64', 'displayWidth', 'a'.repeat(62) + '中x')
  add('dominant-width-2048', 'displayWidth', 'a'.repeat(2046) + '中x')
  add('width-long-ascii', 'displayWidth', 'a'.repeat(2048))
  add('width-middle-single-cjk', 'displayWidth', 'a'.repeat(1024) + '中' + 'a'.repeat(1023))
  add('width-two-cjk-far-apart', 'displayWidth', 'a中' + 'a'.repeat(2045) + '中')
  add('width-dense-cjk', 'displayWidth', '中'.repeat(2048))
  add('width-short-dense-cjk', 'displayWidth', '中'.repeat(512))
  add('width-short-two-cjk-far-apart', 'displayWidth', 'a中' + 'a'.repeat(509) + '中')
  add('tail-below-guard', 'tailToWidth', 'a'.repeat(511))
  add('tail-gated', 'tailToWidth', 'a'.repeat(2048))
  add('tail-late-cjk', 'tailToWidth', 'a'.repeat(2047) + '中')
  add('tail-dense-cjk', 'tailToWidth', '中'.repeat(2048))
  add('tail-zero-budget', 'tailToWidth', '中'.repeat(2048), 0)
  add('chunk-gated', 'chunkToWidth', 'a'.repeat(512), 64)
  add('chunk-late-cjk', 'chunkToWidth', 'a'.repeat(2047) + '中', 80)
  add('chunk-dense-cjk', 'chunkToWidth', '中'.repeat(2048), 80)
  add('wrap-short-gated', 'wrapToWidth', 'a'.repeat(512), 80)
  add('wrap-long-ascii-admitted', 'wrapToWidth', 'a'.repeat(2048), 80)
  add('wrap-long-ascii-budget256', 'wrapToWidth', 'a'.repeat(2048), 256)
  add('wrap-late-cjk', 'wrapToWidth', 'a'.repeat(2047) + '中', 80)
  add('wrap-dense-cjk', 'wrapToWidth', '中'.repeat(2048), 80)
  add('wrap-late-esc-ascii', 'wrapToWidth', 'a'.repeat(2043) + '\x1b[0m ', 80)
  add('wrap-late-esc-cjk', 'wrapToWidth', '中'.repeat(2043) + '\x1b[0m ', 80)
  add('fit-ascii-no-guard', 'fitToWidth', 'a'.repeat(2048), 80)
  let checksum = 0
  function batch(fn, count) {
    const start = performance.now()
    for (let i = 0; i < count; i++) {
      const value = fn(i)
      checksum = (checksum + (typeof value === 'number' ? value : value?.length ?? 0)) | 0
    }
    return (performance.now() - start) * 1e6 / count
  }
  function measure(fn) {
    batch(fn, 500)
    let count = 128, elapsed
    do { elapsed = batch(fn, count) * count; if (elapsed < 5e6) count *= 2 } while (elapsed < 5e6 && count < 1048576)
    const means = Array.from({ length: 5 }, () => batch(fn, count))
    return { count, means, medianNs: [...means].sort((a, b) => a - b)[2] }
  }
  for (const row of rows) {
    const { op, corpus, columns } = row
    const g = graphs.guarded, n = graphs.withoutGuards
    row.guard = g.primitives.regressionGuard(op, corpus[0], columns) ?? null
    deepStrictEqual(row.guard, graphs.legacyGuarded.primitives.regressionGuard(op, corpus[0], columns) ?? null)
    row.calls = {}
    const expected = corpus.map(text => graphs.typescript.api[op](text, columns))
    for (const [name, graph] of Object.entries(graphs)) {
      const original = graph.addon[op]
      let calls = 0
      graph.addon[op] = (...args) => { calls++; return original(...args) }
      try { for (let i = 0; i < corpus.length; i++) deepStrictEqual(graph.api[op](corpus[i], columns), expected[i]) }
      finally { graph.addon[op] = original }
      row.calls[name] = calls
    }
    deepStrictEqual(row.calls.guarded, row.calls.legacyGuarded, 'guard fix must not widen native admission')
  }
  const variantsFor = ({ op, corpus, columns }) => {
    const g = graphs.guarded, n = graphs.withoutGuards
    return {
      guardOnly: i => g.primitives.regressionGuard(op, corpus[i % 8], columns),
      noGuardProbe: i => n.primitives.regressionGuard(op, corpus[i % 8], columns),
      guarded: i => g.api[op](corpus[i % 8], columns),
      withoutGuards: i => n.api[op](corpus[i % 8], columns),
      typescript: i => graphs.typescript.api[op](corpus[i % 8], columns),
      legacyGuardOnly: i => graphs.legacyGuarded.primitives.regressionGuard(op, corpus[i % 8], columns),
      legacyGuarded: i => graphs.legacyGuarded.api[op](corpus[i % 8], columns),
    }
  }
  // Interleave *each batch*, not just whole passes. A predeclared longer repeat
  // checks the noisy Intel result without deleting its losing first-run data.
  const protocol = { interleaved, passes: interleaved ? 11 : 5, batchesPerPass: 5, targetBatchNs: interleaved ? 1e7 : 5e6 }
  if (interleaved) for (let index = 0; index < rows.length; index++) {
    const row = rows[index], variants = variantsFor(row), names = Object.keys(variants), counts = {}
    for (const name of names) {
      batch(variants[name], 500)
      let count = 128
      while (count < 4194304) {
        const means = Array.from({ length: 3 }, () => batch(variants[name], count)).sort((a, b) => a - b)
        if (means[1] * count >= protocol.targetBatchNs) break
        count *= 2
      }
      counts[name] = count
    }
    for (let pass = 0; pass < protocol.passes; pass++) {
      const means = Object.fromEntries(names.map(name => [name, []]))
      for (let block = 0; block < protocol.batchesPerPass; block++) {
        const offset = (pass + index + block) % names.length
        for (const name of [...names.slice(offset), ...names.slice(0, offset)]) means[name].push(batch(variants[name], counts[name]))
      }
      for (const name of names) (row.timings[name] ??= []).push({ count: counts[name], means: means[name], medianNs: [...means[name]].sort((a, b) => a - b)[2] })
    }
    console.error(`Interleaved guard timing: workload ${index + 1}/${rows.length}, ${protocol.passes} passes`)
  }
  else for (let pass = 0; pass < 5; pass++) for (let index = 0; index < rows.length; index++) {
    const row = rows[index], variants = variantsFor(row)
    const order = Object.keys(variants), offset = (pass + index) % order.length
    for (const name of [...order.slice(offset), ...order.slice(0, offset)]) (row.timings[name] ??= []).push(measure(variants[name]))
    if (index === rows.length - 1) console.error(`Guard overhead: pass ${pass + 1}/5`)
  }
  deepStrictEqual(readFileSync(compiledFile, 'utf8'), compiled)
  deepStrictEqual(rendererIdentity(), identity)
  deepStrictEqual(proof.inputDigest, await rendererNativeInputsDigest())
  deepStrictEqual(sha(readFileSync(legacyBinary)), legacyNativeProof.binarySha256)
  const result = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), platform, node: process.version, unicode: process.versions.unicode, cpu: cpus()[0]?.model, identity, legacyCommit, legacyIdentity, legacyNativeProof, rustSourceUnchanged, proof, toolSha256: sha(readFileSync(fileURLToPath(import.meta.url))), compiledSha256: sha(compiled), mutations, equivalence, protocol, procedure: 'Existing historical regression test, unmodified then each named return individually removed from temporary compiled emission (always restored). Four private graphs: fixed guarded auto, current auto without regressionGuard, explicit TS, and freshly compiled immutable reviewed 25a2501 with its own actual old addon and clean proof. Current/native-only graphs share current addon bytes; before is not relabeled to the new kernel. Same pinned toolchain and unchanged compiler policy. Fixed-vs-reviewed decision/call counts and exact TS outputs checked. No-guard counterfactual removes only regressionGuard body, not thresholds or Unicode/bounds admission. 26 inputs x8 flattened varying texts; 500 warmups. Default is five rotated passes, five batch means/pass, >=5ms calibration. Interleaved repeat is eleven passes with five batches/variant/pass, rotating order every batch; calibration uses median of three batches to target >=10ms (4194304-call cap), no trimming/filtering. Same reported median-of-pass-medians metric. Guard-only timings include call/loop overhead; no subtraction/tail claim. No tests/builds during timing. Platform is actual executing hardware.', checksum, rows: rows.map(({ corpus, ...row }) => row) }
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
} finally {
  if (legacyWorktree) execFileSync('git', ['worktree', 'remove', '--force', legacyRoot], { cwd: root, stdio: 'pipe' })
  rmSync(scratch, { recursive: true, force: true })
}
