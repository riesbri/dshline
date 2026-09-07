/**
 * Joining two Harness authorities into one transient presentation model.
 *
 * `/worktrees` reads exactly two surfaces, and joins them on nothing cleverer
 * than the canonical path Harness itself stamped:
 *
 * ```
 * ctx.workspaceRegistry   which working directories Harness has records for
 * ctx.sessionQuery        which sessions were created in one exact directory
 * ```
 *
 * The join is presentation and lives only as long as the picker. Nothing here
 * is persisted, cached across openings, or reconciled in the background: a
 * second store of "which sessions belong to which directory" would be a third
 * authority arguing with the two above, and the registry already publishes its
 * own membership account.
 *
 * The session side is NOT a second session browser. It is the very
 * `SessionCatalog` `/sessions` uses, constructed with this workspace's exact
 * path as its corpus scope, so corpus order, filtering, title folding, and
 * cancellation are Harness's and dshline's one existing implementation of
 * them. What is different is only the question asked: `/sessions` asks "which
 * conversation", this asks "which conversations are rooted here".
 * @module dshline/worktrees/catalog
 */

import type { SessionCatalogSpec, SessionQueryReads } from '../sessions/catalog.ts'
import { SessionCatalog } from '../sessions/catalog.ts'
import type { SessionFiltersValue } from '../sessions/filters.ts'
import type { CatalogState } from '../sessions/model.ts'
import type { WorkspaceRegistryReads } from './harness.ts'
import type {
  WorktreeListing,
  WorktreeRow,
  WorktreeSelection,
  WorktreeStatus,
} from './model.ts'

/**
 * The filters one workspace's session listing runs under.
 *
 * `workspace: 'current'` is what turns the catalog's injected scope into a
 * real `cwd` clause; the other two are deliberately wide open. Narrowing by
 * age or origin is the corpus question `/sessions` answers with `ctrl-f`, and
 * hiding a delegated child here would make the count under a worktree
 * disagree with the corpus for no reason a reader asked for.
 */
const WORKSPACE_ONLY: SessionFiltersValue = { workspace: 'current', origin: 'all', age: 'all' }

/** Rows kept from one workspace's session listing. */
export const WORKTREE_SESSION_LIMIT = 50

/** What the catalog needs from its owner. */
export interface WorktreeCatalogSpec {
  /** The mounted Workspace registry, or undefined in a profile without the row. */
  readonly registry: WorkspaceRegistryReads | undefined
  /** The mounted session-query engine, or undefined in a profile without one. */
  readonly query: SessionQueryReads | undefined
  /** Redraw after catalog state changes. */
  readonly invalidate: () => void
  /**
   * The workspace the attached session is rooted in, when there is one.
   *
   * Its header's own `cwd`, not the launch directory: a resumed session keeps
   * the workspace it was created in, and marking the wrong row current would
   * be the frontend disagreeing with the header it just read.
   */
  readonly currentWorkspace?: string
  /** Rows to keep from one workspace's session listing; omitted, the module limit applies. */
  readonly limit?: number
  /** Current time source, injected so relative ages are assertable. */
  readonly now?: () => number
}

/** What registering the current directory resolved to. */
export type RegisterOutcome =
  /** Harness holds a record for the directory now; it may already have had one. */
  | { readonly kind: 'registered'; readonly workspaceId: string }
  /** This profile mounts no Workspace registry. */
  | { readonly kind: 'unavailable' }
  /** Harness refused; the message is its own and is untrusted. */
  | { readonly kind: 'failed'; readonly message: string }

/** The transient join behind the `/worktrees` picker. */
export class WorktreeCatalog {
  private listingState: WorktreeListing
  private unregisteredPath: string | undefined
  private selectedId: string | undefined
  private selectedStatus: WorktreeStatus = 'unknown'
  private sessions: SessionCatalog | undefined
  private listingGeneration = 0
  private statusGeneration = 0
  private disposed = false

  constructor(private readonly spec: WorktreeCatalogSpec) {
    this.listingState = spec.registry === undefined ? { kind: 'unavailable' } : { kind: 'loading' }
  }

  /** The current workspace listing. */
  listing(): WorktreeListing {
    return this.listingState
  }

  /**
   * The current directory, when Harness positively holds no record for it.
   *
   * Undefined while the resolve is still in flight, when it failed, and when a
   * workspace does own the directory — three different reasons that share one
   * presentation consequence: no register row is offered, because offering one
   * on a guess would ask a reader to create a duplicate of a record that
   * exists.
   * @returns the unowned current directory, or undefined.
   */
  unregistered(): string | undefined {
    return this.unregisteredPath
  }

  /**
   * Read the registry and resolve which of its rows the window is rooted in.
   *
   * `list()` is synchronous and reads no persistence, so the listing is ready
   * on the first frame in the ordinary case; only the current-workspace
   * resolve is asynchronous, because canonicalizing a path is Harness's job
   * and it does it with `fs.realpath`.
   */
  refresh(): void {
    const registry = this.spec.registry
    if (registry === undefined || this.disposed) return
    const generation = (this.listingGeneration += 1)
    let rows: readonly WorkspaceListingRow[]
    try {
      rows = registry.list().map(workspace => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        sessions: workspace.sessionIds.length,
      }))
    } catch (error: unknown) {
      // A registry that has not started yet throws rather than answering
      // empty, and "this profile has no workspaces" is a different sentence
      // from "the registry could not be read".
      this.listingState = { kind: 'failed', message: reason(error) }
      this.spec.invalidate()
      return
    }
    this.publish(generation, rows, undefined)
    const current = this.spec.currentWorkspace
    if (current === undefined) return
    void (async (): Promise<void> => {
      try {
        const owner = await registry.resolveByPath(current)
        if (this.stale(generation)) return
        this.publish(generation, rows, owner?.path)
        this.unregisteredPath = owner === undefined ? current : undefined
      } catch {
        // The current directory did not resolve at all — it was deleted or
        // replaced under the running window. Nothing is marked current and
        // nothing is offered for registration; a create() would reject with
        // the same error one keystroke later.
        if (this.stale(generation)) return
        this.unregisteredPath = undefined
      }
      this.spec.invalidate()
    })()
  }

  /**
   * Open one workspace's sessions, or close the one that is open.
   *
   * Selecting starts exactly one `filterSessions` + one batched title
   * observation, the same two reads `/sessions` pays for its own listing, and
   * one `fs.stat` for the directory check. Selecting a different workspace
   * abandons the previous catalog rather than keeping both alive: its results
   * would repaint a view that has moved on.
   * @param workspaceId - the workspace to open, or undefined to go back.
   */
  select(workspaceId: string | undefined): void {
    if (workspaceId === this.selectedId) return
    this.sessions?.dispose()
    this.sessions = undefined
    this.selectedId = workspaceId
    this.selectedStatus = 'unknown'
    this.statusGeneration += 1
    if (workspaceId === undefined) {
      this.spec.invalidate()
      return
    }
    const row = this.row(workspaceId)
    if (row === undefined) {
      this.spec.invalidate()
      return
    }
    const spec: SessionCatalogSpec = {
      query: this.spec.query,
      invalidate: this.spec.invalidate,
      workspace: { kind: 'cwd', cwd: row.path },
      limit: this.spec.limit ?? WORKTREE_SESSION_LIMIT,
      ...(this.spec.now === undefined ? {} : { now: this.spec.now }),
    }
    const catalog = new SessionCatalog(spec)
    this.sessions = catalog
    // Applying the filter rather than `refresh()` is what puts the `cwd`
    // clause in the request: a bare refresh lists the whole corpus, which is
    // the one thing this view must never show.
    catalog.applyFilters(WORKSPACE_ONLY)
    this.readStatus(workspaceId)
    this.spec.invalidate()
  }

  /**
   * Everything the second view draws, or undefined when nothing is open.
   * @returns the selection, including a listing state of its own.
   */
  selection(): WorktreeSelection | undefined {
    const id = this.selectedId
    if (id === undefined) return undefined
    const workspace = this.row(id)
    if (workspace === undefined) return undefined
    const sessions: CatalogState = this.sessions?.listing()
      ?? (this.spec.query === undefined ? { kind: 'unavailable' } : { kind: 'loading' })
    return { workspace, status: this.selectedStatus, sessions }
  }

  /**
   * Register a directory Harness holds no record for.
   *
   * Harness's own single add route, idempotent per canonical path, so a race
   * with another surface that registered the same directory resolves to the
   * record that already exists rather than to a conflict. The listing is
   * re-read on success, because the new row has to appear under the cursor
   * that asked for it.
   * @param path - the directory to record.
   * @returns what the registry did, including when it refused.
   */
  async register(path: string): Promise<RegisterOutcome> {
    const registry = this.spec.registry
    if (registry === undefined) return { kind: 'unavailable' }
    try {
      const workspace = await registry.create(path)
      if (this.disposed) return { kind: 'registered', workspaceId: workspace.id }
      this.refresh()
      return { kind: 'registered', workspaceId: workspace.id }
    } catch (error: unknown) {
      return { kind: 'failed', message: reason(error) }
    }
  }

  /** Abandon every in-flight read; their results would repaint a closed view. */
  dispose(): void {
    this.disposed = true
    this.listingGeneration += 1
    this.statusGeneration += 1
    this.sessions?.dispose()
    this.sessions = undefined
  }

  /**
   * Publish one listing, marking the row whose path Harness canonicalized to.
   * @param generation - the read this publication belongs to.
   * @param rows - the registry's rows, in its own order.
   * @param currentPath - the canonical path of the current workspace's owner.
   */
  private publish(
    generation: number,
    rows: readonly WorkspaceListingRow[],
    currentPath: string | undefined,
  ): void {
    if (this.stale(generation)) return
    this.listingState = {
      kind: 'ready',
      rows: rows.map((row): WorktreeRow => ({ ...row, current: row.path === currentPath })),
    }
    this.spec.invalidate()
  }

  /**
   * Take the live directory check for the workspace a reader just opened.
   * @param workspaceId - the opened workspace.
   */
  private readStatus(workspaceId: string): void {
    const workspace = this.spec.registry?.get(workspaceId)
    if (workspace === undefined) return
    const generation = (this.statusGeneration += 1)
    void (async (): Promise<void> => {
      let status: WorktreeStatus
      try {
        status = await workspace.status()
      } catch {
        // `status()` contains its own stat failures, so reaching here means
        // the registry itself is gone. Leaving the fact unknown is honest;
        // claiming `missing-dir` would put a warning on a directory nobody
        // checked.
        return
      }
      if (this.disposed || generation !== this.statusGeneration) return
      this.selectedStatus = status
      this.spec.invalidate()
    })()
  }

  /**
   * One listed row by id.
   * @param workspaceId - the id to find.
   * @returns the row, or undefined when the listing does not hold it.
   */
  private row(workspaceId: string): WorktreeRow | undefined {
    const listing = this.listingState
    if (listing.kind !== 'ready') return undefined
    return listing.rows.find(row => row.id === workspaceId)
  }

  /**
   * Whether a read has been superseded or the catalog is gone.
   * @param generation - the read's own generation.
   * @returns whether its result should be dropped.
   */
  private stale(generation: number): boolean {
    return this.disposed || generation !== this.listingGeneration
  }
}

/** One registry row before the current-workspace mark is applied. */
interface WorkspaceListingRow {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly sessions: number
}

/**
 * A thrown value as a line the frontend may draw.
 * @param error - the thrown value.
 * @returns its message; untrusted, so the view still escapes it.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
