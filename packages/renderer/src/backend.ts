/** Optional native presentation dispatch; the original modules remain the oracle. */
import { createRequire } from 'node:module'
import { types } from 'node:util'
import * as width from './width.ts'
import * as boxes from './box.ts'
import * as text from './text.ts'
import * as markdown from './markdown.ts'
import { nativePaletteSnapshot } from './theme.ts'

/** Renderer selection. Rust forces admitted pure work; host-only features stay TS. */
export type RendererBackend = 'auto' | 'rust' | 'typescript'
type FastOperation = 'displayWidth' | 'stripAnsi' | 'escapeControls' | 'sanitizePasted' | 'truncateToWidth' | 'tailToWidth' | 'fitToWidth' | 'chunkToWidth' | 'wrapToWidth'
type FastResult = number | string | string[]
type Addon = { execute(request: string): string; codePointWidth?(code: number): number } & Partial<Record<FastOperation, (source: string, columns?: number) => FastResult>>
// These direct methods bound their own input/expansion rather than paying the
// conservative JSON corpus's quadratic estimate for a scalar measurement.
const MAX_TEXT_UNITS = 2048
const MAX_COLUMNS = 256
// FFI cannot beat a JS scalar table lookup. JSON-only transforms also stay TS in
// auto until their whole boundary cost (not just the Rust kernel) earns a win.
const AUTO_MIN_UNITS: Record<FastOperation, number> = {
  displayWidth: 64, stripAnsi: Infinity, escapeControls: Infinity, sanitizePasted: Infinity,
  truncateToWidth: Infinity, tailToWidth: 64, fitToWidth: 64, chunkToWidth: 512, wrapToWidth: 64,
}
let selection: RendererBackend = 'auto'
let addon: Addon | undefined
let attempted = false
const require = createRequire(import.meta.url)

/** Select the process renderer, matching the process-owned terminal and palette.
 * @param backend - requested backend.
 * @returns an idempotent disposer restoring the previous selection.
 */
export function setRendererBackend(backend: RendererBackend): () => void {
  if (!['auto', 'rust', 'typescript'].includes(backend)) throw failure('INVALID_INPUT')
  if (backend === 'rust' && !load()) throw failure('BACKEND_FAILURE')
  const previous = selection
  selection = backend
  let disposed = false
  return () => { if (!disposed) { disposed = true; selection = previous } }
}
/** Read the requested backend.
 * @returns current selection.
 */
export function rendererBackend(): RendererBackend { return selection }
function failure(code: string): Error { return Object.assign(new Error(`renderer: ${code}`), { code, fallbackEligible: false }) }
function load(): Addon | undefined {
  if (!attempted) {
    attempted = true
    try {
      const candidate: unknown = require(`../native/${process.platform}-${process.arch}.node`)
      if (candidate && typeof (candidate as Addon).execute === 'function') addon = candidate as Addon
    } catch { /* Missing or unloadable optional artifacts are an auto-only fallback. */ }
  }
  return addon
}
const units = (value: string): number[] => Array.from({ length: value.length }, (_, i) => value.charCodeAt(i))
function encode(value: unknown): unknown {
  if (typeof value === 'string') return units(value)
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, ['op', 'mode', 'kind'].includes(k) ? v : encode(v)]))
  return value
}
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  // Arbitrary host getters/callbacks retain their original TS evaluation order.
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(d => 'value' in d)
}
function dense(value: unknown, predicate: (v: unknown) => boolean, limit = 64): boolean {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key))) return false
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i)
    if (!descriptor || !('value' in descriptor) || !predicate(descriptor.value)) return false
  }
  return true
}
const boundedString = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT_UNITS
const boundedColumns = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= MAX_COLUMNS
const boundedParam = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 9999
function shape(op: string, input: Record<string, unknown>): boolean {
  const content = (v: unknown): boolean => boundedString(v) || (plain(v) && Object.keys(v).length === 1 && v.kind === 'divider')
  const options = (v: unknown, frame: boolean): boolean => {
    if (!plain(v) || Object.keys(v).some(k => !(frame ? ['width', 'title', 'rightTitle', 'footer', 'border'] : ['width', 'title', 'border']).includes(k))) return false
    return boundedColumns(v.width) && ['title', 'rightTitle', 'footer'].every(k => v[k] === undefined || boundedString(v[k])) && v.border === undefined
  }
  if (op === 'hangingIndent') return ['mark', 'indent', 'text'].every(k => boundedString(input[k])) && boundedColumns(input.columns)
  if (op === 'sgr') return boundedString(input.text) && dense(input.params, boundedParam, 16)
  if (op === 'box' || op === 'frame') return dense(input.content, op === 'box' ? boundedString : content) && options(input.options, op === 'frame')
  if (op === 'boxHeight' || op === 'frameHeight') return dense(input.content, op === 'boxHeight' ? boundedString : content) && boundedColumns(input.width)
  if (op === 'markdownTransition') return boundedString(input.text) && typeof input.startsLine === 'boolean'
  return ['renderInline', 'renderMarkdown'].includes(op) && boundedString(input.text)
}
// Bound the complete normalized presentation data. Match the pure transport's
// work estimate: palette metadata is aggregate input, not output expansion for
// standalone markdown. Transitions include their explicit palette and state.
function eligible(value: Record<string, unknown>): boolean {
  let total = 0, keys = 0, entries = 0, maximum = 0, valid = true
  function walk(v: unknown, key = '', budget = true): void {
    if (!valid || v === undefined || v === null || typeof v === 'boolean') return
    if (typeof v === 'string') { total += v.length; valid = v.length <= MAX_TEXT_UNITS; return }
    if (typeof v === 'number') { valid = boundedParam(v); if (budget) maximum = Math.max(maximum, Math.abs(v)); return }
    if (Array.isArray(v)) {
      valid = dense(v, () => true, key === 'params' || key === 'role-params' ? 16 : 64)
      if (budget) entries += v.length
      for (const child of v) walk(child, key === 'roles' ? 'role-params' : '', budget)
      return
    }
    if (!plain(v)) { valid = false; return }
    for (const [k, child] of Object.entries(v)) { keys += k.length; walk(child, k, budget) }
  }
  // Work budget excludes the op tag on the explicit transition ABI.
  const transition = value.op === 'markdownTransition'
  const { palette, op, ...input } = value
  walk(transition ? input : { op, ...input })
  const workTotal = total, workEntries = entries, workMaximum = maximum
  if (palette !== undefined) {
    if (!plain(palette) || !boundedString(palette.id) || ![0, 4, 8, 24].includes(palette.depth as number) || !plain(palette.roles) || Object.keys(palette.roles).length > 64 || Object.entries(palette.roles).some(([key, params]) => !boundedString(key) || !dense(params, boundedParam, 16))) return false
    walk(palette, 'palette', transition)
  }
  const estimate = transition ? total + Math.min(maximum, MAX_COLUMNS) + entries + 1 : workTotal + Math.min(workMaximum, MAX_COLUMNS) + workEntries + 1
  const aggregateExtra = (transition ? String(op).length + 2 : 0) + (palette === undefined ? 0 : 7)
  return valid && total + keys + aggregateExtra <= 8192 && estimate ** 2 * 1024 <= 67_108_864
}
function nativeFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : ''
  return failure(['RESOURCE_LIMIT', 'INVALID_INPUT'].includes(message) ? message : 'BACKEND_FAILURE')
}
function invokeFast<T extends FastResult>(native: Addon, op: FastOperation, source: string, columns?: number): T {
  const method = native[op]
  if (!method) throw failure('BACKEND_FAILURE')
  let value: FastResult
  try { value = method(source, columns) } catch (error) { throw nativeFailure(error) }
  if (op === 'displayWidth' ? !Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_TEXT_UNITS * 2
    : op === 'chunkToWidth' || op === 'wrapToWidth' ? !Array.isArray(value) || !value.every(row => typeof row === 'string')
      : typeof value !== 'string') throw failure('BACKEND_FAILURE')
  return value as T
}
function unary<T extends number | string>(op: FastOperation, reference: (source: string) => T): (source: string) => T {
  return source => {
    if (selection === 'typescript' || !boundedString(source) || selection === 'auto' && source.length < AUTO_MIN_UNITS[op]) return reference(source)
    const native = load()
    if (!native || typeof native[op] !== 'function') {
      if (selection === 'rust') throw failure('BACKEND_FAILURE')
      return reference(source)
    }
    return invokeFast<T>(native, op, source)
  }
}
function cut<T extends string | string[]>(op: FastOperation, reference: (source: string, columns: number) => T): (source: string, columns: number) => T {
  return (source, columns) => {
    if (selection === 'typescript' || !boundedString(source) || !boundedColumns(columns)) return reference(source, columns)
    // Crossing FFI once per output row loses on narrow wraps even when the Rust
    // scan is faster. Rust forces admitted work; auto retains the cheap TS host.
    const narrowRows = op === 'chunkToWidth' && columns < 64 || op === 'wrapToWidth' && columns < 32
    if (selection === 'auto' && (narrowRows || source.length < AUTO_MIN_UNITS[op])) return reference(source, columns)
    const native = load()
    if (!native || typeof native[op] !== 'function') {
      if (selection === 'rust') throw failure('BACKEND_FAILURE')
      return reference(source, columns)
    }
    return invokeFast<T>(native, op, source, columns)
  }
}
function decode(value: unknown, op: string): unknown {
  if (['codePointWidth', 'displayWidth', 'boxHeight', 'frameHeight'].includes(op)) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw failure('BACKEND_FAILURE')
    return value
  }
  const string = (v: unknown): string => {
    if (!Array.isArray(v) || v.some(n => !Number.isInteger(n) || n < 0 || n > 65535)) throw failure('BACKEND_FAILURE')
    const parts: string[] = []
    for (let i = 0; i < v.length; i += 4096) parts.push(String.fromCharCode(...v.slice(i, i + 4096) as number[]))
    return parts.join('')
  }
  if (op === 'markdownTransition') {
    const result = value as { state: { fence: unknown }; rows: unknown[] }
    return { state: { fence: result.state.fence === null ? null : string(result.state.fence) }, rows: result.rows.map(string) }
  }
  return ['chunkToWidth', 'wrapToWidth', 'hangingIndent', 'box', 'frame', 'renderMarkdown'].includes(op) ? (value as unknown[]).map(string) : string(value)
}
function dispatch<T>(op: string, input: Record<string, unknown>, fallback: () => T): T {
  if (selection !== 'rust') return fallback()
  const native = load()
  if (!native) throw failure('BACKEND_FAILURE')
  // Public host features are selected before normalized admission, not retried
  // after a native rejection. This keeps forced Rust usable by callback frames.
  if (!shape(op, input)) return fallback()
  const compatible = !['renderInline', 'renderMarkdown', 'markdownTransition'].includes(op) || process.versions.unicode === '17.0'
  if (!compatible) return fallback()
  if (['renderInline', 'renderMarkdown', 'markdownTransition'].includes(op)) {
    const palette = nativePaletteSnapshot()
    if (!palette) return fallback()
    input.palette = palette
  }
  const request = { op, ...input }
  if (!eligible(request)) return fallback()
  const wire = encode(request) as Record<string, unknown>
  if (input.palette) {
    const palette = input.palette as NonNullable<ReturnType<typeof nativePaletteSnapshot>>
    wire.palette = { id: units(palette.id), depth: palette.depth, roles: Object.entries(palette.roles).map(([key, params]) => [units(key), params]) }
  }
  try {
    const result = JSON.parse(native.execute(JSON.stringify(wire))) as { ok?: boolean; value?: unknown; error?: { code?: string } } | null
    if (!result || result.ok !== true) throw failure(['RESOURCE_LIMIT', 'INVALID_INPUT', 'BACKEND_FAILURE'].includes(result?.error?.code ?? '') ? result!.error!.code! : 'BACKEND_FAILURE')
    return decode(result.value, op) as T
  } catch (error) {
    if (error instanceof Error && 'fallbackEligible' in error && error.fallbackEligible === false) throw error
    throw failure('BACKEND_FAILURE')
  }
}

/** Backend-dispatched codePointWidth; preserves the reference signature. */
export const codePointWidth: typeof width.codePointWidth = code => {
  if (selection !== 'rust' || typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 0x10ffff) return width.codePointWidth(code)
  const native = load()
  if (!native?.codePointWidth) throw failure('BACKEND_FAILURE')
  let value: number
  try { value = native.codePointWidth(code) } catch (error) { throw nativeFailure(error) }
  if (!Number.isInteger(value) || value < 0 || value > 2) throw failure('BACKEND_FAILURE')
  return value
}

/** Backend-dispatched displayWidth; preserves the reference signature. */
export const displayWidth: typeof width.displayWidth = unary('displayWidth', width.displayWidth)

/** Backend-dispatched stripAnsi; preserves the reference signature. */
export const stripAnsi: typeof width.stripAnsi = unary('stripAnsi', width.stripAnsi)

/** Backend-dispatched truncateToWidth; preserves the reference signature. */
export const truncateToWidth: typeof width.truncateToWidth = cut('truncateToWidth', width.truncateToWidth)

/** Backend-dispatched tailToWidth; preserves the reference signature. */
export const tailToWidth: typeof width.tailToWidth = cut('tailToWidth', width.tailToWidth)

/** Backend-dispatched chunkToWidth; preserves the reference signature. */
export const chunkToWidth: typeof width.chunkToWidth = cut('chunkToWidth', width.chunkToWidth)

/** Backend-dispatched wrapToWidth; preserves the reference signature. */
export const wrapToWidth: typeof width.wrapToWidth = cut('wrapToWidth', width.wrapToWidth)

/** Backend-dispatched hangingIndent; preserves the reference signature. */
export const hangingIndent: typeof width.hangingIndent = (...args) => selection !== 'rust' ? width.hangingIndent(...args) : dispatch('hangingIndent', { mark: args[0], indent: args[1], text: args[2], columns: args[3] }, () => width.hangingIndent(...args))

/** Backend-dispatched fitToWidth; preserves the reference signature. */
export const fitToWidth: typeof boxes.fitToWidth = cut('fitToWidth', boxes.fitToWidth)

/** Backend-dispatched box; preserves the reference signature. */
export const box: typeof boxes.box = (...args) => selection !== 'rust' ? boxes.box(...args) : dispatch('box', { content: args[0], options: args[1] }, () => boxes.box(...args))

/** Backend-dispatched boxHeight; preserves the reference signature. */
export const boxHeight: typeof boxes.boxHeight = (...args) => selection !== 'rust' ? boxes.boxHeight(...args) : dispatch('boxHeight', { content: args[0], width: args[1] }, () => boxes.boxHeight(...args))

/** Backend-dispatched frame; preserves the reference signature. */
export const frame: typeof boxes.frame = (...args) => selection !== 'rust' ? boxes.frame(...args) : dispatch('frame', { content: args[0], options: args[1] }, () => boxes.frame(...args))

/** Backend-dispatched frameHeight; preserves the reference signature. */
export const frameHeight: typeof boxes.frameHeight = (...args) => selection !== 'rust' || !plain(args[1]) ? boxes.frameHeight(...args) : dispatch('frameHeight', { content: args[0], width: args[1].width }, () => boxes.frameHeight(...args))

/** Backend-dispatched escapeControls; preserves the reference signature. */
export const escapeControls: typeof text.escapeControls = unary('escapeControls', text.escapeControls)

/** Backend-dispatched sanitizePasted; preserves the reference signature. */
export const sanitizePasted: typeof text.sanitizePasted = unary('sanitizePasted', text.sanitizePasted)

/** Backend-dispatched sgr; preserves the reference signature. */
export const sgr: typeof text.sgr = (...args) => selection !== 'rust' ? text.sgr(...args) : dispatch('sgr', { text: args[0], params: args[1] }, () => text.sgr(...args))

/** Backend-dispatched renderInline; preserves the reference signature. */
export const renderInline: typeof markdown.renderInline = (...args) => selection !== 'rust' ? markdown.renderInline(...args) : dispatch('renderInline', { text: args[0] }, () => markdown.renderInline(...args))

/** Backend-dispatched renderMarkdown; preserves the reference signature. */
export const renderMarkdown: typeof markdown.renderMarkdown = (...args) => selection !== 'rust' ? markdown.renderMarkdown(...args) : dispatch('renderMarkdown', { text: args[0] }, () => markdown.renderMarkdown(...args))

/** Create a streaming renderer; reconstruct TS fence state lazily on fallback.
 * @returns a renderer with the unchanged line/partial interface.
 */
export function createMarkdownRenderer(): markdown.MarkdownRenderer {
  let reference: markdown.MarkdownRenderer | undefined
  let state: { fence: string | null } = { fence: null }
  let referenceOnly = false
  function referenceForState(): markdown.MarkdownRenderer {
    if (!reference) {
      reference = markdown.createMarkdownRenderer()
      if (state.fence !== null) reference.line(state.fence)
    }
    return reference
  }
  return {
    line(source) {
      if (referenceOnly) {
        return referenceForState().line(source)
      }
      let usedReference = false
      const result = dispatch('markdownTransition', { text: source, state, mode: 'line', startsLine: true }, () => {
        referenceOnly = true
        usedReference = true
        return { state, rows: referenceForState().line(source) }
      })
      if (!usedReference) reference = undefined
      state = result.state
      return result.rows
    },
    partial(source, startsLine = true) {
      if (referenceOnly) {
        return referenceForState().partial(source, startsLine)
      }
      const result = dispatch('markdownTransition', { text: source, state, mode: 'partial', startsLine }, () => ({ state, rows: [referenceForState().partial(source, startsLine)] }))
      return result.rows.join('')
    },
  }
}
