/**
 * The projection units the status line reads, and nothing else.
 *
 * The footer is redrawn on every spinner beat, every streamed delta, and every
 * tool transition, so its projection read is the hottest one in the frontend.
 * An unkeyed `snapshot()` folds, views, and schema-validates every unit the
 * profile has registered, and this line consumes five fields out of all of them:
 * the permission, the cache-read share, the context figure, the Todo count, and
 * the goal state. Every other unit was being paid for to produce a value nobody
 * read.
 *
 * Naming the five changes no authority and no freshness. The registry still
 * folds and materializes the complete state at one `asOfSeq` position — that is
 * upstream's contract for a keyed cut, not this frontend's — and a unit that
 * moves still drives the same `onChanged` invalidation the observer was already
 * subscribed to. This is a narrower question to the same authority, not a
 * remembered answer to it, which is why nothing here may become a cache.
 * @module dshline/projections/status-keys
 */

import type { ProjectionKey } from './observer.ts'

/**
 * The five units the status line's `StatusState` can draw, with the field each
 * one feeds.
 *
 * Derived field by field from what the status builder reads, so the list is an
 * audit of that read rather than a guess at it:
 *
 * - `permissions` — the effective `currentValue` the footer paints verbatim.
 * - `tokenUsage` — Harness's own buckets, whose ratio of cache-read to prompt
 *   tokens is the `CR` segment. Not the dshline usage fold beside it, which is
 *   priced separately and needs no projection.
 * - `contextPressure` — the O(1) occupancy fold whose `projectedTokens` is the
 *   footer's token figure.
 * - `todos` — the list whose completed/total count is the `todo n/m` segment.
 * - `goal` — the durable half of the goal reading, joined with process-local
 *   activation for the `goal …` state.
 *
 * `contextBreakdown` is deliberately ABSENT, and the reasoning is the part worth
 * writing down. `contextReading()` does read it — its `composition` half is a
 * real reading, not a stray access — but the status line takes only
 * `occupancy.tokens`, which is `contextPressure.projectedTokens` and nothing
 * else. So the unit is not requested: the registry produces no view for it and
 * validates none, which is where the cost was. What is left is one property read
 * of an already-materialized cut that yields `undefined` and is discarded, and
 * the broader `/context` reading still reads the unit exactly as it did — this
 * narrowing is scoped to the status path and leaves that model alone.
 */
export const STATUS_PROJECTION_KEYS = [
  'permissions',
  'tokenUsage',
  'contextPressure',
  'todos',
  'goal',
] as const satisfies readonly ProjectionKey[]
