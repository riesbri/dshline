/**
 * The writes `/plugins` performs, each through the seam that owns it.
 *
 * Two operations, each mapping onto exactly one Harness authority:
 *
 * ```
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
 * `agent.cordis.yml`. Both belonged to that ownership model and both are gone
 * upstream. A preset is now an ordinary `@deepseek-ai/dsh-agent-preset` row in
 * a Cordis composition; the registry "writes no declarations", "accepts no
 * preset paths", and its own preset tree overrides `write()` to a no-op
 * because "only the profile configuration editor persists definitions". A new
 * declaration is a bundle patch installed through `plugin_manager`, and an
 * edit to an existing one is a profile patch through `ctx.configEditor` —
 * Harness's operations, over Harness's own reconciliation, with a Loader
 * reload underneath. Rebuilding either here would be a second persistence path
 * for the same fact, which is the thing dshline must never own.
 *
 * Nothing here decides whether an action should be OFFERED; `model.ts`'s
 * `presetSwitchEligibility` does, from the same facts. These functions assume
 * the offer was made and report what Harness answered.
 * @module dshline/plugins/actions
 */

import type { AgentPresetsSeam, PluginsAgent, PluginsSettings } from './harness.ts'
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
