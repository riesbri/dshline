/**
 * Session-scoped reading of Harness's per-turn workspace-change records.
 *
 * Harness owns what changed and how to compare it. `@deepseek-ai/dsh-workspace-changes`
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
 * the service publishes no index from one to the other. So the announcement has to
 * be correlated out of the durable log, and there are exactly two sources:
 *
 *   - LIVE. The attachment's own `session/event` feed. Cheap, and it covers every
 *     turn this Host recorded — which is every turn whose summary this Host can
 *     serve.
 *   - HISTORICAL. A turn whose announcement predates this attachment: a reopened
 *     session, or the same durable session resumed twice in one process, where the
 *     second recorder starts with an empty record map while the log still carries
 *     the first run's events. Ignoring this would make a reopened session show
 *     nothing at all, which no reader can tell apart from a turn that changed no
 *     files. It is therefore read — but only when a reader explicitly opens such a
 *     turn, through the one asynchronous corpus read, and never from the live
 *     `Session` object, because `snapshotEvents()` is deprecated upstream for NEW
 *     production callers: dshline's own replay path (`resume.ts`) is legacy debt
 *     this feature does not copy.
 *
 * Announcements are durable while summaries are not, and that asymmetry is why
 * {@link TurnChangesReading} separates "announced but unserved" from "never
 * announced". A turn is never reported as having changed no files merely because
 * this Host can no longer compare it, and no state here is ever derived from the
 * current contents of a file.
 *
 * Nothing is attached to process lifetime. A resumed attachment builds a new
 * adapter, and {@link WorkspaceChangesAdapter.dispose} drops the fold, the pending
 * read, and the generation that would let a late settlement publish.
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
 * The one corpus read that recovers an announcement this attachment never saw.
 *
 * `listEvents` is deliberately not used even though it is the cheaper call: a
 * `SessionEventRecord` carries `seq`, `type`, `time`, and `surface` and NO
 * payload, so the announced `turn` would be unreachable and every record would
 * need a second round trip to become usable. `readSession` is the single read
 * that returns payloads, and it is asked once.
 */
export interface WorkspaceChangesHistory {
  /**
   * The session's complete raw log, read and replay-validated as one detached
   * observation.
   * @param sessionId - the live-preferred session to read.
   * @returns the cloned log, in sequence order.
   */
  readSession(sessionId: SessionId): Promise<{ readonly events: readonly SessionEvent[] }>
}

/** What a terminal may truthfully say about one turn's workspace changes. */
export type TurnChangesReading =
  /** This composition mounts no `workspaceChanges` service at all. */
  | { readonly kind: 'unmounted' }
  /** No `workspace/changes` event announced this turn, as far as the log shows. */
  | { readonly kind: 'none' }
  /** The historical log read for this turn has not settled yet. */
  | { readonly kind: 'pending' }
  /** The historical read for this turn failed. */
  | { readonly kind: 'failed' }
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
  /** The corpus read that recovers pre-attachment announcements, when mounted. */
  readonly history?: WorkspaceChangesHistory
  /** Redraw after a read settles or a live announcement lands. */
  readonly invalidate: () => void
}

/**
 * Session-scoped correlation of `workspace/changes` announcements to turns, and
 * the only caller of `ctx.workspaceChanges.diff` in dshline.
 *
 * One adapter belongs to one attachment. The live fold is a map from turn number
 * to the newest announcement's sequence; the newest wins because Harness states
 * that the latest event for one turn replaces earlier ones, and an in-turn record
 * can be superseded by the one taken after `turn/end`.
 */
export class WorkspaceChangesAdapter {
  /** Newest announcement per Harness-assigned turn number. */
  private readonly announced = new Map<number, number>()
  /** Whether the one historical log read has been started, settled, or refused. */
  private historyState: 'unread' | 'reading' | 'ready' | 'failed' = 'unread'
  /** Turn numbers a reader explicitly opened, so one turn starts at most one read. */
  private readonly checked = new Set<number>()
  private historyGeneration = 0
  private disposed = false

  /**
   * @param spec - the session, the optional seams, and the redraw request.
   */
  constructor(private readonly spec: WorkspaceChangesAdapterSpec) {}

  /** Whether this composition mounts the capability at all. */
  get mounted(): boolean {
    return this.spec.changes !== undefined
  }

  /**
   * Fold one durable event of THIS session.
   *
   * Nothing else is derived from the log, and no payload is rewritten: the turn
   * is Harness's own. An announcement naming a turn the outline has not heard of
   * yet is still recorded, because the outline catches up on its next
   * projection cut and dropping the announcement here would lose it for good.
   * @param event - one event from the attachment's `session/event` feed.
   */
  observe(event: SessionEvent): void {
    if (this.disposed || event.type !== WORKSPACE_CHANGES_EVENT) return
    const turn = announcedTurn(event)
    if (turn === undefined) return
    this.announce(turn, Number(event.seq))
  }

  /**
   * Read the announcement-backed state of one turn.
   *
   * A turn with a live announcement is answered immediately and synchronously —
   * `summary()` is an in-memory lookup on Harness's side, so the outline can ask
   * for the rows it actually draws without a read of its own. The historical read
   * is requested only through {@link requestHistory}, never from here, so a paint
   * can never start I/O.
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
    if (seq !== undefined) return this.served(seq)
    if (this.spec.history === undefined) return { kind: 'none' }
    if (this.historyState === 'failed') return { kind: 'failed' }
    // Before the log has been read, absence is UNKNOWN rather than zero: a turn
    // with no announcement anywhere is a settled negative only once the log says so.
    if (this.historyState !== 'ready') return { kind: 'pending' }
    return { kind: 'none' }
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
   * Start the one historical read, if this turn needs it and none is running.
   *
   * Called when the reader OPENS a turn, never while a list is being painted: a
   * paint that could start a whole-log read would make opening `/turns` cost
   * something the reader did not ask to inspect.
   * @param turn - the turn the reader explicitly opened.
   * @returns whether this call started a read.
   */
  requestHistory(turn: number): boolean {
    const history = this.spec.history
    // No capability, no announcement can exist to find, so a composition that
    // dropped the row must not pay for a whole-log read to prove it.
    if (this.disposed || history === undefined || this.spec.changes === undefined) return false
    // Already live, already read, already failed, or already asked about this
    // exact turn: one read answers every turn, and re-asking would restart it.
    if (this.announced.has(turn) || this.checked.has(turn)) return false
    if (this.historyState !== 'unread') return false
    this.checked.add(turn)
    this.historyState = 'reading'
    const generation = (this.historyGeneration += 1)
    void history.readSession(this.spec.sessionId).then(log => {
      if (this.disposed || generation !== this.historyGeneration) return
      for (const event of log.events) this.remember(event)
      this.historyState = 'ready'
      this.spec.invalidate()
    }).catch(() => {
      if (this.disposed || generation !== this.historyGeneration) return
      this.historyState = 'failed'
      this.spec.invalidate()
    })
    return true
  }

  /**
   * Release the fold, the pending read, and the generation that guards it.
   *
   * A late settlement is dropped rather than published: the attachment that
   * asked for it is gone, and its redraw callback would otherwise paint the NEXT
   * session's terminal with this one's evidence.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.historyGeneration += 1
    this.announced.clear()
    this.checked.clear()
  }

  /**
   * Record one announcement, newest sequence per turn winning.
   *
   * A historical log is never allowed to REPLACE a sequence the live feed
   * already gave: the feed observed an event happening, and no later read of a
   * log can be newer than that.
   * @param turn - the announced turn number.
   * @param seq - the announcing event's sequence number.
   */
  private announce(turn: number, seq: number): void {
    const current = this.announced.get(turn)
    if (current === undefined || seq > current) this.announced.set(turn, seq)
  }

  /**
   * Fold one event of a historical log, ignoring every type but an announcement.
   * @param event - one raw log event.
   */
  private remember(event: SessionEvent): void {
    if (event.type !== WORKSPACE_CHANGES_EVENT) return
    const turn = announcedTurn(event)
    if (turn !== undefined) this.announce(turn, Number(event.seq))
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
