/**
 * The `ctrl-r` overlay: what each key does, what it draws, and what it leaves
 * the composer and the history holding afterwards.
 *
 * The draft assertions check the CURSOR as well as the text. A search that
 * previewed results into the buffer could restore the characters and still put
 * the cursor at the end of them, which is the same bug with a smaller blast
 * radius — and the reason the implementation never writes to the composer at all.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { Composer, stripAnsi } from '@dshline/renderer'
import type { Key } from '@dshline/renderer'
import { createCompletion } from '../src/completion.ts'
import type { Completion } from '../src/completion.ts'
import { HistorySearch } from '../src/history-search.ts'
import { createHistorySearchOverlay } from '../src/history-search-overlay.ts'
import { InputHistory } from '../src/history.ts'
import type { ComposerGeometry } from '../src/input.ts'
import { applyHistorySearch, routeInputKey } from '../src/input.ts'
import { createSelectOverlay } from '../src/select.ts'
import { TuiSlots } from '../src/slots.ts'
import type { TuiOverlay } from '../src/slots.ts'

/** A terminal wide and tall enough that nothing is given up to geometry. */
const COLUMNS = 80
const ROWS = 24

/** A wide geometry so ordinary lines never wrap during routing assertions. */
const WIDE: ComposerGeometry = { width: 120, gutter: line => (line === 0 ? '› ' : '  ') }

const UP = { kind: 'key', name: 'up' } as const
const DOWN = { kind: 'key', name: 'down' } as const

/**
 * One named key, as the decoder produces it.
 * @param name - the key name.
 * @returns the decoded key.
 */
function key(name: string): Key {
  return { kind: 'key', name } as Key
}

/**
 * An {@link InputHistory} holding the given submissions, in order.
 * @param lines - the lines to record.
 * @returns the populated history.
 */
function recorded(...lines: string[]): InputHistory {
  const history = new InputHistory()
  for (const line of lines) history.record(line)
  return history
}

/** A mounted overlay and everything the wiring around it settled. */
interface Mounted {
  readonly overlay: TuiOverlay
  readonly search: HistorySearch
  /** Settlement answers, in order; each is a position or a cancellation. */
  readonly settled: (number | undefined)[]
  /** How many redraws the overlay asked for. */
  redraws(): number
  /** Feed one key, or a whole typed string, to the overlay. */
  press(...keys: (Key | string)[]): void
  /** The visible rows, with styling removed. */
  rows(columns?: number, rows?: number): string[]
}

/**
 * Mount a search overlay over a history.
 * @param history - the corpus to search.
 * @returns the overlay and its observed effects.
 */
function mount(history: InputHistory): Mounted {
  const search = new HistorySearch(history)
  const settled: (number | undefined)[] = []
  let drawn = 0
  const overlay = createHistorySearchOverlay({
    search,
    settle: index => { settled.push(index) },
    invalidate: () => { drawn += 1 },
  })
  return {
    overlay,
    search,
    settled,
    redraws: () => drawn,
    press: (...keys) => {
      for (const entry of keys) {
        if (typeof entry !== 'string') {
          overlay.handleKey(entry)
          continue
        }
        for (const character of entry) overlay.handleKey({ kind: 'text', text: character })
      }
    },
    rows: (columns = COLUMNS, terminalRows = ROWS) =>
      overlay.render(columns, terminalRows).map(line => stripAnsi(line)),
  }
}

/** Completion sources offering only the named commands. */
function completionFor(composer: Composer, commands: readonly string[]): Completion {
  return createCompletion(composer, {
    commands: () => commands.map(name => ({ name, description: '' })),
    commandArguments: async () => [],
    paths: async () => [],
  }, () => {})
}

describe('the history-search overlay', () => {
  it('opens on the newest entry with an empty query', () => {
    const view = mount(recorded('older prompt', 'newest prompt'))

    // Deliberately not seeded from the composer's draft and not carried over
    // from a previous search: both make the first frame a list the reader did
    // not ask for.
    expect(view.search.query).toBe('')
    expect(view.search.selectedText).toBe('newest prompt')
    expect(view.rows().join('\n')).toContain('❯ newest prompt')
  })

  it('filters as characters arrive and redraws for each', () => {
    const view = mount(recorded('run the tests', 'explain the auth flow', 'fix auth retry'))
    view.press('auth')

    expect(view.redraws()).toBe(4)
    expect(view.search.matches).toEqual([2, 1])
    const text = view.rows().join('\n')
    expect(text).toContain('⌕ auth█')
    expect(text).toContain('❯ fix auth retry')
    expect(text).toContain('explain the auth flow')
    expect(text).not.toContain('run the tests')
  })

  it('walks older on ctrl-r and on down, and newer on up', () => {
    const view = mount(recorded('log a', 'log b', 'log c'))
    view.press('log')

    view.press(key('ctrl-r'))
    expect(view.search.selectedText).toBe('log b')
    view.press(DOWN)
    expect(view.search.selectedText).toBe('log a')
    view.press(UP)
    expect(view.search.selectedText).toBe('log b')
  })

  it('stops at either end rather than wrapping, and does not redraw for a press that moved nothing', () => {
    const view = mount(recorded('log a', 'log b'))
    view.press('log')
    const before = view.redraws()

    view.press(UP)
    expect(view.redraws()).toBe(before)
    view.press(key('ctrl-r'), key('ctrl-r'), DOWN)
    expect(view.search.selectedText).toBe('log a')
    expect(view.redraws()).toBe(before + 1)
  })

  it('jumps to the newest match on home and the oldest on end', () => {
    const view = mount(recorded('log a', 'log b', 'log c'))
    view.press('log', key('end'))
    expect(view.search.selectedText).toBe('log a')
    view.press(key('home'))
    expect(view.search.selectedText).toBe('log c')
    view.press(key('ctrl-e'))
    expect(view.search.selectedText).toBe('log a')
    view.press(key('ctrl-a'))
    expect(view.search.selectedText).toBe('log c')
  })

  it('edits the query with backspace, ctrl-u, and ctrl-w', () => {
    const view = mount(recorded('run the tests'))
    view.press('run the')
    view.press(key('ctrl-w'))
    expect(view.search.query).toBe('run ')
    view.press(key('backspace'))
    expect(view.search.query).toBe('run')
    view.press(key('ctrl-u'))
    expect(view.search.query).toBe('')
  })

  it('turns pasted line breaks into one space, since the query is one line', () => {
    const view = mount(recorded('deploy the staging build'))
    view.overlay.handleKey({ kind: 'paste', text: 'deploy\r\n\nthe' })

    expect(view.search.query).toBe('deploy the')
    expect(view.search.matches).toEqual([0])
  })

  it('keeps repeated spaces in a pasted query, because matching is literal', () => {
    const view = mount(recorded('run tests', 'run  tests'))
    view.overlay.handleKey({ kind: 'paste', text: 'run  tests' })

    // Collapsing whitespace here would search for something other than what was
    // pasted, against a feature that documents spaces as meaningful.
    expect(view.search.query).toBe('run  tests')
    expect(view.search.matches).toEqual([1])
    expect(view.search.selectedText).toBe('run  tests')
  })

  it('keeps leading and trailing spaces in a pasted query', () => {
    const view = mount(recorded('a line with  padding  inside'))
    view.overlay.handleKey({ kind: 'paste', text: ' with  padding ' })

    expect(view.search.query).toBe(' with  padding ')
    expect(view.search.matches).toEqual([0])
  })

  it('settles with the selected historical position on enter', () => {
    const view = mount(recorded('log a', 'log b', 'log c'))
    view.press('log', key('ctrl-r'), key('enter'))

    expect(view.settled).toEqual([1])
  })

  it('settles with a cancellation on escape', () => {
    const view = mount(recorded('log a'))
    view.press(key('escape'))

    expect(view.settled).toEqual([undefined])
  })

  it('cancels the search on ctrl-c rather than letting it through', () => {
    const view = mount(recorded('log a'))
    view.press(key('ctrl-c'))

    // The overlay owns input while it is mounted, so a running turn underneath
    // is not interrupted by the press that closed this.
    expect(view.settled).toEqual([undefined])
  })

  it('settles exactly once, however many keys arrive during the unmount', () => {
    const view = mount(recorded('log a'))
    view.press(key('enter'), key('enter'), key('escape'), key('ctrl-c'))

    expect(view.settled).toEqual([0])
  })

  it('does not settle on enter when nothing matched', () => {
    const view = mount(recorded('log a'))
    view.press('zzz', key('enter'))

    // Settling with undefined here would read as a cancellation the reader
    // never asked for, and settling with a position would recall nothing.
    expect(view.settled).toEqual([])
  })

  it('does not claim ctrl-d, which the window reads before any overlay', () => {
    const view = mount(recorded('log a'))
    const before = view.redraws()
    view.press(key('ctrl-d'))

    // Quitting means the same thing everywhere, so this overlay must not turn
    // it into a cancellation or anything else on its way past.
    expect(view.settled).toEqual([])
    expect(view.redraws()).toBe(before)
    expect(view.search.query).toBe('')
  })

  it('has no second mode behind tab', () => {
    const view = mount(recorded('log a'))
    const before = view.redraws()
    view.press(key('tab'))

    expect(view.settled).toEqual([])
    expect(view.redraws()).toBe(before)
  })

  it('reports an empty session as one with nothing sent yet', () => {
    expect(mount(recorded()).rows().join('\n')).toContain('Nothing has been sent in this session yet.')
  })

  it('says nothing matched when the corpus is there but the query is not in it', () => {
    const view = mount(recorded('alpha'))
    view.press('zzz')

    expect(view.rows().join('\n')).toContain('No input matches that.')
  })
})

describe('a search over a draft', () => {
  it('leaves the text and the cursor exactly where cancellation found them', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'an unfinished draft' })
    for (let step = 0; step < 7; step += 1) composer.handle(key('left'))
    const before = { value: composer.value, position: composer.position }

    const history = recorded('log a', 'log b')
    const view = mount(history)
    view.press('log', key('ctrl-r'), key('escape'))
    expect(view.settled).toEqual([undefined])
    applyHistorySearch(view.settled[0], composer, history)

    expect(composer.value).toBe(before.value)
    expect(composer.position).toBe(before.position)
  })

  it('leaves a multiline draft and its cursor untouched', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'first line\nsecond line\nthird line' })
    for (let step = 0; step < 12; step += 1) composer.handle(key('left'))
    const before = { value: composer.value, position: composer.position }

    const history = recorded('log a')
    const view = mount(history)
    view.press('log', key('escape'))
    applyHistorySearch(view.settled[0], composer, history)

    expect(composer.value).toBe('first line\nsecond line\nthird line')
    expect(composer.position).toBe(before.position)
  })

  it('returns to the exact ordinary history-navigation state it was opened from', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'my unfinished draft' })
    const history = recorded('oldest', 'middle', 'newest')
    const completion = completionFor(composer, [])

    routeInputKey(UP, composer, completion, history, WIDE)
    routeInputKey(UP, composer, completion, history, WIDE)
    expect(composer.value).toBe('middle')

    const view = mount(history)
    view.press('old', key('escape'))
    applyHistorySearch(view.settled[0], composer, history)

    // The traversal is where it was: one older is `oldest`, and walking forward
    // still reaches the draft that was saved before the search ever opened.
    expect(composer.value).toBe('middle')
    expect(history.navigating).toBe(true)
    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('oldest')
    routeInputKey(DOWN, composer, completion, history, WIDE)
    routeInputKey(DOWN, composer, completion, history, WIDE)
    routeInputKey(DOWN, composer, completion, history, WIDE)
    expect(composer.value).toBe('my unfinished draft')
  })
})

describe('applyHistorySearch()', () => {
  it('recalls the chosen entry into the composer without submitting it', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'unfinished' })
    const history = recorded('A', 'B', 'C', 'D')

    const view = mount(history)
    view.press('B', key('enter'))
    const reopen = applyHistorySearch(view.settled[0], composer, history)

    expect(composer.value).toBe('B')
    // Nothing was sent: recall puts a line in the buffer and stops there, so a
    // typo in the query cannot execute a command.
    expect(reopen).toBe(false)
    expect(history.navigating).toBe(true)
  })

  it('continues ordinary navigation relative to the recalled entry', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'unfinished' })
    const history = recorded('A', 'B', 'C', 'D')
    const completion = completionFor(composer, [])

    const view = mount(history)
    view.press('B', key('enter'))
    applyHistorySearch(view.settled[0], composer, history)

    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('A')
    routeInputKey(DOWN, composer, completion, history, WIDE)
    expect(composer.value).toBe('B')
    routeInputKey(DOWN, composer, completion, history, WIDE)
    expect(composer.value).toBe('C')
    routeInputKey(DOWN, composer, completion, history, WIDE)
    routeInputKey(DOWN, composer, completion, history, WIDE)
    // Past the newest entry is the draft the search never touched.
    expect(composer.value).toBe('unfinished')
  })

  it('recalls the exact occurrence of a duplicated line, not the first one with that text', () => {
    const composer = new Composer()
    const history = recorded('run tests', 'run the build', 'run tests')
    const completion = completionFor(composer, [])

    const view = mount(history)
    view.press('run tests')
    // Two results with identical text; the OLDER one is chosen.
    expect(view.search.matches).toEqual([2, 0])
    view.press(key('ctrl-r'), key('enter'))
    expect(view.settled).toEqual([0])
    applyHistorySearch(view.settled[0], composer, history)

    expect(composer.value).toBe('run tests')
    // Position 0 is the oldest entry, so there is nothing older to step to.
    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('composer')
    expect(composer.value).toBe('run tests')
    routeInputKey(DOWN, composer, completion, history, WIDE)
    expect(composer.value).toBe('run the build')
  })

  it('recalls the newer occurrence of a duplicated line when that is the one selected', () => {
    const composer = new Composer()
    const history = recorded('run tests', 'run the build', 'run tests')
    const completion = completionFor(composer, [])

    const view = mount(history)
    view.press('run tests', key('enter'))
    // The NEWEST duplicate this time, which is the case a text lookup gets
    // wrong: scanning the history for the matching string finds position 0 and
    // silently recalls a different entry with the same text.
    expect(view.settled).toEqual([2])
    applyHistorySearch(view.settled[0], composer, history)

    expect(composer.value).toBe('run tests')
    expect(routeInputKey(UP, composer, completion, history, WIDE)).toBe('history')
    expect(composer.value).toBe('run the build')
  })

  it('ends traversal on the first edit of a recalled line, by the ordinary rule', () => {
    const composer = new Composer()
    const history = recorded('A', 'B', 'C')

    const view = mount(history)
    view.press('B', key('enter'))
    applyHistorySearch(view.settled[0], composer, history)

    const before = composer.value
    composer.handle({ kind: 'text', text: '!' })
    expect(history.resetIfEdited(before, composer.value)).toBe(true)
    expect(history.navigating).toBe(false)
  })

  it('keeps traversal after a cursor-only move of a recalled line', () => {
    const composer = new Composer()
    const history = recorded('A', 'B', 'C')

    const view = mount(history)
    view.press('B', key('enter'))
    applyHistorySearch(view.settled[0], composer, history)

    const before = composer.value
    composer.handle(key('left'))
    expect(history.resetIfEdited(before, composer.value)).toBe(false)
    expect(history.navigating).toBe(true)
  })

  it('makes a recalled line safe to draw, as an arrow-recalled one is', () => {
    const composer = new Composer()
    const history = new InputHistory()
    // A durable log can carry anything a tool or a paste put into a prompt.
    history.record('before\u001b[31mred\u0007 after')

    const view = mount(history)
    view.press(key('enter'))
    applyHistorySearch(view.settled[0], composer, history)

    expect(composer.value).not.toContain('\u001b')
    expect(composer.value).toContain('^[[31mred^G')
  })

  it('lets completion recompute after a cancellation over an ordinary draft', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: '/mod' })
    const history = recorded('something')

    const view = mount(history)
    view.press(key('escape'))

    // The draft is unchanged and nothing owns the arrows, so the caller may
    // refresh completion exactly as any cursor move would.
    expect(applyHistorySearch(view.settled[0], composer, history)).toBe(true)
  })

  it('keeps completion shut over a line an accepted result recalled', () => {
    const composer = new Composer()
    const history = recorded('explain this', '/model deepseek-v4-pro')

    const view = mount(history)
    view.press('/model', key('enter'))
    const reopen = applyHistorySearch(view.settled[0], composer, history)

    // A recalled `/model …` is completable. Reopening a list over it would let
    // the list swallow the next vertical arrow, which is the regression the
    // ordinary recall path already guards against.
    expect(composer.value).toBe('/model deepseek-v4-pro')
    expect(reopen).toBe(false)
  })

  it('keeps completion shut when a cancellation returns to a recalled line', () => {
    const composer = new Composer()
    const history = recorded('explain this', '/model deepseek-v4-pro')
    const completion = completionFor(composer, ['model'])
    routeInputKey(UP, composer, completion, history, WIDE)
    expect(composer.value).toBe('/model deepseek-v4-pro')

    const view = mount(history)
    view.press(key('escape'))

    expect(applyHistorySearch(view.settled[0], composer, history)).toBe(false)
  })
})

describe('completion while a search opens', () => {
  it('hides a visible list and abandons an in-flight lookup', async () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '/m' })
    const completion = completionFor(composer, ['model'])
    await completion.refresh()
    expect(completion.active).toBe(true)

    // What the attachment does on ctrl-r, before the overlay is mounted.
    completion.invalidate()

    expect(completion.active).toBe(false)
  })

  it('does not let a stale lookup land candidates while the search is open', async () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: '@pack' })
    let release = (): void => {}
    const completion = createCompletion(composer, {
      commands: () => [],
      commandArguments: async () => [],
      paths: () => new Promise(resolve => {
        release = () => { resolve([{ name: 'packages', directory: true }]) }
      }),
    }, () => {})
    const pending = completion.refresh()

    completion.invalidate()
    const view = mount(recorded('a prompt'))
    view.press('prompt')
    release()
    await pending

    // The directory read resolves against a generation that has been retired,
    // so nothing appears over or after the query.
    expect(completion.active).toBe(false)
    expect(view.search.query).toBe('prompt')
  })
})

describe('who owns ctrl-r', () => {
  /**
   * The routing `attachment.ts` installs: the window has already taken `ctrl-d`,
   * a mounted overlay takes everything else, and only the composer's own turn
   * reaches the search.
   * @param slots - the registry the overlays are mounted on.
   * @param opened - counts the searches the composer's turn would have opened.
   * @returns the dispatcher.
   */
  function dispatcher(slots: TuiSlots, opened: { count: number }): (key: Key) => void {
    return pressed => {
      const overlay = slots.activeOverlay
      if (overlay !== undefined) {
        overlay.handleKey(pressed)
        return
      }
      if (pressed.kind === 'key' && pressed.name === 'ctrl-r') opened.count += 1
    }
  }

  it('opens a search when ordinary composer input owns the key', () => {
    const slots = new TuiSlots(new Context())
    const opened = { count: 0 }

    dispatcher(slots, opened)(key('ctrl-r'))

    expect(opened.count).toBe(1)
  })

  it('leaves ctrl-r to whichever overlay is mounted', () => {
    const slots = new TuiSlots(new Context())
    const opened = { count: 0 }
    const seen: string[] = []
    // Any overlay: `/connect` refreshes on ctrl-r, an approval may ignore it, a
    // question owns input outright. None of them may lose it to a search.
    slots.pushOverlay({
      render: () => [],
      handleKey: pressed => { if (pressed.kind === 'key') seen.push(pressed.name) },
    })

    dispatcher(slots, opened)(key('ctrl-r'))

    expect(seen).toEqual(['ctrl-r'])
    expect(opened.count).toBe(0)
  })

  it('does not open a second search over the one already up', () => {
    const slots = new TuiSlots(new Context())
    const opened = { count: 0 }
    const history = recorded('log a', 'log b')
    const search = new HistorySearch(history)
    slots.pushOverlay(createHistorySearchOverlay({
      search,
      settle: () => {},
      invalidate: () => {},
    }))

    dispatcher(slots, opened)(key('ctrl-r'))

    expect(opened.count).toBe(0)
    expect(search.selectedText).toBe('log a')
  })

  it('leaves ctrl-r to a real picker mounted over the composer', () => {
    const slots = new TuiSlots(new Context())
    const opened = { count: 0 }
    const answers: (string | undefined)[] = []
    slots.pushOverlay(createSelectOverlay({
      title: 'Select a model',
      choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      settle: value => { answers.push(value) },
      invalidate: () => {},
    }))

    const dispatch = dispatcher(slots, opened)
    dispatch(key('ctrl-r'))
    dispatch(key('down'))
    dispatch(key('enter'))

    // The picker ignored ctrl-r, as it always has, and nothing about it changed.
    expect(opened.count).toBe(0)
    expect(answers).toEqual(['b'])
  })
})
