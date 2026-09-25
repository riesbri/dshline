/**
 * Reading one preset declaration's composition text, for display.
 *
 * The dialect is Harness's entry-list YAML: a top-level list of plugin rows
 * (`EntryOptions`, from `@deepseek-ai/cordis-plugin-loader`), where a
 * `group: true` row's `config` is itself a nested list of rows —
 * `delegation > tool-subagent-codex` is one row inside another row's
 * `config`, not a flat entry. The ONLY thing Harness's own discovery
 * validator (`entryListProblem` in `packages/preset/agent-preset-registry/src/
 * definition.ts`) requires of a row is a non-empty `name`; `id` is not part of
 * the minimum-valid shape — the Loader assigns a random one at mount time
 * when a row omits it (`config/tree.ts`'s `Math.random().toString(16)...`).
 * This parser follows that same shallow acceptance rather than a stricter one
 * of its own: an id-less row is valid input here, exactly as it is to
 * Harness, and is displayed by its `name` and structural position instead.
 *
 * `disabled` is not only boolean: the same dialect tags a scalar
 * `!!js <expression>` (`tag:yaml.org,2002:js` in `vendor/include`'s
 * `entryListSchema`), evaluated by the Loader against its own running
 * context at composition time. This module NEVER evaluates that expression —
 * doing so here would run untrusted host-specific logic
 * (`process.platform === 'win32'`, and worse is possible) inside a terminal
 * frontend that has no business deciding what it means. A row whose
 * `disabled` is a `!!js` node is modeled as `'conditional'` and its raw
 * expression text is carried through for display only.
 *
 * This module is now READ-ONLY, and that is a migration result rather than a
 * choice. The previous generation's roster was a live directory of
 * `agent.cordis.yml` files, so `/plugins` could address a row by a
 * {@link RowLocator} and splice exactly one `disabled` field in place, and
 * nothing about that survives: the adopted registry "accepts no preset paths",
 * returns no path to write, and its own preset tree overrides `write()` to a
 * no-op because "only the profile configuration editor persists definitions".
 * A composition now changes only through Harness's own profile-patch
 * reconciliation, and a second YAML-splicing path beside it would be a second
 * authority over the same file. So the locator, the re-parse-and-refuse
 * discipline, and the narrow edit are deleted, and what remains is the parse
 * the browser draws.
 * @module dshline/plugins/composition
 */

import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Document, ScalarTag, YAMLMap, YAMLSeq } from 'yaml'

/** The Loader's own tag for a `!!js` conditional scalar. */
const CONDITIONAL_TAG = 'tag:yaml.org,2002:js'

/** Recognizes the conditional tag without ever evaluating what it carries. */
const conditionalTag: ScalarTag = {
  identify: (value: unknown): boolean =>
    typeof value === 'object' && value !== null && '__jsExpr' in (value as Record<string, unknown>),
  tag: CONDITIONAL_TAG,
  resolve: (source: string): { __jsExpr: string } => ({ __jsExpr: source }),
  stringify: (item): string => {
    const value = (item as { value?: unknown }).value
    return typeof value === 'object' && value !== null && '__jsExpr' in value
      ? String((value as { __jsExpr: unknown }).__jsExpr)
      : String(value)
  },
}

/** One row's own `disabled` field, modeled honestly instead of coerced to boolean. */
export type DisabledState =
  /** No `disabled` field, or an explicit falsy one. */
  | { readonly kind: 'enabled' }
  /** `disabled: true` (or another truthy plain value). */
  | { readonly kind: 'disabled' }
  /** `disabled: !!js <expression>` — the Loader decides this, not dshline. */
  | { readonly kind: 'conditional'; readonly expression: string }

/** Whether a row runs, once its own field and its ancestors' are combined. */
export type EffectiveState = 'enabled' | 'disabled' | 'conditional'

/** One row of a preset's composition, at whatever depth it was found. */
export interface CompositionRow {
  /** How to safely re-find this exact row in the declaration being edited. */
  readonly locator: RowLocator
  /**
   * Display breadcrumb from the root row down to and including this one —
   * each ancestor's `id`, falling back to its `name` when it has none.
   */
  readonly path: readonly string[]
  /** This row's own id, when the declaration gives it one. */
  readonly id: string | undefined
  /** Module specifier the row loads. */
  readonly name: string
  /** Nesting depth; `0` for a top-level row. */
  readonly depth: number
  /** Whether this row is a nested group (its `config` holds child rows). */
  readonly group: boolean
  /** This row's own `disabled` field, before any ancestor is considered. */
  readonly disabled: DisabledState
  /**
   * Whether the row actually runs, per the Loader's own inheritance rule: a
   * group's OWN row is always `'enabled'` here (a group container always
   * runs so its children can be evaluated — the Loader's `Entry._disabled`
   * returns `false` unconditionally for a group), but a group's `disabled`
   * field still governs every row nested under it, which is what makes a
   * leaf's `effective` here possibly `'disabled'` or `'conditional'` even
   * when its own {@link disabled} is `'enabled'`.
   */
  readonly effective: EffectiveState
  /**
   * A short, obvious summary of `config`, when it is worth showing: a plain
   * scalar, or a small object of plain scalars, whitespace-normalized and
   * capped to {@link MAX_SUMMARY_LENGTH} characters. Never computed for a
   * group row (its `config` is the child list) and omitted rather than
   * guessed whenever a value is not plainly summarizable — this keeps a
   * multi-kilobyte persona or system-prompt `config` from ever landing in a
   * row's detail line.
   */
  readonly configSummary?: string
  /**
   * This row's `config.provider`, when it declares one as a plain string.
   *
   * Read structurally and named after the FIELD, not after any meaning: this
   * module is a parser and does not know which registry a given row resolves a
   * provider from, or whether it resolves one at all. `health.ts` owns that
   * judgement, and only for module names it can prove the link for. Kept
   * separate from {@link configSummary}, which is display text and may be
   * absent (a large config is deliberately not summarized) while this is
   * present.
   */
  readonly configProvider?: string
}

/** What one parse of a composition file produced. */
export type CompositionTree =
  /** Parsed and structurally valid: a top-level list of entry rows. */
  | { readonly kind: 'parsed'; readonly rows: readonly CompositionRow[] }
  /** The text could not be read as an entry list; the reason is Harness's own. */
  | { readonly kind: 'broken'; readonly reason: string }

/**
 * Parse one preset's composition text into a flat, pre-order row list.
 *
 * Never throws: text this dialect cannot make sense of is reported as
 * {@link CompositionTree} `'broken'`, the same posture Harness's own
 * registration takes toward a malformed `plugins` list — and, by design, no
 * MORE strict than that posture: a row this parser cannot make complete sense
 * of but Harness's own validator accepts (an id-less row, chiefly) is parsed,
 * not rejected. This function is presentation for declarations Harness already
 * considers valid; it does not independently decide a preset's health — see
 * `catalog.ts`, which treats the roster's own `AgentPresetRow.broken` as
 * authoritative over whatever this parser thinks.
 * @param text - the declaration's rendered child list, as `readDocument()` returns it.
 * @returns the flattened rows, or why none could be read.
 */
export function parseComposition(text: string): CompositionTree {
  try {
    const doc = parseDocument(text, { customTags: [conditionalTag] })
    if (doc.errors.length > 0) {
      return { kind: 'broken', reason: doc.errors[0]?.message ?? 'composition did not parse as YAML' }
    }
    const top = doc.contents
    if (!isSeq(top)) return { kind: 'broken', reason: 'composition is not a list of entries' }
    const rows: CompositionRow[] = []
    const problem = walk(top, [], [], 0, 'enabled', rows)
    if (problem !== undefined) return { kind: 'broken', reason: problem }
    return { kind: 'parsed', rows }
  } catch (error) {
    return { kind: 'broken', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Walk one entry list, flattening rows in pre-order and threading the display
 * path down through nested groups.
 * @param seq - the entry list at this level.
 * @param parentPath - display breadcrumb above this level.
 * @param depth - nesting depth of this level.
 * @param ancestorBlock - the combined state every ancestor group contributes.
 * @param out - accumulator every row is pushed onto, in document order.
 * @returns a problem description, or undefined once the whole level is read.
 */
function walk(
  seq: YAMLSeq,
  parentPath: readonly string[],
  parentSteps: readonly RowLocatorStep[],
  depth: number,
  ancestorBlock: EffectiveState,
  out: CompositionRow[],
): string | undefined {
  for (const [index, item] of seq.items.entries()) {
    // Matches `entryListProblem` exactly: a row is valid iff it is a mapping
    // naming a non-empty `name`. `id` is read when present but never required.
    if (!isMap(item)) return `row ${String(index + 1)} is not a plugin row (expected a map with a "name")`
    const name = item.get('name')
    if (typeof name !== 'string' || name === '') {
      return `row ${String(index + 1)} names no plugin (a "name" string is required)`
    }
    const idValue = item.get('id')
    const id = typeof idValue === 'string' && idValue !== '' ? idValue : undefined
    const group = item.get('group') === true
    const disabled = readDisabled(item)
    const steps = [...parentSteps, { index, name, id }]
    const path = [...parentPath, id ?? name]
    const effective: EffectiveState = group ? 'enabled' : combine(ancestorBlock, disabled)
    const configSummary = group ? undefined : summarizeConfig(item.get('config'))
    const configProvider = group ? undefined : readConfigProvider(item.get('config', true))
    out.push({
      locator: { steps },
      path,
      id,
      name,
      depth,
      group,
      disabled,
      effective,
      ...(configSummary !== undefined ? { configSummary } : {}),
      ...(configProvider !== undefined ? { configProvider } : {}),
    })
    if (group) {
      const config: unknown = item.get('config')
      if (!isSeq(config)) return `group ${path.join(' > ')} must hold a list of plugin rows`
      const problem = walk(config, path, steps, depth + 1, combine(ancestorBlock, disabled), out)
      if (problem !== undefined) return problem
    }
  }
  return undefined
}

/**
 * Read one row's own `disabled` field without resolving a `!!js` node's
 * meaning — only its tag and its raw expression text.
 * @param row - the row's mapping node.
 * @returns the row's own disabled state.
 */
function readDisabled(row: YAMLMap): DisabledState {
  const node = row.get('disabled', true)
  if (node === undefined) return { kind: 'enabled' }
  const value = isScalar(node) ? node.value : node
  if (isJsExpr(value)) return { kind: 'conditional', expression: value.__jsExpr }
  return { kind: Boolean(value) ? 'disabled' : 'enabled' }
}

/**
 * Combine an ancestor's accumulated state with one more field, most-blocking
 * value winning — a literal `disabled` anywhere outranks an unresolved
 * conditional, which outranks enabled.
 * @param ancestor - the state contributed by everything above this row.
 * @param own - this row's own disabled state.
 * @returns the combined state.
 */
function combine(ancestor: EffectiveState, own: DisabledState): EffectiveState {
  if (ancestor === 'disabled' || own.kind === 'disabled') return 'disabled'
  if (ancestor === 'conditional' || own.kind === 'conditional') return 'conditional'
  return 'enabled'
}

/**
 * A row's `config.provider`, when it is a plain non-empty string.
 *
 * A `!!js` provider expression is deliberately NOT read: this module never
 * evaluates one, so there is no name to check a registry against and claiming
 * otherwise would be a guess. A non-string value is a malformed config the
 * Loader will complain about far more usefully than a browser could.
 * @param node - the row's `config` node, unresolved.
 * @returns the provider name, or undefined when the row names none plainly.
 */
function readConfigProvider(node: unknown): string | undefined {
  if (!isMap(node)) return undefined
  const value = node.get('provider')
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A config summary never grows past this many characters, whitespace collapsed first. */
const MAX_SUMMARY_LENGTH = 100

/**
 * Collapse whitespace (including newlines) to single spaces and cap length,
 * so a multi-kilobyte prompt block can never reach a row's detail line.
 * @param text - the raw text.
 * @returns the compact, terminal-friendly text.
 */
function compact(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length > MAX_SUMMARY_LENGTH
    ? `${normalized.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : normalized
}

/**
 * A short, obvious summary of a leaf row's `config`, or undefined when
 * nothing plain enough is there to show.
 * @param raw - the resolved `config` value, when the row has one.
 * @returns the summary text, or undefined.
 */
function summarizeConfig(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  // `get()` auto-unwraps a Scalar to its value but leaves a Map/Seq as its AST
  // node; `.toJSON()` is that node's own plain-JS projection (recursive, and
  // it runs our custom tag's `resolve` output through unchanged since that is
  // already plain data), never a re-parse of the source text.
  const config = typeof raw === 'object' && hasToJSON(raw) ? raw.toJSON() : raw
  if (isJsExpr(config)) return undefined
  if (isPlainScalar(config)) return compact(String(config))
  if (isPlainObject(config)) {
    const entries = Object.entries(config)
    if (entries.length === 0 || entries.length > 3) return undefined
    if (entries.some(([, value]) => !isPlainScalar(value))) return undefined
    return compact(entries.map(([key, value]) => `${key}=${String(value)}`).join(', '))
  }
  return undefined
}

function hasToJSON(value: object): value is { toJSON(): unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function'
}

/** Whether a value is a `!!js` conditional, once resolved. */
function isJsExpr(value: unknown): value is { __jsExpr: string } {
  return typeof value === 'object' && value !== null && '__jsExpr' in (value as Record<string, unknown>)
}

function isPlainScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isJsExpr(value)
}

/**
 * One step of a {@link RowLocator}: a row's position within its containing
 * entry list, and the fingerprint expected there.
 *
 * `name` is always checked because it is the one field Harness itself requires
 * of a row. `id` is checked only when the row had one, since its absence here
 * does not mean a re-read may not since have grown one — only that this locator
 * does not know to expect it.
 */
export interface RowLocatorStep {
  /** Index within the immediately containing entry list. */
  readonly index: number
  /** The name expected at that position. */
  readonly name: string
  /** The id expected at that position, when this row had one. */
  readonly id: string | undefined
}

/**
 * How to safely re-find one row after re-reading the declaration.
 *
 * A declaration is a list of rows where a `group: true` row's own children live
 * in its `config`, so a locator is a path of (index, name, id) steps from the
 * top-level list down to one row. `id` is optional to Harness and is not
 * guaranteed unique where present, so it is a corroborating check and never the
 * only one — the alternative, addressing a row by name alone, would silently
 * edit the first match in a list a person may have made ambiguous on purpose.
 */
export interface RowLocator {
  /** Steps from the top-level list down to and including the target row. */
  readonly steps: readonly RowLocatorStep[]
}

/** Why {@link togglePresetRow} could not apply the requested change. */
export type ToggleFailureReason =
  /** The declaration's child list is not the array of rows it should be. */
  | 'broken'
  /** The locator's structure (an index, or a group where one is expected) no longer exists. */
  | 'not-found'
  /**
   * A row exists at the located position, but its name — or its id, when the
   * locator recorded one — no longer matches: the declaration changed
   * incompatibly since this locator was built, and mutating that position
   * anyway would edit a different row than the one shown.
   */
  | 'changed'
  /**
   * The row's current `disabled` is a `!!js` expression: toggling here would
   * silently discard host-specific behavior an operator wrote on purpose.
   */
  | 'conditional'

/** The result of attempting one narrow `disabled` edit. */
export type ToggleResult =
  /** The edit applied, or nothing needed to change. */
  | { readonly ok: true; readonly changed: boolean; readonly plugins: readonly unknown[] }
  /** The edit was refused, or the row could not be safely re-found. */
  | { readonly ok: false; readonly reason: ToggleFailureReason; readonly message: string }

/** One child row as a preset declaration holds it, before any parsing. */
type RawRow = Readonly<Record<string, unknown>>

/** Whether a value is a `!!js` conditional, already resolved by the Loader. */
function isRawJsExpr(value: unknown): value is { readonly __jsExpr: string } {
  return typeof value === 'object' && value !== null && '__jsExpr' in (value as Record<string, unknown>)
}

/**
 * Read one row's own `disabled` field from the raw declaration, without ever
 * resolving what a `!!js` node means.
 * @param row - the raw row.
 * @returns the row's own disabled state.
 */
function rawDisabledState(row: RawRow): DisabledState {
  const value = row['disabled']
  if (value === undefined) return { kind: 'enabled' }
  if (isRawJsExpr(value)) return { kind: 'conditional', expression: value.__jsExpr }
  return { kind: Boolean(value) ? 'disabled' : 'enabled' }
}

/**
 * Enable or disable exactly one row of a preset declaration.
 *
 * This operates on the STRUCTURED child list the Loader resolved, not on
 * rendered YAML text, and it copies every row it does not touch. That is the
 * point of the migration: a preset is a `@deepseek-ai/dsh-agent-preset` row in
 * a composition, the composition is persisted by `ctx.configEditor` through a
 * profile patch, and that path re-serializes the whole `config` through the
 * owning plugin's own `Config`. A second YAML writer producing a second
 * rendering of the same declaration would be a second authority over one file.
 *
 * Every step of the locator is re-verified against the list being edited, so a
 * declaration changed since the browser read it is refused rather than
 * mutating whatever now sits at that position. A request that changes nothing
 * returns the input list unchanged, so a redundant write never lands a
 * profile patch.
 *
 * A `!!js` `disabled` is refused outright. Overwriting one would discard
 * host-specific behavior an operator wrote on purpose, and the adopted Loader
 * still evaluates it, so there is no representation here that is both a toggle
 * and an honest edit.
 * @param plugins - the declaration's resolved child list.
 * @param locator - the row's locator, as {@link CompositionRow.locator} reports it.
 * @param enable - `true` to enable the row, `false` to disable it.
 * @returns the new list, or why the edit was refused.
 */
export function togglePresetRow(
  plugins: readonly unknown[],
  locator: RowLocator,
  enable: boolean,
): ToggleResult {
  if (locator.steps.length === 0) return { ok: false, reason: 'not-found', message: 'no row addressed' }
  const label = locator.steps.map(step => step.id ?? step.name).join(' > ')
  const next = stepInto(plugins, locator.steps, 0, label, enable)
  if (next === undefined) return { ok: false, reason: 'not-found', message: `no row at the expected position for ${label}` }
  if ('refused' in next) return next.refused
  return { ok: true, changed: next.list !== plugins, plugins: next.list }
}

/**
 * Walk one step deeper, rebuilding the list only along the path to the target.
 * @param list - the list at this level.
 * @param steps - the remaining locator steps.
 * @param depth - how many steps have been consumed.
 * @param label - the human-readable path, for a refusal message.
 * @param enable - what the target row's `disabled` should become.
 * @returns the rebuilt list on success, or a refusal at this level.
 */
function stepInto(
  list: readonly unknown[],
  steps: readonly RowLocatorStep[],
  depth: number,
  label: string,
  enable: boolean,
): { readonly list: readonly unknown[] } | { readonly refused: ToggleResult } | undefined {
  const step = steps[depth]
  if (step === undefined) return undefined
  const row: unknown = list[step.index]
  if (row === undefined) return undefined
  const moved = (): { refused: ToggleResult } => ({
    refused: { ok: false, reason: 'changed', message: `the declaration changed since this was read: ${label} moved or was replaced` },
  })
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return moved()
  const map = row as Record<string, unknown>
  if (map['name'] !== step.name) return moved()
  if (step.id !== undefined && map['id'] !== step.id) return moved()
  const last = depth === steps.length - 1
  if (!last) {
    // Only a group row has children, and only in its own `config`. A row that
    // used to nest and no longer does is a changed declaration, not a leaf.
    const children: unknown = map['config']
    if (!Array.isArray(children)) {
      return {
        refused: { ok: false, reason: 'changed', message: `the declaration changed since this was read: ${label} is no longer a group` },
      }
    }
    const rebuilt = stepInto(children, steps, depth + 1, label, enable)
    if (rebuilt === undefined) return undefined
    if ('refused' in rebuilt) return rebuilt
    if (rebuilt.list === children) return { list }
    const copy = [...list]
    copy[step.index] = { ...map, config: rebuilt.list }
    return { list: copy }
  }
  const current = rawDisabledState(map)
  if (current.kind === 'conditional') {
    return {
      refused: {
        ok: false,
        reason: 'conditional',
        message: `${label} is disabled by a condition (${current.expression}), not a plain toggle`,
      },
    }
  }
  const already = enable ? current.kind === 'enabled' : current.kind === 'disabled'
  if (already) return { list }
  const copy = [...list]
  // Dropping the field IS the enable case, for the same reason the shipped
  // declarations omit it rather than writing `false`: a row with no `disabled`
  // is enabled, and that is what a person reading the patch expects to see.
  if (enable) {
    const { disabled: _dropped, ...rest } = map
    void _dropped
    copy[step.index] = rest
  } else {
    copy[step.index] = { ...map, disabled: true }
  }
  return { list: copy }
}
