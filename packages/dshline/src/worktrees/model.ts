/**
 * What a worktree row IS, for a reader who has to pick a place to work.
 *
 * `/sessions` answers "which conversation". `/worktrees` answers the question
 * before it — "which working directory does my Harness session history
 * represent" — and the answer is derived, not stored:
 *
 * ```text
 * SessionHeader.cwd        immutable, stamped by Harness at creation
 *       ↓ group by exact string
 * transient cwd groups     this module; alive only while the picker is open
 *       ↓ select one
 * SessionCatalog scoped to { kind: 'cwd', cwd }
 * ```
 *
 * A row is therefore DEFINED as "the sessions whose header records exactly
 * this cwd", which is why the group needs no id, no title, and no durable
 * record: the key is the definition. dshline stores nothing here, and there is
 * no second registry to disagree with the corpus.
 *
 * Two things a row deliberately is NOT:
 *
 * - **not a Git worktree.** Git owns Git. A directory appears because Harness
 *   has a session in it, not because a repository lists it; a worktree nobody
 *   has worked in yet is simply absent. Nothing here reads `.git` or runs Git.
 * - **not a durable workspace entity.** The grouping key is the stored `cwd`
 *   string exactly as Harness wrote it. dshline does not `realpath` it, join
 *   it, or normalize it, so two spellings of one directory stay two rows if
 *   sessions were really created with two different strings — which is
 *   preferable to a frontend inventing path identity.
 *
 * Everything in this module is pure. The catalog owns the reads and the
 * overlay owns the keyboard; this owns the grouping rule and the labels, which
 * is the part worth testing without a terminal or a harness.
 * @module dshline/worktrees/model
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { CatalogState, SessionEntry } from '../sessions/model.ts'
import { shortWorkspace } from '../sessions/model.ts'

/** One working directory the session corpus represents, as the picker lists it. */
export interface WorktreeRow {
  /**
   * The exact `SessionHeader.cwd` string this group is defined by.
   *
   * Both the group's identity and the `cwd` clause the second view filters
   * on, which is what keeps the count and the rows one relationship rather
   * than two authorities.
   */
  readonly cwd: string
  /** How many corpus records carry exactly this cwd. */
  readonly sessions: number
  /**
   * Whether the session THIS window is driving is one of them.
   *
   * From the attached session's own `header.cwd`, never the launch directory:
   * a resumed session keeps the workspace it was created in, and marking the
   * row the process happens to have started in would be the frontend
   * disagreeing with the header it just read.
   */
  readonly current: boolean
}

/** The worktree listing the picker draws. */
export type WorktreeListing =
  /** No `ctx.sessionQuery` is mounted, so there is no corpus to group. */
  | { readonly kind: 'unavailable' }
  /** The corpus read is in flight. */
  | { readonly kind: 'loading' }
  /** Harness refused the read; the message is its own and is untrusted. */
  | { readonly kind: 'failed'; readonly message: string }
  /** A grouping arrived, possibly empty. */
  | { readonly kind: 'ready'; readonly rows: readonly WorktreeRow[] }

/** One row of the second view. */
export type WorktreeSessionRow =
  /** Start a fresh session rooted in the selected directory. */
  | { readonly kind: 'new' }
  /** Reopen this persisted session. */
  | { readonly kind: 'session'; readonly entry: SessionEntry }

/** What the picker resolved to, in the attachment vocabulary the loop speaks. */
export type WorktreeChoice =
  /**
   * Reopen an existing session.
   *
   * Id alone: the resumed session's own `SessionHeader.cwd` stays
   * authoritative, and supplying a cwd here would re-root a conversation.
   */
  | { readonly kind: 'resume'; readonly id: SessionId }
  /**
   * Start a fresh session in the selected directory.
   *
   * `cwd` is the whole transition. Harness stamps it into the new session's
   * immutable header, which is what makes the new conversation a member of
   * this group on the next read — no membership write exists, because
   * membership is the grouping rule rather than a stored fact.
   */
  | { readonly kind: 'new'; readonly cwd: string }

/** Everything the second view draws for one selected directory. */
export interface WorktreeSelection {
  /** The row itself, as the grouping reported it. */
  readonly row: WorktreeRow
  /** Its sessions, read through the same `ctx.sessionQuery` catalog `/sessions` uses. */
  readonly sessions: CatalogState
}

/**
 * Group corpus records into worktree rows by their exact stored cwd.
 *
 * This function sorts nothing. It preserves its INPUT order, grouping each cwd
 * at its first appearance — and the caller's input is `listSessions()`, which
 * Harness returns newest `createdAt` first with a stable id tiebreak. Given
 * that order, first appearance puts each group at its newest session,
 * deterministically; the chronology is Harness's, not this module's, and there
 * is no second ordering authority and nothing saved.
 *
 * A record whose header carries no cwd is skipped entirely. Those exist — the
 * field is optional — and an empty-string or "unknown" row would be dshline
 * inventing a directory that no session names.
 * @param records - the logical corpus, in Harness's own order.
 * @param currentCwd - the attached session's own header cwd, when there is one.
 * @returns one row per distinct stored cwd, in corpus order.
 */
export function worktreeRows(
  records: readonly SessionRecord[],
  currentCwd: string | undefined,
): readonly WorktreeRow[] {
  const counts = new Map<string, number>()
  for (const record of records) {
    const cwd = record.header.cwd
    if (cwd === undefined || cwd === '') continue
    counts.set(cwd, (counts.get(cwd) ?? 0) + 1)
  }
  return [...counts].map(([cwd, sessions]) => ({
    cwd,
    sessions,
    current: cwd === currentCwd,
  }))
}

/**
 * Compose the second view's rows.
 *
 * `+ New session` is FIRST and unconditional, which is the difference between
 * this and a filtered session browser: the reader chose a place to work, and
 * starting fresh there is a first-class answer rather than what is left when
 * no row appeals. It is present even while the listing is still loading or
 * failed, because creating a session needs nothing the listing read.
 * @param sessions - the directory's session listing.
 * @returns the rows to draw, in order.
 */
export function worktreeSessionRows(sessions: CatalogState): readonly WorktreeSessionRow[] {
  const entries = sessions.kind === 'ready' ? sessions.entries : []
  return [
    { kind: 'new' },
    ...entries.map((entry): WorktreeSessionRow => ({ kind: 'session', entry })),
  ]
}

/**
 * Whether a typed query matches one row.
 *
 * Matched against the label and the full stored path — the two facts a row
 * shows. Case is folded and whitespace runs collapse, the same rule
 * `/sessions` filtering uses, so the two pickers do not disagree about what
 * counts as a match.
 * @param row - the candidate.
 * @param query - raw query text; an empty query matches everything.
 * @returns whether the row should be listed.
 */
export function matchesWorktree(row: WorktreeRow, query: string): boolean {
  const needle = normalize(query)
  if (needle === '') return true
  return normalize(worktreeLabel(row.cwd)).includes(needle) || normalize(row.cwd).includes(needle)
}

/**
 * Normalise text for matching.
 * @param text - the raw text.
 * @returns its normalised form.
 */
function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

/**
 * The short name a row shows, derived from the path and never stored.
 *
 * The last non-empty segment, which is what a person calls a checkout. Two
 * directories can share it; the path drawn beside it is what distinguishes
 * them, so this deliberately does not disambiguate. Separators are matched
 * for both platforms because a stored cwd is whatever Harness recorded on the
 * machine the session was created on.
 * @param cwd - the stored workspace path.
 * @returns the label, falling back to the path when it has no segment.
 */
export function worktreeLabel(cwd: string): string {
  const segments = cwd.split(/[/\\]/u).filter(segment => segment !== '')
  return segments.at(-1) ?? cwd
}

/**
 * The path a row shows, shortened at the home directory.
 *
 * Shared with `/sessions` rather than reimplemented: the home prefix is the
 * same on every row, so it is the one part of a path that never distinguishes
 * two worktrees, while the part that does is the part a narrow terminal cuts
 * off first. Presentation only — the stored string is what every read uses.
 * @param cwd - the stored workspace path.
 * @param home - the user's home directory, when it is known.
 * @returns the path to display.
 */
export function worktreePath(cwd: string, home: string | undefined): string {
  return shortWorkspace(cwd, home) ?? cwd
}

/**
 * How a row's session count reads beside its path.
 * @param sessions - how many corpus records carry this cwd.
 * @returns the cue.
 */
export function sessionCountLabel(sessions: number): string {
  return sessions === 1 ? '1 session' : `${String(sessions)} sessions`
}

/**
 * What to say when a worktree listing has no rows to show.
 *
 * Every branch names an authority rather than a symptom, because each of them
 * is a different thing for the reader to do: mount a corpus, work somewhere,
 * or clear a filter.
 * @param listing - the listing state.
 * @param filtered - whether a query is narrowing the rows.
 * @returns one sentence.
 */
export function listingMessage(listing: WorktreeListing, filtered: boolean): string {
  switch (listing.kind) {
    case 'unavailable':
      return 'No Harness session corpus is mounted in this profile.'
    case 'loading':
      return 'Reading Harness sessions…'
    case 'failed':
      return listing.message
    case 'ready':
      return filtered
        ? 'No working directory matches that filter.'
        : 'No working directories are represented in Harness sessions yet.'
  }
}

/**
 * What to say when a selected directory's session listing has no rows.
 * @param sessions - the session listing state.
 * @returns one sentence.
 */
export function sessionsMessage(sessions: CatalogState): string {
  switch (sessions.kind) {
    case 'unavailable':
      return 'No Harness session corpus is mounted in this profile.'
    case 'loading':
      return 'Reading this directory’s sessions…'
    case 'failed':
      return sessions.message
    case 'ready':
      return 'No sessions here yet.'
  }
}
