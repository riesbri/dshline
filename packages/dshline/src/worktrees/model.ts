/**
 * What a worktree IS, for a reader who has to pick one out of a list.
 *
 * The vocabulary matters more here than the drawing does, because the word
 * `/worktrees` uses and the thing Harness owns are not the same size:
 *
 * ```
 * repository
 *   └─ worktree / working directory      Git's, and Git's alone
 *        └─ Harness Workspace            one durable record over that directory
 *             ├─ Session A               one conversation rooted in it
 *             ├─ Session B
 *             └─ Session C
 * ```
 *
 * A worktree is not a session, which is the whole reason this is a two-level
 * picker rather than a filtered `/sessions`: choosing a directory must not
 * silently resume whichever conversation happens to be newest in it. And a
 * Harness Workspace is not a Git worktree either — it is a canonical working
 * directory Harness has a record for. At the adopted generation Harness
 * publishes no Git or worktree capability at all, so this layer models the
 * facts the Workspace registry does publish and leaves room for structured
 * Git facts to arrive later from an upstream capability rather than from a
 * subprocess here.
 *
 * Everything in this module is pure. The catalog owns the reads and the
 * overlay owns the keyboard; this owns the row shapes, the labels, and the
 * matching rules, which is the part worth testing without a terminal or a
 * harness.
 * @module dshline/worktrees/model
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CatalogState, SessionEntry } from '../sessions/model.ts'
import { shortWorkspace } from '../sessions/model.ts'

/** One known Harness Workspace, as the picker lists it. */
export interface WorktreeRow {
  /** The workspace id Harness generated; the only stable identity a row has. */
  readonly id: string
  /** Harness's display title, defaulted upstream to the directory's basename. */
  readonly title: string
  /** The canonical directory Harness owns, exactly as the registry reports it. */
  readonly path: string
  /**
   * How many sessions Harness accounts to this workspace right now.
   *
   * The registry's own already-filtered membership count, shown as a scale cue
   * rather than as the list of sessions: the rows in the second view come from
   * `ctx.sessionQuery` filtered on this exact path, so the two numbers can
   * differ honestly — membership is what Harness recorded, and the query is
   * the whole corpus rooted here.
   */
  readonly sessions: number
  /**
   * Whether this is the workspace the attached session is rooted in.
   *
   * Resolved through the registry's own `resolveByPath`, which canonicalizes
   * the same way create did. Absent rather than guessed when the current
   * directory is not a known Workspace: no row is marked, and the picker
   * offers to register it instead of pretending one of the others is it.
   */
  readonly current: boolean
}

/** The workspace listing the picker draws. */
export type WorktreeListing =
  /** No `ctx.workspaceRegistry` is mounted, so there is nothing to list. */
  | { readonly kind: 'unavailable' }
  /** The first read is in flight. */
  | { readonly kind: 'loading' }
  /** Harness refused the read; the message is its own and is untrusted. */
  | { readonly kind: 'failed'; readonly message: string }
  /** A listing arrived, possibly empty. */
  | { readonly kind: 'ready'; readonly rows: readonly WorktreeRow[] }

/** One row of the first view. */
export type WorktreeListRow =
  /** A known Harness Workspace. */
  | { readonly kind: 'workspace'; readonly workspace: WorktreeRow }
  /**
   * Register the directory this window is rooted in.
   *
   * Offered only when `resolveByPath` positively answered that no workspace
   * owns it. It is Harness's own single add route (`workspaceRegistry.create`),
   * which its Workspace controller also exposes as a human command, and it
   * creates no directory and touches no Git — it records a directory Harness
   * is already being used in.
   */
  | { readonly kind: 'register'; readonly path: string }

/** One row of the second view. */
export type WorktreeSessionRow =
  /** Start a fresh session rooted in the selected workspace. */
  | { readonly kind: 'new' }
  /** Reopen this persisted session. */
  | { readonly kind: 'session'; readonly entry: SessionEntry }

/** What the picker resolved to, in the attachment vocabulary the loop speaks. */
export type WorktreeChoice =
  /** Reopen an existing session; its own header cwd stays authoritative. */
  | { readonly kind: 'resume'; readonly id: SessionId }
  /**
   * Start a fresh session in the chosen workspace.
   *
   * Both fields are needed and neither substitutes for the other: `cwd` is
   * what the new session's header records, and `workspaceId` is what the
   * membership write names once creation succeeded.
   */
  | { readonly kind: 'new'; readonly cwd: string; readonly workspaceId: string }

/** The live directory fact read for the ONE workspace a reader opened. */
export type WorktreeStatus = 'unknown' | 'ok' | 'missing-dir'

/** Everything the second view draws for one selected workspace. */
export interface WorktreeSelection {
  /** The workspace itself, as the listing reported it. */
  readonly workspace: WorktreeRow
  /** Its live directory check, or `unknown` while the stat is in flight. */
  readonly status: WorktreeStatus
  /** Its sessions, read through the same `ctx.sessionQuery` catalog `/sessions` uses. */
  readonly sessions: CatalogState
}

/**
 * Compose the first view's rows.
 *
 * The register row is last and is not a workspace, so the filter never hides
 * it: it is the answer to "why is the directory I am in not on this list",
 * and a reader who has typed a query that excludes every workspace is exactly
 * the reader who needs it. It is offered only when the caller positively knows
 * the current directory is unowned.
 * @param rows - the known workspaces, in Harness's registry order.
 * @param unregistered - the current directory when no workspace owns it.
 * @param query - the typed filter; empty matches every workspace.
 * @returns the rows to draw, in order.
 */
export function worktreeListRows(
  rows: readonly WorktreeRow[],
  unregistered: string | undefined,
  query: string,
): readonly WorktreeListRow[] {
  const matching = rows
    .filter(row => matchesWorktree(row, query))
    .map((workspace): WorktreeListRow => ({ kind: 'workspace', workspace }))
  return unregistered === undefined
    ? matching
    : [...matching, { kind: 'register', path: unregistered }]
}

/**
 * Compose the second view's rows.
 *
 * `+ New session` is FIRST and unconditional, which is the difference between
 * this and a filtered session browser: the reader chose a place to work, and
 * starting fresh there is a first-class answer rather than what is left when
 * no row appeals. It is present even while the listing is still loading or
 * failed, because creating a session needs nothing the listing read.
 * @param sessions - the workspace's session listing.
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
 * Whether a typed query matches one workspace.
 *
 * Matched against the title and the path — the two facts a row shows. Case is
 * folded and whitespace runs collapse, the same rule `/sessions` filtering
 * uses, so the two pickers do not disagree about what counts as a match.
 * @param row - the candidate.
 * @param query - raw query text; an empty query matches everything.
 * @returns whether the row should be listed.
 */
export function matchesWorktree(row: WorktreeRow, query: string): boolean {
  const needle = normalize(query)
  if (needle === '') return true
  return normalize(row.title).includes(needle) || normalize(row.path).includes(needle)
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
 * The path a row shows, shortened at the home directory.
 *
 * Shared with `/sessions` rather than reimplemented: the home prefix is the
 * same on every row, so it is the one part of a path that never distinguishes
 * two worktrees, while the part that does is the part a narrow terminal cuts
 * off first.
 * @param path - the canonical directory.
 * @param home - the user's home directory, when it is known.
 * @returns the path to display.
 */
export function worktreePath(path: string, home: string | undefined): string {
  return shortWorkspace(path, home) ?? path
}

/**
 * How a workspace's session membership reads beside its path.
 * @param sessions - the registry's own membership count.
 * @returns the cue, or an empty string when there is nothing to say.
 */
export function sessionCountLabel(sessions: number): string {
  if (sessions <= 0) return 'no sessions'
  return sessions === 1 ? '1 session' : `${String(sessions)} sessions`
}

/**
 * What to say when a workspace listing has no rows to show.
 *
 * Every branch names an authority rather than a symptom, because each of them
 * is a different thing for the reader to do: mount a row, use Harness in a
 * directory, or clear a filter.
 * @param listing - the listing state.
 * @param filtered - whether a query is narrowing the rows.
 * @returns one sentence.
 */
export function listingMessage(listing: WorktreeListing, filtered: boolean): string {
  switch (listing.kind) {
    case 'unavailable':
      return 'No Harness Workspace registry is mounted in this profile.'
    case 'loading':
      return 'Reading known workspaces…'
    case 'failed':
      return listing.message
    case 'ready':
      return filtered
        ? 'No workspace matches that filter.'
        : 'Harness knows no workspaces yet. One appears once a session has run in a directory it has a record for.'
  }
}

/**
 * What to say when a selected workspace's session listing has no rows.
 * @param sessions - the session listing state.
 * @returns one sentence.
 */
export function sessionsMessage(sessions: CatalogState): string {
  switch (sessions.kind) {
    case 'unavailable':
      return 'No Harness session corpus is mounted in this profile.'
    case 'loading':
      return 'Reading this workspace’s sessions…'
    case 'failed':
      return sessions.message
    case 'ready':
      return 'No sessions here yet.'
  }
}
