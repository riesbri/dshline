/**
 * `cordis.patch.yml`: the agent plane moves behind agent presets exactly
 * once, never twice.
 *
 * This is dshline's own shipped composition, not a fixture — a regression
 * here means a fresh install gets it wrong. The check is structural, not a
 * live Cordis mount (nothing in this repo boots a real Loader tree in a
 * unit test): every row `dsh-base` mounts unconditionally that a Harness
 * preset also lists must be disabled here, `agent-presets` must be
 * inserted with a real default, and no id may be both disabled and
 * (re-)inserted by this same file — that would be dshline arguing with
 * itself about whether one row exists.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** This package's own manifest, for the rows the patch names. */
const MANIFEST_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * The one adopted Harness version, read from `HARNESS_TARGET` rather than
 * written here — a literal would be a second place to update on a migration,
 * and `tools/harness-target.mjs` already owns the comparison.
 */
const HARNESS_VERSION = /^version (?<version>\S+)$/mu
  .exec(readFileSync(fileURLToPath(new URL('../../../HARNESS_TARGET', import.meta.url)), 'utf8'))
  ?.groups?.version

/**
 * Loader's own `!!js <expr>` tag, resolved here as the bare source string —
 * enough to evaluate it under a controlled `baseUrl`, without reimplementing
 * Loader's own `with (ctx) { eval(expr) }` scope for anything this file does
 * not need. Registering it also silences `yaml`'s "unresolved tag" warning,
 * which the tag being genuinely unresolved (not a parse bug) would otherwise
 * print on every parse of this file from now on.
 */
const JS_EXPR_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (source: string) => source }

/** One insert/disable/patch entry, as the Loader's patch-list dialect shapes it. */
interface PatchEntry {
  readonly id?: string
  readonly disabled?: boolean
  readonly insert?: readonly { readonly id: string; readonly name: string; readonly disabled?: unknown; readonly config?: unknown }[]
}

/**
 * Every row id `dsh-base` mounts unconditionally that a shipped Harness
 * preset (`standard`/`code`/`minimal`/`cordis`) also lists — copied
 * verbatim from `packages/bundle/web-app/cordis.patch.yml` in
 * deepseek-harness, the reference implementation of this exact move.
 */
const EXPECTED_DISABLED = [
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-str-replace-editor',
  'skill-filesystem',
  'tool-skill',
  'tool-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
  'agent-instructions',
  'tool-todo',
  'tool-web',
]

/** Rows this file explicitly keeps host-plane (never disabled), and why. */
const DELIBERATELY_NOT_DISABLED = [
  // A process singleton with a cross-session query surface; a preset row
  // registers a continuable setup on it rather than a tool the agent calls.
  'tool-subagent-report',
]

function loadPatch(): readonly PatchEntry[] {
  const parsed: unknown = parse(readFileSync(PATCH_PATH, 'utf8'), { customTags: [JS_EXPR_TAG] })
  if (!Array.isArray(parsed)) throw new Error('cordis.patch.yml must be a top-level list')
  return parsed as readonly PatchEntry[]
}

function disabledIds(patch: readonly PatchEntry[]): string[] {
  return patch.filter(entry => entry.disabled === true && entry.id !== undefined).map(entry => entry.id as string)
}

function insertedIds(patch: readonly PatchEntry[]): string[] {
  return patch.flatMap(entry => entry.insert?.map(row => row.id) ?? [])
}

describe('cordis.patch.yml: the agent plane moves behind agent presets', () => {
  it('disables exactly the rows a shipped preset also composes, no more and no fewer', () => {
    const patch = loadPatch()
    expect(disabledIds(patch).sort()).toEqual([...EXPECTED_DISABLED].sort())
  })

  it('never disables the rows this file deliberately keeps host-plane', () => {
    const patch = loadPatch()
    const disabled = new Set(disabledIds(patch))
    for (const id of DELIBERATELY_NOT_DISABLED) expect(disabled.has(id)).toBe(false)
  })

  it('inserts the preset roster with a real default', () => {
    const patch = loadPatch()
    const agentPresets = patch
      .flatMap(entry => entry.insert ?? [])
      .find(row => row.id === 'agent-presets')
    expect(agentPresets?.name).toBe('@deepseek-ai/dsh-agent-presets')
    expect((agentPresets?.config as { default?: unknown } | undefined)?.default).toBe('standard')
  })

  it('never both disables and (re-)inserts the same row id', () => {
    // A row this file disables and ALSO inserts under the same id would be
    // this file contradicting itself about whether that row exists at all.
    const patch = loadPatch()
    const disabled = new Set(disabledIds(patch))
    const inserted = insertedIds(patch)
    const overlap = inserted.filter(id => disabled.has(id))
    expect(overlap).toEqual([])
  })

  it('no longer inserts its own tool-ask-user row (each preset owns that choice now)', () => {
    // Whether an agent gets ask_user is the PRESET's decision — standard
    // mounts it, minimal (a deliberately two-tool preset) does not — and a
    // copy here would force it back on regardless of what a preset says.
    const patch = loadPatch()
    expect(insertedIds(patch)).not.toContain('tool-ask-user')
  })

  it('still inserts the frontend\'s own two rows', () => {
    const patch = loadPatch()
    expect(insertedIds(patch)).toEqual(expect.arrayContaining(['dshline-startup', 'dshline']))
  })
})

/**
 * `/usage`'s performance section reads Harness's `sessionStats` projection, and
 * `dsh-base` does not mount the unit that registers it — a plain TUI assembly
 * serves no such key. This bundle inserts it, host-plane, beside the frontend's
 * own rows: it registers a pure fold over the session log, is model-invisible,
 * and is keyed by session rather than by agent, so a preset is the wrong owner
 * (and would register the same unit once per mounted preset). The section is
 * optional in the UI regardless — see `usage-inspector.spec.ts` — so a profile
 * that drops this row keeps a working `/usage`.
 *
 * Two separable facts, and the manifest test below is the second one: the row
 * names a package, so the package has to be there. Availability is a shipped
 * `dependency`; the CAPABILITY is what a composition may drop.
 */
describe('cordis.patch.yml: the session-stats row', () => {
  function findRow(patch: readonly PatchEntry[]): { readonly id: string; readonly name: string; readonly disabled?: unknown; readonly config?: unknown } {
    const row = patch.flatMap(entry => entry.insert ?? []).find(candidate => candidate.id === 'session-stats')
    if (row === undefined) throw new Error('session-stats row not found')
    return row
  }

  it('inserts the official Harness package, not a dshline equivalent', () => {
    expect(findRow(loadPatch()).name).toBe('@deepseek-ai/dsh-session-stats')
  })

  it('mounts it unconditionally, with no capability probe and no configuration', () => {
    const row = findRow(loadPatch())
    expect(row.disabled).toBeUndefined()
    // The unit takes no options; a config block here would be dshline inventing
    // a knob upstream does not define.
    expect(row.config).toBeUndefined()
  })

  it('keeps it host-plane rather than behind an agent preset', () => {
    const patch = loadPatch()
    // Not in the agent-plane list, and never disabled: whether `/usage` can
    // report performance must not be a function of which preset a session runs.
    expect(EXPECTED_DISABLED).not.toContain('session-stats')
    expect(disabledIds(patch)).not.toContain('session-stats')
  })

  it('ships every package its own rows name as a real dependency', () => {
    // A row this bundle inserts unconditionally must resolve in a fresh install,
    // so the package is an ordinary `dependency` — not a peer the installing
    // profile is asked to supply, and not a devDependency, which would leave a
    // published bundle naming a row it does not bring. `optional` is wrong for
    // the same reason: the row is named unconditionally.
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, unknown>
    }
    const name = findRow(loadPatch()).name
    expect(manifest.dependencies?.[name]).toBe(HARNESS_VERSION)
    expect(manifest.peerDependencies?.[name]).toBeUndefined()
    expect(manifest.devDependencies?.[name]).toBeUndefined()
    expect(manifest.optionalDependencies?.[name]).toBeUndefined()
    expect(manifest.peerDependenciesMeta?.[name]).toBeUndefined()
  })
})

/**
 * The `standard` preset's `tool-subagent` row opts into
 * `modelSelectionSettings: true`, which needs
 * `@deepseek-ai/dsh-tool-subagent/model-selection-settings` mounted
 * Host-plane. The adopted Harness generation publishes that subpath, and the
 * bundle pins that generation exactly, so the row is mounted outright — the
 * `!!js` resolution probe it used to carry existed only to straddle a line
 * that did not publish it. Nothing here re-proves the subpath resolves:
 * `dsh-tool-subagent` is not this workspace's dependency (the shipped `dsh`
 * app supplies it), and `tools/consumer-smoke.mjs` boots that real install
 * under a pseudo-terminal, where an unresolvable row fails the Loader mount.
 */
describe('cordis.patch.yml: the model-selection-settings row', () => {
  function findRow(patch: readonly PatchEntry[]): { readonly id: string; readonly name: string; readonly disabled?: unknown } {
    const row = patch.flatMap(entry => entry.insert ?? []).find(candidate => candidate.id === 'subagent-model-selection-settings')
    if (row === undefined) throw new Error('subagent-model-selection-settings row not found')
    return row
  }

  it('inserts the row under the exact Host-plane subpath the standard preset needs', () => {
    const row = findRow(loadPatch())
    expect(row.name).toBe('@deepseek-ai/dsh-tool-subagent/model-selection-settings')
  })

  it('mounts it unconditionally, with no capability probe and no version literal', () => {
    const row = findRow(loadPatch())
    expect(row.disabled).toBeUndefined()
  })
})
