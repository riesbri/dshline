import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as api from '../packages/renderer/lib/index.js'
import * as referenceWidth from '../packages/renderer/lib/width.js'
import * as referenceText from '../packages/renderer/lib/text.js'
import { createMarkdownRenderer as referenceMarkdown } from '../packages/renderer/lib/markdown.js'
import { Config } from '../packages/dshline/lib/index.js'
import { fixtures, inputOf } from './renderer-parity.mjs'
import { runNapiHost } from './renderer-napi-host.mjs'
import { loadVerifiedRenderer } from './renderer-identity.mjs'
const { renderer: referenceBox } = await loadVerifiedRenderer(undefined, { referenceOnly: true })
const referenceFrame = referenceBox.frame
const root = fileURLToPath(new URL('../', import.meta.url))
const addonName = `${process.platform}-${process.arch}.node`
const addonPath = join(root, 'packages/renderer/native', addonName)
const available = existsSync(addonPath)
if (process.env.DSHLINE_REQUIRE_NATIVE === '1' && !available) throw new Error('Required native addon is missing')

/** Exercise real loading in a private package copy, never mutate the working addon. */
function isolated(script, nativeBytes) {
  const scratch = mkdtempSync(join(tmpdir(), 'renderer-selection-test-'))
  try {
    // A fault audit supplies a disposable compiled graph; the verified root stays intact.
    cpSync(process.env.DSHLINE_TEST_RENDERER_LIB ?? join(root, 'packages/renderer/lib'), join(scratch, 'lib'), { recursive: true })
    writeFileSync(join(scratch, 'package.json'), '{"type":"module"}')
    if (nativeBytes) {
      mkdirSync(join(scratch, 'native'))
      writeFileSync(join(scratch, 'native', addonName), nativeBytes)
    }
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: scratch, encoding: 'utf8' }))
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
describe('renderer Phase 4 selection and native boundary', () => {
  it('recovers admitted panic/backend failures once in auto with exact TS outputs, but not forced rust', () => {
    expect(isolated(`
      import Module from 'node:module'
      import {deepStrictEqual,equal,throws} from 'node:assert/strict'
      const ops=['displayWidth','tailToWidth','fitToWidth','chunkToWidth','wrapToWidth']
      let kind,calls={}
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true})
      Module._extensions['.node']=m=>{m.exports={unicodeVersion:()=> '17.0',execute(){throw Error('no composite')},...Object.fromEntries(ops.map(op=>[op,()=>{
        calls[op]=(calls[op]??0)+1
        if(kind==='malformed')return undefined
        if(kind==='typed')throw Object.assign(Error('native failed'),{code:'BACKEND_FAILURE'})
        throw Error(kind==='panic'?'simulated caught panic':'BACKEND_FAILURE')
      }]))}}
      const m=await import('./lib/index.js'),source=('\\x1b[31m中😀\\ud800e\\u0301\\x1b[0m').repeat(40)
      const expected=Object.fromEntries(ops.map(op=>[op,m[op](source,80)]))
      deepStrictEqual(calls,{})
      m.setRendererBackend('auto')
      for(kind of ['panic','backend','typed','malformed'])for(const op of ops){
        calls={};deepStrictEqual(m[op](source,80),expected[op]);deepStrictEqual(calls,{[op]:1});equal(m.rendererBackend(),'auto')
        const restore=m.setRendererBackend('rust');calls={}
        throws(()=>m[op](source,80),e=>e.code==='BACKEND_FAILURE'&&e.fallbackEligible===false)
        deepStrictEqual(calls,{[op]:1});restore()
      }
      process.stdout.write(JSON.stringify({auto:20,forced:20,exact:true}))
    `, 'fixture')).toEqual({ auto: 20, forced: 20, exact: true })
  })
  it('runs a recovery oracle only once under TS and restores auto even when that oracle throws', () => {
    expect(isolated(`
      import Module from 'node:module'
      import {deepStrictEqual,equal,throws} from 'node:assert/strict'
      let nativeCalls=0,referenceCalls=0,referenceThrows=false
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true})
      Module._extensions['.node']=m=>{m.exports={unicodeVersion:()=> '17.0',execute(){throw Error('no composite')},displayWidth(){nativeCalls++;throw Error('BACKEND_FAILURE')},fitToWidth(){nativeCalls++;throw Error('BACKEND_FAILURE')}}}
      const m=await import('./lib/index.js'),p=await import('./lib/native-primitives.js'),source='中'.repeat(512),sentinel=Error('TS oracle failed')
      const reference=()=>{referenceCalls++;equal(m.rendererBackend(),'typescript');if(referenceThrows)throw sentinel;return m.displayWidth(source)}
      const unary=p.unary('displayWidth',reference),cut=p.cut('fitToWidth',reference)
      m.setRendererBackend('auto')
      for(const fn of [()=>unary(source),()=>cut(source,80)]){
        nativeCalls=referenceCalls=0;referenceThrows=false;equal(fn(),1024);deepStrictEqual([nativeCalls,referenceCalls],[1,1]);equal(m.rendererBackend(),'auto')
        nativeCalls=referenceCalls=0;referenceThrows=true;throws(fn,e=>e===sentinel);deepStrictEqual([nativeCalls,referenceCalls],[1,1]);equal(m.rendererBackend(),'auto')
      }
      process.stdout.write(JSON.stringify({singleAttempt:true,restored:true}))
    `, 'fixture')).toEqual({ singleAttempt: true, restored: true })
  })
  it('never retries terminal native codes from messages or typed errors in auto or forced rust', () => {
    expect(isolated(`
      import Module from 'node:module'
      import {deepStrictEqual,throws} from 'node:assert/strict'
      const ops=['displayWidth','tailToWidth','fitToWidth','chunkToWidth','wrapToWidth']
      let code,form,calls={}
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true})
      Module._extensions['.node']=m=>{m.exports={unicodeVersion:()=> '17.0',execute(){throw Error('no composite')},...Object.fromEntries(ops.map(op=>[op,()=>{
        calls[op]=(calls[op]??0)+1
        if(form==='string')throw code
        throw form==='message'?Object.assign(Error(code),{code:'GenericFailure'}):Object.assign(Error('caller rejected'),{code})
      }]))}}
      const m=await import('./lib/index.js'),source='中'.repeat(512)
      for(const mode of ['auto','rust']){
        m.setRendererBackend(mode)
        for(code of ['RESOURCE_LIMIT','INVALID_INPUT'])for(form of ['message','code','string'])for(const op of ops){
          calls={};throws(()=>m[op](source,80),e=>e.code===code&&e.fallbackEligible===false);deepStrictEqual(calls,{[op]:1})
        }
      }
      process.stdout.write(JSON.stringify({terminal:60}))
    `, 'fixture')).toEqual({ terminal: 60 })
  })
  it.runIf(available)('fits long measured prefixes and zero-budget zero-width sources against independent TS', () => {
    const native = createRequire(import.meta.url)(addonPath)
    for (const source of ['', '\x1b[31m', '\0\t', 'a'.repeat(2048), '中'.repeat(2048), '\x1b[31mhello中\x1b[0m '.repeat(80), '\ud800'.repeat(512)]) {
      for (const columns of [-256, -1, 0, 1, 8, 40, 120, 256]) expect(native.fitToWidth(source, columns)).toBe(referenceBox.fitToWidth(source, columns))
    }
  })
  it('accepts explicit composition-time backend choices and defaults to TypeScript', () => {
    expect(Config({}).renderer).toBe('typescript')
    for (const renderer of ['auto', 'rust', 'typescript']) expect(Config({ renderer }).renderer).toBe(renderer)
    expect(() => Config({ renderer: 'unknown' })).toThrow()
  })
  it('loads without an addon, falls back in auto and refuses forced Rust', () => {
    expect(isolated(`
      const m = await import('./lib/index.js')
      const width = m.displayWidth('中文')
      let code; try { m.setRendererBackend('rust') } catch(e) { code = e.code }
      const restore = m.setRendererBackend('typescript'); restore(); restore()
      process.stdout.write(JSON.stringify({width,code,selection:m.rendererBackend()}))
    `)).toEqual({ width: 4, code: 'BACKEND_FAILURE', selection: 'typescript' })
  })
  it('treats a corrupt optional artifact as unavailable without changing TS output', () => {
    expect(isolated(`const m=await import('./lib/index.js');process.stdout.write(JSON.stringify(m.displayWidth('😀')))`, 'not an addon')).toBe(2)
  })
  it('does not retry native resource errors through TypeScript', () => {
    expect(isolated(`
      import Module from 'node:module'
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true});Module._extensions['.node'] = m => { m.exports={unicodeVersion:()=> '17.0',execute:()=>{throw Error('unexpected JSON')},displayWidth:()=>{throw Error('RESOURCE_LIMIT')}} }
      const m=await import('./lib/index.js')
      m.setRendererBackend('auto');let code;try{m.displayWidth('中'.repeat(96))}catch(e){code=e.code}
      m.setRendererBackend('typescript')
      process.stdout.write(JSON.stringify({code,width:m.displayWidth('A')}))
    `, 'fixture')).toEqual({ code: 'RESOURCE_LIMIT', width: 1 })
  })
  it('preselects TS for an optional addon missing a direct method', () => {
    expect(isolated(`
      import Module from 'node:module'
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true});Module._extensions['.node']=m=>{m.exports={unicodeVersion:()=> '17.0',execute:()=>{throw Error('not called')}}}
      const m=await import('./lib/index.js');const width=m.displayWidth('x'.repeat(96))
      m.setRendererBackend('rust');let code;try{m.displayWidth('x'.repeat(96))}catch(e){code=e.code}
      process.stdout.write(JSON.stringify({width,code}))
    `, 'fixture')).toEqual({width:96,code:'BACKEND_FAILURE'})
  })
  it('normalizes malformed native response envelopes to a typed failure', () => {
    expect(isolated(`
      import Module from 'node:module'
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true});Module._extensions['.node']=m=>{m.exports={unicodeVersion:()=> '17.0',execute:()=> 'null'}}
      const m=await import('./lib/index.js');m.setRendererBackend('rust')
      let code;try{m.sgr('x',[31])}catch(e){code=e.code}
      process.stdout.write(JSON.stringify(code))
    `, 'fixture')).toBe('BACKEND_FAILURE')
  })
  it('guards native markdown on a host with different Unicode properties', () => {
    expect(isolated(`
      import Module from 'node:module'
      let calls=0
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true});Module._extensions['.node'] = m => { m.exports={unicodeVersion:()=> '17.0',execute:()=>{calls++;throw Error('must not execute')}} }
      Object.defineProperty(process.versions,'unicode',{value:'16.0'})
      const m=await import('./lib/index.js')
      const prose=m.renderInline('**x**')
      m.setRendererBackend('rust')
      const forced=m.renderInline('**x**')
      process.stdout.write(JSON.stringify({styled:prose.includes('\\u001b[1m'),same:forced===prose,calls}))
    `, 'fixture')).toEqual({ styled: true, same: true, calls: 0 })
  })
  it.runIf(available)('matches every golden through the actual addon, including native-backed TS hosts', async () => {
    for (const fixture of await fixtures()) {
      const result = await runNapiHost(inputOf(fixture))
      expect(result.execution.nativeCalls, fixture.cases[0].id).toBeGreaterThan(0)
      expect(result.value.cases, fixture.cases[0].id).toEqual(fixture.cases.map(({ id, output }) => ({ id, output })))
    }
  })
  it.runIf(available && process.versions.unicode === '17.0')('preserves public UTF-16, palette and streaming state through forced Rust', () => {
    const restore = api.setRendererBackend('rust')
    try {
      expect(api.displayWidth('\ud800')).toBe(1)
      expect(api.wrapToWidth('中文😀\ud800', 4)).toEqual(['中文', '😀\ud800'])
      const markdown = api.createMarkdownRenderer()
      const reference = referenceMarkdown()
      for (const [method, text, startsLine] of [['partial', '```js'], ['line', '````'], ['line', '```'], ['partial', '**literal**', false], ['line', '````'], ['line', '**bold**']]) {
        expect(markdown[method](text, startsLine)).toEqual(reference[method](text, startsLine))
      }
      const release = api.setPalette({ id: '\ud800', name: 'fixture', description: '', depth: 4, roles: { strong: { ansi: [35] }, '\udfff': { ansi: [31] } } }, 4)
      try { expect(api.renderInline('**x**')).toBe('\u001b[35mx\u001b[0m') } finally { release() }
    } finally { restore() }
  })
  it.runIf(available)('preselects TS for unsupported public inputs and retains streaming fallback state', () => {
    const restore = api.setRendererBackend('auto')
    try {
      expect(api.codePointWidth(-1)).toBe(0)
      const long = 'x'.repeat(4096)
      expect(api.escapeControls(long)).toBe(long)
      const markdown = api.createMarkdownRenderer()
      markdown.line('```')
      expect(markdown.line(long)[0]).toContain(long)
      expect(markdown.line('**literal**')[0]).toContain('**literal**')
      markdown.line('```')
      expect(markdown.line('**bold**')).toEqual(['\u001b[1mbold\u001b[0m'])
      const options = { width: 12, border: text => '!' + text }
      expect(api.frame(['x'], options)).toEqual(referenceFrame(['x'], options))
    } finally { restore() }
  })
  it.runIf(available)('preserves TS host object and sparse-array behavior in auto without traversing ignored fields', () => {
    const restore = api.setRendererBackend('auto')
    try {
      for (const code of [undefined, null, true, [], {}, NaN, Infinity, -1, 1.5]) expect(api.codePointWidth(code)).toBe(referenceWidth.codePointWidth(code))
      for (const op of ['chunkToWidth', 'wrapToWidth']) {
        let reads = 0
        const columns = { valueOf() { return ++reads === 1 ? 1 : 64 } }
        expect(api[op]('abcd', columns)).toEqual(['a', 'b', 'c', 'd'])
        expect(reads).toBe(1)
      }
      const sparse = new Array(2)
      expect(api.sgr('x', new Array(1))).toBe(referenceText.sgr('x', new Array(1)))
      expect(api.box(sparse, { width: 8 })).toEqual(referenceBox.box(sparse, { width: 8 }))
      const cycle = {}; cycle.self = cycle
      const options = { width: 8, extra: cycle, get ignored() { throw Error('must remain unread') } }
      expect(api.frame(['x'], options)).toEqual(referenceFrame(['x'], options))
      let reads = 0
      const heightOptions = { get width() { reads++; return 12 } }
      api.frameHeight(['x'], heightOptions)
      expect(reads).toBe(1)
    } finally { restore() }
  })
  it.runIf(available)('matches direct UTF-16 methods, including empty input, sentinels, malformed ANSI and surrogate boundaries', () => {
    const native = createRequire(import.meta.url)(addonPath)
    const reference = { ...referenceWidth, ...referenceText, ...referenceBox }
    const restore = api.setRendererBackend('rust')
    let seed = 0x71c3
    const atom = ['a', '中', '😀', '\ud800', '\udfff', '\0', '\t', '\n', '\u001b[31m', '\u001b[0m', '\u001b]bad', ' ', 'e\u0301']
    const samples = ['', 'x', 'x\0', '\0', '\ud800', '\ud800\0', '\u001b]bad\0', 'a'.repeat(2048)]
    for (let i = 0; i < 150; i++) {
      let source = ''
      for (let j = 0; j < 24; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; source += atom[seed % atom.length] }
      samples.push(source)
    }
    try {
      for (const source of samples) for (const op of ['displayWidth', 'stripAnsi', 'escapeControls', 'sanitizePasted', 'truncateToWidth', 'tailToWidth', 'fitToWidth', 'chunkToWidth', 'wrapToWidth']) {
        const budgets = ['displayWidth', 'stripAnsi', 'escapeControls', 'sanitizePasted'].includes(op) ? [undefined] : [-1, 0, 1, 7, 40, 256]
        for (const budget of budgets) {
          const expected = reference[op](source, budget)
          expect(native[op](source, budget), op).toEqual(expected)
          expect(api[op](source, budget), op).toEqual(expected)
        }
      }
    } finally { restore() }
  })
  it.runIf(available)('routes only measured direct operations to native in auto', () => {
    expect(isolated(`
      import Module from 'node:module'
      const calls=[]
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true});Module._extensions['.node']=m=>{m.exports={unicodeVersion:()=> '17.0',execute:()=>{throw Error('JSON must stay out of auto')},displayWidth:s=>{calls.push('width');return s.length},wrapToWidth:s=>{calls.push('wrap');return [s]}}}
      const m=await import('./lib/index.js')
      m.setRendererBackend('auto');m.codePointWidth(65);m.displayWidth('x');m.displayWidth('中'.repeat(96));m.wrapToWidth('中'.repeat(96),120)
      m.renderInline('**x**');m.escapeControls('x'.repeat(200));m.truncateToWidth('x'.repeat(200),10)
      process.stdout.write(JSON.stringify(calls))
    `, 'fixture')).toEqual(['width', 'wrap'])
  })
  it.runIf(available && process.versions.unicode === '17.0')('rebuilds fallback fence state without replaying native committed lines', () => {
    const restore = api.setRendererBackend('rust')
    try {
      const stream = api.createMarkdownRenderer()
      stream.line('````')
      const auto = api.setRendererBackend('auto')
      try {
        expect(stream.partial('**literal**')).toContain('**literal**')
        expect(stream.line('```')).toContainEqual(expect.stringContaining('```'))
        expect(stream.line('````')).toEqual([])
        expect(stream.line('**bold**')).toEqual(['\u001b[1mbold\u001b[0m'])
      } finally { auto() }
      const params = [35]
      const release = api.setPalette({ id: 'mutable', name: '', description: '', depth: 4, roles: { strong: { ansi: params } } }, 4)
      try {
        expect(api.renderInline('**x**')).toBe('\u001b[35mx\u001b[0m')
        params[0] = 31
        expect(api.renderInline('**x**')).toBe('\u001b[31mx\u001b[0m')
      } finally { release() }
    } finally { restore() }
  })
  it.runIf(available)('runs shipped callback frames and full-theme streaming through actual compiled package resolution', () => {
    const output = execFileSync(process.execPath, ['tools/renderer-forced-smoke.mjs'], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    expect(JSON.parse(output)).toEqual({ palettes: 5, frames: 20, streamingLines: 120, compiledPackageResolution: true })
  })
  it('still propagates admitted JSON errors in required-Rust mode without a TS retry', () => {
    expect(isolated(`
      import Module from 'node:module'
      Object.defineProperty(process.versions,'unicode',{value:'17.0',configurable:true});Module._extensions['.node']=m=>{m.exports={unicodeVersion:()=> '17.0',execute:()=>JSON.stringify({ok:false,error:{code:'RESOURCE_LIMIT'}})}}
      const m=await import('./lib/index.js');m.setRendererBackend('rust')
      let code;try{m.sgr('x',[31])}catch(e){code=e.code}
      process.stdout.write(JSON.stringify(code))
    `, 'fixture')).toBe('RESOURCE_LIMIT')
  })
  it.runIf(available)('validates raw native input before allocation and rejects malformed payloads', () => {
    const addon = createRequire(import.meta.url)(addonPath)
    for (const request of ['{', '{"op":"wrapToWidth","text":[],"columns":-9223372036854775808}']) expect(JSON.parse(addon.execute(request)).ok).toBe(false)
    expect(JSON.parse(addon.execute(' '.repeat(1_048_577)))).toEqual({ ok: false, error: { code: 'RESOURCE_LIMIT', fallbackEligible: false } })
    expect(JSON.parse(addon.execute(JSON.stringify({ op: 'displayWidth', text: [0xd800] })))).toEqual({ ok: true, value: 1 })
    expect(addon.displayWidth('\ud800😀中')).toBe(5)
    for (const code of [-1, 1.5, NaN, Infinity, 0x110000]) expect(() => addon.codePointWidth(code)).toThrow('INVALID_INPUT')
    expect(addon.codePointWidth(0xd800)).toBe(1)
    expect(() => addon.displayWidth('x'.repeat(2049))).toThrow('RESOURCE_LIMIT')
  })
})
