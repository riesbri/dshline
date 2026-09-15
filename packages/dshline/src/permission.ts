/**
 * Presentation adapter for Harness-owned permission presets.
 *
 * Harness splits the authority this adapter joins, and the split is the whole
 * design here:
 *
 * ```
 * permissionPresets.catalog()      sessionProjections.permissions
 *   → live selectable options        → durable current selection
 *              \                    /
 *               terminal picker (this module)
 *                      ↓
 *               /permission <option id>
 *                      ↓
 *               Harness mutation
 * ```
 *
 * The catalog is PROCESS-level and live: a contribution can add or remove a
 * selectable preset at any moment, and Harness announces that with
 * `permission-presets/catalog-changed`. The selection is SESSION-level and
 * durable: it is folded from the session's own knob events. Neither is copied
 * into anything dshline owns — the catalog is read at the interaction boundary
 * and the selection is read from the attached session's projection snapshot.
 *
 * Staleness is therefore not this module's problem to solve, and deliberately
 * so. A choice leaves here as a `/permission <id>` command line, and Harness's
 * own command handler validates that id against the live catalog before it
 * applies anything. A picker that was open across a catalog change cannot
 * apply a withdrawn option: it can only ask Harness, and be told no. Building a
 * second catalog state machine here to pre-empt that would duplicate the
 * authority it is trying to respect.
 * @module dshline/permission
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PermissionCatalog, PermissionSelection } from '@deepseek-ai/dsh-permission-presets/types'
import { promptSelect } from './select.ts'
import type { SelectChoice } from './select.ts'

/**
 * Picker-originated selections that need an explicit human acknowledgement,
 * and the words to ask for it in.
 *
 * Keyed by Harness's opaque option id, because that is the only thing about an
 * option this frontend may recognise. The copy mirrors Harness Web's own risk
 * gate for the same two values so one product decision reads identically in a
 * browser and in a terminal; a deployment-defined preset dshline knows nothing
 * about is not gated here, because inventing a risk claim about it would be a
 * policy dshline does not own.
 */
const RISK_CONFIRMATIONS: Readonly<Record<string, { readonly title: string; readonly detail: string; readonly enable: string }>> = {
  'danger-full-access': {
    title: 'Enable Full access?',
    detail: 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
    enable: 'Enable Full access',
  },
  auto: {
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
 * Join Harness's live catalog with the session's current selection for the
 * shared terminal picker.
 *
 * The two are separate arguments because they are separate authorities with
 * separate scopes, and nothing here recombines them into a local object that
 * claims to own both. Every row comes from the catalog verbatim — opaque id,
 * Harness's name, Harness's description, Harness's order — and the selection
 * contributes exactly one thing: which of those rows, if any, is current.
 *
 * A current value that resolves to no catalog row is reported as-is and
 * highlights nothing. `custom` is the case Harness derives, but it is not
 * special-cased: any unresolvable current value is reported rather than
 * explained, and none of them is ever added to the catalog so the picker can
 * find it. Offering a value Harness does not list is offering a command Harness
 * will reject.
 *
 * Both authorities are required. Without the catalog there are no honest rows;
 * without the selection there is no honest current state, and a picker that
 * showed one anyway would be inventing the very fact it exists to report. The
 * caller falls back to Harness's ordinary command path instead.
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
 * Mirror Harness Web's risk-gating policy through dshline's terminal-native
 * confirmation picker. Typed command arguments retain their normal Harness
 * semantics and do not come through this presentation step.
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
