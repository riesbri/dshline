/** Review-only guard overhead and individual removal experiments; no shipped policy edits. */
import { deepStrictEqual, ok } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rendererIdentity } from './renderer-identity.mjs'
import { rendererNativeInputsDigest } from './renderer-native-inputs.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = process.argv[2]
ok(output && process.argv.length === 3, 'usage: node tools/renderer-guard-audit.mjs output.json')
const identity = rendererIdentity(), platform = `${process.platform}-${process.arch}`
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const binary = join(root, `packages/renderer/native/${platform}.node`)
const proof = JSON.parse(readFileSync(join(root, `packages/renderer/native/${platform}.provenance.json`)))
deepStrictEqual(proof.inputDigest, await rendererNativeInputsDigest(), 'stale native proof')
deepStrictEqual(proof.binarySha256, sha(readFileSync(binary)))
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
try {
  const graphs = {}
  for (const name of ['guarded', 'withoutGuards', 'typescript']) {
    const directory = join(scratch, name)
    mkdirSync(directory)
    cpSync(join(root, 'packages/renderer/lib'), join(directory, 'lib'), { recursive: true })
    mkdirSync(join(directory, 'native'))
    cpSync(binary, join(directory, 'native', `${platform}.node`))
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}')
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
  }
  // Phase is sequential: no tests/builds overlap these calibrated batches.
  for (let pass = 0; pass < 5; pass++) for (let index = 0; index < rows.length; index++) {
    const row = rows[index], { op, corpus, columns } = row, g = graphs.guarded, n = graphs.withoutGuards
    const variants = {
      guardOnly: i => g.primitives.regressionGuard(op, corpus[i % 8], columns),
      noGuardProbe: i => n.primitives.regressionGuard(op, corpus[i % 8], columns),
      guarded: i => g.api[op](corpus[i % 8], columns),
      withoutGuards: i => n.api[op](corpus[i % 8], columns),
      typescript: i => graphs.typescript.api[op](corpus[i % 8], columns),
    }
    const order = Object.keys(variants), offset = (pass + index) % order.length
    for (const name of [...order.slice(offset), ...order.slice(0, offset)]) (row.timings[name] ??= []).push(measure(variants[name]))
    if (index === rows.length - 1) console.error(`Guard overhead: pass ${pass + 1}/5`)
  }
  deepStrictEqual(readFileSync(compiledFile, 'utf8'), compiled)
  deepStrictEqual(rendererIdentity(), identity)
  deepStrictEqual(proof.inputDigest, await rendererNativeInputsDigest())
  const result = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), platform, node: process.version, unicode: process.versions.unicode, cpu: cpus()[0]?.model, identity, proof, toolSha256: sha(readFileSync(fileURLToPath(import.meta.url))), compiledSha256: sha(compiled), mutations, procedure: 'Existing historical regression test, unmodified then each named return individually removed from temporary compiled emission (always restored). Timing uses three private copied graphs: guarded auto, auto without regressionGuard, and explicit TS. Exact same actual addon bytes and exact TS oracle; counterfactual removes only regressionGuard body, not thresholds or Unicode/bounds admission. 26 inputs x8 flattened varying texts, 500 warmups, >=5ms calibrated batches, five batch means x5 rotated passes. Guard-only timings include call/loop overhead; no subtraction/tail claim. No tests/builds during timing. Local Linux evidence only, not Mac hot-path measurements.', checksum, rows: rows.map(({ corpus, ...row }) => row) }
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
} finally { rmSync(scratch, { recursive: true, force: true }) }
