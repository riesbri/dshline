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

/**
 * The one adopted Harness version, read from `HARNESS_TARGET` rather than
 * written here — a literal would be a second place to update on a migration,
 * and `tools/harness-target.mjs` already owns that comparison.
 */
const HARNESS_VERSION = /^version (?<version>\S+)$/mu
  .exec(readFileSync(fileURLToPath(new URL('../../../../HARNESS_TARGET', import.meta.url)), 'utf8'))
  ?.groups?.version

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

/**
 * The dedicated `skill-harness-authoring` row: the three first-party Cordis
 * authoring skills `@deepseek-ai/dsh-agent-preset` ships, contributed by this
 * preset as baseline knowledge rather than as a root a person configured.
 *
 * Upstream's own `standard` has neither row beyond the bare ordinary provider;
 * upstream's `cordis` (Creator) preset reaches the same three skills by adding a
 * `customSkillDirs` entry to ITS single provider. dshline takes the skills and
 * not Creator's capabilities, and represents them the way the adopted Harness
 * generation models package-owned skills: a second, isolated provider instance
 * whose only root is a `bundledSkillDir`, so the registry resolves them as
 * `source: bundled` at rank 600 with a Host-trusted read.
 *
 * These assertions exist so a later Harness migration treats the row as a
 * decision rather than deleting it as drift, and so an edit that quietly turns
 * this into full Creator mode — or that quietly reverts it to a `customSkillDirs`
 * entry, which changes precedence and the source the UI reports — fails here.
 *
 * Structural only. That the expression resolves to the installed package, and
 * that the real provider then serves those three skills and loses every name a
 * project or user root claims, is `preset-skills.probe.spec.ts`'s job; a string
 * check cannot stand in for it.
 */
describe('shipped standard: the harness-authoring skill provider', () => {
  /** The config block of one row, typed only as far as these cases read it. */
  function configOf(preset: PresetDefinition, id: string): Record<string, unknown> {
    const row = preset.plugins.find(candidate => candidate.id === id)
    if (row === undefined) throw new Error(`standard declares no ${id} row`)
    return (row.config ?? {}) as Record<string, unknown>
  }

  it('leaves the ordinary skill-filesystem row exactly as upstream states it', () => {
    // Bare. This row owns the project and user roots AND the deployment's own
    // bundled channel, and a person who configures nothing must get upstream's
    // provider untouched. Configuring it here is what the previous shape of this
    // work did, and it is precisely what no longer happens.
    const rows = rowsOf(declaration('../../presets/standard.patch.yml')).filter(row => row.id === 'skill-filesystem')
    expect(rows, 'a second instance under this id would be ambiguous in /plugins').toHaveLength(1)
    expect(rows[0]?.name).toBe('@deepseek-ai/dsh-skill-filesystem')
    const config = configOf(declaration('../../presets/standard.patch.yml'), 'skill-filesystem')
    expect(config, 'the ordinary provider must keep its upstream defaults intact').toEqual({})
  })

  it('declares exactly one dedicated authoring row, and it is the same Harness provider', () => {
    const rows = rowsOf(declaration('../../presets/standard.patch.yml'))
      .filter(row => row.id === 'skill-harness-authoring')
    expect(rows, 'a second instance would register the same root twice').toHaveLength(1)
    // Not a dshline package: the row is the ordinary provider, configured.
    expect(rows[0]?.name).toBe('@deepseek-ai/dsh-skill-filesystem')
  })

  it('gives that provider its own name, because a scope holds one provider per name', () => {
    const config = configOf(declaration('../../presets/standard.patch.yml'), 'skill-harness-authoring')
    // A second instance left on the shipped `filesystem` default cannot register
    // at all: the layer throws `a skill provider named "filesystem" is already
    // registered in this scope`, so the whole preset would fail to activate
    // rather than degrade. This is load-bearing, not a label.
    expect(config['providerName']).toBe('harness-authoring')
    // And it must differ from the ordinary row's name, which is the default.
    const ordinary = configOf(declaration('../../presets/standard.patch.yml'), 'skill-filesystem')
    expect(config['providerName']).not.toBe(ordinary['providerName'])
  })

  it('isolates it from the ordinary roots, so it contributes exactly one root', () => {
    const config = configOf(declaration('../../presets/standard.patch.yml'), 'skill-harness-authoring')
    // Without this the row would be a second copy of the ordinary provider:
    // every project and user skill discovered twice, from two providers, which
    // is a duplication bug rather than an addition.
    expect(config['includeDefaultRoots']).toBe(false)
  })

  it('points bundledSkillDir at the installed agent-preset skills directory', () => {
    const config = configOf(declaration('../../presets/standard.patch.yml'), 'skill-harness-authoring')
    const expression = config['bundledSkillDir']
    expect(typeof expression, 'bundledSkillDir is required, not optional').toBe('string')
    // A `!!js` value is source text, so its exact form is the declaration. The
    // resolution is verified for real in `preset-skills.probe.spec.ts`; what is
    // pinned here is that it reaches the PACKAGE rather than a hard-coded path,
    // because a literal `node_modules` spelling breaks in a pnpm store and in a
    // published bundle alike.
    expect(expression as string).toContain("createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')")
    expect(expression as string).toMatch(/'skills'\)?$/)
  })

  it('uses bundledSkillDir rather than customSkillDirs, because the semantics differ', () => {
    const config = configOf(declaration('../../presets/standard.patch.yml'), 'skill-harness-authoring')
    // `bundledSkillDir` gives `source: bundled`, rank 600, and a Host-trusted
    // read. `customSkillDirs` would give `source: custom` at rank 300 — ABOVE
    // both user roots, so a home skill of the same name would lose to the
    // shipped copy. That is the wrong answer for package-owned baseline skills,
    // and it would also mislabel them in `/skills`.
    expect(config['customSkillDirs'], 'a custom root is neither bundled nor last-resort').toBeUndefined()
  })

  it('keeps the skill tool that serves the merged catalog to the agent', () => {
    const rows = rowsOf(declaration('../../presets/standard.patch.yml'))
    const tool = rows.find(row => row.id === 'tool-skill')
    expect(tool?.name).toBe('@deepseek-ai/dsh-tool-skill')
    expect(tool?.group).toBe(false)
  })

  it('does NOT become the Creator preset: no tool-cordis row exists', () => {
    // Skills exposed is not Creator tools enabled. `dsh-tool-cordis` supplies
    // `cordis_inspect_list` and `cordis_inspect_query`, and enabling it is a
    // separate decision this feature explicitly does not take. Note the
    // direction of the relationship: `tool-cordis` does not load these skills —
    // `skill-filesystem` discovers them and `tool-skill` loads them. Creator
    // mounts `tool-cordis` because ITS workflow needs that capability.
    const rows = rowsOf(declaration('../../presets/standard.patch.yml'))
    expect(rows.map(row => row.name)).not.toContain('@deepseek-ai/dsh-tool-cordis')
    expect(rows.map(row => row.id)).not.toContain('tool-cordis')
  })

  it('leaves tool-plugin-manager disabled in the standard preset', () => {
    const preset = declaration('../../presets/standard.patch.yml')
    const row = preset.plugins.find(candidate => candidate.id === 'tool-plugin-manager')
    expect(row?.name, 'the row stays, so a profile can still enable it deliberately').toBe('@deepseek-ai/dsh-plugin-manager/tools')
    expect(row?.disabled, 'plugin management is a human action taken through /profiles').toBe(true)
  })

  it('leaves minimal alone: minimal is not a second way to get the packaged skills', () => {
    // `minimal` exists to be switched TO, not tuned. The authoring provider there
    // would make the deliberately small preset carry three Cordis skills a person
    // never asked for, and would spread one decision across two presets.
    const rows = rowsOf(declaration('../../presets/minimal.patch.yml'))
    expect(rows.filter(row => row.id === 'skill-filesystem')).toHaveLength(1)
    expect(rows.map(row => row.id)).not.toContain('skill-harness-authoring')
    const config = configOf(declaration('../../presets/minimal.patch.yml'), 'skill-filesystem')
    expect(config['bundledSkillDir']).toBeUndefined()
    expect(config['customSkillDirs']).toBeUndefined()
  })

  it('ships the package whose skills it exposes as a runtime dependency, not a new one', () => {
    // The `!!js` expression resolves `@deepseek-ai/dsh-agent-preset` from the
    // composition, so the row only works if the package is really installed —
    // which it already was, because this bundle composes the preset itself.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['@deepseek-ai/dsh-agent-preset']).toBe(HARNESS_VERSION)
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-agent-preset']).toBeUndefined()
  })
})
