/**
 * Grouping the authoritative session corpus by working directory, for as long
 * as the picker is open.
 *
 * One authority, and it is the one that is already shared across terminals:
 *
 * ```text
 * ctx.sessionQuery.listSessions()   the logical corpus — a fresh
 *                                   sessionPersistence.list() merged with this
 *                                   process's live sessions, newest first
 *       ↓ group by exact header.cwd
 * worktree rows                     transient, never persisted
 *       ↓ select one
 * SessionCatalog { kind: 'cwd', cwd }   the same catalog /sessions uses
 * ```
 *
 * The corpus was chosen over a durable workspace registry deliberately, and
 * the reason is a property of the adopted Harness generation rather than a
 * preference. `/worktrees` exists to serve several dshline processes working
 * in several directories at once, and at this generation the durable
 * domain-storage stack is single-process by its own documentation:
 * `dsh-storage-domain` states that memory is authoritative for an open domain
 * and that `domain/changed` is in-process, so "a second host process observes
 * no changes"; `dsh-storage-json` states there is "no cross-process write
 * locking" and that concurrent writers to one unit are last-completion-wins.
 * A feature whose whole point is several simultaneous terminals cannot be
 * built on shared mutable state with those properties. Session persistence is
 * the opposite shape: one artifact per session, one live writer per session,
 * and a fresh listing on every corpus read — so distinct sessions in distinct
 * directories are exactly what it already models well.
 *
 * The second view is NOT a second session browser. It is the very
 * `SessionCatalog` `/sessions` uses, scoped to the selected cwd, so corpus
 * order, title folding, filtering, and cancellation stay in dshline's one
 * implementation of them. Because a row is DEFINED as "sessions whose header
 * records exactly this cwd", the count in the first view and the rows in the
 * second are the same relationship read twice, not two authorities compared.
 * @module dshline/worktrees/catalog
 */

import type { SessionCatalogSpec, SessionQueryReads } from '../sessions/catalog.ts'
import { SessionCatalog } from '../sessions/catalog.ts'
import type { SessionFiltersValue } from '../sessions/filters.ts'
import type { CatalogState } from '../sessions/model.ts'
import type { WorktreeListing, WorktreeRow, WorktreeSelection } from './model.ts'
import { worktreeRows } from './model.ts'

/**
 * The filters one directory's session listing runs under.
 *
 * `workspace: 'current'` is what turns the catalog's injected scope into a
 * real `cwd` clause; the other two are deliberately wide open. Narrowing by
 * age or origin is the corpus question `/sessions` answers with `ctrl-f`, and
 * hiding a delegated child here would make the second view disagree with the
 * count in the first for no reason a reader asked for.
 */
const CWD_ONLY: SessionFiltersValue = { workspace: 'current', origin: 'all', age: 'all' }

/** What the catalog needs from its owner. */
export interface WorktreeCatalogSpec {
  /** The mounted session-query engine, or undefined in a profile without one. */
  readonly query: SessionQueryReads | undefined
  /** Redraw after catalog state changes. */
  readonly invalidate: () => void
  /**
   * The attached session's own `SessionHeader.cwd`, when its header records one.
   *
   * Exactly that, and nothing substituted for it. The launch directory is
   * deliberately NOT a fallback here: a session whose header names no
   * directory belongs to no group, and marking the group that happens to match
   * the process's startup cwd would claim the current conversation is rooted
   * somewhere its own header never said. Undefined means no row is current,
   * which is the honest answer.
   *
   * This is narrower than the attachment's effective workspace (`header.cwd ??
   * startup.cwd`), which tools, skills, and the composer correctly keep using
   * — an operational directory has to resolve to something, while this
   * presentation fact does not.
   */
  readonly currentCwd?: string
  /** Current time source, passed through to the session catalog. */
  readonly now?: () => number
}

/** The transient cwd grouping behind the `/worktrees` picker. */
export class WorktreeCatalog {
  private listingState: WorktreeListing
  private selectedCwd: string | undefined
  private sessions: SessionCatalog | undefined
  private generation = 0
  private abort: AbortController | undefined
  private disposed = false

  constructor(private readonly spec: WorktreeCatalogSpec) {
    this.listingState = spec.query === undefined ? { kind: 'unavailable' } : { kind: 'loading' }
  }

  /** The current worktree listing. */
  listing(): WorktreeListing {
    return this.listingState
  }

  /**
   * Read the corpus and regroup it.
   *
   * One `listSessions()` and nothing else: the whole corpus is needed because
   * the grouping is over every stored cwd, and a bounded listing would make a
   * directory's presence depend on how many sessions happen to be newer than
   * it. No titles are read here — a row's label is derived from its path, so
   * the batched title observation the session browser pays for is not needed
   * until a directory is actually opened.
   */
  refresh(): void {
    const query = this.spec.query
    if (query === undefined || this.disposed) return
    const generation = (this.generation += 1)
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    this.listingState = { kind: 'loading' }
    this.spec.invalidate()
    void (async (): Promise<void> => {
      try {
        const records = await query.listSessions(abort.signal)
        if (this.stale(generation)) return
        this.listingState = {
          kind: 'ready',
          rows: worktreeRows(records, this.spec.currentCwd),
        }
      } catch (error: unknown) {
        if (this.stale(generation)) return
        if (aborted(error)) return
        this.listingState = { kind: 'failed', message: reason(error) }
      }
      this.spec.invalidate()
    })()
  }

  /**
   * Open one directory's sessions, or close the one that is open.
   *
   * Selecting starts exactly one `filterSessions` plus one batched title
   * observation — the same two reads `/sessions` pays for its own listing.
   * Selecting a different directory abandons the previous catalog rather than
   * keeping both alive: its results would repaint a view that has moved on.
   * @param cwd - the stored cwd to open, or undefined to go back.
   */
  select(cwd: string | undefined): void {
    if (cwd === this.selectedCwd) return
    this.sessions?.dispose()
    this.sessions = undefined
    this.selectedCwd = cwd
    if (cwd === undefined) {
      this.spec.invalidate()
      return
    }
    const spec: SessionCatalogSpec = {
      query: this.spec.query,
      invalidate: this.spec.invalidate,
      workspace: { kind: 'cwd', cwd },
      ...(this.spec.now === undefined ? {} : { now: this.spec.now }),
    }
    const catalog = new SessionCatalog(spec)
    this.sessions = catalog
    // Applying the filter rather than `refresh()` is what puts the `cwd`
    // clause in the request: a bare refresh lists the whole corpus, which is
    // the one thing this view must never show.
    catalog.applyFilters(CWD_ONLY)
    this.spec.invalidate()
  }

  /**
   * Everything the second view draws, or undefined when nothing is open.
   *
   * The row is re-read from the current listing so a refresh that landed
   * while a directory was open cannot leave a stale count on screen. A
   * selected cwd the listing no longer holds keeps a synthesized row with no
   * sessions rather than closing the view: the reader is standing in a place
   * they chose, and `+ New session` there is still exactly as valid — the
   * directory is only ever used as the new session's cwd, which Harness
   * validates itself.
   * @returns the selection, including a listing state of its own.
   */
  selection(): WorktreeSelection | undefined {
    const cwd = this.selectedCwd
    if (cwd === undefined) return undefined
    const sessions: CatalogState = this.sessions?.listing()
      ?? (this.spec.query === undefined ? { kind: 'unavailable' } : { kind: 'loading' })
    return { row: this.row(cwd), sessions }
  }

  /** Abandon every in-flight read; their results would repaint a closed view. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.abort?.abort()
    this.abort = undefined
    this.sessions?.dispose()
    this.sessions = undefined
  }

  /**
   * The listed row for one cwd, or a fresh-directory stand-in.
   * @param cwd - the selected cwd.
   * @returns the row to draw.
   */
  private row(cwd: string): WorktreeRow {
    const listing = this.listingState
    const found = listing.kind === 'ready'
      ? listing.rows.find(row => row.cwd === cwd)
      : undefined
    return found ?? { cwd, sessions: 0, current: cwd === this.spec.currentCwd }
  }

  /**
   * Whether a read has been superseded or the catalog is gone.
   * @param generation - the read's own generation.
   * @returns whether its result should be dropped.
   */
  private stale(generation: number): boolean {
    return this.disposed || generation !== this.generation
  }
}

/** Typed cancellation code the query backends use. */
const SEARCH_ABORTED = 'SESSION_QUERY_ABORTED'

/**
 * Whether a thrown value is this frontend's own cancellation.
 *
 * Two shapes, because two things cancel a corpus read: the query engine's own
 * typed code, and the `AbortSignal` the catalog passed it.
 * @param error - the thrown value.
 * @returns whether it should be dropped rather than reported.
 */
function aborted(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (code === SEARCH_ABORTED) return true
    if ((error as { name?: unknown }).name === 'AbortError') return true
  }
  return false
}

/**
 * A thrown value as a line the frontend may draw.
 * @param error - the thrown value.
 * @returns its message; untrusted, so the view still escapes it.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
