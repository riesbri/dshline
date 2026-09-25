/**
 * What `/plugins` knows, as rows and decisions a terminal can draw.
 *
 * Two things are joined here that Harness keeps deliberately separate: a
 * preset's ROSTER identity (`AgentPresetRow` — id, display fields,
 * broken-ness) and one preset's COMPOSITION (`CompositionRow`, from
 * `./composition.ts` — the rows a declaration lists). A session's relationship
 * to a preset is a third thing again, and it is not reconstructed here at all:
 * `agentPreset` and `turnBoundary` are Session projections Harness owns, and
 * `harness.ts`'s {@link PluginsSessionFacts} is what they answer. This module
 * decides only what those facts make worth OFFERING; the authority to act on
 * them is Harness's, and `AgentPresetRegistry.select` re-reads `turnBoundary`
 * itself before it writes.
 * @module dshline/plugins/model
 */

import type { AgentPresetRow, PluginsSessionFacts } from './harness.ts'
import type { CompositionRow } from './composition.ts'

/** One roster preset, joined with what the current session and default say about it. */
export interface PresetRow {
  /** The preset id. */
  readonly id: string
  /** Display name; falls back to `id`. */
  readonly name: string
  /** One-line description, when the declaration publishes one. */
  readonly description: string | undefined
  /** Why this preset cannot be mounted, when it cannot. */
  readonly broken: string | undefined
  /** Whether the active session is actually composed from this preset. */
  readonly isCurrent: boolean
  /** Whether this is the preset a new session would get. */
  readonly isDefault: boolean
}

/**
 * Join the roster with session and default facts, preserving roster order.
 *
 * Order is never re-ranked, the same rule `connect/model.ts` states for its
 * own rows: the registry's own `order` sort is Harness's, not a preference
 * this frontend invents.
 * @param presets - the roster, as `AgentPresetsSeam.list()` returns it.
 * @param currentId - the id the active session is composed from, if resolved.
 * @param defaultId - the id a new session would get.
 * @returns one row per roster preset.
 */
export function presetRows(
  presets: readonly AgentPresetRow[],
  currentId: string | undefined,
  defaultId: string,
): readonly PresetRow[] {
  return presets.map(preset => ({
    id: preset.id,
    name: preset.name ?? preset.id,
    description: preset.description,
    broken: preset.broken,
    isCurrent: preset.id === currentId,
    isDefault: preset.id === defaultId,
  }))
}

/**
 * Normalize text for matching: case-folded, with runs of space collapsed.
 * @param value - raw text.
 * @returns the comparable form.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ')
}

/**
 * Whether one composition row answers a typed query, matched against its id
 * (when it has one — `id` is optional to Harness, and an id-less row is
 * still fully searchable by name) and its package/module name — the two
 * fields the spec calls out by example (`subagent`, `codex`, `workflow`,
 * `bash`), and nothing else: matching against `configSummary` would surface
 * rows by a fact a reader did not type looking for.
 * @param row - the composition row.
 * @param query - raw query text.
 * @returns true when the row should stay visible.
 */
export function matchesCompositionRow(row: CompositionRow, query: string): boolean {
  const needle = normalize(query)
  if (needle === '') return true
  return normalize(`${row.id ?? ''} ${row.name}`).includes(needle)
}

/**
 * Apply a query to composition rows, preserving document order.
 * @param rows - the flattened composition rows.
 * @param query - raw query text.
 * @returns the matching rows, in their original order.
 */
export function filterCompositionRows(
  rows: readonly CompositionRow[],
  query: string,
): readonly CompositionRow[] {
  return normalize(query) === '' ? rows : rows.filter(row => matchesCompositionRow(row, query))
}

/**
 * Whether one preset row answers a typed query, matched against its id and
 * display name.
 * @param row - the preset row.
 * @param query - raw query text.
 * @returns true when the row should stay visible.
 */
export function matchesPresetRow(row: PresetRow, query: string): boolean {
  const needle = normalize(query)
  if (needle === '') return true
  return normalize(`${row.id} ${row.name}`).includes(needle)
}

/**
 * Apply a query to preset rows, preserving roster order.
 * @param rows - the preset rows.
 * @param query - raw query text.
 * @returns the matching rows, in their original order.
 */
export function filterPresetRows(rows: readonly PresetRow[], query: string): readonly PresetRow[] {
  return normalize(query) === '' ? rows : rows.filter(row => matchesPresetRow(row, query))
}

/** The mark a composition row's own state earns — never `effective`, which needs no glyph of its own. */
export type RowMark = '●' | '○' | '◐'

/**
 * The glyph a composition row's OWN `disabled` field earns.
 *
 * Deliberately reads {@link CompositionRow.disabled}, not `.effective`: a
 * leaf disabled only because its parent group is off still shows its own
 * field honestly (`●`, enabled) so toggling it back does what the row says it
 * will, and `effective` is reported alongside as a fact, not folded into the
 * mark.
 * @param row - the composition row.
 * @returns the mark.
 */
export function rowMark(row: CompositionRow): RowMark {
  if (row.disabled.kind === 'conditional') return '◐'
  return row.disabled.kind === 'enabled' ? '●' : '○'
}

/**
 * The right-hand facts under a composition row: its effective state (only
 * when it disagrees with its own field), a config summary, and nothing this
 * module cannot see structurally.
 * @param row - the composition row.
 * @returns the facts, most useful first.
 */
export function compositionRowFacts(row: CompositionRow): string[] {
  const facts: string[] = []
  if (row.disabled.kind === 'conditional') facts.push(`condition: ${row.disabled.expression}`)
  if (!row.group && row.effective !== row.disabled.kind && row.effective !== 'enabled') {
    facts.push(row.effective === 'disabled' ? 'off via parent group' : 'conditional via parent group')
  }
  if (row.configSummary !== undefined) facts.push(row.configSummary)
  return facts
}

/** What pressing space on one composition row would do, before it is tried. */
export type ToggleEligibility =
  /** The row's own field is a plain boolean; space flips it. */
  | { readonly kind: 'toggle'; readonly enable: boolean }
  /** The row's `disabled` is a `!!js` condition; a plain toggle would discard it. */
  | { readonly kind: 'conditional'; readonly expression: string }
  /** A group row, which has no single on/off state of its own. */
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * What pressing space on one row would do, given what this profile can do.
 *
 * The conditional check runs first on purpose: a `!!js` row is not togglable no
 * matter what else is true of it, so every other answer would send a reader
 * through a keypress that was always going to be refused.
 *
 * There is no longer a trust check, and that is the migration rather than a
 * relaxation. The previous generation's roster classified a preset as shipped
 * or user-authored, and refused to edit anything shipped in place — so space on
 * a system row offered a copy first. The adopted registry publishes no `trust`
 * and no `path`, because a declaration is a row and a profile may legitimately
 * carry an override of a shipped one: `ctx.configEditor` writes a profile-layer
 * override and leaves the declaration in its package untouched. So there is no
 * row here this frontend must refuse on ownership grounds, and the only two
 * refusals left are ones about the row itself.
 * @param row - the selected composition row.
 * @param editable - whether this profile mounts the configuration editor.
 * @returns the eligibility, before any write is attempted.
 */
export function toggleEligibility(
  row: CompositionRow,
  editable: boolean,
): ToggleEligibility {
  if (row.group) return { kind: 'unavailable', reason: 'a group row has no single on/off state to toggle' }
  if (row.disabled.kind === 'conditional') {
    return { kind: 'conditional', expression: row.disabled.expression }
  }
  if (!editable) {
    return { kind: 'unavailable', reason: 'this profile mounts no configuration editor' }
  }
  return { kind: 'toggle', enable: row.disabled.kind === 'disabled' }
}

/** What selecting a preset in the `p` picker would do to the active session. */
export type PresetSwitchEligibility =
  /** The session is blank; `select` may run and takes effect immediately. */
  | { readonly kind: 'recompose' }
  /** The session already has history; only the default for the NEXT session can change. */
  | { readonly kind: 'locked'; readonly message: string }

/**
 * Whether picking a preset may switch the active session, or must be
 * redirected to "default for the next session" instead.
 *
 * PRESENTATION eligibility, not write authority. `AgentPresetRegistry.select`
 * refuses a started session itself, from the same `turnBoundary` fact, re-read
 * inside its own serialized switch — so this decides only whether the reader is
 * offered a switch or the default they can actually have. Both read one
 * projection, which is why the offer and the refusal cannot disagree.
 * @param session - the active session's projected facts.
 * @returns which path applies.
 */
export function presetSwitchEligibility(session: PluginsSessionFacts): PresetSwitchEligibility {
  if (!session.started) return { kind: 'recompose' }
  return {
    kind: 'locked',
    message: 'this session has already started; its agent preset is fixed — pick a default for the next session instead',
  }
}

/**
 * Presets worth offering in the `p` switch/default picker.
 *
 * A broken declaration is still shown in the composition browser when it is the
 * one currently open (the roster still lists it, `broken` and all), but a
 * picker whose whole job is choosing what to compose from next offers none it
 * cannot mount.
 * @param rows - every roster preset row.
 * @returns the rows a picker may offer.
 */
export function selectablePresetRows(rows: readonly PresetRow[]): readonly PresetRow[] {
  return rows.filter(row => row.broken === undefined)
}

/**
 * One preset's picker label: name, id, and the tags that distinguish it —
 * current and default — matching the facts the spec's own mock calls out
 * (`current · default`).
 *
 * No built-in-vs-custom tag: the adopted generation's roster does not carry
 * one. A shipped declaration and a profile-authored one are both rows in a
 * composition, and nothing in the registry's own report distinguishes them.
 * @param row - the preset row.
 * @returns the label line.
 */
export function presetChoiceLabel(row: PresetRow): string {
  const tags = [
    row.isCurrent ? 'current' : undefined,
    row.isDefault ? 'default' : undefined,
  ].filter((tag): tag is string => tag !== undefined)
  const suffix = tags.length === 0 ? '' : ` · ${tags.join(' · ')}`
  return `${row.name}  ${row.id}${suffix}`
}

/**
 * One preset's picker detail line, shown only while it is selected.
 * @param row - the preset row.
 * @returns the description, or undefined when the preset declares none.
 */
export function presetChoiceDetail(row: PresetRow): string | undefined {
  return row.description
}
