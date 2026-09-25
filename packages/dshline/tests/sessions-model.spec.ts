/** Tests for the vocabulary a session browser needs before it draws anything. */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEntry } from '../src/sessions/model.ts'
import {
  CURRENT,
  filterEntries,
  filterEntriesWithState,
  matchesQuery,
  relativeAge,
  sessionFacts,
  sessionLabel,
  shortWorkspace,
  UNTITLED,
} from '../src/sessions/model.ts'

/** A fixed clock, so every age assertion is exact. */
const NOW = 1_800_000_000_000

/**
 * One listable session with only the facts a test cares about.
 * @param overrides - fields to replace.
 * @returns the entry.
 */
function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'dshline-1' as SessionId,
    title: 'Fix the wrap bug',
    createdAt: NOW,
    cwd: '/home/dev/projects/dshline',
    live: false,
    persisted: true,
    parent: undefined,
    origin: 'own',
    ...overrides,
  }
}

describe('how old a session reads', () => {
  it('steps through minutes, hours, days, and weeks', () => {
    expect(relativeAge(NOW, NOW)).toBe('just now')
    expect(relativeAge(NOW - 90_000, NOW)).toBe('2m ago')
    expect(relativeAge(NOW - 59 * 60_000, NOW)).toBe('59m ago')
    expect(relativeAge(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
    expect(relativeAge(NOW - 3 * 86_400_000, NOW)).toBe('3d ago')
    expect(relativeAge(NOW - 21 * 86_400_000, NOW)).toBe('3w ago')
  })

  it('reads a clock skewed into the future as just now', () => {
    // A persisted header carries the timestamp of whichever machine wrote it, so
    // a negative age is reachable. "in -2m" is worse than saying nothing precise.
    expect(relativeAge(NOW + 120_000, NOW)).toBe('just now')
  })
})

describe('what a row is called', () => {
  it('uses the folded title', () => {
    expect(sessionLabel(entry())).toBe('Fix the wrap bug')
  })

  it('names an untitled session without pretending it has a title', () => {
    // The placeholder is a RENDERING choice: the entry keeps `undefined`, so the
    // matcher below cannot report a hit on the word "untitled".
    expect(sessionLabel(entry({ title: undefined }))).toBe(UNTITLED)
    expect(sessionLabel(entry({ title: '   ' }))).toBe(UNTITLED)
  })

  it('names an untitled current session by its relationship to the window', () => {
    expect(sessionLabel(entry({ title: undefined }), entry().id)).toBe(CURRENT)
    expect(sessionLabel(entry({ title: '   ' }), entry().id)).toBe(CURRENT)
  })
})

describe('shortening a workspace', () => {
  it('replaces the home prefix, which never distinguishes two rows', () => {
    expect(shortWorkspace('/home/dev/projects/dshline', '/home/dev')).toBe('~/projects/dshline')
  })

  it('shortens the home directory itself', () => {
    expect(shortWorkspace('/home/dev', '/home/dev')).toBe('~')
  })

  it('leaves a path that only shares a prefix segment alone', () => {
    // `/home/developer` starts with `/home/dev` as a STRING but is a different
    // directory; abbreviating it would name a folder the session never used.
    expect(shortWorkspace('/home/developer/work', '/home/dev')).toBe('/home/developer/work')
  })

  it('answers nothing for a header with no workspace', () => {
    expect(shortWorkspace(undefined, '/home/dev')).toBeUndefined()
  })

  it('leaves the path alone when the home directory is unknown', () => {
    expect(shortWorkspace('/srv/build', undefined)).toBe('/srv/build')
  })
})

describe('matching a typed query', () => {
  it('matches the title case-insensitively', () => {
    expect(matchesQuery(entry(), 'WRAP')).toBe(true)
  })

  it('matches the workspace, which is often what a reader remembers', () => {
    expect(matchesQuery(entry({ title: 'untitled work' }), 'dshline')).toBe(true)
  })

  it('matches the id, so a pasted id finds its session', () => {
    expect(matchesQuery(entry({ id: 'dshline-abc-123' as SessionId }), 'abc-123')).toBe(true)
  })

  it('collapses whitespace runs on both sides', () => {
    // A title folded out of a wrapped prompt can carry a newline where the reader
    // types one space.
    expect(matchesQuery(entry({ title: 'Fix   the\nwrap bug' }), 'fix the wrap')).toBe(true)
  })

  it('does not match the untitled placeholder', () => {
    expect(matchesQuery(entry({ title: undefined }), 'untitled')).toBe(false)
  })

  it('matches everything for an empty or blank query', () => {
    expect(matchesQuery(entry(), '')).toBe(true)
    expect(matchesQuery(entry(), '   ')).toBe(true)
  })
})

describe('filtering a listing', () => {
  const listing = [
    entry({ id: 'a' as SessionId, title: 'Roadmap review' }),
    entry({ id: 'b' as SessionId, title: 'Fix the wrap bug' }),
    entry({ id: 'c' as SessionId, title: 'Wrap CJK correctly' }),
  ]

  it('keeps Harness order rather than ranking by its own idea of relevance', () => {
    // Newest-first is the corpus's order. Re-sorting here would invent a ranking
    // the corpus never agreed to; asking for one is what the content tier is for.
    expect(filterEntries(listing, 'wrap').map(match => match.id)).toEqual(['b', 'c'])
  })

  it('returns the same listing for an empty query', () => {
    expect(filterEntries(listing, '')).toBe(listing)
  })

  it('returns nothing rather than everything when nothing matches', () => {
    expect(filterEntries(listing, 'attachments')).toEqual([])
  })
})

describe('title resolution while a picker is loading', () => {
  it('does not call a pending title untitled or a negative match', () => {
    const pending = entry({ title: undefined, titleState: { kind: 'pending' } })
    expect(sessionLabel(pending)).toBe('loading title…')
    expect(filterEntriesWithState([pending], 'untitled')).toEqual({ entries: [], complete: false })
  })

  it('keeps workspace and id matches useful before the title settles', () => {
    const pending = entry({ id: 'session-abc' as SessionId, title: undefined, cwd: '/w/project', titleState: { kind: 'pending' } })
    expect(filterEntriesWithState([pending], 'project').entries).toEqual([pending])
    expect(filterEntriesWithState([pending], 'abc').entries).toEqual([pending])
  })

  it('lets a late exact title add a match', () => {
    const pending = entry({ title: undefined, titleState: { kind: 'pending' } })
    const exact = entry({ title: 'late title', titleState: { kind: 'exact', title: 'late title' } })
    expect(filterEntriesWithState([pending], 'late').entries).toEqual([])
    expect(filterEntriesWithState([exact], 'late')).toEqual({ entries: [exact], complete: true })
  })

  it('does not present a provisional hint as exact and removes it after reconciliation', () => {
    const provisional = entry({ title: 'cached old', titleState: { kind: 'provisional', title: 'cached old' } })
    expect(sessionLabel(provisional)).toBe('~ cached old')
    expect(filterEntriesWithState([provisional], 'old').complete).toBe(false)
    const exact = entry({ title: 'new exact', titleState: { kind: 'exact', title: 'new exact' } })
    expect(filterEntriesWithState([exact], 'old').entries).toEqual([])
  })

  it('distinguishes exact absence from an unreadable observation', () => {
    const exactNone = entry({ title: undefined, titleState: { kind: 'exact', title: undefined } })
    const failed = entry({ title: undefined, titleState: { kind: 'failed', title: undefined, message: 'no read' } })
    expect(sessionLabel(exactNone)).toBe(UNTITLED)
    expect(sessionLabel(failed)).toBe('title unavailable')
    expect(filterEntriesWithState([exactNone, failed], 'anything').complete).toBe(false)
  })
})

describe('the facts a disclosed session states', () => {
  /** The context every fact assertion shares. */
  const context = { home: '/home/dev', now: NOW } as const

  /**
   * The facts as a lookup, so an assertion names one fact rather than an index.
   * @param facts - the produced fact lines.
   * @returns label-to-value.
   */
  function byLabel(facts: readonly { label: string; value: string }[]): Record<string, string> {
    return Object.fromEntries(facts.map(fact => [fact.label, fact.value]))
  }

  it('states only what Harness answered, and omits the rest', () => {
    // A session with no recorded workspace, no parent, and no landed log read
    // has three fewer facts — not three facts reading `unknown`.
    const facts = byLabel(sessionFacts(entry({ cwd: undefined }), undefined, context))
    expect(facts).toEqual({
      Created: 'just now',
      Origin: 'own',
      Availability: 'persisted',
      Session: 'dshline-1',
    })
  })

  it('adds the log-derived facts once the bounded read has landed', () => {
    const facts = byLabel(sessionFacts(entry(), { events: 214, lastActivityAt: NOW - 600_000 }, context))
    expect(facts.Events).toBe('214')
    expect(facts.Activity).toBe('10m ago')
    expect(facts.Workspace).toBe('~/projects/dshline')
  })

  it('states an event count without a last activity for an empty log', () => {
    // A fork inherits a header and can carry no events of its own yet; claiming
    // an activity time for that log would be inventing one.
    const facts = byLabel(sessionFacts(entry(), { events: 0, lastActivityAt: undefined }, context))
    expect(facts.Events).toBe('0')
    expect(facts.Activity).toBeUndefined()
  })

  it('reports both availabilities when the corpus holds both', () => {
    const facts = byLabel(sessionFacts(entry({ live: true }), undefined, context))
    expect(facts.Availability).toBe('live · persisted')
  })

  it('names the parent and the delegated origin when the header records them', () => {
    const facts = byLabel(sessionFacts(
      entry({ origin: 'delegated', parent: 'dshline-0' as SessionId }),
      undefined,
      context,
    ))
    expect(facts.Origin).toBe('delegated')
    expect(facts.Parent).toBe('dshline-0')
  })

  it('orders the identifying facts before the quotable one', () => {
    // A short terminal keeps a prefix of this list, so the order is the policy:
    // the id is what a reader needs last and least.
    const labels = sessionFacts(entry(), { events: 3, lastActivityAt: NOW }, context).map(fact => fact.label)
    expect(labels).toEqual(['Workspace', 'Created', 'Activity', 'Events', 'Origin', 'Availability', 'Session'])
  })
})
