/**
 * A route's model list as a draft: pure edits, no Harness, no rendering.
 *
 * A pi-ai route serves one of two catalogs. An explicit `models` array is the
 * route's whole list, each entry carrying an `id` and possibly fields this pass
 * does not curate. A route with no such list inherits the installed catalog,
 * and then per-model edits go to `modelOverrides.<id>` so the rest of that
 * catalog keeps serving untouched. {@link ModelStorage} is what tells the two
 * apart inside one draft type, and the write projection follows from it.
 *
 * An override draft records which curated fields the reader actually edited
 * ({@link ModelDraftEntry.changed}), because a whole-object rewrite would carry
 * the open-time copy of a field nobody opened back over a concurrent edit. The
 * `models` array keeps its whole-array write: array elements are not
 * independently path-addressable through this settings seam, and that write
 * already carries every uncurated field through.
 *
 * Every function here is a pure transform over `ModelDraftEntry[]`. The
 * terminal loop that turns keystrokes into calls on these lives in
 * `route-editor.ts`; nothing here pushes an overlay or calls a seam.
 * @module dshline/connect/model-editor
 */

import type { LlmDiscoveredModelRead } from './harness.ts'
import type { CuratedModelFields, ModelCuratedField, ReasoningEffortsValue } from './pi-ai.ts'
import { CURATED_MODEL_FIELDS, curatedFieldValue, curatedModelFields, curatedOverrideFields, mergeModelEntry, mergeOverrideEntry } from './pi-ai.ts'

/** Which profile field one draft's entries are written into. */
export type ModelStorage = 'models' | 'override'

/** No field edited yet; shared so an untouched entry allocates nothing. */
const NOTHING_CHANGED: ReadonlySet<ModelCuratedField> = new Set()

/** One model row in a draft being edited. */
export interface ModelDraftEntry {
  readonly id: string
  readonly name: string | undefined
  readonly contextWindow: number | undefined
  readonly maxTokens: number | undefined
  /** Declared modalities, or undefined to inherit the installed catalog's / route default. */
  readonly input: readonly string[] | undefined
  /** The declared reasoning capability, or undefined to inherit. */
  readonly reasoningEfforts: ReasoningEffortsValue | undefined
  /** The entry's previous raw shape, so an unrendered field survives a write. */
  readonly retained: Record<string, unknown> | undefined
  /** Whether this entry is part of the set that would be written. */
  readonly included: boolean
  /** Which profile field a write addresses. */
  readonly storage: ModelStorage
  /**
   * The curated fields this draft actually edited, and therefore the only
   * fields a `modelOverrides.<id>` write may address. An untouched field stays
   * out of the set even though its value is displayed, which is what keeps a
   * second save after a revision race from reapplying a stale copy of a field
   * the reader never opened.
   */
  readonly changed: ReadonlySet<ModelCuratedField>
}

/**
 * Build a draft from a route's raw `models` array.
 *
 * The array is the route's explicit list, so every usable entry is included;
 * `undefined` and `[]` both mean the route inherits, and each yields an empty
 * draft. An entry without a usable id is skipped, since nothing downstream can
 * address it.
 * @param raw - the profile's stored entries, or undefined/empty when it inherits.
 * @returns one entry per usable raw item, all included, writing to `models`.
 */
export function entriesFromRaw(raw: readonly unknown[] | undefined): ModelDraftEntry[] {
  if (raw === undefined) return []
  const entries: ModelDraftEntry[] = []
  for (const item of raw) {
    const curated = curatedModelFields(item)
    if (curated === undefined) continue
    entries.push({ ...curated, retained: item as Record<string, unknown>, included: true, storage: 'models', changed: NOTHING_CHANGED })
  }
  return entries
}

/**
 * Build a draft from a route's raw `modelOverrides` dict.
 *
 * Every stored override is included — it is a saved customization, and the
 * route menu must show it even when the installed catalog no longer describes
 * that id, because removing it is the repair. An empty key is skipped, since it
 * cannot address a model.
 * @param raw - the profile's raw `modelOverrides` dict.
 * @returns one entry per stored override, all included, writing to `modelOverrides`.
 */
export function entriesFromOverrides(raw: Record<string, unknown>): ModelDraftEntry[] {
  const entries: ModelDraftEntry[] = []
  for (const [id, value] of Object.entries(raw)) {
    if (id === '') continue
    entries.push({
      ...curatedOverrideFields(id, value),
      retained: typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined,
      included: true,
      storage: 'override',
      changed: NOTHING_CHANGED,
    })
  }
  return entries
}

/**
 * Fold discovery candidates into a draft, without touching an id already there.
 *
 * A candidate whose id the draft already knows is dropped rather than merged:
 * the draft's own fields — possibly hand-corrected — are the more trustworthy
 * source for that id, and an endpoint listing seldom reports more than an id
 * anyway. A new id is added unchecked, so adopting it is still a deliberate
 * toggle rather than something this call did on the reader's behalf.
 * @param entries - the draft before the fetch.
 * @param candidates - what the endpoint reported.
 * @param storage - which field a later write addresses, matching the draft.
 * @returns the draft with unseen candidates appended, unincluded.
 */
export function addCandidates(
  entries: readonly ModelDraftEntry[],
  candidates: readonly LlmDiscoveredModelRead[],
  storage: ModelStorage,
): ModelDraftEntry[] {
  const known = new Set(entries.map(entry => entry.id))
  const added: ModelDraftEntry[] = []
  for (const candidate of candidates) {
    if (known.has(candidate.id)) continue
    known.add(candidate.id)
    added.push({
      id: candidate.id,
      name: candidate.name,
      contextWindow: candidate.contextWindow,
      maxTokens: candidate.maxTokens,
      input: undefined,
      reasoningEfforts: undefined,
      retained: undefined,
      included: false,
      storage,
      changed: NOTHING_CHANGED,
    })
  }
  return [...entries, ...added]
}

/**
 * Flip one entry's inclusion.
 * @param entries - the draft.
 * @param id - the entry to toggle.
 * @returns the draft with that entry's `included` flipped.
 */
export function toggleIncluded(entries: readonly ModelDraftEntry[], id: string): ModelDraftEntry[] {
  return entries.map(entry => entry.id === id ? { ...entry, included: !entry.included } : entry)
}

/**
 * Mark one curated field as edited, keeping every other field and the set's
 * previous members.
 * @param entry - the entry being edited.
 * @param field - the field the reader changed.
 * @returns the entry with the field recorded as changed.
 */
export function markChanged(entry: ModelDraftEntry, field: ModelCuratedField): ModelDraftEntry {
  if (entry.changed.has(field)) return entry
  return { ...entry, changed: new Set([...entry.changed, field]) }
}

/** Fields a hand-typed or hand-edited model row carries. */
export interface ModelFieldInput {
  readonly id: string
  readonly name: string | undefined
  readonly contextWindow: number | undefined
  readonly maxTokens: number | undefined
  readonly input: readonly string[] | undefined
  readonly reasoningEfforts: ReasoningEffortsValue | undefined
}

/** What adding or editing one entry produced. */
export type ModelEditResult =
  | { readonly ok: true; readonly entries: ModelDraftEntry[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Add a hand-typed model, refusing a duplicate id before it reaches settings.
 * @param entries - the draft.
 * @param fields - the typed fields.
 * @param storage - which field a later write addresses, matching the draft.
 * @returns the draft with the new entry appended and included, or the refusal.
 */
export function addManual(
  entries: readonly ModelDraftEntry[],
  fields: ModelFieldInput,
  storage: ModelStorage,
): ModelEditResult {
  const id = fields.id.trim()
  if (id === '') return { ok: false, reason: 'a model id is required' }
  if (entries.some(entry => entry.id === id)) return { ok: false, reason: `"${id}" is already in the list` }
  // Only the fields actually supplied count as edited. An id-only add leaves
  // `changed` empty, so an override write for it is the whole-value spelling a
  // first appearance earns — never a set of paths nobody chose.
  const changed = new Set(CURATED_MODEL_FIELDS.filter(field => curatedFieldValue(fields, field) !== undefined))
  return {
    ok: true,
    entries: [...entries, { ...fields, id, retained: undefined, included: true, storage, changed }],
  }
}

/**
 * Replace one entry's curated fields, keeping its id, inclusion, and retained shape.
 * @param entries - the draft.
 * @param id - the entry being edited.
 * @param fields - the new curated values.
 * @param changed - the fields this edit actually touched.
 * @returns the draft with that entry updated.
 */
export function updateFields(
  entries: readonly ModelDraftEntry[],
  id: string,
  fields: Omit<ModelFieldInput, 'id'>,
  changed: readonly ModelCuratedField[] = [],
): ModelDraftEntry[] {
  return entries.map(entry => entry.id === id
    ? { ...entry, ...fields, changed: new Set([...entry.changed, ...changed]) }
    : entry)
}

/**
 * Drop one entry from the draft entirely.
 * @param entries - the draft.
 * @param id - the entry to remove.
 * @returns the draft without it.
 */
export function removeEntry(entries: readonly ModelDraftEntry[], id: string): ModelDraftEntry[] {
  return entries.filter(entry => entry.id !== id)
}

/** The numeric bounds a serialized `number` field declared; absent means unconstrained. */
export interface NumericRules {
  readonly min?: number
  readonly step?: number
}

/**
 * Parse an optional numeric field against the constraints its own schema
 * declared.
 *
 * The rules come from the serialized `number` node, not from this function: a
 * blank answer means absent, a value must clear `min` when one is declared, and
 * a declared `step` (measured from `min`, or from zero when no floor exists)
 * must divide the value exactly. Nothing here assumes a positive integer — a
 * schema that allows zero, or a fractional step, is honored as written, and a
 * schema with no `step` accepts any finite number rather than inventing one.
 * @param raw - the typed text, or undefined when the field was not answered.
 * @param rules - the schema-declared bounds for this field.
 * @returns the parsed number, or the refusal reason.
 */
export function parseCapacity(
  raw: string | undefined,
  rules: NumericRules,
): { ok: true; value: number | undefined } | { ok: false; reason: string } {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') return { ok: true, value: undefined }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { ok: false, reason: 'must be a number' }
  if (rules.min !== undefined && value < rules.min) return { ok: false, reason: `must be at least ${String(rules.min)}` }
  // The owning schema measures a multiple with `Math.abs(step)`, so a negative
  // declaration means the same spacing rather than "no constraint".
  const step = rules.step === undefined ? undefined : Math.abs(rules.step)
  if (step !== undefined && Number.isFinite(step) && step > 0) {
    const from = rules.min ?? 0
    const steps = (value - from) / step
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      return { ok: false, reason: `must be a multiple of ${String(step)} from ${String(from)}` }
    }
  }
  return { ok: true, value }
}

/**
 * The entries that would actually be written.
 * @param entries - the draft.
 * @returns the included entries, in draft order.
 */
export function includedEntries(entries: readonly ModelDraftEntry[]): readonly ModelDraftEntry[] {
  return entries.filter(entry => entry.included)
}

/**
 * The draft's included entries as JSON-compatible rows, unknown fields intact.
 * @param entries - the draft.
 * @returns one record per included entry, ready for a `set` op.
 */
export function toRawEntries(entries: readonly ModelDraftEntry[]): Record<string, unknown>[] {
  return includedEntries(entries).map(entry => mergeModelEntry(entry.retained, entry))
}

/**
 * Whether two drafts would write the same models, order aside.
 *
 * Compared as written rows rather than as entry objects, so an entry whose
 * `retained` carries the same values two different ways (or not at all,
 * because a manual entry has none) still compares equal when the read is what
 * matters. Order does not matter to what a route serves, so a fetch that
 * re-adds entries in a different order is not reported as a change.
 * @param left - one draft.
 * @param right - the other draft.
 * @returns true when their written rows carry the same fields, regardless of order.
 */
export function sameModelSet(left: readonly ModelDraftEntry[], right: readonly ModelDraftEntry[]): boolean {
  const a = toRawEntries(left)
  const b = toRawEntries(right)
  if (a.length !== b.length) return false
  const sortedA = [...a].sort((x, y) => String(x.id).localeCompare(String(y.id)))
  const sortedB = [...b].sort((x, y) => String(x.id).localeCompare(String(y.id)))
  return JSON.stringify(sortedA) === JSON.stringify(sortedB)
}

/**
 * One override value as it would be written, unknown fields intact.
 *
 * Used only for an id's first appearance in a draft, where there is no stored
 * sibling to preserve; an existing override is written field by field.
 * @param entry - the draft entry.
 * @returns the `modelOverrides.<id>` value.
 */
export function toRawOverride(entry: ModelDraftEntry): Record<string, unknown> {
  return mergeOverrideEntry(entry.retained, entry)
}

/**
 * The draft's included overrides as id-keyed JSON-compatible values.
 * @param entries - the draft.
 * @returns the override dict, in draft order.
 */
export function toRawOverrides(entries: readonly ModelDraftEntry[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(includedEntries(entries).map(entry => [entry.id, toRawOverride(entry)]))
}

/**
 * Whether two override drafts would write the same customizations.
 *
 * Compared as written values rather than as entry objects, for the same reason
 * {@link sameModelSet} compares rows: an edited field that lands on the value
 * already stored is not a change. Order is not compared because a dict has
 * none. Used by the menu to decide whether the draft differs at all, never to
 * build a write.
 * @param left - one draft.
 * @param right - the other draft.
 * @returns true when both write the same id set with the same fields.
 */
export function sameOverrideSet(left: readonly ModelDraftEntry[], right: readonly ModelDraftEntry[]): boolean {
  const a = toRawOverrides(left)
  const b = toRawOverrides(right)
  const keysA = Object.keys(a).sort()
  const keysB = Object.keys(b).sort()
  if (keysA.length !== keysB.length || keysA.some((key, index) => key !== keysB[index])) return false
  return keysA.every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]))
}
