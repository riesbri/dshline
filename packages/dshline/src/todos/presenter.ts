/**
 * The `/todos` capability presenter.
 *
 * Opening a temporary terminal overlay is frontend-local, not a Harness-wide
 * command and not a Todo-domain mutation, so this presenter owns the command,
 * the surface, and the translation from the authoritative projection cut to a
 * terminal reading. The Harness `todos` projection stays the state authority;
 * `attachSession` supplies only the cut and the slot registry.
 * @module dshline/todos/presenter
 */

import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { LocalCommand } from '../local-commands.ts'
import type { TuiSlots } from '../slots.ts'
import { openSurface } from '../surface.ts'
import { todoReading } from './model.ts'
import { createTodoOverlay } from './overlay.ts'

/** Narrow dependencies the Todos presenter needs from the session runner. */
export interface TodosPresenterDeps {
  /** Live-region registry that owns the overlay stack. */
  readonly slots: TuiSlots
  /**
   * The authoritative projection cut, or undefined when the profile mounts no
   * registry.
   * @returns the current cut.
   */
  readonly snapshot: () => ProjectionSnapshot | undefined
}

/** The Todos capability as one local command. */
export interface TodosPresenter {
  /** `/todos` — inspect the current Harness todo list. */
  readonly command: LocalCommand
}

/**
 * Build the Todos presenter.
 * @param deps - the slot registry and the projection cut reader.
 * @returns the presenter's local command.
 */
export function createTodosPresenter(deps: TodosPresenterDeps): TodosPresenter {
  return {
    command: {
      name: 'todos',
      description: 'Inspect the current Harness todo list',
      execute: () => {
        openSurface(deps.slots, close => createTodoOverlay({
          reading: () => todoReading(deps.snapshot()),
          close,
        }))
      },
    },
  }
}
