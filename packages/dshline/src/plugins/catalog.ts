/**
 * Reading Harness's preset roster and one preset's composition, on demand.
 *
 * One pass reads the whole browser: the roster (`list()`), the active
 * session's actual preset (from the `agentPreset` Session projection Harness
 * maintains), the default a new session would get (`defaultId`), and the
 * composition of whichever preset is currently being BROWSED — which starts as
 * the session's own preset but can move without touching the session, so a
 * declaration's rows can be inspected before anything is switched. Between
 * passes this class holds a rendered snapshot and nothing else, the same
 * discipline `connect/catalog.ts` keeps: no preset list, no composition cache,
 * and no session mirror to fall out of date. `list()` and `readDocument()` are
 * unmemoized on the Harness side for exactly this reason — a roster is a live
 * set of declarations, and holding a private copy of it is how a frontend
 * disagrees with a composition someone just edited outside it.
 * @module dshline/plugins/catalog
 */

import type { CompositionTree } from './composition.ts'
import { parseComposition } from './composition.ts'
import type { AgentPresetRow, AgentPresetsSeam, PluginsSeams, PluginsSessionFacts } from './harness.ts'
import type { HostCapabilities } from './health.ts'
import type { PresetRow } from './model.ts'
import { presetRows } from './model.ts'

/** Which of the two optional seams this deployment mounts, joined with what the roster allows. */
export interface PluginsCapabilities {
  /** Whether `ctx.get('agentPresets')` is mounted at all. */
  readonly agentPresets: boolean
  /** Whether `ctx.get('settings')` is mounted, needed to write the default. */
  readonly settings: boolean
  /** Whether `ctx.get('configEditor')` is mounted, needed to edit a composition. */
  readonly configEditor: boolean
}

/** One preset's composition, as the browser currently reads it. */
export type BrowsedComposition =
  /** Parsed successfully. */
  | { readonly kind: 'rows'; readonly presetId: string; readonly tree: Extract<CompositionTree, { kind: 'parsed' }> }
  /** The preset's file could not be read or parsed as an entry list. */
  | { readonly kind: 'broken'; readonly presetId: string; readonly reason: string }

/** What one gathering pass produced. */
export type PluginsState =
  /** The first read has not landed yet. */
  | { readonly kind: 'loading' }
  /** This profile mounts no `agentPresets` seam; there is nothing to browse. */
  | { readonly kind: 'unavailable'; readonly message: string }
  /** Harness could not answer. */
  | { readonly kind: 'failed'; readonly message: string }
  /** A complete reading. */
  | {
    readonly kind: 'ready'
    readonly capabilities: PluginsCapabilities
    readonly presets: readonly PresetRow[]
    readonly defaultId: string
    readonly sessionPresetId: string | undefined
    readonly blank: boolean
    readonly browsing: BrowsedComposition
    /**
     * What the Host's own capability registries report, for the rows whose
     * backing can be proven. Read per pass, never held — see `health.ts`.
     */
    readonly host: HostCapabilities
  }

/** What the catalog needs from its owner. */
export interface PluginsCatalogSpec {
  /** The Harness seams to read. */
  readonly seams: PluginsSeams
  /**
   * Read the Host's capability registries. A function, not a snapshot: a
   * provider can register while the browser is open, and a pass that reused
   * an old list would keep reporting a row as unbacked after its backing
   * arrived.
   */
  readonly host: () => HostCapabilities
  /** The active agent's scope context, for `composedPreset`. */
  readonly agentCtx: object
  /**
   * Read the active session's current projected facts. A live accessor, not a
   * snapshot taken once at construction: the session this agent runs keeps
   * growing while `/plugins` may stay open across a `ctrl-r` refresh, so a
   * stale copy could go on reporting a session as blank after it had already
   * started.
   */
  readonly session: () => PluginsSessionFacts
  /** Redraw after a pass lands. */
  readonly invalidate: () => void
}

/** Reads Harness's preset roster and one preset's composition, on demand. */
export class PluginsCatalog {
  private current: PluginsState = { kind: 'loading' }
  private generation = 0
  private disposed = false
  private browsingOverride: string | undefined

  /**
   * @param spec - the seams, agent, and session to read, and the redraw to call.
   */
  constructor(private readonly spec: PluginsCatalogSpec) {}

  /** The most recent complete reading, or what is standing in for one. */
  state(): PluginsState {
    return this.current
  }

  /**
   * Browse a different preset's composition without touching the session.
   *
   * This is how a system preset gets copied and then edited in the same
   * browser session: the copy changes what a NEW preset id resolves to, and
   * this is what points the browser at it, entirely independent of whether
   * the active session ever recomposes.
   * @param presetId - the preset to browse from the next pass on.
   */
  browse(presetId: string): void {
    this.browsingOverride = presetId
    this.refresh()
  }

  /**
   * Start a fresh pass over the roster and the browsed preset's composition.
   *
   * Never awaited by the caller, matching `connect/catalog.ts`: the browser
   * is already on screen, and a read that has not landed shows the previous
   * reading rather than a blank frame.
   */
  refresh(): void {
    if (this.disposed) return
    const generation = ++this.generation
    void this.gather()
      .then(next => { this.settle(generation, next) })
      .catch((error: unknown) => {
        this.settle(generation, { kind: 'failed', message: messageOf(error) })
      })
  }

  /** Abandon in-flight passes; their results would repaint a closed browser. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
  }

  /**
   * Adopt a pass's result when it is still the newest one.
   * @param generation - the pass's stamp.
   * @param next - what it read.
   */
  private settle(generation: number, next: PluginsState): void {
    if (this.disposed || generation !== this.generation) return
    this.current = next
    this.spec.invalidate()
  }

  /**
   * Read the roster and one preset's composition once, and join them.
   * @returns the complete reading.
   */
  private async gather(): Promise<PluginsState> {
    const { agentPresets, settings } = this.spec.seams
    if (agentPresets === undefined) {
      return { kind: 'unavailable', message: 'agent presets are not available in this Harness profile' }
    }
    const capabilities: PluginsCapabilities = {
      agentPresets: true,
      settings: settings !== undefined,
      configEditor: this.spec.seams.configEditor !== undefined,
    }
    const opening = this.spec.session()
    const [presets, defaultId, sessionPresetId] = await Promise.all([
      agentPresets.list(),
      Promise.resolve(agentPresets.defaultId),
      Promise.resolve(agentPresets.composedPreset(this.spec.agentCtx) ?? opening.presetId),
    ])
    const browsingId = this.browsingOverride ?? sessionPresetId ?? defaultId
    const target = presets.find(preset => preset.id === browsingId)
    const browsing = await this.readComposition(agentPresets, browsingId, target)
    return {
      kind: 'ready',
      capabilities,
      presets: presetRows(presets, sessionPresetId, defaultId),
      defaultId,
      sessionPresetId,
      // Re-read after the awaits rather than reusing `opening`: a turn can
      // start while the roster and the composition file are being read, and
      // the pass reports what is true when it lands.
      blank: !this.spec.session().started,
      browsing,
      host: this.spec.host(),
    }
  }

  /**
   * Read and parse one preset's composition, reporting a broken read rather
   * than throwing out of the pass.
   *
   * The roster's own `broken` is authoritative and checked FIRST: if Harness
   * already knows this preset cannot be mounted, that reason is reported
   * as-is, without dshline's own parser getting a vote — a declaration this
   * parser happens to accept is not proof of health, only that this module can
   * make presentational sense of it. Harness decides preset health; this only
   * decides what a healthy declaration's rows look like.
   * @param agentPresets - the preset seam.
   * @param presetId - the preset to read.
   * @param rosterEntry - this preset's own roster row, when it is still listed.
   * @returns the browsed composition, parsed or broken.
   */
  private async readComposition(
    agentPresets: AgentPresetsSeam,
    presetId: string,
    rosterEntry: AgentPresetRow | undefined,
  ): Promise<BrowsedComposition> {
    if (rosterEntry?.broken !== undefined) {
      return { kind: 'broken', presetId, reason: rosterEntry.broken }
    }
    let content: string
    try {
      // The registry renders the declared child list back as the Loader's own
      // entry-list YAML, `!!js` conditions included, and accepts nothing in
      // return. That makes this a genuinely read-only view of the composition.
      content = (await agentPresets.readDocument(presetId)).content
    } catch (error) {
      return { kind: 'broken', presetId, reason: messageOf(error) }
    }
    const tree = parseComposition(content)
    if (tree.kind === 'broken') return { kind: 'broken', presetId, reason: tree.reason }
    return { kind: 'rows', presetId, tree }
  }
}

/**
 * A message for a failure, without leaking an object's shape into the UI.
 * @param error - whatever was thrown.
 * @returns the sentence to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
