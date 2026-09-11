/**
 * The `/context` capability presenter.
 *
 * The inspector is the hardest bounded surface dshline has: two stages, an
 * expensive per-node survey asked for only while it is open, a scrollable
 * listing with selection, and a temporary notice for a refused compaction. All
 * of that state is presentation-local — the projection and the token meter stay
 * the authorities — so it belongs to a presenter rather than to the session
 * runner. `attachSession` supplies the session, the projection cut, and the
 * registered `/compact` dispatch, and knows nothing else about the frame.
 * @module dshline/context/presenter
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { LocalCommand } from '../local-commands.ts'
import type { TuiSlots } from '../slots.ts'
import { openSurface } from '../surface.ts'
import { contextPreview, contextReading } from './model.ts'
import type { ContextSurvey } from './model.ts'
import { createContextOverlay } from './overlay.ts'

/** Narrow dependencies the Context presenter needs from the session runner. */
export interface ContextPresenterDeps {
  /** Live-region registry that owns the overlay stack. */
  readonly slots: TuiSlots
  /** The attached session whose surface is surveyed and previewed. */
  readonly session: Session
  /**
   * The cheap projection cut, or undefined when the profile mounts no registry.
   * @returns the current cut.
   */
  readonly snapshot: () => ProjectionSnapshot | undefined
  /** Expensive per-node survey; the surveyor decides when to remeasure. */
  readonly survey: () => ContextSurvey
  /** The selected route's advertised context window. */
  readonly capacity: () => number | undefined
  /**
   * Whether the running agent currently has a registered `/compact`.
   *
   * A live getter, not a snapshot: a scoped composition change while the
   * overlay is open must not leave the footer advertising a command that no
   * longer resolves.
   * @returns whether the command is currently available.
   */
  readonly canCompact: () => boolean
  /**
   * Run the REGISTERED Harness `/compact` command.
   * @returns a message when the request failed, else nothing.
   */
  readonly compact: () => Promise<string | undefined>
  /** Redraw after a keystroke or a settled compaction. */
  readonly invalidate: () => void
}

/** The Context capability as one local command. */
export interface ContextPresenter {
  /** `/context` — inspect what is occupying the model's context right now. */
  readonly command: LocalCommand
}

/**
 * Build the Context presenter.
 * @param deps - readers, the optional compaction command, and overlay controls.
 * @returns the presenter's local command.
 */
export function createContextPresenter(deps: ContextPresenterDeps): ContextPresenter {
  return {
    command: {
      name: 'context',
      description: "Inspect what is occupying the model's context right now",
      execute: () => {
        openSurface(deps.slots, close => createContextOverlay({
          reading: () => contextReading(deps.snapshot()),
          survey: deps.survey,
          preview: seq => contextPreview(deps.session, seq),
          capacity: deps.capacity,
          canCompact: deps.canCompact,
          compact: deps.compact,
          close,
          invalidate: deps.invalidate,
        }))
      },
    },
  }
}
