/**
 * Optional Harness projection title hints, over the adopted generation's
 * header-only cache contract.
 *
 * The interesting case is the cold SEEDED row. It used to have no hint at all:
 * the previous cache API demanded an exact `inheritedEventCount` that a listed
 * `SessionRecord` does not carry, so returning nothing was the only honest
 * answer. The adopted generation matches a cached checkpoint against the
 * lifecycle identity a header alone witnesses — `formatVersion`, `createdAt`,
 * `cwd`, `isSeeded` — and Harness owns that comparison. So the reader passes the
 * header and nothing else, and a seeded row is served exactly like an unseeded
 * one. Both tests below fail if that `isSeeded` guard is ever reintroduced.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import { sessionTitleHints } from '../src/sessions/hints.ts'

/** One header with the lifecycle fields the pinned cache checks. */
function header(id: string, isSeeded = false): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: id as SessionId,
    createdAt: 1_000,
    cwd: '/w',
    isSeeded,
  }
}

/** One listed record. */
function record(id: string, options: { readonly live?: boolean; readonly isSeeded?: boolean } = {}): SessionRecord {
  return {
    header: header(id, options.isSeeded ?? false),
    live: options.live ?? false,
    persisted: true,
  }
}

/** A Context carrying only the optional services this adapter reads. */
function context(services: Readonly<Record<string, unknown>>): Context {
  return { get: (key: string) => services[key] } as unknown as Context
}

describe('Harness session title hints', () => {
  it('reads a cold row through the header-only cache contract', () => {
    const cachedSnapshot = vi.fn(() => ({ values: { title: 'Cached title' } }))
    const hints = sessionTitleHints(context({ sessionProjectionCache: { cachedSnapshot } }))
    expect(hints?.(record('cold'))).toEqual({ title: 'Cached title' })
    // The header is the WHOLE argument. A second positional argument here would
    // be a fabricated inherited cut, which this generation no longer accepts.
    expect(cachedSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: 'cold' }), ['title'])
  })

  it('serves a cold seeded row from the same read, with no inherited count to guess', () => {
    const cachedSnapshot = vi.fn(() => ({ values: { title: 'Seeded cached title' } }))
    const hints = sessionTitleHints(context({ sessionProjectionCache: { cachedSnapshot } }))
    expect(hints?.(record('fork', { isSeeded: true }))).toEqual({ title: 'Seeded cached title' })
    expect(cachedSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: 'fork' }), ['title'])
  })

  it('uses the attached live projection when a live record is listed', () => {
    const live = { id: 'live' as SessionId } as never
    const cachedSnapshot = vi.fn(() => ({ values: { title: 'Live hint' } }))
    const hints = sessionTitleHints(context({
      sessions: { get: () => live },
      sessionProjections: { cachedSnapshot },
    }))
    expect(hints?.(record('live', { live: true }))).toEqual({ title: 'Live hint' })
    expect(cachedSnapshot).toHaveBeenCalledWith(live, ['title'])
  })

  it('leaves live rows pending when the live projection is unavailable', () => {
    const live = { id: 'live' as SessionId } as never
    const hints = sessionTitleHints(context({
      sessions: { get: () => live },
      sessionProjections: { cachedSnapshot: vi.fn(() => undefined) },
    }))
    expect(hints?.(record('live', { live: true }))).toBeUndefined()
  })

  it('treats cache failures as misses', () => {
    const cachedSnapshot = vi.fn(() => { throw new Error('cache unavailable') })
    const hints = sessionTitleHints(context({ sessionProjectionCache: { cachedSnapshot } }))
    expect(hints?.(record('cold'))).toBeUndefined()
    expect(cachedSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not require optional services', () => {
    expect(sessionTitleHints(context({}))).toBeUndefined()
  })
})
