/** Capture actual reference calls, not guessed expectations. No session discovery. */
import { open, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadVerifiedRenderer, rendererIdentity } from './renderer-identity.mjs'
import { CaptureInputSchema } from './renderer-schema.mjs'
const { identity: loadedIdentity, renderer } = await loadVerifiedRenderer(undefined, { referenceOnly: true })

export const syntheticInput = {
  version: 1,
  provenance: { kind: 'synthetic', description: 'Hand-authored presentation inputs; outputs observed from live TypeScript calls, not a user session.' },
  cases: [
    { id: 'unicode', input: { op: 'wrapToWidth', text: 'Latin 中文 e\u0301 😀 \ud800', columns: 8 } },
    { id: 'sgr-cut', input: { op: 'truncateToWidth', text: '\u001b[31m中文abc\u001b[0m', columns: 5 } },
    { id: 'markdown-stream', input: { op: 'markdownSequence', calls: [
      { method: 'partial', text: '```ts' }, { method: 'line', text: '```ts' },
      { method: 'partial', text: '**literal**' }, { method: 'line', text: '**literal**' },
      { method: 'line', text: '```' }, { method: 'partial', text: '_suffix_', startsLine: false },
    ] } },
    { id: 'screen', input: { op: 'screenSequence', columns: 12, calls: [
      { method: 'setLive', lines: ['live 中文'], cursor: { row: 0, column: 2 } },
      { method: 'setLive', lines: ['live 中文'], cursor: { row: 0, column: 2 } },
      { method: 'commit', lines: ['finished'] }, { method: 'resize', columns: 8 },
      { method: 'markStale' }, { method: 'setLive', lines: ['short'] }, { method: 'close' },
    ] } },
  ],
}

function evaluate(input) {
  const { op } = input
  if (op === 'markdownSequence') {
    const markdown = renderer.createMarkdownRenderer()
    return input.calls.map(call => call.method === 'line' ? markdown.line(call.text) : markdown.partial(call.text, call.startsLine))
  }
  if (op === 'screenSequence') {
    let columns = input.columns
    let writes = []
    const screen = new renderer.Screen({ columns: () => columns, write: chunk => writes.push(chunk) })
    return input.calls.map(call => {
      writes = []
      if (call.method === 'resize') columns = call.columns
      else if (call.method === 'setLive') screen.setLive(call.lines, call.cursor)
      else if (call.method === 'commit') screen.commit(call.lines)
      else screen[call.method]()
      return { writes, height: screen.height }
    })
  }
  if (op === 'codePointWidth') return renderer.codePointWidth(input.code)
  if (op === 'hangingIndent') return renderer.hangingIndent(input.mark, input.indent, input.text, input.columns)
  if (op === 'sgr') return renderer.sgr(input.text, input.params)
  if (op === 'box' || op === 'frame') {
    const { border, ...options } = input.options
    return renderer[op](input.content, { ...options, ...(border === undefined ? {} : { border: text => renderer.sgr(text, border) }) })
  }
  if (op === 'boxHeight') return renderer.boxHeight(input.content, input.width)
  if (op === 'frameHeight') return renderer.frameHeight(input.content, { width: input.width })
  return renderer[op](input.text, input.columns)
}

/** Canonical admitted request with the explicit default resolved palette. */
export function normalizeCaptureInput(value) {
  const source = CaptureInputSchema.parse(value)
  const palette = source.palette ?? { id: 'markdown', depth: 4, roles: Object.fromEntries(Object.entries(renderer.MARKDOWN_ROLES).map(([role, color]) => [role, color.ansi])) }
  return { ...source, palette }
}

export function capture(value) {
  const source = normalizeCaptureInput(value)
  const identity = rendererIdentity()
  if (JSON.stringify(identity) !== JSON.stringify(loadedIdentity)) throw new Error('Renderer changed since module loading; restart capture process')
  const palette = source.palette
  const roles = Object.fromEntries(Object.entries(palette.roles).map(([role, ansi]) => [role, { ansi }]))
  const restore = renderer.setPalette({ id: palette.id, name: palette.id, description: 'Resolved presentation snapshot', depth: palette.depth, roles }, palette.depth)
  try {
    return { ...source, palette, reference: { identity, package: '@dshline/renderer', palette: renderer.activePalette(), transport: 'JSON UTF-16 strings; Screen writes are JavaScript strings before host encoding' }, cases: source.cases.map(item => ({ ...item, output: evaluate(item.input) })) }
  } finally { restore() }
}

/** Stable tooling result envelope. Never retry rejected work through an unbounded fallback. */
export function captureResult(value) {
  try { return { ok: true, value: capture(value) } }
  catch (error) {
    const issues = error?.issues ?? []
    const resource = issues.some(issue => issue.message.includes('RESOURCE_LIMIT') || issue.code === 'too_big')
    return { ok: false, error: { code: issues.length ? (resource ? 'RESOURCE_LIMIT' : 'INVALID_INPUT') : 'REFERENCE_FAILURE', fallbackEligible: false } }
  }
}

/** Read at most limit+1 bytes from one opened inode; path replacement/growth cannot bypass the cap. */
export async function readBoundedJson(path, limit = 1_048_576) {
  const handle = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > limit) throw new Error('RESOURCE_LIMIT')
    return JSON.parse(bytes.subarray(0, offset).toString('utf8'))
  } finally { await handle.close() }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || !['--synthetic', '--session-input'].includes(args[0])) {
    throw new Error('Build first: pnpm build. Usage: node tools/renderer-capture.mjs --synthetic output.json | --session-input normalized.json (writes JSON to stdout). Never accepts raw session logs.')
  }
  if (args[0] === '--synthetic') await writeFile(args[1], `${JSON.stringify(captureResult(syntheticInput), null, 2)}\n`, { flag: 'wx' })
  else {
    let result
    try {
      const value = await readBoundedJson(args[1])
      result = value?.provenance?.kind === 'observed' ? captureResult(value) : { ok: false, error: { code: 'INVALID_INPUT', fallbackEligible: false } }
    } catch (error) { result = { ok: false, error: { code: error.message === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'INVALID_INPUT', fallbackEligible: false } } }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
  }
}
