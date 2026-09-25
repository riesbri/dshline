/**
 * The writes `/plugins` performs, each through the seam that owns it.
 *
 * Three operations, each mapping onto exactly one Harness authority:
 *
 * ```
 * toggleRow          ctx.configEditor.edit() — the profile configuration
 *                    editor, which is the only owner a preset declaration has
 *                    in the adopted generation
 * switchPreset       ctx.agentPresets.select() — Harness's own whole operation:
 *                    serialize per session, re-check `turnBoundary`, refuse a
 *                    started session, recompose, then record the switch.
 *                    dshline neither checks nor appends anything of its own
 * setDefaultPreset   ctx.settings.update('agent-preset-registry', …) — the
 *                    `selectedDefault` volatile field new sessions resolve
 *                    over the deployment default, written through the same
 *                    ns/patch contract every namespace uses
 * ```
 *
 * What this module no longer offers is as much a part of the contract as what
 * it does. The previous generation's roster was a live directory of files, so
 * `/plugins` had exactly two authoring paths into it: `agentPresets.copy()` to
 * fork a shipped preset, and a narrow lock-coordinated edit of the copy's
 * `agent.cordis.yml`. The second survives, re-owned; the first is gone
 * upstream. A preset is now an ordinary `@deepseek-ai/dsh-agent-preset` row in
 * a Cordis composition, the registry "writes no declarations" and "accepts no
 * preset paths", and its own preset tree overrides `write()` to a no-op
 * because "only the profile configuration editor persists definitions". So a
 * new declaration is a bundle patch installed through `plugin_manager` —
 * Harness's operation, and authoring one is a plugin-management concern rather
 * than a terminal one. What is left for a terminal is EDITING a declaration
 * that already exists, and that is {@link toggleRow}, routed through
 * `ctx.configEditor` rather than through a second YAML writer and a second
 * file lock of dshline's own.
 *
 * Nothing here decides whether an action should be OFFERED; `model.ts`'s
 * `presetSwitchEligibility` does, from the same facts. These functions assume
 * the offer was made and report what Harness answered.
 * @module dshline/plugins/actions
 */

import { escapeControls } from '@dshline/renderer'
import type { AgentPresetsSeam, ConfigEditorSeam, PluginsAgent, PluginsSettings } from './harness.ts'
import type { RowLocator } from './composition.ts'
import { togglePresetRow } from './composition.ts'
import { messageOf } from './catalog.ts'

/**
 * The settings namespace the adopted generation keeps the user default in.
 *
 * The registry entry's own id, which is what upstream's own General-settings
 * row writes: `selectedDefault` is a volatile field of the
 * `agent-preset-registry` entry that overrides the deployment's `default` for
 * sessions created later. The retired `agent-presets` namespace is a different
 * entry that no longer exists, so writing to it would be a silent no-op.
 */
const AGENT_PRESET_NAMESPACE = 'agent-preset-registry'

/**
 * The package that declares a preset. Named, not imported: the registry is
 * reached structurally so a profile mounting neither still starts, and a
 * literal is the same kind of agreement — the row a profile composes is this
 * name, and a mismatch is a composition that mounts no roster at all.
 */
const PRESET_DECLARATION = '@deepseek-ai/dsh-agent-preset'

/** Carries {@link togglePresetRow}'s own refusal out of the editor's callback. */
class ToggleRefusedError extends Error {}

/** How one write ended, in words the transcript can carry. */
export interface PluginsActionOutcome {
  /** Whether the write went through. */
  readonly kind: 'done' | 'failed'
  /** What happened, already worded for a reader. */
  readonly message: string
}

function done(message: string): PluginsActionOutcome {
  return { kind: 'done', message }
}

function failed(message: string): PluginsActionOutcome {
  return { kind: 'failed', message }
}

/**
 * Enable or disable one row of a preset declaration, as a profile override.
 *
 * The declaration is located through the configuration editor's own entry list
 * rather than by a path: the registry publishes no `path`, and the editor's
 * `entries()` is what Harness itself addresses configuration by. Exactly one
 * `@deepseek-ai/dsh-agent-preset` row may declare that preset id, and anything
 * else — none, or more than one — is refused rather than guessed at, because
 * editing the wrong declaration is worse than editing nothing.
 *
 * The write goes through `edit()`, which takes the row's whole next `config`,
 * validates it through that row's own `Config`, persists a profile-layer
 * override under Harness's file lock, and reconciles the Loader. So a shipped
 * declaration is never modified in its package: the profile carries the
 * override, which is exactly what a bundle patch would do by hand, and the
 * declaration keeps working unchanged for any profile that does not override
 * it. Nothing here writes YAML, takes a lock, or reconciles anything itself.
 * @param configEditor - the profile configuration editor.
 * @param presetId - the declaration whose row is being toggled.
 * @param locator - the row's locator, as `CompositionRow.locator` reports it.
 * @param enable - `true` to enable the row, `false` to disable it.
 * @returns what happened.
 */
export async function toggleRow(
  configEditor: ConfigEditorSeam,
  presetId: string,
  locator: RowLocator,
  enable: boolean,
): Promise<PluginsActionOutcome> {
  const matches = configEditor.entries().filter(entry => {
    if (entry.options.name !== PRESET_DECLARATION) return false
    const config = entry.options.config
    return typeof config === 'object' && config !== null
      && (config as { id?: unknown }).id === presetId
  })
  if (matches.length === 0) {
    return failed(`${presetId} is not an editable declaration in this profile`)
  }
  if (matches.length > 1) {
    // Two rows declaring one id is a composition that cannot say which preset a
    // session runs, and `register()` rejects a duplicate at mount. Refusing
    // here keeps a toggle from picking a winner by accident.
    return failed(`${presetId} is declared more than once, so its rows cannot be edited safely`)
  }
  const entry = matches[0]
  if (entry === undefined) return failed(`${presetId} is not an editable declaration in this profile`)
  let changed = false
  try {
    await configEditor.edit(entry, current => {
      const plugins: unknown = current['plugins']
      if (!Array.isArray(plugins)) {
        throw new Error(`${presetId} declares no composition to edit`)
      }
      const result = togglePresetRow(plugins, locator, enable)
      if (!result.ok) throw new ToggleRefusedError(result.message)
      changed = result.changed
      // Every other key of the row's own config is carried through untouched;
      // a partial object here would silently reset `id`, `order` or a `name`
      // the declaration published.
      return { ...current, plugins: result.plugins }
    })
  } catch (error) {
    if (error instanceof ToggleRefusedError) return failed(error.message)
    // Escaped before it is styled, like any other text this frontend did not
    // compose: Harness's own refusal can quote a profile path and the schema
    // rejection quotes the value that failed.
    return failed(`could not write the change to ${presetId} (${escapeControls(messageOf(error))})`)
  }
  return done(`${presetId}: ${enable ? 'enabled' : 'disabled'}${changed ? '' : ' (already so)'}`)
}

/**
 * Switch the active session's agent to a different preset.
 *
 * One call, because one authority owns the whole operation. Harness's
 * `AgentPresetRegistry.select` serializes concurrent selections per session,
 * re-reads the `turnBoundary` projection inside that queue, refuses a session
 * that has already started, recomposes the agent, and appends
 * `agent-preset/selected` only after the recomposition committed — then
 * returns the id it recorded.
 *
 * dshline previously did the middle three steps itself: check blank,
 * `recompose`, append. Every one of them was a second implementation of a rule
 * Harness also enforced, and the blank check in particular was a check made
 * OUTSIDE the switch it protected, so two selections racing through it could
 * both pass. That orchestration is deleted rather than translated; what is
 * left here is turning Harness's answer into a sentence.
 * @param agentPresets - the preset seam.
 * @param agent - the live agent whose session is switching.
 * @param id - the preset to switch to.
 * @returns what happened.
 */
export async function switchPreset(
  agentPresets: AgentPresetsSeam,
  agent: PluginsAgent,
  id: string,
): Promise<PluginsActionOutcome> {
  let committed: string
  try {
    committed = await agentPresets.select(agent, id)
  } catch (error) {
    return failed(`could not switch to ${id}: ${messageOf(error)}`)
  }
  return done(`switched to ${committed}`)
}

/**
 * Set the preset a new session gets when none is named explicitly.
 *
 * Written as the volatile `selectedDefault` field rather than by overwriting
 * the deployment's `default`, because that is the field upstream reserves for
 * exactly this: a deployment's `default` is its composition, while the user's
 * choice is a separate preference that resolves over it and is cleared back to
 * it by an unset.
 * @param settings - the settings seam.
 * @param id - the preset id to make the default.
 * @returns what happened.
 */
export async function setDefaultPreset(settings: PluginsSettings, id: string): Promise<PluginsActionOutcome> {
  try {
    await settings.update(AGENT_PRESET_NAMESPACE, { selectedDefault: id })
  } catch (error) {
    return failed(`could not set ${id} as the default: ${messageOf(error)}`)
  }
  return done(`${id} is now the default for new sessions`)
}
