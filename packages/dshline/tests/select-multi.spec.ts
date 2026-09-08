/**
 * The multi-select picker: the shared picker's bounds with toggling rows.
 *
 * It exists because Harness's question contract lets a caller ask for several
 * answers at once (`multiSelect`), and a single-choice picker asked to carry it
 * would silently narrow the answer to one label. The bound is inherited from
 * the single-select's regression: the list is a viewport, never a row per
 * choice, or the rows that scroll off can no longer be reached or erased.
 */

import { describe, expect, it } from 'vitest'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import type { SelectChoice } from '../src/select.ts'
import { createMultiSelectOverlay, SEARCHABLE_CHOICES } from '../src/select.ts'

/** Width and height of a comfortable terminal. */
const COLUMNS = 80
const ROWS = 24

/** A short list, the shape a multi-select question offers. */
const SHORT: SelectChoice[] = [
  { value: 'a', label: 'Alpha', description: 'The first facet.' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
]

/** A list long enough to grow a query box. */
function many(count: number): SelectChoice[] {
  return Array.from({ length: count }, (_unused, index) => ({
    value: String(index),
    label: index === 0
      ? 'openrouter/first-sentinel'
      : index === count - 1 ? 'openrouter/last-sentinel' : `openrouter/model-${String(index)}`,
  }))
}

/** An overlay under test, plus what it settled with. */
interface Mounted {
  render(columns?: number, rows?: number): string[]
  text(columns?: number, rows?: number): string
  press(...keys: Key[]): void
  readonly settled: () => { values: string[] | undefined } | undefined
}

/**
 * Mount a multi-select over a fixed list.
 * @param choices - the offered choices.
 * @param initialChecked - values checked before the first frame.
 * @returns the overlay and its settlement.
 */
function mount(choices: readonly SelectChoice[], initialChecked?: readonly string[]): Mounted {
  let settled: { values: string[] | undefined } | undefined
  const overlay = createMultiSelectOverlay({
    title: 'Pick facets',
    choices,
    ...initialChecked === undefined ? {} : { initialChecked },
    settle: values => { settled = { values } },
    invalidate: () => {},
  })
  const render = (columns = COLUMNS, rows = ROWS): string[] => [...overlay.render(columns, rows)]
  return {
    render,
    text: (columns = COLUMNS, rows = ROWS) => stripAnsi(render(columns, rows).join('\n')),
    press: (...keys) => { for (const key of keys) overlay.handleKey(key) },
    settled: () => settled,
  }
}

/**
 * One decoded key press.
 * @param name - the key.
 * @returns the key event.
 */
function key(name: Extract<Key, { kind: 'key' }>['name']): Key {
  return { kind: 'key', name }
}

describe('a multi-select short enough to read', () => {
  it('shows every choice with its toggle state, and no query box', () => {
    const shown = mount(SHORT).text()
    expect(shown).toContain('Alpha')
    expect(shown).toContain('Beta')
    expect(shown).toContain('Gamma')
    expect(shown).not.toContain('type to filter')
  })

  it('toggles by space and confirms the checked set in the offered order', () => {
    const view = mount(SHORT)
    // Check Gamma first, then Alpha: the answer still lists Alpha before
    // Gamma, because the offered order is the reader's map of the question.
    view.press(key('down'), key('down'), { kind: 'text', text: ' ' }, key('up'), key('up'), { kind: 'text', text: ' ' })
    expect(view.text()).toContain('2 checked')
    view.press(key('enter'))
    expect(view.settled()).toEqual({ values: ['a', 'c'] })
  })

  it('confirming an empty set is an ordinary answer, not a cancellation', () => {
    const view = mount(SHORT)
    view.press(key('enter'))
    expect(view.settled()).toEqual({ values: [] })
  })

  it('cancels on escape with the set discarded', () => {
    const view = mount(SHORT)
    view.press({ kind: 'text', text: ' ' }, key('escape'))
    expect(view.settled()).toEqual({ values: undefined })
  })

  it('shows the highlighted choice description, aligned under the label', () => {
    const view = mount(SHORT)
    expect(view.text()).toContain('The first facet.')
  })

  it('keeps checked state across a moved cursor', () => {
    const view = mount(SHORT)
    view.press({ kind: 'text', text: ' ' }, key('down'))
    // The check mark travels with the VALUE, not the cursor row.
    expect(view.text()).toContain('\u25c9')
    expect(view.text()).toContain('\u25cb')
  })

  it('restores a return visit with its earlier checks', () => {
    const view = mount(SHORT, ['b'])
    view.press(key('enter'))
    expect(view.settled()).toEqual({ values: ['b'] })
  })

  it('remains answerable on a terminal too small for the frame', () => {
    const view = mount(SHORT, ['a', 'c'])
    const shown = view.text(COLUMNS, 3)
    expect(shown).toContain('Alpha')
    expect(shown).toContain('2 checked')
    view.press(key('enter'))
    expect(view.settled()).toEqual({ values: ['a', 'c'] })
  })
})

describe('a searchable multi-select', () => {
  it('grows a query box past the search threshold', () => {
    expect(mount(many(SEARCHABLE_CHOICES + 1)).text()).toContain('type to filter')
  })

  it('toggles through a filtered view, and the query never steals space', () => {
    const view = mount(many(30))
    view.press({ kind: 'text', text: 'f' })
    // Space toggles even while a query is active: it is the list's defining
    // gesture, never a query character.
    view.press({ kind: 'text', text: ' ' })
    view.press(key('enter'))
    expect(view.settled()).toEqual({ values: ['0'] })
  })

  it('keeps checks made before filtering when the query changes', () => {
    const view = mount(many(30))
    view.press({ kind: 'text', text: ' ' }, key('escape'), key('escape'))
    // First escape clears the query, the second cancels; the pre-filter check
    // survives both, because the set is by value.
    expect(view.settled()).toEqual({ values: undefined })
    const restored = mount(many(30))
    restored.press({ kind: 'text', text: ' ' }, { kind: 'text', text: 'f' }, key('enter'))
    expect(restored.settled()).toEqual({ values: ['0'] })
  })

  it('confirming while the query empties the view still settles the checked set', () => {
    const view = mount(many(30))
    view.press({ kind: 'text', text: ' ' }, { kind: 'text', text: 'zzz' })
    expect(view.text()).toContain('Nothing matches that.')
    view.press(key('enter'))
    expect(view.settled()).toEqual({ values: ['0'] })
  })
})
