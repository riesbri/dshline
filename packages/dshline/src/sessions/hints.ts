/**
 * Optional Harness projection hints for session-list titles.
 *
 * The pinned Harness generation exposes a persisted projection cache, but the
 * cache is optional and its API is generation-specific. Keeping this adapter in
 * one small module means dshline consumes the generic Harness service without
 * making the cache a runtime dependency or teaching the catalog about storage
 * paths. A hint is always provisional; exact title reads remain authoritative.
 * @module dshline/sessions/hints
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { SessionTitleHint } from './model.ts'

/** The subset of the pinned generation's optional projection-cache surface. */
interface ProjectionCacheReader {
  cachedSnapshot(
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    keys?: readonly string[],
  ): { readonly values: Readonly<Record<string, unknown>> } | undefined
}

/**
 * Read the optional projection cache without requiring its package at runtime.
 *
 * dshline must still start in profiles that mount only `ctx.sessionQuery`, while
 * the adopted Harness generation defines this service as an optional peer. The
 * type-only import carries the generic Context augmentation without making the
 * cache a runtime dependency. The next target migration can replace this one
 * adapter with the newer header-only signature without changing catalog or
 * overlay code.
 * @param ctx - the Host context carrying optional Harness services.
 * @returns the cache reader, when one is mounted.
 */
function projectionCache(ctx: Context): ProjectionCacheReader | undefined {
  return ctx.get('sessionProjectionCache')
}

/** Read a projected title value without treating null/empty as a title. */
function projectedTitle(values: Readonly<Record<string, unknown>> | undefined): SessionTitleHint | undefined {
  if (values === undefined || !Object.hasOwn(values, 'title')) return undefined
  const title = values.title
  return { title: typeof title === 'string' && title.trim() !== '' ? title : undefined }
}

/**
 * Build a title-hint reader for a Harness context.
 *
 * Unseeded cold sessions have an exact known inherited cut of zero, so the
 * pinned `cachedSnapshot` identity is safe for them. A cold seeded Session is
 * different: `SessionRecord` does not expose its inherited cut, and the pinned
 * cache API requires that exact cut for both current and predecessor reads. The
 * reader therefore returns no hint for every cold seeded row rather than
 * guessing zero or reconstructing the cut from a log. Exact demand-driven title
 * hydration remains the fallback. A live row may use the attached Session's
 * current projection cells; those are still presented as provisional hints
 * because the metadata listing and projection observation are separate cuts.
 * @param ctx - the Host context.
 * @returns a per-record hint reader, or undefined when no optional source exists.
 */
export function sessionTitleHints(
  ctx: Context,
): ((record: SessionRecord) => SessionTitleHint | undefined) | undefined {
  const cache = projectionCache(ctx)
  const sessions = ctx.get('sessions')
  const projections = ctx.get('sessionProjections')
  const titles = ctx.get('sessionTitle')
  if (cache === undefined && sessions === undefined) return undefined
  return (record: SessionRecord): SessionTitleHint | undefined => {
    try {
      if (record.live) {
        const session = sessions?.get(record.header.id)
        if (session === undefined) return undefined
        const current = titles?.get(session)?.title
        if (current !== undefined && current.trim() !== '') return { title: current }
        return projectedTitle(projections?.cachedSnapshot(session, ['title'])?.values)
      }
      // SessionRecord has no inheritedEventCount. The unseeded contract fixes
      // it at zero; the seeded contract does not, so never call either cache
      // read with a fabricated cut.
      if (cache === undefined || record.header.isSeeded) return undefined
      return projectedTitle(cache.cachedSnapshot(record.header, SessionLogOffset(0), ['title'])?.values)
    } catch {
      // Projection hints are optional presentation. A cache miss or malformed
      // derived row must leave the exact title path intact.
      return undefined
    }
  }
}
