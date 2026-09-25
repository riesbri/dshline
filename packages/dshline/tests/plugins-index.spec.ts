/**
 * Orchestration: what a keystroke in `/plugins` actually does end to end.
 *
 * These drive `openPlugins` for real — a fake `ctx.tuiSlots` stack answers
 * whatever overlay is currently on top (the browser itself, then the preset
 * picker or the locked-session offer when one is raised) — against a fake
 * profile whose declarations live in memory, so a toggle's `configEditor.edit`,
 * Harness's own `recompose`/`select`/`settings.update` calls, and the session's
 * recorded switch are all exercised together, not just the units that make each
 * decision.
 *
 * The fake profile is a `ConfigEditorSeam` plus a roster, not a directory of
 * files. That is the migration: the previous generation's roster published a
 * `path` per preset and this frontend spliced one `disabled` field in the file
 * it named, while the adopted registry publishes no path, "writes no
 * declarations", and leaves persistence to the profile configuration editor. A
 * fake holding files would be modelling a service that no longer exists, and it
 * could not express the two things the browser now depends on — that an edit
 * takes the row's WHOLE next config, and that the editor hands the change back
 * to Harness, which then re-renders the declaration.
 *
 * Waits are condition-polled (`waitUntil`), never a fixed timeout: the chains
 * under test bottom out in the catalog's own re-read and an action's awaits,
 * whose completion arrives on a schedule this suite does not control.
 */

import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Key } from '@dshline/renderer'
import type { TuiOverlay } from '../src/slots.ts'
import { openPlugins } from '../src/plugins/index.ts'
import type { PluginsAgent } from '../src/plugins/index.ts'
import type { AgentPresetRow, AgentPresetsSeam, ConfigEditorSeam, PluginsSettings } from '../src/plugins/harness.ts'

/** A fixed clock; nothing here relies on notice expiry. */
const NOW = 1_800_000_000_000

/** The module that declares a preset, as the editor's entry list names it. */
const PRESET_DECLARATION = '@deepseek-ai/dsh-agent-preset'

/**
 * One declaration in the fake profile: the roster row Harness reports, and the
 * resolved child list its configuration editor persists.
 *
 * No `path` and no `trust`, because the adopted registry publishes neither: a
 * declaration is a row in a composition, and a profile may carry an override of
 * a shipped one, so there is nothing about a row's origin to record.
 */
interface FakePreset {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly broken?: string
  /** The declaration's resolved child rows; an `edit` replaces this list. */
  plugins: readonly unknown[]
}

/**
 * A shipped-shaped declaration: a plain row and a `delegation` group whose
 * child is disabled.
 *
 * Built fresh per call, because an `edit` rewrites the list it is handed: two
 * presets sharing one child list would make one preset's toggle show up in the
 * other's composition.
 * @param id - the preset id.
 * @param overrides - fields to replace.
 * @returns the declaration.
 */
function preset(id: string, overrides: Partial<FakePreset> = {}): FakePreset {
  return {
    id,
    plugins: [
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      {
        id: 'delegation',
        name: 'cordis:group',
        group: true,
        config: [{ id: 'tool-subagent-codex', name: '@deepseek-ai/dsh-subagent-codex', disabled: true }],
      },
    ],
    ...overrides,
  }
}

/**
 * A declaration with one enabled row.
 * @param id - the preset id.
 * @param overrides - fields to replace.
 * @returns the declaration.
 */
function minimal(id: string, overrides: Partial<FakePreset> = {}): FakePreset {
  return { id, plugins: [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }], ...overrides }
}

/**
 * Render a declaration's resolved child list the way the registry renders one:
 * entry-list YAML the browser parses back into the rows it drew.
 *
 * Re-serializing the whole list is what the real write path does — the editor
 * validates a `config` through the owning plugin's own `Config` and persists a
 * profile-layer override, so a comment belongs to the rendering and not to what
 * a write preserves. A `!!js` conditional is the one thing this does not round
 * trip, because a resolved expression is a plain object once the Loader has
 * handed it over; no fixture here uses one, since a row whose condition came
 * back as an ordinary truthy `disabled` would have the suite asserting about a
 * row the store does not hold.
 * @param plugins - the declaration's resolved child rows.
 * @returns the entry-list text.
 */
function render(plugins: readonly unknown[]): string {
  return stringify(plugins, { lineWidth: 0 })
}

/** One entry of the editor's profile rows, as this suite's fake reports it. */
interface FakeEntry {
  readonly options: { readonly id: string; readonly name: string; readonly config: Record<string, unknown> }
}

/** The roster row one declaration is reported as. */
function rowOf(declaration: FakePreset): AgentPresetRow {
  return {
    id: declaration.id,
    ...declaration.name === undefined ? {} : { name: declaration.name },
    ...declaration.description === undefined ? {} : { description: declaration.description },
    ...declaration.broken === undefined ? {} : { broken: declaration.broken },
  }
}

/**
 * The profile configuration editor over a store: one entry per declaration, and
 * an `edit` that hands the seam the row's whole next config and keeps what came
 * back.
 *
 * Mirrors the two properties of the real editor the browser depends on: the
 * change is derived from the CURRENT config — so a second edit against the same
 * entry sees what the first persisted — and the editor is what holds the result,
 * not dshline writing anything itself.
 * @param store - the declarations this profile carries.
 * @param onEdit - called as each edit begins, for tests that need a write to be
 * where a turn can start.
 * @returns the seam, and the edits it recorded.
 */
function fakeConfigEditor(
  store: Map<string, FakePreset>,
  onEdit: () => void = () => {},
): { editor: ConfigEditorSeam; edits: { entry: string; config: Record<string, unknown> }[] } {
  const entries: FakeEntry[] = [...store].map(([id, declaration]) => ({
    options: { id: `preset-${id}`, name: PRESET_DECLARATION, config: { id, order: 1, plugins: declaration.plugins } },
  }))
  const current = new Map(entries.map(entry => [entry.options.id, entry.options.config]))
  const edits: { entry: string; config: Record<string, unknown> }[] = []
  const editor: ConfigEditorSeam = {
    entries: () => entries,
    edit: async (target, change) => {
      onEdit()
      const existing = current.get(target.options.id)
      if (existing === undefined) throw new Error(`no config tracked for ${target.options.id}`)
      const next = change({ ...existing }, {})
      const id = next['id']
      const declaration = typeof id === 'string' ? store.get(id) : undefined
      if (declaration === undefined) throw new Error(`no declaration for ${String(id)}`)
      const plugins = next['plugins']
      if (!Array.isArray(plugins)) throw new Error('the declaration holds no child list')
      declaration.plugins = plugins
      current.set(target.options.id, next)
      edits.push({ entry: target.options.id, config: next })
    },
  }
  return { editor, edits }
}

/**
 * An `AgentPresetsSeam` over an in-memory roster of declarations.
 * @param store - the roster.
 * @param defaultId - the id `defaultId` reports.
 * @param composed - what `composedPreset` reports.
 * @param overrides - fields to replace on the fake seam.
 * @param started - whether the session has opened a turn, for `select`'s own
 * re-check.
 * @returns the seam, and what it recorded.
 */
function fakeAgentPresets(
  store: Map<string, FakePreset>,
  defaultId: string,
  composed: string | undefined,
  overrides: Partial<AgentPresetsSeam> = {},
  started: () => boolean = () => false,
): { seam: AgentPresetsSeam; recomposed: string[]; selected: string[] } {
  const recomposed: string[] = []
  const selected: string[] = []
  const seam: AgentPresetsSeam = {
    get defaultId() { return defaultId },
    list: async () => [...store.values()].map(rowOf),
    resolve: async id => {
      const found = store.get(id ?? defaultId)
      if (found === undefined) throw new Error(`unknown preset ${String(id)}`)
      return rowOf(found)
    },
    composedPreset: () => composed,
    // Only the window composes an agent, by mounting an unpublished one. A
    // browser that reached for this would re-parent a live scope to draw a list.
    mount: async () => { throw new Error('/plugins must not mount an agent') },
    recompose: async (_agentCtx, id) => {
      recomposed.push(id)
      const found = store.get(id)
      if (found === undefined) throw new Error(`unknown preset ${id}`)
      return rowOf(found)
    },
    // Harness's owned operation, mirrored in the order the real one performs
    // it: re-check the started lock INSIDE the switch, recompose, and only
    // then record. dshline contributes none of those three steps.
    select: async (agent, id) => {
      if (started()) {
        throw new Error(`session "${String(agent.id)}" has already started; its agent preset is fixed`)
      }
      recomposed.push(id)
      const found = store.get(id)
      if (found === undefined) throw new Error(`unknown preset ${id}`)
      selected.push(found.id)
      return found.id
    },
    // View-only by construction: the registry renders the declared child list
    // back as entry-list YAML and accepts nothing in return, so this is the one
    // composition read the browser gets.
    readDocument: async agentPreset => {
      const found = store.get(agentPreset)
      if (found === undefined) throw new Error(`unknown preset ${agentPreset}`)
      return {
        agentPreset,
        content: render(found.plugins),
        ...found.name === undefined ? {} : { name: found.name },
        ...found.description === undefined ? {} : { description: found.description },
      }
    },
    ...overrides,
  }
  return { seam, recomposed, selected }
}

/** One namespace patch the settings seam was asked to apply. */
type SettingsUpdate = { ns: string; patch: Readonly<Record<string, unknown>> }

/**
 * A settings seam that records every namespace patch it is asked to apply.
 * @returns the seam, and what it recorded.
 */
function fakeSettings(): { settings: PluginsSettings; updates: SettingsUpdate[] } {
  const updates: SettingsUpdate[] = []
  return {
    settings: { update: async (ns, patch) => { updates.push({ ns, patch }) } },
    updates,
  }
}

/** What one fake agent's projections answer, and how a test moves them. */
interface FakeAgent {
  /** The agent `/plugins` is opened over; a real detached Session underneath. */
  readonly agent: PluginsAgent
  /** The `ctx.sessionProjections` seam answering for that exact session. */
  readonly projections: FakeProjections
  /** Whether the `turnBoundary` projection currently reports a turn. */
  readonly started: () => boolean
  /** Start a turn mid-action, the way a real one lands across an await. */
  readonly startTurn: () => void
}

/** The two projection reads `/plugins` makes, answered for one exact session. */
interface FakeProjections {
  stateOf(session: Session, key: 'agentPreset' | 'turnBoundary'): unknown
}

/**
 * A fake agent whose Harness projections answer for one real detached Session.
 *
 * The facts are read live, not captured, which is what lets a test start a
 * turn part-way through an action and see whether the decision that follows
 * noticed. Nothing here fakes `Session.append`: dshline never
 * writes `agent-preset/selected` — `AgentPresets.select` does — so the fake
 * roster records the switch instead (see `fakeAgentPresets`).
 * @param presetId - what the `agentPreset` projection reports.
 * @param blank - whether the `turnBoundary` projection starts with no turn.
 * @returns the agent, its projections, and a way to start a turn mid-flight.
 */
function fakeAgent(presetId: string | undefined, blank: boolean): FakeAgent {
  const id = SessionId('plugins-index-spec')
  const session = Session.create(id)
  let started = !blank
  const projections: FakeProjections = {
    stateOf: (target, key) => {
      // Session ids are durable names, not identity: only THIS session's facts.
      if (target !== session) return undefined
      if (key === 'agentPreset') return presetId ?? null
      return {
        openTurnStartSeq: null,
        lastStepStartSeq: null,
        lastStepBoundary: null,
        lastTurn: started ? 1 : 0,
      }
    },
  }
  return {
    agent: { id, ctx: {}, session },
    projections,
    started: () => started,
    startTurn: () => { started = true },
  }
}

/** A context whose slot registry hands each pushed overlay to the test, plus `ctx.get`. */
interface Harness {
  readonly ctx: Context
  readonly answer: (...keys: Key[]) => void
  readonly depth: () => number
  readonly renderTop: () => string | undefined
}

/**
 * A context offering `tuiSlots` and the four seams `/plugins` reads off a
 * context: `agentPresets`, `settings`, `configEditor`, and `sessionProjections`.
 *
 * The editor is a required argument rather than an optional extra: a toggle
 * that found no editor mounted is a silent no-op, so a test that meant to write
 * one must not be able to leave it out and pass.
 * @param agentPresets - the preset seam, or undefined to simulate an absent one.
 * @param settings - the settings seam, or undefined.
 * @param projections - the projection registry answering the session's facts.
 * @param configEditor - the profile configuration editor, or undefined.
 * @returns the context and its controls.
 */
function harness(
  agentPresets: AgentPresetsSeam | undefined,
  settings: PluginsSettings | undefined,
  projections: FakeProjections | undefined,
  configEditor: ConfigEditorSeam | undefined,
): Harness {
  const stack: TuiOverlay[] = []
  const ctx = {
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay): (() => void) => {
        stack.push(overlay)
        return (): void => {
          const index = stack.indexOf(overlay)
          if (index >= 0) stack.splice(index, 1)
        }
      },
      invalidate: (): void => {},
    },
    get: (name: string): unknown => {
      if (name === 'agentPresets') return agentPresets
      if (name === 'settings') return settings
      if (name === 'configEditor') return configEditor
      if (name === 'sessionProjections') return projections
      return undefined
    },
  } as unknown as Context
  return {
    ctx,
    answer: (...keys) => { const top = stack.at(-1); for (const k of keys) top?.handleKey(k) },
    depth: () => stack.length,
    renderTop: () => stack.at(-1)?.render(90, 24).join('\n'),
  }
}

function key(name: Extract<Key, { kind: 'key' }>['name']): Key {
  return { kind: 'key', name }
}

function press(t: string): Key {
  return { kind: 'text', text: t }
}

/**
 * Poll a condition until it holds, rather than guessing a fixed delay.
 * @param predicate - checked every few milliseconds.
 * @param label - named in the timeout error, for a failure that is legible.
 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
}

/**
 * Wait for the initial catalog read to land: the query row's placeholder
 * text only appears once a `'ready'` state has actually been rendered.
 * @param h - the harness whose top overlay is the Plugins browser.
 */
async function waitReady(h: Harness): Promise<void> {
  // "Preset:" only appears once `PluginsState` is actually `'ready'` — unlike
  // the query hint, which the loading frame shows too, this cannot pass
  // while the first catalog read is still in flight.
  await waitUntil(() => h.renderTop()?.includes('Preset:') === true, 'initial ready render')
}

describe('a row toggle: the current session', () => {
  it('a blank session on the toggled preset is recomposed live, with no new selection event', async () => {
    const store = new Map<string, FakePreset>([['mine', minimal('mine')]])
    const { agent, projections, started } = fakeAgent('mine', true)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press(' ')) // toggle the only row, tool-fs
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    // The declaration that landed is re-read and drawn, which is the only
    // evidence a reader has that the row they just pressed space on is off.
    await waitUntil(() => h.renderTop()?.includes('○') === true, 'the row redrawn as disabled')
    h.answer(key('escape'))
    await done

    expect(store.get('mine')?.plugins).toEqual([{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', disabled: true }])
    expect(recomposed).toEqual(['mine'])
    expect(selected).toEqual([])
    expect(committed.join('\n')).toContain('current session updated live')
  })

  it('a started session on the toggled preset is never recomposed; the declaration still changes', async () => {
    const store = new Map<string, FakePreset>([['mine', minimal('mine')]])
    const { agent, projections, started } = fakeAgent('mine', false)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    expect(store.get('mine')?.plugins).toEqual([{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', disabled: true }])
    expect(recomposed).toEqual([])
    expect(selected).toEqual([])
    expect(committed.join('\n')).toContain('saved for future sessions')
    expect(committed.join('\n')).toContain('already started')
  })

  it('reports honestly when the write succeeds but the live recompose then fails', async () => {
    const store = new Map<string, FakePreset>([['mine', minimal('mine')]])
    const { agent, projections, started } = fakeAgent('mine', true)
    const { seam, selected } = fakeAgentPresets(store, 'mine', 'mine', {
      recompose: async () => { throw new Error('standing mount is wedged') },
    }, started)
    const { editor } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    // The write already landed — a failed recompose does not undo it.
    expect(store.get('mine')?.plugins).toEqual([{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', disabled: true }])
    expect(selected).toEqual([])
    const transcript = committed.join('\n')
    expect(transcript).toContain('✗')
    expect(transcript).toContain('could not pick it up')
    expect(transcript).toContain('standing mount is wedged')
  })

  it('refuses a group row, which has no single on/off state, and writes nothing', async () => {
    // A refusal that is never attempted is an ephemeral notice and no committed
    // row: nothing was done, so nothing durable is said about it.
    const store = new Map<string, FakePreset>([['standard', preset('standard')]])
    const { agent, projections, started } = fakeAgent('standard', true)
    const { seam, recomposed } = fakeAgentPresets(store, 'standard', 'standard', {}, started)
    const { editor, edits } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    // Rows in document order: tool-fs, delegation.
    h.answer(key('down'), key('enter'))
    await waitUntil(() => h.renderTop()?.includes('no single on/off state') === true, 'group-row refusal notice')
    h.answer(key('escape'))
    await done

    expect(edits).toEqual([])
    expect(recomposed).toEqual([])
    expect(committed).toEqual([])
  })
})

describe('a toggle on a preset the session is not confirmed to be running', () => {
  it('never switches or recomposes; the outcome names what the current session runs instead', async () => {
    const store = new Map<string, FakePreset>([['standard', preset('standard')]])
    // Nothing composed yet and no header preset: dshline cannot positively
    // confirm the session is running `standard`, even though it is browsing it
    // as the default — so a write here must not touch the session.
    const { agent, projections, started } = fakeAgent(undefined, true)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'standard', undefined, {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    expect(store.get('standard')?.plugins[0])
      .toEqual({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', disabled: true })
    expect(recomposed).toEqual([])
    expect(selected).toEqual([])
    expect(committed.join('\n')).toContain('the current session runs another preset')
  })
})

describe('p: switching the session onto another preset', () => {
  it('tells its caller the composition changed, so scope-aware views re-read', async () => {
    const store = new Map<string, FakePreset>([
      ['standard', preset('standard')],
      ['minimal', minimal('minimal')],
    ])
    const { agent, projections, started } = fakeAgent('standard', true)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'standard', 'standard', {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    // A re-parented scope changes which layers a scope-aware Harness registry
    // merges for this agent, and emits no registry mutation saying so — which
    // is exactly why this hook exists rather than a `skills/change` listener
    // being enough.
    let composedAgain = 0
    const done = openPlugins({
      ctx: h.ctx,
      agent,
      commit: lines => { committed.push(...lines) },
      now: () => NOW,
      recomposed: () => { composedAgain += 1 },
    })
    await waitReady(h)
    h.answer(press('p'))
    await waitUntil(() => h.depth() === 2, 'preset picker open')
    // The roster is offered in list order; `minimal` is the second row.
    h.answer(key('down'), key('enter'))
    await waitUntil(() => committed.length > 0, 'switch outcome committed')
    h.answer(key('escape'))
    await done

    expect(recomposed).toEqual(['minimal'])
    expect(selected).toEqual(['minimal'])
    expect(agent.session.snapshotEvents()).toEqual([])
    expect(composedAgain).toBe(1)
  })

  it('says nothing changed when the switch itself failed', async () => {
    const store = new Map<string, FakePreset>([
      ['standard', preset('standard')],
      ['minimal', minimal('minimal')],
    ])
    const { agent, projections, started } = fakeAgent('standard', true)
    const { seam } = fakeAgentPresets(store, 'standard', 'standard', {
      select: async () => { throw new Error('standing mount is wedged') },
    }, started)
    const { editor } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    let composedAgain = 0
    const done = openPlugins({
      ctx: h.ctx,
      agent,
      commit: lines => { committed.push(...lines) },
      now: () => NOW,
      recomposed: () => { composedAgain += 1 },
    })
    await waitReady(h)
    h.answer(press('p'))
    await waitUntil(() => h.depth() === 2, 'preset picker open')
    h.answer(key('down'), key('enter'))
    await waitUntil(() => committed.length > 0, 'switch outcome committed')
    h.answer(key('escape'))
    await done

    // Nothing was re-parented, so nothing must be told it was.
    expect(composedAgain).toBe(0)
  })

  it('never offers a broken declaration in the picker at all', async () => {
    const store = new Map<string, FakePreset>([
      ['standard', preset('standard')],
      ['broken-one', minimal('broken-one', { broken: 'a service row escaped its isolate realm' })],
    ])
    const { agent, projections, started } = fakeAgent('standard', true)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'standard', 'standard', {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press('p'))
    await waitUntil(() => h.depth() === 2, 'preset picker open')
    // One choice, not two, and confirming it switches rather than doing nothing.
    expect(h.renderTop()).not.toContain('broken-one')
    h.answer(key('enter'))
    await waitUntil(() => committed.length > 0, 'switch outcome committed')
    h.answer(key('escape'))
    await done

    expect(recomposed).toEqual(['standard'])
    expect(selected).toEqual(['standard'])
  })
})

describe('a live toggle that recomposes the current session', () => {
  it('tells its caller the composition changed', async () => {
    const store = new Map<string, FakePreset>([['mine', minimal('mine')]])
    const { agent, projections, started } = fakeAgent('mine', true)
    const { seam, recomposed } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    let composedAgain = 0
    const done = openPlugins({
      ctx: h.ctx,
      agent,
      commit: lines => { committed.push(...lines) },
      now: () => NOW,
      recomposed: () => { composedAgain += 1 },
    })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    expect(recomposed).toEqual(['mine'])
    expect(composedAgain).toBe(1)
  })

  it('says nothing when a started session was left on its existing composition', async () => {
    const store = new Map<string, FakePreset>([['mine', minimal('mine')]])
    const { agent, projections, started } = fakeAgent('mine', false)
    const { seam, recomposed } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    let composedAgain = 0
    const done = openPlugins({
      ctx: h.ctx,
      agent,
      commit: lines => { committed.push(...lines) },
      now: () => NOW,
      recomposed: () => { composedAgain += 1 },
    })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    expect(recomposed).toEqual([])
    expect(composedAgain).toBe(0)
  })
})

describe('d: making the browsed preset the default', () => {
  it('refuses a preset the roster reports broken, without mutating settings', async () => {
    const store = new Map<string, FakePreset>([
      ['standard', preset('standard', { broken: 'a service row escaped its isolate realm' })],
    ])
    const { agent, projections, started } = fakeAgent('standard', true)
    const { seam } = fakeAgentPresets(store, 'code', 'standard', {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings, updates } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press('d'))
    // A refusal that never attempted a write is an ephemeral notice, not a
    // committed transcript row — the same posture Connect's own refusals
    // take (`noActionsReason`): nothing was done, so nothing durable is said.
    await waitUntil(() => h.renderTop()?.includes('cannot be made the default') === true, 'make-default refusal notice')
    expect(h.renderTop()).toContain('isolate realm')
    h.answer(key('escape'))
    await done

    expect(updates).toEqual([])
    expect(committed).toEqual([])
  })

  it('refuses a preset that has disappeared from the roster entirely', async () => {
    const store = new Map<string, FakePreset>()
    // `composedPreset` names an id the roster no longer lists at all.
    const { agent, projections, started } = fakeAgent('ghost', true)
    const { seam } = fakeAgentPresets(store, 'standard', 'ghost', {
      readDocument: async () => { throw new Error('ENOENT') },
    }, started)
    const { editor } = fakeConfigEditor(store)
    const { settings, updates } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press('d'))
    await waitUntil(() => h.renderTop()?.includes('no longer on the roster') === true, 'make-default refusal notice')
    h.answer(key('escape'))
    await done

    expect(updates).toEqual([])
    expect(committed).toEqual([])
  })

  it('says a preset that is already the default is the default, without writing', async () => {
    const store = new Map<string, FakePreset>([['mine', minimal('mine')]])
    const { agent, projections, started } = fakeAgent('mine', true)
    const { seam } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings, updates } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press('d'))
    await waitUntil(() => h.renderTop()?.includes('already the default') === true, 'already-default notice')
    h.answer(key('escape'))
    await done

    expect(updates).toEqual([])
    expect(committed).toEqual([])
  })
})

describe('the started-session lock is re-checked at the moment it is acted on', () => {
  it('does not recompose a session that started a turn while the declaration was being written', async () => {
    const store = new Map<string, FakePreset>([['mine', minimal('mine')]])
    const { agent, projections, started, startTurn } = fakeAgent('mine', true)
    // The eligibility this turns on was read before the write, and the fact it
    // is about can change across the write's own await. Starting the turn as
    // the editor begins puts the turn exactly where a real one can land:
    // after the reading the toggle was decided against, before the live-effect
    // decision. A decision made from that stale reading recomposes a session
    // that has already produced a turn — the one boundary this whole feature
    // exists to respect.
    let edits = 0
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { editor } = fakeConfigEditor(store, () => {
      edits += 1
      if (edits === 1) startTurn()
    })
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press(' '))
    await waitUntil(() => committed.length > 0, 'toggle outcome committed')
    h.answer(key('escape'))
    await done

    // The write still happened — the profile override is the durable
    // customization, and withholding it would lose work over a race the reader
    // never saw.
    expect(store.get('mine')?.plugins).toEqual([{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', disabled: true }])
    expect(recomposed).toEqual([])
    expect(selected).toEqual([])
    expect(committed.join('\n')).toContain('saved for future sessions')
  })

  it('offers the next session\'s default when a turn starts while the picker is open, and never switches', async () => {
    const store = new Map<string, FakePreset>([
      ['standard', preset('standard')],
      ['minimal', minimal('minimal')],
    ])
    const { agent, projections, started, startTurn } = fakeAgent('standard', true)
    const { seam, recomposed, selected } = fakeAgentPresets(store, 'standard', 'standard', {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings, updates } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press('p'))
    await waitUntil(() => h.depth() === 2, 'preset picker open')
    // A turn begins while the human is still choosing.
    startTurn()
    h.answer(key('down'), key('enter'))
    await waitUntil(() => h.renderTop()?.includes('Session preset is fixed') === true, 'locked-session offer raised')
    h.answer(key('enter')) // "Make minimal the default" is offered first
    await waitUntil(() => committed.length > 0, 'make-default outcome committed')
    h.answer(key('escape'))
    await done

    // The lock is honoured rather than bypassed and rather than silently
    // dropping the request: the pick lands as the next session's default.
    expect(recomposed).toEqual([])
    expect(selected).toEqual([])
    expect(updates).toEqual([{ ns: 'agent-preset-registry', patch: { selectedDefault: 'minimal' } }])
    expect(committed.join('\n')).toContain('is now the default for new sessions')
  })
})

describe('an action that throws instead of answering', () => {
  it('reports a throwing recomposed hook rather than leaving the rejection unhandled', async () => {
    const store = new Map<string, FakePreset>([
      ['mine', minimal('mine')],
      ['other', minimal('other')],
    ])
    const { agent, projections, started } = fakeAgent('mine', true)
    const { seam } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const rejections: unknown[] = []
    const onRejection = (error: unknown): void => { rejections.push(error) }
    process.on('unhandledRejection', onRejection)
    try {
      // `recomposed` is the caller's own hook, invoked after a committed
      // switch. Nothing turns its throw into an outcome, so without a catch
      // around the action it becomes an unhandled rejection — which ends the
      // process on Node's default setting, over one keystroke in an overlay.
      const done = openPlugins({
        ctx: h.ctx,
        agent,
        commit: lines => { committed.push(...lines) },
        now: () => NOW,
        recomposed: () => { throw new Error('the skill catalog refused to re-read') },
      })
      await waitReady(h)
      h.answer(press('p'))
      await waitUntil(() => h.depth() === 2, 'preset picker raised')
      h.answer(key('down'), key('enter'))
      await waitUntil(() => committed.length > 0, 'failure committed')
      h.answer(key('escape'))
      await done
      // Let any stray rejection reach the process hook before asserting none did.
      await new Promise(resolve => { setTimeout(resolve, 20) })
    } finally {
      process.off('unhandledRejection', onRejection)
    }

    expect(rejections).toEqual([])
    expect(committed.join('\n')).toContain('could not be completed')
    expect(committed.join('\n')).toContain('refused to re-read')
  })

  it('does not reject again when reporting the failure is itself what fails', async () => {
    const store = new Map<string, FakePreset>([
      ['mine', minimal('mine')],
      ['other', minimal('other')],
    ])
    const { agent, projections, started } = fakeAgent('mine', true)
    const { seam } = fakeAgentPresets(store, 'mine', 'mine', {}, started)
    const { editor } = fakeConfigEditor(store)
    const { settings } = fakeSettings()
    const h = harness(seam, settings, projections, editor)
    // Drawing is this domain's only channel. If the recovery path's own write
    // throws, letting it out would reject the promise the catch exists to
    // settle — reintroducing the crash by way of the recovery from it.
    let attempts = 0
    const commit = (): void => {
      attempts += 1
      throw new Error('the terminal is gone')
    }
    const rejections: unknown[] = []
    const onRejection = (error: unknown): void => { rejections.push(error) }
    process.on('unhandledRejection', onRejection)
    try {
      const done = openPlugins({
        ctx: h.ctx,
        agent,
        commit,
        now: () => NOW,
        recomposed: () => { throw new Error('the skill catalog refused to re-read') },
      })
      await waitReady(h)
      h.answer(press('p'))
      await waitUntil(() => h.depth() === 2, 'preset picker raised')
      h.answer(key('down'), key('enter'))
      await waitUntil(() => attempts > 0, 'the recovery write was attempted')
      h.answer(key('escape'))
      await done
      await new Promise(resolve => { setTimeout(resolve, 20) })
    } finally {
      process.off('unhandledRejection', onRejection)
    }

    expect(rejections).toEqual([])
  })
})

describe('a write that lands after the reader has closed the browser', () => {
  // Deliberately unlike Connect, which drops a late result outright: a
  // withdrawn sign-in is work that did not happen, while this write persisted a
  // profile override, and the committed row is the only durable evidence of it
  // this session leaves. `land` skips the transient notice and the re-read in
  // this case — neither is observable from here, since a disposed catalog
  // already ignores a refresh, but both are addressed to a reader who left.
  it('still commits the transcript row naming what landed', async () => {
    const store = new Map<string, FakePreset>([
      ['mine', minimal('mine')],
      ['other', minimal('other', { name: 'Other' })],
    ])
    // The default is `other` while the session runs `mine`, so `d` on the
    // browsed preset is a real write rather than the "already the default"
    // early return.
    const { agent, projections, started } = fakeAgent('mine', false)
    const { seam } = fakeAgentPresets(store, 'other', 'mine', {}, started)
    const { editor } = fakeConfigEditor(store)
    // A settings write held open until the test releases it, so `esc` is
    // guaranteed to arrive first rather than racing the write.
    let release = (): void => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const updates: SettingsUpdate[] = []
    const settings: PluginsSettings = {
      update: async (ns, patch) => {
        await held
        updates.push({ ns, patch })
      },
    }
    const h = harness(seam, settings, projections, editor)
    const committed: string[] = []
    const done = openPlugins({ ctx: h.ctx, agent, commit: lines => { committed.push(...lines) }, now: () => NOW })
    await waitReady(h)
    h.answer(press('d'))
    // The started session makes `d` the plain make-default path, whose only
    // await is the held `update`.
    await waitUntil(() => h.depth() === 1, 'still only the browser on the stack')
    h.answer(key('escape'))
    await done
    expect(h.depth()).toBe(0)
    release()
    await waitUntil(() => committed.length > 0, 'late outcome committed')

    // The write did happen, through the namespace and field the adopted
    // registry reserves for exactly this, so the transcript says so: it is the
    // only durable evidence this session leaves of it.
    expect(updates).toEqual([{ ns: 'agent-preset-registry', patch: { selectedDefault: 'mine' } }])
    expect(committed.join('\n')).toContain('is now the default for new sessions')
  })
})
