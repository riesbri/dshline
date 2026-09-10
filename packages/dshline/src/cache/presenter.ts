/**
 * The `/cache` capability presenter.
 *
 * The report reads Harness's cumulative `tokenUsage` projection and the two
 * latest recorded request accessors; it owns no state of its own and offers no
 * mutation. This presenter owns the command, the surface, and the translation
 * from those authorities to a terminal reading, so `attachSession` supplies
 * only the session and the projection cut.
 * @module dshline/cache/presenter
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { LocalCommand } from '../local-commands.ts'
import type { TuiSlots } from '../slots.ts'
import { openSurface } from '../surface.ts'
import { cacheInspection, requestHeaderReading, routeContextReading } from './model.ts'
import { createCacheOverlay } from './overlay.ts'

/** Narrow dependencies the Cache presenter needs from the session runner. */
export interface CachePresenterDeps {
  /** Live-region registry that owns the overlay stack. */
  readonly slots: TuiSlots
  /** The attached session whose recorded request head the report names. */
  readonly session: Session
  /**
   * The authoritative projection cut, or undefined when the profile mounts no
   * registry.
   * @returns the current cut.
   */
  readonly snapshot: () => ProjectionSnapshot | undefined
}

/** The Cache capability as one local command. */
export interface CachePresenter {
  /** `/cache` — inspect how this session's prompt cache is behaving. */
  readonly command: LocalCommand
}

/**
 * Build the Cache presenter.
 * @param deps - the slot registry, the session, and the projection cut reader.
 * @returns the presenter's local command.
 */
export function createCachePresenter(deps: CachePresenterDeps): CachePresenter {
  return {
    command: {
      name: 'cache',
      description: "Inspect how this session's prompt cache is behaving",
      execute: () => {
        openSurface(deps.slots, close => createCacheOverlay({
          // One projection cut per paint, the same one `/usage` reads, so the two
          // inspectors cannot report different buckets for one moment. The two
          // records beside it are Harness's own accessors, read the same way.
          inspection: () => cacheInspection(
            deps.snapshot(),
            requestHeaderReading(deps.session),
            routeContextReading(deps.session),
          ),
          close,
        }))
      },
    },
  }
}
