/**
 * Finding a profile's credential field from a serialized settings schema.
 *
 * The envelopes below are hand-built in the exact shape `schema.toJSON()`
 * produces — `{ uid, refs }`, with every nested node replaced by its uid so
 * shared and recursive references survive serialization. Schemastery is not a
 * dependency of this package, so the fixture states the contract rather than
 * re-deriving it; the two adapters shipped today (`llm-pi-ai`, keyed under a
 * `providers` dict, and `llm-deepseek`, whose whole section is the profile) are
 * both represented.
 */

import { describe, expect, it } from 'vitest'
import {
  credentialRefFields,
  dictKeyStrings,
  fieldNode,
  innerNode,
  leafAcceptance,
  numberConstraints,
  profileNode,
  resolveSchemaNode,
  unionConstValues,
  unionHasConst,
  valueAt,
} from '../src/connect/schema.ts'

/** A `z.string().role('credential-ref')` node. */
const REF_NODE = { type: 'string', meta: { role: 'credential-ref' } }

/** A plain `z.string()` node. */
const PLAIN_NODE = { type: 'string', meta: {} }

/**
 * The `llm-pi-ai` shape: a section holding a dict of profiles.
 * @returns the serialized envelope.
 */
function piAiSchema(): unknown {
  return {
    uid: 1,
    refs: {
      1: { type: 'object', meta: {}, dict: { providers: 2 } },
      2: { type: 'dict', meta: {}, inner: 3 },
      3: { type: 'object', meta: {}, dict: { apiKeyEnv: 4, baseURL: 5, displayName: 5 } },
      4: REF_NODE,
      5: PLAIN_NODE,
    },
  }
}

/**
 * The `llm-deepseek` shape: the section itself is the profile.
 * @returns the serialized envelope.
 */
function deepseekSchema(): unknown {
  return {
    uid: 10,
    refs: {
      10: { type: 'object', meta: {}, dict: { apiKeyEnv: 11, baseURL: 12 } },
      11: { type: 'string', meta: { role: 'credential-ref', default: 'DEEPSEEK_API_KEY' } },
      12: PLAIN_NODE,
    },
  }
}

describe('locating a provider profile in a serialized settings schema', () => {
  it('follows a dict segment through its one element node', () => {
    // `openrouter` is nowhere in the schema — a dict describes every key with a
    // single `inner`, and that is exactly what lets a route the adapter never
    // named be configured.
    const located = profileNode(piAiSchema(), ['providers', 'openrouter'])
    expect(credentialRefFields(located)).toEqual(['apiKeyEnv'])
  })

  it('treats an empty path as the section root', () => {
    expect(credentialRefFields(profileNode(deepseekSchema(), []))).toEqual(['apiKeyEnv'])
  })

  it('reports no field when the role is absent, rather than guessing a name', () => {
    // The whole point of reading the role: a schema with an `apiKeyEnv`-shaped
    // field that is NOT declared a credential reference must not be written to.
    const schema = {
      uid: 1,
      refs: { 1: { type: 'object', meta: {}, dict: { apiKeyEnv: 2 } }, 2: PLAIN_NODE },
    }
    expect(credentialRefFields(profileNode(schema, []))).toEqual([])
  })

  it('flattens an intersection, which is how a schema composes shared fields', () => {
    const schema = {
      uid: 1,
      refs: {
        1: { type: 'intersect', meta: {}, list: [2, 3] },
        2: { type: 'object', meta: {}, dict: { token: 4 } },
        3: { type: 'object', meta: {}, dict: { baseURL: 5 } },
        4: REF_NODE,
        5: PLAIN_NODE,
      },
    }
    expect(credentialRefFields(profileNode(schema, []))).toEqual(['token'])
  })

  it('answers nothing for a path the schema does not describe', () => {
    expect(profileNode(piAiSchema(), ['nowhere', 'openai'])).toBeUndefined()
    expect(credentialRefFields(profileNode(piAiSchema(), ['nowhere']))).toEqual([])
  })

  it('answers nothing when the descriptor carries no envelope at all', () => {
    // A namespace whose provider could not serialize a schema must degrade to
    // "no credential field", never to a thrown error inside a render pass.
    expect(profileNode(undefined, [])).toBeUndefined()
    expect(profileNode({ notAnEnvelope: true }, [])).toBeUndefined()
    expect(credentialRefFields(undefined)).toEqual([])
  })

  it('terminates on a schema that refers to itself', () => {
    const schema = { uid: 1, refs: { 1: { type: 'intersect', meta: {}, list: [1] } } }
    expect(credentialRefFields(profileNode(schema, []))).toEqual([])
  })
})

describe('reading a path out of a resolved settings value', () => {
  it('returns the value at the path', () => {
    const value = { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } }
    expect(valueAt(value, ['providers', 'openai', 'apiKeyEnv'])).toBe('OPENAI_API_KEY')
  })

  it('returns the whole value for an empty path', () => {
    expect(valueAt({ apiKeyEnv: 'X' }, [])).toEqual({ apiKeyEnv: 'X' })
  })

  it('returns undefined through an absent or non-object segment', () => {
    expect(valueAt({ providers: {} }, ['providers', 'openai', 'apiKeyEnv'])).toBeUndefined()
    expect(valueAt({ providers: 'text' }, ['providers', 'openai'])).toBeUndefined()
    expect(valueAt(undefined, ['providers'])).toBeUndefined()
  })
})

/**
 * The model shapes `llm-pi-ai` really serializes, taken from running
 * `Config.toJSON()` against the pinned harness: `models` is an array of entry
 * objects, `modelOverrides` a dict of the same object with a plain-string key
 * schema, `input` an array of modality consts, and `reasoningEfforts` a union
 * of `const(false)` and a dict whose key schema is the level vocabulary.
 * @returns the serialized envelope.
 */
function modelSchema(): unknown {
  return {
    uid: 1,
    refs: {
      1: { type: 'object', meta: {}, dict: { providers: 2 } },
      2: { type: 'dict', meta: {}, inner: 3, sKey: 30 },
      3: { type: 'object', meta: {}, dict: { models: 40, modelOverrides: 41 } },
      40: { type: 'array', meta: { default: [] }, inner: 42 },
      41: { type: 'dict', meta: { default: {} }, inner: 42, sKey: 7 },
      42: { type: 'object', meta: { default: {} }, dict: { contextWindow: 11, input: 12, reasoningEfforts: 14 } },
      7: { type: 'string', meta: {} },
      11: { type: 'number', meta: { step: 1, min: 1 } },
      12: { type: 'array', meta: { default: [] }, inner: 13 },
      13: { type: 'union', meta: {}, list: [15, 16] },
      15: { type: 'const', meta: { required: true }, value: 'text' },
      16: { type: 'const', meta: { required: true }, value: 'image' },
      14: { type: 'union', meta: {}, list: [17, 18] },
      17: { type: 'const', meta: {}, value: false },
      18: { type: 'dict', meta: { default: {} }, inner: 21, sKey: 19 },
      19: { type: 'union', meta: {}, list: [22, 23] },
      22: { type: 'const', meta: { required: true }, value: 'off' },
      23: { type: 'const', meta: { required: true }, value: 'max' },
      21: { type: 'union', meta: {}, list: [24, 25] },
      24: { type: 'string', meta: {} },
      25: { type: 'const', meta: {}, value: null },
      30: { type: 'string', meta: {} },
    },
  }
}

describe('generic schema introspection', () => {
  it('descends a dict or array to its single element node', () => {
    const located = profileNode(modelSchema(), ['providers', 'openai'])
    if (located === undefined) throw new Error('fixture did not locate')
    const entry = innerNode(fieldNode(located, 'models'), located.envelope)
    expect(entry?.type).toBe('object')
    expect(innerNode(fieldNode(located, 'modelOverrides'), located.envelope)?.type).toBe('object')
    expect(innerNode(fieldNode(located, 'models'), located.envelope)?.dict).toHaveProperty('input')
  })

  it('reads the fixed key vocabulary a dict declares at `sKey`', () => {
    const located = profileNode(modelSchema(), ['providers', 'openai'])
    if (located === undefined) throw new Error('fixture did not locate')
    const entry = innerNode(fieldNode(located, 'models'), located.envelope)
    if (entry === undefined) throw new Error('fixture has no entry')
    const reasoning = fieldNode({ node: entry, envelope: located.envelope }, 'reasoningEfforts')
    const dict = (reasoning?.list ?? [])
      .map(member => resolveSchemaNode(member, located.envelope))
      .find(member => member?.type === 'dict')
    expect(dictKeyStrings(dict, located.envelope)).toEqual(['off', 'max'])
    // An open dict (`z.dict(z.string())`) declares no vocabulary.
    expect(dictKeyStrings(fieldNode(located, 'modelOverrides'), located.envelope)).toEqual([])
  })

  it('reports a union of constants by value, not only by string type', () => {
    const located = profileNode(modelSchema(), ['providers', 'openai'])
    if (located === undefined) throw new Error('fixture did not locate')
    const entry = innerNode(fieldNode(located, 'models'), located.envelope)
    if (entry === undefined) throw new Error('fixture has no entry')
    const reasoning = fieldNode({ node: entry, envelope: located.envelope }, 'reasoningEfforts')
    // A union with a structured branch answers no pure constant list, but the
    // constant it DOES carry is still visible to a targeted lookup.
    expect(unionConstValues(reasoning, located.envelope)).toEqual([])
    expect(unionConstValues(
      innerNode(fieldNode({ node: entry, envelope: located.envelope }, 'input'), located.envelope),
      located.envelope,
    )).toEqual(['text', 'image'])
    expect(unionHasConst(reasoning, located.envelope, false)).toBe(true)
    expect(unionHasConst(reasoning, located.envelope, true)).toBe(false)
  })

  it('reads the numeric bounds the schema actually declares', () => {
    const located = profileNode(modelSchema(), ['providers', 'openai'])
    if (located === undefined) throw new Error('fixture did not locate')
    const entry = innerNode(fieldNode(located, 'models'), located.envelope)
    if (entry === undefined) throw new Error('fixture has no entry')
    expect(numberConstraints(fieldNode({ node: entry, envelope: located.envelope }, 'contextWindow')))
      .toEqual({ min: 1, step: 1 })
    expect(numberConstraints(PLAIN_NODE)).toBeUndefined()
  })

  it('reads which primitive kinds one value leaf accepts', () => {
    const envelope = { uid: 1, refs: {} as Record<string, unknown> }
    expect(leafAcceptance({ type: 'string', meta: {} }, envelope))
      .toEqual({ string: true, number: false, boolean: false, null: false })
    expect(leafAcceptance({ type: 'number', meta: {} }, envelope))
      .toEqual({ string: false, number: true, boolean: false, null: false })
    expect(leafAcceptance({ type: 'const', meta: {}, value: false }, envelope))
      .toEqual({ string: false, number: false, boolean: true, null: false })
    expect(leafAcceptance({ type: 'const', meta: {}, value: null }, envelope))
      .toEqual({ string: false, number: false, boolean: false, null: true })
  })

  it('merges the kinds of a union of primitive leaves', () => {
    const envelope = { uid: 1, refs: {} as Record<string, unknown> }
    expect(leafAcceptance({ type: 'union', meta: {}, list: [
      { type: 'string', meta: {} },
      { type: 'const', meta: {}, value: null },
    ] }, envelope)).toEqual({ string: true, number: false, boolean: false, null: true })
  })

  it('fails closed on a leaf shape it cannot classify', () => {
    const envelope = { uid: 1, refs: {} as Record<string, unknown> }
    // A structured member makes the whole leaf unrenderable as a primitive.
    expect(leafAcceptance({ type: 'union', meta: {}, list: [
      { type: 'string', meta: {} },
      { type: 'object', meta: {}, dict: {} },
    ] }, envelope)).toBeUndefined()
    expect(leafAcceptance({ type: 'object', meta: {}, dict: {} }, envelope)).toBeUndefined()
    expect(leafAcceptance({ type: 'intersect', meta: {}, list: [] }, envelope)).toBeUndefined()
    expect(leafAcceptance(undefined, envelope)).toBeUndefined()
  })

  it('reads the reasoning value leaf through the real dict shape', () => {
    const located = profileNode(modelSchema(), ['providers', 'openai'])
    if (located === undefined) throw new Error('fixture did not locate')
    const entry = innerNode(fieldNode(located, 'models'), located.envelope)
    if (entry === undefined) throw new Error('fixture has no entry')
    const reasoning = fieldNode({ node: entry, envelope: located.envelope }, 'reasoningEfforts')
    const dict = (reasoning?.list ?? [])
      .map(member => resolveSchemaNode(member, located.envelope))
      .find(member => member?.type === 'dict')
    expect(leafAcceptance(innerNode(dict, located.envelope), located.envelope))
      .toEqual({ string: true, number: false, boolean: false, null: true })
  })
})
