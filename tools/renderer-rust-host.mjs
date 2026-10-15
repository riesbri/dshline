/** Differential host adapter. Native transforms only; Screen/document state stays here. */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMISSION, CaptureInputSchema, MarkdownTransitionInputSchema, MarkdownTransitionOutputSchema } from './renderer-schema.mjs'
import { rendererIdentity } from './renderer-identity.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const executable = 'dshline-renderer-cli' + (process.platform === 'win32' ? '.exe' : '')
const defaultBinary = join(root, 'crates/dshline-renderer/target/debug', executable)
const textResults = new Set(['stripAnsi', 'escapeControls', 'sanitizePasted', 'renderInline', 'truncateToWidth', 'tailToWidth', 'fitToWidth', 'sgr'])
const rowsResults = new Set(['chunkToWidth', 'wrapToWidth', 'hangingIndent', 'box', 'frame', 'renderMarkdown'])
const numberResults = new Set(['codePointWidth', 'displayWidth', 'boxHeight', 'frameHeight'])
class BackendError extends Error {
  constructor(code = 'BACKEND_FAILURE') { super(code); this.code = code }
}
const units = text => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))
function encode(input) {
  const value = { ...input }
  for (const key of ['text', 'mark', 'indent']) if (typeof value[key] === 'string') value[key] = units(value[key])
  if (value.content) value.content = value.content.map(row => typeof row === 'string' ? units(row) : row)
  if (value.options) {
    value.options = { ...value.options }
    for (const key of ['title', 'rightTitle', 'footer']) if (typeof value.options[key] === 'string') value.options[key] = units(value.options[key])
  }
  if (value.state) value.state = { fence: value.state.fence === null ? null : units(value.state.fence) }
  if (value.palette) value.palette = {
    id: units(value.palette.id), depth: value.palette.depth,
    roles: Object.entries(value.palette.roles).map(([role, params]) => [units(role), params]),
  }
  return value
}
function decodeText(value) {
  if (!Array.isArray(value) || value.length > ADMISSION.estimatedOutputUnits || value.some(unit => !Number.isInteger(unit) || unit < 0 || unit > 65535)) throw new BackendError()
  const chunks = []
  for (let offset = 0; offset < value.length; offset += 4096) chunks.push(String.fromCharCode(...value.slice(offset, offset + 4096)))
  return chunks.join('')
}
function decodeRows(value) {
  if (!Array.isArray(value)) throw new BackendError()
  const total = value.reduce((sum, row) => sum + (Array.isArray(row) ? row.length : ADMISSION.estimatedOutputUnits + 1), 0)
  if (total > ADMISSION.estimatedOutputUnits) throw new BackendError('RESOURCE_LIMIT')
  return value.map(decodeText)
}
function decode(op, value) {
  if (textResults.has(op)) return decodeText(value)
  if (rowsResults.has(op)) return decodeRows(value)
  if (numberResults.has(op)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > ADMISSION.estimatedOutputUnits) throw new BackendError()
    return value
  }
  if (op === 'markdownTransition') {
    if (!value || !value.state) throw new BackendError()
    return MarkdownTransitionOutputSchema.parse({ state: { fence: value.state.fence === null ? null : decodeText(value.state.fence) }, rows: decodeRows(value.rows) })
  }
  throw new BackendError('INVALID_INPUT')
}

/** Use unchanged, freshly verified TS Screen with native wrapping injected as its only dependency. */
async function nativeScreen(native) {
  const identity = rendererIdentity()
  const source = await readFile(join(root, 'packages/renderer/lib/screen.js'), 'utf8')
  if (!source.includes("import { wrapToWidth } from './width.js';") || [...source.matchAll(/^import /gmu)].length !== 1) throw new BackendError()
  const snapshot = await mkdtemp(join(tmpdir(), 'renderer-rust-screen-'))
  const bridge = '__dshlineParityWrap_' + randomUUID()
  globalThis[bridge] = (text, columns) => native({ op: 'wrapToWidth', text, columns })
  try {
    await writeFile(join(snapshot, 'package.json'), '{"type":"module"}')
    await writeFile(join(snapshot, 'screen.js'), source)
    await writeFile(join(snapshot, 'width.js'), `export const wrapToWidth = globalThis[${JSON.stringify(bridge)}];\n`)
    if (JSON.stringify(rendererIdentity()) !== JSON.stringify(identity)) throw new BackendError()
    return (await import(pathToFileURL(join(snapshot, 'screen.js')).href)).Screen
  } finally {
    delete globalThis[bridge]
    await rm(snapshot, { recursive: true, force: true })
  }
}

export async function runRustHost(value, binary = defaultBinary, executeTransport) {
  const source = CaptureInputSchema.parse(value)
  const palette = source.palette ?? { id: 'markdown', depth: 4, roles: Object.fromEntries(Object.entries((await import('../packages/renderer/lib/theme.js')).MARKDOWN_ROLES).map(([role, color]) => [role, color.ansi])) }
  let nativeCalls = 0
  const native = input => {
    nativeCalls++
    const request = encode({ ...input, palette })
    let stdout
    if (executeTransport) stdout = executeTransport(JSON.stringify(request))
    else {
      const result = spawnSync(binary, [], { input: JSON.stringify(request), encoding: 'utf8', timeout: 10_000, maxBuffer: 1_048_576, shell: false })
      if (result.error || result.status !== 0) throw new BackendError()
      stdout = result.stdout
    }
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 1_048_576) throw new BackendError('RESOURCE_LIMIT')
    let envelope
    try { envelope = JSON.parse(stdout) } catch { throw new BackendError() }
    if (envelope?.ok !== true) throw new BackendError(['INVALID_INPUT', 'RESOURCE_LIMIT', 'BACKEND_FAILURE'].includes(envelope?.error?.code) ? envelope.error.code : 'BACKEND_FAILURE')
    return decode(input.op, envelope.value)
  }
  const cases = []
  for (const item of source.cases) {
    const input = item.input
    let output
    if (input.op === 'markdownSequence') {
      let state = { fence: null }
      output = input.calls.map(call => {
        const transition = MarkdownTransitionInputSchema.parse({ state, palette, text: call.text, mode: call.method, startsLine: call.startsLine ?? true })
        const result = native({ op: 'markdownTransition', ...transition })
        if (call.method === 'partial' && result.state.fence !== state.fence) throw new BackendError()
        state = result.state
        return call.method === 'partial' ? result.rows.join('') : result.rows
      })
    } else if (input.op === 'screenSequence') {
      const Screen = await nativeScreen(native)
      let columns = input.columns
      let writes = []
      const screen = new Screen({ columns: () => columns, write: chunk => writes.push(chunk) })
      output = input.calls.map(call => {
        writes = []
        if (call.method === 'resize') columns = call.columns
        else if (call.method === 'setLive') screen.setLive(call.lines, call.cursor)
        else if (call.method === 'commit') screen.commit(call.lines)
        else screen[call.method]()
        return { writes, height: screen.height }
      })
    } else output = native(input)
    cases.push({ id: item.id, output })
  }
  return { ok: true, value: { cases }, execution: { nativeCalls } }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--binary')) throw new BackendError('INVALID_INPUT')
    const chunks = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 1_048_576) throw new BackendError('RESOURCE_LIMIT')
      chunks.push(chunk)
    }
    let input
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw new BackendError('INVALID_INPUT') }
    process.stdout.write(JSON.stringify(await runRustHost(input, args.length ? resolve(args[1]) : defaultBinary)) + '\n')
  } catch (error) {
    const resource = error?.issues?.some(issue => issue.code === 'too_big' || issue.message.includes('RESOURCE_LIMIT'))
    const code = error instanceof BackendError ? error.code : error?.issues ? (resource ? 'RESOURCE_LIMIT' : 'INVALID_INPUT') : 'BACKEND_FAILURE'
    process.stdout.write(JSON.stringify({ ok: false, error: { code, fallbackEligible: false } }) + '\n')
  }
}
