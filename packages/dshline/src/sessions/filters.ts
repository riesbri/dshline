/** Pure Sessions-browser filter vocabulary and Harness-clause translation. */

import type { SessionResultFilter, SessionResultRange } from '@deepseek-ai/dsh-session-query'
import type { SessionEntry } from './model.ts'

/** Whether workspace filtering is disabled or bound to the active workspace. */
export type WorkspaceChoice = 'all' | 'current'

/**
 * The exact corpus scope a catalog's workspace clause can narrow to.
 *
 * Held apart from {@link WorkspaceChoice} because the two answer different
 * questions. The choice is the READER's two-state control — filter by
 * workspace, or do not — while this is the scope its `current` position
 * resolves against, and that scope is an arbitrary exact `cwd` rather than
 * "wherever this window happens to be". `/sessions` supplies the attached
 * session's own workspace and `/worktrees` supplies the workspace a reader
 * selected, and both reach `filterSessions` through this one translation
 * instead of a second query path.
 *
 * `cwd` is Harness's own exact string equality: it has no path-prefix,
 * trailing-separator, or symlink semantics, which is why the only string ever
 * put in it is one Harness itself wrote — a `SessionHeader.cwd`, either the
 * attached session's own or the key of a `/worktrees` group, which is defined
 * as the sessions carrying exactly that value.
 */
export type SessionWorkspace =
  /** Never narrow by workspace, whatever the reader's choice says. */
  | { readonly kind: 'all' }
  /** Narrow to sessions whose header records exactly this workspace. */
  | { readonly kind: 'cwd'; readonly cwd: string }

/** The scope that narrows nothing, for a caller with no workspace of its own. */
export const EVERY_WORKSPACE: SessionWorkspace = { kind: 'all' }

/**
 * Resolve an optional workspace path into a corpus scope.
 * @param cwd - the exact workspace path, or undefined when there is none.
 * @returns the scope to hand {@link sessionFilterClauses}.
 */
export function workspaceScope(cwd: string | undefined): SessionWorkspace {
  return cwd === undefined || cwd === '' ? EVERY_WORKSPACE : { kind: 'cwd', cwd }
}

/** Which presentation-classified session origins remain visible. */
export type OriginChoice = 'all' | 'own' | 'delegated'

/** The creation-time window offered by the Sessions browser. */
export type AgeChoice = 'all' | 'today' | '7d' | '30d'

/** The complete value edited by the Sessions filter controls. */
export interface SessionFiltersValue {
  /** Workspace predicate to apply. */
  readonly workspace: WorkspaceChoice
  /** Presentation-only origin classification to retain. */
  readonly origin: OriginChoice
  /** Creation-time window to apply. */
  readonly age: AgeChoice
}

/** The number of milliseconds in one day-sized recency interval. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000

/** Filters that leave the complete corpus visible. */
export const NO_FILTERS: SessionFiltersValue = {
  workspace: 'all',
  origin: 'all',
  age: 'all',
}

/**
 * Compare two complete filter values.
 * @param a - the first value.
 * @param b - the second value.
 * @returns whether every filter choice is equal.
 */
export function equalFilters(a: SessionFiltersValue, b: SessionFiltersValue): boolean {
  return a.workspace === b.workspace && a.origin === b.origin && a.age === b.age
}

/**
 * Resolve one age choice to its inclusive Harness range.
 *
 * `today` starts at local midnight because it is a calendar choice, while the
 * day-count choices are rolling durations. Availability is deliberately absent:
 * whether a source is live or persisted says nothing about when it was created.
 * @param age - the browser's recency choice.
 * @param now - the captured current Unix epoch time in milliseconds.
 * @returns the inclusive range, or undefined for all time.
 */
export function ageWindowRange(age: AgeChoice, now: number): SessionResultRange | undefined {
  if (age === 'all') return undefined
  if (age === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return { from: midnight.getTime(), to: now }
  }
  const days = age === '7d' ? 7 : 30
  return { from: now - days * MILLISECONDS_PER_DAY, to: now }
}

/**
 * Translate browser filters into ANDed Harness session predicates.
 *
 * Harness has no origin predicate. In particular, `parent: [null]` means no
 * recorded parent, not "own", so origin is deliberately applied only after a
 * read. A `cwd` clause is exact string equality; it has no path-prefix or symlink
 * semantics, and is omitted when the scope narrows nothing.
 * @param filters - the browser value to translate.
 * @param workspace - the corpus scope the `current` choice resolves against.
 * @param now - the captured current Unix epoch time in milliseconds.
 * @returns Harness clauses, ANDed in their returned order.
 */
export function sessionFilterClauses(
  filters: SessionFiltersValue,
  workspace: SessionWorkspace,
  now: number,
): SessionResultFilter[] {
  const clauses: SessionResultFilter[] = []
  if (filters.workspace === 'current' && workspace.kind === 'cwd') {
    clauses.push({ kind: 'cwd', values: [workspace.cwd] })
  }
  const age = ageWindowRange(filters.age, now)
  if (age !== undefined) clauses.push({ kind: 'created-at', ...age })
  return clauses
}

/**
 * Apply the presentation-only origin choice without changing Harness order.
 *
 * Missing origin metadata is classified as `own` by the catalog. This filter
 * therefore keeps ordinary forks under `own` and excludes only rows explicitly
 * classified as delegated.
 * @param entries - entries in Harness-defined order.
 * @param origin - the origin choice to retain.
 * @returns the retained entries in their original order.
 */
export function applyOrigin(
  entries: readonly SessionEntry[],
  origin: OriginChoice,
): readonly SessionEntry[] {
  if (origin === 'all') return entries
  return entries.filter(entry => origin === 'delegated'
    ? entry.origin === 'delegated'
    : entry.origin !== 'delegated')
}
