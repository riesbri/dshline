/**
 * The exact Harness surfaces this frontend consumes for agent presets, and
 * nothing else — read by `/plugins` and by `window.ts`'s per-agent
 * composition alike, since both are the same one seam.
 *
 * Two seams answer everything either caller needs:
 *
 * ```
 * ctx.get('agentPresets')   the preset roster, one preset's composition text,
 *                           joining/recomposing an agent, and copy/remove
 * ctx.get('settings')       the `agent-presets.default` setting, written
 *                           through the same path/op contract every namespace
 *                           uses
 * ```
 *
 * Neither VALUE is imported from `@deepseek-ai/dsh-agent-presets` or
 * `@deepseek-ai/dsh-settings`. This mirrors `connect/harness.ts`'s own choice
 * for the same reason: a profile that mounts neither service still starts —
 * `/plugins` degrades instead of failing to open, and an agent this frontend
 * attaches simply keeps whatever the host layer already composed, exactly
 * as before presets existed here — and a structural shape costs nothing at
 * the few call sites that use it. Every field below is copied from the
 * published `@deepseek-ai/dsh-agent-presets` source, not guessed —
 * `AgentPresetRow`'s shape, `mount`/`recompose`'s real return type
 * (`AgentPresetRow`, not a bespoke "read" type), `select`'s committed-id
 * return, and `ensureStanding`'s mtime+size stamp (the reason a blank
 * session's `recompose` after a file edit picks up the new generation, and a
 * started session's does not) all come from
 * `packages/preset/agent-presets/src/index.ts` in deepseek-harness.
 *
 * The type-only imports below are a different thing from a runtime
 * dependency, and are the Harness-native way to reach a projection key: they
 * carry nothing but the `declare module` augmentations that put `agentPreset`
 * and `turnBoundary` in `SessionProjectionStateMap`, so {@link sessionFacts}
 * can name them without the optional packages being installed, let alone
 * mounted. Nothing here imports a value from either.
 * @module dshline/plugins/harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// The `turnBoundary` projection key, which `dsh-agent` declares and
// `dsh-agent-loop` registers.
import type {} from '@deepseek-ai/dsh-agent'
// The `agentPreset` projection key, which `dsh-agent-presets` declares and
// registers. `/types` is its client-safe, path-free module: no service, no
// filesystem, nothing but the declarations.
import type {} from '@deepseek-ai/dsh-agent-presets/types'

/** Whether a preset ships with the deployment or was authored locally. */
export type PresetTrust = 'system' | 'user'

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
  return {
    presetId: projections.stateOf(session, 'agentPreset') ?? undefined,
    started: boundary !== undefined && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0),
  }
}

/** One preset as the roster reports it — never composition rows. */
export interface AgentPresetRow {
  /** The preset's id; also its directory name. */
  readonly id: string
  /** Whether this preset ships with the deployment or was authored locally. */
  readonly trust: PresetTrust
  /** Absolute path to the preset's composition file (`agent.cordis.yml`), not its directory. */
  readonly path: string
  /** Display name; falls back to `id` when absent. */
  readonly name?: string
  /** One-line description. */
  readonly description?: string
  /** Declared ordering hint among presets. */
  readonly order?: number
  /**
   * Human-readable reason this preset cannot be mounted, when it cannot.
   * Present on the roster row rather than hiding the preset — a broken preset
   * still needs to be seen so it can be fixed or removed.
   */
  readonly broken?: string
}

/**
 * The `ctx.get('agentPresets')` surface this frontend consumes — read by
 * `/plugins` (browsing, toggling, switching), and by `window.ts`'s
 * `attachOptions` (composing every agent it attaches from its resolved
 * preset, the reason a composition exists for `/plugins` to browse at all).
 * One structural shape for both, rather than two drifting copies of the same
 * real service.
 *
 * `mount`/`recompose` return the `AgentPresetRow` now installed, matching
 * the real service exactly — not `Promise<void>`, and not a distinct "read"
 * type. Both methods' own docs say the caller owns the blank-session and
 * unpublished-agent checks, and callers here perform those themselves
 * (`window.ts` for the composition an attachment mounts, `index.ts` for the
 * live pickup a file edit earns).
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
  /** Whether this deployment has a root locally authored presets can go to. */
  readonly authorable: boolean
  /** Every preset this roster's roots supply, broken ones included. */
  list(): Promise<readonly AgentPresetRow[]>
  /** Resolve one preset by id; throws when no root supplies it. */
  resolve(id?: string): Promise<AgentPresetRow>
  /** The preset id a joined agent is actually composed from, if any. */
  composedPreset(agentCtx: object): string | undefined
  /** Join an unpublished agent to a preset's standing composition; the only supported call site is `setup(agentCtx, agent)`. */
  mount(agentCtx: object, id?: string): Promise<AgentPresetRow>
  /**
   * Re-link one agent to a different preset's standing composition.
   *
   * The raw re-link, with no session check of its own: use it only where the
   * preset id does NOT change (a file edit a blank session should pick up
   * live). A CHOICE between presets goes through {@link select}, which owns
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
  /** One preset's composition text, exactly as stored. */
  read(id: string): Promise<string>
  /** Create a locally authored preset by copying an existing one whole. */
  copy(from: string, id: string, name?: string): Promise<void>
  // The real service also exposes `remove(id)`. It is deliberately absent
  // here: this is the set of surfaces this frontend CONSUMES, and declaring a
  // destructive one it never calls would make every test double implement a
  // deletion path nothing exercises, while reading as though `/plugins` can
  // delete a preset. Add it in the same change that first offers deletion.
}

/** One `{ op, path }` edit against a namespace's stored user section. */
export type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/**
 * The `ctx.get('settings')` surface `/plugins` consumes: one write, to the
 * `agent-presets` namespace's `default` field. `/plugins` never reads through
 * this seam — `AgentPresetsSeam.defaultId` already reports the resolved
 * value, layering included.
 */
export interface PluginsSettings {
  /**
   * Apply ordered path edits to one namespace's user section.
   * @param ns - the namespace to edit (`'agent-presets'` for every call here).
   * @param ops - the edits, applied in order.
   * @param expectedRevision - the revision the caller read; a stale one rejects.
   */
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
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
