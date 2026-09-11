/**
 * The `/turns` capability presenter.
 *
 * `/turns` is a Dshline-local command, not a Harness-wide one: it opens a
 * temporary bounded terminal surface over the authoritative `turnOutline`
 * projection, and the projection stays the state authority. `attachSession`
 * supplies only the projection cut, the slot registry, and a redraw request,
 * and learns nothing about filtering, selection, or how a turn is inspected.
 *
 * Two surfaces are opened through the shared kernel: the outline, and a
 * read-only inspection surface pushed over it. Navigation between them is the
 * kernel's own overlay stack, so Escape pops one level without any special
 * "sometimes back" state in `surface.ts`.
 * @module dshline/turns/presenter
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { LocalCommand } from '../local-commands.ts'
import type { TuiSlots } from '../slots.ts'
import { openSurface } from '../surface.ts'
import { turnReading } from './model.ts'
import { createTurnInspectionOverlay, createTurnsOverlay } from './overlay.ts'

/** Narrow dependencies the Turns presenter needs from the session runner. */
export interface TurnsPresenterDeps {
  /** Live-region registry that owns the overlay stack. */
  readonly slots: TuiSlots
  /**
   * The authoritative projection cut, or undefined when the profile mounts no
   * registry. Read fresh on every paint; no turn list is copied here.
   * @returns the current cut.
   */
  readonly snapshot: () => ProjectionSnapshot | undefined
  /** Redraw after a keystroke that changed presentation state. */
  readonly invalidate: () => void
}

/** The Turns capability as one local command. */
export interface TurnsPresenter {
  /** `/turns` — browse the session's turns and inspect one read-only. */
  readonly command: LocalCommand
}

/**
 * Build the Turns presenter.
 * @param deps - the slot registry, the projection cut reader, and redraw request.
 * @returns the presenter's local command.
 */
export function createTurnsPresenter(deps: TurnsPresenterDeps): TurnsPresenter {
  /**
   * Push the read-only inspection surface over the outline.
   *
   * A second bounded surface rather than a stage inside the first: Escape then
   * closes exactly the top surface and the outline underneath is still there,
   * which is the kernel's own contract instead of a new one.
   * @param initialSeq - the selected turn's stable `turn/start` seq.
   */
  const openInspection = (initialSeq: SessionSeq): void => {
    openSurface(deps.slots, close => createTurnInspectionOverlay({
      reading: () => turnReading(deps.snapshot()),
      initialSeq,
      invalidate: deps.invalidate,
      close,
    }))
  }
  return {
    command: {
      name: 'turns',
      description: "Browse this session's turns and inspect one",
      execute: rawInput => {
        openSurface(deps.slots, close => createTurnsOverlay({
          reading: () => turnReading(deps.snapshot()),
          ...(rawInput.trim() === '' ? {} : { initialQuery: rawInput.trim() }),
          inspect: openInspection,
          invalidate: deps.invalidate,
          close,
        }))
      },
    },
  }
}
