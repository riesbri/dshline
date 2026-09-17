/** A route's model list as a draft: pure edits, no Harness, no rendering. */

import { describe, expect, it } from 'vitest'
import type { LlmDiscoveredModelRead } from '../src/connect/harness.ts'
import {
  addCandidates,
  addManual,
  entriesFromOverrides,
  entriesFromRaw,
  includedEntries,
  parseCapacity,
  removeEntry,
  sameModelSet,
  sameOverrideSet,
  toggleIncluded,
  toRawEntries,
  toRawOverrides,
  updateFields,
} from '../src/connect/model-editor.ts'
import type { ModelDraftEntry } from '../src/connect/model-editor.ts'

describe('building a draft from a stored profile', () => {
  it('is empty when the profile inherits, distinct from an explicit empty list', () => {
    expect(entriesFromRaw(undefined)).toEqual([])
    expect(entriesFromRaw([])).toEqual([])
  })

  it('keeps every raw field, not only the curated ones, so nothing is lost on write-back', () => {
    const raw = { id: 'gpt', name: 'GPT', contextWindow: 128000, input: ['text', 'image'] }
    const [entry] = entriesFromRaw([raw])
    expect(entry).toMatchObject({ id: 'gpt', name: 'GPT', contextWindow: 128000, included: true, storage: 'models' })
    expect(entry?.retained).toEqual(raw)
    expect(entry?.input).toEqual(['text', 'image'])
  })

  it('reads an empty `input` as no declaration rather than an empty one', () => {
    // The schema materializes `[]` for an absent array, and `llm-pi-ai` reads
    // both as "keep the installed catalog's modalities".
    expect(entriesFromRaw([{ id: 'gpt', input: [] }])[0]?.input).toBeUndefined()
  })

  it('keeps the three reasoningEfforts states apart', () => {
    expect(entriesFromRaw([{ id: 'a' }])[0]?.reasoningEfforts).toBeUndefined()
    expect(entriesFromRaw([{ id: 'b', reasoningEfforts: false }])[0]?.reasoningEfforts).toBe(false)
    expect(entriesFromRaw([{ id: 'c', reasoningEfforts: { low: 'low', off: null } }])[0]?.reasoningEfforts)
      .toEqual({ low: 'low', off: null })
  })

  it('drops an entry with no usable id', () => {
    expect(entriesFromRaw([{ name: 'no id' }, 'not an object'])).toEqual([])
  })
})

describe('building a draft from stored overrides', () => {
  it('takes the id from the dict key and every value included', () => {
    const draft = entriesFromOverrides({ gpt: { name: 'GPT', compat: { supportsStore: false } } })
    expect(draft).toHaveLength(1)
    expect(draft[0]).toMatchObject({ id: 'gpt', name: 'GPT', included: true, storage: 'override' })
    expect(draft[0]?.retained).toEqual({ name: 'GPT', compat: { supportsStore: false } })
  })

  it('still shows a stored override whose value is malformed, so it can be removed', () => {
    const draft = entriesFromOverrides({ gpt: 'not an object' })
    expect(draft).toHaveLength(1)
    expect(draft[0]).toMatchObject({ id: 'gpt', included: true, storage: 'override', retained: undefined })
  })

  it('skips an empty key, which no model id can use', () => {
    expect(entriesFromOverrides({ '': {} })).toEqual([])
  })
})

describe('folding discovery candidates into a draft', () => {
  const CANDIDATES: LlmDiscoveredModelRead[] = [
    { id: 'gpt', name: 'GPT (renamed)', contextWindow: 999 },
    { id: 'embedding', name: 'Embedding' },
  ]

  it('never touches an id already in the draft, even with different metadata', () => {
    // The whole reason a fetched candidate starts unchecked rather than
    // overwriting: an endpoint listing only ever gives an id, at best a name
    // and two capacities, and a row a person already corrected carries
    // information no listing can improve.
    const before = entriesFromRaw([{ id: 'gpt', name: 'GPT (corrected)', contextWindow: 32000 }])
    const after = addCandidates(before, CANDIDATES, 'models')
    const gpt = after.find(entry => entry.id === 'gpt')
    expect(gpt).toMatchObject({ name: 'GPT (corrected)', contextWindow: 32000, included: true })
  })

  it('adds an unseen candidate unincluded', () => {
    const after = addCandidates([], CANDIDATES, 'models')
    expect(after.every(entry => !entry.included)).toBe(true)
    expect(after.map(entry => entry.id)).toEqual(['gpt', 'embedding'])
  })

  it('carries the draft storage onto every candidate', () => {
    expect(addCandidates([], CANDIDATES, 'override').every(entry => entry.storage === 'override')).toBe(true)
  })
})

describe('toggling and removing entries', () => {
  it('flips only the named entry', () => {
    const draft = addCandidates([], [{ id: 'a' }, { id: 'b' }], 'models')
    const after = toggleIncluded(draft, 'a')
    expect(after.find(entry => entry.id === 'a')?.included).toBe(true)
    expect(after.find(entry => entry.id === 'b')?.included).toBe(false)
  })

  it('drops the named entry entirely', () => {
    const draft = addCandidates([], [{ id: 'a' }, { id: 'b' }], 'models')
    expect(removeEntry(draft, 'a').map(entry => entry.id)).toEqual(['b'])
  })
})

describe('adding and editing a model by hand', () => {
  const BLANK = { name: undefined, contextWindow: undefined, maxTokens: undefined, input: undefined, reasoningEfforts: undefined }

  it('requires a non-empty id', () => {
    const result = addManual([], { id: '  ', ...BLANK }, 'models')
    expect(result).toEqual({ ok: false, reason: 'a model id is required' })
  })

  it('refuses a duplicate id before it ever reaches settings', () => {
    const draft = entriesFromRaw([{ id: 'gpt' }])
    const result = addManual(draft, { id: 'gpt', ...BLANK }, 'models')
    expect(result).toEqual({ ok: false, reason: '"gpt" is already in the list' })
  })

  it('adds a well-formed manual entry, included, in the draft storage', () => {
    const result = addManual([], {
      id: 'gpt',
      name: 'GPT',
      contextWindow: 128000,
      maxTokens: 4096,
      input: ['text'],
      reasoningEfforts: false,
    }, 'models')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.entries).toEqual([{
        id: 'gpt',
        name: 'GPT',
        contextWindow: 128000,
        maxTokens: 4096,
        input: ['text'],
        reasoningEfforts: false,
        retained: undefined,
        included: true,
        storage: 'models',
      }])
    }
  })

  it('replaces curated fields while keeping id, inclusion, and retained shape', () => {
    const raw = { id: 'gpt', name: 'GPT', compat: { foo: true } }
    const draft = entriesFromRaw([raw])
    const after = updateFields(draft, 'gpt', { name: undefined, contextWindow: 8000, maxTokens: undefined })
    expect(after).toEqual([{
      id: 'gpt',
      name: undefined,
      contextWindow: 8000,
      maxTokens: undefined,
      input: undefined,
      reasoningEfforts: undefined,
      retained: raw,
      included: true,
      storage: 'models',
    }])
  })
})

describe('capacity fields', () => {
  it('treats a blank answer as absent, not as zero', () => {
    expect(parseCapacity(undefined)).toEqual({ ok: true, value: undefined })
    expect(parseCapacity('')).toEqual({ ok: true, value: undefined })
    expect(parseCapacity('   ')).toEqual({ ok: true, value: undefined })
  })

  it('accepts a positive whole number', () => {
    expect(parseCapacity('128000')).toEqual({ ok: true, value: 128000 })
  })

  it('refuses zero, negative, and non-integral answers', () => {
    expect(parseCapacity('0').ok).toBe(false)
    expect(parseCapacity('-5').ok).toBe(false)
    expect(parseCapacity('12.5').ok).toBe(false)
    expect(parseCapacity('not a number').ok).toBe(false)
  })
})

describe('what would actually be written', () => {
  it('writes only the included entries', () => {
    const draft = toggleIncluded(addCandidates([], [{ id: 'a' }, { id: 'b' }], 'models'), 'a')
    expect(includedEntries(draft).map(entry => entry.id)).toEqual(['a'])
    expect(toRawEntries(draft)).toEqual([{ id: 'a' }])
  })

  it('preserves unknown fields on a retained entry that is still included', () => {
    const raw = { id: 'gpt', name: 'GPT', compat: { supportsDeveloperRole: false } }
    const draft = entriesFromRaw([raw])
    expect(toRawEntries(draft)).toEqual([raw])
  })

  it('drops a curated field cleared back to undefined, rather than writing null', () => {
    const draft = updateFields(entriesFromRaw([{ id: 'gpt', name: 'GPT' }]), 'gpt', {
      name: undefined,
      contextWindow: undefined,
      maxTokens: undefined,
    })
    expect(toRawEntries(draft)).toEqual([{ id: 'gpt' }])
  })

  it('writes overrides without an id, preserving unrendered fields', () => {
    const draft = toggleIncluded(entriesFromOverrides({ a: { compat: { supportsStore: false } }, b: {} }), 'b')
    expect(toRawOverrides(draft)).toEqual({ a: { compat: { supportsStore: false } } })
  })

  it('never lets an override carry an id, even one a hand-edited profile stored', () => {
    const draft = entriesFromOverrides({ a: { id: 'wrong', name: 'A' } })
    expect(toRawOverrides(draft)).toEqual({ a: { name: 'A' } })
  })
})

describe('comparing two drafts', () => {
  it('is order-insensitive', () => {
    const left: readonly ModelDraftEntry[] = addCandidates([], [{ id: 'a' }, { id: 'b' }], 'models')
    const right: readonly ModelDraftEntry[] = addCandidates([], [{ id: 'b' }, { id: 'a' }], 'models')
    expect(sameModelSet(left, right)).toBe(true)
  })

  it('is sensitive to a changed capacity', () => {
    const left = entriesFromRaw([{ id: 'a', contextWindow: 1000 }])
    const right = entriesFromRaw([{ id: 'a', contextWindow: 2000 }])
    expect(sameModelSet(left, right)).toBe(false)
  })

  it('is sensitive to inclusion, since an unincluded entry would not be written', () => {
    const included = entriesFromRaw([{ id: 'a' }])
    const excluded = toggleIncluded(included, 'a')
    expect(sameModelSet(included, excluded)).toBe(false)
  })

  it('compares overrides as a dict, ignoring catalog rows that write nothing', () => {
    const stored = entriesFromOverrides({ a: { input: ['text'] } })
    const withCatalog = addCandidates(stored, [{ id: 'b' }], 'override')
    expect(sameOverrideSet(withCatalog, stored)).toBe(true)
  })

  it('is sensitive to a changed override field', () => {
    const left = entriesFromOverrides({ a: { input: ['text'] } })
    const right = entriesFromOverrides({ a: { input: ['text', 'image'] } })
    expect(sameOverrideSet(left, right)).toBe(false)
  })

  it('is sensitive to an override removed', () => {
    const left = entriesFromOverrides({ a: {}, b: {} })
    const right = toggleIncluded(left, 'b')
    expect(sameOverrideSet(left, right)).toBe(false)
  })
})
