/**
 * Bounded read-only inspector for this session's cache behaviour.
 *
 * Two sections, two authorities, and the overlay never joins them. **Cache
 * accounting** is Harness's cumulative `tokenUsage` buckets, over the whole
 * session and every route it used. **Request header** is `Session.requestHeader()`
 * and `Session.requestContext()` — the LATEST records Harness kept, which are not
 * a promise about the next request: a step may reassemble the tools before a new
 * header is logged. Neither section is presented as evidence about the other.
 *
 * The header section reports no system prompt. Under Session format V3 the
 * prompt is a `system/message` surface node rather than a header field, so
 * `/cache` names the one prompt fact the request head still holds: how the
 * recorded route takes a prompt that changes mid-conversation. See
 * `./model.ts`.
 *
 * There is no preference to set and nothing to mutate: `/cache` observes, and
 * every optimization gesture a cache inspector invites — warning on `/model`,
 * guarding a route, rewriting a request — is control, which belongs to a seam
 * that defines authorization and lifecycle for it rather than to this overlay.
 * @module dshline/cache/overlay
 */

import { escapeControls, formatTokens, paint, truncateToWidth, wrapToWidth } from '@dshline/renderer'
import { createBoundedSurface } from '../surface.ts'
import type { TuiOverlay } from '../slots.ts'
import { formatCacheShare } from '../usage.ts'
import type { CacheInspection, RequestHeaderReading, RouteContextReading } from './model.ts'
import { hasCacheReads } from './model.ts'

/**
 * Widest label plus its gap, so every value starts in one column.
 *
 * Sixteen is `uncached input` and `prompt updates` with room to breathe. A
 * narrower column does not shorten anything, because `padEnd` is a minimum: it
 * just lets the longest label touch its own value while every other row keeps a
 * gap, which reads as a typo rather than as a column.
 */
const LABEL_COLUMN = 16

/**
 * The one line that says when figures would appear.
 *
 * Printed for every absence, because all of them resolve the same way from a
 * reader's side: the numbers arrive when the route's adapter reports them.
 */
const WHEN_AVAILABLE
  = 'dshline will show provider cache usage when the active Harness adapter exposes it.'

/**
 * The accounting's scope, in one line.
 *
 * The figures above are Harness's session-wide `tokenUsage` fold — every route
 * this session used, including ones the session has left. The header section
 * below names ONE recorded request, so without the caption a reader can read
 * the totals as the route beneath them. A provider/model change is a request
 * boundary, not a reset boundary for this metric, and the caption says that
 * without having to say why the numbers did not move.
 */
const SESSION_SCOPE_NOTE = 'Session cumulative · includes requests across provider/model changes'

/** Inputs the cache inspector needs from its owner. */
export interface CacheOverlaySpec {
  /** The current reading, read fresh on every paint. */
  readonly inspection: () => CacheInspection
  /** Remove this temporary overlay. */
  readonly close: () => void
}

/**
 * Create the bounded cache inspector.
 * @param spec - the reading and overlay controls.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createCacheOverlay(spec: CacheOverlaySpec): TuiOverlay {
  return createBoundedSurface<CacheInspection>({
    reading: spec.inspection,
    title: () => 'Cache',
    body: (inspection, width) => bodyRows(inspection, width),
    compact: inspection => compactSummary(inspection),
    close: spec.close,
  })
}

/**
 * The report's rows.
 * @param inspection - the current reading.
 * @param width - display columns available inside the frame.
 * @returns painted rows, one per physical line.
 */
function bodyRows(inspection: CacheInspection, width: number): string[] {
  return [
    ...accountingRows(inspection, width),
    '',
    ...headerRows(inspection.header, inspection.route, width),
  ]
}

/**
 * A sentence, wrapped rather than cut.
 *
 * Every prose line in this report is a whole explanation, and half of one reads
 * as a different, smaller claim — `The Harness token meter is not` says the
 * opposite of what the sentence goes on to say. Painted one row at a time,
 * because a single `paint` over a multi-line string leaves colour switched on at
 * the end of every row but the last.
 * @param text - the sentence.
 * @param width - display columns available inside the frame.
 * @returns one painted row per physical line.
 */
function note(text: string, width: number): string[] {
  return wrapToWidth(text, Math.max(1, width)).map(row => paint(row, 'muted'))
}

/**
 * The accounting section: what the provider reported, cumulatively.
 *
 * The figures appear only when the cache-READ bucket is positive. Harness folds
 * an absent `cacheReadTokens` to zero, so a route that reports no cache reads
 * and a route whose cache went cold arrive here identically — and a printed `0%`
 * would tell a reader the provider missed, which is a claim about a route nobody
 * made. See `hasCacheReads`.
 *
 * The cache-write row is dropped when the provider reported no write. That is
 * not to keep the panel short: the share's denominator is all three prompt
 * buckets, so printing two of the three under a percentage derived from three
 * would leave a reader with arithmetic that does not reconcile.
 * @param inspection - the current reading.
 * @param width - display columns available inside the frame.
 * @returns painted rows.
 */
function accountingRows(inspection: CacheInspection, width: number): string[] {
  const rows = [paint('Cache accounting', 'section-heading')]
  const buckets = inspection.buckets
  if (!hasCacheReads(inspection) || buckets === undefined) {
    rows.push(...note(unavailable(inspection), width), ...note(WHEN_AVAILABLE, width))
  } else {
    const share = formatCacheShare(inspection.cacheReadShare)
    if (share !== undefined) rows.push(fact('cache read', share, width))
    rows.push(
      fact('cached input', formatTokens(buckets.cacheRead), width),
      fact('uncached input', formatTokens(buckets.uncachedInput), width),
    )
    if (buckets.cacheWrite > 0) rows.push(fact('cache write', formatTokens(buckets.cacheWrite), width))
  }
  // The caption belongs to the accounting half, not the header half: it states
  // what the fold's scope is, and the route below it is a separate record.
  rows.push(...note(SESSION_SCOPE_NOTE, width))
  return rows
}

/**
 * Why there is nothing to print, named precisely.
 *
 * Three different absences, and telling them apart is the difference between a
 * reader who can act — mount the meter — and one who cannot. None of them is
 * reported as a claim about the provider: a profile with no token meter says
 * nothing at all about what the route would have reported.
 * @param inspection - the current reading.
 * @returns one line of explanation.
 */
function unavailable(inspection: CacheInspection): string {
  if (!inspection.projections) return 'Session projections are unavailable in this profile.'
  if (inspection.buckets === undefined) return 'The Harness token meter is not mounted.'
  return 'This session has no provider-reported cache reads.'
}

/**
 * The request-header section: what the newest recorded request head is made of.
 *
 * Facts and no verdict. `EpochHeader` is the request state outside derived
 * history — the route and the assembled tool schemas — so these describe the head
 * of a request and not the conversation under it, which is where the system
 * prompt now lives. The caption says `recorded` rather than `next` on purpose: a
 * step may reassemble the tool list before a new header snapshot is logged.
 *
 * The `prompt updates` row comes from `request/context` rather than the header,
 * and appears only once Harness has recorded route metadata: before that, an
 * absent update mode is unknown rather than `leading message`, and printing the
 * default would state a route fact nobody logged.
 * @param header - the latest recorded header reading.
 * @param route - the latest recorded route metadata.
 * @param width - display columns available inside the frame.
 * @returns painted rows.
 */
function headerRows(
  header: RequestHeaderReading,
  route: RouteContextReading,
  width: number,
): string[] {
  const rows = [paint('Request header', 'section-heading')]
  if (!header.recorded) {
    return [...rows, ...note('No request header has been recorded in this session yet.', width)]
  }
  return [
    ...rows,
    fact('route', header.route ?? '', width),
    fact('tools', String(header.tools), width),
    ...route.recorded ? [fact('prompt updates', promptUpdateLabel(route), width)] : [],
    '',
    ...note('Latest request header Harness recorded.', width),
  ]
}

/**
 * How the recorded route takes a mid-conversation system-prompt change, in words.
 *
 * Two answers, both of them upstream's: `in-history` is the declared mode that
 * reads the latest `system` message wherever it sits, and its absence on a
 * recorded route is documented to mean only the leading one is read. A mode this
 * frontend has never seen is named rather than guessed at — `SystemPromptUpdate`
 * is upstream's union to widen.
 * @param route - the latest recorded route metadata.
 * @returns the label for the `prompt updates` row.
 */
function promptUpdateLabel(route: RouteContextReading): string {
  if (route.promptUpdate === undefined) return 'leading message'
  return route.promptUpdate === 'in-history' ? 'in-history' : escapeControls(route.promptUpdate)
}

/**
 * One two-column fact row.
 *
 * Every value here is a number this frontend formatted or an identifier from
 * Harness's own registration vocabulary, so nothing on these rows is model
 * text; the row is still truncated to the frame's width.
 * @param label - the fact's name.
 * @param value - its already-formatted value.
 * @param width - display columns available inside the frame.
 * @returns the painted row.
 */
function fact(label: string, value: string, width: number): string {
  return paint(truncateToWidth(`${label.padEnd(LABEL_COLUMN)}${value}`, Math.max(1, width)), 'muted')
}

/**
 * The one-row truth about cache reads.
 *
 * A share is named only when Harness reported cache reads; otherwise the route's
 * silence is reported as `unreported` rather than as a zero it never claimed.
 * @param inspection - the current reading.
 * @returns the summary phrase, without the shared close suffix.
 */
function compactSummary(inspection: CacheInspection): string {
  const share = hasCacheReads(inspection) ? formatCacheShare(inspection.cacheReadShare) : undefined
  return `cache read ${share ?? 'unreported'}`
}
