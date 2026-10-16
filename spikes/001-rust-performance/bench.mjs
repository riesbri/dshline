/** Compare actual addon calls, alternating variant order; no public auto claim. */
import { deepStrictEqual } from 'node:assert'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { cpus } from 'node:os'
import { rendererIdentity, loadVerifiedRenderer } from '../../tools/renderer-identity.mjs'
const scratch = resolve(process.argv[2] ?? '/tmp/dshline-performance-study')
const passes = Number(process.argv[3] ?? 3)
if (!Number.isInteger(passes) || passes < 1 || passes > 10) throw Error('Invalid passes')
const builds = JSON.parse(readFileSync(join(scratch, 'builds.json')))
const checks = JSON.parse(readFileSync(join(scratch, 'checks.json')))
deepStrictEqual(checks.buildEvidence, builds, 'Run parity checks for these exact builds first')
const selected = process.argv.slice(4)
if (selected.some(name => !builds.variants[name])) throw Error('Unknown benchmark variant')
const names = selected.length ? selected : Object.keys(builds.variants)
const require = createRequire(import.meta.url)
const addons = Object.fromEntries(names.map(name => [name, require(join(scratch, name, 'renderer.node'))]))
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
function assertBinaries() { for (const name of names) deepStrictEqual(hash(join(scratch, name, 'renderer.node')), builds.variants[name].addonSha256) }
assertBinaries()
const { renderer: reference, identity } = await loadVerifiedRenderer(undefined, { referenceOnly: true })
deepStrictEqual(identity, checks.identity)
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
  const samples = Array.from({ length: 5 }, () => batch(call, count))
  return { samplesNs: samples.map(Math.round), medianNs: Math.round([...samples].sort((a, b) => a - b)[2]), callsPerBatch: count }
}
const seeds = { ascii: 'The quick brown fox jumps over the lazy dog. ', ansi: '\x1b[32mHello styled world\x1b[0m ', cjk: '你好世界，终端渲染测试。', emoji: '👩‍💻😀🏳️‍🌈é ', hostile: 'x\ud800é\x1b[1:2m\x1b]bad\0中 ' }
const rows = []
for (const op of ['displayWidth', 'tailToWidth', 'wrapToWidth', 'fitToWidth', 'chunkToWidth']) {
  for (const [kind, seed] of Object.entries(seeds)) for (const length of [24, 64, 192, 512, 2048]) {
    const text = seed.repeat(Math.ceil(length / seed.length)).slice(0, length)
    rows.push({ op, kind, length, budget: 40, corpus: Array.from({ length: 8 }, (_, i) => text.slice(0, -1) + String(i)), timings: {} })
  }
}
for (const op of ['wrapToWidth', 'chunkToWidth']) for (const budget of [1, 8, 32, 120, 256]) {
  const seed = seeds.ascii.repeat(12)
  rows.push({ op, kind: 'rows', length: seed.length, budget, corpus: Array.from({ length: 8 }, (_, i) => seed.slice(0, -1) + String(i)), timings: {} })
}
for (let pass = 0; pass < passes; pass++) {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], { op, corpus, budget } = row
    const expected = corpus.map(source => reference[op](source, budget))
    const order = [...names, 'typescript']
    const offset = (pass + index) % order.length
    for (const name of [...order.slice(offset), ...order.slice(0, offset)]) {
      const implementation = name === 'typescript' ? reference : addons[name]
      for (let i = 0; i < corpus.length; i++) deepStrictEqual(implementation[op](corpus[i], budget), expected[i], `${name}/${op}/${row.kind}/${row.length}`)
      const timing = measure(i => implementation[op](corpus[i % corpus.length], budget))
      ;(row.timings[name] ??= []).push(timing)
    }
  }
  console.log(`Finished pass ${pass + 1}/${passes}: ${rows.length} workloads`)
}
deepStrictEqual(rendererIdentity(), identity)
assertBinaries()
writeFileSync(join(scratch, 'bench.json'), JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }, identity, builds, checksSha256: hash(join(scratch, 'checks.json')), procedure: 'Eight varying inputs per workload; 500 warmups; calibrated >=5ms batch, median of five batch means; rotated variant order per workload/pass. Independent passes retained. No cache, no public-auto/E2E/cross-platform/per-call-tail claim.', passes, checksum, rows: rows.map(({ corpus, ...row }) => row) }, null, 2) + '\n')
