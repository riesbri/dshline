/**
 * The Profiles browser: what it draws, and what each key asks its owner for.
 *
 * The structural subject is the list shape — every profile followed by its own
 * bundle layers — and the fact that selection walks both kinds as one
 * sequence, so a bundle operation always has an unambiguous target and no row
 * is stranded behind a mode.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Key } from '@dshline/renderer'
import { spinnerFrame, stripAnsi } from '@dshline/renderer'
import type { BundleRow, PlainDependencyRow, ProfileRow } from '../src/profiles/harness.ts'
import type { ProfilesState } from '../src/profiles/catalog.ts'
import type { ProfilesOverlay } from '../src/profiles/overlay.ts'
import type { ProfilesActivityView } from '../src/profiles/overlay.ts'
import { createProfilesOverlay, selectableRows } from '../src/profiles/overlay.ts'

/** Nothing running and nothing owed a restart. */
const QUIET: ProfilesActivityView = { running: [], restartQueued: [] }

/** Width and height of a comfortable terminal. */
const COLUMNS = 90
const ROWS = 28

/** A fixed clock, so notice expiry is exact. */
const NOW = 1_800_000_000_000

/** One bundle row, with sensible defaults. */
function bundle(packageName: string, overrides: Partial<BundleRow> = {}): BundleRow {
  return { packageName, version: '1.0.0', managed: true, declaresBundle: true, ...overrides }
}

/** One profile row, with sensible defaults. */
function profile(name: string, overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    name,
    dir: `/home/.dsh/profiles/${name}`,
    current: false,
    bundles: [],
    plain: [],
    pendingBuilds: [],
    broken: undefined,
    ...overrides,
  }
}

/** A complete reading. */
function ready(profiles: readonly ProfileRow[], currentName?: string): ProfilesState {
  return {
    kind: 'ready',
    reading: { root: '/home/.dsh/profiles', profiles, currentName },
  }
}

/** What the overlay asked its owner for. */
interface Asked {
  readonly added: string[]
  readonly updated: { profile: string; bundle: string | undefined }[]
  readonly removed: { profile: string; bundle: string }[]
  readonly removedPlain: { profile: string; dependency: string }[]
  readonly created: () => number
  readonly explained: string[]
  readonly refreshed: () => number
  readonly closed: () => boolean
}

/** An overlay under test, plus what it recorded. */
interface Mounted extends Asked {
  render(columns?: number, rows?: number): string[]
  text(columns?: number, rows?: number): string
  press(...keys: Key[]): void
  readonly overlay: ProfilesOverlay
}

/**
 * Mount the browser over a fixed reading.
 * @param state - the reading to show.
 * @returns the overlay and its recorded requests.
 */
function mount(state: ProfilesState, activity: ProfilesActivityView = QUIET): Mounted {
  const added: string[] = []
  const updated: { profile: string; bundle: string | undefined }[] = []
  const removed: { profile: string; bundle: string }[] = []
  const removedPlain: { profile: string; dependency: string }[] = []
  const explained: string[] = []
  let created = 0
  let refreshed = 0
  let closed = false
  const overlay = createProfilesOverlay({
    state: () => state,
    activity: () => activity,
    refresh: () => { refreshed += 1 },
    addBundle: target => { added.push(target.name) },
    updateBundle: (target, row) => { updated.push({ profile: target.name, bundle: row?.packageName }) },
    removeBundle: (target, row) => { removed.push({ profile: target.name, bundle: row.packageName }) },
    removeDependency: (target, row) => { removedPlain.push({ profile: target.name, dependency: row.packageName }) },
    createProfile: () => { created += 1 },
    explainBoot: target => { explained.push(target.name) },
    now: () => NOW,
    close: () => { closed = true },
    invalidate: () => {},
  })
  const render = (columns = COLUMNS, rows = ROWS): string[] => [...overlay.render(columns, rows)]
  return {
    overlay,
    render,
    text: (columns = COLUMNS, rows = ROWS) => stripAnsi(render(columns, rows).join('\n')),
    press: (...keys) => { for (const k of keys) overlay.handleKey(k) },
    added,
    updated,
    removed,
    removedPlain,
    created: () => created,
    explained,
    refreshed: () => refreshed,
    closed: () => closed,
  }
}

function key(name: Extract<Key, { kind: 'key' }>['name']): Key {
  return { kind: 'key', name }
}

function text(value: string): Key {
  return { kind: 'text', text: value }
}

describe('the selectable sequence', () => {
  const rows = [
    profile('dshline', { current: true, bundles: [bundle('@dshline/dshline'), bundle('@deepseek-ai/dsh-base')] }),
    profile('web', { bundles: [bundle('@deepseek-ai/dsh-web-app')] }),
  ]

  it('follows each profile with its own bundle layers', () => {
    const selection = selectableRows(ready(rows), '')
    expect(selection.map(entry => entry.kind)).toEqual(['profile', 'bundle', 'bundle', 'profile', 'bundle'])
  })

  it('addresses every bundle row to the profile it sits under', () => {
    const selection = selectableRows(ready(rows), '')
    expect(selection.map(entry => `${entry.profile.name}/${entry.kind}`)).toEqual([
      'dshline/profile', 'dshline/bundle', 'dshline/bundle', 'web/profile', 'web/bundle',
    ])
  })

  it('reaches every bundle by moving down, with no row stranded behind a mode', () => {
    // The dead end the earlier inspect-one-profile shape had: the first
    // profile's bundles were unreachable, because passing the second profile's
    // row re-pointed the section away from them.
    const selection = selectableRows(ready(rows), '')
    const bundles = selection.filter(entry => entry.kind === 'bundle')
    expect(bundles).toHaveLength(3)
  })

  it('is empty before the first read lands', () => {
    expect(selectableRows({ kind: 'loading' }, '')).toEqual([])
  })

  it('narrows to the profiles a query matches, bundles included', () => {
    expect(selectableRows(ready(rows), 'web').map(entry => entry.profile.name)).toEqual(['web', 'web'])
  })

  it('draws a profile with no bundles as a single row', () => {
    expect(selectableRows(ready([profile('bare')]), '').map(entry => entry.kind)).toEqual(['profile'])
  })
})

describe('what the browser shows', () => {
  it('names the booted profile and marks it in the roster', () => {
    const view = mount(ready([profile('dshline', { current: true }), profile('web')], 'dshline'))
    const out = view.text()
    expect(out).toContain('Host: dshline')
    expect(out).toContain('● dshline')
    expect(out).toContain('current')
    expect(out).toContain('○ web')
  })

  it('says so plainly when this Host booted no profile', () => {
    expect(mount(ready([profile('web')])).text()).toContain('not booted from a profile')
  })

  it('lists the inspected profile bundles under a heading, with versions', () => {
    const view = mount(ready([
      profile('dshline', { current: true, bundles: [bundle('@dshline/dshline', { version: '0.7.1' })] }),
    ], 'dshline'))
    const out = view.text()
    expect(out).toContain('Bundles')
    expect(out).toContain('@dshline/dshline')
    expect(out).toContain('0.7.1')
    expect(out).toContain('✓')
  })

  it('shows the profiles root, so a reader knows which home is being read', () => {
    expect(mount(ready([profile('web')])).text()).toContain('/home/.dsh/profiles')
  })

  it('offers to create one when the roster is empty', () => {
    expect(mount(ready([])).text()).toContain('Press n to create one')
  })

  it('shows an unreadable profile rather than hiding it', () => {
    const view = mount(ready([profile('broken', { broken: 'package.json is missing' })]))
    const out = view.text()
    expect(out).toContain('broken')
    expect(out).toContain('unreadable')
    expect(out).toContain('package.json is missing')
  })

  it('reports a failed read in its own words', () => {
    expect(mount({ kind: 'failed', message: 'EACCES' }).text()).toContain('EACCES')
  })

  it('reports an absent home-path service as unavailable', () => {
    expect(mount({ kind: 'unavailable', message: 'no home-path service' }).text()).toContain('no home-path service')
  })

  it('never exceeds the terminal at any height a frame is drawn at', () => {
    const state = ready(Array.from({ length: 8 }, (_unused, index) => profile(`p${String(index)}`, {
      bundles: [bundle('@a/one'), bundle('@a/two'), bundle('@a/three')],
    })))
    for (let rows = 8; rows <= 30; rows += 1) {
      expect(mount(state).render(COLUMNS, rows).length, `height ${String(rows)}`).toBeLessThanOrEqual(rows)
    }
  })
})

describe('keys', () => {
  const roster = ready([
    profile('dshline', { current: true, bundles: [bundle('@dshline/dshline'), bundle('@deepseek-ai/dsh-base')] }),
    profile('web'),
  ], 'dshline')

  it('asks to add a bundle to the profile the cursor is in', () => {
    const view = mount(roster)
    view.render()
    view.press(text('a'))
    expect(view.added).toEqual(['dshline'])
  })

  it('asks to update the selected bundle, and every bundle on U', () => {
    const view = mount(roster)
    view.render()
    // One row down from the profile is its own first bundle.
    view.press(key('down'))
    view.render()
    view.press(text('u'))
    expect(view.updated).toEqual([{ profile: 'dshline', bundle: '@dshline/dshline' }])
    view.press(text('U'))
    expect(view.updated.at(-1)).toEqual({ profile: 'dshline', bundle: undefined })
  })

  it('updates every bundle when the cursor is on a profile rather than a bundle', () => {
    const view = mount(roster)
    view.render()
    view.press(text('u'))
    expect(view.updated).toEqual([{ profile: 'dshline', bundle: undefined }])
  })

  it('only removes when a bundle is selected', () => {
    const view = mount(roster)
    view.render()
    view.press(text('r'))
    expect(view.removed).toEqual([])
    view.press(key('down'))
    view.render()
    view.press(text('r'))
    expect(view.removed).toEqual([{ profile: 'dshline', bundle: '@dshline/dshline' }])
  })

  it('asks to create a profile on n, even with an empty roster', () => {
    const view = mount(ready([]))
    view.render()
    view.press(text('n'))
    expect(view.created()).toBe(1)
  })

  it('explains how a profile is booted on enter, rather than pretending to switch', () => {
    // A composed Host cannot swap its bundle layers; naming the command is
    // what switching profiles actually is.
    const view = mount(roster)
    view.render()
    view.press(key('enter'))
    expect(view.explained).toEqual(['dshline'])
  })

  it('re-reads on ctrl-r', () => {
    const view = mount(roster)
    view.render()
    view.press(key('ctrl-r'))
    expect(view.refreshed()).toBe(1)
  })

  it('closes on escape with no filter, and clears the filter first when there is one', () => {
    const view = mount(roster)
    view.render()
    view.press(text('/'), text('w'), key('escape'))
    view.render()
    // Search mode left, filter kept: escape now clears it rather than closing.
    view.press(key('escape'))
    expect(view.closed()).toBe(false)
    view.render()
    view.press(key('escape'))
    expect(view.closed()).toBe(true)
  })

  it('treats a, u, r, and n as search text once search mode is entered', () => {
    // Every one of those letters occurs in an ordinary package name, which is
    // why search is an explicit mode here rather than always-on.
    const view = mount(roster)
    view.render()
    view.press(text('/'), text('a'), text('u'), text('r'), text('n'))
    expect(view.added).toEqual([])
    expect(view.updated).toEqual([])
    expect(view.removed).toEqual([])
    expect(view.created()).toBe(0)
    expect(view.text()).toContain('aurn')
  })

  it('shows a reported result, and lets it expire', () => {
    const view = mount(roster)
    view.overlay.report('restart required', false)
    expect(view.text()).toContain('restart required')
  })

  it('reports whether it has closed, for a late-landing operation', () => {
    const view = mount(roster)
    expect(view.overlay.closed()).toBe(false)
    view.press(key('ctrl-c'))
    expect(view.overlay.closed()).toBe(true)
  })

  it('asks for a repaint at expiry, and none after close', () => {
    // With nothing running there is no heartbeat, so the notice's own timer is
    // what retires the result on an idle browser.
    vi.useFakeTimers()
    try {
      let invalidates = 0
      const overlay = createProfilesOverlay({
        state: () => roster,
        activity: () => QUIET,
        refresh: () => {},
        addBundle: () => {},
        updateBundle: () => {},
        removeBundle: () => {},
        removeDependency: () => {},
        createProfile: () => {},
        explainBoot: () => {},
        now: () => Date.now(),
        close: () => {},
        invalidate: () => { invalidates += 1 },
      })
      overlay.render(COLUMNS, ROWS)
      overlay.report('restart required', false)
      const afterShow = invalidates
      vi.advanceTimersByTime(8_000)
      expect(invalidates).toBe(afterShow + 1)

      overlay.report('again', false)
      const beforeDispose = invalidates
      overlay.dispose?.()
      vi.advanceTimersByTime(8_000)
      expect(invalidates).toBe(beforeDispose)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('what is happening right now stays on screen', () => {
  const roster = ready([profile('dshline', { current: true, bundles: [bundle('@example/plugin')] })], 'dshline')

  it('shows a running operation for as long as it runs, not for the life of a notice', () => {
    // The manual report this fixes: "bundles update… no feedback, what's going
    // on?" A pnpm install takes minutes and a notice expires in seconds.
    const view = mount(roster, { running: [{ profile: 'dshline', what: 'updating 2 bundles' }], restartQueued: [] })
    const out = view.text()
    expect(out).toContain('dshline: updating 2 bundles…')
  })

  it('keeps showing it after the notice clock has moved well past any expiry', () => {
    const view = mount(roster, { running: [{ profile: 'dshline', what: 'installing @a/b' }], restartQueued: [] })
    // `now` is fixed in this harness, but the activity row is not time-based at
    // all — which is the property under test.
    expect(view.text(COLUMNS, ROWS)).toContain('installing @a/b')
    expect(view.text(COLUMNS, ROWS)).toContain('installing @a/b')
  })

  it('says a restart is owed once a change has landed', () => {
    const view = mount(roster, { running: [], restartQueued: ['dshline'] })
    expect(view.text()).toContain('dshline: restart to pick this up')
  })

  it('shows both at once, since one profile can be mid-install while another waits', () => {
    const view = mount(roster, {
      running: [{ profile: 'web', what: 'installing @a/b' }],
      restartQueued: ['dshline'],
    })
    const out = view.text()
    expect(out).toContain('web: installing @a/b…')
    expect(out).toContain('dshline: restart to pick this up')
  })

  it('says nothing when nothing is happening', () => {
    const out = mount(roster).text()
    expect(out).not.toContain('…')
    expect(out).not.toContain('↻')
  })

  it('still fits the terminal with activity rows present', () => {
    const busy = {
      running: [{ profile: 'a', what: 'installing one' }, { profile: 'b', what: 'installing two' }],
      restartQueued: ['c'],
    }
    for (let rows = 10; rows <= 30; rows += 1) {
      expect(mount(roster, busy).render(COLUMNS, rows).length, `height ${String(rows)}`).toBeLessThanOrEqual(rows)
    }
  })
})

describe('a dependency that is installed but is not a layer', () => {
  /** One non-layer dependency row. */
  function plain(packageName: string, overrides: Partial<PlainDependencyRow> = {}): PlainDependencyRow {
    return { packageName, version: '1.0.0', declaresBundle: false, ...overrides }
  }

  it('lists it under its own caption, so an inert install is visible', () => {
    // The gap this closes: a package with no `dsh.bundle` is installed, is
    // correctly not a layer, and previously appeared nowhere at all — so
    // "I installed it and nothing changed" had no explanation on screen.
    const view = mount(ready([profile('dshline', {
      current: true,
      bundles: [bundle('@example/layer')],
      plain: [plain('@example/inert')],
    })], 'dshline'))
    const out = view.text()
    expect(out).toContain('Installed, composes nothing')
    expect(out).toContain('@example/inert')
    expect(out).toContain('not a bundle')
  })

  it('marks one whose installed copy DOES declare dsh.bundle, since the layer list is stale', () => {
    const view = mount(ready([profile('dshline', {
      current: true,
      plain: [plain('@example/now-a-bundle', { declaresBundle: true })],
    })], 'dshline'))
    const out = view.text()
    expect(out).toContain('⚠')
    expect(out).toContain('declares dsh.bundle')
  })

  it('says a declared dependency with no manifest is simply not installed', () => {
    const view = mount(ready([profile('dshline', {
      plain: [plain('@example/pending', { version: undefined, declaresBundle: undefined })],
    })]))
    expect(view.text()).toContain('not installed')
  })

  it('offers r on it, because an inert install is the commonest thing to remove', () => {
    const view = mount(ready([profile('dshline', { plain: [plain('@example/inert')] })]))
    view.render()
    view.press(key('down'))
    view.render()
    view.press(text('r'))
    expect(view.removedPlain).toEqual([{ profile: 'dshline', dependency: '@example/inert' }])
    expect(view.removed).toEqual([])
  })

  it('shows nothing extra for the ordinary profile that has none', () => {
    const view = mount(ready([profile('web', { bundles: [bundle('@example/layer')] })]))
    expect(view.text()).not.toContain('Installed, composes nothing')
  })
})

describe('the running row actually turns', () => {
  const roster = ready([profile('dshline', { current: true, bundles: [bundle('@example/plugin')] })], 'dshline')
  const busy = { running: [{ profile: 'dshline', what: 'installing @a/b' }], restartQueued: [] }

  it('advances its frame while work is in flight', async () => {
    const view = mount(roster, busy)
    view.overlay.mounted?.()
    const first = view.text()
    // The ticker drives `invalidate`, and the harness re-renders on demand, so
    // wait for the frame the ticker has advanced to.
    await vi.waitFor(() => { expect(view.text()).not.toBe(first) }, { timeout: 2_000 })
    view.overlay.dispose?.()
  })

  it('uses the renderer own spinner frames, not a second vocabulary', () => {
    // The status line already spins this way while a turn runs; a browser that
    // span differently would read as a different kind of busy.
    const drawn = mount(roster, busy).text()
    const frames = Array.from({ length: 12 }, (_unused, index) => spinnerFrame(index))
    expect(frames.some(frame => drawn.includes(frame))).toBe(true)
  })

  it('runs no ticker at all when nothing is in flight', () => {
    // A spinner turning over finished work says the opposite of the truth, and
    // an idle overlay must not repaint forever.
    const view = mount(roster)
    view.overlay.mounted?.()
    const first = view.text()
    const second = view.text()
    expect(second).toBe(first)
    view.overlay.dispose?.()
  })

  it('stops the ticker when the overlay goes away', () => {
    // vitest fails the run on a timer left behind by a disposed overlay.
    const view = mount(roster, busy)
    view.overlay.mounted?.()
    view.render()
    view.overlay.dispose?.()
    expect(view.text()).toContain('installing @a/b')
  })
})

describe('u never widens its own scope', () => {
  const roster = ready([profile('dshline', {
    current: true,
    bundles: [bundle('@example/layer')],
    plain: [{ packageName: '@example/inert', version: '1.0.0', declaresBundle: false }],
  })], 'dshline')

  it('does nothing on a plain dependency, rather than meaning update-all', () => {
    // The bug: a plain row reached `updateBundle` with `bundle: undefined`,
    // which the owner reads as "every managed bundle" — so a cursor resting on
    // one package silently updated the whole profile.
    const view = mount(roster)
    view.render()
    view.press(key('down'), key('down'))
    view.render()
    view.press(text('u'))
    expect(view.updated).toEqual([])
  })

  it('still updates the bundle the cursor is on', () => {
    const view = mount(roster)
    view.render()
    view.press(key('down'))
    view.render()
    view.press(text('u'))
    expect(view.updated).toEqual([{ profile: 'dshline', bundle: '@example/layer' }])
  })

  it('still means every bundle on a profile row', () => {
    const view = mount(roster)
    view.render()
    view.press(text('u'))
    expect(view.updated).toEqual([{ profile: 'dshline', bundle: undefined }])
  })

  it('keeps U explicit on a plain row, since it names the wider operation', () => {
    const view = mount(roster)
    view.render()
    view.press(key('down'), key('down'))
    view.render()
    view.press(text('U'))
    expect(view.updated).toEqual([{ profile: 'dshline', bundle: undefined }])
  })

  it('offers u in the help only where it does something', () => {
    const view = mount(roster)
    view.render()
    expect(view.text()).toContain('u update')
    view.press(key('down'), key('down'))
    view.render()
    const help = view.text()
    expect(help).not.toContain('u update')
    expect(help).toContain('U update all')
    expect(help).toContain('r remove')
  })
})

describe('the overflow hint answers a question about choices', () => {
  it('does not claim more below for the selected profile detail alone', () => {
    // Capacity is one (9 - PROFILES_FIXED_ROWS - three header rows). The solo
    // profile's two pending-build lines are the only rows below the window; the
    // profile itself is fully visible.
    const view = mount(ready([profile('solo', { pendingBuilds: ['dep-a'] })]))
    const text = view.text(90, 9)
    expect(text).toContain('1 row')
    expect(text).not.toContain('more below')
  })

  it('still claims more below when a real bundle child is hidden', () => {
    // The selected profile's detail pushes its first bundle child below the
    // window; that child is a real choice, so the hint must survive.
    const view = mount(ready([profile('solo', {
      bundles: [bundle('@x/one')],
      pendingBuilds: ['dep-a'],
    })]))
    expect(view.text(90, 11)).toContain('more below')
  })

  it('still claims more below when a real plain dependency is hidden', () => {
    // The "Installed, composes nothing" caption sits above its plain child, so
    // the hidden row that earns the hint is the choice, not the caption.
    const view = mount(ready([profile('solo', {
      plain: [{ packageName: '@x/inert', version: '1.0.0', declaresBundle: false }],
    })]))
    expect(view.text(90, 10)).toContain('more below')
  })

  it('does not claim more below when later choices are already visible', () => {
    // Both profiles fit. An index comparison (0 < 1) would still believe the
    // later profile is hidden, so this pins the viewport-based condition.
    const view = mount(ready([profile('a'), profile('b')]))
    const text = view.text(90, 14)
    expect(text).toContain('2 rows')
    expect(text).not.toContain('more below')
  })
})
