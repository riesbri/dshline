/**
 * Cross-surface regression coverage for dshline's bounded UI contracts.
 *
 * The per-surface specs already pin each overlay's own behavior. This file
 * checks the properties EVERY bounded surface shares, through the reusable
 * assertions in {@link ./surface-contracts.ts}:
 *
 * - physical geometry: a surface never draws a row wider than the terminal or
 *   more physical rows than the live region can hold;
 * - whole action hints: a compact backstop drops help rather than cutting it;
 * - Enter truthfulness: a footer names Enter only when the current selection
 *   has an action;
 * - failure priority: a refusal the reader just caused survives the geometry
 *   fallback;
 * - untrusted text: a path, id, or Harness message cannot inject a control or
 *   an unbudgeted physical row;
 * - control authority: a gesture acts on the rows the CURRENT query and state
 *   leave, never on a previous frame, because invalidation is coalesced and key
 *   delivery does not imply a repaint between two keys.
 *
 * Each case here targets a defect the audit found; the deliberate break-it
 * check named in the branch description is the pre-fix behavior these cases
 * fail against.
 * @module dshline/tests/ui-surface-contracts
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import { expectPhysicallyBounded, expectWholeHelp } from './surface-contracts.ts'
import { compactRows, createBoundedSurface, SurfaceNotice } from '../src/surface.ts'
import { createWorkOverlay } from '../src/work/overlay.ts'
import { createSelectOverlay } from '../src/select.ts'
import { createMultiSelectOverlay } from '../src/multiselect.ts'
import { createToolOutputOverlay } from '../src/tool-output.ts'
import { createWorktreesOverlay } from '../src/worktrees/overlay.ts'
import { createLineageOverlay } from '../src/sessions/lineage-overlay.ts'
import { createSkillsOverlay } from '../src/skills/overlay.ts'
import { createTurnsOverlay } from '../src/turns/overlay.ts'
import { createSubagentCatalogOverlay } from '../src/subagents/overlay.ts'
import { createCacheOverlay } from '../src/cache/overlay.ts'
import { createPluginsOverlay } from '../src/plugins/overlay.ts'
import { createConnectOverlay } from '../src/connect/overlay.ts'
import { createProfilesOverlay } from '../src/profiles/overlay.ts'
import { catalogReading } from '../src/subagents/model.ts'
import type { SkillCatalogReading } from '../src/skills/catalog.ts'
import type { SkillView } from '../src/skills/model.ts'
import type { CompositionRow } from '../src/plugins/composition.ts'
import type { PluginsState } from '../src/plugins/catalog.ts'
import type { ConnectProviderRow, ConnectState } from '../src/connect/model.ts'
import type { ProfileRow } from '../src/profiles/harness.ts'
import type { ProfilesState } from '../src/profiles/catalog.ts'
import type { LineageState } from '../src/sessions/model.ts'
import type { WorktreeListing, WorktreeSelection } from '../src/worktrees/model.ts'
import type { NewPlan } from '../src/sessions/plan.ts'
import { bannerLines, createStatusView } from '../src/views.ts'

/** A named key event. */
function key(name: string): Key {
  return { kind: 'key', name } as Key
}

/** A printable key event. */
function typed(text: string): Key {
  return { kind: 'text', text } as Key
}

/** Every width a narrow terminal can present, then the ordinary ones. */
const WIDTHS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 24, 30, 36, 40, 80] as const

/** Heights from a one-row pane to a tall window. */
const HEIGHTS = [1, 2, 3, 4, 5, 6, 8, 12, 24] as const

describe('whole action hints', () => {
  it('Work never cuts its compact backstop into a partial instruction', () => {
    const overlay = createWorkOverlay({
      snapshot: () => ({
        available: true,
        workflows: [],
        subagents: [],
        jobs: [{ id: 'bash-1', source: 'job', kind: 'bash', label: 'pnpm test', state: 'running', startedAt: 0, ownership: 'this-session' }],
      }) as never,
      interrupt: () => ({ kind: 'requested', message: 'ok' }) as never,
      close: () => {},
      invalidate: () => {},
    })
    // The full summary, the bare way out, and the ladder's last rung. A cut
    // `esc clos` or `esc c` is not in this set, which is the point.
    const allowed = ['0 subagents · 1 job · esc close', 'esc close', 'esc']
    for (const columns of WIDTHS) {
      for (const line of expectPhysicallyBounded(overlay, columns, 5, 'work compact')) {
        expectWholeHelp(line, allowed, `work compact at ${String(columns)} columns`)
      }
    }
    // The defect itself: the pre-fix fallback rendered a fragment like `esc cl`.
    expect(compactRows('state', 6).map(stripAnsi)).toEqual(['esc'])
    expect(compactRows('state', 8).map(stripAnsi)).toEqual(['esc'])
  })

  it('Tool output never cuts its only help, and never drops it at one row', () => {
    const overlay = createToolOutputOverlay({
      title: 'Tool output',
      render: () => ({ rows: ['inspected'], truncated: false }),
      close: () => {},
      invalidate: () => {},
    })
    const allowed = [
      'Tool output · Tool output · resize to inspect · esc close',
      'esc close',
      'esc',
    ]
    // Every geometry that takes the compact fallback: a short terminal, and a
    // terminal too narrow for the framed body.
    for (const rows of [1, 2, 3, 4, 5, 6]) {
      for (const line of expectPhysicallyBounded(overlay, 80, rows, 'tool output rows')) {
        expectWholeHelp(line, allowed, `tool output at ${String(rows)} rows`)
      }
    }
    for (const columns of [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 17]) {
      for (const line of expectPhysicallyBounded(overlay, columns, 24, 'tool output columns')) {
        expectWholeHelp(line, allowed, `tool output at ${String(columns)} columns`)
      }
    }
    // At five columns the pre-fix second row was `esc c`.
    expect(compactRows('Tool output · resize to inspect', 5).map(stripAnsi)).toEqual(['esc'])
  })
})

describe('Enter truthfulness', () => {
  it('the select compact fallback does not advertise Enter for an empty result', () => {
    const settled: (string | undefined)[] = []
    const overlay = createSelectOverlay({
      title: 'Pick',
      choices: Array.from({ length: 20 }, (_unused, index) => ({ value: `v${String(index)}`, label: `choice-${String(index)}` })),
      settle: value => { settled.push(value) },
      invalidate: () => {},
    })
    overlay.handleKey(typed('z'))
    const compact = stripAnsi(overlay.render(19, 24).join('\n'))
    expect(compact).toContain('esc clear')
    expect(compact).not.toContain('enter')
    // The framed help already dropped it; Enter agrees by doing nothing.
    overlay.handleKey(key('enter'))
    expect(settled).toEqual([])
  })

  it('the subagent catalog names Enter only for a row it can open', () => {
    const mount = (entries: Parameters<typeof catalogReading>[0]): string => {
      const overlay = createSubagentCatalogOverlay({
        reading: () => catalogReading(entries),
        inspect: () => {},
        refresh: () => {},
        close: () => {},
        invalidate: () => {},
      })
      return stripAnsi(overlay.render(80, 20).join('\n'))
    }
    const diagnostic = mount([{ kind: 'diagnostic', id: 'broken' as never, reason: 'corrupt' }])
    expect(diagnostic).not.toContain('enter inspect')
    const child = mount([{ kind: 'child', id: 'ok' as never, mode: 'continuable', activity: 'running', label: 'ok', hasChildren: false }])
    expect(child).toContain('enter inspect')
  })

  it('the skills footer names Enter only for a launchable row, and names Escape clearly', () => {
    const skill = (over: Partial<SkillView> & { name: string }): SkillView => ({
      description: `${over.name} description`,
      userInvocable: true,
      modelInvocable: true,
      source: 'project-dsh',
      ...over,
    })
    const mount = (reading: SkillCatalogReading): ReturnType<typeof createSkillsOverlay> =>
      createSkillsOverlay({ reading: () => reading, commandNames: () => [], insert: () => {}, close: () => {}, invalidate: () => {} })
    const ready = (skills: readonly SkillView[]): SkillCatalogReading =>
      ({ kind: 'ready', skills, stale: false, refreshing: false })

    const modelOnly = stripAnsi(mount(ready([skill({ name: 'architecture', userInvocable: false })])).render(88, 26).join('\n'))
    expect(modelOnly).not.toContain('enter insert')
    const launchable = stripAnsi(mount(ready([skill({ name: 'api-review' })])).render(88, 26).join('\n'))
    expect(launchable).toContain('enter insert')

    // A filter matching nothing: no Enter, no selection hint, and the way out
    // names what Escape clears.
    const overlay = mount(ready([skill({ name: 'api-review' })]))
    overlay.handleKey(typed('zzz'))
    const empty = stripAnsi(overlay.render(88, 26).join('\n'))
    expect(empty).not.toContain('enter insert')
    expect(empty).not.toContain('↑↓ select')
    expect(empty).toContain('esc clear')
  })

  it('the turns outline names Enter only while a turn is under the cursor', () => {
    const mount = (turns: readonly unknown[]): string => {
      const overlay = createTurnsOverlay({
        reading: () => ({ kind: 'list', turns }) as never,
        inspect: () => {},
        close: () => {},
        invalidate: () => {},
      })
      return stripAnsi(overlay.render(80, 20).join('\n'))
    }
    expect(mount([])).not.toContain('↵ inspect')
    const entry = { turn: 1, seq: 1, prompt: 'hello', response: 'world' }
    expect(mount([entry])).toContain('↵ inspect')
  })

  it('worktrees names Enter only while the view has a row', () => {
    const opened: string[] = []
    const mount = (listing: WorktreeListing, selection?: WorktreeSelection): ReturnType<typeof createWorktreesOverlay> =>
      createWorktreesOverlay({
        listing: () => listing,
        selection: () => selection,
        open: cwd => { opened.push(cwd) },
        back: () => {},
        resume: () => ({ kind: 'resume' }) as never,
        create: () => ({ kind: 'new' }) as never,
        home: '/home/dev',
        now: () => 0,
        close: () => {},
        invalidate: () => {},
      })
    const empty = stripAnsi(mount({ kind: 'ready', rows: [] }).render(80, 24).join('\n'))
    expect(empty).not.toContain('enter open')
    const rows = [{ cwd: '/home/dev/src/dshline', sessions: 2, current: true }]
    expect(stripAnsi(mount({ kind: 'ready', rows }).render(80, 24).join('\n'))).toContain('enter open')
    // Enter on the empty view is a no-op, matching the footer.
    mount({ kind: 'ready', rows: [] }).handleKey(key('enter'))
    expect(opened).toEqual([])
  })

  it('lineage names focus only while a session row can take it', () => {
    const target = 'target' as SessionId
    const mount = (state: LineageState): ReturnType<typeof createLineageOverlay> =>
      createLineageOverlay({
        lineage: () => state,
        requestLineage: () => {},
        target,
        home: '/home/dev',
        now: () => 0,
        focus: () => true,
        close: () => {},
        invalidate: () => {},
      })
    for (const state of [
      { kind: 'idle' },
      { kind: 'loading', sessionId: target },
      { kind: 'failed', sessionId: target, message: 'boom' },
    ] satisfies readonly LineageState[]) {
      expect(stripAnsi(mount(state).render(90, 24).join('\n')), state.kind).not.toContain('↵ focus')
    }
    const ready: LineageState = {
      kind: 'ready',
      sessionId: target,
      rows: [{ kind: 'target', depth: 0, id: target, title: 'Target', createdAt: 0, origin: 'own' }],
      targetRow: 0,
      complete: true,
    }
    expect(stripAnsi(mount(ready).render(90, 24).join('\n'))).toContain('↵ focus')
  })
})

describe('untrusted text safety', () => {
  it('worktrees escapes a Harness session-listing failure message', () => {
    const overlay = createWorktreesOverlay({
      listing: () => ({ kind: 'ready', rows: [{ cwd: '/repo', sessions: 1, current: false }] }) as never,
      selection: () => ({ row: { cwd: '/repo' }, sessions: { kind: 'failed', message: 'boom\u001b[2Jerased' } }) as never,
      open: () => {},
      back: () => {},
      resume: () => ({ kind: 'resume' }) as never,
      create: () => ({ kind: 'new' }) as never,
      home: '/home/dev',
      now: () => 0,
      close: () => {},
      invalidate: () => {},
    })
    const raw = overlay.render(80, 24).join('\n')
    expect(raw).not.toContain('\u001b[2J')
    expect(stripAnsi(raw)).toContain('^[[2Jerased')
  })

  it('the cache route id is escaped before it reaches the terminal', () => {
    const overlay = createCacheOverlay({
      inspection: () => ({
        projections: true,
        buckets: undefined,
        cacheReadShare: undefined,
        header: { recorded: true, route: 'evil\u001b[2Jroute', tools: 2 },
        route: { recorded: false, promptUpdate: undefined },
      }),
      close: () => {},
    })
    const raw = overlay.render(80, 24).join('\n')
    expect(raw).not.toContain('\u001b[2J')
    expect(stripAnsi(raw)).toContain('evil^[[2Jroute')
  })

  it('the committed banner escapes the workspace path and model id', () => {
    const raw = bannerLines('/w/\u001b[2Jevil', 'model\u001b[31mred', '0.22.0', 80).join('\n')
    expect(raw).not.toContain('\u001b[2J')
    expect(raw).not.toContain('\u001b[31m')
    expect(stripAnsi(raw)).toContain('^[[2Jevil')
  })

  it('a notice with embedded newlines stays one physical row', () => {
    const notice = new SurfaceNotice(1_000)
    notice.show('a\nb\nc\nd', true)
    const surface = createBoundedSurface({
      reading: () => 0,
      title: () => 'Probe',
      body: () => ['body'],
      compact: () => 'Probe',
      notice,
      close: () => {},
    })
    for (const rows of HEIGHTS) {
      const lines = expectPhysicallyBounded(surface, 40, rows, 'kernel notice')
      // The whole notice is still shown, flattened to a space, never as rows.
      if (rows >= 1) expect(stripAnsi(lines.join('\n'))).toContain('a b c d')
    }
  })

  it('compactRows collapses a phrase newline instead of emitting two rows', () => {
    const row = compactRows('state\nmore', 40)
    expect(row.map(stripAnsi)).toEqual(['state more · esc close'])
  })
})

describe('physical geometry', () => {
  it('the multiselect compact fallback cuts its assembled row to the terminal', () => {
    const overlay = createMultiSelectOverlay({
      title: 'Pick',
      view: 'Pick',
      choices: [
        { value: 'a', label: 'AAAA' },
        { value: 'b', label: 'BBBB' },
      ],
      settle: () => {},
      invalidate: () => {},
    } as never)
    // The pre-fix row `❯ [ ] A` was seven columns on a five-column terminal and
    // wrapped into a second physical row, stranding the first frame's top row.
    expectPhysicallyBounded(overlay, 5, 2, 'multiselect compact')
    for (const columns of WIDTHS) {
      for (const rows of HEIGHTS) expectPhysicallyBounded(overlay, columns, rows, 'multiselect compact')
    }
  })

  it('the select compact fallback stays inside its terminal', () => {
    const overlay = createSelectOverlay({
      title: 'Pick',
      choices: Array.from({ length: 20 }, (_unused, index) => ({ value: `v${String(index)}`, label: `choice-${String(index)}` })),
      settle: () => {},
      invalidate: () => {},
    })
    overlay.handleKey(typed('z'))
    for (const columns of WIDTHS) {
      for (const rows of HEIGHTS) expectPhysicallyBounded(overlay, columns, rows, 'select compact')
    }
  })

  it('the plugins browser draws its frame just above the minimum width', () => {
    const row = (id: string): CompositionRow => ({
      locator: { steps: [{ index: 0, name: id, id }] },
      path: [id],
      id,
      name: id,
      depth: 0,
      group: false,
      disabled: { kind: 'enabled' },
      effective: 'enabled',
    })
    const state: PluginsState = {
      kind: 'ready',
      capabilities: { agentPresets: true, settings: true, canWriteUserPresets: true },
      presets: [{ id: 'standard', trust: 'system', name: 'Standard', description: undefined, broken: undefined, isCurrent: true, isDefault: true }],
      defaultId: 'standard',
      sessionPresetId: 'standard',
      blank: true,
      browsing: { kind: 'rows', presetId: 'standard', tree: { kind: 'parsed', rows: Array.from({ length: 20 }, (_unused, index) => row(`row-${String(index)}`)) } },
      host: { subagentProviders: undefined },
    } as never
    const overlay = createPluginsOverlay({
      state: () => state,
      refresh: () => {},
      toggle: () => {},
      pickPreset: () => {},
      makeDefault: () => {},
      now: () => 0,
      close: () => {},
      invalidate: () => {},
    })
    // The query row's `/ to search` hint used to overrun `inner` at this width,
    // so the physical backstop dropped the whole browser to its compact line.
    for (const columns of [32, 34, 36, 38, 40]) {
      const lines = expectPhysicallyBounded(overlay, columns, 24, 'plugins framed')
      expect(stripAnsi(lines.join('\n')), `framed at ${String(columns)} columns`).toContain('dshline')
    }
  })
})

describe('failure priority', () => {
  it('worktrees keeps a refusal visible in the compact fallback', () => {
    const listing: WorktreeListing = { kind: 'ready', rows: [{ cwd: '/repo', sessions: 0, current: false }] }
    const selection: WorktreeSelection = { row: listing.kind === 'ready' ? listing.rows[0]! : { cwd: '/repo', sessions: 0, current: false }, sessions: { kind: 'ready', entries: [], truncated: 0 } }
    const refuse: NewPlan = { kind: 'refused', message: 'still busy' } as never
    const overlay = createWorktreesOverlay({
      listing: () => listing,
      selection: () => selection,
      open: () => {},
      back: () => {},
      resume: () => ({ kind: 'resume' }) as never,
      create: () => refuse,
      home: '/home/dev',
      now: () => 0,
      close: () => {},
      invalidate: () => {},
    })
    // In the second view, Enter on `+ New session` is refused; the framed body
    // shows it, and a narrow terminal must not hide what the reader just caused.
    overlay.render(80, 24)
    overlay.handleKey(key('enter'))
    const compact = stripAnsi(overlay.render(17, 20).join('\n'))
    expect(compact).toContain('still busy')
  })
})

describe('the idle status line drops the whole context reading', () => {
  /** One status view with a million-token window and the given tokens. */
  function idleStatus(tokens: number): ReturnType<typeof createStatusView> {
    return createStatusView(() => ({
      busy: false,
      tick: 0,
      elapsedMs: undefined,
      activityWord: 'ready',
      activity: undefined,
      attention: undefined,
      model: 'deepseek-v4-flash',
      effort: undefined,
      usage: undefined,
      cacheRead: undefined,
      tokens,
      contextWindow: 1_000_000,
      detail: 'compact',
      work: undefined,
      pending: undefined,
      todo: undefined,
      plan: false,
      replay: undefined,
      goal: undefined,
    }))
  }

  it('never shows a half-cut reading at a narrow width', () => {
    const view = idleStatus(68_000)
    for (const columns of [1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 19, 20]) {
      const line = stripAnsi(view.render(columns)[0] ?? '')
      // Any context reading that appears must be the whole `68k/1.0M`; the
      // pre-fix line read `68k/1.0` or `68k/` at these widths.
      if (line.includes('68k/')) {
        expect(line, `at ${String(columns)} columns`).toContain('68k/1.0M')
      }
    }
  })
})

describe('control reads the current query, not the last frame', () => {
  /**
   * Every case here renders once, then edits the query and delivers the next
   * gesture WITHOUT a render in between. Invalidation is coalesced, so key
   * delivery does not imply a repaint; a gesture that read the previous frame's
   * array would act on a row the query has already removed.
   */

  /** One configurable Connect provider route. */
  function provider(id: string, displayName = id): ConnectProviderRow {
    return {
      kind: 'provider',
      provider: id,
      displayName,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', id],
      declared: false,
      state: 'active',
      models: 1,
      credential: { field: 'apiKeyEnv', ref: 'KEY', info: { configured: true, source: 'file', writable: true } },
      userOwned: true,
      revision: 1,
    }
  }

  /** A ready Connect reading over the given provider routes. */
  function connectState(providers: readonly ConnectProviderRow[]): ConnectState {
    return {
      kind: 'ready',
      providers,
      signIns: [],
      capabilities: { settings: true, credentials: true, authorization: false },
      newRouteTargets: [],
    }
  }

  /** Mount Connect and record which row each confirmed action targeted. */
  function mountConnect(state: ConnectState): { overlay: ReturnType<typeof createConnectOverlay>; acted: string[] } {
    const acted: string[] = []
    const overlay = createConnectOverlay({
      state: () => state,
      refresh: () => {},
      act: row => { acted.push(row.kind === 'provider' ? row.provider : row.kind === 'sign-in' ? row.key : row.label) },
      now: () => 0,
      close: () => {},
      invalidate: () => {},
    })
    return { overlay, acted }
  }

  it('Connect: a query that removes the selected route is in force at Enter', () => {
    const { overlay, acted } = mountConnect(connectState([provider('openai'), provider('anthropic', 'Anthropic')]))
    overlay.render(90, 24) // frame: [openai, anthropic], selected on openai
    for (const character of 'anth') overlay.handleKey(typed(character))
    // Deliberately no render between the edit and the gesture.
    overlay.handleKey(key('enter'))
    expect(acted).toEqual(['anthropic'])
  })

  it('Connect: movement and End use the query rows, not the old frame', () => {
    const { overlay, acted } = mountConnect(connectState([
      provider('openai'),
      provider('anthropic', 'Anthropic'),
      provider('google', 'Google'),
    ]))
    overlay.render(90, 24) // frame: [openai, anthropic, google]
    for (const character of 'goo') overlay.handleKey(typed(character))
    overlay.handleKey(key('down'))
    overlay.handleKey(key('enter'))
    expect(acted).toEqual(['google'])

    // An empty result must make both End and Enter no-ops rather than fall back
    // to the row the previous frame happened to hold.
    const empty = mountConnect(connectState([provider('openai')]))
    empty.overlay.render(90, 24)
    for (const character of 'zzz') empty.overlay.handleKey(typed(character))
    empty.overlay.handleKey(key('end'))
    empty.overlay.handleKey(key('enter'))
    expect(empty.acted).toEqual([])
  })

  /** One composition row for the Plugins browser. */
  function composition(id: string): CompositionRow {
    return {
      locator: { steps: [{ index: 0, name: id, id }] },
      path: [id],
      id,
      name: id,
      depth: 0,
      group: false,
      disabled: { kind: 'enabled' },
      effective: 'enabled',
    }
  }

  /** A ready Plugins reading browsing the given composition rows. */
  function pluginsState(rows: readonly CompositionRow[]): PluginsState {
    return {
      kind: 'ready',
      capabilities: { agentPresets: true, settings: true, canWriteUserPresets: true },
      presets: [{ id: 'standard', trust: 'system', name: 'Standard', description: undefined, broken: undefined, isCurrent: true, isDefault: true }],
      defaultId: 'standard',
      sessionPresetId: 'standard',
      blank: true,
      browsing: { kind: 'rows', presetId: 'standard', tree: { kind: 'parsed', rows } },
      host: { subagentProviders: undefined },
    } as never
  }

  /** Mount Plugins and record which row each toggle targeted. */
  function mountPlugins(state: PluginsState): { overlay: ReturnType<typeof createPluginsOverlay>; toggled: string[] } {
    const toggled: string[] = []
    const overlay = createPluginsOverlay({
      state: () => state,
      refresh: () => {},
      toggle: row => { toggled.push(row.id ?? row.name) },
      pickPreset: () => {},
      makeDefault: () => {},
      now: () => 0,
      close: () => {},
      invalidate: () => {},
    })
    return { overlay, toggled }
  }

  it('Plugins: leaving search then acting uses the query rows, not the old frame', () => {
    const { overlay, toggled } = mountPlugins(pluginsState([composition('alpha'), composition('beta')]))
    overlay.render(90, 24) // frame: [alpha, beta], selected on alpha
    overlay.handleKey(typed('/'))
    for (const character of 'beta') overlay.handleKey(typed(character))
    overlay.handleKey(key('enter')) // leave search mode
    // Deliberately no render between the edit and the action.
    overlay.handleKey(key('enter'))
    expect(toggled).toEqual(['beta'])
  })

  it('Plugins: movement after an edit searches the new rows', () => {
    const { overlay, toggled } = mountPlugins(pluginsState([
      composition('alpha'),
      composition('beta'),
      composition('gamma'),
    ]))
    overlay.render(90, 24) // frame: [alpha, beta, gamma]
    overlay.handleKey(typed('/'))
    for (const character of 'gamma') overlay.handleKey(typed(character))
    overlay.handleKey(key('enter'))
    overlay.handleKey(key('down'))
    overlay.handleKey(typed(' '))
    expect(toggled).toEqual(['gamma'])
  })

  /** One profile row for the Profiles browser. */
  function profile(name: string): ProfileRow {
    return { name, dir: `/p/${name}`, current: false, bundles: [], plain: [], pendingBuilds: [], broken: undefined }
  }

  /** A ready Profiles reading over the given profiles. */
  function profilesState(profiles: readonly ProfileRow[]): ProfilesState {
    return { kind: 'ready', reading: { root: '/p', profiles } }
  }

  /** Mount Profiles and record the row each action targeted. */
  function mountProfiles(state: ProfilesState): {
    overlay: ReturnType<typeof createProfilesOverlay>
    added: string[]
    explained: string[]
  } {
    const added: string[] = []
    const explained: string[] = []
    const overlay = createProfilesOverlay({
      state: () => state,
      activity: () => ({ running: [], restartQueued: [] }),
      refresh: () => {},
      addBundle: target => { added.push(target.name) },
      updateBundle: () => {},
      removeBundle: () => {},
      removeDependency: () => {},
      createProfile: () => {},
      explainBoot: target => { explained.push(target.name) },
      now: () => 0,
      close: () => {},
      invalidate: () => {},
    })
    return { overlay, added, explained }
  }

  it('Profiles: a row action after an edit targets the query row, not the old frame', () => {
    const { overlay, added } = mountProfiles(profilesState([profile('dshline'), profile('web')]))
    overlay.render(90, 28) // selectable: [dshline, web], selected on dshline
    overlay.handleKey(typed('/'))
    for (const character of 'web') overlay.handleKey(typed(character))
    overlay.handleKey(key('enter')) // leave search mode
    // Deliberately no render between the edit and the action.
    overlay.handleKey(typed('a'))
    expect(added).toEqual(['web'])
  })

  it('Profiles: Enter and movement use the query rows after an edit', () => {
    const { overlay, explained } = mountProfiles(profilesState([
      profile('dshline'),
      profile('web'),
      profile('infra'),
    ]))
    overlay.render(90, 28) // selectable: [dshline, web, infra]
    overlay.handleKey(typed('/'))
    for (const character of 'infra') overlay.handleKey(typed(character))
    overlay.handleKey(key('enter'))
    overlay.handleKey(key('down'))
    overlay.handleKey(key('enter'))
    expect(explained).toEqual(['infra'])

    // A query matching nothing leaves no row to explain.
    const empty = mountProfiles(profilesState([profile('dshline')]))
    empty.overlay.render(90, 28)
    empty.overlay.handleKey(typed('/'))
    for (const character of 'zzz') empty.overlay.handleKey(typed(character))
    empty.overlay.handleKey(key('enter'))
    empty.overlay.handleKey(key('enter'))
    expect(empty.explained).toEqual([])
  })
})
