/**
 * Session-scoped observation of Harness projection snapshots.
 *
 * The registry remains the state authority: change notifications only coalesce
 * a later redraw, and every consumer reads its value from `snapshot(session)`.
 * @module dshline/projections/observer
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type {
  ProjectionSnapshot,
  SessionProjectionMap,
  SessionProjectionRegistry,
} from '@deepseek-ai/dsh-session-projection'

/** One registered client-visible projection unit, by name. */
export type ProjectionKey = Extract<keyof SessionProjectionMap, string>

/** Inputs the shared session-projection observer needs from the runner. */
export interface SessionProjectionObserverSpec {
  /** Optional Harness registry; custom profiles may omit the entire seam. */
  readonly registry: SessionProjectionRegistry | undefined
  /** Exact session instance whose views this observer serves. */
  readonly session: Session
  /** Request a live-region redraw after the registry's synchronous drive settles. */
  readonly invalidate: () => void
}

/**
 * Observe one exact session's optional Harness projection registry.
 *
 * The registry calls listeners once for every changing unit while it drives one
 * event. Deferring one invalidation to a microtask prevents a view render from
 * synchronously re-entering that drive and makes several unit changes one redraw.
 */
export class SessionProjectionObserver {
  private alive = true
  private pending = false
  private readonly unsubscribe: (() => void) | undefined

  /**
   * @param spec - optional registry, exact session identity, and redraw request.
   */
  constructor(private readonly spec: SessionProjectionObserverSpec) {
    const { registry, session } = spec
    this.unsubscribe = registry?.onChanged(changedSession => {
      // Session ids are durable names, not an authority boundary. A replacement
      // instance with the same id must never redraw this agent's presentation.
      if (changedSession !== session || this.pending) return
      this.pending = true
      queueMicrotask(() => {
        this.pending = false
        if (this.alive) spec.invalidate()
      })
    })
  }

  /** Whether this profile mounted the generic projection infrastructure. */
  get available(): boolean {
    return this.spec.registry !== undefined
  }

  /**
   * Read the registry's authoritative current cut for this exact session.
   *
   * `keys` narrows which client-visible VIEWS are produced and validated, which
   * is the whole cost of an unkeyed read on a line redrawn by every spinner beat:
   * every unit a profile has registered is folded, viewed, and passed through its
   * own `viewSchema` on the way out, whether or not this caller reads a field of
   * it. Naming the units a consumer actually reads therefore buys nothing in
   * authority — the cut is the registry's, state materialization still covers
   * every unit, and the same `asOfSeq` position — while leaving the units nobody
   * reads unviewed.
   * @param keys - the units this consumer reads, or every unit when omitted.
   * @returns the snapshot, or undefined when the optional registry is absent.
   */
  snapshot(keys?: readonly ProjectionKey[]): ProjectionSnapshot | undefined {
    return this.spec.registry?.snapshot(this.spec.session, keys)
  }

  /** Stop observing and suppress an already-queued redraw. */
  dispose(): void {
    if (!this.alive) return
    this.alive = false
    this.unsubscribe?.()
  }
}
