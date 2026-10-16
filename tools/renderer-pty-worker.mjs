/** A deterministic streamed presentation turn in a real controlling terminal. */
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import * as renderer from '../packages/renderer/lib/index.js'
import { StreamBuffer } from '../packages/dshline/lib/stream.js'

if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdout.columns !== 80 || process.stdout.rows !== 24) throw Error('An actual 80x24 PTY is required')
const backend = process.argv[2]
if (!['typescript', 'auto'].includes(backend)) throw Error('Only TS or admitted Rust leaves may be measured')
const addon = createRequire(import.meta.url)(`../packages/renderer/native/${process.platform}-${process.arch}.node`)
let calls = {}
for (const [op, method] of Object.entries(addon)) if (typeof method === 'function' && op !== 'unicodeVersion') {
  addon[op] = (...args) => { calls[op] = (calls[op] ?? 0) + 1; return method(...args) }
}
renderer.setRendererBackend(backend)
process.stdin.setRawMode(true)
const input = createInterface({ input: process.stdin })
const marker = value => process.stdout.write('\x1b]777;DSHBENCH:' + Buffer.from(JSON.stringify(value)).toString('base64') + '\x07')
marker({ type: 'ready', backend, tty: true, columns: process.stdout.columns, rows: process.stdout.rows, unicode: process.versions.unicode, compiledUnicode: addon.unicodeVersion() })
for await (const line of input) {
  const request = JSON.parse(line)
  if (request.command === 'quit') break
  if (request.command !== 'turn' || !['ascii', 'cjk'].includes(request.kind) || ![2, 32].includes(request.lines)) throw Error('Invalid benchmark turn')
  const seed = request.kind === 'ascii' ? 'The quick brown fox jumps over the lazy dog. ' : '你好世界，终端渲染测试。'
  // Logical rows stay inside native admission; total turns are deliberately
  // much longer than a viewport. No model/network delay is injected.
  const source = Array.from({ length: request.lines }, (_, i) => seed.repeat(Math.ceil(2048 / seed.length)).slice(0, 2044) + String(i).padStart(3, '0') + '\n').join('')
  const stream = new StreamBuffer()
  const writes = []
  const screen = new renderer.Screen({ columns: () => process.stdout.columns, write: value => { writes.push(value); process.stdout.write(value) } })
  calls = {}
  const composer = renderer.frame(['ready for the next prompt'], { width: 80, border: s => s })
  screen.commit(['> benchmark ' + request.kind])
  let deltas = 0
  const start = performance.now()
  for (let offset = 0; offset < source.length; offset += 128) {
    screen.commit(stream.push('text', source.slice(offset, offset + 128), 80))
    screen.setLive([...stream.live(80), ...composer])
    deltas++
  }
  screen.commit(stream.settle([{ type: 'text', text: source }], 80))
  screen.setLive(composer)
  screen.close()
  const renderMs = performance.now() - start
  // The marker travels through the same slave/master queues after every write.
  // The controller measures completion only after its emulator drains those bytes.
  const rendered = writes.join('')
  marker({ type: 'done', id: request.id, kind: request.kind, inputUnits: source.length, inputBytes: Buffer.byteLength(source), inputSha256: createHash('sha256').update(source).digest('hex'), deltas, renderMs, calls, renderedBytes: Buffer.byteLength(rendered), renderedSha256: createHash('sha256').update(rendered).digest('hex') })
}
input.close()
process.stdin.setRawMode(false)
process.stdin.pause()
