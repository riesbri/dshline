/**
 * Reading a provider profile out of a namespace's serialized settings schema.
 *
 * This is the part of Connect that keeps it provider-neutral. The naive way to
 * offer "set an API key" is to write `apiKeyEnv` into the profile, which is
 * what the field happens to be called in both adapters shipped today — and is
 * exactly the hard-coded provider knowledge this frontend must not hold.
 *
 * Harness already publishes the answer. A settings namespace registers a
 * schemastery schema, and a field that carries a credential REFERENCE is
 * declared `z.string().role('credential-ref')` — `llm-pi-ai`, `llm-deepseek`,
 * and `web-search-deepseek` all mark theirs that way. `ctx.settings.describe()`
 * hands back `schema.toJSON()`, so the role travels with the descriptor and an
 * adapter that calls its field something else is served without a code change.
 *
 * The serialized form is `{ uid, refs }`: every node lives in `refs` under its
 * own uid, and a nested node appears as that uid rather than inline, because
 * schemastery preserves shared and recursive references. So walking it means
 * resolving a number at each step, which is all {@link resolveNode} does.
 *
 * The rest of this module is the same walk applied to SHAPE, not just names:
 * a union's string constants (a protocol or modality vocabulary), a dict's
 * declared key schema (a reasoning-level vocabulary), a dict's element schema
 * (what one mapping value accepts), a number's `min`/`step`, and which
 * properties exist at all. A caller decides what a field is CALLED; everything
 * about what it accepts comes from here, and a shape this walk cannot classify
 * answers "unreadable" so the caller can fail closed rather than guess.
 * @module dshline/connect/schema
 */

/** A serialized schemastery node, as far as this walk needs to understand one. */
export interface SchemaNode {
  /** Node kind: `object`, `dict`, `array`, `union`, `intersect`, `string`, `const`, … */
  type?: string
  /** UI and validation metadata, including the renderer role. */
  meta?: { role?: unknown }
  /** `object` properties, keyed by property name. */
  dict?: Record<string, unknown>
  /** `dict` and `array` element schema. */
  inner?: unknown
  /** A `dict`'s key schema; a plain string when the schema does not constrain keys. */
  sKey?: unknown
  /** `union` and `intersect` members. */
  list?: readonly unknown[]
  /** The one value a `const` node accepts. */
  value?: unknown
}

/** The serialized envelope `schema.toJSON()` produces. */
export interface SchemaEnvelope {
  /** Uid of the root node. */
  uid: number
  /** Every node reachable from the root, keyed by uid. */
  refs: Record<string, unknown>
}

/** The role a settings schema marks a credential-reference field with. */
export const CREDENTIAL_REF_ROLE = 'credential-ref'

/**
 * Whether a value is a plain object this walk may look inside.
 * @param value - the candidate.
 * @returns true when it is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the envelope out of a descriptor's `schema`, when it is one.
 * @param schema - the serialized schema from `ctx.settings.describe()`.
 * @returns the envelope, or undefined when the value is not one.
 */
function envelopeOf(schema: unknown): SchemaEnvelope | undefined {
  if (!isRecord(schema)) return undefined
  const { uid, refs } = schema
  if (typeof uid !== 'number' || !isRecord(refs)) return undefined
  return { uid, refs }
}

/**
 * Resolve one node reference against the envelope's table.
 *
 * A reference is a uid, but an envelope produced by another build — or a node
 * a future serializer chooses to inline — may be the node itself, so both are
 * accepted rather than one being assumed.
 * @param reference - a uid, or an inline node.
 * @param envelope - the table every uid is looked up in.
 * @returns the node, or undefined when the reference resolves to nothing.
 */
function resolveNode(reference: unknown, envelope: SchemaEnvelope): SchemaNode | undefined {
  if (typeof reference === 'number') {
    const found = envelope.refs[String(reference)]
    return isRecord(found) ? found : undefined
  }
  return isRecord(reference) ? reference : undefined
}

/**
 * Resolve one node reference against the envelope's table.
 *
 * The exported companion to the private walk step, for a caller that needs to
 * inspect a node's members directly — a `union` whose branches it must classify
 * itself, rather than one of the fixed shapes the other helpers recognize.
 * @param reference - a uid, or an inline node.
 * @param envelope - the table every uid is looked up in.
 * @returns the node, or undefined when the reference resolves to nothing.
 */
export function resolveSchemaNode(reference: unknown, envelope: SchemaEnvelope): SchemaNode | undefined {
  return resolveNode(reference, envelope)
}

/**
 * Follow one path segment into a node.
 *
 * A dict or array segment is a concrete key or index that the schema describes
 * with ONE element node, so the segment is consumed by moving to `inner`
 * without being matched against anything — which is what makes
 * `['providers', 'openrouter']` reach a route the schema never names.
 * @param node - the node to descend from.
 * @param segment - the path segment to follow.
 * @param envelope - the table every uid is looked up in.
 * @returns the child node, or undefined when the path leaves the schema.
 */
function descend(node: SchemaNode, segment: string, envelope: SchemaEnvelope): SchemaNode | undefined {
  switch (node.type) {
    case 'object':
      return resolveNode(node.dict?.[segment], envelope)
    case 'dict':
    case 'array':
      return resolveNode(node.inner, envelope)
    case 'union':
    case 'intersect': {
      // A profile described as a union or an intersection has no single child;
      // the first member that can follow the segment answers for all of them.
      for (const member of node.list ?? []) {
        const resolved = resolveNode(member, envelope)
        const next = resolved === undefined ? undefined : descend(resolved, segment, envelope)
        if (next !== undefined) return next
      }
      return undefined
    }
    default:
      return undefined
  }
}

/** One profile's node, kept with the table its children resolve through. */
export interface LocatedProfile {
  /** The profile's own serialized node. */
  readonly node: SchemaNode
  /** The envelope every nested uid is looked up in. */
  readonly envelope: SchemaEnvelope
}

/**
 * The schema node one configurable provider's profile is described by.
 * @param schema - the namespace's serialized schema.
 * @param path - `LlmConfigurableProvider.settingsPath`; empty means the section root.
 * @returns the profile's node and its table, or undefined when the schema does
 *   not describe that path.
 */
export function profileNode(schema: unknown, path: readonly string[]): LocatedProfile | undefined {
  const envelope = envelopeOf(schema)
  if (envelope === undefined) return undefined
  let node = resolveNode(envelope.uid, envelope)
  for (const segment of path) {
    if (node === undefined) return undefined
    node = descend(node, segment, envelope)
  }
  return node === undefined ? undefined : { node, envelope }
}

/**
 * Property names in a profile that carry a credential reference.
 *
 * Plural because nothing stops a schema declaring two; the caller takes the
 * first and Connect says which one it used rather than guessing which of
 * several a person meant. An intersection is flattened, since that is how a
 * schema composes a shared field set with a specific one.
 * @param located - the profile {@link profileNode} found.
 * @returns the property names, in declaration order.
 */
export function credentialRefFields(located: LocatedProfile | undefined): string[] {
  if (located === undefined) return []
  return fieldsIn(located.node, located.envelope, new Set())
}

/**
 * Walk one node for credential-reference properties.
 * @param node - the node to inspect.
 * @param envelope - the table every uid is looked up in.
 * @param seen - uids already visited, so a recursive schema terminates.
 * @returns the property names, in declaration order.
 */
function fieldsIn(node: SchemaNode, envelope: SchemaEnvelope, seen: Set<unknown>): string[] {
  if (node.type === 'object') {
    const found: string[] = []
    for (const [property, reference] of Object.entries(node.dict ?? {})) {
      const child = resolveNode(reference, envelope)
      if (child?.meta?.role === CREDENTIAL_REF_ROLE) found.push(property)
    }
    return found
  }
  if (node.type === 'intersect' || node.type === 'union') {
    const found: string[] = []
    for (const member of node.list ?? []) {
      if (seen.has(member)) continue
      seen.add(member)
      const resolved = resolveNode(member, envelope)
      if (resolved !== undefined) found.push(...fieldsIn(resolved, envelope, seen))
    }
    return found
  }
  return []
}

/**
 * The schema node for one named field of a located profile.
 *
 * The one step {@link profileNode} does not take: a profile's node answers
 * what the WHOLE route looks like, and a caller reading one field — the
 * credential reference is the other case, but it is found by role rather than
 * by name — still needs to descend into it by the field's own name.
 * @param located - the profile {@link profileNode} found.
 * @param field - the property name to descend into.
 * @returns the field's node, or undefined when the schema does not describe it.
 */
export function fieldNode(located: LocatedProfile | undefined, field: string): SchemaNode | undefined {
  if (located === undefined) return undefined
  return descend(located.node, field, located.envelope)
}

/**
 * String choices a `union`-of-`const` node offers, when it is shaped that way.
 *
 * This is how a protocol picker learns its choices without importing anything
 * about the adapter that published them: `z.union(['a', 'b'])` serializes as a
 * `union` node whose `list` members are each a `const` node carrying one
 * string, and that shape is generic schemastery vocabulary, not knowledge of
 * any one namespace. A field the owning schema did not build this way (a plain
 * `z.string()`, say) answers with an empty list, which is this walk's honest
 * way of saying the schema offers no fixed choice — the caller falls back to
 * free text rather than inventing one.
 * @param node - the field's own node, typically found via {@link profileNode}
 *   plus one more {@link descend} step onto the field name.
 * @param envelope - the table every uid is looked up in.
 * @returns the offered strings, in schema order; empty when the node is not a
 *   union of string consts.
 */
export function unionConstStrings(node: SchemaNode | undefined, envelope: SchemaEnvelope): string[] {
  if (node?.type !== 'union') return []
  const found: string[] = []
  for (const member of node.list ?? []) {
    const resolved = resolveNode(member, envelope)
    if (resolved?.type !== 'const') return []
    const value = (resolved as { value?: unknown }).value
    if (typeof value !== 'string') return []
    found.push(value)
  }
  return found
}

/**
 * Every value a `union`-of-`const` node accepts, whatever type the constants are.
 *
 * The typed companion to {@link unionConstStrings}: a schema may union a
 * non-string constant with a structured branch — `llm-pi-ai`'s
 * `reasoningEfforts` unions `const(false)` with a dict — and a caller deciding
 * which BRANCHES exist needs those values without assuming strings.
 * @param node - the union node.
 * @param envelope - the table every uid is looked up in.
 * @returns the constant values, in schema order; empty when some member is not
 *   a `const` node.
 */
export function unionConstValues(node: SchemaNode | undefined, envelope: SchemaEnvelope): unknown[] {
  if (node?.type !== 'union') return []
  const found: unknown[] = []
  for (const member of node.list ?? []) {
    const resolved = resolveNode(member, envelope)
    if (resolved?.type !== 'const') return []
    found.push(resolved.value)
  }
  return found
}

/**
 * The fixed key vocabulary a `dict` node describes, when it declares one.
 *
 * `z.dict(value, keys)` serializes the key schema at `sKey`; when that schema
 * is a union of string consts the dict admits exactly those keys, which is how
 * a reasoning-level vocabulary travels from the owning adapter to this
 * frontend without either side hard-coding it. A dict of open keys (a plain
 * `z.dict(z.string())`, say) or one this walk cannot read answers with an
 * empty list, the honest "no fixed vocabulary here" a caller falls back from.
 * @param node - the field's own node, typically a `dict`.
 * @param envelope - the table every uid is looked up in.
 * @returns the key strings, in schema order; empty when none are declared.
 */
export function dictKeyStrings(node: SchemaNode | undefined, envelope: SchemaEnvelope): string[] {
  if (node?.type !== 'dict') return []
  return unionConstStrings(resolveNode(node.sKey, envelope), envelope)
}

/**
 * The one node a `dict` or `array` describes all of its entries with.
 *
 * A dict segment and an array index are both answered by a single element
 * schema, so this is the step that turns "the `models` field" into "one model
 * entry" or "the `modelOverrides` dict" into "one override value."
 * @param node - the `dict` or `array` node.
 * @param envelope - the table every uid is looked up in.
 * @returns the element node, or undefined for any other node kind.
 */
export function innerNode(node: SchemaNode | undefined, envelope: SchemaEnvelope): SchemaNode | undefined {
  if (node?.type !== 'dict' && node?.type !== 'array') return undefined
  return resolveNode(node.inner, envelope)
}

/**
 * The numeric constraints a `number` schema declares, when it is one.
 *
 * `z.number().step(1).min(1)` serializes its bounds into `meta`; reading them
 * lets a form state the same floor the owning schema enforces instead of
 * discovering it at a refused write. A `number` with no recorded bounds
 * answers an empty object, and any non-number node answers undefined so a
 * caller can tell "a number field with no bounds" from "not a number field."
 * @param node - the field's own node.
 * @returns the declared `min`/`step`, or undefined when the node is not a number.
 */
export function numberConstraints(node: SchemaNode | undefined): { min?: number; step?: number } | undefined {
  if (node?.type !== 'number') return undefined
  const meta = node.meta as { min?: unknown; step?: unknown } | undefined
  return {
    ...typeof meta?.min === 'number' ? { min: meta.min } : {},
    ...typeof meta?.step === 'number' ? { step: meta.step } : {},
  }
}

/**
 * Whether a `union` node offers one exact constant.
 *
 * The companion to {@link unionConstValues} for a caller that only needs to
 * know a branch EXISTS — `llm-pi-ai`'s `reasoningEfforts` offering `false` is
 * what makes an explicit "this model does not reason" state expressible.
 * @param node - the union node.
 * @param envelope - the table every uid is looked up in.
 * @param value - the constant to look for, compared by `Object.is`.
 * @returns true when some member is a `const` carrying that value.
 */
export function unionHasConst(node: SchemaNode | undefined, envelope: SchemaEnvelope, value: unknown): boolean {
  if (node?.type !== 'union') return false
  return (node.list ?? []).some((member) => {
    const resolved = resolveNode(member, envelope)
    return resolved?.type === 'const' && Object.is(resolved.value, value)
  })
}

/** Which primitive JSON kinds one schema leaf accepts. */
export interface LeafAcceptance {
  /** Whether the leaf accepts a string. */
  readonly string: boolean
  /** Whether the leaf accepts a number. */
  readonly number: boolean
  /** Whether the leaf accepts a boolean. */
  readonly boolean: boolean
  /** Whether the leaf accepts `null`. */
  readonly null: boolean
}

/** A leaf that accepts nothing this walk recognizes. */
const NOTHING_ACCEPTED: LeafAcceptance = { string: false, number: false, boolean: false, null: false }

/**
 * The primitive kinds one `const` node's value belongs to.
 * @param value - the constant's value.
 * @returns the accepted kinds, or undefined when it is not a primitive.
 */
function acceptanceOfConst(value: unknown): LeafAcceptance | undefined {
  if (value === null) return { ...NOTHING_ACCEPTED, null: true }
  if (typeof value === 'string') return { ...NOTHING_ACCEPTED, string: true }
  if (typeof value === 'number') return { ...NOTHING_ACCEPTED, number: true }
  if (typeof value === 'boolean') return { ...NOTHING_ACCEPTED, boolean: true }
  return undefined
}

/**
 * Which primitive kinds a leaf schema accepts, when it is one.
 *
 * The value-side companion to {@link dictKeyStrings}: `llm-pi-ai`'s
 * `reasoningEfforts` maps each offered level to `union([z.string(),
 * z.const(null)])`, and a form that means to edit a leaf as text-or-nothing
 * must learn that from the schema rather than from the field's name. A union
 * of recognizable primitives merges their kinds; a structured member, an
 * intersection, an `any`, or a node this walk cannot classify answers
 * `undefined`, which is how a caller fails closed instead of guessing at a
 * shape it does not understand. An empty union accepts nothing and answers the
 * all-false record rather than `undefined`.
 * @param node - the leaf node itself, typically a `dict`'s `inner`.
 * @param envelope - the table every uid is looked up in.
 * @returns the accepted primitive kinds, or undefined when the shape is unrecognized.
 */
export function leafAcceptance(node: SchemaNode | undefined, envelope: SchemaEnvelope): LeafAcceptance | undefined {
  if (node === undefined) return undefined
  switch (node.type) {
    case 'string':
      return { ...NOTHING_ACCEPTED, string: true }
    case 'number':
      return { ...NOTHING_ACCEPTED, number: true }
    case 'boolean':
      return { ...NOTHING_ACCEPTED, boolean: true }
    case 'const':
      return acceptanceOfConst(node.value)
    case 'union': {
      let accepted = NOTHING_ACCEPTED
      for (const member of node.list ?? []) {
        const part = leafAcceptance(resolveNode(member, envelope), envelope)
        if (part === undefined) return undefined
        accepted = {
          string: accepted.string || part.string,
          number: accepted.number || part.number,
          boolean: accepted.boolean || part.boolean,
          null: accepted.null || part.null,
        }
      }
      return accepted
    }
    default:
      return undefined
  }
}

/**
 * Whether a node is a `dict` whose elements are plain strings.
 *
 * The companion shape check to {@link unionConstStrings}, and generic
 * schemastery vocabulary for the same reason: `z.dict(z.string())` serializes
 * as a `dict` node whose `inner` is a `string` node, and a caller that means to
 * edit a field as a map of text needs to know the schema still describes it
 * that way. A field the owning schema shapes some other way answers false, so
 * the caller can offer no editor rather than write a value the namespace would
 * refuse.
 * @param node - the field's own node, typically from {@link fieldNode}.
 * @param envelope - the table every uid is looked up in.
 * @returns true when the node is a dict whose element schema is a string.
 */
export function isStringDict(node: SchemaNode | undefined, envelope: SchemaEnvelope): boolean {
  if (node?.type !== 'dict') return false
  return resolveNode(node.inner, envelope)?.type === 'string'
}

/**
 * Read one path out of a resolved settings value.
 *
 * Separate from the schema walk because they answer different questions: the
 * schema says which field COULD name a credential, and the value says which
 * one currently does.
 * @param value - a namespace's resolved value, or a layer of it.
 * @param path - the path to read.
 * @returns the value at that path, or undefined when the path is absent.
 */
export function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}
