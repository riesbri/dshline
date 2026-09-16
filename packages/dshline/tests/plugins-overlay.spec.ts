/** The Plugins browser's rendering, search mode, and single-key actions. */

import { describe, expect, it, vi } from 'vitest'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import type { CompositionRow } from '../src/plugins/composition.ts'
import type { PluginsState } from '../src/plugins/catalog.ts'
import type { PluginsOverlay } from '../src/plugins/overlay.ts'
import { createPluginsOverlay } from '../src/plugins/overlay.ts'

/** Width and height of a comfortable terminal. */
const COLUMNS = 90
const ROWS = 24

/** A fixed clock, so notice expiry is exact. */
const NOW = 1_800_000_000_000

/**
 * One composition row, with sensible defaults.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function row(overrides: Partial<CompositionRow> = {}): CompositionRow {
  return {
    locator: { steps: [{ index: 0, name: '@deepseek-ai/dsh-tool-fs', id: 'tool-fs' }] },
    path: ['tool-fs'],
    id: 'tool-fs',
    name: '@deepseek-ai/dsh-tool-fs',
    depth: 0,
    group: false,
    disabled: { kind: 'enabled' },
    effective: 'enabled',
    ...overrides,
  }
}

/** A complete reading, browsing a preset's parsed rows. */
function ready(rows: readonly CompositionRow[], overrides: Partial<Extract<PluginsState, { kind: 'ready' }>> = {}): PluginsState {
  return {
    kind: 'ready',
    capabilities: { agentPresets: true, settings: true, canWriteUserPresets: true },
    presets: [
      { id: 'standard', trust: 'system', name: 'Standard mode', description: undefined, broken: undefined, isCurrent: true, isDefault: true },
    ],
    defaultId: 'standard',
    sessionPresetId: 'standard',
    blank: true,
    browsing: { kind: 'rows', presetId: 'standard', tree: { kind: 'parsed', rows } },
    // No capability registry unless a test names one: health then claims
    // nothing, which keeps every other case in this file about layout.
    host: { subagentProviders: undefined },
    ...overrides,
  }
}

/** An overlay under test, plus what it asked its owner for. */
interface Mounted {
  render(columns?: number, rows?: number): string[]
  text(columns?: number, rows?: number): string
  press(...keys: Key[]): void
  readonly overlay: PluginsOverlay
  readonly toggled: string[]
  readonly pickedPreset: () => number
  readonly madeDefault: () => number
  readonly refreshed: () => number
  readonly closed: () => boolean
}

/**
 * Mount the browser over a fixed reading.
 * @param state - the reading to show.
 * @param now - the clock, when a test moves it.
 * @returns the overlay and its recorded requests.
 */
function mount(state: PluginsState, now: () => number = () => NOW): Mounted {
  const toggled: string[] = []
  let pickedPreset = 0
  let madeDefault = 0
  let refreshed = 0
  let closed = false
  const overlay = createPluginsOverlay({
    state: () => state,
    refresh: () => { refreshed += 1 },
    toggle: r => { toggled.push(r.id ?? r.name) },
    pickPreset: () => { pickedPreset += 1 },
    makeDefault: () => { madeDefault += 1 },
    now,
    close: () => { closed = true },
    invalidate: () => {},
  })
  const render = (columns = COLUMNS, rows = ROWS): string[] => [...overlay.render(columns, rows)]
  return {
    overlay,
    render,
    text: (columns = COLUMNS, rows = ROWS) => stripAnsi(render(columns, rows).join('\n')),
    press: (...keys) => { for (const k of keys) overlay.handleKey(k) },
    toggled,
    pickedPreset: () => pickedPreset,
    madeDefault: () => madeDefault,
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

/**
 * One typed character.
 * @param text - the character(s).
 * @returns the key event.
 */
function text(text: string): Key {
  return { kind: 'text', text }
}

describe('what the browser shows', () => {
  it('shows the browsed preset and the default, on one line when they agree', () => {
    const shown = mount(ready([row()])).text()
    expect(shown).toContain('Preset: Standard mode')
    expect(shown).toContain('default: Standard mode')
  })

  it('distinguishes the session\'s current preset from the browsed one when they differ', () => {
    const state = ready([row()], { sessionPresetId: 'code' })
    const shown = mount(state).text()
    expect(shown).toContain('current session:')
  })

  it('shows a row\'s id, package name, and enabled mark', () => {
    const shown = mount(ready([row({ id: 'tool-subagent-codex', name: '@deepseek-ai/dsh-subagent-codex' })])).text()
    expect(shown).toContain('tool-subagent-codex')
    expect(shown).toContain('@deepseek-ai/dsh-subagent-codex')
    expect(shown).toContain('●')
  })

  it('marks a disabled row hollow and a conditional row half', () => {
    const shown = mount(ready([
      row({ id: 'a', disabled: { kind: 'disabled' } }),
      row({ id: 'b', disabled: { kind: 'conditional', expression: "process.platform === 'win32'" } }),
    ])).text()
    expect(shown).toContain('○')
    expect(shown).toContain('◐')
  })

  it('indents a nested row under its group', () => {
    const shown = mount(ready([
      row({ id: 'delegation', name: 'cordis:group', group: true, depth: 0 }),
      row({ id: 'tool-subagent-codex', path: ['delegation', 'tool-subagent-codex'], depth: 1 }),
    ])).text()
    expect(shown).toContain('  tool-subagent-codex')
  })

  it('says it is still reading before the first pass lands', () => {
    expect(mount({ kind: 'loading' }).text()).toContain('Reading agent presets…')
  })

  it('degrades cleanly when the profile mounts no agentPresets seam', () => {
    expect(mount({ kind: 'unavailable', message: 'agent presets are not available in this Harness profile' }).text())
      .toContain('agent presets are not available in this Harness profile')
  })

  it('reports a failed read in Harness\'s own words', () => {
    expect(mount({ kind: 'failed', message: 'registry is down' }).text())
      .toContain('Harness could not be read: registry is down')
  })

  it('reports a broken browsed preset using the given reason, and shows no rows', () => {
    const state = ready([row()], { browsing: { kind: 'broken', presetId: 'standard', reason: 'a service row escaped its isolate realm' } })
    expect(mount(state).text()).toContain('a service row escaped its isolate realm')
  })

  it('says an empty roster differently from an empty search result', () => {
    expect(mount(ready([])).text()).toContain('No plugin rows in this preset.')
    const view = mount(ready([row({ id: 'tool-fs' })]))
    view.render()
    view.press(text('/'), text('z'), text('z'), text('z'))
    expect(view.text()).toContain('No plugin matches that.')
  })
})

describe('search mode: entered explicitly with /', () => {
  it('does not filter on bare letters that also happen to be shortcuts', () => {
    // "tool-pwsh" contains a 'p' and "cordis" a 'd' — outside search mode
    // those letters must never reach the query.
    const rows = [row({ id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' }), row({ id: 'tool-fs' })]
    const view = mount(ready(rows))
    view.render()
    view.press(text('p'))
    expect(view.pickedPreset()).toBe(1)
    expect(view.text()).toContain('tool-fs')
    expect(view.text()).toContain('tool-pwsh')
  })

  it('routes every character, including space/p/d, into the query once searching', () => {
    const rows = [row({ id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' }), row({ id: 'tool-fs' })]
    const view = mount(ready(rows))
    view.render()
    view.press(text('/'), text('p'), text('w'), text('s'), text('h'))
    expect(view.pickedPreset()).toBe(0)
    expect(view.madeDefault()).toBe(0)
    const shown = view.text()
    expect(shown).toContain('tool-pwsh')
    expect(shown).not.toContain('tool-fs')
  })

  it('filters by package/module name while searching', () => {
    const rows = [
      row({ id: 'tool-subagent-codex', name: '@deepseek-ai/dsh-subagent-codex' }),
      row({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }),
    ]
    const view = mount(ready(rows))
    view.render()
    view.press(text('/'), text('s'), text('u'), text('b'), text('a'), text('g'), text('e'), text('n'), text('t'))
    const shown = view.text()
    expect(shown).toContain('tool-subagent-codex')
    expect(shown).not.toContain('tool-fs')
  })

  it('exits search mode on enter, keeping the filter, and re-arms shortcuts', () => {
    const rows = [row({ id: 'tool-fs' }), row({ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', path: ['tool-bash'] })]
    const view = mount(ready(rows))
    view.render()
    view.press(text('/'), text('f'), text('s'), key('enter'))
    view.render()
    view.press(text('p'))
    expect(view.pickedPreset()).toBe(1)
    expect(view.text()).toContain('tool-fs')
    expect(view.text()).not.toContain('tool-bash')
  })

  it('exits search mode on the first escape, keeping the filter', () => {
    const rows = [row({ id: 'tool-fs' }), row({ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', path: ['tool-bash'] })]
    const view = mount(ready(rows))
    view.render()
    view.press(text('/'), text('f'), text('s'), key('escape'))
    view.render()
    expect(view.text()).not.toContain('tool-bash')
    view.press(key('escape'))
    expect(view.closed()).toBe(false)
    view.render()
    expect(view.text()).toContain('tool-bash')
  })

  it('closes on a third escape once the filter is already clear and search already exited', () => {
    const view = mount(ready([row({ id: 'tool-fs' })]))
    view.render()
    view.press(text('/'), text('f'), key('escape'))
    view.render()
    view.press(key('escape'))
    view.render()
    view.press(key('escape'))
    expect(view.closed()).toBe(true)
  })

  it('lets ctrl-c close from inside search mode', () => {
    const view = mount(ready([row()]))
    view.render()
    view.press(text('/'))
    view.press(key('ctrl-c'))
    expect(view.closed()).toBe(true)
  })
})

describe('single-key actions outside search mode', () => {
  it('toggles the selected row on space', () => {
    const view = mount(ready([row({ id: 'tool-fs' }), row({ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', path: ['tool-bash'] })]))
    view.render()
    view.press(key('down'))
    view.press(text(' '))
    expect(view.toggled).toEqual(['tool-bash'])
  })

  it('opens the preset picker on p', () => {
    const view = mount(ready([row()]))
    view.render()
    view.press(text('p'))
    expect(view.pickedPreset()).toBe(1)
  })

  it('makes the browsed preset default on d', () => {
    const view = mount(ready([row()]))
    view.render()
    view.press(text('d'))
    expect(view.madeDefault()).toBe(1)
  })

  it('does nothing on space when there are no rows to select', () => {
    const view = mount(ready([]))
    view.render()
    view.press(text(' '))
    expect(view.toggled).toEqual([])
  })

  it('closes immediately on escape when there is no filter', () => {
    const view = mount(ready([row()]))
    view.render()
    view.press(key('escape'))
    expect(view.closed()).toBe(true)
  })

  it('refreshes on ctrl-r', () => {
    const view = mount(ready([row()]))
    view.render()
    view.press(key('ctrl-r'))
    expect(view.refreshed()).toBe(1)
  })
})

describe('scrolling and bounds', () => {
  it('keeps many rows inside a bounded terminal without exceeding its height', () => {
    const rows = Array.from({ length: 400 }, (_, i) => row({ id: `tool-${String(i)}`, path: [`tool-${String(i)}`] }))
    const view = mount(ready(rows))
    for (let i = 0; i < 50; i += 1) view.press(key('down'))
    const frame = view.render(90, 24)
    expect(frame.length).toBeLessThanOrEqual(24)
  })

  it('keeps many rows inside a small 14-row terminal too', () => {
    const rows = Array.from({ length: 400 }, (_, i) => row({ id: `tool-${String(i)}`, path: [`tool-${String(i)}`] }))
    const view = mount(ready(rows))
    for (let i = 0; i < 50; i += 1) view.press(key('down'))
    const frame = view.render(90, 14)
    expect(frame.length).toBeLessThanOrEqual(14)
  })

  it('falls back to a compact single line on a very narrow terminal', () => {
    const view = mount(ready([row()]))
    const frame = view.render(20, 24)
    expect(frame.length).toBeGreaterThan(0)
    expect(frame.length).toBeLessThanOrEqual(24)
  })

  it('falls back to a compact single line on a very short terminal', () => {
    const view = mount(ready([row()]))
    const frame = view.render(90, 3)
    expect(frame.length).toBeLessThanOrEqual(3)
  })
})

describe('notices', () => {
  it('shows a reported result and lets it expire', () => {
    let now = NOW
    const view = mount(ready([row()]), () => now)
    view.overlay.report('tool-fs: enabled', false)
    expect(view.text()).toContain('tool-fs: enabled')
    now += 6_000
    expect(view.text()).not.toContain('tool-fs: enabled')
  })

  it('marks a failed report distinctly from a successful one', () => {
    const failure = mount(ready([row()]))
    failure.overlay.report('could not write', true)
    expect(failure.render().join('\n')).toContain('[31m')
  })
  it('asks for a repaint at expiry, and none after close', () => {
    // The shared notice owns one unref'd timer; an idle browser otherwise kept
    // an expired result on screen until some unrelated paint.
    vi.useFakeTimers()
    try {
      let invalidates = 0
      const overlay = createPluginsOverlay({
        state: () => ready([row()]),
        refresh: () => {},
        toggle: () => {},
        pickPreset: () => {},
        makeDefault: () => {},
        now: () => Date.now(),
        close: () => {},
        invalidate: () => { invalidates += 1 },
      })
      overlay.render(COLUMNS, ROWS)
      overlay.report('tool-fs: enabled', false)
      const afterShow = invalidates
      vi.advanceTimersByTime(5_000)
      expect(invalidates).toBe(afterShow + 1)

      // A result closed before its lifetime must not repaint after teardown.
      overlay.report('again', false)
      const beforeDispose = invalidates
      overlay.dispose?.()
      vi.advanceTimersByTime(5_000)
      expect(invalidates).toBe(beforeDispose)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('untrusted preset display names', () => {
  // A preset's `name` is display text read out of a `preset.yml` beside its
  // composition — file content, untrusted exactly like a tool result. Left
  // raw it is obeyed by the terminal AND mis-measured by `displayWidth`,
  // which scores an escape sequence as zero columns.
  const ESC = String.fromCharCode(27)
  const HOSTILE = `Std${ESC}[31m${ESC}[2JEVIL`

  it('escapes the browsed and default preset names in the header', () => {
    const view = mount(ready([row()], {
      presets: [
        { id: 'standard', trust: 'system', name: HOSTILE, description: undefined, broken: undefined, isCurrent: true, isDefault: true },
      ],
    }))
    const header = view.render().find(line => line.includes('Preset:')) ?? ''
    expect(header).not.toContain(`${ESC}[2J`)
    expect(stripAnsi(header)).toContain('Std^[[31m^[[2JEVIL')
  })

  it('escapes the current-session preset name on the second header line', () => {
    const view = mount(ready([row()], {
      presets: [
        { id: 'standard', trust: 'system', name: 'Standard', description: undefined, broken: undefined, isCurrent: false, isDefault: true },
        { id: 'mine', trust: 'user', name: HOSTILE, description: undefined, broken: undefined, isCurrent: true, isDefault: false },
      ],
      sessionPresetId: 'mine',
    }))
    const line = view.render().find(row => row.includes('current session')) ?? ''
    expect(line).not.toContain(`${ESC}[2J`)
    expect(stripAnsi(line)).toContain('Std^[[31m^[[2JEVIL')
  })
})

describe('row budget when the session runs a different preset than the one browsed', () => {
  /** A reading browsing `standard` while the session runs `mine`. */
  function browsingOther(count: number): PluginsState {
    return ready(Array.from({ length: count }, (_unused, index) => row({
      locator: { steps: [{ index, name: `@x/p${String(index)}`, id: `p${String(index)}` }] },
      path: [`p${String(index)}`],
      id: `p${String(index)}`,
      name: `@x/p${String(index)}`,
    })), {
      presets: [
        { id: 'standard', trust: 'system', name: 'Standard', description: undefined, broken: undefined, isCurrent: false, isDefault: true },
        { id: 'mine', trust: 'user', name: 'Mine', description: undefined, broken: undefined, isCurrent: true, isDefault: false },
      ],
      sessionPresetId: 'mine',
    })
  }

  it('sheds one list row instead of collapsing the whole frame', () => {
    // The second header line ("current session: Mine") makes the header block
    // three rows rather than two. A fixed-row budget that assumed the shorter
    // form built a frame one row too tall, and the height guard then dropped
    // the reader to the one-line compact fallback — losing the browser
    // entirely in exactly the state copy-to-customize produces.
    const frame = mount(browsingOther(3)).render(90, 10)
    expect(frame.length).toBeGreaterThan(1)
    expect(frame.length).toBeLessThanOrEqual(10)
    const text = stripAnsi(frame.join('\n'))
    expect(text).toContain('current session: Mine')
    expect(text).toContain('p0')
    expect(text).toContain('more below')
  })

  it('keeps the frame within the terminal when the session preset matches too', () => {
    // The same off-by-one applied with a two-row header; it only needed more
    // list rows than the budget to surface.
    const frame = mount(ready(Array.from({ length: 6 }, (_unused, index) => row({
      locator: { steps: [{ index, name: `@x/p${String(index)}`, id: `p${String(index)}` }] },
      path: [`p${String(index)}`],
      id: `p${String(index)}`,
      name: `@x/p${String(index)}`,
    })))).render(90, 11)
    expect(frame.length).toBeGreaterThan(1)
    expect(frame.length).toBeLessThanOrEqual(11)
    expect(stripAnsi(frame.join('\n'))).toContain('more below')
  })

  it('never exceeds the terminal at any height a frame is drawn at', () => {
    for (let rows = 8; rows <= 30; rows += 1) {
      for (const state of [browsingOther(12), ready(Array.from({ length: 12 }, () => row()))]) {
        const view = mount(state)
        expect(view.render(90, rows).length, `height ${String(rows)}`).toBeLessThanOrEqual(rows)
      }
    }
  })
})

describe('enter is the same gesture as space on a row', () => {
  it('toggles the selected row on enter', () => {
    const view = mount(ready([row()]))
    view.render()
    view.press(key('enter'))
    expect(view.toggled).toEqual(['tool-fs'])
  })

  it('toggles the same row either key reaches', () => {
    const rows = [row(), row({ id: 'tool-web', name: '@x/web', path: ['tool-web'] })]
    const withSpace = mount(ready(rows))
    withSpace.render()
    withSpace.press(key('down'), text(' '))
    const withEnter = mount(ready(rows))
    withEnter.render()
    withEnter.press(key('down'), key('enter'))
    expect(withEnter.toggled).toEqual(withSpace.toggled)
    expect(withEnter.toggled).toEqual(['tool-web'])
  })

  it('leaves enter meaning "done typing" inside search mode', () => {
    // Stealing it there would leave no way back to the shortcuts.
    const view = mount(ready([row()]))
    view.render()
    view.press(text('/'), text('f'), key('enter'))
    expect(view.toggled).toEqual([])
    // Back outside search mode, so enter acts again and the filter is kept.
    view.press(key('enter'))
    expect(view.toggled).toEqual(['tool-fs'])
    expect(view.text()).toContain('f')
  })

  it('does nothing on enter when no row is selectable', () => {
    const view = mount(ready([]))
    view.render()
    view.press(key('enter'))
    expect(view.toggled).toEqual([])
  })

  it('offers both keys in the help line', () => {
    expect(mount(ready([row()])).text()).toContain('space/enter toggle')
  })
})

describe('host capability health on a row', () => {
  /** A reading whose Host mounts a subagent registry with `providers`. */
  function withHost(rows: readonly CompositionRow[], providers: readonly string[] | undefined): PluginsState {
    return ready(rows, { host: { subagentProviders: providers } })
  }

  /** One delegation row naming `provider`. */
  function delegation(provider: string, disabled: CompositionRow['disabled']): CompositionRow {
    return row({
      id: 'tool-subagent-extra',
      name: '@deepseek-ai/dsh-tool-subagent',
      path: ['tool-subagent-extra'],
      configProvider: provider,
      disabled,
      effective: disabled.kind === 'disabled' ? 'disabled' : 'enabled',
    })
  }

  it('marks an enabled row whose provider the Host does not supply', () => {
    const view = mount(withHost([delegation('absent', { kind: 'enabled' })], ['spawn']))
    const text = view.text()
    expect(text).toContain('⚠')
    expect(text).toContain('enabled in preset · provider "absent" unavailable in this Host')
  })

  it('keeps the ordinary enabled presentation when the Host supplies it', () => {
    const view = mount(withHost([delegation('spawn', { kind: 'enabled' })], ['spawn']))
    const text = view.text()
    expect(text).toContain('●')
    expect(text).not.toContain('⚠')
    expect(text).not.toContain('unavailable')
  })

  it('claims nothing when the Host mounts no registry to ask', () => {
    const view = mount(withHost([delegation('absent', { kind: 'enabled' })], undefined))
    const text = view.text()
    expect(text).toContain('●')
    expect(text).not.toContain('⚠')
  })

  it('leaves a disabled row mark alone and explains it instead', () => {
    const view = mount(withHost([delegation('absent', { kind: 'disabled' })], ['spawn']))
    const text = view.text()
    expect(text).toContain('○')
    expect(text).not.toContain('⚠')
    expect(text).toContain('provider "absent" unavailable in this Host')
  })
})

describe('the overflow hint answers a question about choices', () => {
  /**
   * One composition row carrying a config summary, so selecting it earns a
   * detail line and the physical document grows longer than the choice list.
   * @param index - the row's index, used for its id, path, and name.
   * @returns the row.
   */
  function detailed(index: number): CompositionRow {
    return row({
      locator: { steps: [{ index, name: `@x/p${String(index)}`, id: `p${String(index)}` }] },
      path: [`p${String(index)}`],
      id: `p${String(index)}`,
      name: `@x/p${String(index)}`,
      configSummary: `cfg ${String(index)}`,
    })
  }

  it('does not claim more below for the selected row detail alone', () => {
    // Capacity is three (10 - PLUGINS_FIXED_ROWS - two header rows). Three
    // choices fill it exactly; the last choice's own detail line is the only
    // row below, and selecting a row is not another choice.
    const view = mount(ready([detailed(0), detailed(1), detailed(2)]))
    view.render(90, 10)
    view.press(key('down'), key('down'))
    const text = view.text(90, 10)
    expect(text).toContain('3 rows')
    expect(text).not.toContain('more below')
  })

  it('still claims more below when a real entry is hidden', () => {
    // Capacity two at height 9: selecting p0 inserts its detail, which pushes
    // p1 and p2 — real choices — below the window. The hint must survive.
    const view = mount(ready([detailed(0), detailed(1), detailed(2)]))
    const text = view.text(90, 9)
    expect(text).toContain('more below')
  })

  it('does not claim more below when later choices are already visible', () => {
    // A tall window holds every choice. An index comparison (0 < 2) would still
    // believe later rows are hidden, so this pins the viewport-based condition.
    const view = mount(ready([detailed(0), detailed(1), detailed(2)]))
    const text = view.text(90, 13)
    expect(text).toContain('3 rows')
    expect(text).not.toContain('more below')
  })

  it('does not claim more below for a single detailed match', () => {
    // Capacity one at height 8: the sole choice is visible and only its detail
    // is below.
    const view = mount(ready([detailed(0)]))
    const text = view.text(90, 8)
    expect(text).toContain('1 row')
    expect(text).not.toContain('more below')
  })
})
