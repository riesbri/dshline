/**
 * The subagent authorization overlay's rendering and keys.
 *
 * The overlay is a bounded surface: it must stay inside the terminal at every
 * geometry, keep its footer a whole instruction, show persistent refusals
 * rather than timed ones, and leave ordinary typed characters to search while
 * single-key actions still work outside search mode.
 */

import { describe, expect, it } from 'vitest'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import { draftFrom, withEnabled, withToggled } from '../src/subagent-model-selection/model.ts'
import type { SubagentModelEntry, SubagentModelReading } from '../src/subagent-model-selection/model.ts'
import { createSubagentModelSelectionOverlay } from '../src/subagent-model-selection/overlay.ts'
import { expectPhysicallyBounded } from './surface-contracts.ts'

/** One offered row. */
function entry(provider: string, model: string, available = true): SubagentModelEntry {
  return { route: { provider, model }, available }
}

/** A ready reading with a live catalog and one saved route. */
function ready(overrides: Partial<Extract<SubagentModelReading, { kind: 'ready' }>> = {}): SubagentModelReading {
  return {
    kind: 'ready',
    entries: [
      entry('deepseek-official', 'deepseek-chat'),
      entry('deepseek-official', 'deepseek-reasoner'),
      entry('opencode', 'kimi'),
      entry('private-gateway', 'gone', false),
    ],
    failedProviders: [],
    catalogError: undefined,
    draft: draftFrom({
      enabled: true,
      allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-chat' }],
    }),
    refusal: undefined,
    saving: false,
    ...overrides,
  }
}

/** A mounted overlay plus what it asked its owner for. */
function mount(initial: SubagentModelReading): {
  render(columns?: number, rows?: number): string[]
  text(columns?: number, rows?: number): string
  press(...keys: Key[]): void
  set(reading: SubagentModelReading): void
  toggles: string[]
  flips: () => number
  saves: () => number
  refreshes: () => number
  closed: () => boolean
} {
  let reading = initial
  let flips = 0
  let saves = 0
  let refreshes = 0
  let closed = false
  const toggles: string[] = []
  const overlay = createSubagentModelSelectionOverlay({
    reading: () => reading,
    toggle: chosen => {
      toggles.push(`${chosen.route.provider}/${chosen.route.model}`)
      if (reading.kind === 'ready') reading = { ...reading, draft: withToggled(reading.draft, chosen.route) }
    },
    flipEnabled: () => {
      flips += 1
      if (reading.kind === 'ready') reading = { ...reading, draft: withEnabled(reading.draft, !reading.draft.enabled) }
    },
    save: () => { saves += 1 },
    refresh: () => { refreshes += 1 },
    close: () => { closed = true },
    invalidate: () => {},
  })
  return {
    render: (columns = 90, rows = 24) => [...overlay.render(columns, rows)],
    text: (columns = 90, rows = 24) => stripAnsi(overlay.render(columns, rows).join('\n')),
    press: (...keys) => { for (const key of keys) overlay.handleKey(key) },
    set: next => { reading = next },
    toggles,
    flips: () => flips,
    saves: () => saves,
    refreshes: () => refreshes,
    closed: () => closed,
  }
}

/** A named key. */
function key(name: string): Key {
  return { kind: 'key', name } as Key
}

/** Typed text. */
function text(value: string): Key {
  return { kind: 'text', text: value }
}

describe('what the editor shows', () => {
  it('states the session semantics verbatim and reports selection and count', () => {
    const view = mount(ready())
    const shown = view.text()
    expect(shown).toContain('Applies to new sessions; the current session keeps its recorded policy.')
    expect(shown).toContain('Selection   on')
    expect(shown).toContain('Allowed     1 model')
    expect(shown).toContain('[x] deepseek-official/deepseek-chat')
    expect(shown).toContain('[ ] opencode/kimi')
  })

  it('marks a saved route the catalog no longer advertises as unavailable', () => {
    const view = mount(ready())
    expect(view.text()).toContain('[ ] private-gateway/gone')
    expect(view.text()).toContain('unavailable')
  })

  it('names a partial catalog failure without hiding healthy rows', () => {
    const view = mount(ready({ failedProviders: ['private-gateway'] }))
    const shown = view.text()
    expect(shown).toContain('could not list: private-gateway')
    expect(shown).toContain('[x] deepseek-official/deepseek-chat')
    expect(shown).toContain('[ ] private-gateway/gone')
  })

  it('shows a total catalog failure without stranding saved authorization', () => {
    const view = mount(ready({ catalogError: 'the registry is busy' }))
    const shown = view.text()
    expect(shown).toContain('live catalog unavailable: the registry is busy')
    expect(shown).toContain('[x] deepseek-official/deepseek-chat')
  })

  it('shows a refusal persistently, not as an expiring notice', () => {
    const view = mount(ready({ refusal: 'this setting changed elsewhere; your draft is kept' }))
    expect(view.text()).toContain('this setting changed elsewhere')
  })
})

describe('keys outside search', () => {
  it('toggles the highlighted row with space or enter', () => {
    const view = mount(ready())
    view.press(text(' '))
    expect(view.toggles).toEqual(['deepseek-official/deepseek-chat'])
    view.press(key('down'), key('enter'))
    expect(view.toggles).toEqual(['deepseek-official/deepseek-chat', 'deepseek-official/deepseek-reasoner'])
  })

  it('flips enabled while retaining the selected routes', () => {
    const view = mount(ready())
    view.press(key('down'), text('e'))
    expect(view.flips()).toBe(1)
    const shown = view.text()
    expect(shown).toContain('Selection   off')
    expect(shown).toContain('Allowed     1 model')
  })

  it('saves on s', () => {
    const view = mount(ready())
    view.press(text('s'))
    expect(view.saves()).toBe(1)
  })

  it('refreshes on ctrl-r', () => {
    const view = mount(ready())
    view.press(key('ctrl-r'))
    expect(view.refreshes()).toBe(1)
  })

  it('closes on escape when there is no query', () => {
    const view = mount(ready())
    view.press(key('escape'))
    expect(view.closed()).toBe(true)
  })

  it('does nothing while a write is in flight, including escape', () => {
    const view = mount(ready({ saving: true }))
    view.press(text(' '), text('e'), text('s'), key('escape'), key('ctrl-c'))
    expect(view.toggles).toEqual([])
    expect(view.flips()).toBe(0)
    expect(view.saves()).toBe(0)
    expect(view.closed()).toBe(false)
    expect(view.text()).toContain('saving…')
  })
})

describe('search mode', () => {
  it('captures ordinary characters, including s, e, and space', () => {
    const view = mount(ready())
    view.press(text('/'), text('s'), text('e'), text(' '))
    // None of those fired their action while typing.
    expect(view.saves()).toBe(0)
    expect(view.flips()).toBe(0)
    expect(view.toggles).toEqual([])
  })

  it('filters as you type and toggles the filtered row after leaving search', () => {
    const view = mount(ready())
    view.press(text('/'), text('k'), text('i'), text('m'), text('i'), key('enter'))
    expect(view.text()).toContain('opencode/kimi')
    expect(view.text()).not.toContain('deepseek-official/deepseek-chat')
    view.press(text(' '))
    expect(view.toggles).toEqual(['opencode/kimi'])
  })

  it('leaves search on escape while keeping the filter', () => {
    const view = mount(ready())
    view.press(text('/'), text('kimi'), key('escape'))
    expect(view.closed()).toBe(false)
    expect(view.text()).toContain('opencode/kimi')
    // Now outside search, the second escape clears the query rather than closing.
    view.press(key('escape'))
    expect(view.closed()).toBe(false)
    view.press(key('escape'))
    expect(view.closed()).toBe(true)
  })
})

describe('geometry', () => {
  const columns = [40, 60, 90, 120]
  const rows = [4, 6, 10, 14, 24, 40]

  it('stays inside every terminal it is given', () => {
    for (const width of columns) {
      for (const height of rows) {
        expectPhysicallyBounded(mount(ready()), width, height, 'subagent editor')
      }
    }
  })

  it('stays bounded with a selected unavailable route, a query, and a partial failure', () => {
    const view = mount(ready({ failedProviders: ['private-gateway'], refusal: 'this setting changed elsewhere' }))
    view.press(text('/'), text('gateway'))
    for (const width of columns) {
      for (const height of rows) {
        expectPhysicallyBounded(view, width, height, 'subagent editor stressed')
      }
    }
  })

  it('stays bounded with a long catalog', () => {
    const entries = Array.from({ length: 300 }, (_, index) => entry('gateway', `model-${String(index)}`))
    const view = mount(ready({ entries }))
    for (const width of columns) {
      for (const height of rows) {
        expectPhysicallyBounded(view, width, height, 'subagent editor long')
      }
    }
  })

  it('keeps one physical row per entry however long the route name is', () => {
    // A body row one column too wide is wrapped by `frame()` into a second
    // bordered row the viewport never budgeted. The layout must not change with
    // the length of a route name, so a long catalog and a short one draw the
    // same number of rows at the same geometry.
    const long = 'x'.repeat(200)
    const lines = (model: string): string[] => stripAnsi(
      mount(ready({
        entries: [
          entry('gateway', model),
          entry('private-gateway', model, false),
        ],
      })).render(60, 30).join('\n'),
    ).split('\n')
    const short = lines('m')
    const wide = lines(long)
    expect(wide).toHaveLength(short.length)
    // And the unavailable marker stays on its own entry's row, not on a
    // wrapped continuation line.
    expect(wide.some(row => row.includes('unavailable'))).toBe(true)
    // The same widening used to push the whole editor into its one-line
    // backstop on a short terminal, hiding the list and every control.
    const narrow = stripAnsi(mount(ready({
      entries: [
        entry('gateway', long),
        entry('private-gateway', long, false),
        entry('gateway', `${long}b`),
      ],
    })).render(40, 14).join('\n'))
    expect(narrow).toContain('Selection')
    expect(narrow).not.toContain('esc close')
  })

  it('degrades to a whole phrase when the frame cannot fit', () => {
    const view = mount(ready())
    const compact = view.text(20, 2)
    expect(compact).not.toBe('')
    expect(stripAnsi(compact)).toMatch(/esc/)
  })
})
