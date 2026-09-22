/**
 * Integration seam for the current-session hub.
 *
 * The presenter owns the small adaptation from a runner's ordinary overlay-push
 * callback to the factory close handshake required by nested session children.
 * The hub itself remains pure presentation and receives no Harness context.
 * @module dshline/session/presenter
 */

import type { TuiOverlay } from '../slots.ts'
import { openSurface } from '../surface.ts'
import { createCurrentSessionHubOverlay, type CurrentSessionHubOverlaySpec } from './overlay.ts'

/** A runner-owned normal overlay stack push. */
export type CurrentSessionHubPush = (overlay: TuiOverlay) => () => void

/** Inputs needed to open one current-session hub from a session runner. */
export type CurrentSessionHubPresenterDeps = Omit<
  CurrentSessionHubOverlaySpec,
  'push' | 'close'
> & {
  /** Push an overlay onto the runner's normal stack and return its dismisser. */
  readonly push: CurrentSessionHubPush
}

/** The current-session hub's integration API. */
export interface CurrentSessionHubPresenter {
  /** Open the hub and return an idempotent close function. */
  readonly open: () => () => void
}

/**
 * Create an integration API for the current-session hub.
 * @param deps - owner-owned reading, capabilities, callbacks, and normal stack push.
 * @returns an opener that keeps nested child overlays on the same normal stack.
 */
export function createCurrentSessionHubPresenter(
  deps: CurrentSessionHubPresenterDeps,
): CurrentSessionHubPresenter {
  const stack = { pushOverlay: deps.push }
  // This adapter belongs here rather than in `sessions/`: a child can request
  // close before a runner has returned its disposer, and openSurface preserves
  // that stack contract without teaching the existing catalog browser about a
  // second presentation entry point.
  const push = (create: (close: () => void) => TuiOverlay): void => {
    openSurface(stack, create)
  }
  return {
    open: () => openSurface(stack, close => createCurrentSessionHubOverlay({
      reading: deps.reading,
      capabilities: deps.capabilities,
      ...(deps.navigator === undefined ? {} : { navigator: deps.navigator }),
      ...(deps.openTurns === undefined ? {} : { openTurns: deps.openTurns }),
      ...(deps.rename === undefined ? {} : { rename: deps.rename }),
      ...(deps.focusLineage === undefined ? {} : { focusLineage: deps.focusLineage }),
      home: deps.home,
      now: deps.now,
      push,
      close,
      invalidate: deps.invalidate,
    })),
  }
}
