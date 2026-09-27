/**
 * Session-scoped reading of Harness's per-turn workspace-change records.
 *
 * Harness owns what changed and how it is compared. `@deepseek-ai/dsh-workspace-changes`
 * snapshots the working tree around each top-level turn, appends one
 * `workspace/changes` event naming the turn, and keeps the summary and its
 * per-file comparisons **on this Host, for this Session's lifetime**, served
 * through `ctx.workspaceChanges`. This module is the only place dshline reads
 * that seam, and it holds no changed-file state of its own: no Git command, no
 * filesystem snapshot, no mutation record, no second copy of a diff.
 *
 * THE PART THAT IS ACTUALLY HARD IS CORRELATION, and it is why this file
 * exists. A summary is addressed by the sequence number of the `workspace/changes`
 * EVENT, while `/turns` addresses a turn by its Harness-assigned turn number, and
 * the service publishes no index from one to the other. The one state this
 * frontend owns is that pairing: `turn -> the newest announcement's seq`.
 *
 * It is a TRANSIENT index over durable Harness events, and it is fed from the
 * two places the attachment already receives them — not from a read of its own:
 *
 *   - the attachment's live `session/event` feed, for announcements appended
 *     while this attachment watches;
 *   - the attachment's EXISTING resume replay, which already walks the whole
 *     durable log to rebuild a reopened session's transcript. `workspace/changes`
 *     is a non-surface durable event, so `transcriptEvents()` already returns
 *     it, and the replay that folds those events into the transcript is the
 *     natural place to fold them here too.
 *
 * That second source is the whole of the reopened-session story, and it is why
 * this module needs no read of its own. An earlier shape of this feature kept a
 * `ctx.sessionQuery.readSession()` pass for announcements the live feed had not
 * seen, and reported those turns as `pending` until it settled — which put a
 * `Δ ?` on every unmatched row of a reopened `/turns` before anyone had opened
 * anything. A turn whose announcement has not been found is not evidence that
 * Harness published one, and the durable log the replay already read is the
 * authority that settles it. Reusing that boundary also keeps this feature from
 * adding a second synchronous whole-log reader beside `resume.ts`'s legacy one.
 *
 * Announcements are durable while summaries are not, and that asymmetry is why
 * {@link TurnChangesReading} separates "announced but unserved" from "never
 * announced". A turn is never reported as having changed no files merely because
 * this Host can no longer compare it, and no state here is ever derived from the
 * current contents of a file.
 *
 * Nothing is attached to process lifetime. A resumed attachment builds a new
 * adapter, and {@link WorkspaceChangesAdapter.dispose} drops the fold with it.
 * @module dshline/turns/changes
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only, through the host-safe subpath. The package is an ordinary
// dependency because dshline's own bundle patch names and mounts it as a Cordis
// row; what stays optional is the CAPABILITY, since a composition may drop that
// row — the same arrangement `turnOutline` already has.
import type {
  WorkspaceChangedFile,
  WorkspaceChangesSummary,
  WorkspaceFileDiff,
} from '@deepseek-ai/dsh-workspace-changes/types'

/** The durable event type Harness appends to announce one turn's changes. */
export const WORKSPACE_CHANGES_EVENT = 'workspace/changes'

/**
 * The two `ctx.workspaceChanges` operations `/turns` consumes.
 *
 * Structurally the Harness service, declared here so the presenter, the
 * surfaces, and the tests depend on the narrow read rather than on the plugin.
 * Nothing about Git, subprocesses, or capture reaches this type: from dshline's
 * side the seam is "a summary for one announced sequence" and "a comparison for
 * one listed index", which is the whole of what is presented.
 */
export interface WorkspaceChangesSeam {
  /**
   * The summary one `workspace/changes` event announced.
   * @param sessionId - the Session that appended the event.
   * @param seq - the announcing event's sequence number.
   * @returns the summary, or undefined once the Session is disposed or when
   *   this Host never recorded it.
   */
  summary(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined
  /**
   * Compare one listed file's contents at turn start and turn end.
   * @param sessionId - the Session that appended the event.
   * @param seq - the announcing event's sequence number.
   * @param index - the file's index in the summary's `files`.
   * @param signal - cancels the reads.
   * @returns the comparison, or undefined once the Session is disposed, when
   *   this Host never recorded it, or when no file has that index.
   */
  diff(
    sessionId: SessionId,
    seq: number,
    index: number,
    signal: AbortSignal,
  ): Promise<WorkspaceFileDiff | undefined>
}

/**
 * What a terminal may truthfully say about one turn's workspace changes.
 *
 * There is no "still looking" state, and that is deliberate. Every announcement
 * `/turns` can need is already known by the time the first frame is painted —
 * the replay resolves the durable prefix and the live feed resolves the rest —
 * so an unknown turn is unknown for a reason that will not change, and saying
 * otherwise would put a mark on a row nobody has evidence for.
 */
export type TurnChangesReading =
  /** This composition mounts no `workspaceChanges` service at all. */
  | { readonly kind: 'unmounted' }
  /** No `workspace/changes` event announced this turn. */
  | { readonly kind: 'none' }
  /**
   * An announcement exists, but this Host can no longer serve its summary.
   *
   * The reopened-session and restarted-Host case, in its honest form: the
   * evidence that the turn changed files is durable, the comparison is not.
   */
  | { readonly kind: 'unserved'; readonly seq: number }
  /** Harness served the summary, including an explicitly empty one. */
  | {
    readonly kind: 'summary'
    /** The announcing event's sequence, the only key a comparison can be asked for. */
    readonly seq: number
    /** Harness's own summary, read fresh. Never retained by this module. */
    readonly summary: WorkspaceChangesSummary
  }

/** Inputs one attachment's workspace-change reading needs. */
export interface WorkspaceChangesAdapterSpec {
  /** The exact Session this adapter describes; a durable id, not an authority. */
  readonly sessionId: SessionId
  /** Harness's service, or undefined when the composition mounts no such row. */
  readonly changes?: WorkspaceChangesSeam
}

/**
 * Session-scoped correlation of `workspace/changes` announcements to turns, and
 * the only caller of `ctx.workspaceChanges.diff` in dshline.
 *
 * One adapter belongs to one attachment. Newest announcement per turn wins,
 * because Harness states that the latest event for one turn replaces earlier
 * ones and an in-turn record can be superseded by the one taken after
 * `turn/end`.
 */
export class WorkspaceChangesAdapter {
  /** Newest announcement per Harness-assigned turn number. */
  private readonly announced = new Map<number, number>()
  private disposed = false

  /**
   * @param spec - the session and the optional seam.
   */
  constructor(private readonly spec: WorkspaceChangesAdapterSpec) {}

  /** Whether this composition mounts the capability at all. */
  get mounted(): boolean {
    return this.spec.changes !== undefined
  }

  /**
   * Fold one durable event of THIS session.
   *
   * Called from the two places the attachment already receives them: the live
   * `session/event` feed, and the resume replay that rebuilds a reopened
   * session's transcript. Idempotent, and safe to call with the same event twice
   * — the two sources overlap by construction, because an event already in the
   * replay snapshot is one the live listener never delivered.
   *
   * Nothing else is derived from the log and no payload is rewritten: the turn
   * is Harness's own. An announcement naming a turn the outline has not heard of
   * yet is still recorded, because the outline catches up on its next
   * projection cut and dropping the announcement here would lose it for good.
   *
   * A FORK-INHERITED prefix would be recorded the same way and then looked up
   * under this Session's own id, where it resolves to nothing — because the
   * recorder that wrote it belonged to another Session. That is the honest
   * answer rather than a wrong one, and it cannot arise in practice: the
   * recorder declines every subagent session, and a forked child is exactly
   * that, while the attached session is always created fresh or restored whole.
   * @param event - one event from the live feed or the replayed prefix.
   */
  observe(event: SessionEvent): void {
    if (this.disposed || event.type !== WORKSPACE_CHANGES_EVENT) return
    const turn = announcedTurn(event)
    if (turn === undefined) return
    const current = this.announced.get(turn)
    // Newest wins, and a live observation is never older than a replayed one:
    // the replay snapshot is taken after the listener is registered, so an event
    // both sources saw is the SAME event, and its sequence decides.
    if (current === undefined || Number(event.seq) > current) this.announced.set(turn, Number(event.seq))
  }

  /**
   * Read the announcement-backed state of one turn.
   *
   * Synchronous and allocation-free, because `summary()` is an in-memory lookup
   * on Harness's side over a record it already built: the outline asks for the
   * rows it actually draws and pays a map lookup each, never a read of its own.
   * @param turn - the Harness-assigned turn number from the outline.
   * @returns what may truthfully be presented for that turn right now.
   */
  reading(turn: number): TurnChangesReading {
    const changes = this.spec.changes
    // A disposed adapter answers for nothing, including a composition that
    // mounts the capability. Its attachment is gone, and the alternative is a
    // stale surface still resolving turns against evidence nobody owns.
    if (this.disposed || changes === undefined) return { kind: 'unmounted' }
    const seq = this.announced.get(turn)
    if (seq === undefined) return { kind: 'none' }
    return this.served(seq)
  }

  /**
   * Ask Harness for one listed file's comparison, on explicit disclosure only.
   *
   * The single call site of `diff`, reachable only from the changed-file list's
   * `open` action. The caller's `AbortSignal` is the caller's own: the surface
   * that asked owns the lifetime, so closing it or moving to another file cancels
   * a read that no longer has a surface to paint.
   * @param seq - the announcing event's sequence number.
   * @param index - the file's index in the summary's `files`.
   * @param signal - cancels the reads.
   * @returns Harness's comparison, or undefined when it can serve none.
   * @throws whatever a live Session's snapshot read threw.
   */
  diff(seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined> {
    const changes = this.spec.changes
    if (changes === undefined || this.disposed) return Promise.resolve(undefined)
    return changes.diff(this.spec.sessionId, seq, index, signal)
  }

  /**
   * Release the fold.
   *
   * A new attachment builds a new adapter, so nothing here can survive into the
   * next session's terminal: the map is dropped and every later read answers for
   * nothing.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.announced.clear()
  }

  /**
   * Resolve one announced sequence against what this Host can still serve.
   * @param seq - the announcing event's sequence number.
   * @returns the served summary, or the honest unserved state.
   */
  private served(seq: number): TurnChangesReading {
    const summary = this.spec.changes?.summary(this.spec.sessionId, seq)
    if (summary === undefined) return { kind: 'unserved', seq }
    return { kind: 'summary', seq, summary }
  }
}

/**
 * The turn an announcement names, or undefined for a payload that names none.
 *
 * The durable log is a file and a frontier, and neither the event type nor its
 * payload survives an older build's refusal to read it; a `turn` that is not a
 * positive integer is not a turn identity this frontend may correlate a row with.
 * @param event - one candidate announcement.
 * @returns the announced turn number.
 */
function announcedTurn(event: SessionEvent): number | undefined {
  const { turn } = event.data as { turn?: unknown }
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 1 ? turn : undefined
}

/**
 * One file row the terminal may draw, resolved from Harness's own record.
 *
 * `index` is the file's position in the summary's `files` and is the ONLY key a
 * comparison is addressed by, so it travels with the row rather than being
 * recomputed by the surface: a windowed or scrolled list must never be able to
 * ask Harness about a different file than the one on screen.
 */
export interface ChangedFileRow {
  /** The file's index in the summary, for `workspaceChanges.diff`. */
  readonly index: number
  /** Harness's durable path: relative to the working directory, or absolute. */
  readonly path: string
  /** Harness's display path, which is also the label and the sort key. */
  readonly display: string
  /** Lines Harness counted as added; zero for a binary or oversized file. */
  readonly added: number
  /** Lines Harness counted as deleted; zero for a binary or oversized file. */
  readonly deleted: number
  /** Harness reported the file as binary, or a captured side held a NUL byte. */
  readonly binary: boolean
  /** A captured side exceeded the recorder's `maxFileBytes`. */
  readonly oversized: boolean
}

/**
 * Project one Harness file record into the row the changed-file list draws.
 *
 * Pure, and deliberately lossless about the two facts a textual diff would
 * flatten: `binary` and `oversized` are Harness's own refusals, and rendering
 * either as an ordinary "+0 -0" text change would claim an empty edit for a file
 * Harness declines to compare.
 * @param index - the file's position in the summary's `files`.
 * @param file - the authoritative record.
 * @returns the presentation row.
 */
export function changedFileRow(index: number, file: WorkspaceChangedFile): ChangedFileRow {
  return {
    index,
    path: file.path,
    display: file.display,
    added: file.added,
    deleted: file.deleted,
    binary: file.binary === true,
    oversized: file.oversized === true,
  }
}
