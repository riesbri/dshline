/**
 * Whether the Host actually supplies what an enabled preset row asks for.
 *
 * Profiles PROVIDE capabilities; presets EXPOSE them to an agent. Those are
 * different layers, and a row being enabled proves only the second. The
 * shipped `standard` preset says so in its own comment beside the optional
 * delegation rows — "Install the matching Bundle in this Profile and restart
 * the Host, then copy this preset and remove `disabled` from the matching tool
 * row. Host availability alone grants no tool." — and the reverse is just as
 * true and much easier to hit by accident: removing `disabled` from a row
 * whose Bundle was never installed produces a preset that mounts, a tool the
 * model can see, and a delegation that fails on first use.
 *
 * This module closes only the gap it can PROVE. A link is reported when three
 * facts line up, and never otherwise:
 *
 * ```
 * the row names a module in LINKS          (so its config field's meaning is known)
 * the row's config names a provider        (a plain string, never a !!js expression)
 * the Host mounts the registry behind it   (so "absent" means absent, not unreadable)
 * ```
 *
 * {@link CAPABILITY_LINKS} is a data table, not a branch per provider: an
 * entry says "rows loading THIS module resolve `config.provider` from THAT
 * registry", and the two entries there today both resolve from `ctx.subagents`
 * — one a delegation tool, one a workflow backend. Nothing here knows the name
 * `codex` (or `spawn`, or `claude-code`); a provider is a string read out of a
 * row and looked up in a registry, and a Bundle that adds a new provider needs
 * no change here. A module this table does not cover produces no verdict at
 * all, which is the honest answer rather than a guess dressed as a warning.
 * @module dshline/plugins/health
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CompositionRow } from './composition.ts'

/**
 * The one `ctx.subagents` surface this module reads.
 *
 * Structural, and read through `ctx.get`, for the reason `harness.ts` states
 * for its own seams: a profile that mounts no subagent registry still starts,
 * and health simply reports nothing rather than failing to draw. `list()` is
 * the registry's own "which providers are registered" method — the same one
 * every other consumer asks.
 */
export interface SubagentRegistrySeam {
  /** Registered provider names, in registration order. */
  list(): string[]
}

/** Which Host registry a row's `config.provider` is resolved from. */
export type CapabilityRegistry = 'subagents'

/**
 * Module names whose `config.provider` names an entry in a Host registry.
 *
 * Keyed by the row's `name` (the module specifier the Loader imports), which
 * is the only field that identifies what a row IS — `id` is optional and
 * freely chosen by whoever wrote the composition, so two rows loading the same
 * module under different ids must produce the same verdict.
 */
export const CAPABILITY_LINKS: Readonly<Record<string, CapabilityRegistry>> = {
  // A delegation tool: `config.provider` is the `ctx.subagents` provider its
  // runs start on. Every `subagent_*` tool row in the shipped presets is an
  // instance of this one module with a different provider.
  '@deepseek-ai/dsh-tool-subagent': 'subagents',
  // A workflow backend, resolving a provider from the same registry — the
  // second entry is why this is a table and not a special case.
  '@deepseek-ai/dsh-workflow-worker-thread': 'subagents',
}

/** What the Host says about the capability one row depends on. */
export type RowHealth =
  /**
   * Nothing provable: the row names no linked module, declares no plain
   * provider, or the Host mounts no registry to ask. Draws exactly as before.
   */
  | { readonly kind: 'unknown' }
  /** The registry supplies the named provider. */
  | { readonly kind: 'satisfied'; readonly provider: string }
  /** The registry is mounted and does not supply the named provider. */
  | { readonly kind: 'missing'; readonly registry: CapabilityRegistry; readonly provider: string }

/**
 * The Host capability registries this frontend can consult, read off a
 * context without asserting that any is mounted.
 */
export interface HostCapabilities {
  /** Provider names `ctx.subagents` reports, or undefined when none is mounted. */
  readonly subagentProviders: readonly string[] | undefined
}

/**
 * Read the Host's capability registries once per catalog pass.
 *
 * Read per pass rather than held, matching every other reading in this domain:
 * a provider registers when its row activates, and Harness may change the
 * mounted capability set at runtime (the adopted generation's HMR service and
 * plugin manager), so a browser that cached the list could miss a provider that
 * just arrived or keep reporting one that is already gone.
 * @param ctx - context carrying (or not carrying) the registries.
 * @returns what each registry currently reports.
 */
export function hostCapabilities(ctx: Context): HostCapabilities {
  const subagents = ctx.get('subagents') as SubagentRegistrySeam | undefined
  let subagentProviders: readonly string[] | undefined
  try {
    subagentProviders = subagents?.list()
  } catch {
    // A registry that cannot answer is indistinguishable from one that is not
    // mounted, for this module's purpose: either way there is no list to
    // compare against, and reporting every row as broken off a failed read
    // would be the loudest possible wrong answer.
    subagentProviders = undefined
  }
  return { subagentProviders }
}

/**
 * What the Host says about one row's declared provider.
 * @param row - the composition row.
 * @param capabilities - what the Host's registries report.
 * @returns the verdict, `'unknown'` whenever nothing can be proven.
 */
export function rowHealth(row: CompositionRow, capabilities: HostCapabilities): RowHealth {
  if (row.group) return { kind: 'unknown' }
  const provider = row.configProvider
  const registry = CAPABILITY_LINKS[row.name]
  if (provider === undefined || registry === undefined) return { kind: 'unknown' }
  const available = capabilities.subagentProviders
  if (available === undefined) return { kind: 'unknown' }
  return available.includes(provider)
    ? { kind: 'satisfied', provider }
    : { kind: 'missing', registry, provider }
}

/**
 * Whether a row's missing capability is worth marking rather than merely
 * noting.
 *
 * A row whose own field is DISABLED and whose provider is absent is
 * consistent, not broken: that is exactly the state every optional delegation
 * row ships in, and marking it would put a warning on most of a stock preset.
 * The warning belongs on the contradiction — a row this preset turns on that
 * the Host cannot back.
 * @param row - the composition row.
 * @param health - the verdict for it.
 * @returns whether the row is enabled here but unbacked by the Host.
 */
export function unbackedWhileEnabled(row: CompositionRow, health: RowHealth): boolean {
  return health.kind === 'missing' && row.disabled.kind !== 'disabled' && row.effective !== 'disabled'
}

/**
 * The health facts drawn under a selected row, most useful first.
 *
 * A missing provider is worded for the state it is actually in: a row turned
 * ON here that the Host cannot back is the contradiction the reader has to
 * act on, and one still turned off is orientation for before they do — the
 * order of operations the preset's own comment describes (install the Bundle,
 * restart, then enable the row).
 *
 * "unavailable in this Host" and not "not installed in this profile", which is
 * the wording this first shipped with and could not support. `list()` reports
 * which providers are REGISTERED in the running process. A package can be
 * installed in the profile and still not appear — its row disabled, its own
 * dependency missing, the Host booted before it was added — so naming
 * installation would be a claim about the filesystem made from evidence about
 * a registry. Availability is exactly what was observed, and it is also the
 * fact that decides whether the row works.
 * @param row - the composition row.
 * @param health - the verdict for it.
 * @returns zero or one fact line.
 */
export function healthFacts(row: CompositionRow, health: RowHealth): string[] {
  if (health.kind !== 'missing') return []
  return unbackedWhileEnabled(row, health)
    ? [`enabled in preset · provider "${health.provider}" unavailable in this Host`]
    : [`provider "${health.provider}" unavailable in this Host`]
}
