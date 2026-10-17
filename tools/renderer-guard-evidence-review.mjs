/** Independently recompute retained public/PTY evidence rather than trust its summaries. */
import { deepStrictEqual, ok } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rendererIdentity } from './renderer-identity.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = name => JSON.parse(readFileSync(new URL(`../benchmarks/${name}`, import.meta.url)))
const sha = value => createHash('sha256').update(value).digest('hex')
const fileSha = name => sha(readFileSync(new URL(`../benchmarks/${name}`, import.meta.url)))
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const ns = samples => median(samples.map(sample => sample.medianNs))
const key = row => [row.op, row.kind, row.length, row.columns].join('/')
const identity = rendererIdentity(root)
const flags = ['darwin-arm64', 'darwin-x64'].flatMap(platform => {
  const old = read(`renderer-leaf-${platform}.json`)
  return old.rows.filter(row => ns(row.timings.auto) > ns(row.timings.baselineAuto) * 1.1).map(row => ({ platform, key: key(row), kind: row.kind }))
})
deepStrictEqual(flags.length, 41)
deepStrictEqual(flags.filter(row => ['ascii', 'ansi', 'narrow', 'lateCjk'].includes(row.kind)).length, 29)
const publicChecks = []
for (const platform of ['linux-arm64', 'darwin-arm64', 'darwin-x64']) {
  const name = `renderer-guard-${platform}.json`, data = read(name)
  deepStrictEqual(data.identity, identity, 'public measurements must bind current production emission')
  deepStrictEqual(data.rows.length, 120)
  for (const flag of flags) {
    const row = data.rows.find(row => key(row) === flag.key)
    ok(row, flag.key)
    deepStrictEqual(row.nativeCalls.auto, {}, `${platform}/${flag.key}: historical gate must precede native work`)
  }
  const controls = ['displayWidth', 'fitToWidth'].map(op => {
    const row = data.rows.find(row => row.op === op && row.kind === 'cjk' && row.length === 2048)
    ok(row.nativeCalls.auto[op] > 0, `${platform}/${op}: actual Rust must be reached`)
    return { op, reviewedUs: ns(row.timings.baselineAuto) / 1000, currentUs: ns(row.timings.auto) / 1000, reviewedSpeedup: ns(row.timings.baselineAuto) / ns(row.timings.auto) }
  })
  publicChecks.push({ platform, fileSha256: fileSha(name), historicalObservationsGated: flags.length, historicalAsciiFamilyObservationsGated: 29, controls })
}
const ptyChecks = []
const toolSha256 = sha(Buffer.concat(['renderer-pty-bench.mjs', 'renderer-pty-worker.mjs'].map(name => readFileSync(new URL(name, import.meta.url)))))
for (const name of ['renderer-pty-linux-arm64.json', 'renderer-pty-darwin-arm64.json', 'renderer-pty-darwin-x64.json', 'renderer-pty-linux-arm64-review.json']) {
  const data = read(name)
  deepStrictEqual(data.identity, identity)
  deepStrictEqual(data.toolSha256, toolSha256)
  deepStrictEqual(data.rows.length, 10)
  for (const [variant, ready] of Object.entries(data.ready)) {
    deepStrictEqual({ tty: ready.tty, columns: ready.columns, rows: ready.rows, unicode: ready.unicode, compiledUnicode: ready.compiledUnicode, outputProcessing: ready.outputProcessing, backend: ready.backend }, { tty: true, columns: 80, rows: 24, unicode: '17.0', compiledUnicode: '17.0', outputProcessing: 'disabled', backend: variant === 'typescript' ? 'typescript' : 'auto' })
  }
  for (const kind of ['ascii', 'cjk']) {
    const pairs = data.rows.filter(row => row.kind === kind)
    deepStrictEqual(pairs.map(row => row.pass), [0, 1, 2, 3, 4])
    const samples = { typescript: [], admittedRust: [] }
    for (const { timings } of pairs) {
      const { typescript: ts, admittedRust: native } = timings
      for (const value of [ts, native]) {
        deepStrictEqual(value.inputUnits, 65536)
        deepStrictEqual(value.deltas, 512)
        deepStrictEqual(value.outputSha256, value.renderedSha256)
        deepStrictEqual(value.outputBytes, value.renderedBytes)
      }
      for (const field of ['inputUnits', 'inputBytes', 'inputSha256', 'deltas', 'renderedBytes', 'renderedSha256', 'outputBytes', 'outputSha256', 'snapshotSha256', 'cursor']) deepStrictEqual(native[field], ts[field], `${name}/${field}`)
      deepStrictEqual(ts.calls, {})
      ok(native.calls.wrapToWidth > 0 && native.calls.displayWidth > 0)
      ok(!native.calls.execute, 'no native composite ownership')
      for (const variant of Object.keys(samples)) samples[variant].push(timings[variant])
    }
    const medians = Object.fromEntries(Object.entries(samples).map(([variant, values]) => [variant, Object.fromEntries(['visibleMs', 'ptyDrainedMs', 'firstByteMs', 'renderMs', 'throughputUnitsPerSecond'].map(field => [field, median(values.map(value => value[field]))]))]))
    deepStrictEqual(data.summary.find(row => row.kind === kind), { kind, ...medians })
    ptyChecks.push({ file: name, fileSha256: fileSha(name), platform: data.platform, commit: data.commit, kind, measuredTurns: 10, medians, visibleChangePercent: (medians.admittedRust.visibleMs / medians.typescript.visibleMs - 1) * 100, visibleRanges: Object.fromEntries(Object.entries(samples).map(([variant, values]) => [variant, [Math.min(...values.map(value => value.visibleMs)), Math.max(...values.map(value => value.visibleMs))]])), nativeCalls: samples.admittedRust.map(value => value.calls) })
  }
}
writeFileSync(new URL('../benchmarks/renderer-guard-review-validation.json', import.meta.url), JSON.stringify({ identity, toolSha256: sha(readFileSync(fileURLToPath(import.meta.url))), procedure: 'Recomputed all medians from raw samples; checked current compiler-verified production identity, exact producing/received bytes/hash, emulator snapshot/cursor, input, actual TTY geometry, version, TS=0/native>0/no composites, and all 41 historical observations in each 120-case platform archive. Mac records are revalidated retained hosted runs, not fresh hardware measurements. Fresh Linux review file is a separate five-pair replication.', publicChecks, ptyChecks }, null, 2) + '\n')
console.log(`Verified ${publicChecks.length * flags.length} historical platform/observation gates and ${ptyChecks.reduce((sum, row) => sum + row.measuredTurns, 0)} byte/state-equal PTY turns`)
