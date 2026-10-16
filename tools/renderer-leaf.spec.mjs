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
  it('keeps the runtime import graph acyclic and the reference width policy isolated', () => {
    const directory = join(root, 'packages/renderer/lib')
    const graph = new Map(readdirSync(directory).filter(name => name.endsWith('.js')).map(name => [name, [...readFileSync(join(directory, name), 'utf8').matchAll(/(?:from\s*|import\s*)['"]\.\/([^'"]+)['"]/gu)].map(match => match[1])]))
    const visit = (name, stack = []) => {
      expect(stack, `Runtime import cycle ${[...stack, name].join(' -> ')}`).not.toContain(name)
      for (const next of graph.get(name) ?? []) visit(next, [...stack, name])
    }
    for (const name of ['native-primitives.js', 'screen.js', 'box.js', 'backend.js']) visit(name)
    expect(graph.get('width.js')).toEqual(['width-tables.js'])
    expect(graph.get('native-primitives.js')).toEqual(['width.js'])
  })
  it('routes Screen and callback frames through the same mode-aware leaves without native error retry', () => {
    expect(isolated(`
      import Module from 'node:module'
      let calls=0
      Module._extensions['.node']=m=>{m.exports={execute(){throw Error('no composite')},wrapToWidth(){calls++;throw Error('RESOURCE_LIMIT')}}}
      const m=await import('./lib/index.js'), source='x'.repeat(96)
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
      Module._extensions['.node']=m=>{m.exports={execute(){throw Error('no composite')},wrapToWidth(){calls++;throw Error('must not call')}}}
      const m=await import('./lib/index.js')
      const screen=(source,columns)=>new m.Screen({columns:()=>columns,write(){}}).setLive([source])
      screen('small',80);screen('x'.repeat(2049),80);screen('x'.repeat(96),20)
      let reads=0
      m.frame(['tiny'],{get width(){reads++;return 80},border:s=>s})
      process.stdout.write(JSON.stringify({calls,reads}))
    `)).toEqual({ calls: 0, reads: 1 })
  })
  it.runIf(available)('matches exact writes, callback observation and emulator cells in auto/rust/TS', async () => {
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
