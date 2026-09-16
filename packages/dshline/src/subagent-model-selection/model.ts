/**
 * The subagent-model authorization editor's state and semantics.
 *
 * Harness owns the authority: the `subagent-model-selection` Host setting is
 * the durable authorization document, and a Session's recorded policy is the
 * per-Session fact. Nothing here writes a Session or routes a child. This
 * module only stages a draft against the Host setting and decides what a row
 * on screen means.
 *
 * The two things the editor joins are deliberately kept apart:
 *
 * ```
 * live model catalog        saved authorization
 * (advisory availability)   (the settings decision)
 * ```
 *
 * A route the live catalog no longer advertises is still authorized; it stays
 * visible, marked `unavailable`, and removable. A provider whose listing fails
 * removes nothing — not a saved route, not a draft selection, not another
 * provider's models.
 * @module dshline/subagent-model-selection/model
 */

import type { ModelCatalogRoute } from '../model-catalog.ts'
import { modelRouteKey } from '../model-catalog.ts'

/**
 * The Host-owned settings namespace that authorizes explicit child routes.
 *
 * A plain literal rather than an import from `@deepseek-ai/dsh-tool-subagent`:
 * this frontend consumes the generic `ctx.settings` document and must not take
 * a package dependency on the tool that reads it.
 */
export const SUBAGENT_MODEL_SELECTION_NAMESPACE = 'subagent-model-selection'

/** One exact `{ provider, model }` route the Host setting authorizes. */
export interface SubagentModelRoute {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
}

/** The resolved value of the Host-owned `subagent-model-selection` section. */
export interface SubagentModelSelectionValue {
  /** Whether newly composed top-level Sessions receive model selection. */
  readonly enabled: boolean
  /** Exact child routes those Sessions may select explicitly. */
  readonly allowedModels: readonly SubagentModelRoute[]
}

/** One row the editor offers: an exact route and its live availability. */
export interface SubagentModelEntry {
  /** The exact route this row authorizes. */
  readonly route: SubagentModelRoute
  /** Whether the live catalog currently advertises this exact route. */
  readonly available: boolean
}

/** The staged draft. Nothing is written to settings until Save. */
export interface SubagentModelDraft {
  /** Whether the setting would be on. */
  readonly enabled: boolean
  /**
   * Selected routes, keyed by {@link modelRouteKey}. The route object is kept
   * beside its key, and the key is never parsed back into one.
   */
  readonly selected: ReadonlyMap<string, SubagentModelRoute>
}

/** What the editor knows while it is open. */
export type SubagentModelReading =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | {
    readonly kind: 'ready'
    /** Every row: live routes first, then saved and draft routes the catalog omits. */
    readonly entries: readonly SubagentModelEntry[]
    /** Provider routes whose listing failed, in provider order. */
    readonly failedProviders: readonly string[]
    /**
     * Set when the live catalog could not be read at all. Saved authorization
     * is still shown; this only says the availability column is unknown.
     */
    readonly catalogError: string | undefined
    /** The draft being staged. */
    readonly draft: SubagentModelDraft
    /**
     * A refusal or conflict the reader must still see.
     *
     * Deliberately part of the reading rather than a timed notice: a conflict
     * that faded after a few seconds would let the reader keep pressing Save
     * without knowing why nothing landed.
     */
    readonly refusal: string | undefined
    /** Whether a write is in flight. The editor is inert while it is. */
    readonly saving: boolean
  }

/**
 * Validate one descriptor value into the setting's resolved shape.
 *
 * The schema already guarantees this shape, so a mismatch means the namespace
 * is not the one this editor understands. Returning undefined lets the caller
 * report that truthfully rather than fabricate a default and write it back.
 * @param value - the descriptor's resolved value.
 * @returns the resolved setting, or undefined when it is not that shape.
 */
export function selectionValueFrom(value: unknown): SubagentModelSelectionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { enabled?: unknown; allowedModels?: unknown }
  if (typeof candidate.enabled !== 'boolean' || !Array.isArray(candidate.allowedModels)) return undefined
  const allowedModels: SubagentModelRoute[] = []
  for (const entry of candidate.allowedModels) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const route = entry as { provider?: unknown; model?: unknown }
    if (typeof route.provider !== 'string' || route.provider === '') return undefined
    if (typeof route.model !== 'string' || route.model === '') return undefined
    allowedModels.push({ provider: route.provider, model: route.model })
  }
  return { enabled: candidate.enabled, allowedModels }
}

/**
 * Stage the saved value as a draft, with every saved route preselected.
 * @param value - the resolved Host setting.
 * @returns the draft the editor opens on.
 */
export function draftFrom(value: SubagentModelSelectionValue): SubagentModelDraft {
  const selected = new Map<string, SubagentModelRoute>()
  for (const route of value.allowedModels) {
    selected.set(modelRouteKey(route.provider, route.model), { provider: route.provider, model: route.model })
  }
  return { enabled: value.enabled, selected }
}

/**
 * The label every row shows, and the only text search matches.
 * @param route - the exact route.
 * @returns the qualified `provider/model` spelling.
 */
export function entryLabel(route: SubagentModelRoute): string {
  return `${route.provider}/${route.model}`
}

/**
 * Join the live catalog with saved authorization.
 *
 * Live routes come first in catalog order, so the editor reads like the model
 * picker. A saved route the catalog did not advertise — because its provider
 * failed, or because it no longer lists that model — is appended in saved
 * order and marked unavailable. Nothing is ever dropped: catalog membership is
 * advisory, and authorization is the settings decision.
 * @param routes - live catalog routes, in provider order.
 * @param saved - the routes currently authorized by the setting.
 * @returns every row the editor should show.
 */
export function joinEntries(
  routes: readonly ModelCatalogRoute[],
  saved: readonly SubagentModelRoute[],
): SubagentModelEntry[] {
  const entries: SubagentModelEntry[] = routes.map(route => ({
    route: { provider: route.provider, model: route.model },
    available: true,
  }))
  const present = new Set(entries.map(entry => modelRouteKey(entry.route.provider, entry.route.model)))
  for (const route of saved) {
    const key = modelRouteKey(route.provider, route.model)
    if (present.has(key)) continue
    present.add(key)
    entries.push({ route: { provider: route.provider, model: route.model }, available: false })
  }
  return entries
}

/**
 * Filter rows by a search query, matching the qualified label alone.
 * @param entries - every row.
 * @param query - the typed query.
 * @returns the matching rows, in their original order.
 */
export function filterEntries(
  entries: readonly SubagentModelEntry[],
  query: string,
): readonly SubagentModelEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return entries
  return entries.filter(entry => entryLabel(entry.route).toLowerCase().includes(needle))
}

/**
 * Toggle one route in the draft. Disabling does not clear the selection, and
 * neither does unchecking one row.
 * @param draft - the current draft.
 * @param route - the route to toggle.
 * @returns the next draft.
 */
export function withToggled(draft: SubagentModelDraft, route: SubagentModelRoute): SubagentModelDraft {
  const key = modelRouteKey(route.provider, route.model)
  const selected = new Map(draft.selected)
  if (selected.has(key)) selected.delete(key)
  else selected.set(key, { provider: route.provider, model: route.model })
  return { enabled: draft.enabled, selected }
}

/**
 * Stage a new enabled flag, retaining the selection either way.
 * @param draft - the current draft.
 * @param enabled - the next flag.
 * @returns the next draft.
 */
export function withEnabled(draft: SubagentModelDraft, enabled: boolean): SubagentModelDraft {
  return { enabled, selected: draft.selected }
}

/**
 * Why the draft cannot be saved, or undefined when it can.
 *
 * This blocks only the state Harness itself rejects — an enabled setting with
 * nothing authorized — so the reader is told before a write. Harness remains
 * the authority: every other validation is left to the write.
 * @param draft - the draft about to be saved.
 * @returns a refusal message, or undefined.
 */
export function saveRefusal(draft: SubagentModelDraft): string | undefined {
  return draft.enabled && draft.selected.size === 0
    ? 'selection is on, so at least one model must be allowed'
    : undefined
}

/**
 * The routes a save should write.
 *
 * Already-saved routes keep their stored order, so saving without a change
 * writes the same list back; newly checked routes are appended in the order
 * the editor shows them. The result is deterministic and duplicate-free.
 * @param saved - the routes the setting held when the editor opened.
 * @param selected - the draft's selected routes.
 * @param entries - every row the editor showed.
 * @returns the exact route list to write.
 */
export function authorizedRoutes(
  saved: readonly SubagentModelRoute[],
  selected: ReadonlyMap<string, SubagentModelRoute>,
  entries: readonly SubagentModelEntry[],
): SubagentModelRoute[] {
  const routes: SubagentModelRoute[] = []
  const written = new Set<string>()
  const take = (route: SubagentModelRoute): void => {
    const key = modelRouteKey(route.provider, route.model)
    if (!selected.has(key) || written.has(key)) return
    written.add(key)
    routes.push({ provider: route.provider, model: route.model })
  }
  for (const route of saved) take(route)
  for (const entry of entries) take(entry.route)
  // A selected route that reached neither list is still an authorization the
  // reader made. It is written last rather than silently dropped; the owner
  // keeps such routes in `entries` already, so this is a backstop.
  for (const route of selected.values()) take(route)
  return routes
}
