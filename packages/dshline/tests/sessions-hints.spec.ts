/** The pinned-generation adapter for optional Harness projection title hints. */

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

describe('pinned Harness session title hints', () => {
  it('uses the known zero inherited cut for an unseeded cold session', () => {
    const cachedSnapshot = vi.fn(() => ({ values: { title: 'Cached title' } }))
    const hints = sessionTitleHints(context({ sessionProjectionCache: { cachedSnapshot } }))
    expect(hints?.(record('cold'))).toEqual({ title: 'Cached title' })
    expect(cachedSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: 'cold' }), 0, ['title'])
  })

  it('never guesses a cold seeded session’s inherited cut or reads an unrelated cache row', () => {
    const cachedSnapshot = vi.fn(() => ({ values: { title: 'Unsafe current row' } }))
    const cachedPredecessorTitle = vi.fn(() => ({ values: { title: 'Unsafe predecessor row' } }))
    const hints = sessionTitleHints(context({
      sessionProjectionCache: { cachedSnapshot, cachedPredecessorTitle },
    }))
    expect(hints?.(record('fork', { isSeeded: true }))).toBeUndefined()
    expect(cachedSnapshot).not.toHaveBeenCalled()
    expect(cachedPredecessorTitle).not.toHaveBeenCalled()
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
