import { studyDirectory } from './study-path.mjs'
/** Synthetic TS-owned frame/Screen workloads with isolated native leaf injection. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { deepStrictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { rendererIdentity } from '../../tools/renderer-identity.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const scratch = studyDirectory(process.argv[2])
const builds = JSON.parse(readFileSync(join(scratch, 'builds.json')))
const identity = rendererIdentity()
const require = createRequire(import.meta.url)
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const modules = {}, counters = {}
for (const name of ['original-auto', 'leaf-baseline', 'leaf-candidate']) {
  const directory = join(scratch, name)
  mkdirSync(directory, { recursive: true })
  cpSync(join(root, 'packages/renderer/lib'), join(directory, 'lib'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n')
  const variant = name === 'leaf-candidate' ? 'candidate' : 'baseline'
  const addonPath = join(scratch, variant, 'renderer.node')
  deepStrictEqual(hash(addonPath), builds.variants[variant].addonSha256)
  const real = require(addonPath)
  const counter = counters[name] = {}
  // A process-local scratch-only bridge, never a published package entry point.
  const bridge = `__dshlineStudy_${name.replaceAll('-', '_')}`
  globalThis[bridge] = Object.fromEntries(Object.entries(real).filter(([, value]) => typeof value === 'function').map(([op, value]) => [op, (...args) => { counter[op] = (counter[op] ?? 0) + 1; return value(...args) }]))
  if (name === 'original-auto') {
    // Existing loader sees the same guarded transport, without changing source files.
    mkdirSync(join(directory, 'native'), { recursive: true })
    const loader = join(directory, `native/${process.platform}-${process.arch}.node`)
    cpSync(addonPath, loader)
    require.cache[loader] = { exports: globalThis[bridge] }
  } else {
    cpSync(join(directory, 'lib/width.js'), join(directory, 'lib/width-reference.js'))
    writeFileSync(join(directory, 'lib/width.js'), `import * as ts from './width-reference.js';
export * from './width-reference.js';
const addon = globalThis[${JSON.stringify(bridge)}];
const text = source => typeof source === 'string' && source.length >= 64 && source.length <= 2048;
const budget = columns => typeof columns === 'number' && Number.isInteger(columns) && Math.abs(columns) <= 256;
export const displayWidth = source => text(source) ? addon.displayWidth(source) : ts.displayWidth(source);
export const wrapToWidth = (source, columns) => text(source) && budget(columns) && columns >= 32 ? addon.wrapToWidth(source, columns) : ts.wrapToWidth(source, columns);
`)
  }
  modules[name] = await import(pathToFileURL(join(directory, 'lib/index.js')).href)
  // Force loading in the original module before deleting its temporary bridge.
  if (name === 'original-auto') {
    modules[name].setRendererBackend('auto')
    modules[name].displayWidth('x'.repeat(64))
  }
  delete globalThis[bridge]
}
const source = 'The quick brown fox jumps over the lazy dog. '.repeat(12)
const trace = {}
for (const [name, api] of Object.entries(modules)) {
  const counter = counters[name]
  const delta = call => {
    for (const op of Object.keys(counter)) delete counter[op]
    call()
    return { ...counter }
  }
  trace[name] = {
    publicWrap: delta(() => api.wrapToWidth(source, 80)),
    callbackFrame: delta(() => api.frame([source], { width: 80, border: text => '\x1b[32m' + text + '\x1b[0m' })),
    screen: delta(() => { const screen = new api.Screen({ columns: () => 80, write() {} }); screen.setLive([source]); screen.commit([source]); screen.close() }),
  }
}
deepStrictEqual(trace['original-auto'].publicWrap, { wrapToWidth: 1 }, 'Tracing must observe actual native dispatch')
deepStrictEqual(trace['original-auto'].callbackFrame, {}, 'Documented original callback frame reachability')
deepStrictEqual(trace['original-auto'].screen, {}, 'Documented original Screen reachability')
for (const name of ['leaf-baseline', 'leaf-candidate']) {
  if (!trace[name].callbackFrame.wrapToWidth || !trace[name].screen.wrapToWidth) throw Error('Leaf experiment never reached Rust')
}
const rows = []
let checksum = 0
function measure(call) {
  for (let i = 0; i < 300; i++) checksum += call(i).length
  let count = 128
  const batch = n => { const start = performance.now(); for (let i = 0; i < n; i++) checksum += call(i).length; return (performance.now() - start) * 1e6 / n }
  while (batch(count) * count < 5e6 && count < 262144) count *= 2
  const samplesNs = Array.from({ length: 5 }, () => batch(count)).sort((a, b) => a - b)
  return { medianNs: Math.round(samplesNs[2]), samplesNs: samplesNs.map(Math.round), callsPerBatch: count }
}
for (const [kind, seed] of Object.entries({ ascii: 'The quick brown fox jumps over the lazy dog. ', cjk: '你好世界，终端渲染测试。', ansi: '\x1b[32mHello styled world\x1b[0m ' })) for (const length of [192, 512, 2048]) for (const workload of ['callbackFrame', 'screen']) {
  const text = seed.repeat(Math.ceil(length / seed.length)).slice(0, length)
  const corpus = Array.from({ length: 8 }, (_, i) => text.slice(0, -1) + String(i))
  const call = (api, i) => {
    if (workload === 'callbackFrame') return api.frame([corpus[i % 8]], { width: 80, border: value => '\x1b[32m' + value + '\x1b[0m' })
    const writes = []
    let columns = 80
    const screen = new api.Screen({ columns: () => columns, write: value => writes.push(value) })
    screen.setLive([corpus[i % 8]], { row: 0, column: 1 })
    screen.commit(['done'])
    columns = 60
    screen.markStale()
    screen.setLive([corpus[i % 8]], { row: 0, column: 1 })
    screen.setLive(['short'])
    screen.close()
    return writes
  }
  const timings = {}
  for (let pass = 0; pass < 3; pass++) {
    const names = Object.keys(modules), offset = (pass + rows.length) % names.length
    for (const name of [...names.slice(offset), ...names.slice(0, offset)]) {
      for (let i = 0; i < 8; i++) deepStrictEqual(call(modules[name], i), call(modules['original-auto'], i), `${name}/${kind}/${length}/${workload}`)
      ;(timings[name] ??= []).push(measure(i => call(modules[name], i)))
    }
  }
  rows.push({ kind, length, workload, timings })
}
for (const variant of ['baseline', 'candidate']) deepStrictEqual(hash(join(scratch, variant, 'renderer.node')), builds.variants[variant].addonSha256)
deepStrictEqual(rendererIdentity(), identity)
writeFileSync(join(scratch, 'host.json'), JSON.stringify({ identity, builds, trace, rows, checksum, procedure: 'Scratch module snapshots only. Original TS Screen/frame own state, callbacks and writes. Native leaf injection uses existing length/column thresholds. Eight varying inputs; three rotated passes; median of five >=5ms batch averages. Synthetic CPU workloads, not a real PTY/session or full model turn.' }, null, 2) + '\n')
console.log('Host reachability and 18 synthetic workload cases pass')
