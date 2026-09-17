/**
 * The subagent authorization editor's pure semantics.
 *
 * Availability is advisory and authorization is the settings decision, so what
 * is pinned here is exactly that separation: saved routes survive a catalog
 * that does not advertise them, a newly discovered route is never selected on
 * its own, and the route set a save would write is deterministic.
 */

import { describe, expect, it } from 'vitest'
import type { ModelCatalogRoute } from '../src/model-catalog.ts'
import { modelRouteKey } from '../src/model-catalog.ts'
import {
  authorizedRoutes,
  draftFrom,
  filterEntries,
  joinEntries,
  saveRefusal,
  selectionValueFrom,
  withEnabled,
  withToggled,
} from '../src/subagent-model-selection/model.ts'
import type { SubagentModelDraft, SubagentModelRoute } from '../src/subagent-model-selection/model.ts'

/** One live catalog route. */
function route(provider: string, model: string): ModelCatalogRoute {
  return { provider, providerName: provider, model, modelName: model }
}

/** One authorized route. */
function saved(provider: string, model: string): SubagentModelRoute {
  return { provider, model }
}

/** A draft with the given selected routes. */
function draftOf(enabled: boolean, routes: readonly SubagentModelRoute[]): SubagentModelDraft {
  return draftFrom({ enabled, allowedModels: routes })
}

describe('selectionValueFrom()', () => {
  it('accepts the resolved shape and keeps route identities exact', () => {
    expect(selectionValueFrom({
      enabled: true,
      allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
    })).toEqual({
      enabled: true,
      allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
    })
  })

  it('rejects anything that is not that shape rather than inventing a default', () => {
    expect(selectionValueFrom(undefined)).toBeUndefined()
    expect(selectionValueFrom(null)).toBeUndefined()
    expect(selectionValueFrom([])).toBeUndefined()
    expect(selectionValueFrom({ allowedModels: [] })).toBeUndefined()
    expect(selectionValueFrom({ enabled: 'yes', allowedModels: [] })).toBeUndefined()
    expect(selectionValueFrom({ enabled: false, allowedModels: 'none' })).toBeUndefined()
    expect(selectionValueFrom({ enabled: false, allowedModels: [{}] })).toBeUndefined()
    expect(selectionValueFrom({ enabled: false, allowedModels: [{ provider: '', model: 'm' }] })).toBeUndefined()
    expect(selectionValueFrom({ enabled: false, allowedModels: [{ provider: 'p', model: '' }] })).toBeUndefined()
  })
})

describe('draftFrom()', () => {
  it('preselects exactly the saved routes', () => {
    const draft = draftFrom({ enabled: true, allowedModels: [saved('a', 'one'), saved('b', 'two')] })
    expect([...draft.selected.keys()]).toEqual([modelRouteKey('a', 'one'), modelRouteKey('b', 'two')])
    expect(draft.enabled).toBe(true)
  })
})

describe('joinEntries()', () => {
  it('shows live routes first in catalog order and never duplicates a saved one', () => {
    const entries = joinEntries([route('a', 'one'), route('b', 'two')], [saved('a', 'one')])
    expect(entries).toEqual([
      { route: { provider: 'a', model: 'one' }, available: true },
      { route: { provider: 'b', model: 'two' }, available: true },
    ])
  })

  it('appends a saved route the catalog does not advertise, marked unavailable', () => {
    // This is the failed-provider case and the retired-model case at once:
    // authorization survives an advisory catalog that cannot confirm it.
    const entries = joinEntries([route('a', 'one')], [saved('a', 'one'), saved('private', 'gone')])
    expect(entries).toEqual([
      { route: { provider: 'a', model: 'one' }, available: true },
      { route: { provider: 'private', model: 'gone' }, available: false },
    ])
  })

  it('keeps saved routes when every provider failed, so they stay manageable', () => {
    const entries = joinEntries([], [saved('a', 'one'), saved('b', 'two')])
    expect(entries).toEqual([
      { route: { provider: 'a', model: 'one' }, available: false },
      { route: { provider: 'b', model: 'two' }, available: false },
    ])
  })

  it('keeps a draft-only route the refreshed catalog no longer advertises', () => {
    // The called-with-union case: a route checked but not yet saved must not
    // vanish when its provider's listing fails on refresh.
    const draft = draftOf(false, [saved('private', 'new')])
    const keep = [...draft.selected.values()]
    const entries = joinEntries([route('a', 'one')], keep)
    expect(entries.at(-1)).toEqual({ route: { provider: 'private', model: 'new' }, available: false })
  })

  it('keeps two providers that share a model id as two distinct rows', () => {
    const entries = joinEntries([route('a', 'same'), route('b', 'same')], [saved('b', 'same')])
    expect(entries).toHaveLength(2)
    expect(entries.map(entry => entry.route.provider)).toEqual(['a', 'b'])
  })
})

describe('filterEntries()', () => {
  const entries = joinEntries([route('deepseek-official', 'deepseek-v4-pro'), route('opencode', 'kimi')], [])

  it('matches the qualified label, case-insensitively, in order', () => {
    expect(filterEntries(entries, 'DEEPSEEK').map(entry => entry.route.provider)).toEqual(['deepseek-official'])
    expect(filterEntries(entries, 'opencode/').map(entry => entry.route.model)).toEqual(['kimi'])
  })

  it('returns every row for an empty query', () => {
    expect(filterEntries(entries, '   ')).toEqual(entries)
  })
})

describe('withToggled() / withEnabled()', () => {
  it('adds and removes one route without disturbing the others', () => {
    const draft = draftOf(false, [saved('a', 'one')])
    const added = withToggled(draft, saved('b', 'two'))
    expect([...added.selected.keys()]).toEqual([modelRouteKey('a', 'one'), modelRouteKey('b', 'two')])
    const removed = withToggled(added, saved('a', 'one'))
    expect([...removed.selected.keys()]).toEqual([modelRouteKey('b', 'two')])
  })

  it('retains the selection when the setting is disabled, for later reuse', () => {
    const draft = draftOf(true, [saved('a', 'one')])
    const disabled = withEnabled(draft, false)
    expect(disabled.enabled).toBe(false)
    expect(disabled.selected.size).toBe(1)
  })
})

describe('saveRefusal()', () => {
  it('blocks only an enabled setting with nothing allowed', () => {
    expect(saveRefusal({ enabled: true, selected: new Map() })).toBeDefined()
    expect(saveRefusal({ enabled: false, selected: new Map() })).toBeUndefined()
    expect(saveRefusal(draftOf(true, [saved('a', 'one')]))).toBeUndefined()
  })
})

describe('authorizedRoutes()', () => {
  const entries = joinEntries([route('a', 'one'), route('b', 'two'), route('c', 'three')], [])

  it('keeps stored order and appends newly checked routes in display order', () => {
    const draft = draftOf(false, [saved('b', 'two'), saved('a', 'one')])
    const added = withToggled(draft, saved('c', 'three'))
    expect(authorizedRoutes([saved('b', 'two'), saved('a', 'one')], added.selected, entries)).toEqual([
      { provider: 'b', model: 'two' },
      { provider: 'a', model: 'one' },
      { provider: 'c', model: 'three' },
    ])
  })

  it('writes the same list back when nothing changed, and never duplicates', () => {
    const origin = [saved('b', 'two'), saved('a', 'one')]
    const draft = draftFrom({ enabled: false, allowedModels: origin })
    expect(authorizedRoutes(origin, draft.selected, entries)).toEqual(origin)
  })

  it('drops a deselected route entirely', () => {
    const origin = [saved('a', 'one'), saved('b', 'two')]
    const draft = withToggled(draftFrom({ enabled: false, allowedModels: origin }), saved('a', 'one'))
    expect(authorizedRoutes(origin, draft.selected, entries)).toEqual([{ provider: 'b', model: 'two' }])
  })

  it('includes a selected route that is absent from the live catalog', () => {
    const draft = draftOf(false, [saved('private', 'gateway')])
    const retained = joinEntries([], [...draft.selected.values()])
    expect(authorizedRoutes([], draft.selected, retained)).toEqual([{ provider: 'private', model: 'gateway' }])
  })
})
