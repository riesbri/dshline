/**
 * Parsing Harness's entry-list composition, and the one narrow edit on it.
 *
 * The fixtures below are trimmed from the real shipped `standard` preset
 * (`apps/cli/config/agent-presets/standard/agent.cordis.yml` in
 * deepseek-harness): the `!!js` platform-conditional shell tools, and the
 * `delegation` group whose `tool-subagent-codex` child ships `disabled: true`
 * with a comment telling an operator to install the provider and remove the
 * field. Round-tripping this exact shape — nested groups, `!!js`, multiline
 * block scalars — is the point: this is what a real toggle in a real preset
 * touches.
 *
 * The edit is no longer a splice of the rendered TEXT. A declaration is a
 * `@deepseek-ai/dsh-agent-preset` row in a composition, the adopted registry
 * publishes no path and "writes no declarations", and the profile
 * configuration editor re-serializes the whole `config` through the owning
 * plugin's own `Config`. So {@link togglePresetRow} operates on the RESOLVED
 * child list the Loader hands that editor, copying every row it does not touch,
 * and this suite reaches that list the way the Loader does: by parsing the very
 * same rendered text {@link parseComposition} renders rows from, which is also
 * what makes "the locator the browser reports is usable against the list the
 * editor is handed" an assertion rather than a hope.
 *
 * Comments and block-scalar formatting are not asserted on below, and cannot
 * be: they belong to the rendering, and the write path re-renders the whole
 * config. What survives a toggle is the resolved rows, which is what the Loader
 * and the browser both read.
 */

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { CompositionRow, RowLocator } from '../src/plugins/composition.ts'
import { parseComposition, togglePresetRow } from '../src/plugins/composition.ts'

/**
 * The Loader's own `!!js` tag, so a conditional resolves to the raw expression
 * the way Harness resolves it and never to a boolean.
 *
 * Mirrors the tag `composition.ts` reads with, rather than reusing it: that one
 * is module-private, and a test that could not turn a rendered fixture back into
 * the resolved list the Loader hands an editor would be asserting on a
 * structure the real write path never receives.
 */
const JS_EXPR_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (source: string): { __jsExpr: string } => ({ __jsExpr: source }),
}

/** A trimmed, realistic composition: top-level conditional rows, a multiline
 * scalar, and a nested `delegation` group with a disabled leaf. */
const FIXTURE = `# The \`standard\` agent preset (trimmed for a test fixture).
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

# \`shell\`
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: delegation
  name: cordis:group
  group: true
  config:
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent

    # Production dsh does not install these optional providers. Install the
    # matching Bundle in this Profile and restart the Host, then copy this
    # preset and remove \`disabled\` from the matching tool row.
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: codex
        toolName: subagent_codex
`

/** The full real `standard` preset's opening section, for the byte-level regression test. */
const REAL_STANDARD_EXCERPT = `# The \`standard\` agent preset: the full coding agent, mounted once per process.
#
# This file is an AGENT-PLANE composition. The roster mounts it ONCE under a
# standing scope; every session naming it joins by scope parentage, so the
# tools and prompt sections registered here cover each joined agent while a
# session's own state stays keyed per Session/Agent inside the plugins.

# ── identity ────────────────────────────────────────────────────────────────

# The preset's own persona, shadowing the deployment default for this agent.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

# ── shell ───────────────────────────────────────────────────────────────────

# \`shell-env\` stays in the HOST composition: injected to publish
# DSH_WEB_URL/DSH_WEB_MODE, and a host row that injects a service is the
# criterion for host-plane ownership.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

# ── delegation ───────────────────────────────────────────────────────────────
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable

    # Production dsh does not install these optional providers. Install the
    # matching Bundle in this Profile and restart the Host, then copy this
    # preset and remove \`disabled\` from the matching tool row. Host availability
    # alone grants no tool.
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: codex
        toolName: subagent_codex
        backgroundMode: one-shot
        maxDepth: provider-managed
`

/**
 * The composition as the Loader resolves it: the child list a configuration
 * editor is handed, derived from the same text the browser's rows are parsed
 * from so the two cannot drift apart in the assertions below.
 * @param text - a rendered entry list.
 * @returns the resolved child rows.
 */
function resolved(text: string): Record<string, unknown>[] {
  const parsed: unknown = parse(text, { customTags: [JS_EXPR_TAG] })
  if (!Array.isArray(parsed)) throw new Error('a composition must be a top-level list of rows')
  return parsed.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
}

/**
 * Find one row's locator by its display path, for use in `togglePresetRow`.
 * @param rows - the parsed rows.
 * @param path - the row's expected display path.
 * @returns the locator.
 */
function locatorFor(rows: readonly CompositionRow[], path: readonly string[]): RowLocator {
  const row = rows.find(r => r.path.length === path.length && r.path.every((segment, i) => segment === path[i]))
  if (row === undefined) throw new Error(`fixture row not found: ${path.join(' > ')}`)
  return row.locator
}

/**
 * The parsed rows of a rendered composition, for a locator.
 * @param text - the composition's rendered text.
 * @returns the flattened rows.
 */
function rowsOf(text: string): readonly CompositionRow[] {
  const tree = parseComposition(text)
  if (tree.kind !== 'parsed') throw new Error('expected parsed')
  return tree.rows
}

describe('parseComposition: recursive traversal', () => {
  it('flattens top-level and nested rows in document order with display paths', () => {
    const tree = parseComposition(FIXTURE)
    expect(tree.kind).toBe('parsed')
    if (tree.kind !== 'parsed') return
    expect(tree.rows.map(row => row.path)).toEqual([
      ['persona'],
      ['tool-bash'],
      ['tool-pwsh'],
      ['tool-fs'],
      ['delegation'],
      ['delegation', 'tool-subagent'],
      ['delegation', 'tool-subagent-codex'],
    ])
  })

  it('reports depth and group correctly for nested rows', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const delegation = tree.rows.find(row => row.id === 'delegation')
    const codex = tree.rows.find(row => row.id === 'tool-subagent-codex')
    expect(delegation?.group).toBe(true)
    expect(delegation?.depth).toBe(0)
    expect(codex?.group).toBe(false)
    expect(codex?.depth).toBe(1)
    expect(codex?.path).toEqual(['delegation', 'tool-subagent-codex'])
  })

  it('carries the row name (module specifier) through', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const codex = tree.rows.find(row => row.id === 'tool-subagent-codex')
    expect(codex?.name).toBe('@deepseek-ai/dsh-tool-subagent')
  })
})

describe('parseComposition: id is optional, matching Harness\'s own validator exactly', () => {
  it('accepts a valid top-level row with no id at all', () => {
    const tree = parseComposition('- name: "@deepseek-ai/dsh-tool-fs"\n')
    expect(tree.kind).toBe('parsed')
    if (tree.kind !== 'parsed') return
    expect(tree.rows).toHaveLength(1)
    expect(tree.rows[0]?.id).toBeUndefined()
    expect(tree.rows[0]?.name).toBe('@deepseek-ai/dsh-tool-fs')
  })

  it('falls back to name for the display path of an id-less row', () => {
    const tree = parseComposition('- name: "@deepseek-ai/dsh-tool-fs"\n')
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows[0]?.path).toEqual(['@deepseek-ai/dsh-tool-fs'])
  })

  it('accepts a valid nested id-less row inside a group', () => {
    const tree = parseComposition(`- id: delegation
  name: cordis:group
  group: true
  config:
    - name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
`)
    expect(tree.kind).toBe('parsed')
    if (tree.kind !== 'parsed') return
    const child = tree.rows.find(row => row.name === '@deepseek-ai/dsh-tool-subagent')
    expect(child?.id).toBeUndefined()
    expect(child?.path).toEqual(['delegation', '@deepseek-ai/dsh-tool-subagent'])
    expect(child?.disabled).toEqual({ kind: 'disabled' })
  })

  it('still rejects a row with no name, id or not', () => {
    expect(parseComposition('- id: tool-fs\n').kind).toBe('broken')
    expect(parseComposition('- {}\n').kind).toBe('broken')
  })

  it('accepts duplicate ids across different rows without treating the file as broken', () => {
    const tree = parseComposition(`- id: tool-a
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-a
  name: '@deepseek-ai/dsh-tool-bash'
`)
    expect(tree.kind).toBe('parsed')
    if (tree.kind !== 'parsed') return
    expect(tree.rows.map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-bash',
    ])
  })
})

describe('parseComposition: tri-state disabled', () => {
  it('models a row with no disabled field as enabled', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const fs = tree.rows.find(row => row.id === 'tool-fs')
    expect(fs?.disabled).toEqual({ kind: 'enabled' })
    expect(fs?.effective).toBe('enabled')
  })

  it('models a literal disabled: true row as disabled, without evaluating anything', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const codex = tree.rows.find(row => row.id === 'tool-subagent-codex')
    expect(codex?.disabled).toEqual({ kind: 'disabled' })
  })

  it('models a !!js row as conditional, carrying the raw expression and never evaluating it', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const bash = tree.rows.find(row => row.id === 'tool-bash')
    const pwsh = tree.rows.find(row => row.id === 'tool-pwsh')
    expect(bash?.disabled).toEqual({ kind: 'conditional', expression: "process.platform === 'win32'" })
    expect(pwsh?.disabled).toEqual({ kind: 'conditional', expression: "process.platform !== 'win32'" })
    expect(bash?.effective).toBe('conditional')
  })
})

describe('parseComposition: ancestor inheritance', () => {
  const NESTED_DISABLED_GROUP = `- id: delegation
  name: cordis:group
  group: true
  disabled: true
  config:
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
`
  it('always reports a group row itself as effectively enabled, even when its own field is disabled', () => {
    const tree = parseComposition(NESTED_DISABLED_GROUP)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const delegation = tree.rows.find(row => row.id === 'delegation')
    expect(delegation?.disabled).toEqual({ kind: 'disabled' })
    expect(delegation?.effective).toBe('enabled')
  })

  it('propagates a disabled ancestor group to a leaf whose own field stays enabled', () => {
    const tree = parseComposition(NESTED_DISABLED_GROUP)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const codex = tree.rows.find(row => row.id === 'tool-subagent-codex')
    expect(codex?.disabled).toEqual({ kind: 'enabled' })
    expect(codex?.effective).toBe('disabled')
  })

  const NESTED_CONDITIONAL_GROUP = `- id: delegation
  name: cordis:group
  group: true
  disabled: !!js process.env.DELEGATION === 'off'
  config:
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
`
  it('combines a conditional ancestor with a literally disabled leaf as disabled (literal wins)', () => {
    const tree = parseComposition(NESTED_CONDITIONAL_GROUP)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const codex = tree.rows.find(row => row.id === 'tool-subagent-codex')
    expect(codex?.effective).toBe('disabled')
  })

  it('reports conditional for a leaf under a conditional ancestor with no other blocker', () => {
    const tree = parseComposition(`- id: delegation
  name: cordis:group
  group: true
  disabled: !!js process.env.DELEGATION === 'off'
  config:
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const child = tree.rows.find(row => row.id === 'tool-subagent')
    expect(child?.disabled).toEqual({ kind: 'enabled' })
    expect(child?.effective).toBe('conditional')
  })
})

describe('parseComposition: config summaries are bounded', () => {
  it('summarizes a small plain-scalar config object', () => {
    const tree = parseComposition(`- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows[0]?.configSummary).toBe('provider=spawn, toolName=subagent')
  })

  it('summarizes a plain scalar config directly', () => {
    const tree = parseComposition(`- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config: 65536
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows[0]?.configSummary).toBe('65536')
  })

  it('normalizes whitespace and caps a realistic long persona/prompt block scalar', () => {
    const longPrompt = 'You are a coding agent powered by the {{model}} model. '
      + 'Your working directory is {{cwd}}. Follow the plan exactly, never skip a step, '
      + 'and always verify your changes build and pass tests before reporting completion.'
    const tree = parseComposition(`- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      ${longPrompt}
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const summary = tree.rows[0]?.configSummary
    expect(summary).toBeDefined()
    expect(summary?.length).toBeLessThanOrEqual(100)
    expect(summary?.endsWith('…')).toBe(true)
    // Never a raw multi-line dump: no newline survives into the summary.
    expect(summary?.includes('\n')).toBe(false)
  })

  it('never computes a summary for a group row', () => {
    const tree = parseComposition(FIXTURE)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    const delegation = tree.rows.find(row => row.id === 'delegation')
    expect(delegation?.configSummary).toBeUndefined()
  })

  it('omits a summary for a nested config object', () => {
    const tree = parseComposition(`- id: tool-subagent-fork
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
    nested:
      deeper: true
`)
    if (tree.kind !== 'parsed') throw new Error('expected parsed')
    expect(tree.rows[0]?.configSummary).toBeUndefined()
  })
})

describe('parseComposition: broken/malformed input never throws', () => {
  it('reports broken when the top level is not a list', () => {
    const tree = parseComposition('just: a mapping\n')
    expect(tree.kind).toBe('broken')
  })

  it('reports broken when an entry has no name', () => {
    const tree = parseComposition('- id: tool-fs\n')
    expect(tree.kind).toBe('broken')
  })

  it('reports broken when a group has no nested list', () => {
    const tree = parseComposition('- id: g\n  name: cordis:group\n  group: true\n')
    expect(tree.kind).toBe('broken')
  })

  it('reports broken rather than throwing on invalid YAML syntax', () => {
    expect(() => parseComposition('- id: [unterminated\n')).not.toThrow()
    expect(parseComposition('- id: [unterminated\n').kind).toBe('broken')
  })

  it('reports broken on an empty file', () => {
    expect(parseComposition('').kind).toBe('broken')
  })

  it('reports broken on a comments-only file', () => {
    expect(parseComposition('# nothing here\n').kind).toBe('broken')
  })
})

describe('togglePresetRow: the narrow edit, on a real composition', () => {
  it('enables a disabled leaf by dropping only its own disabled field', () => {
    const plugins = resolved(FIXTURE)
    const result = togglePresetRow(plugins, locatorFor(rowsOf(FIXTURE), ['delegation', 'tool-subagent-codex']), true)
    expect(result).toMatchObject({ ok: true, changed: true })
    if (!result.ok) return
    const group = (result.plugins[4] as { config: Record<string, unknown>[] }).config
    expect(group[1]).toEqual({
      id: 'tool-subagent-codex',
      name: '@deepseek-ai/dsh-tool-subagent',
      config: { provider: 'codex', toolName: 'subagent_codex' },
    })
    // A `!!js` row is untouched and still carries its unresolved condition: the
    // enable case is the ABSENCE of the field, which is how the shipped
    // declarations themselves read, and writing `disabled: false` would say
    // something true in a shape nobody writes by hand.
    expect(result.plugins[1]).toEqual({
      id: 'tool-bash',
      name: '@deepseek-ai/dsh-tool-bash',
      disabled: { __jsExpr: "process.platform === 'win32'" },
    })
  })

  it('disables an enabled leaf, leaving the persona block and every other row alone', () => {
    const plugins = resolved(FIXTURE)
    const result = togglePresetRow(plugins, locatorFor(rowsOf(FIXTURE), ['tool-fs']), false)
    expect(result).toMatchObject({ ok: true, changed: true })
    if (!result.ok) return
    expect(result.plugins[3]).toEqual({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', disabled: true })
    expect((result.plugins[0] as { config: { text: string } }).config.text)
      .toContain('You are a coding agent powered by the {{model}} model')
  })

  it('rebuilds only the path to a toggled nested row, leaving the group’s siblings alone', () => {
    const plugins = resolved(FIXTURE)
    const result = togglePresetRow(plugins, locatorFor(rowsOf(FIXTURE), ['delegation', 'tool-subagent']), false)
    expect(result).toMatchObject({ ok: true, changed: true })
    if (!result.ok) return
    const group = (result.plugins[4] as { name: string; group: boolean; config: Record<string, unknown>[] })
    expect(group.name).toBe('cordis:group')
    expect(group.group).toBe(true)
    expect(group.config).toHaveLength(2)
    expect(group.config[0]).toEqual({
      id: 'tool-subagent',
      name: '@deepseek-ai/dsh-tool-subagent',
      disabled: true,
      config: { provider: 'spawn', toolName: 'subagent' },
    })
    expect(group.config[1]).toEqual({
      id: 'tool-subagent-codex',
      name: '@deepseek-ai/dsh-tool-subagent',
      disabled: true,
      config: { provider: 'codex', toolName: 'subagent_codex' },
    })
    // The row above the group is the same object, not a copy of itself.
    expect(result.plugins[3]).toBe(plugins[3])
  })

  it('toggles an id-less row, addressed by structural locator alone', () => {
    const text = `- name: '@deepseek-ai/dsh-tool-bash'
- name: '@deepseek-ai/dsh-tool-fs'
  disabled: true
`
    const plugins = resolved(text)
    const target = rowsOf(text).find(row => row.name === '@deepseek-ai/dsh-tool-fs')
    if (target === undefined) throw new Error('fixture row not found')
    const result = togglePresetRow(plugins, target.locator, true)
    expect(result).toMatchObject({ ok: true, changed: true })
    if (!result.ok) return
    // `id` is optional to Harness and is not guaranteed unique where present, so
    // the locator corroborates on `name` alone and the neighbouring row is left
    // alone by position rather than by name.
    expect(result.plugins[1]).toEqual({ name: '@deepseek-ai/dsh-tool-fs' })
    expect(result.plugins[0]).toBe(plugins[0])
  })

  it('refuses a !!js conditional row, naming the expression it will not discard', () => {
    const result = togglePresetRow(resolved(FIXTURE), locatorFor(rowsOf(FIXTURE), ['tool-bash']), true)
    expect(result).toMatchObject({ ok: false, reason: 'conditional' })
    if (result.ok) return
    expect(result.message).toContain("process.platform === 'win32'")
  })

  it('refuses without touching the list it was handed', () => {
    const plugins = resolved(FIXTURE)
    const before = structuredClone(plugins)
    const result = togglePresetRow(plugins, locatorFor(rowsOf(FIXTURE), ['tool-pwsh']), false)
    expect(result).toMatchObject({ ok: false, reason: 'conditional' })
    // A refusal yields no list at all and nothing about the input changed, so
    // the editor is never handed a partial config to persist.
    expect(plugins).toEqual(before)
  })

  it('reports not-found for a locator index that no longer exists', () => {
    const result = togglePresetRow(resolved(FIXTURE), { steps: [{ index: 99, name: 'nope', id: undefined }] }, true)
    expect(result).toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('reports changed, not a silent wrong-row edit, when the declaration was reordered', () => {
    const plugins = resolved(FIXTURE)
    const staleLocator = locatorFor(rowsOf(FIXTURE), ['tool-fs'])
    // Simulate an external edit: a new row is prepended, shifting every index by
    // one, so the locator's index-3 step no longer names tool-fs. A name match
    // would still have found it; the index is what makes the edit refuse.
    const shifted = [{ id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' }, ...plugins]
    const result = togglePresetRow(shifted, staleLocator, true)
    expect(result).toMatchObject({ ok: false, reason: 'changed' })
    expect(shifted[0]).toEqual({ id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' })
  })

  it('returns the input list itself — unserialized — when a row already holds the requested state', () => {
    const plugins = resolved(FIXTURE)
    const on = togglePresetRow(plugins, locatorFor(rowsOf(FIXTURE), ['tool-fs']), true)
    expect(on).toMatchObject({ ok: true, changed: false })
    if (on.ok) expect(on.plugins).toBe(plugins)
    const off = togglePresetRow(plugins, locatorFor(rowsOf(FIXTURE), ['delegation', 'tool-subagent-codex']), false)
    expect(off).toMatchObject({ ok: true, changed: false })
    if (off.ok) expect(off.plugins).toBe(plugins)
  })

  it('regression: toggling one row in the real standard excerpt leaves every unrelated row intact', () => {
    const plugins = resolved(REAL_STANDARD_EXCERPT)
    const result = togglePresetRow(
      plugins,
      locatorFor(rowsOf(REAL_STANDARD_EXCERPT), ['delegation', 'tool-subagent-codex']),
      true,
    )
    expect(result).toMatchObject({ ok: true, changed: true })
    if (!result.ok) return
    const delegation = result.plugins[4] as { isolate: unknown; config: Record<string, unknown>[] }
    const codex = delegation.config[2] as { disabled?: unknown; config: Record<string, unknown> }
    expect(codex.disabled).toBeUndefined()
    // Unrelated `!!js` conditionals survive verbatim, as unresolved expressions.
    expect(result.plugins[2]).toMatchObject({ id: 'tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } })
    expect(result.plugins[3]).toMatchObject({ id: 'tool-pwsh', disabled: { __jsExpr: "process.platform !== 'win32'" } })
    // The persona's folded block scalar survives as the one line it always was.
    expect((result.plugins[0] as { config: { text: string } }).config.text)
      .toContain('You are a coding agent powered by the {{model}} model')
    // The isolate map, the untouched sibling rows, and the sibling configs the
    // editor validates all survive.
    expect(delegation.isolate).toEqual({ workflowEngine: true })
    expect(delegation.config[0]).toEqual({
      id: 'tool-subagent-control',
      name: '@deepseek-ai/dsh-tool-subagent-control',
    })
    expect((result.plugins[1] as { config: { maxBytes: number } }).config.maxBytes).toBe(65536)
    expect((delegation.config[1] as { config: Record<string, unknown> }).config.backgroundMode).toBe('continuable')
    expect(codex.config).toEqual({
      provider: 'codex',
      toolName: 'subagent_codex',
      backgroundMode: 'one-shot',
      maxDepth: 'provider-managed',
    })
  })
})
