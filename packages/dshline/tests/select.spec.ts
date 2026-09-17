/**
 * The shared picker: bounded to the terminal, and searchable once it is long.
 *
 * The bound is the regression that matters. A gateway route advertises hundreds
 * of models, and a picker that drew a row per choice handed `Screen` a live
 * region taller than the screen — after which the rows that scrolled off can no
 * longer be erased, and the next redraw corrupts committed scrollback.
 */

import { describe, expect, it } from 'vitest'
import type { Key } from '@dshline/renderer'
import { displayWidth, stripAnsi, wrapToWidth } from '@dshline/renderer'
import type { SelectChoice } from '../src/select.ts'
import { createSelectOverlay, filterChoices, SEARCHABLE_CHOICES } from '../src/select.ts'

/** Width and height of a comfortable terminal. */
const COLUMNS = 80
const ROWS = 24

/**
 * The title the question adapter composes when a header and a question are both
 * present — the exact shape that used to be cut off mid-sentence.
 */
const LONG_TITLE = "Apply the profile fix?: Do you want me to fix the profile's Codex provider now, or leave it for now?"

/**
 * Rejoin rows the picker wrapped and drop box chrome, so a phrase split across
 * two physical rows still reads as one string.
 * @param text - rendered rows, already stripped of ANSI.
 * @returns the body text with runs of whitespace collapsed.
 */
function bodyText(text: string): string {
  return text
    .replace(/[│╭╮╰╯─]/gu, ' ')
    .split('\n')
    .map(row => row.trim())
    .filter(row => row !== '')
    .join(' ')
    .replace(/\s+/gu, ' ')
}

/** A short list, the shape an approval or `/reasoning` offers. */
const SHORT: SelectChoice[] = [
  { value: 'allowed-once', label: 'Allow once', description: 'Run this call and ask again.' },
  { value: 'rejected', label: 'Reject' },
]

/**
 * A list longer than any terminal can show, the shape `/model` offers over a
 * gateway route.
 * @param count - how many choices.
 * @returns the choices, each labelled the way the model picker labels one.
 */
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
  readonly settled: () => { value: string | undefined } | undefined
}

/**
 * Mount a picker over a fixed list.
 * @param choices - the offered choices.
 * @param detail - the optional supporting line.
 * @returns the overlay and its settlement.
 */
function mount(choices: readonly SelectChoice[], detail?: string, initialValue?: string): Mounted {
  let settled: { value: string | undefined } | undefined
  const overlay = createSelectOverlay({
    title: 'Select a model',
    ...detail === undefined ? {} : { detail },
    ...initialValue === undefined ? {} : { initialValue },
    choices,
    settle: value => { settled = { value } },
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

describe('a picker short enough to read', () => {
  it('shows every choice, with no query box', () => {
    const shown = mount(SHORT).text()
    expect(shown).toContain('Allow once')
    expect(shown).toContain('Reject')
    expect(shown).not.toContain('⌕')
    expect(shown).not.toContain('type to filter')
  })

  it('ignores typed text, which would otherwise insert nowhere', () => {
    // An approval with two choices has nothing to filter, and a keystroke that
    // appeared to do nothing would read as a hang.
    const view = mount(SHORT)
    view.press({ kind: 'text', text: 'y' }, { kind: 'paste', text: 'yes' })
    expect(view.text()).not.toContain('y⌕')
    view.press(key('enter'))
    expect(view.settled()).toEqual({ value: 'allowed-once' })
  })

  it('cancels on the first escape, with no query to clear first', () => {
    const view = mount(SHORT)
    view.press(key('escape'))
    expect(view.settled()).toEqual({ value: undefined })
  })

  it('shows the description of the selected choice only', () => {
    const view = mount(SHORT)
    expect(view.text()).toContain('Run this call and ask again.')
    view.press(key('down'))
    expect(view.text()).toContain('Reject')
  })

  it('keeps the detail line its caller supplied', () => {
    expect(mount(SHORT, 'current: deepseek-official/deepseek-v4-flash').text())
      .toContain('current: deepseek-official/deepseek-v4-flash')
  })

  it('initially highlights the caller’s named offered value', () => {
    const view = mount(SHORT, undefined, 'rejected')
    expect(view.text()).toContain('❯ Reject')
    view.press(key('enter'))
    expect(view.settled()).toEqual({ value: 'rejected' })
  })

  it('falls back to the first row when the initial value is not offered', () => {
    const view = mount(SHORT, undefined, 'absent')
    view.press(key('enter'))
    expect(view.settled()).toEqual({ value: 'allowed-once' })
  })

  it('leaves an empty offer unanswerable even with an initial value', () => {
    const view = mount([], undefined, 'absent')
    view.press(key('enter'))
    expect(view.settled()).toBeUndefined()
  })
})

describe('a picker long enough to need searching', () => {
  it('offers a query box and counts the offer', () => {
    const shown = mount(many(400)).text()
    expect(shown).toContain('⌕')
    expect(shown).toContain('400 choices')
    expect(shown).toContain('type to filter')
  })

  it('turns the box on just past the threshold, and not at it', () => {
    expect(mount(many(SEARCHABLE_CHOICES)).text()).not.toContain('⌕')
    expect(mount(many(SEARCHABLE_CHOICES + 1)).text()).toContain('⌕')
  })

  it('keeps a non-first initial value until a query deliberately changes it', () => {
    const choices = many(400)
    const view = mount(choices, undefined, '370')
    expect(view.text()).toContain('❯ openrouter/model-370')
    view.press({ kind: 'text', text: 'last-sentinel' }, key('enter'))
    expect(view.settled()).toEqual({ value: '399' })
  })

  it('filters as you type and says how much is left', () => {
    const view = mount(many(400))
    view.render()
    view.press({ kind: 'text', text: 'model-370' })
    const shown = view.text()
    expect(shown).toContain('openrouter/model-370')
    expect(shown).not.toContain('openrouter/model-120')
    // The counter reports the two numbers separately: what the query left, and
    // what was offered. Conflating them is how a counter starts lying.
    expect(shown).toContain('1 of 400')
  })

  it('confirms the choice the query left selected, not the one behind it', () => {
    const view = mount(many(400))
    view.render()
    view.press({ kind: 'text', text: 'last-sentinel' })
    view.press(key('enter'))
    expect(view.settled()).toEqual({ value: '399' })
  })

  it('confirms nothing while a query has left nothing to confirm', () => {
    // Settling with undefined here would read as a cancellation the reader never
    // asked for.
    const view = mount(many(400))
    view.render()
    view.press({ kind: 'text', text: 'nothing-matches-this' })
    view.press(key('enter'))
    expect(view.settled()).toBeUndefined()
    expect(view.text()).toContain('Nothing to choose from.')
  })

  it('clears the query on the first escape and cancels on the second', () => {
    const view = mount(many(400))
    view.render()
    view.press({ kind: 'text', text: 'x' })
    view.press(key('escape'))
    expect(view.settled()).toBeUndefined()
    expect(view.text()).toContain('400 choices')
    view.press(key('escape'))
    expect(view.settled()).toEqual({ value: undefined })
  })

  it('says which escape is armed', () => {
    const view = mount(many(400))
    expect(view.text()).toContain('esc cancel')
    view.press({ kind: 'text', text: 'x' })
    expect(view.text()).toContain('esc clear')
  })

  it('deletes one character per press, and clears the line', () => {
    const view = mount(many(400))
    view.render()
    view.press({ kind: 'text', text: 'model-1' }, key('backspace'))
    expect(view.text()).toContain('⌕ model-')
    view.press(key('ctrl-u'))
    expect(view.text()).toContain('400 choices')
  })

  it('collapses a pasted newline into the one line a query is', () => {
    const view = mount(many(400))
    view.render()
    view.press({ kind: 'paste', text: 'open\nrouter' })
    expect(view.text()).toContain('⌕ open router')
  })
})

describe('staying inside the terminal', () => {
  it.each([[24], [12], [6]])('draws no more than %i rows for four hundred choices', rows => {
    const view = mount(many(400))
    expect(view.render(COLUMNS, rows).length).toBeLessThanOrEqual(rows)
  })

  it('still draws a framed list at fourteen rows, rather than giving up on one', () => {
    // The row count alone cannot tell a windowed list from the bare fallback, and
    // only one of those is a usable picker. The frame is the evidence the list
    // was WINDOWED to fit rather than abandoned.
    const view = mount(many(400))
    const lines = view.render(COLUMNS, 14)
    expect(lines.length).toBeLessThanOrEqual(14)
    expect(stripAnsi(lines.join('\n'))).toContain('╭')
  })

  it('stays inside the terminal while the selection walks past the window', () => {
    const view = mount(many(400))
    for (let press = 0; press < 450; press += 1) {
      view.press(key('down'))
      expect(view.render(COLUMNS, 14).length).toBeLessThanOrEqual(14)
    }
  })

  it('scrolls the window forward so a walked-to selection stays drawn', () => {
    // Stepping down past the last visible row has to move the window with it;
    // a list that stopped following would leave the reader moving a selection
    // they can no longer see.
    const view = mount(many(400))
    view.render(COLUMNS, 14)
    for (let press = 0; press < 30; press += 1) {
      view.press(key('down'))
      view.render(COLUMNS, 14)
    }
    expect(view.text(COLUMNS, 14)).toContain('openrouter/model-30')
  })

  it('keeps the description of a selected choice in the window beside its label', () => {
    // The description is drawn under the SELECTED row only, so it is the one row
    // that appears as the cursor arrives — and following the label alone scrolled
    // it off exactly when the label reached the last visible row.
    const described = many(400).map(choice => ({
      ...choice,
      description: `about ${choice.label}.`,
    }))
    const view = mount(described)
    view.render(COLUMNS, 14)
    for (let index = 1; index < 40; index += 1) {
      view.press(key('down'))
      const shown = view.text(COLUMNS, 14)
      const label = described[index]?.label ?? ''
      expect(shown).toContain(`❯ ${label}`)
      expect(shown).toContain(`about ${label}.`)
    }
  })

  it('jumps to either end of the list', () => {
    const view = mount(many(400))
    view.render(COLUMNS, 14)
    view.press(key('end'))
    expect(view.text(COLUMNS, 14)).toContain('openrouter/last-sentinel')
    view.press(key('home'))
    expect(view.text(COLUMNS, 14)).toContain('openrouter/first-sentinel')
  })

  it('never draws a row wider than the terminal', () => {
    const view = mount([{ value: 'x', label: `openrouter/${'long-'.repeat(40)}model` }, ...many(20)])
    for (const line of view.render(50, ROWS)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(50)
    }
  })

  it('keeps the question answerable in a terminal too narrow to frame', () => {
    // The frame is what is given up, never the decision: an approval can arrive
    // in any geometry, and a reader who cannot see what they are confirming
    // cannot answer it. Narrow but TALL, so the height leaves room for a frame
    // and only the width rules one out.
    const view = mount(SHORT)
    const lines = view.render(12, 24)
    expect(stripAnsi(lines.join('\n'))).toContain('Allow once')
    expect(stripAnsi(lines.join('\n'))).not.toContain('╭')
  })

  it('keeps it answerable in a terminal too short to frame', () => {
    const view = mount(SHORT)
    const lines = view.render(COLUMNS, 2)
    expect(lines.length).toBeLessThanOrEqual(2)
    expect(stripAnsi(lines.join('\n'))).toContain('Allow once')
  })

  it('shows the selected choice in that fallback, not the first one', () => {
    const view = mount(SHORT)
    view.press(key('down'))
    expect(stripAnsi(mountedFallback(view))).toContain('Reject')
  })
})

describe('a title longer than one row', () => {
  it('wraps a long semantic title instead of truncating the question', () => {
    // The title carries the question for an `ask_user_question` single-select,
    // and the one-row truncation this replaces dropped everything past the
    // frame's inner width with no ellipsis.
    const overlay = createSelectOverlay({
      title: LONG_TITLE,
      view: 'Question',
      choices: SHORT,
      settle: () => {},
      invalidate: () => {},
    })
    for (const columns of [100, 80]) {
      const lines = [...overlay.render(columns, ROWS)]
      const shown = stripAnsi(lines.join('\n'))
      expect(bodyText(shown), `${String(columns)} columns`).toContain(LONG_TITLE)
      // The wrapped heading shrinks the list window; the confirmable rows stay.
      expect(shown, `${String(columns)} columns`).toContain('Allow once')
      for (const line of lines) {
        expect(displayWidth(line), `${String(columns)} columns`).toBeLessThanOrEqual(columns)
      }
    }
  })

  it('charges wrapped title rows against the list capacity at the framed boundary', () => {
    // At 80 columns the long title wraps to two rows, so the heading is three
    // rows and the frame opens at seven with exactly one viewport row. Charging
    // those title rows against `heading.length` is what keeps the frame at the
    // terminal's height: pretending the heading were one row would reclaim two
    // rows for the list and push the frame past the bottom.
    const overlay = createSelectOverlay({
      title: LONG_TITLE,
      view: 'Question',
      choices: SHORT,
      settle: () => {},
      invalidate: () => {},
    })
    const lines = [...overlay.render(COLUMNS, 7)]
    const physical = lines.flatMap(line => wrapToWidth(line, COLUMNS))
    expect(physical.length).toBeLessThanOrEqual(7)
    const shown = stripAnsi(lines.join('\n'))
    expect(shown).toContain('╭')
    expect(bodyText(shown)).toContain(LONG_TITLE)
    // The active, confirmable choice stays visible as the list window shrinks.
    expect(shown).toContain('Allow once')
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(COLUMNS)
    }
  })
})

describe('filterChoices()', () => {
  it('matches the label, case-folded, and keeps the order it was given', () => {
    const choices = [{ value: '0', label: 'B/one' }, { value: '1', label: 'A/One' }]
    expect(filterChoices(choices, ' ONE ').map(choice => choice.value)).toEqual(['0', '1'])
  })

  it('returns the same list for an empty query', () => {
    expect(filterChoices(SHORT, '  ')).toBe(SHORT)
  })

  it('does not match a description, which only the selected row shows', () => {
    // A reader who cannot see why a row matched cannot trust the ones that did not.
    expect(filterChoices(SHORT, 'ask again')).toEqual([])
  })
})

describe('owner-contributed help', () => {
  /** A phrase with no meaning to the picker at all. */
  const OWNER_PHRASE = 'x frobnicate'

  /**
   * Render a picker that carries one owner phrase.
   * @param extraHelp - the phrases the owner contributed.
   * @param columns - terminal width.
   * @returns the rendered rows, ANSI stripped.
   */
  function ownerHelp(extraHelp: readonly string[], columns = COLUMNS): string {
    const overlay = createSelectOverlay({
      title: 'Pick',
      choices: SHORT,
      extraHelp,
      settle: () => {},
      invalidate: () => {},
    })
    return stripAnsi(overlay.render(columns, ROWS).join('\n'))
  }

  it('renders an owner phrase without knowing anything about it', () => {
    // The primitive must not learn subagents, models, or `ctrl-k`: a phrase it
    // has never seen is drawn exactly like any other help segment.
    expect(ownerHelp([OWNER_PHRASE])).toContain(OWNER_PHRASE)
  })

  it('offers no owner help when the owner contributed none', () => {
    expect(ownerHelp([])).not.toContain(OWNER_PHRASE)
  })

  it('makes an owner phrase safe before drawing it', () => {
    // Owner text is untrusted by this seam: an escape sequence is shown, not
    // obeyed.
    expect(ownerHelp(['ctrl-\u001b[2Jx'])).toContain('^[[2J')
  })

  it('drops an owner phrase whole under width pressure rather than cutting it', () => {
    // Wide enough for the full ladder; narrow enough that movement goes first
    // and the owner phrase goes next, while confirmation and the way out stay.
    expect(ownerHelp([OWNER_PHRASE], 80)).toContain(OWNER_PHRASE)

    const narrow = ownerHelp([OWNER_PHRASE], 45)
    expect(narrow).toContain('enter confirm · esc cancel')
    expect(narrow).not.toContain(OWNER_PHRASE)
    // Whole-segment dropping: no truncated prefix of the dropped phrase.
    expect(narrow).not.toContain('x frob')
  })
})

/**
 * The compact fallback for a mounted picker, as plain text.
 * @param view - the mounted picker.
 * @returns the joined lines.
 */
function mountedFallback(view: Mounted): string {
  return view.render(COLUMNS, 2).join('\n')
}
