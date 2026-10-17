/** Cycle-free native leaves. Width policy stays in width.ts; host state stays in TS. */
import { createRequire } from 'node:module'
import * as width from './width.ts'
import { WIDTH_UNICODE_VERSION } from './width-tables.ts'

/** Renderer selection. Rust forces admitted pure work; host-only features stay TS. */
export type RendererBackend = 'auto' | 'rust' | 'typescript'
type FastOperation = 'displayWidth' | 'stripAnsi' | 'escapeControls' | 'sanitizePasted' | 'truncateToWidth' | 'tailToWidth' | 'fitToWidth' | 'chunkToWidth' | 'wrapToWidth'
type FastResult = number | string | string[]
type Addon = { execute(request: string): string; unicodeVersion?(): string; codePointWidth?(code: number): number } & Partial<Record<FastOperation, (source: string, columns?: number) => FastResult>>
// These direct methods bound their own input/expansion rather than paying the
// conservative JSON corpus's quadratic estimate for a scalar measurement.
/** Maximum admitted UTF-16 input units; shared with the native boundary. */
export const MAX_TEXT_UNITS = 2048
/** Maximum admitted absolute column budget; bounds output expansion. */
export const MAX_COLUMNS = 256
// FFI cannot beat a JS scalar table lookup. JSON-only transforms also stay TS in
// auto until their whole boundary cost (not just the Rust kernel) earns a win.
const AUTO_MIN_UNITS: Record<FastOperation, number> = {
  displayWidth: 64, stripAnsi: Infinity, escapeControls: Infinity, sanitizePasted: Infinity,
  truncateToWidth: Infinity, tailToWidth: 64, fitToWidth: 64, chunkToWidth: 512, wrapToWidth: 64,
}
/** Internal live binding shared with composite dispatch, changed only by the setter. */
export let selection: RendererBackend = 'typescript'
let addon: Addon | undefined
let attempted = false
let addonUnicodeMatches = false
// Node's Unicode release cannot change during a real process. Capture it once;
// the optional addon's *compiled* release is checked separately when loaded.
const runtimeUnicodeMatches = process.versions.unicode === WIDTH_UNICODE_VERSION
const require = createRequire(import.meta.url)
// These probes need ASCII code-unit membership, not Unicode character matching.
// Unicode regex mode makes sparse two-byte strings pay an expensive full scan.
const NON_ASCII = /[^\x00-\x7f]/
function asciiOnly(source: string): boolean {
  // A non-ASCII edge already disproves ASCII; do not scan the intervening run.
  return source.length === 0 || source.charCodeAt(0) < 128 && source.charCodeAt(source.length - 1) < 128 && !NON_ASCII.test(source)
}

/** Name a conservative TS guard for families with observed Mac regressions.
 * @param op - Requested leaf.
 * @param source - Already bounded text.
 * @param columns - Already bounded budget, where applicable.
 * @returns A regression guard name, or undefined for ordinary admission.
 */
export function regressionGuard(op: FastOperation, source: string, columns = 0): string | undefined {
  // Do not replace the existing thresholds. These additional exclusions keep
  // the measured losing families on TS, including ANSI-encoded ASCII text.
  if (op === 'displayWidth') {
    // The long sparse-Unicode regression is a late suffix. Do not add a full
    // JS scan to ordinary long ASCII just to decide whether Rust may scan it.
    if (source.length > 512 && source.charCodeAt(source.length - 1) < 128 && source.charCodeAt(source.length - 2) < 128) return undefined
    // A greedy whole-string dominance expression backtracks over long ASCII
    // and costs more than the leaf itself. A first-non-ASCII search avoids that.
    const first = source.search(NON_ASCII)
    if (first < 0) return source.length <= 512 ? 'ascii-short-width' : undefined
    const head = source.charCodeAt(first), next = source.charCodeAt(first + 1)
    const units = head >= 0xd800 && head <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1
    const after = first + units
    // A second non-ASCII point at either suffix edge settles this immediately;
    // do not scan a long ASCII gap merely to rediscover that same point.
    if (after < source.length && source.charCodeAt(source.length - 1) >= 128 || after < source.length - 1 && source.charCodeAt(source.length - 2) >= 128) return undefined
    if (!NON_ASCII.test(source.slice(after))) return 'ascii-dominant-width'
  }
  if (op === 'tailToWidth' && source.length >= 512 && asciiOnly(source)) return 'ascii-tail'
  if (op === 'chunkToWidth' && asciiOnly(source)) return 'ascii-chunk'
  if (op === 'wrapToWidth' && (source.length <= 512 || columns >= 256 || source.includes('\x1b')) && asciiOnly(source)) return 'ascii-wrap'
  return undefined
}

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
/** Create a non-retryable native boundary error. @param code - Bounded error code. @returns Typed error. */
export function failure(code: string): Error { return Object.assign(new Error(`renderer: ${code}`), { code, fallbackEligible: false }) }
/** Load the optional process addon once. @returns The guarded addon or undefined. */
export function load(): Addon | undefined {
  if (!attempted) {
    attempted = true
    try {
      const candidate: unknown = require(`../native/${process.platform}-${process.arch}.node`)
      if (candidate && typeof (candidate as Addon).execute === 'function') {
        addon = candidate as Addon
        addonUnicodeMatches = typeof addon.unicodeVersion === 'function' && addon.unicodeVersion() === WIDTH_UNICODE_VERSION
      }
    } catch { /* Missing or unloadable optional artifacts are an auto-only fallback. */ }
  }
  return addon
}
/** Require matching runtime, TS policy and compiled Rust lookup before execution.
 * @returns Whether native Unicode-dependent work can be admitted.
 */
export function unicodeCompatible(): boolean {
  return runtimeUnicodeMatches && !!load() && addonUnicodeMatches
}
/** Admit primitive text without coercion. @param v - Caller input. @returns Whether native text is bounded. */
export const boundedString = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT_UNITS
/** Admit an integer budget without coercion. @param v - Caller input. @returns Whether the budget is bounded. */
export const boundedColumns = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= MAX_COLUMNS

/** Normalize a native throw without reference retry. @param error - Native failure. @returns Typed error. */
export function nativeFailure(error: unknown): Error {
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
/** Bind guarded unary dispatch. @param op - Direct operation. @param reference - TS oracle. @returns Mode-aware primitive. */
export function unary<T extends number | string>(op: FastOperation, reference: (source: string) => T): (source: string) => T {
  return source => {
    if (selection === 'typescript' || !boundedString(source) || selection === 'auto' && (source.length < AUTO_MIN_UNITS[op] || regressionGuard(op, source)) || !runtimeUnicodeMatches) return reference(source)
    const native = load()
    if (!native || typeof native[op] !== 'function') {
      if (selection === 'rust') throw failure('BACKEND_FAILURE')
      return reference(source)
    }
    if (!addonUnicodeMatches) return reference(source)
    return invokeFast<T>(native, op, source)
  }
}
/** Bind guarded text/budget dispatch. @param op - Direct operation. @param reference - TS oracle. @returns Mode-aware primitive. */
export function cut<T extends string | string[]>(op: FastOperation, reference: (source: string, columns: number) => T): (source: string, columns: number) => T {
  return (source, columns) => {
    if (selection === 'typescript' || !boundedString(source) || !boundedColumns(columns) || !runtimeUnicodeMatches) return reference(source, columns)
    // Crossing FFI once per output row loses on narrow wraps even when the Rust
    // scan is faster. Rust forces admitted work; auto retains the cheap TS host.
    const narrowRows = op === 'chunkToWidth' && columns < 64 || op === 'wrapToWidth' && columns < 32
    if (selection === 'auto' && (narrowRows || source.length < AUTO_MIN_UNITS[op] || regressionGuard(op, source, columns))) return reference(source, columns)
    const native = load()
    if (!native || typeof native[op] !== 'function') {
      if (selection === 'rust') throw failure('BACKEND_FAILURE')
      return reference(source, columns)
    }
    if (!addonUnicodeMatches) return reference(source, columns)
    return invokeFast<T>(native, op, source, columns)
  }
}
/** Backend-dispatched codePointWidth; preserves the reference signature. */
export const codePointWidth: typeof width.codePointWidth = code => {
  if (selection !== 'rust' || typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 0x10ffff || !unicodeCompatible()) return width.codePointWidth(code)
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
