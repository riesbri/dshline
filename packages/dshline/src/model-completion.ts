/**
 * The derived `/model` completion catalog.
 *
 * Harness owns which providers and models exist: `/model`'s argument list is
 * exactly `listProviders()` joined with one `listModels(provider)` per route.
 * That read is cheap to keep correct and expensive to repeat — completion
 * recomputes it on every keystroke and every cursor move inside a `/model`
 * argument, so an edit sequence of N issued N full provider fan-outs while only
 * the last could ever be shown.
 *
 * This holds ONE derived snapshot and nothing else. It is not a model registry:
 * every value in it came from Harness, a Harness event can discard it at any
 * time, and the next request rebuilds it from scratch. `pickModel` and the
 * subagent editor keep reading Harness directly, so this can never become the
 * authority on what a route offers.
 *
 * A read is generation-stamped and single-flight. Callers that arrive while one
 * is in flight share it; an invalidation claims a newer generation, so a read
 * that straddled it can neither install its result nor be joined by a later
 * caller. `listModels` takes no `AbortSignal`, so an invalidated read is not
 * cancelled — it is allowed to finish and its result is discarded.
 *
 * Only a COMPLETE reading is cached. A reading with a failed route is partial,
 * and caching it would keep that route missing until the next Harness event;
 * leaving it uncached makes the next request retry, which is what the
 * uncached path always did.
 * @module dshline/model-completion
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only, for the `Context` event-map merges this module subscribes to
// (`llm/adapters-updated`, `settings/updated`). The services are optional peers
// read through their types, never their runtime code.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type { LocalCommandChoice } from './local-commands.ts'
import type { ModelCompletionReading } from './model.ts'

/**
 * A single-slot, Harness-invalidated cache of `/model`'s completion values.
 *
 * Constructed once per session attachment and disposed with it, so a reopened
 * session starts from Harness rather than an earlier session's routes.
 */
export class ModelCompletionCatalog {
  /** The newest complete reading, or none before the first one lands. */
  private current: readonly LocalCommandChoice[] | undefined
  /** One shared read for every caller of the current generation. */
  private inflight: Promise<ModelCompletionReading> | undefined
  /** Bumped by invalidation, so a read that straddled it cannot install. */
  private generation = 0
  /** Terminal: no further read starts and no late result installs. */
  private disposed = false

  /**
   * @param read - one complete discovery of `/model`'s values and whether every
   *   route answered. The caller owns the Harness read; this class owns only
   *   when it is repeated.
   */
  constructor(private readonly read: () => Promise<ModelCompletionReading>) {}

  /**
   * The completion values for `/model`'s argument.
   *
   * Returns the cached reading when there is one, otherwise joins the read in
   * flight, otherwise starts one. A caller whose read was invalidated while it
   * was running does not receive that stale reading: it loops onto the newest
   * generation, which is the same generation every later caller asks for.
   * @returns the values, or none when the catalog was disposed.
   */
  async completions(): Promise<readonly LocalCommandChoice[]> {
    for (;;) {
      if (this.current !== undefined) return this.current
      if (this.disposed) return []
      const generation = this.generation
      const run = this.inflight ?? this.start()
      let reading: ModelCompletionReading
      try {
        reading = await run
      } catch (error) {
        // A rejected read that straddled an invalidation describes a
        // configuration that no longer exists, so it is retried on the newest
        // generation rather than reported for one the caller is not asking
        // about. Only a failure of the current generation is surfaced.
        if (generation !== this.generation) continue
        throw error
      }
      // An invalidation landed while this generation was in flight. Its answer
      // describes a configuration that no longer exists, so the caller is owed
      // one started after the change rather than this one.
      if (generation === this.generation) return reading.values
    }
  }

  /**
   * Discard the snapshot because Harness may have changed what it read.
   *
   * Synchronous, not coalesced onto a microtask: a caller that asks for values
   * in the same turn as the event must not be served the snapshot the event
   * just invalidated. The work is already coalesced where it matters — dropping
   * the snapshot costs nothing, and one lazy read serves every later request.
   */
  invalidate(): void {
    if (this.disposed) return
    this.generation += 1
    this.current = undefined
    this.inflight = undefined
  }

  /** Stop accepting reads. Late results from an in-flight read are discarded. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.current = undefined
    this.inflight = undefined
  }

  /**
   * Begin one read and adopt its result only while it is still the newest and
   * every route answered.
   * @returns the shared promise for this generation's read.
   */
  private start(): Promise<ModelCompletionReading> {
    const generation = this.generation
    const run = this.read().then(reading => {
      if (!this.disposed && generation === this.generation && reading.complete) {
        this.current = reading.values
      }
      return reading
    })
    this.inflight = run
    // Clear the slot only if this pass still owns it. An invalidation replaces
    // `inflight`, and an older pass finishing must not clear the newer one.
    const clear = (): void => { if (this.inflight === run) this.inflight = undefined }
    // Attached as a handler, not a second branch on the returned promise: the
    // original `run` still rejects for its awaiters.
    void run.then(clear, clear)
    return run
  }
}

/**
 * Discard the catalog whenever Harness could have changed what it read.
 *
 * Two feeds, established from the adapters this generation ships. The registry
 * announces a route set or configurable-provider directory change with
 * `llm/adapters-updated`. `settings/updated` is the resolved-value commit each
 * adapter's `listModels` actually reads: a `models` or `modelOverrides` edit
 * changes an already-registered route's catalog WITHOUT re-registering it, so
 * no registry event fires. The other settings and credential events do not bear
 * on catalog membership — `settings/document-updated` is a raw-section revision
 * for configuration surfaces, and credentials gate authentication on the
 * request path, not which models a route advertises.
 *
 * The subscriptions are owned by the caller's scope, so a disposed session
 * stops invalidating a catalog nobody can reach.
 * @param ctx - context carrying the registry and settings event vocabulary.
 * @param catalog - the catalog to invalidate.
 * @returns the disposer removing both subscriptions.
 */
export function watchModelCompletion(ctx: Context, catalog: ModelCompletionCatalog): () => void {
  const disposers = [
    ctx.on('llm/adapters-updated', () => { catalog.invalidate() }),
    ctx.on('settings/updated', () => { catalog.invalidate() }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
