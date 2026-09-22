/** Tests for the pure construction of the current-session hub reading. */

import { describe, expect, it } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { CurrentSessionReading, CurrentSessionReadingInput } from '../src/session/model.ts'
import { currentSessionReading } from '../src/session/model.ts'
import type { SessionFact } from '../src/sessions/model.ts'

/** A fixed clock, so the Created age is exact. */
const NOW = 1_800_000_000_000

/** The session the reading identifies. */
const SESSION_ID = 'current-session' as SessionId

/** The home the workspace path is shortened against. */
const HOME = '/home/dev'

/** Created ninety seconds before the injected clock, which reads as 2m ago. */
const CREATED_AT = NOW - 90_000

/**
 * One header carrying only the facts a test does not override.
 * @param overrides - fields to replace; leaving a field out leaves it absent.
 * @returns the header.
 */
function header(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: 3,
    id: SESSION_ID,
    createdAt: CREATED_AT,
    isSeeded: false,
    ...overrides,
  }
}

/**
 * One reading built from a header plus top-level overrides.
 * @param headerOverrides - header fields to replace.
 * @param overrides - already-resolved input values to replace.
 * @returns the raw reading.
 */
function build(
  headerOverrides: Partial<SessionHeader> = {},
  overrides: Partial<CurrentSessionReadingInput> = {},
): CurrentSessionReading {
  return currentSessionReading({
    session: { id: SESSION_ID, header: header(headerOverrides) },
    title: undefined,
    stats: undefined,
    home: HOME,
    now: NOW,
    ...overrides,
  })
}

/**
 * The facts of a reading, every build of which names its session.
 * @param headerOverrides - header fields to replace.
 * @param overrides - already-resolved input values to replace.
 * @returns the fact lines, in display order.
 */
function facts(
  headerOverrides: Partial<SessionHeader> = {},
  overrides: Partial<CurrentSessionReadingInput> = {},
): readonly SessionFact[] {
  const reading = build(headerOverrides, overrides)
  if (reading.sessionId === undefined) throw new Error('expected a reading that names its session')
  return reading.facts ?? []
}

/**
 * The labels of a reading's facts, for order assertions.
 * @param headerOverrides - header fields to replace.
 * @param overrides - already-resolved input values to replace.
 * @returns the labels, in display order.
 */
function labels(
  headerOverrides: Partial<SessionHeader> = {},
  overrides: Partial<CurrentSessionReadingInput> = {},
): readonly string[] {
  return facts(headerOverrides, overrides).map(fact => fact.label)
}

/** Every fact label the reading can state. */
const FULL_HEADER: Partial<SessionHeader> = {
  cwd: '/home/dev/projects/dshline',
  agentPreset: 'code',
  parentSession: 'parent-session' as SessionId,
}

describe('the current-session reading shape', () => {
  it('names its session, always carries facts, and omits an absent title', () => {
    const reading = build()
    expect(reading.sessionId).toBe(SESSION_ID)
    expect('title' in reading).toBe(false)
    expect('facts' in reading).toBe(true)
    expect(facts().length).toBeGreaterThan(0)
  })

  it('carries the resolved title when there is one', () => {
    const reading = build({}, { title: 'Fix the wrap bug' })
    expect('title' in reading).toBe(true)
    expect(reading).toMatchObject({ sessionId: SESSION_ID, title: 'Fix the wrap bug' })
  })

  it('states Created from the injected clock, not the wall clock', () => {
    expect(facts()[0]).toEqual({ label: 'Created', value: '2m ago' })
  })
})

describe('workspace facts', () => {
  it('states the header workspace, shortened against the injected home', () => {
    const workspace = facts(FULL_HEADER).find(fact => fact.label === 'Workspace')
    expect(workspace?.value).toBe('~/projects/dshline')
  })

  it('leaves the full path when no home is known', () => {
    const workspace = facts({ cwd: '/srv/build' }, { home: undefined })
      .find(fact => fact.label === 'Workspace')
    expect(workspace?.value).toBe('/srv/build')
  })

  it('drops the fact entirely when the header records no cwd', () => {
    const reading = build()
    const text = JSON.stringify(reading)
    expect(text).not.toContain('Workspace')
    // No startup/process cwd may stand in for a header that records none.
    expect(text).not.toContain(process.cwd())
    expect(text).not.toContain('unknown')
  })
})

describe('activity facts', () => {
  it('states authoritative turn and step totals in the fixed wording', () => {
    const activity = facts({}, { stats: { turns: 12, steps: 34 } })
      .find(fact => fact.label === 'Activity')
    expect(activity?.value).toBe('12 turns · 34 steps')
  })

  it('disappears when no stats exist, without a placeholder', () => {
    const text = JSON.stringify(build())
    expect(text).not.toContain('Activity')
    expect(text).not.toContain('unknown')
  })
})

describe('optional header facts', () => {
  it('states the preset when the header records one', () => {
    expect(facts({ agentPreset: 'code' }).find(fact => fact.label === 'Preset')?.value)
      .toBe('code')
  })

  it('drops the preset when the header records none', () => {
    expect(labels()).not.toContain('Preset')
  })

  it('states the parent when the header records one', () => {
    expect(facts({ parentSession: 'parent-session' as SessionId })
      .find(fact => fact.label === 'Parent')?.value).toBe('parent-session')
  })

  it('drops the parent when the header records none', () => {
    expect(labels()).not.toContain('Parent')
  })
})

describe('fact order', () => {
  it('keeps the fixed display order when every fact is present', () => {
    expect(labels(FULL_HEADER, { stats: { turns: 3, steps: 7 } })).toEqual([
      'Workspace',
      'Created',
      'Preset',
      'Activity',
      'Parent',
      'Session',
    ])
  })

  it('keeps the session id last when earlier facts are absent', () => {
    const all = facts()
    const last = all[all.length - 1]
    expect(last).toEqual({ label: 'Session', value: 'current-session' })
  })

  it('keeps the session id last when every optional fact is present', () => {
    const all = facts(FULL_HEADER, { stats: { turns: 3, steps: 7 } })
    const last = all[all.length - 1]
    expect(last?.label).toBe('Session')
    expect(last?.value).toBe('current-session')
  })
})
