/**
 * Optional Harness projection hints for session-list titles.
 *
 * The adopted Harness generation exposes a persisted projection cache, but the
 * cache is optional. Keeping this reader in one small module means dshline
 * consumes the generic Harness service without making the cache a runtime
 * dependency or teaching the catalog about storage paths. A hint is always
 * provisional; exact title reads remain authoritative.
 * @module dshline/sessions/hints
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { SessionTitleHint } from './model.ts'

/** Read a projected title value without treating null/empty as a title. */
function projectedTitle(values: Readonly<Record<string, unknown>> | undefined): SessionTitleHint | undefined {
  if (values === undefined || !Object.hasOwn(values, 'title')) return undefined
  const title = values.title
  return { title: typeof title === 'string' && title.trim() !== '' ? title : undefined }
}

/**
 * Build a title-hint reader for a Harness context.
 *
 * A cold row's hint comes from the projection cache's header-only read, and the
 * adopted generation serves a seeded row and an unseeded row from it the same
 * way: Harness matches the cached checkpoint against the lifecycle identity a
 * `SessionHeader` alone witnesses (`formatVersion`, `createdAt`, `cwd`,
 * `isSeeded`) and returns nothing at all on a mismatch. The reader therefore
 * passes the header and nothing else — it never reconstructs an inherited event
 * count, which `SessionRecord` does not carry and the current read no longer
 * asks for.
 *
 * A live row may use the attached Session's current projection cells; those are
 * still presented as provisional hints because the metadata listing and the
 * projection observation are separate cuts.
 * @param ctx - the Host context.
 * @returns a per-record hint reader, or undefined when no optional source exists.
 */
export function sessionTitleHints(
  ctx: Context,
): ((record: SessionRecord) => SessionTitleHint | undefined) | undefined {
  const cache = ctx.get('sessionProjectionCache')
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
      if (cache === undefined) return undefined
      return projectedTitle(cache.cachedSnapshot(record.header, ['title'])?.values)
    } catch {
      // Projection hints are optional presentation. A cache miss or malformed
      // derived row must leave the exact title path intact.
      return undefined
    }
  }
}
