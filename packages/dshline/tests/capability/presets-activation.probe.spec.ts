/**
 * Capability probe: dshline's own shipped preset declarations, activated.
 *
 * The first version of this migration hand-authored `standard` from the
 * previous generation's file and shipped it without mounting it. The published
 * consumer boot found the consequence: `tool-workflow` sat forever waiting for
 * `workflowEngine`, because the delegation group isolated a realm the preset
 * never filled. No typecheck and no unit test noticed, because a composition
 * that is merely *incomplete* is perfectly valid YAML.
 *
 * So this file mounts the real declarations this bundle ships, through the real
 * `@deepseek-ai/dsh-agent-preset-registry`, and asserts they activate. It is
 * deliberately not a static YAML check: a `grep` for `workflow-ptc` passes on
 * the broken preset too, and only a real mount tells you the realm it belongs
 * to is actually populated.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { parse } from 'yaml'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { entryListProblem, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { pathToFileURL } from 'node:url'

/**
 * The Loader's own conditional tag, so a `!!js` row parses to the raw
 * expression text rather than a warning and a stringified node. The registry
 * never evaluates it — neither does this file.
 */
const JS_EXPR_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (source: string) => source }

/** One shipped declaration file, as this bundle packs it. */
function declaration(file: string): PresetDefinition {
  const parsed: unknown = parse(
    readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'),
    { customTags: [JS_EXPR_TAG] },
  )
  if (!Array.isArray(parsed)) throw new Error(`${file} must be a top-level patch list`)
  const rows = parsed.flatMap(entry => (entry as { insert?: unknown[] }).insert ?? [])
  const row = rows.find(candidate => (candidate as { id?: string }).id === `preset-${file.includes('minimal') ? 'minimal' : 'standard'}`)
  if (row === undefined) throw new Error(`${file} declares no preset row`)
  return (row as { config: PresetDefinition }).config
}

/** Every plugin row in a declaration, flattened out of its groups. */
function rowsOf(preset: PresetDefinition, into: { id: string; name: string; group: boolean }[] = []): typeof into {
  for (const row of preset.plugins) {
    into.push({ id: row.id ?? row.name, name: row.name, group: row.group === true })
    if (row.group === true && Array.isArray(row.config)) {
      rowsOf({ ...preset, plugins: row.config as PresetDefinition['plugins'] }, into)
    }
  }
  return into
}

/**
 * Mount the real registry with one real declaration, the way this bundle's
 * composition does.
 * @param preset - the declaration to register.
 * @returns a context carrying the real services.
 */
async function activated(preset: PresetDefinition): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('loader', {} as never)
  ctx.baseUrl = `${pathToFileURL(tmpdir()).href}/`
  await ctx.plugin(AgentPresetRegistry, { default: preset.id })
  await ctx.plugin(AgentPreset, preset as never)
  return ctx
}

describe('shipped preset declarations activate', () => {
  it('accepts the standard declaration as a well-formed entry list', () => {
    const preset = declaration('../../presets/standard.patch.yml')
    expect(preset.id).toBe('standard')
    // The same validator the registry itself runs before it mounts anything, so
    // a structurally broken composition is reported here rather than as a
    // pending row three layers down.
    expect(entryListProblem(preset.plugins)).toBeUndefined()
  })

  it('accepts the minimal declaration as a well-formed entry list', () => {
    const preset = declaration('../../presets/minimal.patch.yml')
    expect(preset.id).toBe('minimal')
    expect(entryListProblem(preset.plugins)).toBeUndefined()
  })

  it('fills the workflowEngine realm its own workflow tool waits on', async () => {
    const preset = declaration('../../presets/standard.patch.yml')
    const delegation = preset.plugins.find(row => row.id === 'delegation')
    expect(delegation, 'the delegation group is what isolates workflowEngine').toBeDefined()
    expect(delegation?.group).toBe(true)
    const isolate = (delegation?.isolate ?? {}) as Record<string, boolean>
    expect(isolate['workflowEngine']).toBe(true)

    // THE regression. `tool-workflow` resolves `workflowEngine` from inside this
    // realm, so a realm with a consumer and no provider leaves the tool pending
    // forever and the preset never finishes activating. The provider has to be a
    // CHILD of the same group, not merely present somewhere in the file.
    const children = (Array.isArray(delegation?.config) ? delegation?.config : []) as { id?: string; name: string }[]
    const provider = children.find(row => row.id === 'workflow-ptc')
    expect(
      provider?.name,
      'the delegation group must carry its own workflowEngine provider, or tool-workflow stays pending',
    ).toBe('@deepseek-ai/dsh-workflow-ptc')
    expect(children.find(row => row.id === 'tool-workflow')?.name).toBe('@deepseek-ai/dsh-tool-workflow')
  })

  it('keeps the capabilities the previous terminal standard provided', () => {
    const preset = declaration('../../presets/standard.patch.yml')
    const rows = rowsOf(preset)
    const names = rows.map(row => row.name)
    // The rows the adopted generation's own standard declaration carries and a
    // terminal session has always had. Each was verified against
    // `packages/bundle/web-app/presets/standard.patch.yml` at 0.1.7-rc.2.
    for (const name of [
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-jobs',
      '@deepseek-ai/dsh-tool-skill',
      '@deepseek-ai/dsh-tool-goal',
      '@deepseek-ai/dsh-plan-mode',
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-command-compact',
      '@deepseek-ai/dsh-tool-subagent',
      '@deepseek-ai/dsh-workflow-ptc',
      '@deepseek-ai/dsh-tool-workflow',
      '@deepseek-ai/dsh-tool-ask-user',
      '@deepseek-ai/dsh-tool-todo',
      '@deepseek-ai/dsh-tool-web',
      // The deliverables surface. Its absence is invisible until a turn closes
      // with files, which is exactly the kind of regression a mount-time check
      // catches and a launch does not.
      '@deepseek-ai/dsh-tool-present',
      // Shipped disabled, but they are part of the composition's documented
      // surface: a profile that installs the provider removes `disabled`.
      '@deepseek-ai/dsh-plugin-manager/tools',
    ]) {
      expect(names, `standard must compose ${name}`).toContain(name)
    }
    // The optional delegation providers stay OFF by default, each as its own
    // row so a profile can enable one without editing the other.
    const byName = new Map(rows.map(row => [row.name, row.id]))
    expect(byName.get('@deepseek-ai/dsh-plugin-manager/tools')).toBe('tool-plugin-manager')
    const codex = preset.plugins.find(row => row.id === 'delegation')
    const delegationRows = (Array.isArray(codex?.config) ? codex?.config : []) as { id?: string }[]
    expect(delegationRows.map(row => row.id)).toContain('tool-subagent-codex')
    expect(delegationRows.map(row => row.id)).toContain('tool-subagent-claude-code')
  })

  it('registers standard on the real registry without a broken diagnostic', async () => {
    const preset = declaration('../../presets/standard.patch.yml')
    const ctx = await activated(preset)
    try {
      const resolved = await ctx.agentPresets.resolve('standard')
      expect(resolved.broken, `standard did not activate: ${resolved.broken ?? ''}`).toBeUndefined()
      const rows = await ctx.agentPresets.list()
      expect(rows.map(row => [row.id, row.broken])).toEqual([['standard', undefined]])
      expect(ctx.agentPresets.defaultId).toBe('standard')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers minimal on the real registry without a broken diagnostic', async () => {
    const preset = declaration('../../presets/minimal.patch.yml')
    const ctx = await activated(preset)
    try {
      const resolved = await ctx.agentPresets.resolve('minimal')
      expect(resolved.broken, `minimal did not activate: ${resolved.broken ?? ''}`).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
