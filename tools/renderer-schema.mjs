/** Tooling-only normalized boundary. Never imported by either runtime package. */
import { z } from 'zod'
export const ADMISSION = Object.freeze({ textUnits: 2048, collection: 64, columns: 256, totalInputUnits: 8192, estimatedOutputUnits: 67_108_864 })
const integer = z.number().int().min(-9999).max(9999)
const text = z.string().max(ADMISSION.textUnits) // JSON escapes preserve lone UTF-16 surrogates; do not coerce to UTF-8.
const columns = integer.min(-ADMISSION.columns).max(ADMISSION.columns) // Negative budgets are intentional reference cases.
const strings = z.array(text).max(ADMISSION.collection)
const cursor = z.strictObject({ row: integer, column: integer })
const divider = z.strictObject({ kind: z.literal('divider') })
const border = z.array(integer).max(16).optional() // Explicit SGR parameters replace callbacks.
const boxOptions = z.strictObject({ width: columns, title: text.optional(), border })
const frameOptions = boxOptions.extend({ rightTitle: text.optional(), footer: text.optional() })
const operation = (op, shape) => z.strictObject({ op: z.literal(op), ...shape })
/** Resolved presentation state: role names are opaque keys, never domain objects. */
export const ResolvedPaletteSchema = z.strictObject({
  id: text,
  depth: z.union([z.literal(0), z.literal(4), z.literal(8), z.literal(24)]),
  roles: z.record(text, z.array(integer).max(16)).refine(value => Object.keys(value).length <= ADMISSION.collection, { message: 'RESOURCE_LIMIT: too many palette roles' }),
})
const fence = z.string().max(ADMISSION.textUnits).regex(/^(?:`{3,}|~{3,})(?![\s\S])/u).nullable()
/** Proposed native ABI only; no native implementation or dispatch in Phase 1. */
const MarkdownTransitionInputShape = z.strictObject({
  state: z.strictObject({ fence }),
  palette: ResolvedPaletteSchema,
  text,
  mode: z.enum(['line', 'partial']),
  startsLine: z.boolean(),
})
const MarkdownTransitionOutputShape = z.strictObject({
  state: z.strictObject({ fence }),
  rows: strings,
})
const PresentationShape = z.discriminatedUnion('op', [
  ...['displayWidth', 'stripAnsi', 'escapeControls', 'sanitizePasted', 'renderInline', 'renderMarkdown'].map(op => operation(op, { text })),
  // All Unicode code points plus surrogate code-unit values preserved by TS strings.
  operation('codePointWidth', { code: z.number().int().min(0).max(0x10ffff) }),
  ...['truncateToWidth', 'tailToWidth', 'chunkToWidth', 'wrapToWidth', 'fitToWidth'].map(op => operation(op, { text, columns })),
  operation('hangingIndent', { mark: text, indent: text, text, columns }),
  operation('sgr', { text, params: z.array(integer).max(16) }),
  operation('box', { content: strings, options: boxOptions }),
  operation('boxHeight', { content: strings, width: columns }),
  operation('frame', { content: z.array(z.union([text, divider])).max(ADMISSION.collection), options: frameOptions }),
  operation('frameHeight', { content: z.array(z.union([text, divider])).max(ADMISSION.collection), width: columns }),
  operation('markdownSequence', { calls: z.array(z.discriminatedUnion('method', [
    z.strictObject({ method: z.literal('line'), text }),
    z.strictObject({ method: z.literal('partial'), text, startsLine: z.boolean().optional() }),
  ])).max(ADMISSION.collection) }),
  operation('screenSequence', { columns: columns.min(0), calls: z.array(z.discriminatedUnion('method', [
    z.strictObject({ method: z.literal('setLive'), lines: strings, cursor: cursor.optional() }),
    z.strictObject({ method: z.literal('commit'), lines: strings }),
    z.strictObject({ method: z.literal('resize'), columns: columns.min(0) }),
    z.strictObject({ method: z.literal('markStale') }),
    z.strictObject({ method: z.literal('close') }),
  ])).max(ADMISSION.collection) }),
])
/** Conservative admission estimate includes escape/tab expansion, SGR replay and repeated calls. */
export function estimate(value) {
  let units = 0, keyUnits = 0, width = 0, entries = 0
  function walk(item) {
    if (typeof item === 'string') units += item.length
    else if (typeof item === 'number') width = Math.max(width, Math.abs(item))
    else if (Array.isArray(item)) { entries += item.length; for (const child of item) walk(child) }
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { keyUnits += key.length; walk(child) }
  }
  // A code point is a lookup key, not a requested allocation width.
  walk(value?.op === 'codePointWidth' ? { ...value, code: 0 } : value)
  // Max 16 SGR parameters of <=5 characters plus separators; nested spans/replays get factor 1024.
  return { units: units + keyUnits, output: (units + Math.min(width, ADMISSION.columns) + entries + 1) ** 2 * 1024 }
}
function admitted(value, ctx) {
  const cost = estimate(value)
  if (cost.units > ADMISSION.totalInputUnits || cost.output > ADMISSION.estimatedOutputUnits) ctx.addIssue({ code: 'custom', message: 'RESOURCE_LIMIT: normalized request exceeds conservative aggregate work/output budget' })
}
export const PresentationSchema = PresentationShape.superRefine(admitted)
export const MarkdownTransitionInputSchema = MarkdownTransitionInputShape.superRefine(admitted)
export const MarkdownTransitionOutputSchema = MarkdownTransitionOutputShape.superRefine(admitted)
export const NativeResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: MarkdownTransitionOutputSchema }),
  z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.enum(['RESOURCE_LIMIT', 'INVALID_INPUT', 'BACKEND_FAILURE']), fallbackEligible: z.literal(false) }) }),
])
export const CaptureInputSchema = z.strictObject({
  version: z.literal(1),
  provenance: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('synthetic'), description: text }),
    z.strictObject({ kind: z.literal('observed'), description: text, consent: z.literal('explicitly-provided-normalized-data') }),
  ]),
  palette: ResolvedPaletteSchema.optional(),
  cases: z.array(z.strictObject({ id: text.min(1), input: PresentationSchema })).max(ADMISSION.collection),
}).superRefine((value, ctx) => {
  if (value.cases.reduce((sum, item) => sum + estimate(item.input).output, 0) > ADMISSION.estimatedOutputUnits || estimate(value).units > ADMISSION.totalInputUnits) ctx.addIssue({ code: 'custom', message: 'RESOURCE_LIMIT: capture aggregate budget exceeded' })
  const ids = new Set()
  for (const [index, item] of value.cases.entries()) {
    if (ids.has(item.id)) ctx.addIssue({ code: 'custom', path: ['cases', index, 'id'], message: 'Duplicate case id' })
    ids.add(item.id)
  }
})
