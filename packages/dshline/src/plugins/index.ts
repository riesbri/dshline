/**
 * `/plugins`: the running agent's Harness preset composition, from a terminal.
 *
 * The same division of labour every other domain here keeps: Harness owns
 * the preset roster, a preset's composition, session composition and its
 * lifecycle, and the `agent-preset-registry` entry's `selectedDefault` field.
 * This module owns the rows, the keyboard, and the one prompt a keystroke here
 * can raise — the offer a locked session redirects to. There is no plugin
 * registry here, no YAML dialect invented, and no per-provider branch: a row
 * reaches this browser because `ctx.agentPresets` composed it, and a preset is
 * switched or defaulted through the same `agentPresets.select()`/`ctx.settings`
 * seams Harness's own Web client uses.
 *
 * What used to be here and is not: a `space` handler that spliced one
 * `disabled` field into a preset's file, and the copy-to-customize flow behind
 * it. Both belonged to a roster that owned its files. The adopted generation
 * owns no files — a declaration is a row, the registry "writes no
 * declarations" and "accepts no preset paths", and its own preset tree refuses
 * `write()` because "only the profile configuration editor persists
 * definitions". Composition changes are Harness's profile-patch operation now,
 * and this browser reads what it composes.
 * @module dshline/plugins
 */

import type { Context } from '@deepseek-ai/cordis'
import { escapeControls, paint } from '@dshline/renderer'
import { pluginsSeams } from './harness.ts'
import type { AgentPresetRow, AgentPresetsSeam, PluginsSettings } from './harness.ts'
import { PluginsCatalog, messageOf } from './catalog.ts'
import { hostCapabilities } from './health.ts'
import type { PluginsCatalogSpec } from './catalog.ts'
import type { PluginsAgent, PluginsSessionFacts } from './harness.ts'
import { sessionFacts } from './harness.ts'
import type { PresetRow } from './model.ts'
import {
  presetChoiceDetail,
  presetChoiceLabel,
  presetSwitchEligibility,
  selectablePresetRows,
} from './model.ts'
import type { PluginsActionOutcome } from './actions.ts'
import { setDefaultPreset, switchPreset } from './actions.ts'
import { createPluginsOverlay } from './overlay.ts'
import type { PluginsOverlay } from './overlay.ts'
import { promptSelect } from '../select.ts'

export type {
  AgentPresetDocument,
  AgentPresetRow,
  AgentPresetsSeam,
  PluginsAgent,
  PluginsSeams,
  PluginsSessionFacts,
  PluginsSettings,
} from './harness.ts'
export { pluginsSeams, sessionFacts } from './harness.ts'
export type { CompositionRow, CompositionTree, DisabledState } from './composition.ts'
export { parseComposition } from './composition.ts'
export type { PresetRow, PresetSwitchEligibility } from './model.ts'
export {
  filterCompositionRows,
  filterPresetRows,
  presetRows,
  rowMark,
} from './model.ts'
export type { BrowsedComposition, PluginsCapabilities, PluginsCatalogSpec, PluginsState } from './catalog.ts'
export type { CapabilityRegistry, HostCapabilities, RowHealth, SubagentRegistrySeam } from './health.ts'
export { CAPABILITY_LINKS, healthFacts, hostCapabilities, rowHealth, unbackedWhileEnabled } from './health.ts'
export { PluginsCatalog } from './catalog.ts'
export type { PluginsActionOutcome } from './actions.ts'
export { setDefaultPreset, switchPreset } from './actions.ts'
export type { PluginsOverlay, PluginsOverlaySpec } from './overlay.ts'
export { createPluginsOverlay } from './overlay.ts'

/**
 * The active session's facts, read live at the moment of the call.
 *
 * Deliberately read per call rather than captured once: every eligibility
 * decision in this domain turns on whether the session is still blank, and an
 * action holds its own awaits — two prompts a human answers, a file write, a
 * Harness re-resolve — across which a turn can start. A snapshot taken before
 * those awaits would go on reporting a started session as blank.
 * @param spec - the context and agent the browser was opened over.
 * @returns the session's current projected facts.
 */
function factsOf(spec: PluginsSpec): PluginsSessionFacts {
  return sessionFacts(spec.ctx, spec.agent.session)
}

/**
 * The preset the active session can be positively confirmed to be running,
 * read live.
 *
 * The catalog reports the same join, but from whichever pass settled last —
 * and every caller here needs it AFTER its own awaits, not before them. What
 * the agent actually composed wins over what the projection states, since a
 * composed agent is the stronger evidence; `undefined` means dshline cannot
 * confirm which preset is current, which is never treated as a match.
 * @param agentPresets - the preset seam.
 * @param spec - the context and agent the browser was opened over.
 * @returns the preset id, or undefined when it cannot be confirmed.
 */
function runningPresetId(agentPresets: AgentPresetsSeam, spec: PluginsSpec): string | undefined {
  return agentPresets.composedPreset(spec.agent.ctx) ?? factsOf(spec).presetId
}

/** What opening the browser needs from the window it opens over. */
export interface PluginsSpec {
  /** Context carrying the harness seams and the slot registry. */
  readonly ctx: Context
  /** The attached agent, for its composition and its session's projected facts. */
  readonly agent: PluginsAgent
  /** Write finished rows into the terminal's own scrollback. */
  readonly commit: (lines: readonly string[]) => void
  /** Current time; injected so notice expiry is assertable. */
  readonly now?: () => number
  /**
   * Called after this agent's scope was re-parented onto another composition.
   *
   * A recompose changes which layers a scope-aware Harness registry merges for
   * this agent, and it does so WITHOUT a registry mutation — so nothing the
   * registries emit announces it. The one consumer that needs telling today is
   * the skill catalog, and it is told the only thing this module knows:
   * the composition changed, so re-read the authoritative view. Nothing here
   * inspects a preset definition to guess which capability moved.
   */
  readonly recomposed?: () => void
}

/**
 * Show the Plugins browser and stay until the reader closes it.
 * @param spec - the context, the agent, and where transcript rows go.
 * @returns when the browser is closed.
 */
export async function openPlugins(spec: PluginsSpec): Promise<void> {
  const { ctx, agent, commit } = spec
  const seams = pluginsSeams(ctx)
  const catalogSpec: PluginsCatalogSpec = {
    seams,
    agentCtx: agent.ctx,
    session: () => factsOf(spec),
    // Read off the plugin's own context, not the agent's: the subagent
    // registry is a host-plane process singleton (dshline's own
    // `cordis.patch.yml` keeps it there deliberately), so what it supplies is
    // a fact about the running Host — exactly the "profiles provide, presets
    // expose" boundary these rows are checked against.
    host: () => hostCapabilities(ctx),
    invalidate: () => { ctx.tuiSlots.invalidate() },
  }
  const catalog = new PluginsCatalog(catalogSpec)
  catalog.refresh()
  let overlay!: PluginsOverlay
  // One action at a time, for the same reason Connect keeps a `busy` flag: an
  // action opens its own prompts and awaits a human, and a second keystroke
  // arriving underneath would start a second write against state the first
  // has not finished changing.
  let busy = false
  let closed = false
  try {
    await new Promise<void>(resolve => {
      let dismiss = (): void => {}
      const settle = (): void => {
        if (closed) return
        closed = true
        dismiss()
        resolve()
      }
      // Every failure an action can answer for is already turned into a
      // `PluginsActionOutcome` by `actions.ts`. This catch is for the ones that
      // are not answers at all — a prompt or an overlay throwing is the
      // concrete one — which would otherwise leave this floating
      // promise rejected, and an unhandled rejection ends the process on
      // Node's default setting, taking the whole session with it over a
      // keystroke in an overlay.
      //
      // Reporting is itself best-effort, and swallows rather than rethrows.
      // Drawing is the only channel this domain has: if `report` or `commit`
      // is the thing that failed, there is nowhere to say so, and letting that
      // failure out of the handler would reject the very promise this catch
      // exists to settle — reintroducing the crash by way of the recovery from
      // it. A dropped diagnostic loses one sentence; a rejection here loses
      // the session.
      const run = (task: () => Promise<void>): void => {
        if (busy) return
        busy = true
        void task()
          .catch((error: unknown) => {
            const message = `the action could not be completed: ${messageOf(error)}`
            try {
              if (!overlay.closed()) overlay.report(message, true)
              commit(outcomeLines({ kind: 'failed', message }))
            } catch {
              // See above: the terminal is the only place this could be said.
            }
          })
          .finally(() => { busy = false })
      }
      overlay = createPluginsOverlay({
        state: () => catalog.state(),
        refresh: () => { catalog.refresh() },
        pickPreset: () => { run(() => performPickPreset(spec, seams, catalog, overlay)) },
        makeDefault: () => { run(() => performMakeDefault(spec, seams, catalog, overlay)) },
        now: spec.now ?? ((): number => Date.now()),
        close: () => { settle() },
        invalidate: () => { ctx.tuiSlots.invalidate() },
      })
      dismiss = ctx.tuiSlots.pushOverlay(overlay)
    })
  } finally {
    catalog.dispose()
  }
}

/**
 * One outcome as a transcript row, matching `connect/index.ts`'s
 * `outcomeLines` character for character: escaped as a whole, so
 * `escapeControls` neutralizing the escape character itself is not undone by
 * running it over already-coloured text.
 * @param outcome - what the write answered.
 * @returns the single line to commit.
 */
function outcomeLines(outcome: PluginsActionOutcome): string[] {
  const mark = outcome.kind === 'failed' ? '✗' : '·'
  return [paint(
    escapeControls(`${mark} plugins: ${outcome.message}`),
    outcome.kind === 'failed' ? 'error' : 'muted',
  )]
}

/**
 * Report and commit one outcome, then re-read Harness so the browser shows
 * what actually landed rather than what was merely attempted.
 *
 * The transcript row is committed even when the reader has already closed the
 * browser, and that is the one place this domain diverges from Connect — which
 * drops a late result outright. The difference is what the two actions mean: a
 * withdrawn sign-in is work that did not happen, while a landed preset write
 * changed a file on disk, and the committed row is the only durable evidence
 * of it this session leaves. What IS skipped is everything addressed to a
 * reader who is no longer looking — the transient notice, and a re-read whose
 * only purpose is repainting a frame that is gone.
 * @param spec - the context and where transcript rows go.
 * @param catalog - the catalog to refresh (or re-browse) after the write.
 * @param overlay - the overlay to report into.
 * @param outcome - what the write answered.
 * @param browseId - re-browse this preset instead of a plain refresh, when given.
 */
function land(
  spec: PluginsSpec,
  catalog: PluginsCatalog,
  overlay: PluginsOverlay,
  outcome: PluginsActionOutcome,
  browseId?: string,
): void {
  spec.commit(outcomeLines(outcome))
  if (overlay.closed()) return
  overlay.report(outcome.message, outcome.kind === 'failed')
  if (browseId === undefined) catalog.refresh()
  else catalog.browse(browseId)
}

/**
 * Handle `p`: choose a preset, then either switch a blank session to it or
 * offer it as the default for the next one.
 * @param spec - the context and where transcript rows go.
 * @param seams - the Harness seams.
 * @param catalog - the catalog, for the roster and to refresh/browse after.
 * @param overlay - the overlay to report into.
 */
async function performPickPreset(
  spec: PluginsSpec,
  seams: ReturnType<typeof pluginsSeams>,
  catalog: PluginsCatalog,
  overlay: PluginsOverlay,
): Promise<void> {
  const state = catalog.state()
  if (state.kind !== 'ready' || seams.agentPresets === undefined) {
    overlay.report('agent presets are not available in this Harness profile', true)
    return
  }
  const choices = selectablePresetRows(state.presets)
  if (choices.length === 0) {
    overlay.report('no presets are available to choose from', true)
    return
  }
  const pickedId = await promptSelect(spec.ctx, {
    title: 'Agent Preset',
    view: 'Agent preset',
    choices: choices.map(row => {
      const detail = presetChoiceDetail(row)
      return {
        value: row.id,
        label: presetChoiceLabel(row),
        ...detail === undefined ? {} : { description: detail },
      }
    }),
  })
  if (pickedId === undefined) return
  // Read after the picker, not before it: the eligibility this turns on is
  // whether the session is STILL blank, and a human was just answering a
  // prompt. It decides only what to OFFER — Harness re-reads the same
  // `turnBoundary` fact inside `select` and refuses there if it has to.
  const eligibility = presetSwitchEligibility(factsOf(spec))
  if (eligibility.kind === 'recompose') {
    const outcome = await switchPreset(seams.agentPresets, spec.agent, pickedId)
    // A successful switch re-parented this agent's scope, so every scope-aware
    // Harness view of it may now merge different layers.
    if (outcome.kind === 'done') spec.recomposed?.()
    land(spec, catalog, overlay, outcome, pickedId)
    return
  }
  await performOfferDefault(spec, seams, catalog, overlay, pickedId, eligibility.message)
}

/**
 * The locked-session fallback: offer to make the picked preset the default
 * for the NEXT session instead, exactly as the spec's authority boundary
 * requires — never bypassing the lock, never silently doing nothing.
 * @param spec - the context and where transcript rows go.
 * @param seams - the Harness seams.
 * @param catalog - the catalog, to refresh after.
 * @param overlay - the overlay to report into.
 * @param id - the preset that cannot be switched to right now.
 * @param lockedMessage - why the session is locked, for the confirmation's detail.
 */
async function performOfferDefault(
  spec: PluginsSpec,
  seams: ReturnType<typeof pluginsSeams>,
  catalog: PluginsCatalog,
  overlay: PluginsOverlay,
  id: string,
  lockedMessage: string,
): Promise<void> {
  if (seams.settings === undefined) {
    overlay.report(`${lockedMessage}; this profile also mounts no settings provider to set a default`, true)
    return
  }
  const confirmed = await promptSelect(spec.ctx, {
    title: 'Session preset is fixed',
    view: 'Preset',
    detail: lockedMessage,
    choices: [
      { value: 'default', label: `Make ${id} the default for new sessions` },
      { value: 'cancel', label: 'Cancel' },
    ],
  })
  if (confirmed !== 'default') return
  const outcome = await setDefaultPreset(seams.settings, id)
  land(spec, catalog, overlay, outcome)
}

/**
 * Handle `d`: make the preset currently being browsed the default outright,
 * without a picker — the spec's own suggested shortcut for the common case
 * of "this is the one I just finished customizing."
 * @param spec - the context and where transcript rows go.
 * @param seams - the Harness seams.
 * @param catalog - the catalog, for the current reading and to refresh after.
 * @param overlay - the overlay to report into.
 */
async function performMakeDefault(
  spec: PluginsSpec,
  seams: ReturnType<typeof pluginsSeams>,
  catalog: PluginsCatalog,
  overlay: PluginsOverlay,
): Promise<void> {
  const state = catalog.state()
  if (state.kind !== 'ready') return
  const id = state.browsing.presetId
  const settings: PluginsSettings | undefined = seams.settings
  if (settings === undefined) {
    overlay.report('this profile mounts no settings provider', true)
    return
  }
  // The same invariant the `p` picker already keeps (`selectablePresetRows`
  // excludes a broken preset from what can be chosen at all): `d` must not
  // hand a known-broken or already-vanished preset to the NEXT session as
  // its default just because it happened to be the one on screen.
  const current = state.presets.find(candidate => candidate.id === id)
  if (current === undefined) {
    overlay.report(`${id} is no longer on the roster`, true)
    return
  }
  if (current.broken !== undefined) {
    overlay.report(`${id} cannot be made the default: ${current.broken}`, true)
    return
  }
  if (id === state.defaultId) {
    overlay.report(`${id} is already the default`, false)
    return
  }
  const outcome = await setDefaultPreset(settings, id)
  land(spec, catalog, overlay, outcome)
}
