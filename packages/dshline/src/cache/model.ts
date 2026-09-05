/**
 * What this session's cache behaviour is, from the two authorities Harness has.
 *
 * Two halves, two owners, and nothing here folds anything:
 *
 * - **Accounting** is Harness's `tokenUsage` projection, read through the same
 *   {@link usageBuckets} and {@link cacheReadShare} `/usage` reads. There is one
 *   cumulative fold of the provider's buckets in this frontend and `/cache` is
 *   not a second one — a second fold that disagreed with the first would leave a
 *   reader with two numbers and no way to tell which was billed.
 * - **The request header** is `Session.requestHeader()`, Harness's own
 *   incrementally-maintained fold of the log's `request/header` events. It is
 *   the LATEST header Harness recorded, which is a weaker fact than the header
 *   the next request will carry: a step reassembles the system prompt and the
 *   tool list and may pass them through `agent/request` before any new header is
 *   logged. This module reports what was recorded and nothing beyond it.
 *
 * In particular there is no stability verdict here, and no history. The pinned
 * Harness generation publishes no prefix-stability projection, and reconstructing
 * one by scanning the log would make this frontend a second historical authority
 * over state Harness owns. A `request/header` event does not even mean the header
 * moved: upstream logs one on resume, and again after a surface replacement, with
 * the header unchanged. So `/cache` reports the latest recorded header and stops.
 *
 * It also never joins the two halves. The buckets are cumulative over the whole
 * session, across every route it used; the header is one record. Naming a header
 * change as the cause of a cache miss would be a claim invented at this layer,
 * and the reader could not check it.
 * @module dshline/cache/model
 */

import type { EpochHeader, Session } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type { UsageBuckets } from '../usage.ts'
import { cacheReadShare, usageBuckets } from '../usage.ts'

/**
 * The latest request header Harness recorded.
 *
 * Three facts, all read straight off {@link EpochHeader}: the route, whether a
 * rendered system prompt is attached, and how many tool schemas were assembled.
 * `EpochHeader` is the request state OUTSIDE derived history, so this describes
 * the head of a request and says nothing about the conversation under it.
 *
 * Deliberately NOT called the next request's header. A step reassembles the
 * system prompt and the tool list, and may pass them through `agent/request`,
 * before a new header snapshot is logged — so the newest record is what this
 * describes, and the next request is free to carry something else.
 */
export interface RequestHeaderReading {
  /** Whether any header was recorded yet — false before this session's first request. */
  readonly recorded: boolean
  /** The route, as `provider/model`, the form every Harness route id is written in. */
  readonly route: string | undefined
  /** Whether that header carries a rendered system prompt. */
  readonly system: boolean
  /** Model-visible tool schemas in that header; 0 for a tool-less request. */
  readonly tools: number
}

/** Everything `/cache` can truthfully report. */
export interface CacheInspection {
  /** Whether this profile mounted the generic projection infrastructure. */
  readonly projections: boolean
  /** Harness's cumulative buckets, when its usage unit is registered. */
  readonly buckets: UsageBuckets | undefined
  /** Share of prompt tokens served from cache; see {@link cacheReadShare}. */
  readonly cacheReadShare: number | undefined
  /** The latest request header Harness recorded. */
  readonly header: RequestHeaderReading
}

/** A reading for a session whose first request has not been built yet. */
const NO_HEADER: RequestHeaderReading = {
  recorded: false,
  route: undefined,
  system: false,
  tools: 0,
}

/**
 * Read the latest request header Harness recorded.
 *
 * Guarded because the accessor folds header events and a malformed one throws
 * there, exactly as it would inside the token meter — an inspector that reports
 * nothing beats one that takes the frame down with it.
 * @param session - the session whose log carries the header record.
 * @returns the recorded header's facts, or nothing recorded.
 */
export function requestHeaderReading(session: Session): RequestHeaderReading {
  let header: EpochHeader | undefined
  try {
    header = session.requestHeader()
  } catch {
    return NO_HEADER
  }
  if (header === undefined) return NO_HEADER
  return {
    recorded: true,
    route: `${header.config.provider}/${header.config.model}`,
    system: header.system !== undefined && header.system.length > 0,
    tools: header.tools?.length ?? 0,
  }
}

/**
 * Read the cache picture from one projection cut and one header record.
 *
 * Shaped like `/usage`'s own inspection on purpose: the accounting half is the
 * same projection read, so the two inspectors cannot end up disagreeing about
 * what one cut said.
 * @param snapshot - the authoritative projection cut, or undefined when the profile mounts no registry.
 * @param header - the latest request header Harness recorded.
 * @returns what `/cache` may report.
 */
export function cacheInspection(
  snapshot: ProjectionSnapshot | undefined,
  header: RequestHeaderReading,
): CacheInspection {
  const buckets = usageBuckets(snapshot)
  return {
    projections: snapshot !== undefined,
    buckets,
    cacheReadShare: cacheReadShare(buckets),
    header,
  }
}

/**
 * Whether the provider reported a cache read at all.
 *
 * A positive read bucket, and nothing weaker. `TokenUsage.cacheReadTokens` is
 * optional and Harness folds an absent one to zero, so a route whose adapter
 * reports no cache reads is indistinguishable from one whose cache went cold.
 * Printing `0%` would state, of the first, a provider fact nobody reported.
 *
 * A cache WRITE cannot rescue that. `cacheWriteTokens` is independently
 * optional, so a positive write is no evidence that the zero beside it was
 * reported rather than defaulted — this generation cannot tell an explicit zero
 * from an absent field in either bucket.
 * @param inspection - the current reading.
 * @returns whether there is a cache-read figure to show.
 */
export function hasCacheReads(inspection: CacheInspection): boolean {
  return (inspection.buckets?.cacheRead ?? 0) > 0
}
