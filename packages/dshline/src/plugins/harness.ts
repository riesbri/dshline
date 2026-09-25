/**
 * The exact Harness surfaces this frontend consumes for agent presets, and
 * nothing else — read by `/plugins` and by `window.ts`'s per-agent
 * composition alike, since both are the same one seam.
 *
 * Two seams answer everything either caller needs:
 *
 * ```
 * ctx.get('agentPresets')   the declarative preset roster, one declaration's
 *                           rendered composition, joining/recomposing an
 *                           agent, and selection
 * ctx.get('settings')       the `agent-preset-registry` namespace's
 *                           `selectedDefault` field, written through the same
 *                           ns/patch contract every namespace uses
 * ```
 *
 * Neither VALUE is imported from `@deepseek-ai/dsh-agent-preset-registry` or
 * `@deepseek-ai/dsh-settings`. This mirrors `connect/harness.ts`'s own choice
 * for the same reason: a profile that mounts neither service still starts —
 * `/plugins` degrades instead of failing to open, and an agent this frontend
 * attaches simply keeps whatever the host layer already composed, exactly
 * as before presets existed here — and a structural shape costs nothing at
 * the few call sites that use it. Every field below is copied from the
 * adopted generation's real `AgentPresetRegistry`, not guessed: the roster
 * row, `mount`/`recompose`'s real return type (`AgentPreset`, not a bespoke
 * "read" type), `select`'s committed-id return, and `readDocument`'s document
 * all come from `packages/preset/agent-preset-registry/src/{preset,index}.ts`
 * in deepseek-harness.
 *
 * What the previous generation's roster carried and this one deliberately does
 * not is worth stating, because every one of those fields was an owning-file
 * fiction the new architecture removed. There is no `path`: the registry
 * "neither scans directories nor accepts preset paths", and a preset is an
 * ordinary `@deepseek-ai/dsh-agent-preset` row in a Cordis composition. There
 * is no `trust`, because nothing distinguishes a shipped declaration from a
 * profile-authored one once both are rows. There is no `authorable`, because
 * there is no writable preset root — a new preset is a bundle patch, installed
 * with `plugin_manager`, which is Harness's operation and not a frontend's.
 * And there is no `copy`, because the registry "writes no declarations".
 *
 * The type-only imports below are a different thing from a runtime
 * dependency, and are the Harness-native way to reach a projection key: they
 * carry nothing but the `declare module` augmentations that put `agentPreset`
 * in `SessionProjectionStateMap`/`SessionProjectionMap` and `turnBoundary` in
 * `SessionProjectionStateMap`, so {@link sessionFacts} can name them without
 * the optional packages being installed, let alone mounted. Nothing here
 * imports a value from either.
 * @module dshline/plugins/harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// The `turnBoundary` projection key, which `dsh-agent` declares and
// `dsh-agent-loop` registers.
import type {} from '@deepseek-ai/dsh-agent'
// The `agentPreset` projection key, which `dsh-agent-preset-registry`
// declares and registers. `/types` is its client-safe, path-free module: no
// service, no filesystem, nothing but the declarations.
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'

/**
 * The Harness Agent surface `/plugins` reads, and hands back to the Harness
 * operations that write.
 *
 * Exactly the three fields Harness's own preset operations take off an
 * `Agent`: `id` is what {@link AgentPresetsSeam.select} serializes switches
 * on, `ctx` is the scope `composedPreset`/`recompose` resolve against, and
 * `session` is what the projections are read for. A real `Agent` satisfies it
 * structurally, so `attachment.ts` hands one over unchanged and nothing here
 * reconstructs, adapts, or casts an Agent.
 */
export interface PluginsAgent {
  /** Session-backed agent identity. */
  readonly id: SessionId
  /** The agent's own scope context. */
  readonly ctx: object
  /** The live session this agent drives. */
  readonly session: Session
}

/**
 * The two Session facts every `/plugins` decision turns on, each one read from
 * the Harness projection that owns it.
 *
 * Not folded here, and no longer folded anywhere in dshline: `agentPreset` and
 * `turnBoundary` are Session projections Harness registers, maintains, and
 * checkpoints, and a second reconstruction over the raw log would be a
 * frontend disagreeing with the authority its own writes are checked against.
 */
export interface PluginsSessionFacts {
  /** The preset this Session runs, as the `agentPreset` projection states it. */
  readonly presetId: string | undefined
  /** Whether this Session has opened a turn, as the `turnBoundary` projection states it. */
  readonly started: boolean
}

/**
 * Read one Session's preset and turn facts through `ctx.sessionProjections`.
 *
 * `agentPreset` folds the creation header and every later
 * `agent-preset/selected` into the preset the Session actually runs; upstream
 * states outright that reconstruction reads the projection, never the header
 * alone. `turnBoundary` is the same fact `AgentPresets.select` re-checks
 * inside its own serialized switch, tested the same way — an open turn, or any
 * turn at all — so what this frontend OFFERS and what Harness ACCEPTS cannot
 * drift apart.
 *
 * Every absence answers the same way a mounted-but-empty projection would.
 * The registry is optional, but so is the preset roster, and a deployment
 * mounting `agentPresets` necessarily mounts `ctx.sessionProjections` too —
 * the roster registers its projection against it unconditionally at
 * construction. So "no registry" and "no roster" are one case, and `/plugins`
 * already reports that case as unavailable.
 * @param ctx - a context that may carry the projection registry.
 * @param session - the session to read, or undefined before one exists.
 * @returns the facts, defaulted to "nothing recorded, nothing started".
 */
export function sessionFacts(ctx: Context, session: Session | undefined): PluginsSessionFacts {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined || session === undefined) {
    return { presetId: undefined, started: false }
  }
  const boundary = projections.stateOf(session, 'turnBoundary')
  // `agentPreset` is `string | null` in the adopted generation, and null is the
  // registered unit's own answer for "this deployment composes none" — not a
  // missing row. Both collapse to the same dshline fact, an unknown preset.
  const preset = projections.stateOf(session, 'agentPreset')
  return {
    presetId: preset ?? undefined,
    started: boundary !== undefined && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0),
  }
}

/** One preset as the roster reports it — never composition rows. */
export interface AgentPresetRow {
  /** The preset's id; the identity every other seam is keyed by. */
  readonly id: string
  /** Display name; falls back to `id` when the declaration publishes none. */
  readonly name?: string
  /** One-line description. */
  readonly description?: string
  /** Declared ordering hint among presets. */
  readonly order?: number
  /**
   * Human-readable reason this preset cannot be mounted, when it cannot.
   * Present on the roster row rather than hiding the preset — a broken
   * declaration still needs to be seen so it can be fixed or removed.
   */
  readonly broken?: string
}

/** One declaration's composition, rendered back as the Loader's own entry-list YAML. */
export interface AgentPresetDocument {
  /** The preset the composition belongs to. */
  readonly agentPreset: string
  /** The declared child plugin list as entry-list YAML, `!!js` conditions included. */
  readonly content: string
  /** Display name the declaration published. */
  readonly name?: string
  /** One sentence on what this preset is for. */
  readonly description?: string
}

/**
 * The `ctx.get('agentPresets')` surface this frontend consumes — read by
 * `/plugins` (browsing and switching), and by `window.ts`'s `attachOptions`
 * (composing every agent it attaches from its resolved preset, the reason a
 * composition exists for `/plugins` to browse at all). One structural shape
 * for both, rather than two drifting copies of the same real service.
 *
 * `mount`/`recompose` return the `AgentPresetRow` now installed, matching the
 * real service exactly — not `Promise<void>`, and not a distinct "read" type.
 * Both methods' own docs say the caller owns the blank-session and unpublished-
 * agent checks, and callers here perform those themselves (`window.ts` for the
 * composition an attachment mounts).
 *
 * {@link AgentPresetsSeam.select} is the exception, and the reason `/plugins`
 * owns no preset-switch orchestration of its own: Harness performs the whole
 * operation — serialize per session, re-check the authoritative `turnBoundary`
 * projection, refuse a started session, recompose, and only then append
 * `agent-preset/selected` — and returns the id it committed.
 */
export interface AgentPresetsSeam {
  /** The preset id used when a session names none. */
  readonly defaultId: string
  /** Every declared preset, broken ones included. */
  list(): Promise<readonly AgentPresetRow[]>
  /** Resolve one preset by id; throws when no declaration supplies it. */
  resolve(id?: string): Promise<AgentPresetRow>
  /** The preset id a joined agent is actually composed from, if any. */
  composedPreset(agentCtx: object): string | undefined
  /** Join an unpublished agent to a preset's standing composition; the only supported call site is `setup(agentCtx, agent)`. */
  mount(agentCtx: object, id?: string): Promise<AgentPresetRow>
  /**
   * Re-link one agent to a different preset's standing composition.
   *
   * The raw re-link, with no session check of its own: use it only where the
   * preset id does NOT change (a declaration that a blank session should pick
   * up live). A CHOICE between presets goes through {@link select}, which owns
   * the check and the record.
   */
  recompose(agentCtx: object, id: string): Promise<AgentPresetRow>
  /**
   * Switch a blank session's agent to another preset and record the switch.
   *
   * Harness's own operation, whole: it serializes concurrent selections per
   * session, re-reads the `turnBoundary` projection inside that queue, refuses
   * a session that has already started, recomposes the agent, and appends
   * `agent-preset/selected` only after the recomposition committed.
   * @param agent - the live agent whose session is switching.
   * @param agentPreset - the preset to switch to.
   * @returns the preset id Harness committed.
   */
  select(agent: PluginsAgent, agentPreset: string): Promise<string>
  /**
   * One declaration's child plugin list, rendered for reading.
   *
   * View-only by construction: the registry accepts no YAML back, so this is
   * the one composition read a frontend gets and the only one worth having.
   * @param agentPreset - the preset to read.
   * @returns the declared composition beside its published metadata.
   */
  readDocument(agentPreset: string): Promise<AgentPresetDocument>
}

/**
 * The `ctx.get('settings')` surface `/plugins` consumes: one write, setting the
 * `selectedDefault` field of the `agent-preset-registry` namespace — the field
 * upstream documents as "retains the user default, which new sessions resolve
 * over the deployment `default`", and the same write Harness's own General
 * settings row performs. `/plugins` never reads through this seam:
 * `AgentPresetsSeam.defaultId` already reports the resolved value.
 */
export interface PluginsSettings {
  /**
   * Apply a field patch to one namespace.
   * @param ns - the namespace to edit (`'agent-preset-registry'` for every call here).
   * @param patch - the fields to write, e.g. `{ selectedDefault: id }`.
   * @param expectedRevision - the revision the caller read; a stale one rejects.
   */
  update(ns: string, patch: Readonly<Record<string, unknown>>, expectedRevision?: number): Promise<void>
}

/** Which of the two optional seams this deployment mounts. */
export interface PluginsSeams {
  /** The preset roster and composition seam, when this profile mounts one. */
  readonly agentPresets: AgentPresetsSeam | undefined
  /** The settings seam, needed only to write `agent-presets.default`. */
  readonly settings: PluginsSettings | undefined
}

/**
 * Read the two seams `/plugins` needs off a context, without asserting that
 * either is mounted.
 * @param ctx - context carrying (or not carrying) the seams.
 * @returns the seams found.
 */
export function pluginsSeams(ctx: Context): PluginsSeams {
  return {
    agentPresets: ctx.get('agentPresets') as AgentPresetsSeam | undefined,
    settings: ctx.get('settings') as PluginsSettings | undefined,
  }
}
