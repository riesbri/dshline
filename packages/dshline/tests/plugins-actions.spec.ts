/**
 * The writes `/plugins` performs, each through the seam that owns it.
 *
 * Three of them, one per authority: a composition edit through the profile
 * configuration editor, a preset switch through Harness's own whole
 * `AgentPresets.select` operation, and the default preset through the
 * `agent-preset-registry` namespace's `selectedDefault` field.
 *
 * The composition edit changed owner rather than disappearing, so the fakes here
 * are a {@link ConfigEditorSeam} over a structured child list instead of a file
 * on disk. The previous generation's roster published a `path` and this frontend
 * spliced one `disabled` field in the file it named; the adopted registry
 * publishes no path, "writes no declarations", and its own preset tree refuses
 * `write()` because "only the profile configuration editor persists
 * definitions". So the declaration is located through the editor's own entry
 * list, and the editor re-serializes the whole `config` — which is exactly why
 * every key of that config has to survive the round trip.
 */

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { setDefaultPreset, switchPreset, toggleRow } from '../src/plugins/actions.ts'
import { parseComposition } from '../src/plugins/composition.ts'
import type { RowLocator } from '../src/plugins/composition.ts'
import type {
  AgentPresetRow,
  AgentPresetsSeam,
  ConfigEditorSeam,
  PluginsAgent,
  PluginsSettings,
} from '../src/plugins/harness.ts'

/**
 * The Loader's own `!!js` tag, so a conditional row resolves to the raw
 * expression the way the editor is handed it and never to a boolean.
 */
const JS_EXPR_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (source: string): { __jsExpr: string } => ({ __jsExpr: source }),
}

/** The module that declares a preset, as the editor's entry list names it. */
const PRESET_DECLARATION = '@deepseek-ai/dsh-agent-preset'

const USER_TEXT = `- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: true
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
`

/**
 * The composition as the Loader resolves it: the child list the editor holds.
 * @param text - a rendered entry list.
 * @returns the resolved child rows.
 */
function resolved(text: string): Record<string, unknown>[] {
  const parsed: unknown = parse(text, { customTags: [JS_EXPR_TAG] })
  if (!Array.isArray(parsed)) throw new Error('a composition must be a top-level list of rows')
  return parsed.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
}

/**
 * The locator of one row as the browser reports it, parsed out of the very same
 * text the editor's child list came from — so "the locator addresses this row"
 * is checked against the two real structures rather than a hand-written double.
 * @param id - the row's id.
 * @returns the locator.
 */
function locatorFor(id: string): RowLocator {
  const tree = parseComposition(USER_TEXT)
  if (tree.kind !== 'parsed') throw new Error('fixture does not parse')
  const row = tree.rows.find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`row ${id} not found`)
  return row.locator
}

/** One entry of the editor's profile rows, as this suite's fake reports it. */
interface FakeEntry {
  readonly options: { readonly id: string; readonly name: string; readonly config: Record<string, unknown> }
}

/** One persisted edit, with the whole next config the editor was handed. */
interface FakeEdit {
  readonly id: string
  readonly config: Record<string, unknown>
}

/**
 * A configuration editor over a fixed entry list, recording every config it is
 * asked to persist.
 *
 * The latest config is tracked per entry rather than written back onto the
 * entry, because the seam's own shape reports entries as read-only — and
 * because a second `edit` against the same entry must see what the first one
 * persisted, which is what makes "the change landed" observable at all.
 * @param entries - the profile rows the editor reports.
 * @returns the seam, and the edits it recorded.
 */
function editor(entries: FakeEntry[]): ConfigEditorSeam & { edits: FakeEdit[] } {
  const current = new Map(entries.map(entry => [entry.options.id, entry.options.config]))
  const edits: FakeEdit[] = []
  return {
    entries: () => entries,
    edits,
    edit: async (target, change) => {
      const existing = current.get(target.options.id)
      if (existing === undefined) throw new Error(`no config tracked for ${target.options.id}`)
      const next = change({ ...existing }, {})
      current.set(target.options.id, next)
      edits.push({ id: target.options.id, config: next })
    },
  }
}

/**
 * The editor row that declares `id`, with a child list of its own.
 * @param id - the preset id the declaration supplies.
 * @param plugins - the declaration's resolved child list.
 * @param name - the Loader entry id, which need not be the preset id.
 * @returns the entry.
 */
function declaration(id: string, plugins: Record<string, unknown>[], name = `preset-${id}`): FakeEntry {
  return { options: { id: name, name: PRESET_DECLARATION, config: { id, order: 1, plugins } } }
}

/**
 * An editor holding exactly one declaration of `id`, over the shared fixture.
 * @param id - the preset id.
 * @returns the seam and the edits it recorded.
 */
function editorFor(id: string): ReturnType<typeof editor> {
  return editor([declaration(id, resolved(USER_TEXT))])
}

describe('toggleRow', () => {
  it('locates the declaration by its own id and writes the row config back whole', async () => {
    const seam = editor([
      declaration('mine', resolved(USER_TEXT)),
      { options: { id: 'dshline', name: '@dshline/dshline', config: { theme: 'tide' } } },
    ])
    const outcome = await toggleRow(seam, 'mine', locatorFor('tool-fs'), false)
    expect(outcome).toMatchObject({ kind: 'done' })
    expect(seam.edits).toHaveLength(1)
    expect(seam.edits[0]?.id).toBe('preset-mine')
    // Every key of the row's own config survives: a partial object here would
    // reset `id` and `order` and break the declaration the editor is writing.
    expect(seam.edits[0]?.config).toEqual({
      id: 'mine',
      order: 1,
      plugins: [
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', disabled: true },
        { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: true },
        { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: { __jsExpr: "process.platform !== 'win32'" } },
      ],
    })
  })

  it('refuses a declaration this profile does not have, and never asks for a write', async () => {
    const seam = editor([{ options: { id: 'dshline', name: '@dshline/dshline', config: { theme: 'tide' } } }])
    const outcome = await toggleRow(seam, 'mine', locatorFor('tool-fs'), false)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('not an editable declaration')
    expect(seam.edits).toEqual([])
  })

  it('refuses a preset two declarations supply, rather than picking a winner', async () => {
    const seam = editor([
      declaration('mine', resolved(USER_TEXT), 'preset-mine-a'),
      declaration('mine', resolved(USER_TEXT), 'preset-mine-b'),
    ])
    const outcome = await toggleRow(seam, 'mine', locatorFor('tool-fs'), false)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('more than once')
    expect(seam.edits).toEqual([])
  })

  it('refuses a !!js conditional row and leaves the declaration exactly as it was', async () => {
    const plugins = resolved(USER_TEXT)
    const seam = editor([declaration('mine', plugins)])
    const before = structuredClone(plugins)
    const outcome = await toggleRow(seam, 'mine', locatorFor('tool-pwsh'), true)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain("process.platform !== 'win32'")
    // Nothing was persisted and nothing was mutated: the refusal is raised
    // inside the editor's own callback, so there is no partial config for it to
    // reconcile, and the condition an operator wrote on purpose is still there.
    expect(seam.edits).toEqual([])
    expect(plugins).toEqual(before)
  })

  it('enables a disabled row by dropping the field, leaving every other row alone', async () => {
    const seam = editorFor('mine')
    const outcome = await toggleRow(seam, 'mine', locatorFor('tool-bash'), true)
    expect(outcome.kind).toBe('done')
    const config = seam.edits[0]?.config
    if (config === undefined) throw new Error('expected a persisted config')
    const plugins = config['plugins']
    if (!Array.isArray(plugins)) throw new Error('expected a child list')
    expect(plugins[1]).toEqual({ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' })
    expect(plugins[0]).toEqual({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' })
  })

  it('reports a no-op when the row already holds the requested state, persisting the same config', async () => {
    const seam = editorFor('mine')
    const outcome = await toggleRow(seam, 'mine', locatorFor('tool-fs'), true)
    expect(outcome.kind).toBe('done')
    expect(outcome.message).toContain('already')
    // The config handed back is the config that was already there, so a real
    // editor has nothing to reconcile and no redundant profile patch lands.
    expect(seam.edits[0]?.config).toEqual({ id: 'mine', order: 1, plugins: resolved(USER_TEXT) })
  })

  it('refuses rather than writing when the declaration moved under the locator', async () => {
    // An external edit inserted a row above the one the browser drew, so every
    // index below it shifted. Editing that position anyway would edit a
    // different row than the one the reader was shown.
    const declared = [{ id: 'tool-workflow', name: 'workflow' }, ...resolved(USER_TEXT)]
    const seam = editor([declaration('mine', declared)])
    const before = structuredClone(declared)
    const outcome = await toggleRow(seam, 'mine', locatorFor('tool-fs'), false)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('changed')
    expect(seam.edits).toEqual([])
    expect(declared).toEqual(before)
  })

  it('reports a declaration that carries no composition to edit', async () => {
    const seam = editor([{ options: { id: 'preset-empty', name: PRESET_DECLARATION, config: { id: 'empty' } } }])
    const outcome = await toggleRow(seam, 'empty', locatorFor('tool-fs'), false)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('declares no composition')
    expect(seam.edits).toEqual([])
  })

  it("surfaces the editor's own refusal, escaped before it reaches the transcript", async () => {
    const seam: ConfigEditorSeam = {
      entries: () => [declaration('mine', resolved(USER_TEXT))],
      // A schema rejection quotes the value that failed, and Harness's own
      // refusals can quote a profile path — so the text arrives untrusted and
      // is escaped here rather than at the point of drawing.
      edit: () => Promise.reject(new Error('Configuration for "preset-mine" is overridden\u001b[31m')),
    }
    const outcome = await toggleRow(seam, 'mine', locatorFor('tool-fs'), false)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('overridden')
    expect(outcome.message).not.toContain('\u001b')
    expect(outcome.message).toContain('^[[31m')
  })
})

describe('switchPreset', () => {
  /**
   * A minimal preset seam; no roster row carries a `path` or a `trust` any
   * more, because the adopted registry publishes neither.
   * @param overrides - fields to replace on the fake seam.
   * @returns the seam.
   */
  function seamFor(overrides: Partial<AgentPresetsSeam> = {}): AgentPresetsSeam {
    const row: AgentPresetRow = { id: 'standard', name: 'Standard mode' }
    return {
      defaultId: 'standard',
      list: async () => [row],
      resolve: async id => (id === undefined ? row : { ...row, id }),
      composedPreset: () => undefined,
      mount: async (_agentCtx, id) => ({ ...row, id: id ?? row.id }),
      recompose: async (_agentCtx, id) => ({ ...row, id }),
      select: async (_agent, id) => id,
      readDocument: async agentPreset => ({ agentPreset, content: USER_TEXT }),
      ...overrides,
    }
  }

  /**
   * A live agent shape over a real detached root Session.
   * @returns the agent handed to `select`.
   */
  function agent(): PluginsAgent {
    const id = SessionId('switch-1')
    return { id, ctx: {}, session: Session.create(id) }
  }

  it('hands the switch to Harness and appends nothing of its own', async () => {
    const seen: { id: string; agentPreset: string }[] = []
    const seam = seamFor({
      select: async (a, agentPreset) => {
        seen.push({ id: String(a.id), agentPreset })
        return agentPreset
      },
      // Present so a regression that reintroduced dshline's own orchestration
      // would be visible rather than silently equivalent.
      recompose: async () => { throw new Error('switchPreset must not recompose directly') },
    })
    const a = agent()
    const outcome = await switchPreset(seam, a, 'code')
    expect(outcome.kind).toBe('done')
    expect(seen).toEqual([{ id: 'switch-1', agentPreset: 'code' }])
    // Harness owns the record; dshline writes no `agent-preset/selected`.
    expect(a.session.snapshotEvents()).toEqual([])
  })

  it('reports the preset id Harness committed, not the one requested', async () => {
    const seam = seamFor({ select: async () => 'code-resolved' })
    const outcome = await switchPreset(seam, agent(), 'code')
    expect(outcome.kind).toBe('done')
    expect(outcome.message).toContain('code-resolved')
  })

  it("surfaces Harness's refusal of a started session as the failure it is", async () => {
    const seam = seamFor({
      select: async () => { throw new Error('session "s" has already started; its agent preset is fixed') },
    })
    const outcome = await switchPreset(seam, agent(), 'code')
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('already started')
  })

  it('reports failure when the preset itself is unusable', async () => {
    const seam = seamFor({ select: async () => { throw new Error('unknown preset') } })
    const outcome = await switchPreset(seam, agent(), 'nonexistent')
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('unknown preset')
  })
})

describe('setDefaultPreset', () => {
  it('writes selectedDefault to the agent-preset-registry namespace, through update', async () => {
    const calls: { ns: string; patch: unknown; expectedRevision: number | undefined }[] = []
    const settings: PluginsSettings = {
      update: async (ns, patch, expectedRevision) => { calls.push({ ns, patch, expectedRevision }) },
    }
    const outcome = await setDefaultPreset(settings, 'standard-custom')
    expect(outcome.kind).toBe('done')
    // The registry entry's own id, and the volatile field upstream reserves for
    // the user's choice: overwriting the deployment's `default` instead would
    // edit the composition itself rather than a preference over it.
    expect(calls).toEqual([{
      ns: 'agent-preset-registry',
      patch: { selectedDefault: 'standard-custom' },
      expectedRevision: undefined,
    }])
  })

  it('reports failure with the settings seam\'s own reason', async () => {
    const settings: PluginsSettings = {
      update: async () => { throw new Error('revision conflict') },
    }
    const outcome = await setDefaultPreset(settings, 'standard-custom')
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('revision conflict')
  })
})
