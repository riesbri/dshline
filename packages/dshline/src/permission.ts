/**
 * Presentation adapter for Harness-owned permission presets.
 *
 * Two Harness authorities, joined here for one picker and owned by neither:
 *
 * - `permissionPresets.catalog()` — PROCESS-level and live. What may be
 *   selected. Read at the interaction boundary, never retained.
 * - the `permissions` session projection — SESSION-level and durable. What is
 *   selected. Read from the attached session's snapshot.
 *
 * Mutation leaves through Harness's `/permission <id>` command, never a
 * service call, so Harness validates every id against the live catalog. That
 * is why a picker held open across a catalog change needs no staleness
 * machinery here: it can only ask, and be told no.
 *
 * docs/architecture.md carries the full boundary and the reasoning for it.
 * @module dshline/permission
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PermissionCatalog, PermissionSelection } from '@deepseek-ai/dsh-permission-presets/types'
// Type-only, deliberately: `permissionPresets` is an optional capability and
// its package is not a dshline peer dependency, so a value import would make
// an optional seam a load-time requirement. Importing the namespace as a TYPE
// still lets the literal below be checked against upstream's own constant, so
// a rename upstream fails dshline's typecheck instead of silently un-gating a
// risk confirmation.
import type * as PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import { promptSelect } from './select.ts'
import type { SelectChoice } from './select.ts'

/**
 * Harness's experimental per-call review preset, pinned to upstream's own
 * exported constant through its type rather than repeated as a bare literal.
 *
 * The annotation is the point: `AUTO_PRESET` is `declare const … = 'auto'`, so
 * this compiles only while upstream still publishes that exact id. It costs no
 * runtime import, which is what keeps the optional capability optional.
 */
const AUTO_PRESET: typeof PermissionPresets.AUTO_PRESET = 'auto'

/**
 * Picker-originated selections that need an explicit human acknowledgement.
 *
 * Harness publishes the selectable catalog but no per-option risk or
 * confirmation metadata: `PresetOption` is `{ value, name, description? }`, and
 * the only frontend that decides which options are risk-bearing is Harness
 * Web's own client package — a browser aggregate dshline must not depend on.
 * So this table is dshline's presentation policy, mirroring the same
 * user-control boundary Harness Web applies to the same two upstream-known
 * options. It is deliberately small, keyed by opaque option id, and holds no
 * state.
 *
 * Risk is never inferred — not from sandbox or approval internals, not from an
 * option's display name. A deployment-defined preset dshline knows nothing
 * about is not gated here, because inventing a risk claim about it would be a
 * policy Harness owns and dshline does not.
 */
const RISK_CONFIRMATIONS: Readonly<Record<string, { readonly title: string; readonly detail: string; readonly enable: string }>> = {
  // No host-side constant names this preset id. `danger-full-access` is also a
  // `SandboxMode`, but that is a different domain that happens to collide in
  // dsh-base's default table, and reading risk off a sandbox mode is exactly
  // the inference this module refuses.
  'danger-full-access': {
    title: 'Enable Full access?',
    detail: 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
    enable: 'Enable Full access',
  },
  // Pinned to upstream's exported `AUTO_PRESET` through its type, so this key
  // cannot drift from the id Harness actually publishes.
  [AUTO_PRESET]: {
    title: 'Enable Auto review (experimental)?',
    detail: 'Auto review runs without a sandbox. Before every native tool call and PTC inner call, the same model as the current agent reviews whether to allow it. This feature is experimental, can falsely allow or deny actions, and uses additional tokens.',
    enable: 'Enable Auto review',
  },
}

/** The terminal-facing permission picker data. */
export interface PermissionPicker {
  /** Detail identifying the effective selection before a new one is made. */
  readonly detail: string
  /** The current selection to highlight, when it is one of the live catalog rows. */
  readonly currentValue: string | undefined
  /** Live catalog rows, in Harness's contribution order. */
  readonly choices: readonly SelectChoice[]
}

/**
 * Join Harness's live catalog with the session's current selection.
 *
 * Every row comes from the catalog verbatim — opaque id, name, description,
 * order — and the selection contributes exactly one thing: which row, if any,
 * is current. A current value no catalog row resolves is reported as-is and
 * highlights nothing; `custom` is how Harness derives that state, but nothing
 * here special-cases it, and no row is ever synthesised so the picker can find
 * its current value.
 *
 * Both authorities are required. Missing either one, the caller falls back to
 * Harness's ordinary command path rather than inferring rows or inventing a
 * current state.
 * @param catalog - the live process catalog, from `permissionPresets.catalog()`.
 * @param selection - the session's `permissions` projection value.
 * @returns picker data, or undefined when either authority is unavailable.
 */
export function permissionPicker(
  catalog: PermissionCatalog | undefined,
  selection: PermissionSelection | undefined,
): PermissionPicker | undefined {
  if (catalog === undefined || selection === undefined) return undefined
  const current = catalog.options.find(option => option.value === selection.currentValue)
  return {
    detail: `current: ${current?.name ?? selection.currentValue}`,
    currentValue: current?.value,
    choices: catalog.options.map(option => ({
      value: option.value,
      label: option.name,
      ...option.description === undefined ? {} : { description: option.description },
    })),
  }
}

/**
 * Ask for the acknowledgement a risk-bearing picker choice needs.
 *
 * Typed command arguments retain their normal Harness semantics and do not
 * come through this presentation step.
 * @param ctx - context owning the shared bounded selector.
 * @param value - selected opaque catalog option id.
 * @returns whether this picker-originated selection may dispatch to Harness.
 */
export async function confirmPermissionSelection(ctx: Context, value: string): Promise<boolean> {
  const risk = RISK_CONFIRMATIONS[value]
  if (risk === undefined) return true
  const confirmed = await promptSelect(ctx, {
    title: risk.title,
    view: 'Confirm',
    detail: risk.detail,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'enable', label: risk.enable },
    ],
  })
  return confirmed === 'enable'
}
