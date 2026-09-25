/**
 * The preset composition row toggle, on the adopted generation's persistence
 * path.
 *
 * This is the one `/plugins` write that outlived the migration, and it changed
 * owner rather than disappearing. The previous generation's roster was a
 * directory of `agent.cordis.yml` files, so the edit was a lock-coordinated
 * splice of one `disabled` field in a file this frontend could name by path.
 * The adopted registry publishes no path, "accepts no preset paths", and its
 * own preset tree overrides `write()` to a no-op because "only the profile
 * configuration editor persists definitions" — so the same edit is now a
 * profile-layer override written by `ctx.configEditor` against a declaration
 * located through Harness's own entry list.
 *
 * The tests below cover the three things that makes a real difference:
 * the locator still refuses a declaration that moved, a shipped row is
 * overridden rather than modified, and a `!!js` conditional is still refused.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { parseComposition, togglePresetRow } from '../src/plugins/composition.ts'
import type { RowLocator } from '../src/plugins/composition.ts'
import { toggleRow } from '../src/plugins/actions.ts'
import type { ConfigEditorSeam } from '../src/plugins/harness.ts'

/** The Loader's own conditional tag, so `!!js` parses as raw expression text. */
const JS_EXPR_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (source: string) => source }

/** The shipped standard declaration, as this bundle packs it. */
function shippedStandard(): { id: string; plugins: unknown[] } {
  const text = readFileSync(fileURLToPath(new URL('../presets/standard.patch.yml', import.meta.url)), 'utf8')
  const parsed: unknown = parse(text, { customTags: [JS_EXPR_TAG] })
  if (!Array.isArray(parsed)) throw new Error('standard.patch.yml must be a top-level patch list')
  const rows = parsed.flatMap(entry => (entry as { insert?: unknown[] }).insert ?? [])
  const row = rows.find(candidate => (candidate as { id?: string }).id === 'preset-standard')
  if (row === undefined) throw new Error('standard.patch.yml declares no preset row')
  return (row as { config: { id: string; plugins: unknown[] } }).config
}

/** The locator of one rendered row, addressed by its display path. */
function locatorOf(tree: { rows: readonly { path: readonly string[]; locator: RowLocator }[] }, path: string): RowLocator {
  const row = tree.rows.find(candidate => candidate.path.join(' > ') === path)
  if (row === undefined) throw new Error(`no rendered row at ${path}`)
  return row.locator
}

/**
 * One parsed declaration's rows, rendered the way the registry renders them.
 *
 * `readDocument()` hands `/plugins` the declared child list as entry-list YAML,
 * and that rendered text is what carries the locators the toggle is addressed
 * by. So the rows under test are parsed from the real shipped declaration
 * through that same path, not from a hand-written fixture that happens to look
 * like it.
 */
function rendered(): ReturnType<typeof parseComposition> {
  const tree = parseComposition(stringify(shippedStandard().plugins, { lineWidth: 0 }))
  if (tree.kind !== 'parsed') throw new Error(`the shipped declaration did not parse: ${tree.reason}`)
  return tree
}

describe('preset composition row toggle', () => {
  it('addresses a row nested inside a group by a locator the rendered rows report', () => {
    const tree = rendered()
    if (tree.kind !== 'parsed') throw new Error('unreachable')
    // The path is a display breadcrumb, and the locator is a structural one;
    // they agree here, and the toggle is addressed by the second so a rename
    // cannot silently move the edit onto a neighbouring row.
    const locator = locatorOf(tree, 'delegation > workflow-ptc')
    expect(locator.steps).toEqual([
      { index: expect.any(Number), name: 'cordis:group', id: 'delegation' },
      { index: expect.any(Number), name: '@deepseek-ai/dsh-workflow-ptc', id: 'workflow-ptc' },
    ])
    // And the locator is usable against the declaration the browser rendered.
    const plugins = shippedStandard().plugins
    const result = togglePresetRow(plugins, locator, false)
    expect(result).toMatchObject({ ok: true })
  })
})

describe('togglePresetRow on the resolved child list', () => {
  it('disables a row by writing one field, and enables it by dropping the field', () => {
    const plugins = [{ id: 'a', name: 'pkg-a' }, { id: 'b', name: 'pkg-b', disabled: true }]
    const off = togglePresetRow(plugins, { steps: [{ index: 0, name: 'pkg-a', id: 'a' }] }, false)
    expect(off.ok).toBe(true)
    if (!off.ok) return
    expect(off.changed).toBe(true)
    expect(off.plugins).toEqual([{ id: 'a', name: 'pkg-a', disabled: true }, plugins[1]])

    const on = togglePresetRow(plugins, { steps: [{ index: 1, name: 'pkg-b', id: 'b' }] }, true)
    expect(on.ok).toBe(true)
    if (!on.ok) return
    // The enabled form is the ABSENCE of the field, which is what the shipped
    // declarations themselves read as; writing `disabled: false` would say
    // something true in a shape nobody writes by hand.
    expect(on.plugins).toEqual([plugins[0], { id: 'b', name: 'pkg-b' }])
  })

  it('copies every row it does not touch, so an unknown field survives', () => {
    const plugins = [
      { id: 'a', name: 'pkg-a', config: { nested: { deep: 1 } }, futureField: 'kept' },
      { id: 'b', name: 'pkg-b' },
    ]
    const result = togglePresetRow(plugins, { steps: [{ index: 1, name: 'pkg-b', id: 'b' }] }, false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plugins[0]).toBe(plugins[0])
    expect((result.plugins[0] as { futureField: string }).futureField).toBe('kept')
  })

  it('reports no change when the row is already in the requested state', () => {
    const plugins = [{ id: 'a', name: 'pkg-a' }]
    const result = togglePresetRow(plugins, { steps: [{ index: 0, name: 'pkg-a', id: 'a' }] }, true)
    expect(result).toMatchObject({ ok: true, changed: false })
  })

  it('refuses a conditional row rather than discarding the expression', () => {
    const plugins = [{ id: 'a', name: 'pkg-a', disabled: { __jsExpr: "process.platform === 'win32'" } }]
    const result = togglePresetRow(plugins, { steps: [{ index: 0, name: 'pkg-a', id: 'a' }] }, false)
    expect(result).toMatchObject({ ok: false, reason: 'conditional' })
  })

  it('refuses a declaration that moved under the locator', () => {
    const plugins = [{ id: 'a', name: 'pkg-a' }, { id: 'b', name: 'pkg-b' }]
    const result = togglePresetRow(plugins, { steps: [{ index: 0, name: 'pkg-b', id: 'b' }] }, false)
    expect(result).toMatchObject({ ok: false, reason: 'changed' })
  })

  it('refuses a locator pointing past the end of the list', () => {
    const plugins = [{ id: 'a', name: 'pkg-a' }]
    const result = togglePresetRow(plugins, { steps: [{ index: 4, name: 'pkg-x', id: 'x' }] }, false)
    expect(result).toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('descends into a group and refuses a row that is no longer a group', () => {
    const nested = [{ id: 'inner', name: 'pkg-inner' }]
    const plugins = [{ id: 'g', name: 'cordis:group', group: true, isolate: { thing: true }, config: nested }]
    const ok = togglePresetRow(plugins, { steps: [
      { index: 0, name: 'cordis:group', id: 'g' },
      { index: 0, name: 'pkg-inner', id: 'inner' },
    ] }, false)
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    const group = ok.plugins[0] as { config: { id: string; name: string; disabled: boolean }[] }
    expect(group.config[0]).toMatchObject({ id: 'inner', disabled: true })
    // The group row's own fields are carried through whole.
    expect((ok.plugins[0] as { isolate: unknown }).isolate).toEqual({ thing: true })

    const noLongerGroup = togglePresetRow([{ id: 'g', name: 'cordis:group' }], { steps: [
      { index: 0, name: 'cordis:group', id: 'g' },
      { index: 0, name: 'pkg-inner', id: 'inner' },
    ] }, false)
    expect(noLongerGroup).toMatchObject({ ok: false, reason: 'changed' })
  })
})

describe('toggleRow through the configuration editor', () => {
  /** One entry as `ConfigEditor.entries()` reports it. */
  function entry(id: string, name: string, config: unknown) {
    return { options: { id, name, config } }
  }

  /** A seam over a fixed entry list, recording every edit it is asked to make. */
  function editor(entries: ReturnType<typeof entry>[]): ConfigEditorSeam & { edits: { id: string; config: Record<string, unknown> }[] } {
    const edits: { id: string; config: Record<string, unknown> }[] = []
    return {
      entries: () => entries,
      edits,
      edit: async (target, change) => {
        const current = (target.options.config ?? {}) as Record<string, unknown>
        const next = change({ ...current }, {})
        edits.push({ id: target.options.id, config: next })
        target.options.config = next
      },
    }
  }

  it('locates the declaration by its own id and writes a full config', async () => {
    const plugins = [{ id: 'a', name: 'pkg-a' }]
    const seam = editor([
      entry('preset-standard', '@deepseek-ai/dsh-agent-preset', { id: 'standard', order: 1, plugins }),
      entry('dshline', '@dshline/dshline', { theme: 'tide' }),
    ])
    const outcome = await toggleRow(seam, 'standard', { steps: [{ index: 0, name: 'pkg-a', id: 'a' }] }, false)
    expect(outcome).toMatchObject({ kind: 'done' })
    expect(seam.edits).toHaveLength(1)
    expect(seam.edits[0]?.id).toBe('preset-standard')
    // Every key of the row's own config survives; a partial object would reset
    // `id` and `order` and break the declaration.
    expect(seam.edits[0]?.config).toEqual({ id: 'standard', order: 1, plugins: [{ id: 'a', name: 'pkg-a', disabled: true }] })
  })

  it('refuses when no row declares that preset', async () => {
    const seam = editor([entry('dshline', '@dshline/dshline', {})])
    const outcome = await toggleRow(seam, 'standard', { steps: [{ index: 0, name: 'pkg-a', id: 'a' }] }, false)
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect(seam.edits).toHaveLength(0)
  })

  it('refuses when two rows declare the same preset', async () => {
    const seam = editor([
      entry('preset-standard-a', '@deepseek-ai/dsh-agent-preset', { id: 'standard', plugins: [] }),
      entry('preset-standard-b', '@deepseek-ai/dsh-agent-preset', { id: 'standard', plugins: [] }),
    ])
    const outcome = await toggleRow(seam, 'standard', { steps: [{ index: 0, name: 'pkg-a', id: 'a' }] }, false)
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect(outcome.message).toContain('more than once')
    expect(seam.edits).toHaveLength(0)
  })

  it('reports the toggle refusal rather than writing a partial config', async () => {
    const seam = editor([
      entry('preset-standard', '@deepseek-ai/dsh-agent-preset', {
        id: 'standard',
        plugins: [{ id: 'a', name: 'pkg-a', disabled: { __jsExpr: 'true' } }],
      }),
    ])
    const outcome = await toggleRow(seam, 'standard', { steps: [{ index: 0, name: 'pkg-a', id: 'a' }] }, false)
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect(outcome.message).toContain('condition')
    expect(seam.edits).toHaveLength(0)
  })

  it('surfaces the editor’s own refusal, escaped', async () => {
    const seam: ConfigEditorSeam = {
      entries: () => [entry('preset-standard', '@deepseek-ai/dsh-agent-preset', { id: 'standard', plugins: [{ id: 'a', name: 'pkg-a' }] })],
      edit: () => Promise.reject(new Error('Configuration for "preset-standard" is overridden by a home patch')),
    }
    const outcome = await toggleRow(seam, 'standard', { steps: [{ index: 0, name: 'pkg-a', id: 'a' }] }, false)
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect(outcome.message).toContain('overridden by a home patch')
  })
})
