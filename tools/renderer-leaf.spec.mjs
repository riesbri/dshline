import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadVerifiedRenderer } from './renderer-identity.mjs'
import { createEmulator } from '../tests/emulator.ts'
import * as api from '../packages/renderer/lib/index.js'
const root = fileURLToPath(new URL('../', import.meta.url))
const addonName = `${process.platform}-${process.arch}.node`
const addonFile = join(root, 'packages/renderer/native', addonName)
const available = existsSync(addonFile)
if (process.env.DSHLINE_REQUIRE_NATIVE === '1' && !available) throw Error('Required native addon is missing')
function isolated(script) {
  const scratch = mkdtempSync(join(tmpdir(), 'renderer-leaf-test-'))
  try {
    cpSync(join(root, 'packages/renderer/lib'), join(scratch, 'lib'), { recursive: true })
    mkdirSync(join(scratch, 'native'))
    writeFileSync(join(scratch, 'native', addonName), 'test addon')
    writeFileSync(join(scratch, 'package.json'), '{"type":"module"}')
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: scratch, encoding: 'utf8' }))
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
describe('cycle-free native host leaves', () => {
  it.runIf(available)('uses actual Rust only when runtime, TS policy and compiled lookup Unicode versions all match', () => {
    for (const runtime of ['17.0', '16.0', undefined]) for (const compiled of ['actual', '16.0', 'missing']) {
      const result = isolated(`
        import Module, {createRequire} from 'node:module'
        import {deepStrictEqual} from 'node:assert'
        const native=createRequire(import.meta.url)(${JSON.stringify(addonFile)}),calls={}
        const wrapped=Object.fromEntries(Object.entries(native).map(([op,fn])=>[op,op==='unicodeVersion'?fn:(...args)=>{calls[op]=(calls[op]??0)+1;return fn(...args)}]))
        if(${JSON.stringify(compiled)}==='16.0')wrapped.unicodeVersion=()=> '16.0'
        if(${JSON.stringify(compiled)}==='missing')delete wrapped.unicodeVersion
        Object.defineProperty(process.versions,'unicode',{value:${JSON.stringify(runtime)},configurable:true})
        Module._extensions['.node']=m=>{m.exports=wrapped}
        const m=await import('./lib/index.js'),text='中文终端'.repeat(128)
        const recipe=()=>[m.displayWidth(text),m.tailToWidth(text,80),m.fitToWidth(text,80),m.wrapToWidth(text,80),m.chunkToWidth(text,80),m.codePointWidth(0x4e2d),m.frame(['中文'],{width:12}),m.renderInline('**中文**')]
        const expected=recipe()
        m.setRendererBackend('auto');deepStrictEqual(recipe(),expected)
        m.setRendererBackend('rust');deepStrictEqual(recipe(),expected)
        process.stdout.write(JSON.stringify(calls))
      `)
      if (runtime === '17.0' && compiled === 'actual') {
        for (const op of ['displayWidth', 'tailToWidth', 'fitToWidth', 'wrapToWidth', 'chunkToWidth', 'codePointWidth', 'execute']) expect(result[op], op).toBeGreaterThan(0)
      } else expect(result, `${runtime}/${compiled}`).toEqual({})
    }
  })
  it('defaults to TS even with an available addon, and gates every recorded ASCII regression in auto', () => {
    const seeds = { ascii: 'The quick brown fox jumps over the lazy dog. ', ansi: '\x1b[32mHello styled world\x1b[0m ', narrow: 'The quick brown fox jumps over the lazy dog. ' }
    const cases = []
    for (const platform of ['darwin-arm64', 'darwin-x64']) {
      const evidence = JSON.parse(readFileSync(join(root, `benchmarks/renderer-leaf-${platform}.json`)))
      const median = samples => samples.map(s => s.medianNs).sort((a, b) => a - b)[1]
      for (const row of evidence.rows) {
        if (median(row.timings.auto) <= median(row.timings.baselineAuto) * 1.1 || !['ascii', 'ansi', 'narrow', 'lateCjk'].includes(row.kind)) continue
        const text = row.kind === 'lateCjk' ? 'a'.repeat(row.length - 2) + '中x' : seeds[row.kind].repeat(Math.ceil(row.length / seeds[row.kind].length)).slice(0, row.length)
        cases.push({ ...row, text: text.slice(0, -1) + '0' })
      }
    }
    // Anchor coverage independently of the benchmark generator/guard itself.
    expect(cases.length).toBe(29)
    expect(isolated(`
      import Module from 'node:module'
      let calls=0
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true});Module._extensions['.node']=m=>{m.exports={unicodeVersion:()=> '17.0',execute(){throw Error('no composite')},...Object.fromEntries(['displayWidth','tailToWidth','fitToWidth','wrapToWidth','chunkToWidth'].map(op=>[op,()=>{calls++;throw Error('must stay TS')}]))}}
      const m=await import('./lib/index.js'), initial=m.rendererBackend()
      m.displayWidth('中'.repeat(512))
      m.setRendererBackend('auto')
      for(const row of ${JSON.stringify(cases.map(({ op, text, columns }) => ({ op, text, columns })))})m[row.op](row.text,row.columns)
      process.stdout.write(JSON.stringify({initial,calls}))
    `)).toEqual({ initial: 'typescript', calls: 0 })
  })
  it('gives sliced malformed UTF-16 the same width as identical flat code units in a real Node process', () => {
    expect(isolated(`
      const width=await import('./lib/width.js')
      const {soakCases}=await import(${JSON.stringify(new URL('./renderer-soak-corpus.mjs', import.meta.url).href)})
      const mismatches=[]
      let checked=0
      for(const {text,seed} of soakCases(0)){
        const flat=String.fromCharCode(...Array.from({length:text.length},(_,i)=>text.charCodeAt(i)))
        if(width.displayWidth(text)!==width.displayWidth(flat))mismatches.push(seed)
        checked++
      }
      process.stdout.write(JSON.stringify({checked,mismatches}))
    `)).toEqual({ checked: 136, mismatches: [] })
  })
  it('keeps the runtime import graph acyclic and the reference width policy isolated', () => {
    const directory = join(root, 'packages/renderer/lib')
    const graph = new Map(readdirSync(directory).filter(name => name.endsWith('.js')).map(name => [name, [...readFileSync(join(directory, name), 'utf8').matchAll(/(?:from\s*|import\s*)['"]\.\/([^'"]+)['"]/gu)].map(match => match[1])]))
    const visit = (name, stack = []) => {
      expect(stack, `Runtime import cycle ${[...stack, name].join(' -> ')}`).not.toContain(name)
      for (const next of graph.get(name) ?? []) visit(next, [...stack, name])
    }
    for (const name of ['native-primitives.js', 'screen.js', 'box.js', 'backend.js']) visit(name)
    expect(graph.get('width.js')).toEqual(['width-tables.js'])
    expect(graph.get('native-primitives.js')).toEqual(['width.js', 'width-tables.js'])
  })
  it('routes Screen and callback frames through the same mode-aware leaves without native error retry', () => {
    expect(isolated(`
      import Module from 'node:module'
      let calls=0
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true});Module._extensions['.node']=m=>{m.exports={unicodeVersion:()=> '17.0',execute(){throw Error('no composite')},wrapToWidth(){calls++;throw Error('RESOURCE_LIMIT')}}}
      const m=await import('./lib/index.js');m.setRendererBackend('auto');const source='中'.repeat(96)
      const run=fn=>{try{fn();return 'ok'}catch(e){return e.code}}
      const screen=new m.Screen({columns:()=>80,write(){}})
      const auto=[run(()=>screen.setLive([source])),run(()=>m.frame([source],{width:80,border:s=>s}))]
      m.setRendererBackend('typescript')
      const ts=run(()=>screen.setLive([source]))
      process.stdout.write(JSON.stringify({auto,ts,calls}))
    `)).toEqual({ auto: ['RESOURCE_LIMIT', 'RESOURCE_LIMIT'], ts: 'ok', calls: 2 })
  })
  it('preselects TS for tiny, oversized and narrow host inputs before native execution', () => {
    expect(isolated(`
      import Module from 'node:module'
      let calls=0
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true});Module._extensions['.node']=m=>{m.exports={unicodeVersion:()=> '17.0',execute(){throw Error('no composite')},wrapToWidth(){calls++;throw Error('must not call')}}}
      const m=await import('./lib/index.js');m.setRendererBackend('auto')
      const screen=(source,columns)=>new m.Screen({columns:()=>columns,write(){}}).setLive([source])
      screen('small',80);screen('x'.repeat(2049),80);screen('x'.repeat(96),20)
      let reads=0
      m.frame(['tiny'],{get width(){reads++;return 80},border:s=>s})
      process.stdout.write(JSON.stringify({calls,reads}))
    `)).toEqual({ calls: 0, reads: 1 })
  })
  it.runIf(available && process.versions.unicode === '17.0')('matches exact writes, callback observation and emulator cells in auto/rust/TS', async () => {
    const { renderer: reference } = await loadVerifiedRenderer(undefined, { referenceOnly: true })
    const native = createRequire(import.meta.url)(addonFile)
    const original = native.wrapToWidth
    let calls = 0
    native.wrapToWidth = (...args) => { calls++; return original(...args) }
    async function recipe(target) {
      const terminal = createEmulator(80, 16), writes = [], observed = []
      const source = '\x1b[32mHello 中文 é world\x1b[0m '.repeat(6)
      const screen = new target.Screen({ columns: terminal.target.columns, write: value => { writes.push(value); terminal.target.write(value) } })
      try {
        const options = { get width() { observed.push('width'); return 80 }, border: value => { observed.push(value); return '\x1b[35m' + value + '\x1b[0m' } }
        const frame = target.frame([source], options)
        screen.commit(['before'])
        screen.setLive(frame, { row: 1, column: 3 })
        screen.setLive(frame, { row: 1, column: 3 })
        screen.commit(['done'])
        await terminal.flush()
        terminal.resize(48, 16)
        screen.markStale()
        screen.setLive([source], { row: 0, column: 2 })
        screen.setLive(['short'])
        const cells = []
        for (let row = 0; row < 16; row++) for (let column = 0; column < 48; column++) cells.push(await terminal.cell(column, row))
        const result = { visible: await terminal.screen(), scrollback: await terminal.scrollback(), cursor: await terminal.cursor(), cells, observed }
        screen.close()
        return { ...result, writes }
      } finally { terminal.dispose() }
    }
    try {
      const expected = await recipe(reference)
      for (const mode of ['typescript', 'auto', 'rust']) {
        const restore = api.setRendererBackend(mode), before = calls
        try {
          expect(await recipe(api), mode).toEqual(expected)
          if (mode === 'typescript') expect(calls).toBe(before)
          else expect(calls, mode + ' host never reached native').toBeGreaterThan(before)
        } finally { restore() }
      }
    } finally { native.wrapToWidth = original }
  })
})
