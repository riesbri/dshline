/**
 * The `/turns` capability presenter.
 *
 * `/turns` is a Dshline-local command, not a Harness-wide one: it opens a
 * temporary bounded terminal surface over the authoritative `turnOutline`
 * projection, and the projection stays the state authority. `attachSession`
 * supplies only the projection cut, the slot registry, a redraw request, and the
 * optional workspace-change adapter, and learns nothing about filtering,
 * selection, or how a turn is inspected.
 *
 * Four surfaces are opened through the shared kernel — the outline, the turn
 * inspection, the changed-file list, and a per-file comparison — and navigation
 * between them is the kernel's own overlay stack, so Escape pops one level
 * without any special "sometimes back" state in `surface.ts`.
 *
 * The presenter also owns the LIFETIME of those surfaces, which the overlay
 * stack does not: overlays belong to the process-wide `TuiSlots` service, so
 * without {@link TurnsPresenter.dispose} an open `/turns` would survive the
 * session that opened it and keep taking keystrokes — and keep a comparison read
 * in flight — after the reader has already moved to a different session. The
 * attachment owns the presenter through its `SessionScope`, so teardown closes
 * every level and aborts every read it started.
 * @module dshline/turns/presenter
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { LocalCommand } from '../local-commands.ts'
import type { TuiOverlay, TuiSlots } from '../slots.ts'
import { openSurface } from '../surface.ts'
import type { ChangedFileRow, TurnChangesReading, WorkspaceChangesAdapter } from './changes.ts'
import { createFileDiffOverlay } from './diff-overlay.ts'
import { turnReading } from './model.ts'
import { createTurnFilesOverlay, createTurnInspectionOverlay, createTurnsOverlay } from './overlay.ts'

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
  /**
   * The attachment's workspace-change adapter, or undefined when this
   * composition mounts no `workspaceChanges` row.
   *
   * Owned by the attachment, not created here: the adapter holds a live event
   * fold and a pending historical read, both of which belong to the session
   * rather than to whichever `/turns` surface happens to be open.
   */
  readonly changes?: WorkspaceChangesAdapter
  /** Redraw after a keystroke that changed presentation state. */
  readonly invalidate: () => void
}

/** The Turns capability's internal entry point and local command. */
export interface TurnsPresenter {
  /**
   * Open the session outline directly, optionally pre-filtered.
   * @param initialQuery - an optional initial filter query.
   */
  readonly open: (initialQuery?: string) => void
  /** `/turns` — browse the session's turns and inspect one read-only. */
  readonly command: LocalCommand
  /** Close every surface this presenter opened and release their resources. */
  readonly dispose: () => void
}

/**
 * Build the Turns presenter.
 * @param deps - the slot registry, the projection cut reader, the optional
 *   workspace-change adapter, and the redraw request.
 * @returns the presenter entry point, local command, and teardown.
 */
export function createTurnsPresenter(deps: TurnsPresenterDeps): TurnsPresenter {
  // Every level this presenter opens, newest last. `openSurface` hands back the
  // dismisser, and a surface that closes on its own removes itself from the
  // stack but not from this list, so a later teardown calls a dismisser that is
  // already a no-op — which `TuiSlots` makes idempotent by identity.
  const opened: (() => void)[] = []
  /**
   * Mount one bounded surface and remember how to take it down.
   * @param create - builds the overlay, given the callback that closes it.
   * @returns the dismisser for that one surface.
   */
  const mount = (create: (close: () => void) => TuiOverlay): (() => void) => {
    const close = openSurface(deps.slots, create)
    opened.push(close)
    return close
  }
  const change = (turn: number): TurnChangesReading =>
    deps.changes?.reading(turn) ?? { kind: 'unmounted' }

  /**
   * Push the per-file comparison over the changed-file list.
   *
   * The one place a `workspaceChanges.diff` request is issued, and the only one
   * reachable from a keystroke. The surface owns the AbortController and aborts
   * it when it closes, so walking back to the list and opening another file
   * leaves the previous read cancelled rather than racing the new one.
   * @param file - the disclosed file row.
   * @param seq - the announcing event's sequence number.
   */
  const openDiff = (file: ChangedFileRow, seq: number): void => {
    if (deps.changes === undefined) return
    mount(close => createFileDiffOverlay({
      file,
      request: (row, signal) => { return deps.changes?.diff(seq, row.index, signal) ?? Promise.resolve(undefined) },
      invalidate: deps.invalidate,
      close,
    }))
  }

  /**
   * Push the changed-file list over the turn inspection surface.
   *
   * Enter here is the reader's DISCLOSURE, and it is the only moment that may
   * start the one historical log read. A turn this Host never recorded has no
   * live announcement, so without this call its changed files would be
   * indistinguishable from a turn that changed nothing.
   * @param turn - the addressed turn's Harness-assigned number.
   */
  const openFiles = (turn: number): void => {
    if (deps.changes !== undefined) deps.changes.requestHistory(turn)
    mount(close => createTurnFilesOverlay({
      reading: () => change(turn),
      open: openDiff,
      invalidate: deps.invalidate,
      close,
    }))
  }

  /**
   * Push the read-only inspection surface over the outline.
   *
   * A second bounded surface rather than a stage inside the first: Escape then
   * closes exactly the top surface and the outline underneath is still there,
   * which is the kernel's own contract instead of a new one.
   * @param initialSeq - the selected turn's stable `turn/start` seq.
   */
  const openInspection = (initialSeq: SessionSeq): void => {
    mount(close => createTurnInspectionOverlay({
      reading: () => turnReading(deps.snapshot()),
      initialSeq,
      ...deps.changes === undefined ? {} : { changes: change },
      openChanges: openFiles,
      invalidate: deps.invalidate,
      close,
    }))
  }
  const open = (initialQuery?: string): void => {
    mount(close => createTurnsOverlay({
      reading: () => turnReading(deps.snapshot()),
      ...deps.changes === undefined ? {} : { changes: change },
      ...initialQuery === undefined ? {} : { initialQuery },
      inspect: openInspection,
      invalidate: deps.invalidate,
      close,
    }))
  }
  return {
    open,
    command: {
      name: 'turns',
      description: "Browse this session's turns and inspect one",
      execute: rawInput => { open(rawInput.trim() === '' ? undefined : rawInput.trim()) },
    },
    dispose(): void {
      // Newest first, so the comparison goes down before the list it was pushed
      // over and the list before the inspection it was pushed over. Each aborts
      // its own pending read as it closes.
      for (const close of opened.splice(0).reverse()) close()
    },
  }
}
