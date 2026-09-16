/** The Connect browser's sections, keyboard, and states. */

import { describe, expect, it, vi } from 'vitest'
import type { Key } from '@dshline/renderer'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import type { ConnectNewRouteTarget, ConnectProviderRow, ConnectSignInRow, ConnectState } from '../src/connect/model.ts'
import { outcomeLines } from '../src/connect/index.ts'
import type { ConnectOverlay } from '../src/connect/overlay.ts'
import { createConnectOverlay } from '../src/connect/overlay.ts'

/** Width and height of a comfortable terminal. */
const COLUMNS = 90
const ROWS = 24

/** A fixed clock, so notice expiry is exact. */
const NOW = 1_800_000_000_000

/**
 * One configurable provider route.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function provider(overrides: Partial<ConnectProviderRow> = {}): ConnectProviderRow {
  return {
    kind: 'provider',
    provider: 'openai',
    displayName: 'OpenAI',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openai'],
    declared: false,
    state: 'active',
    models: 12,
    credential: {
      field: 'apiKeyEnv',
      ref: 'OPENAI_API_KEY',
      info: { configured: true, source: 'file', writable: true },
    },
    userOwned: true,
    revision: 1,
    ...overrides,
  }
}

/**
 * One registered authorization flow.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function signIn(overrides: Partial<ConnectSignInRow> = {}): ConnectSignInRow {
  return {
    kind: 'sign-in',
    key: 'llm-pi-ai/openai',
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    inFlight: false,
    record: { configured: false, writable: true },
    ...overrides,
  }
}

/** A complete reading with every seam mounted. */
function ready(
  providers: readonly ConnectProviderRow[],
  signIns: readonly ConnectSignInRow[] = [],
  authorization = true,
  newRouteTargets: readonly ConnectNewRouteTarget[] = [],
): ConnectState {
  return {
    kind: 'ready',
    providers,
    signIns,
    capabilities: { settings: true, credentials: true, authorization },
    newRouteTargets,
  }
}

/** An overlay under test, plus what it asked its owner for. */
interface Mounted {
  render(columns?: number, rows?: number): string[]
  text(columns?: number, rows?: number): string
  press(...keys: Key[]): void
  readonly overlay: ConnectOverlay
  readonly acted: string[]
  readonly refreshed: () => number
  readonly closed: () => boolean
}

/**
 * Mount the browser over a fixed reading.
 * @param state - the reading to show.
 * @param now - the clock, when a test moves it.
 * @returns the overlay and its recorded requests.
 */
function mount(state: ConnectState, now: () => number = () => NOW): Mounted {
  const acted: string[] = []
  let refreshed = 0
  let closed = false
  const overlay = createConnectOverlay({
    state: () => state,
    refresh: () => { refreshed += 1 },
    act: row => { acted.push(row.kind === 'provider' ? row.provider : row.kind === 'sign-in' ? row.key : row.label) },
    now,
    close: () => { closed = true },
    invalidate: () => {},
  })
  const render = (columns = COLUMNS, rows = ROWS): string[] => [...overlay.render(columns, rows)]
  return {
    overlay,
    render,
    text: (columns = COLUMNS, rows = ROWS) => stripAnsi(render(columns, rows).join('\n')),
    press: (...keys) => { for (const key of keys) overlay.handleKey(key) },
    acted,
    refreshed: () => refreshed,
    closed: () => closed,
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

describe('what the browser shows', () => {
  it('keeps provider routes and sign-ins in separate named sections', () => {
    // They answer different questions and Harness publishes no correlation
    // between them, so the browser lists both rather than merging them.
    const shown = mount(ready([provider()], [signIn()])).text()
    expect(shown).toContain('Provider routes')
    expect(shown).toContain('Sign-ins')
    expect(shown).toContain('openai')
    expect(shown).toContain('ChatGPT (Codex)')
  })

  it('names both the display name and the route key', () => {
    // The route key is what `/model` prints and what settings.yaml addresses.
    expect(mount(ready([provider()])).text()).toContain('OpenAI  openai')
  })

  it('reports a live route with its model count and where its key comes from', () => {
    const shown = mount(ready([provider()])).text()
    expect(shown).toContain('active')
    expect(shown).toContain('12 models')
    expect(shown).toContain('key from file')
  })

  it('makes an activatable dormant route’s next step visible', () => {
    const dormant = provider({
      state: 'dormant',
      models: undefined,
      userOwned: false,
      credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
    })
    const view = mount(ready([dormant]))
    expect(view.text()).toContain('not active · activate to add models')
    // The instruction gives way before the provider identity does.
    expect(view.text(55, ROWS)).toContain('OpenAI')
  })

  it('does not promise activation for a dormant route the picker cannot activate', () => {
    const dormant = provider({
      state: 'dormant',
      models: undefined,
      revision: undefined,
      userOwned: false,
      credential: { field: 'apiKeyEnv', ref: undefined, info: undefined },
    })
    const shown = mount(ready([dormant])).text()
    expect(shown).toContain('not active')
    expect(shown).not.toContain('activate to add models')
  })

  it('shows the settings address of the selected row only', () => {
    const shown = mount(ready([provider(), provider({ provider: 'anthropic', displayName: 'Anthropic' })])).text()
    expect(shown.match(/llm-pi-ai · providers\./gu)).toHaveLength(1)
  })

  it('shows an escape sequence from the settings document instead of obeying it', () => {
    // A credential reference is whatever the settings file says, and a source
    // layer name is whatever the credential provider calls it.
    const row = provider({
      credential: { field: 'apiKeyEnv', ref: 'KEY\u001b[2J', info: { configured: false, writable: true } },
    })
    expect(mount(ready([row])).text()).toContain('^[[2J')
  })

  it('says what an empty section means rather than leaving a gap', () => {
    const shown = mount(ready([], [], false)).text()
    expect(shown).toContain('No mounted adapter declares a configurable provider.')
    expect(shown).toContain('This profile mounts no authorization service.')
  })

  it('says it is still reading before the first pass lands', () => {
    expect(mount({ kind: 'loading' }).text()).toContain('Reading provider configuration…')
  })

  it('reports a failed read in Harness own words', () => {
    expect(mount({ kind: 'failed', message: 'registry is down' }).text())
      .toContain('Harness could not be read: registry is down')
  })
})

describe('moving and choosing', () => {
  it('walks both sections as one selection', () => {
    const view = mount(ready([provider()], [signIn()]))
    view.render()
    view.press(key('down'))
    view.press(key('enter'))
    expect(view.acted).toEqual(['llm-pi-ai/openai'])
  })

  it('wraps around at either end', () => {
    const view = mount(ready([provider()], [signIn()]))
    view.render()
    view.press(key('up'))
    view.press(key('enter'))
    expect(view.acted).toEqual(['llm-pi-ai/openai'])
  })

  it('does nothing on enter when the query left no rows', () => {
    const view = mount(ready([provider()]))
    view.render()
    view.press({ kind: 'text', text: 'zzz' })
    view.render()
    view.press(key('enter'))
    expect(view.acted).toEqual([])
  })
})

describe('filtering', () => {
  it('narrows both sections as you type, and counts what is left', () => {
    const view = mount(ready([provider(), provider({ provider: 'anthropic', displayName: 'Anthropic' })], [signIn()]))
    view.render()
    view.press({ kind: 'text', text: 'anthro' })
    const shown = view.text()
    expect(shown).toContain('anthropic')
    expect(shown).not.toContain('ChatGPT')
    expect(shown).toContain('1 of 3')
  })

  it('keeps the newest characters of a query longer than the box', () => {
    // The query box scrolls from the left for the reason the input field does:
    // hiding the tail hides what is being typed.
    const view = mount(ready([provider()]))
    view.render(60, ROWS)
    view.press({ kind: 'text', text: `${'a'.repeat(120)}TAIL` })
    expect(view.text(60)).toContain('TAIL')
  })

  it('collapses a pasted newline into the one line a query is', () => {
    const view = mount(ready([provider()]))
    view.render()
    view.press({ kind: 'paste', text: 'open\nai' })
    expect(view.text()).toContain('⌕ open ai')
  })

  it('clears the query on the first escape and closes on the second', () => {
    const view = mount(ready([provider()]))
    view.render()
    view.press({ kind: 'text', text: 'x' })
    view.press(key('escape'))
    expect(view.closed()).toBe(false)
    view.render()
    view.press(key('escape'))
    expect(view.closed()).toBe(true)
  })

  it('says which escape is armed', () => {
    const view = mount(ready([provider()]))
    expect(view.text()).toContain('esc close')
    view.press({ kind: 'text', text: 'x' })
    expect(view.text()).toContain('esc clear')
  })
})

describe('opening on a named route', () => {
  it('starts filtered when the command named one', () => {
    // `/connect openai` says WHICH route you mean; what to do with it is still a
    // choice between storing a key, activating it, and removing it.
    const overlay = createConnectOverlay({
      state: () => ready([provider(), provider({ provider: 'anthropic', displayName: 'Anthropic' })]),
      query: 'anthropic',
      refresh: () => {},
      act: () => {},
      now: () => NOW,
      close: () => {},
      invalidate: () => {},
    })
    const shown = stripAnsi(overlay.render(COLUMNS, ROWS).join('\n'))
    expect(shown).toContain('⌕ anthropic')
    expect(shown).toContain('1 of 2')
  })
})

describe('asking Harness again', () => {
  it('refreshes on ctrl-r, because a settings file edited elsewhere fires nothing here', () => {
    const view = mount(ready([provider()]))
    view.press(key('ctrl-r'))
    expect(view.refreshed()).toBe(1)
  })

  it('offers the gesture in the help line', () => {
    expect(mount(ready([provider()])).text()).toContain('ctrl-r refresh')
  })
})

describe('reporting a result', () => {
  it('shows the sentence its owner gave over the list, then lets the list return', () => {
    let clock = NOW
    const view = mount(ready([provider()]), () => clock)
    view.overlay.report('openai: key stored behind OPENAI_API_KEY', false)
    expect(view.text()).toContain('key stored behind OPENAI_API_KEY')
    clock = NOW + 6_000
    expect(view.text()).not.toContain('key stored behind OPENAI_API_KEY')
  })

  it('never commits a transcript row of its own', () => {
    // The overlay is temporary chrome. Its owner decides what reaches
    // scrollback; a notice that wrote itself there could not expire.
    const view = mount(ready([provider()]))
    view.overlay.report('anything', true)
    expect(view.render().length).toBeGreaterThan(0)
  })

  it('asks for a repaint when a result expires, with no keypress', () => {
    // The shared notice owns one unref'd timer; an idle browser otherwise kept
    // the expired result on screen until some unrelated paint.
    vi.useFakeTimers()
    try {
      let invalidates = 0
      const overlay = createConnectOverlay({
        state: () => ready([provider()]),
        refresh: () => {},
        act: () => {},
        now: () => Date.now(),
        close: () => {},
        invalidate: () => { invalidates += 1 },
      })
      overlay.render(COLUMNS, ROWS)
      overlay.report('openai: key stored', false)
      const afterShow = invalidates
      vi.advanceTimersByTime(5_000)
      expect(invalidates).toBe(afterShow + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the transcript row an outcome becomes', () => {
  it('escapes the message before styling it, never after', () => {
    // The message carries a credential reference out of the settings document
    // and a Harness error's own words. `escapeControls` neutralizes the escape
    // character itself, so running it over already-coloured text would destroy
    // the colour — the whole line is escaped first, then styled.
    const line = outcomeLines({ kind: 'failed', message: 'llm-pi-ai refused: \u001b[2Jgone' })[0] ?? ''
    expect(stripAnsi(line)).toContain('^[[2J')
    expect(stripAnsi(line)).not.toContain('\u001b[2J')
    // Styling survives: the escaping ran before it, not over it.
    expect(line).not.toBe(stripAnsi(line))
  })

  it('marks a refusal differently from a change that landed', () => {
    expect(stripAnsi(outcomeLines({ kind: 'done', message: 'openai: key stored' })[0] ?? ''))
      .toBe('· connect: openai: key stored')
    expect(stripAnsi(outcomeLines({ kind: 'failed', message: 'openai: refused' })[0] ?? ''))
      .toBe('✗ connect: openai: refused')
  })
})

describe('geometry', () => {
  it.each([[24], [12], [8]])('stays inside a %i-row terminal', rows => {
    const many = Array.from({ length: 40 }, (_unused, index) =>
      provider({ provider: `route-${String(index)}`, displayName: `Route ${String(index)}` }))
    const view = mount(ready(many, [signIn()]))
    expect(view.render(COLUMNS, rows).length).toBeLessThanOrEqual(rows)
  })

  it('never draws a row wider than the terminal', () => {
    const view = mount(ready([provider({ displayName: 'A provider with a very long human readable name indeed' })]))
    for (const line of view.render(60, ROWS)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(60)
    }
  })

  it('falls back to one closable line in a terminal too small to frame', () => {
    const view = mount(ready([provider()]))
    const lines = view.render(20, 4)
    expect(lines).toHaveLength(1)
    expect(stripAnsi(lines[0] ?? '')).toContain('esc')
  })

  it('gives the refusal precedence over the count in that fallback', () => {
    const view = mount(ready([provider()]))
    view.overlay.report('llm-pi-ai refused the profile', true)
    expect(stripAnsi(view.render(40, 3).join(''))).toContain('refused')
  })
})

describe('the overflow hint', () => {
  const TARGET: ConnectNewRouteTarget = { settingsNs: 'llm-pi-ai', parentPath: ['providers'], revision: 3 }

  it('does not claim more below for hidden section chrome alone', () => {
    // One selectable row, and a Sign-ins section that is only a heading and an
    // empty explanation. At this height those presentation lines fall below the
    // window; no CHOICE does, so the hint must stay off. The old
    // `viewport.end < rendered.rows.length` reported one anyway.
    const shown = mount(ready([provider()])).text(COLUMNS, 8)
    expect(shown).toContain('1 row')
    expect(shown).not.toContain('more below')
  })

  it('does not treat the selected row’s own detail line as a hidden choice', () => {
    // Capacity two puts the provider entry in view and its detail line just
    // below `viewport.end`. That line is geometry the selected entry owns, not
    // a second selectable entry.
    const shown = mount(ready([provider()])).text(COLUMNS, 7)
    expect(shown).toContain('1 row')
    expect(shown).not.toContain('more below')
  })

  it('still reports a real selectable provider below the window', () => {
    const view = mount(ready([
      provider(),
      provider({ provider: 'anthropic', displayName: 'Anthropic' }),
      provider({ provider: 'google', displayName: 'Google' }),
    ]))
    const shown = view.text(COLUMNS, 7)
    expect(shown).toContain('3 rows')
    expect(shown).toContain('more below')
  })

  it('stops reporting more below once the last selectable row is visible', () => {
    // Two providers. Selecting the second moves the detail line below both, so
    // no selectable row is at or past `viewport.end` even though the Sign-ins
    // heading and its empty explanation still sit below it.
    const view = mount(ready([provider(), provider({ provider: 'anthropic', displayName: 'Anthropic' })]))
    view.render(COLUMNS, 8)
    view.press(key('down'))
    const shown = view.text(COLUMNS, 8)
    expect(shown).toContain('2 rows')
    expect(shown).not.toContain('more below')
  })

  it('keeps "N of M" but drops the hint when the only match is visible', () => {
    // The filter leaves one selectable row, but both sections still draw their
    // headings and the Sign-ins section its empty explanation.
    const view = mount(ready(
      [provider(), provider({ provider: 'anthropic', displayName: 'Anthropic' })],
      [signIn()],
    ))
    view.render(COLUMNS, 8)
    view.press({ kind: 'text', text: 'anthro' })
    const shown = view.text(COLUMNS, 8)
    expect(shown).toContain('1 of 3')
    expect(shown).not.toContain('more below')
  })

  it('treats the synthetic create row as selectable', () => {
    // Nothing else is selectable, and the create row is visible: the hidden
    // lines are only headings and an empty explanation, so no hint.
    const shown = mount(ready([], [], false, [TARGET])).text(COLUMNS, 8)
    expect(shown).toContain('1 row')
    expect(shown).not.toContain('more below')
  })

  it('reports more below when the hidden selectable row is the create row', () => {
    // One provider visible, the create row below `viewport.end`. Ignoring the
    // create row when recording selectable positions would hide the hint.
    const shown = mount(ready([provider()], [], true, [TARGET])).text(COLUMNS, 7)
    expect(shown).toContain('2 rows')
    expect(shown).toContain('more below')
  })

  it('lets selection push a still-hidden selectable row below the window', () => {
    // Both providers fit while the second is selected. Moving back up to the
    // first inserts that row's detail line above the second provider, pushing
    // it past `viewport.end` — a real hidden choice, so the hint returns. This
    // is why the hint cannot be frozen against selection changes.
    const view = mount(ready([provider(), provider({ provider: 'anthropic', displayName: 'Anthropic' })]))
    view.render(COLUMNS, 8)
    view.press(key('down'))
    expect(view.text(COLUMNS, 8)).not.toContain('more below')
    view.press(key('up'))
    expect(view.text(COLUMNS, 8)).toContain('more below')
  })

  it('does not report more below merely because later logical rows exist', () => {
    // A tall terminal shows every provider while the first is selected. An
    // implementation keyed on `selected < shown - 1` would call that "more"
    // even though the later rows are already on screen.
    const shown = mount(ready([
      provider(),
      provider({ provider: 'anthropic', displayName: 'Anthropic' }),
      provider({ provider: 'google', displayName: 'Google' }),
    ])).text(COLUMNS, ROWS)
    expect(shown).toContain('3 rows')
    expect(shown).not.toContain('more below')
  })
})

describe('the create-route entry point', () => {
  const TARGET: ConnectNewRouteTarget = { settingsNs: 'llm-pi-ai', parentPath: ['providers'], revision: 3 }

  it('is absent when nothing is declarable', () => {
    expect(mount(ready([provider()])).text()).not.toContain('Add custom provider')
  })

  it('appears at the foot of the provider section, once, when something is declarable', () => {
    const shown = mount(ready([provider()], [], true, [TARGET])).text()
    expect(shown.match(/Add custom provider/gu)).toHaveLength(1)
  })

  it('names the namespace it would write to in its own detail line', () => {
    // A different namespace than the ordinary provider row's, so the assertion
    // can only pass by actually reaching the create row's own detail line.
    const other: ConnectNewRouteTarget = { settingsNs: 'llm-other', parentPath: ['providers'], revision: 1 }
    const view = mount(ready([provider()], [], true, [other]))
    view.render()
    view.press(key('down')) // the create row, after the one provider row
    expect(view.text()).toContain('llm-other')
  })

  it('acts on the create row like any other selectable row', () => {
    const view = mount(ready([], [], true, [TARGET]))
    view.render()
    view.press(key('enter')) // the only selectable row
    expect(view.acted).toEqual(['Add custom provider'])
  })

  it('is matched by its label when a query is typed', () => {
    const view = mount(ready([provider()], [], true, [TARGET]))
    view.press({ kind: 'text', text: 'custom' })
    expect(view.text()).toContain('Add custom provider')
    expect(view.text()).not.toContain('openai')
  })

  it('counts the create row in the unfiltered total, never reading "3 of 2"', () => {
    // `shown` and `total` must describe the same row set. Before the shared
    // count, the create row was visible but excluded from the denominator.
    const shown = mount(ready([provider()], [signIn()], true, [TARGET])).text()
    expect(shown).toContain('3 rows')
    expect(shown).not.toContain('3 of 2')
  })

  it('narrows that same total when a query matches only the create row', () => {
    const view = mount(ready([provider()], [signIn()], true, [TARGET]))
    view.render()
    view.press({ kind: 'text', text: 'custom' })
    expect(view.text()).toContain('1 of 3')
  })

  it('calls a lone create row one row rather than "1 of 0"', () => {
    const shown = mount(ready([], [], true, [TARGET])).text()
    expect(shown).toContain('1 row')
    expect(shown).not.toContain('1 of 0')
  })
})
