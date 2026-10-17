/** Measure actual public/native/TS host paths against the reviewed same-toolchain baseline. */
import { deepStrictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as api from '../packages/renderer/lib/index.js'
import { rendererIdentity, loadVerifiedRenderer } from './renderer-identity.mjs'
import { regressionGuard } from '../packages/renderer/lib/native-primitives.js'
import { rendererNativeInputsDigest } from './renderer-native-inputs.mjs'
import { soakCases } from './renderer-soak-corpus.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const options = {}
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (key === '--tune-macos' && !options[key]) options[key] = true
  else if (['--baseline-root', '--previous-root', '--output'].includes(key) && process.argv[i + 1] && !options[key]) options[key] = resolve(process.argv[++i])
  else throw Error('usage: --baseline-root checkout [--output metrics.json] [--tune-macos]')
}
if (!options['--baseline-root']) throw Error('A separately built reviewed baseline checkout is required')
const baselineRoot = options['--baseline-root']
const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
if (git(baselineRoot, 'rev-parse', 'HEAD') !== '5e48b70ca6dc4de5462cda7d559581be7ec8c04d') throw Error('Unexpected renderer baseline')
const baseline = await import(pathToFileURL(join(baselineRoot, 'packages/renderer/lib/index.js')).href)
const baselineInputs = await import(pathToFileURL(join(baselineRoot, 'tools/renderer-native-inputs.mjs')).href)
const previousRoot = options['--previous-root']
const previous = previousRoot ? await import(pathToFileURL(join(previousRoot, 'packages/renderer/lib/index.js')).href) : undefined
if (previousRoot && git(previousRoot, 'rev-parse', 'HEAD') !== 'af3459e2b17b537ac2d3e1942b5a6232f39e2c8f') throw Error('Unexpected pre-guard source')
const previousIdentity = previousRoot ? rendererIdentity(previousRoot) : undefined
const require = createRequire(import.meta.url)
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const platform = `${process.platform}-${process.arch}`
const binaryAt = directory => join(directory, `packages/renderer/native/${platform}.node`)
const currentAddon = require(binaryAt(root)), baselineAddon = require(binaryAt(baselineRoot))
const inputs = await rendererNativeInputsDigest(), baseInputs = await baselineInputs.rendererNativeInputsDigest()
const identity = rendererIdentity(), baselineIdentity = rendererIdentity(baselineRoot)
const { renderer: reference } = await loadVerifiedRenderer(undefined, { referenceOnly: true })
const proofAt = directory => JSON.parse(readFileSync(join(directory, `packages/renderer/native/${platform}.provenance.json`)))
const currentProof = proofAt(root), baselineProof = proofAt(baselineRoot)
const previousProof = previousRoot ? proofAt(previousRoot) : undefined
const previousAddon = previousRoot ? require(binaryAt(previousRoot)) : undefined
if (previousRoot) {
  const previousInputs = await import(pathToFileURL(join(previousRoot, 'tools/renderer-native-inputs.mjs')).href)
  deepStrictEqual(previousProof.inputDigest, await previousInputs.rendererNativeInputsDigest())
  deepStrictEqual(previousProof.binarySha256, hash(binaryAt(previousRoot)))
}
deepStrictEqual(currentProof.inputDigest, inputs, 'Current addon is stale')
deepStrictEqual(baselineProof.inputDigest, baseInputs, 'Baseline addon is stale')
deepStrictEqual(currentProof.binarySha256, hash(binaryAt(root)))
deepStrictEqual(baselineProof.binarySha256, hash(binaryAt(baselineRoot)))
const originals = Object.fromEntries(Object.entries(currentAddon).filter(([, value]) => typeof value === 'function'))
// Check the release-addon domain, not only Rust's debug test build or selected
// benchmark text. Keep this bound independent of the generated lookup indexes.
for (let code = 0; code <= 0x10ffff; code++) {
  const expected = reference.codePointWidth(code)
  deepStrictEqual(currentAddon.codePointWidth(code), expected, `Current release width ${code}`)
  deepStrictEqual(baselineAddon.codePointWidth(code), expected, `Baseline release width ${code}`)
}
let tuningDirectory, tunedAddon, tuning
try {
  if (options['--tune-macos']) {
    if (process.platform !== 'darwin') throw Error('macOS tuning requires a real macOS host')
    tuningDirectory = mkdtempSync(join(tmpdir(), 'renderer-macos-lto-'))
    const env = { ...process.env, CARGO_TARGET_DIR: join(tuningDirectory, 'target'), CARGO_PROFILE_RELEASE_LTO: 'thin', CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1', CARGO_PROFILE_RELEASE_PANIC: 'unwind' }
    execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', join(root, 'crates/dshline-renderer-node/Cargo.toml')], { env, stdio: 'inherit' })
    const binary = join(tuningDirectory, 'tuned.node')
    cpSync(join(tuningDirectory, 'target/release/libdshline_renderer_node.dylib'), binary)
    tunedAddon = require(binary)
    tuning = { flags: { lto: 'thin', codegenUnits: 1, panic: 'unwind', targetCpu: 'unchanged target default' }, inputDigest: inputs, binarySha256: hash(binary), bytes: readFileSync(binary).length }
    for (let code = 0; code <= 0x10ffff; code++) deepStrictEqual(tunedAddon.codePointWidth(code), reference.codePointWidth(code), `Tuned width ${code}`)
    let comparisons = 0
    for (const { text, budget } of soakCases(2000)) for (const op of ['displayWidth', 'tailToWidth', 'fitToWidth', 'wrapToWidth', 'chunkToWidth']) {
      deepStrictEqual(tunedAddon[op](text, budget), reference[op](text, budget), `Tuned ${op}`)
      comparisons++
    }
    tuning.parity = { widths: 1114112, comparisons }
  }
  function host(target, source, workload) {
    if (workload === 'frame') return target.frame([source], { width: 80, border: text => '\x1b[32m' + text + '\x1b[0m' })
    const writes = []
    let columns = 80
    const screen = new target.Screen({ columns: () => columns, write: value => writes.push(value) })
    screen.setLive([source], { row: 0, column: 1 })
    screen.setLive([source], { row: 0, column: 1 })
    screen.commit(['done'])
    columns = 60
    screen.markStale()
    screen.setLive([source], { row: 0, column: 1 })
    screen.setLive(['short'])
    screen.close()
    return writes
  }
  function trace(target, addon, workload) {
    const saved = {}, calls = {}
    for (const [op, method] of Object.entries(addon)) if (typeof method === 'function') {
      saved[op] = method
      addon[op] = (...args) => { calls[op] = (calls[op] ?? 0) + 1; return method(...args) }
    }
    const restore = target.setRendererBackend('auto')
    try { host(target, 'Hello 中文 world '.repeat(12), workload); return calls }
    finally { restore(); Object.assign(addon, saved) }
  }
  const reachability = {}
  for (const workload of ['frame', 'screen']) {
    reachability[workload] = { baseline: trace(baseline, baselineAddon, workload), current: trace(api, currentAddon, workload) }
    if (!reachability[workload].current.wrapToWidth) throw Error(`Current ${workload} did not reach native wrapping`)
  }
  let checksum = 0
  function batch(call, count) {
    const start = performance.now()
    for (let i = 0; i < count; i++) { const value = call(i); checksum = (checksum + (typeof value === 'number' ? value : value.length)) | 0 }
    return (performance.now() - start) * 1e6 / count
  }
  function measure(call) {
    batch(call, 500)
    let count = 128
    while (batch(call, count) * count < 5e6 && count < 262144) count *= 2
    const samplesNs = Array.from({ length: 5 }, () => Math.round(batch(call, count)))
    return { samplesNs, medianNs: [...samplesNs].sort((a, b) => a - b)[2], callsPerBatch: count }
  }
  const seeds = { ascii: 'The quick brown fox jumps over the lazy dog. ', cjk: '你好世界，终端渲染测试。', emoji: '👩‍💻😀🏳️‍🌈é ', ansi: '\x1b[32mHello styled world\x1b[0m ' }
  const rows = []
  for (const op of ['displayWidth', 'tailToWidth', 'fitToWidth', 'wrapToWidth', 'chunkToWidth']) for (const [kind, seed] of Object.entries(seeds)) for (const length of [24, 96, 512, 2048]) rows.push({ op, kind, length, columns: 40, seed })
  for (const op of ['wrapToWidth', 'chunkToWidth']) for (const columns of [1, 8, 32, 120, 256]) rows.push({ op, kind: 'narrow', length: 512, columns, seed: seeds.ascii })
  for (const op of ['displayWidth', 'fitToWidth']) for (const length of [64, 512, 2048]) rows.push({ op, kind: 'lateCjk', length, columns: 40, seed: seeds.ascii })
  for (const op of ['frame', 'screen']) for (const kind of ['ascii', 'cjk', 'ansi']) for (const length of [24, 192, 512, 2048]) rows.push({ op, kind, length, columns: 80, seed: seeds[kind] })
  for (const row of rows) {
    const text = row.kind === 'lateCjk' ? 'a'.repeat(row.length - 2) + '中x' : row.seed.repeat(Math.ceil(row.length / row.seed.length)).slice(0, row.length)
    row.corpus = Array.from({ length: 8 }, (_, i) => text.slice(0, -1) + String(i))
    row.timings = {}
    row.nativeCalls = {}
    row.regressionGuard = regressionGuard(row.op, row.corpus[0], row.columns) ?? null
    delete row.seed
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index], isHost = ['frame', 'screen'].includes(row.op)
      const evaluate = (target, i) => isHost ? host(target, row.corpus[i % 8], row.op) : target[row.op](row.corpus[i % 8], row.columns)
      const expected = row.corpus.map((_, i) => evaluate(reference, i))
      const variants = { baselineAuto: { target: baseline, mode: 'auto' }, auto: { target: api, mode: 'auto' }, typescript: { target: api, mode: 'typescript' }, ...(previous ? { previousAuto: { target: previous, mode: 'auto' } } : {}), ...(!isHost ? { baselineDirect: { target: baselineAddon }, direct: { target: currentAddon } } : {}), ...(tunedAddon ? { macosThinLto: { target: api, mode: 'auto', tuned: true } } : {}) }
      const names = Object.keys(variants), offset = (pass + index) % names.length
      for (const name of [...names.slice(offset), ...names.slice(0, offset)]) {
        const variant = variants[name]
        const restore = variant.mode ? variant.target.setRendererBackend(variant.mode) : () => {}
        if (variant.tuned) Object.assign(currentAddon, tunedAddon)
        try {
          for (let i = 0; i < 8; i++) deepStrictEqual(evaluate(variant.target, i), expected[i], `${name}/${row.op}/${row.kind}/${row.length}`)
          if (pass === 0 && variant.mode) {
            const addon = variant.target === baseline ? baselineAddon : variant.target === previous ? previousAddon : currentAddon
            const saved = {}, calls = {}
            for (const [op, method] of Object.entries(addon)) if (typeof method === 'function') { saved[op] = method; addon[op] = (...args) => { calls[op] = (calls[op] ?? 0) + 1; return method(...args) } }
            try { evaluate(variant.target, 0); row.nativeCalls[name] = calls } finally { Object.assign(addon, saved) }
          }
          ;(row.timings[name] ??= []).push(measure(i => evaluate(variant.target, i)))
        } finally { Object.assign(currentAddon, originals); restore() }
      }
    }
    console.error(`Renderer upgrade benchmark: pass ${pass + 1}/3, ${rows.length} workloads`)
  }
  if (previousRoot) { deepStrictEqual(rendererIdentity(previousRoot), previousIdentity); deepStrictEqual(hash(binaryAt(previousRoot)), previousProof.binarySha256) }
  deepStrictEqual(rendererIdentity(), identity)
  deepStrictEqual(rendererIdentity(baselineRoot), baselineIdentity)
  deepStrictEqual(await rendererNativeInputsDigest(), inputs)
  deepStrictEqual(await baselineInputs.rendererNativeInputsDigest(), baseInputs)
  deepStrictEqual(hash(binaryAt(root)), currentProof.binarySha256)
  deepStrictEqual(hash(binaryAt(baselineRoot)), baselineProof.binarySha256)
  const output = { environment: { node: process.version, unicode: process.versions.unicode, platform, cpu: cpus()[0]?.model, rustc: execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).trim() }, commit: git(root, 'rev-parse', 'HEAD'), baselineCommit: git(baselineRoot, 'rev-parse', 'HEAD'), identity, baselineIdentity, previousIdentity, previousProof, currentProof, baselineProof, toolSha256: hash(fileURLToPath(import.meta.url)), releaseCodePointComparisons: { current: 1114112, baseline: 1114112 }, tuning, reachability, procedure: 'Actual guarded public/native paths; eight varying inputs; 500 warmups; calibrated >=5ms batches; five batch means per pass, three rotated passes. Exact outputs before timing. Synthetic in-memory hosts, not PTY/session/end-to-end or per-call tail claims. No concurrent builds/tests.', checksum, rows: rows.map(({ corpus, ...row }) => row) }
  const bytes = JSON.stringify(output, null, 2) + '\n'
  if (options['--output']) writeFileSync(options['--output'], bytes)
  else process.stdout.write(bytes)
} finally {
  Object.assign(currentAddon, originals)
  if (tuningDirectory) rmSync(tuningDirectory, { recursive: true, force: true })
}
