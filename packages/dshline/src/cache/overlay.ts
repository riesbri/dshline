/**
 * Bounded read-only inspector for this session's cache behaviour.
 *
 * Two sections, two authorities, and the overlay never joins them. **Cache
 * accounting** is Harness's cumulative `tokenUsage` buckets, over the whole
 * session and every route it used. **Request header** is `Session.requestHeader()`
 * — the LATEST header Harness recorded, which is not a promise about the next
 * request: a step may reassemble the system prompt and tools before a new header
 * is logged. Neither section is presented as evidence about the other.
 *
 * There is no preference to set and nothing to mutate: `/cache` observes, and
 * every optimization gesture a cache inspector invites — warning on `/model`,
 * guarding a route, rewriting a request — is control, which belongs to a seam
 * that defines authorization and lifecycle for it rather than to this overlay.
 * @module dshline/cache/overlay
 */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  formatTokens,
  paint,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import type { TuiOverlay } from '../slots.ts'
import { formatCacheShare } from '../usage.ts'
import type { CacheInspection, RequestHeaderReading } from './model.ts'
import { hasCacheReads } from './model.ts'

/** Rows outside the body: the leading blank and the two frame borders. */
const CACHE_FIXED_ROWS = 3

/** Minimum width whose framed report keeps one physical row per fact. */
const CACHE_MIN_COLUMNS = BOX_CHROME_COLUMNS + 10

/**
 * Widest label plus its gap, so every value starts in one column.
 *
 * Sixteen is `uncached input` and `system prompt` with room to breathe. A
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
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  return {
    render(columns, terminalRows = 24) {
      const inspection = spec.inspection()
      const fallback = (): string[] => compactFallback(inspection, columns, terminalRows)
      if (terminalRows <= CACHE_FIXED_ROWS || columns < CACHE_MIN_COLUMNS) return fallback()
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const candidate = [
        '',
        ...rootFrame({
          columns,
          context: paint('Cache', 'overlay-title'),
          body: bodyRows(inspection, inner),
          footer: fitFooterHelp('esc close', footerBudget(columns)),
        }),
      ]
      // The frame wraps what it is given. Count the rows Screen will draw, so a
      // too-tall report falls back instead of leaking one into scrollback.
      return physicalRows(candidate, columns).length <= terminalRows ? candidate : fallback()
    },
    handleKey(key: Key) {
      if (key.kind !== 'key') return
      if (key.name === 'escape' || key.name === 'ctrl-c') close()
    },
  }
}

/**
 * The report's rows.
 * @param inspection - the current reading.
 * @param width - display columns available inside the frame.
 * @returns painted rows, one per physical line.
 */
function bodyRows(inspection: CacheInspection, width: number): string[] {
  return [...accountingRows(inspection, width), '', ...headerRows(inspection.header, width)]
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
    return [...rows, ...note(unavailable(inspection), width), ...note(WHEN_AVAILABLE, width)]
  }
  const share = formatCacheShare(inspection.cacheReadShare)
  if (share !== undefined) rows.push(fact('cache read', share, width))
  rows.push(
    fact('cached input', formatTokens(buckets.cacheRead), width),
    fact('uncached input', formatTokens(buckets.uncachedInput), width),
  )
  if (buckets.cacheWrite > 0) rows.push(fact('cache write', formatTokens(buckets.cacheWrite), width))
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
 * Three facts and no verdict. `EpochHeader` is the request state outside derived
 * history — the route, the rendered system prompt, the assembled tool schemas —
 * so these describe the head of a request and not the conversation under it. The
 * caption says `recorded` rather than `next` on purpose: a step may reassemble
 * the prompt and the tool list before a new header snapshot is logged.
 * @param header - the latest recorded header reading.
 * @param width - display columns available inside the frame.
 * @returns painted rows.
 */
function headerRows(header: RequestHeaderReading, width: number): string[] {
  const rows = [paint('Request header', 'section-heading')]
  if (!header.recorded) {
    return [...rows, ...note('No request header has been recorded in this session yet.', width)]
  }
  return [
    ...rows,
    fact('route', header.route ?? '', width),
    fact('system prompt', header.system ? 'present' : 'none', width),
    fact('tools', String(header.tools), width),
    '',
    ...note('Latest request header Harness recorded.', width),
  ]
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
 * Count the physical rows Screen will draw for a candidate live region.
 * @param lines - candidate logical lines.
 * @param columns - the terminal's width.
 * @returns the physical rows.
 */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(candidate => wrapToWidth(candidate, Math.max(1, columns)))
}

/**
 * A closable answer for a terminal too small to hold the frame safely.
 * @param inspection - the current reading.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @returns at most one row.
 */
function compactFallback(inspection: CacheInspection, columns: number, rows: number): string[] {
  if (rows <= 0) return []
  const share = hasCacheReads(inspection) ? formatCacheShare(inspection.cacheReadShare) : undefined
  const summary = `cache read ${share ?? 'unreported'} · esc close`
  // One row carries a whole truthful phrase or none of it: a cut figure is
  // worse than no figure, and the way out matters more than either.
  const visible = [summary, 'esc close', 'esc'].find(candidate => displayWidth(candidate) <= columns)
  return visible === undefined ? [] : [paint(visible, 'overlay-headline')]
}
