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
 * - **The request head** is `Session.requestHeader()` and `Session.requestContext()`,
 *   Harness's own incrementally-maintained folds of the log's `request/header`
 *   and `request/context` events. They are the LATEST records Harness kept,
 *   which is a weaker fact than what the next request will carry: a step
 *   reassembles the tool list and may pass it through `agent/request` before any
 *   new header is logged. This module reports what was recorded and nothing
 *   beyond it.
 *
 * The system prompt is deliberately absent. In Session format V3 it is durable
 * conversation history — a `system/message` surface node — not a field of
 * `EpochHeader`, which now carries call configuration and tool schemas only.
 * There is no cheap authoritative "is a prompt attached" flag left to read, and
 * folding the surface here to reconstruct one would make this frontend a second
 * historical authority over state Harness owns. What `/cache` reports instead is
 * the fact the removal exposed and a cache reader actually needs:
 * {@link RouteContextReading.promptUpdate}, the route's declared handling of a
 * system prompt that CHANGES mid-conversation. `'in-history'` means a changed
 * prompt is appended after the cached history rather than rewriting message 0,
 * which is the difference between a prompt change that survives a prefix cache
 * and one that does not.
 *
 * In particular there is no stability verdict here, and no history. The adopted
 * Harness generation publishes no prefix-stability projection, and a
 * `request/header` event does not even mean the header moved: upstream logs one
 * on resume, and again after a surface replacement, with the header unchanged.
 * So `/cache` reports the latest recorded records and stops.
 *
 * It also never joins the two halves. The buckets are cumulative over the whole
 * session, across every route it used; the header is one record. Naming a header
 * change as the cause of a cache miss would be a claim invented at this layer,
 * and the reader could not check it.
 * @module dshline/cache/model
 */

import type { EpochHeader, RequestContext, Session } from '@deepseek-ai/dsh-session'
import type { SystemPromptUpdate } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type { UsageBuckets } from '../usage.ts'
import { cacheReadShare, usageBuckets } from '../usage.ts'

/**
 * The latest request header Harness recorded.
 *
 * Two facts, both read straight off {@link EpochHeader}: the route, and how many
 * tool schemas were assembled. `EpochHeader` is the request state OUTSIDE
 * derived history, so this describes the head of a request and says nothing
 * about the conversation under it — including the system prompt, which is a
 * surface node of that conversation rather than a header field.
 *
 * Deliberately NOT called the next request's header. A step reassembles the tool
 * list, and may pass it through `agent/request`, before a new header snapshot is
 * logged — so the newest record is what this describes, and the next request is
 * free to carry something else.
 */
export interface RequestHeaderReading {
  /** Whether any header was recorded yet — false before this session's first request. */
  readonly recorded: boolean
  /** The route, as `provider/model`, the form every Harness route id is written in. */
  readonly route: string | undefined
  /** Model-visible tool schemas in that header; 0 for a tool-less request. */
  readonly tools: number
}

/**
 * The latest route metadata Harness recorded, for the one cache-relevant fact
 * it carries.
 *
 * `request/context` is logged only when the route, its capacity, or its
 * system-prompt update mode changes, and upstream states it takes no part in
 * request reconstruction or header equality — so it is read here for exactly
 * one field and never joined to the header above it.
 *
 * `promptUpdate` is absence-defined rather than unknown: upstream documents an
 * absent `systemPromptUpdate` as "only a leading system message is read". That
 * is why {@link recorded} exists separately — before the first
 * `request/context`, nothing is known, and reporting `leading` there would state
 * a route fact nobody logged.
 */
export interface RouteContextReading {
  /** Whether any route metadata was recorded yet. */
  readonly recorded: boolean
  /**
   * How the recorded route takes a system prompt that changes mid-conversation.
   * `'in-history'` reads the latest `system` message at any position; undefined
   * on a recorded route means only the leading one is read.
   */
  readonly promptUpdate: SystemPromptUpdate | undefined
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
  /** The latest route metadata Harness recorded. */
  readonly route: RouteContextReading
}

/** A reading for a session whose first request has not been built yet. */
const NO_HEADER: RequestHeaderReading = {
  recorded: false,
  route: undefined,
  tools: 0,
}

/** A reading for a session whose route metadata has not been logged yet. */
const NO_ROUTE: RouteContextReading = {
  recorded: false,
  promptUpdate: undefined,
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
    tools: header.tools?.length ?? 0,
  }
}

/**
 * Read the latest route metadata Harness recorded.
 *
 * Guarded for the same reason {@link requestHeaderReading} is: the accessor
 * folds `request/context` events and a malformed one throws there, and an
 * inspector that reports nothing beats one that takes the frame down with it.
 * @param session - the session whose log carries the route record.
 * @returns the recorded route's cache-relevant facts, or nothing recorded.
 */
export function routeContextReading(session: Session): RouteContextReading {
  let context: RequestContext | undefined
  try {
    context = session.requestContext()
  } catch {
    return NO_ROUTE
  }
  if (context === undefined) return NO_ROUTE
  return {
    recorded: true,
    ...context.systemPromptUpdate === undefined
      ? { promptUpdate: undefined }
      : { promptUpdate: context.systemPromptUpdate },
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
 * @param route - the latest route metadata Harness recorded.
 * @returns what `/cache` may report.
 */
export function cacheInspection(
  snapshot: ProjectionSnapshot | undefined,
  header: RequestHeaderReading,
  route: RouteContextReading,
): CacheInspection {
  const buckets = usageBuckets(snapshot)
  return {
    projections: snapshot !== undefined,
    buckets,
    cacheReadShare: cacheReadShare(buckets),
    header,
    route,
  }
}

/**
 * The informational note a real provider/model switch earns.
 *
 * Deliberately worded as an expectation about provider behaviour, never a
 * promise about either outcome: dshline has no authority to say whether any
 * particular provider reuses cache across a route change, and saying it would
 * resend the prompt or keep the cache would claim a provider fact nobody
 * reported. The second half is a statement about this frontend's own metric —
 * `/cache` counts the whole session, so a route boundary is not a reset
 * boundary — which is the claim this note exists to make.
 */
export const CACHE_TRANSITION_NOTE
  = 'cache reuse after a provider/model change is provider-dependent; /cache remains session-cumulative'

/**
 * Whether a provider/model switch earns the transition note, and its text.
 *
 * The cache feature's answer to "is this a real provider/model move", decided
 * on the two facts the command seam already has: the selection BEFORE and AFTER
 * the pick. Deliberately no projection cut and no usage reading beside them:
 * deciding "was there prior usage" would need a snapshot captured at exactly
 * the transition, and the seam cannot take one that is both pre-new-route and
 * post-picker while `/model` can run against an in-flight turn — so the note
 * makes none of those claims and depends on nothing race-sensitive. The
 * decision lives here, not in the model picker: model selection is about
 * models, and the note is cache vocabulary, so the seam composes the two rather
 * than the picker knowing about cache.
 *
 * A move is a REAL change of provider or model, and it takes two known
 * selections to prove one: re-selecting what is already active says nothing,
 * and so does either side being undefined — no explicit override before means
 * the effective route is unknown, not that it differs, and no selection after
 * means nothing was applied.
 * @param before - the selection being replaced; undefined when no override existed.
 * @param after - the selection the pick produced; undefined when nothing was applied.
 * @returns the note to print, or undefined when the switch does not earn one.
 */
export function cacheTransitionNote(
  before: ModelSelection | undefined,
  after: ModelSelection | undefined,
): string | undefined {
  if (before === undefined || after === undefined) return undefined
  if (before.provider === after.provider && before.model === after.model) return undefined
  return CACHE_TRANSITION_NOTE
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
