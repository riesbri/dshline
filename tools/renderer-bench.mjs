/** CPU-sensitive boundary benchmarks. Run release builds, without parallel tests. */
import { deepStrictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as api from '../packages/renderer/lib/index.js'
import { rendererIdentity, loadVerifiedRenderer } from './renderer-identity.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const { identity, renderer: oracle } = await loadVerifiedRenderer(undefined, { referenceOnly: true })
const args = process.argv.slice(2)
const options = {}
for (let i = 0; i < args.length; i += 2) {
  if (!['--output', '--baseline'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('usage: node tools/renderer-bench.mjs [--output result.json] [--baseline previous-renderer-package]')
  options[args[i]] = resolve(args[i + 1])
}
const addonPath = resolve(root, `packages/renderer/native/${process.platform}-${process.arch}.node`)
const addon = createRequire(import.meta.url)(addonPath) // Missing native is an error, never a TS benchmark mislabeled Rust.
const baseline = options['--baseline'] ? await import(pathToFileURL(resolve(options['--baseline'], 'lib/index.js')).href) : undefined
if (baseline) { const restore = baseline.setRendererBackend('rust'); restore() }
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const addonDigest = digest(addonPath)
const seeds = {
  ascii: 'The quick brown fox jumps over the lazy dog. ',
  ansi: '\u001b[32mHello styled world\u001b[0m ',
  cjk: '你好世界，终端渲染测试。',
  emoji: '👩‍💻😀🏳️‍🌈é ',
}
let checksum = 0
function consume(value) { checksum = (checksum + (typeof value === 'number' ? value : value.length)) | 0 }
function batch(call, count) {
  const start = performance.now()
  for (let i = 0; i < count; i++) consume(call(i))
  return (performance.now() - start) * 1e6 / count
}
function measure(call) {
  batch(call, 500)
  let count = 128
  while (batch(call, count) * count < 5e6 && count < 262144) count *= 2
  const samples = Array.from({ length: 5 }, () => batch(call, count)).sort((a, b) => a - b)
  return { medianNsPerCall: Math.round(samples[2]), maxBatchMeanNsPerCall: Math.round(samples[4]), callsPerBatch: count }
}
const rows = []
const directOps = ['displayWidth', 'stripAnsi', 'escapeControls', 'sanitizePasted', 'truncateToWidth', 'tailToWidth', 'fitToWidth', 'chunkToWidth', 'wrapToWidth']
for (const op of [...directOps, 'renderInline', 'renderMarkdown']) {
  const reference = oracle[op]
  for (const [kind, seed] of Object.entries(seeds)) for (const length of [24, 96, 192, 512, 2048]) {
    const source = seed.repeat(Math.ceil(length / seed.length)).slice(0, length)
    // Several inputs prevent an accidentally added one-key memo from passing as
    // a general kernel improvement. No caching is used by either implementation.
    const corpus = Array.from({ length: 8 }, (_, i) => source.slice(0, -1) + String(i))
    const budget = 40
    const samples = corpus.map(s => reference(s, budget))
    const result = { op, kind, length, columns: op.includes('ToWidth') ? budget : undefined }
    const variants = { reference: i => reference(corpus[i % corpus.length], budget) }
    if (directOps.includes(op)) variants.directRust = i => addon[op](corpus[i % corpus.length], budget)
    for (const [variant, mode, target] of [['typescript', 'typescript', api], ['auto', 'auto', api], ...(baseline ? [['baselineAuto', 'auto', baseline]] : [])]) {
      const restore = target.setRendererBackend(mode)
      try {
        for (let i = 0; i < corpus.length; i++) deepStrictEqual(target[op](corpus[i], budget), samples[i], `${op}/${kind}/${length}/${variant}`)
        result[variant] = measure(i => target[op](corpus[i % corpus.length], budget))
      } finally { restore() }
    }
    for (const [variant, call] of Object.entries(variants)) {
      for (let i = 0; i < corpus.length; i++) deepStrictEqual(call(i), samples[i], `${op}/${kind}/${length}/${variant}`)
      result[variant] = measure(call)
    }
    rows.push(result)
  }
}
for (const op of ['chunkToWidth', 'wrapToWidth']) for (const columns of [1, 8, 32, 120]) {
  const source = seeds.ascii.repeat(12)
  const restore = api.setRendererBackend('auto')
  try {
    deepStrictEqual(api[op](source, columns), oracle[op](source, columns))
    rows.push({ op, kind: 'narrow-width', length: source.length, columns, reference: measure(() => oracle[op](source, columns)), auto: measure(() => api[op](source, columns)) })
  } finally { restore() }
}
for (const method of ['line', 'partial']) {
  const source = '**Hello** world 你好 `code` '.repeat(4)
  const reference = oracle.createMarkdownRenderer()
  const result = { op: `stream.${method}`, kind: 'markdown', length: source.length, reference: measure(() => reference[method](source)) }
  for (const [variant, target] of [['auto', api], ...(baseline ? [['baselineAuto', baseline]] : [])]) {
    const restore = target.setRendererBackend('auto')
    try { const stream = target.createMarkdownRenderer(); deepStrictEqual(stream[method](source), reference[method](source)); result[variant] = measure(() => stream[method](source)) } finally { restore() }
  }
  rows.push(result)
}
deepStrictEqual(rendererIdentity(), identity, 'Renderer source/build changed during measurement')
deepStrictEqual(digest(addonPath), addonDigest, 'Native addon changed during measurement')
const result = {
  identity,
  environment: { node: process.version, unicode: process.versions.unicode, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, addonSha256: digest(addonPath), backendSourceSha256: digest(resolve(root, 'packages/renderer/src/backend.ts')), baselineAddonSha256: options['--baseline'] ? digest(resolve(options['--baseline'], `native/${process.platform}-${process.arch}.node`)) : undefined },
  procedure: 'Release addon; 500 warmup calls; calibrated >=5ms batches; median and max of five batch averages. Local CPU-sensitive timings, not per-call tail latency or a cross-platform guarantee.',
  checksum, rows,
}
const output = JSON.stringify(result, null, 2) + '\n'
if (options['--output']) writeFileSync(options['--output'], output)
else process.stdout.write(output)
