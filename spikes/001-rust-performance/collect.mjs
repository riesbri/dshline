import { studyDirectory } from './study-path.mjs'
/** Freeze research evidence and verify its identities before committing it. */
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { deepStrictEqual } from 'node:assert'
const here = fileURLToPath(new URL('./', import.meta.url))
const scratch = studyDirectory(process.argv[2])
const output = join(here, 'results')
mkdirSync(output, { recursive: true })
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const read = file => JSON.parse(readFileSync(file))
for (const name of ['builds', 'checks', 'bench', 'host', 'mutations']) copyFileSync(join(scratch, `${name}.json`), join(output, `${name}.json`))
const builds = read(join(output, 'builds.json')), checks = read(join(output, 'checks.json')), bench = read(join(output, 'bench.json')), host = read(join(output, 'host.json')), mutations = read(join(output, 'mutations.json'))
deepStrictEqual(checks.buildEvidence, builds)
deepStrictEqual(bench.builds, builds)
deepStrictEqual(host.builds, builds)
deepStrictEqual(bench.checksSha256, hash(join(output, 'checks.json')))
for (const value of [bench, host, mutations]) deepStrictEqual(value.identity, checks.identity)
const phase1 = read(join(output, 'phase1-bench.json'))
deepStrictEqual(phase1.checksSha256, hash(join(output, 'phase1-checks.json')))
deepStrictEqual(phase1.identity, checks.identity)
for (const [name, evidence] of Object.entries(builds.variants)) deepStrictEqual(hash(join(scratch, name, 'renderer.node')), evidence.addonSha256)
const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]
const ns = passes => median(passes.map(pass => pass.medianNs))
const summary = {
  procedure: 'Median of three pass medians, not pooled per-call latency; baseline is the already optimized Rust addon, not historical original JSON transport.',
  totals: { builds: Object.keys(builds.variants).length, exhaustiveWidthComparisons: Object.values(checks.variants).reduce((sum, v) => sum + v.widths, 0), exactTransformComparisons: Object.values(checks.variants).reduce((sum, v) => sum + v.comparisons, 0), goldenReplays: Object.values(checks.variants).reduce((sum, v) => sum + v.goldenCases, 0), directWorkloads: bench.rows.length, hostWorkloads: host.rows.length },
  direct: bench.rows.filter(row => row.length === 2048 || row.op === 'wrapToWidth' && row.kind === 'ascii' && row.length === 192).map(row => ({ op: row.op, kind: row.kind, length: row.length, budget: row.budget, medianNs: Object.fromEntries(Object.entries(row.timings).map(([name, passes]) => [name, ns(passes)])) })),
  host: host.rows.map(row => ({ workload: row.workload, kind: row.kind, length: row.length, medianNs: Object.fromEntries(Object.entries(row.timings).map(([name, passes]) => [name, ns(passes)])) })),
}
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
const names = ['builds', 'checks', 'bench', 'host', 'mutations', 'phase1-bench', 'phase1-host', 'phase1-checks', 'summary']
if (existsSync(join(scratch, 'rust-tests.json'))) {
  copyFileSync(join(scratch, 'rust-tests.json'), join(output, 'rust-tests.json'))
  names.push('rust-tests')
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ artifacts: Object.fromEntries(names.map(name => [`${name}.json`, hash(join(output, `${name}.json`))])), tools: Object.fromEntries(['prepare.mjs', 'check.mjs', 'bench.mjs', 'host.mjs', 'mutations.mjs', 'collect.mjs', 'study-path.mjs', 'tail.rs', 'wrap.rs'].map(name => [name, hash(join(here, name))])), note: 'Tool hashes describe this measurement run. phase1 artifacts precede the extra ASCII corpus and reduced-candidate follow-up; their build/tool evolution is documented, not represented as final-tool runs.' }, null, 2) + '\n')
console.log(JSON.stringify(summary.totals))
