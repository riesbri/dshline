/**
 * Presentation-facing reading of the Harness-owned `turnOutline` projection.
 *
 * This module is deliberately one-directional: Harness folds the log into the
 * authoritative outline (`turn`, `seq`, bounded `prompt`/`response` previews)
 * and everything here only decides what a terminal shows of it. Nothing folds
 * the raw event stream, parses transcript rows, or keeps a mutable turn list —
 * `/turns` is a bounded index over facts Harness already owns, and a second
 * transcript model would be a second authority to disagree with.
 *
 * `seq` is a turn's `turn/start` event sequence. It is kept as the stable
 * presentation identity for selection: a live projection update inserts or
 * removes entries, and aiming by the current filtered-array INDEX would let an
 * action land on whichever turn inherited that screen position.
 * @module dshline/turns/model
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
// Type-only, through the host-safe subpath: it carries the `turnOutline` key of
// `SessionProjectionMap`. The package is an ordinary dependency because
// dshline's own bundle patch names and mounts it as a Cordis row; what stays
// optional is the CAPABILITY, since a composition may drop that row.
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-turn-outline/types'

/** What the terminal can truthfully present from the authoritative cut. */
export type TurnReading =
  /** The profile mounts no projection registry at all. */
  | { readonly kind: 'projections-unavailable' }
  /** The registry is mounted, but no `turnOutline` unit registered this key. */
  | { readonly kind: 'unregistered' }
  /** The unit is registered; this session has not started a turn yet. */
  | { readonly kind: 'none' }
  /** The whole outline, in Harness order (strictly increasing turn). */
  | { readonly kind: 'list'; readonly turns: readonly TurnOutlineEntry[] }

/**
 * Read the current outline from the authoritative generic snapshot.
 *
 * Takes the snapshot rather than the observer, so a caller reading several
 * units on one frame pays for one validated cut. `undefined` is the absence of
 * the whole registry; a missing KEY is the separate, honest fact that this
 * composition did not mount the unit. `/turns` implements no fallback fold, so
 * those two absences stay distinguishable rather than collapsing into one
 * fabricated list.
 * @param snapshot - the authoritative cut, or undefined without a registry.
 * @returns the small terminal-facing turn reading.
 */
export function turnReading(snapshot: ProjectionSnapshot | undefined): TurnReading {
  if (snapshot === undefined) return { kind: 'projections-unavailable' }
  const turns = snapshot.values.turnOutline
  if (turns === undefined) return { kind: 'unregistered' }
  if (turns.length === 0) return { kind: 'none' }
  return { kind: 'list', turns }
}

/**
 * The stable presentation identity of one turn.
 *
 * A `turn/start` seq is unique within a session and is what Harness itself uses
 * as the turn's load-through anchor, so it survives filtering and projection
 * updates in a way an array index cannot.
 * @param seq - the entry's `turn/start` seq.
 * @returns the identity key.
 */
export function turnKey(seq: SessionSeq): string {
  return `turn:${String(seq)}`
}

/**
 * The compact label for one outline row.
 *
 * Harness's own bounded preview is the label; this function never synthesizes
 * a title. A turn with no prompt yet falls back to its response preview, and a
 * turn with neither is named by its Harness-assigned number — an empty response
 * is a valid state (a no-text turn), not evidence the turn is still open.
 * @param entry - a Harness-authored outline entry.
 * @returns raw, untrusted label text (the overlay escapes it before drawing).
 */
export function turnLabel(entry: TurnOutlineEntry): string {
  const preview = entry.prompt !== '' ? entry.prompt : entry.response
  return preview !== '' ? preview : `Turn ${String(entry.turn)}`
}

/**
 * Narrow the outline to what a presentation-local query matches.
 *
 * Matching is case-insensitive literal substring over the turn number and both
 * authoritative previews, and nothing else: no fuzzy subsequence, no ranking.
 * The reader can predict every result, which is the same contract the
 * `ctrl-r` search keeps. The returned array preserves Harness order, and an
 * entry absent from it is removed from the view — never rewritten.
 * @param turns - the authoritative entries, in Harness order.
 * @param query - the raw filter text; whitespace-only matches everything.
 * @returns the retained entries, in their original order.
 */
export function filterTurns(
  turns: readonly TurnOutlineEntry[],
  query: string,
): readonly TurnOutlineEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return turns
  return turns.filter(entry =>
    String(entry.turn).includes(needle)
    || entry.prompt.toLowerCase().includes(needle)
    || entry.response.toLowerCase().includes(needle))
}

/**
 * Find one entry by its stable `seq`.
 * @param turns - the authoritative entries.
 * @param seq - the `turn/start` seq to resolve.
 * @returns the entry, or undefined when the projection no longer carries it.
 */
export function turnAt(
  turns: readonly TurnOutlineEntry[],
  seq: SessionSeq,
): TurnOutlineEntry | undefined {
  return turns.find(entry => entry.seq === seq)
}

/**
 * The adjacent turn's `seq`, clamped at the ends rather than wrapped.
 *
 * Clamping is the inspection surface's contract: reaching the newest turn and
 * pressing "next" must not silently teleport the reader to the oldest one.
 * @param turns - the authoritative entries.
 * @param seq - the currently inspected `turn/start` seq.
 * @param delta - -1 for the previous turn, +1 for the next.
 * @returns the neighbour's seq, or undefined at an end or when `seq` is gone.
 */
export function neighbourSeq(
  turns: readonly TurnOutlineEntry[],
  seq: SessionSeq,
  delta: -1 | 1,
): SessionSeq | undefined {
  const at = turns.findIndex(entry => entry.seq === seq)
  if (at < 0) return undefined
  return turns[at + delta]?.seq
}
