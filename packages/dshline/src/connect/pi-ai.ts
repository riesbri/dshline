/**
 * Curated presentation for one known configuration domain: `llm-pi-ai`.
 *
 * Every other module in this directory is generic — it reads what
 * `LlmConfigurableProvider`, a settings descriptor, or a credential reference
 * publishes, and holds no adapter's field names. That stays true for WHICH
 * routes exist, whether one is active, and where its credential lives (the
 * `credential-ref` schema role in {@link "./schema.ts"}). It stops being true
 * for a curated route editor: "endpoint", "protocol", and "model catalog" are
 * not roles any generic seam publishes, so presenting them at all means
 * knowing a specific namespace's field names.
 *
 * `llm-pi-ai` is that one namespace today — the adapter whose settings profile
 * can describe a provider route wholesale, per
 * `@deepseek-ai/dsh-llm-pi-ai`'s `PiAiProviderProfile`. This module names the
 * fields it curates (`displayName`, `baseURL`, `api`, `headers`, `models`,
 * `modelOverrides`, and each model's `name`/`contextWindow`/`maxTokens`/
 * `input`/`reasoningEfforts`) as plain strings and reads/writes them through
 * the same generic `ctx.settings` path ops every other Connect action uses. It
 * does not import the pi-ai package at runtime, does not register providers,
 * does not parse model output, and does not perform network I/O — Harness still
 * does every one of those. What lives here is only the knowledge of which
 * fields, out of the many `PiAiProviderProfile` now has, are worth a terminal
 * form in this pass.
 *
 * `headers` earns its place for the same reason the route fields have it: it
 * decides what a route can REACH. A gateway that authenticates with anything
 * other than the one field carrying the `credential-ref` role — a tenant
 * header, a signed proxy token, a routing tag a corporate egress requires — is
 * otherwise unreachable from the terminal, and the route has to be finished by
 * hand in `settings.yaml`. The per-model capabilities earn theirs for the
 * complementary reason: they are what a deployment MUST state when nothing can
 * infer it, because no endpoint listing reports a model's modalities or its
 * reasoning-level wire spellings. `compat`, `retryPolicy`, and the operational
 * budgets still stay out.
 *
 * Which of those fields exist, and every CHOICE or VOCABULARY one offers, comes
 * from the namespace's own serialized schema rather than a list written here —
 * see {@link routeModelSchema}. The field NAMES are the knowledge this module
 * is allowed to hold; their shapes are the owner's to publish.
 *
 * The protocol CHOICES this module offers are not hard-coded even though the
 * field name is: `protocolChoices` reads the `api` field's own schema node and
 * takes the strings out of a `union` of `const`s, which is exactly how
 * `dsh-llm-pi-ai` builds that field (`z.union(supportedProtocols())`). A future
 * protocol needs no dshline change; a schema that stops shaping the field this
 * way degrades to no offered choices rather than a stale list.
 * {@link headersCurated} is the same discipline for `headers`: the field is
 * offered only while the schema still shapes it as a dict of strings, so a
 * namespace that reshapes it gets no header editor instead of a write it would
 * refuse.
 *
 * {@link piAiDeclarationTarget} owns a second piece of Harness-specific
 * knowledge for the same reason: no generic seam publishes "this namespace
 * accepts a route key it has never seen," so deciding whether `+ Add custom
 * provider` can be serviced AT ALL has to live here too, gated on the same
 * namespace check plus the schema shapes the rest of this module already
 * depends on. `connect/model.ts` stays generic; it never claims that shape is
 * a declaration contract on its own.
 *
 * {@link piAiSignInRoute} is the third, and the one that reaches furthest:
 * which provider route a given sign-in actually authenticates. `model.ts`
 * refuses that join in general and is right to — Harness publishes no
 * contract that a flow's credential scope and a directory entry's namespace
 * must correspond. But `dsh-llm-pi-ai` publishes it for ITSELF, in prose, on
 * both sides: `recordKeyFor(providerId)` documents its parameter as "pi-ai's
 * own provider id, which is also the harness route key", and
 * `directoryEntries` puts that same id at `providers.<id>` in this namespace.
 * Reading one adapter family's own documented identity is what this module is
 * for; asserting it of adapters in general is what `model.ts` refuses.
 * @module dshline/connect/pi-ai
 */

import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type { SettingsDescriptorRead, SettingsPathOp } from './harness.ts'
import type { ConnectAction, ConnectCapabilities, ConnectNewRouteTarget, ConnectProviderRow } from './model.ts'
import {
  dictKeyStrings,
  fieldNode,
  innerNode,
  isStringDict,
  leafAcceptance,
  numberConstraints,
  profileNode,
  resolveSchemaNode,
  unionConstStrings,
  unionHasConst,
} from './schema.ts'
import type { LeafAcceptance, LocatedProfile, SchemaEnvelope, SchemaNode } from './schema.ts'

/** The one namespace this module knows how to present curated fields for. */
export const PI_AI_NAMESPACE = 'llm-pi-ai'

/** `PiAiProviderProfile` field names this pass curates; see the module note for why only these. */
export const DISPLAY_NAME_FIELD = 'displayName'
export const BASE_URL_FIELD = 'baseURL'
export const API_FIELD = 'api'
export const HEADERS_FIELD = 'headers'
export const MODELS_FIELD = 'models'
export const MODEL_OVERRIDES_FIELD = 'modelOverrides'

/**
 * `PiAiModelProfile` fields this pass curates, in either a `models` entry or a
 * `modelOverrides` value. The two sites share every field but the id's home, so
 * one set of names serves both.
 */
export const NAME_FIELD = 'name'
export const CONTEXT_WINDOW_FIELD = 'contextWindow'
export const MAX_TOKENS_FIELD = 'maxTokens'
export const INPUT_FIELD = 'input'
export const REASONING_EFFORTS_FIELD = 'reasoningEfforts'

/** Whether a route row belongs to the one domain this module presents. */
export function isPiAiNamespace(settingsNs: string): boolean {
  return settingsNs === PI_AI_NAMESPACE
}

/**
 * One model entry's `reasoningEfforts` exactly as `llm-pi-ai` accepts it:
 * `false` disables reasoning, and a dict maps each offered level to its wire
 * spelling (or `null` for "supported, send no wire value"). WHICH levels may
 * carry `null` is the namespace owner's semantic rule, not this module's — the
 * schema's leaf shape is the only thing read here.
 */
export type ReasoningEffortsValue = false | Record<string, string | null>

/** One `PiAiModelProfile` entry, exactly as this pass curates it — never the whole shape. */
export interface CuratedModelFields {
  readonly id: string
  readonly name: string | undefined
  readonly contextWindow: number | undefined
  readonly maxTokens: number | undefined
  /** Declared modalities, or undefined to inherit. An empty list is read back as absent. */
  readonly input: readonly string[] | undefined
  /** The declared reasoning capability, or undefined to inherit the installed catalog's. */
  readonly reasoningEfforts: ReasoningEffortsValue | undefined
}

/**
 * One per-model field this pass curates, named by its profile key.
 *
 * The union is the write vocabulary: a `modelOverrides.<id>` edit addresses
 * exactly one of these paths, so the type is what keeps an override edit from
 * becoming a whole-object rewrite that could carry a stale sibling back.
 */
export type ModelCuratedField =
  | typeof NAME_FIELD
  | typeof CONTEXT_WINDOW_FIELD
  | typeof MAX_TOKENS_FIELD
  | typeof INPUT_FIELD
  | typeof REASONING_EFFORTS_FIELD

/** Every curated model field, in the order a form writes them. */
export const CURATED_MODEL_FIELDS: readonly ModelCuratedField[] = [
  NAME_FIELD,
  CONTEXT_WINDOW_FIELD,
  MAX_TOKENS_FIELD,
  INPUT_FIELD,
  REASONING_EFFORTS_FIELD,
]

/**
 * One curated field's current value, read off a curated view.
 *
 * The single place the field-name union meets the value object, so a caller
 * diffing or writing fields never re-enumerates them. An absent value stays
 * `undefined`, which is the "inherit/unset" spelling a path op uses.
 * @param fields - the curated view of an entry or override.
 * @param field - the field to read.
 * @returns the field's JSON-compatible value, or undefined when unset.
 */
export function curatedFieldValue(fields: CuratedModelFields, field: ModelCuratedField): unknown {
  switch (field) {
    case NAME_FIELD:
      return fields.name
    case CONTEXT_WINDOW_FIELD:
      return fields.contextWindow
    case MAX_TOKENS_FIELD:
      return fields.maxTokens
    case INPUT_FIELD:
      return fields.input === undefined ? undefined : [...fields.input]
    case REASONING_EFFORTS_FIELD:
      return fields.reasoningEfforts
  }
}

/**
 * Read one model entry's `input`/`reasoningEfforts` without assuming a shape.
 *
 * An absent array and an empty one are one statement — "no answer here" — which
 * is what lets a catalog model keep its installed modalities and its installed
 * reasoning capability. A dict is carried through as written, including an
 * empty one: that is a profile stating nothing, which Harness refuses on the
 * next write, and this frontend must show it rather than quietly repair it.
 * @param raw - the entry's raw value.
 * @returns the curated `input` and `reasoningEfforts`.
 */
function capabilityFields(raw: unknown): Pick<CuratedModelFields, 'input' | 'reasoningEfforts'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { input: undefined, reasoningEfforts: undefined }
  }
  const record = raw as Record<string, unknown>
  const rawInput = record[INPUT_FIELD]
  const input = Array.isArray(rawInput) && rawInput.length > 0 && rawInput.every(entry => typeof entry === 'string')
    ? [...rawInput] as string[]
    : undefined
  const rawReasoning = record[REASONING_EFFORTS_FIELD]
  return { input, reasoningEfforts: readReasoningEfforts(rawReasoning) }
}

/**
 * Read one `reasoningEfforts` value, keeping the three states apart.
 * @param raw - the stored value.
 * @returns `false`, a mapping, or undefined for "inherit/not stated".
 */
function readReasoningEfforts(raw: unknown): ReasoningEffortsValue | undefined {
  if (raw === false) return false
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const mapping: Record<string, string | null> = {}
  for (const [level, wire] of Object.entries(raw as Record<string, unknown>)) {
    if (wire === null || typeof wire === 'string') mapping[level] = wire
  }
  // Preserved even when empty: `{}` is a profile declaring nothing, which
  // Harness refuses, and echoing it back is how a reader sees that state.
  return mapping
}

/**
 * The curated fields the row-editor form shows, out of whatever a raw model
 * entry actually carries.
 *
 * Every other property on the entry — `compat`, anything a future pi-ai
 * release adds — is read past here rather than discarded: {@link mergeModelEntry}
 * is what carries them forward.
 * @param raw - one element of the profile's `models` array, whatever shape it is.
 * @returns the curated view, or undefined when the entry has no usable `id`.
 */
export function curatedModelFields(raw: unknown): CuratedModelFields | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const id = record.id
  if (typeof id !== 'string' || id === '') return undefined
  return {
    id,
    name: typeof record.name === 'string' ? record.name : undefined,
    contextWindow: typeof record.contextWindow === 'number' ? record.contextWindow : undefined,
    maxTokens: typeof record.maxTokens === 'number' ? record.maxTokens : undefined,
    ...capabilityFields(raw),
  }
}

/**
 * The curated view of one `modelOverrides.<id>` value, whose id is the dict key.
 *
 * The same field reading as {@link curatedModelFields} without requiring an
 * `id` in the value — an override carrying one is refused by `llm-pi-ai`, so a
 * hand-edited profile's stray key is read past rather than trusted. A
 * non-object value still yields an id-only view rather than vanishing: a stored
 * override the adapter cannot serve must stay visible for repair.
 * @param id - the dict key.
 * @param raw - the override value, whatever shape it is.
 * @returns the curated view.
 */
export function curatedOverrideFields(id: string, raw: unknown): CuratedModelFields {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { id, name: undefined, contextWindow: undefined, maxTokens: undefined, input: undefined, reasoningEfforts: undefined }
  }
  const record = raw as Record<string, unknown>
  return {
    id,
    name: typeof record.name === 'string' ? record.name : undefined,
    contextWindow: typeof record.contextWindow === 'number' ? record.contextWindow : undefined,
    maxTokens: typeof record.maxTokens === 'number' ? record.maxTokens : undefined,
    ...capabilityFields(raw),
  }
}

/**
 * The profile's raw `models` array, exactly as stored.
 *
 * An absent key and `[]` are the same request in `llm-pi-ai`: the schema
 * materializes `[]` for the absent case, and an empty catalog could serve no
 * request anyway, so both mean "serve the installed catalog". A caller
 * therefore asks whether the array has entries, never whether the key exists.
 * A non-empty array is the profile's explicit replacement for that catalog.
 * @param profile - the profile value at a route's `settingsPath`.
 * @returns the raw entries, or undefined when the field is not an array.
 */
export function rawModels(profile: unknown): readonly unknown[] | undefined {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined
  const value = (profile as Record<string, unknown>)[MODELS_FIELD]
  return Array.isArray(value) ? value : undefined
}

/**
 * The profile's raw `modelOverrides` dict, exactly as stored.
 *
 * Only a catalog route with no explicit `models` list may carry one, and each
 * key is an installed model id whose entry this overrides field by field. A
 * non-object answers an empty dict, which is the same "no overrides" the
 * absence means.
 * @param profile - the profile value at a route's `settingsPath`.
 * @returns the raw overrides, keyed by model id.
 */
export function rawModelOverrides(profile: unknown): Record<string, unknown> {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return {}
  const value = (profile as Record<string, unknown>)[MODEL_OVERRIDES_FIELD]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/**
 * The profile's raw `headers` object, exactly as stored.
 *
 * Unlike `models`, absent and empty mean the same thing here: nothing inherits
 * a header set, so a route with no `headers` key and a route with `{}` both
 * send none. That is why the editor unsets the field rather than writing an
 * empty object — see {@link unsetHeadersOp}.
 * @param profile - the profile value at a route's `settingsPath`.
 * @returns the raw value, or undefined when the field is unset or not an object.
 */
export function rawHeaders(profile: unknown): unknown {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined
  const value = (profile as Record<string, unknown>)[HEADERS_FIELD]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value
}

/** One model entry's field availability and vocabularies, derived from the schema alone. */
export interface ModelEntrySchema {
  /** Whether the entry still declares a `name` string. */
  readonly name: boolean
  /** `contextWindow` bounds when it is still a constrained number; undefined otherwise. */
  readonly contextWindow: { min?: number; step?: number } | undefined
  /** `maxTokens` bounds when it is still a constrained number; undefined otherwise. */
  readonly maxTokens: { min?: number; step?: number } | undefined
  /** Schema-derived modality vocabulary; empty when the field is not offered. */
  readonly input: readonly string[]
  /** Schema-derived reasoning-level vocabulary; empty when the field is not offered. */
  readonly reasoningLevels: readonly string[]
  /** Whether the schema still offers `reasoningEfforts: false`. */
  readonly reasoningCanDisable: boolean
  /**
   * What one level's mapping VALUE accepts, derived from the dict's element
   * schema. `undefined` means the leaf is not a primitive (`union` of them)
   * this form can render, so the mapping editor fails closed rather than
   * guessing; an all-false record means the leaf accepts nothing.
   */
  readonly reasoningWire: LeafAcceptance | undefined
}

/** Which model-catalog shapes one route's schema still describes. */
export interface RouteModelSchema {
  /** Whether `models` is still an array of entry objects. */
  readonly models: boolean
  /** Whether `modelOverrides` is still a dict of entry objects. */
  readonly overrides: boolean
  /** The shared entry field set, when either site is still readable. */
  readonly entry: ModelEntrySchema | undefined
}

/** Nothing readable — the answer for a schema that does not describe this route. */
const NO_MODEL_SCHEMA: RouteModelSchema = { models: false, overrides: false, entry: undefined }

/**
 * The model-catalog shapes one route's schema describes right now.
 *
 * Every choice and vocabulary a model form needs is read from here rather than
 * written down in this module: a pi-ai release that adds a modality, a thinking
 * level, or a new entry field is presented without a dshline change, and a
 * schema that stops describing one disables that control instead of writing a
 * value the namespace would refuse. The field NAMES are the one thing this
 * module is allowed to know, for the same reason `protocolChoices` knows `api`.
 * @param schema - the `llm-pi-ai` namespace's serialized schema.
 * @param routePath - path to the route's profile.
 * @returns the readable shapes; all absent when the schema cannot be walked.
 */
export function routeModelSchema(schema: unknown, routePath: readonly string[]): RouteModelSchema {
  const located = profileNode(schema, routePath)
  if (located === undefined) return NO_MODEL_SCHEMA
  const modelsNode = entryObjectNode(located, MODELS_FIELD)
  const overridesNode = entryObjectNode(located, MODEL_OVERRIDES_FIELD)
  const entryNode = modelsNode ?? overridesNode
  return {
    models: modelsNode !== undefined,
    overrides: overridesNode !== undefined,
    entry: entryNode === undefined ? undefined : entrySchema(entryNode, located.envelope),
  }
}

/**
 * The element node of a `models`/`modelOverrides` field, when it is an object.
 * @param located - the route's located profile.
 * @param field - the field name.
 * @returns the element node, or undefined when the field is not a collection of objects.
 */
function entryObjectNode(located: LocatedProfile, field: string): SchemaNode | undefined {
  const element = innerNode(fieldNode(located, field), located.envelope)
  return element?.type === 'object' ? element : undefined
}

/**
 * Read one entry object's field set and vocabularies.
 * @param node - the entry's object node.
 * @param envelope - the table every uid is looked up in.
 * @returns the derived field availability and choices.
 */
function entrySchema(node: SchemaNode, envelope: SchemaEnvelope): ModelEntrySchema {
  const located: LocatedProfile = { node, envelope }
  const reasoning = fieldNode(located, REASONING_EFFORTS_FIELD)
  const mapping = dictMember(reasoning, envelope)
  return {
    name: fieldNode(located, NAME_FIELD)?.type === 'string',
    contextWindow: numberConstraints(fieldNode(located, CONTEXT_WINDOW_FIELD)),
    maxTokens: numberConstraints(fieldNode(located, MAX_TOKENS_FIELD)),
    input: unionConstStrings(innerNode(fieldNode(located, INPUT_FIELD), envelope), envelope),
    reasoningLevels: dictKeyStrings(mapping, envelope),
    reasoningCanDisable: unionHasConst(reasoning, envelope, false),
    reasoningWire: leafAcceptance(innerNode(mapping, envelope), envelope),
  }
}

/**
 * The `dict` branch of a union that also carries a non-dict constant.
 *
 * `reasoningEfforts` is `union([const(false), dict])`, so the level vocabulary
 * lives on the dict member; a union of some other shape answers undefined and
 * the field is simply not offered.
 * @param node - the `reasoningEfforts` node.
 * @param envelope - the table every uid is looked up in.
 * @returns the dict member, or undefined when there is none.
 */
function dictMember(node: SchemaNode | undefined, envelope: SchemaEnvelope): SchemaNode | undefined {
  if (node === undefined) return undefined
  if (node.type === 'dict') return node
  if (node.type !== 'union') return undefined
  for (const member of node.list ?? []) {
    const resolved = resolveSchemaNode(member, envelope)
    if (resolved?.type === 'dict') return resolved
  }
  return undefined
}

/**
 * Merge curated edits onto whatever a model entry already carried.
 *
 * The retained object is the source of unknown-field survival: spreading it
 * first and the curated fields second keeps `compat`, `headers`, and anything
 * else this pass does not render, while still letting a curated edit win. A
 * curated field cleared back to undefined is deleted rather than written as
 * `null` or literal `undefined` — `settings.mutate` accepts only JSON-compatible
 * data, and a stored `null` would read back as configured-to-nothing rather
 * than as inherited.
 * @param retained - the entry's previous raw shape, when one existed.
 * @param curated - the fields the editor changed.
 * @returns the entry to write, JSON-compatible.
 */
export function mergeModelEntry(
  retained: Record<string, unknown> | undefined,
  curated: CuratedModelFields,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...retained, id: curated.id }
  applyCuratedFields(next, curated)
  return next
}

/**
 * Merge curated edits onto a `modelOverrides.<id>` value.
 *
 * The id lives in the dict key, so a value carrying its own is refused by
 * `llm-pi-ai` — this strips one a hand-edited profile may have stored as well
 * as the `id` {@link mergeModelEntry} always stamps, so an override can never
 * carry a stray rename.
 * @param retained - the override's previous raw shape, when one existed.
 * @param curated - the fields the editor changed.
 * @returns the override value to write, JSON-compatible.
 */
export function mergeOverrideEntry(
  retained: Record<string, unknown> | undefined,
  curated: CuratedModelFields,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...retained }
  delete next.id
  applyCuratedFields(next, curated)
  return next
}

/**
 * Write every curated field onto a raw entry, deleting the ones cleared.
 * @param target - the object being built.
 * @param curated - the curated values.
 */
function applyCuratedFields(target: Record<string, unknown>, curated: CuratedModelFields): void {
  setOrDelete(target, NAME_FIELD, curated.name)
  setOrDelete(target, CONTEXT_WINDOW_FIELD, curated.contextWindow)
  setOrDelete(target, MAX_TOKENS_FIELD, curated.maxTokens)
  setOrDelete(target, INPUT_FIELD, curated.input === undefined ? undefined : [...curated.input])
  setOrDelete(target, REASONING_EFFORTS_FIELD, curated.reasoningEfforts)
}

/**
 * Write a field, or remove it when the curated value is absent.
 * @param target - the object being built.
 * @param key - the field name.
 * @param value - the curated value, or undefined to omit it.
 */
function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}

/**
 * Wire protocols the `api` field's own schema currently offers.
 * @param schema - the `llm-pi-ai` namespace's serialized schema.
 * @param routePath - path to the route's profile (an existing route's
 *   `settingsPath`, or a new route's `[...parentPath, id]` — a `dict` node
 *   answers the same shape for a key it has never seen).
 * @returns the offered protocol strings, in schema order; empty when the
 *   schema does not shape the field as a union of string consts.
 */
export function protocolChoices(schema: unknown, routePath: readonly string[]): string[] {
  const located = profileNode(schema, routePath)
  if (located === undefined) return []
  const node = fieldNode(located, API_FIELD)
  return unionConstStrings(node, located.envelope)
}

/**
 * Whether this route's `headers` field is still shaped as a map of text.
 *
 * The same fail-closed reading {@link protocolChoices} makes, for the same
 * reason: the field NAME is knowledge this module is allowed to hold, but its
 * SHAPE is the schema's to publish, and a namespace that reshaped it — dropped
 * it, made its values structured — must produce no header editor rather than a
 * form whose write `settings.mutate` would refuse. A route whose schema this
 * walk cannot read at all answers false for the same reason.
 * @param schema - the `llm-pi-ai` namespace's serialized schema.
 * @param routePath - path to the route's profile (an existing route's
 *   `settingsPath`, or a new route's `[...parentPath, id]`).
 * @returns true when the field can be curated as a dict of strings.
 */
export function headersCurated(schema: unknown, routePath: readonly string[]): boolean {
  const located = profileNode(schema, routePath)
  if (located === undefined) return false
  return isStringDict(fieldNode(located, HEADERS_FIELD), located.envelope)
}

/** One field-level change to a route's curated, non-model profile. */
export interface CuratedFieldChange {
  readonly field: string
  /** The new value, or undefined to unset the field back to inherited/absent. */
  readonly value: string | undefined
}

/**
 * Path ops for a set of curated field changes against an EXISTING route.
 *
 * One op per changed field, each addressed under the route's own path — never
 * a wholesale replace, so a sibling field this pass does not render (`compat`,
 * `retryPolicy`, `thinkingBudgets`, …) is untouched by construction rather than
 * by care taken while building a bigger object.
 * @param routePath - the route's `settingsPath`.
 * @param changes - the fields that changed, already diffed against the read profile.
 * @returns the ops, in the order given.
 */
export function fieldOps(routePath: readonly string[], changes: readonly CuratedFieldChange[]): SettingsPathOp[] {
  return changes.map(change => change.value === undefined
    ? { op: 'unset', path: [...routePath, change.field] }
    : { op: 'set', path: [...routePath, change.field], value: change.value })
}

/**
 * One op replacing a route's whole `models` array.
 * @param routePath - the route's `settingsPath`.
 * @param entries - the entries to write, already merged by {@link mergeModelEntry}.
 * @returns the op.
 */
export function setModelsOp(routePath: readonly string[], entries: readonly Record<string, unknown>[]): SettingsPathOp {
  return { op: 'set', path: [...routePath, MODELS_FIELD], value: entries }
}

/**
 * One op replacing a route's whole `headers` map.
 *
 * Whole rather than per-header, unlike {@link fieldOps}: the editor renders
 * every pair the field holds, so there is no unrendered sibling to preserve
 * here — and a per-key write would need a matching `unset` for each removal,
 * which is more ops to say the same thing.
 * @param routePath - the route's `settingsPath`.
 * @param headers - the map to write; never empty, see {@link unsetHeadersOp}.
 * @returns the op.
 */
export function setHeadersOp(routePath: readonly string[], headers: Record<string, string>): SettingsPathOp {
  return { op: 'set', path: [...routePath, HEADERS_FIELD], value: headers }
}

/**
 * The op that removes a route's request headers entirely.
 *
 * `unset`, never `set` with `{}`, and for the opposite reason to
 * {@link unsetModelsOp}'s: an empty header map and an absent one are the same
 * route — nothing inherits headers — so writing `{}` would leave a key in
 * `settings.yaml` that says nothing the absent key did not already say.
 * @param routePath - the route's `settingsPath`.
 * @returns the op.
 */
export function unsetHeadersOp(routePath: readonly string[]): SettingsPathOp {
  return { op: 'unset', path: [...routePath, HEADERS_FIELD] }
}

/**
 * The op that resets a route's model catalog back to its owning adapter's.
 *
 * `unset`, never `set` with `[]`. The two are the same request to `llm-pi-ai` —
 * the schema materializes `[]` for the absent case, so both mean "serve the
 * installed catalog" — but only `unset` removes the key, leaving a
 * `settings.yaml` that says what it means instead of an empty array a reader
 * has to know is equivalent.
 * @param routePath - the route's `settingsPath`.
 * @returns the op.
 */
export function unsetModelsOp(routePath: readonly string[]): SettingsPathOp {
  return { op: 'unset', path: [...routePath, MODELS_FIELD] }
}

/**
 * One op creating a whole `modelOverrides.<id>` that did NOT exist at open.
 *
 * Deliberately not the general edit path. An override the route already
 * carried is edited field by field through {@link setOverrideFieldOp}, because
 * only the fields a reader actually touched may be written — a whole-object
 * `set` would carry the open-time copy of every field it never rendered back
 * over a concurrent edit. There is no sibling to preserve on the id's first
 * appearance, so one whole-value `set` is the honest spelling for it.
 * @param routePath - the route's `settingsPath`.
 * @param id - the installed model id, which is the dict key.
 * @param value - the override value, already merged by {@link mergeOverrideEntry}.
 * @returns the op.
 */
export function setNewOverrideOp(
  routePath: readonly string[],
  id: string,
  value: Record<string, unknown>,
): SettingsPathOp {
  return { op: 'set', path: [...routePath, MODEL_OVERRIDES_FIELD, id], value }
}

/**
 * One op addressing exactly one curated field of an existing override.
 *
 * The narrowest owned path the settings seam can express, so a conflict-time
 * second save reapplies only what the reader edited and leaves every other
 * field — curated or unknown — at whatever the current revision holds. An
 * undefined value unsets the key, which is how a field is returned to
 * inheritance rather than stored as `null`.
 * @param routePath - the route's `settingsPath`.
 * @param id - the installed model id.
 * @param field - the curated field to write.
 * @param value - the field's value, or undefined to unset it.
 * @returns the op.
 */
export function setOverrideFieldOp(
  routePath: readonly string[],
  id: string,
  field: ModelCuratedField,
  value: unknown,
): SettingsPathOp {
  const path = [...routePath, MODEL_OVERRIDES_FIELD, id, field]
  return value === undefined ? { op: 'unset', path } : { op: 'set', path, value }
}

/**
 * The op that removes one installed-catalog model's override.
 *
 * `unset` on the exact id, so removing the last override leaves an empty dict
 * the schema reads as "no overrides" — no whole-dict write that could drop a
 * sibling this pass never showed.
 * @param routePath - the route's `settingsPath`.
 * @param id - the installed model id.
 * @returns the op.
 */
export function unsetOverrideOp(routePath: readonly string[], id: string): SettingsPathOp {
  return { op: 'unset', path: [...routePath, MODEL_OVERRIDES_FIELD, id] }
}

/** Every curated field a brand-new route's profile may set. */
export interface NewRouteProfile {
  readonly displayName: string | undefined
  readonly baseURL: string
  readonly api: string
  /** Request headers the form collected; omitted from the write when empty. */
  readonly headers: Record<string, string>
  readonly models: readonly CuratedModelFields[]
  /** The schema-discovered credential-reference field, when the schema names one. */
  readonly credentialField: string | undefined
  readonly credentialRef: string | undefined
}

/**
 * One `set` op declaring a brand-new route, whole.
 *
 * Unlike an edit, a new key has no prior value to preserve a sibling of, so
 * one op is the whole write — the same reason {@link activateRoute} in
 * `actions.ts` writes a single object for a route that does not exist yet.
 * @param routePath - `[...parentPath, id]` for the new route.
 * @param profile - the fields the create form collected.
 * @returns the op.
 */
export function createRouteOp(routePath: readonly string[], profile: NewRouteProfile): SettingsPathOp {
  const value: Record<string, unknown> = { [BASE_URL_FIELD]: profile.baseURL, [API_FIELD]: profile.api }
  if (profile.displayName !== undefined) value[DISPLAY_NAME_FIELD] = profile.displayName
  if (profile.credentialField !== undefined && profile.credentialRef !== undefined) {
    value[profile.credentialField] = profile.credentialRef
  }
  // Absent rather than `{}` when none were typed, for the reason
  // `unsetHeadersOp` gives: the two say the same thing, and only one of them
  // leaves a key in `settings.yaml` for a reader to wonder about later.
  if (Object.keys(profile.headers).length > 0) value[HEADERS_FIELD] = profile.headers
  value[MODELS_FIELD] = profile.models.map(model => mergeModelEntry(undefined, model))
  return { op: 'set', path: routePath, value }
}

/**
 * The one action `rowActions` cannot offer: opening the curated editor.
 *
 * `model.ts` stays generic on purpose, so "edit route" is not one of its
 * offers — no seam publishes which fields are worth curating for a route in
 * general. This is the one place that gap is closed, and only for the
 * domain this module presents: a row from any other namespace gets nothing
 * added, and falls back to whatever `rowActions` already offered.
 * @param row - the selected provider row.
 * @param capabilities - which optional seams this deployment mounts.
 * @returns zero or one action, to append to `rowActions`'s own offer.
 */
export function extraActions(row: ConnectProviderRow, capabilities: ConnectCapabilities): ConnectAction[] {
  if (!isPiAiNamespace(row.settingsNs)) return []
  if (!capabilities.settings || row.revision === undefined || row.settingsPath.length === 0) return []
  return [{
    id: 'edit-route',
    label: 'Edit route',
    description: 'Opens the curated editor for this route’s base URL, protocol, request headers, and model catalog',
  }]
}

/**
 * Whether every entry's route sits under the same parent segments.
 * @param entries - directory entries, assumed already filtered to one namespace.
 * @returns the shared parent path, or undefined when there is none to agree on.
 */
function sameParent(entries: readonly LlmConfigurableProvider[]): readonly string[] | undefined {
  let parent: readonly string[] | undefined
  for (const entry of entries) {
    if (entry.settingsPath.length === 0) return undefined
    const candidate = entry.settingsPath.slice(0, -1)
    if (parent === undefined) {
      parent = candidate
    } else if (parent.length !== candidate.length || !parent.every((segment, index) => segment === candidate[index])) {
      // Entries in this namespace disagreeing about where their dict sits
      // would mean the namespace addresses routes two different ways; neither
      // address is safe to assume for a route that does not exist yet.
      return undefined
    }
  }
  return parent
}

/**
 * Where a brand-new `llm-pi-ai` route could be declared, when this module can
 * actually service the declaration end to end.
 *
 * Five things have to hold, and any one failing means the schema drifted from
 * what this presentation module knows how to read — the honest answer is to
 * offer nothing rather than a `+ Add custom provider` row that is guaranteed
 * to fail partway through the wizard, which is exactly the "never offer an
 * action known to fail" rule the rest of Connect already follows:
 *
 * 1. every existing `llm-pi-ai` directory entry agrees on where its dict of
 *    routes sits — disagreement means there is no one address to assume for a
 *    route that does not exist yet;
 * 2. the schema shapes that address as a `dict`, so an unseen key answers the
 *    same shape as an existing one;
 * 3. the curated `baseURL` field is still reachable there;
 * 4. the curated `models` field is still reachable there too —
 *    {@link "./route-editor.ts".runCreateRoute} always writes one, so a schema
 *    that stopped describing it would accept the row and then fail the write;
 * 5. the `api` field is still a union of string consts this module can offer
 *    as protocol choices — this is deliberately the same schema-shape check
 *    {@link protocolChoices} makes, because a namespace this module cannot
 *    offer a protocol for is one it cannot safely declare a route into either.
 *
 * A credential-reference field is deliberately NOT on this list. Its absence
 * is a supported state — a route with nowhere to store a key still has an
 * endpoint, a protocol, and a model list — so `runCreateRoute` reads it itself
 * and adjusts what it asks for, rather than this gate disabling creation
 * outright over a field only the API-key step needs. What it must never do is
 * accept a typed key it then has nowhere to put; see the note on
 * {@link "./route-editor.ts".runCreateRoute} for how that is kept from
 * happening.
 *
 * This is where the one Harness-specific fact this module knows — that
 * `llm-pi-ai` is a domain whose settings profile can describe a whole
 * provider route — is allowed to matter. A schema merely SHAPING a dict of
 * objects is not that fact by itself: a future adapter could publish
 * `providers: dict<ProviderConfig>` while still only recognizing a fixed set
 * of keys, and nothing about that shape alone would say otherwise. Restricting
 * this check to entries already known to belong to `llm-pi-ai` is what keeps
 * the inference honest rather than reading "arbitrary keys are structurally
 * accepted" as "arbitrary keys declare a new LLM route."
 * @param directory - every configurable-provider entry Harness published.
 * @param descriptors - every namespace descriptor, keyed by namespace.
 * @returns the one target this module can service, or undefined.
 */
export function piAiDeclarationTarget(
  directory: readonly LlmConfigurableProvider[],
  descriptors: ReadonlyMap<string, SettingsDescriptorRead>,
): ConnectNewRouteTarget | undefined {
  const entries = directory.filter(entry => isPiAiNamespace(entry.settingsNs))
  const sample = entries[0]
  if (sample === undefined) return undefined
  const parentPath = sameParent(entries)
  if (parentPath === undefined || parentPath.length === 0) return undefined
  const descriptor = descriptors.get(PI_AI_NAMESPACE)
  if (profileNode(descriptor?.schema, parentPath)?.node.type !== 'dict') return undefined
  const routeNode = profileNode(descriptor?.schema, sample.settingsPath)
  if (fieldNode(routeNode, BASE_URL_FIELD) === undefined) return undefined
  if (fieldNode(routeNode, MODELS_FIELD) === undefined) return undefined
  if (protocolChoices(descriptor?.schema, sample.settingsPath).length === 0) return undefined
  return { settingsNs: PI_AI_NAMESPACE, parentPath, revision: descriptor?.revision }
}

/**
 * The scope of the credential records this adapter family's authorization
 * flows write.
 *
 * Spelled as its own constant even though it is the same string as
 * {@link PI_AI_NAMESPACE}, because it is a different fact about a different
 * store. `RECORD_SCOPE` in `dsh-llm-pi-ai`'s `auth.ts` is documented as "the
 * plugin's registered name", and the plugin's `export const name` happens to
 * equal the settings namespace it installs. Two facts that agree today are
 * still two facts: folding them into one constant would quietly turn a
 * coincidence into an assumption, and the day upstream renames one the join
 * below should stop matching rather than address the wrong route.
 */
export const PI_AI_RECORD_SCOPE = 'llm-pi-ai'

/**
 * The provider route one `llm-pi-ai` sign-in actually authenticates.
 *
 * `connect/model.ts` refuses to join the two row kinds in general, and stays
 * right to: a flow is addressed by a `CredentialKey` whose scope is its
 * owning plugin's registered name, a directory entry by `settingsNs` plus a
 * route key, and Harness publishes no contract that the two must correspond.
 * That refusal is about the GENERAL case. For the one domain this module
 * already presents, upstream states the correspondence outright:
 * `registerPiAiFlows` keys every flow it registers at
 * `recordKeyFor(providerId)` — `<RECORD_SCOPE>/<providerId>` — where
 * `recordKeyFor`'s own parameter documentation calls `providerId` "pi-ai's own
 * provider id, WHICH IS ALSO THE HARNESS ROUTE KEY", and `directoryEntries`
 * publishes that same id as `provider` at `providers.<providerId>` in this
 * namespace.
 *
 * So this is a reading of one adapter family's documented identity, not an
 * inference from shape — which is exactly the kind of knowledge this module
 * exists to hold and `model.ts` exists not to. It is also verified rather
 * than assumed: a key is only ever resolved against routes the directory
 * ACTUALLY published, so a scope that stopped naming this namespace, an id
 * outside it, or a namespace that started addressing its routes somewhere
 * other than `providers.<id>` all answer undefined and leave the sign-in
 * standing alone, exactly as it does today.
 * @param key - the sign-in's `<scope>/<id>` credential record address.
 * @param providers - every provider row the same reading produced.
 * @returns the route this sign-in authenticates, or undefined when nothing
 *   published here can be said to correspond to it.
 */
export function piAiSignInRoute(
  key: string,
  providers: readonly ConnectProviderRow[],
): ConnectProviderRow | undefined {
  // Split at the FIRST separator only: a record id may not contain one, so a
  // second separator means this is not an address this module can read.
  const separator = key.indexOf('/')
  if (separator <= 0) return undefined
  const scope = key.slice(0, separator)
  const id = key.slice(separator + 1)
  if (scope !== PI_AI_RECORD_SCOPE || id === '' || id.includes('/')) return undefined
  return providers.find(row => row.provider === id
    && isPiAiNamespace(row.settingsNs)
    // The address as well as the key. `directoryEntries` publishes
    // `providers.<id>`, and a namespace that started addressing its routes
    // anywhere else is one this join has no business claiming to understand —
    // activating the wrong path would replace a profile that is not this
    // sign-in's.
    && row.settingsPath.length > 0
    && row.settingsPath.at(-1) === id)
}
