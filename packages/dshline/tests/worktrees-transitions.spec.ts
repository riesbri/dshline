/**
 * What a `/worktrees` choice becomes, and what it deliberately does not carry.
 *
 * Two transitions, and each one's ABSENCES are the assertions: a fresh session
 * carries a cwd and nothing else — no workspace id, no membership write, no
 * second accounting path — and a resumed session carries an id and nothing
 * else, because its own `SessionHeader.cwd` stays authoritative and re-rooting
 * a conversation is the mistake this shape prevents.
 */

import { describe, expect, it } from 'vitest'
import type { AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentOpener, AttachTarget } from '../src/sessions/reopen.ts'
import { attachTarget } from '../src/sessions/reopen.ts'

/**
 * A resolved handle standing in for a live agent.
 * @param sessionId - the session it drives.
 * @returns the handle.
 */
function handle(sessionId: string): AgentHandle {
  return {
    agent: { session: { id: sessionId as SessionId } } as unknown as AgentHandle['agent'],
    dispose: async () => {},
  }
}

/**
 * A factory surface that records what it was asked for.
 * @param createRejects - a creation failure for the first attempt only.
 * @returns the opener and its call log.
 */
function opener(createRejects?: Error): {
  readonly agents: AgentOpener
  readonly created: CreateAgentOptions[]
  readonly resumed: ResumeAgentOptions[]
} {
  const created: CreateAgentOptions[] = []
  const resumed: ResumeAgentOptions[] = []
  let attempts = 0
  return {
    created,
    resumed,
    agents: {
      create: async (options) => {
        created.push(options)
        attempts += 1
        if (createRejects !== undefined && attempts === 1) throw createRejects
        return handle(String(options.sessionId))
      },
      resume: async (options) => {
        resumed.push(options)
        return handle(String(options.resumeSessionId))
      },
    },
  }
}

/**
 * Drive one transition through the real attachment resolver.
 * @param first - the target the picker produced.
 * @param answers - what the browser answers on each recovery ask.
 * @param createRejects - a creation failure for the first attempt only.
 * @returns the outcome, the call log, and what was reported.
 */
async function attach(
  first: AttachTarget,
  answers: readonly AttachTarget[] = [],
  createRejects?: Error,
): Promise<{
  readonly target: AttachTarget
  readonly created: CreateAgentOptions[]
  readonly resumed: ResumeAgentOptions[]
  readonly reported: string[]
}> {
  const { agents, created, resumed } = opener(createRejects)
  const reported: string[] = []
  let index = 0
  const outcome = await attachTarget({
    agents,
    newSessionId: () => 'dshline-new' as SessionId,
    newSessionPreset: () => undefined,
    cwd: '/launch/dir',
    options: {},
    report: (_kind, reason) => reported.push(reason),
    ask: async () => answers[index++] ?? { kind: 'new', afterDismissal: true },
  }, first)
  return { target: outcome.target, created, resumed, reported }
}

describe('a fresh session in the chosen directory', () => {
  it('creates it with that cwd stamped into the header, and carries nothing else', async () => {
    const { target, created, resumed } = await attach({ kind: 'new', cwd: '/home/me/src/dshline-auth' })
    expect(resumed).toHaveLength(0)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      sessionId: 'dshline-new',
      meta: { cwd: '/home/me/src/dshline-auth' },
    })
    // The cwd IS the whole transition: Harness stamps it into the immutable
    // header, which is what any later grouping reads, so there is no
    // membership to record and no other field to carry.
    expect(target).toEqual({ kind: 'new', cwd: '/home/me/src/dshline-auth' })
    expect(Object.keys(target)).toEqual(['kind', 'cwd'])
  })

  it('writes no session metadata beyond cwd and the resolved preset', async () => {
    const { created } = await attach({ kind: 'new', cwd: '/home/me/src/dshline-auth' })
    expect(Object.keys(created[0]?.meta ?? {})).toEqual(['cwd'])
  })

  it('keeps its cwd through a retried attempt after a failed creation', async () => {
    const { target, created, reported } = await attach(
      { kind: 'new', cwd: '/home/me/src/dshline-auth' },
      // A plain dismissal, which carries no cwd of its own.
      [{ kind: 'new', afterDismissal: true }],
      new Error('provider route missing'),
    )
    expect(reported).toEqual(['provider route missing'])
    expect(created).toHaveLength(2)
    expect(created[1]).toMatchObject({ meta: { cwd: '/home/me/src/dshline-auth' } })
    expect(target).toMatchObject({ cwd: '/home/me/src/dshline-auth' })
  })

  it('reports a creation Harness refused rather than substituting a directory', async () => {
    const { target, reported } = await attach(
      { kind: 'new', cwd: '/home/me/src/deleted' },
      [{ kind: 'resume', id: 's-old' as SessionId }],
      new Error("cwd '/home/me/src/deleted' does not exist"),
    )
    // The ordinary Harness creation failure, surfaced by the ordinary recovery
    // path. There is no second filesystem truth check in the picker.
    expect(reported).toEqual(["cwd '/home/me/src/deleted' does not exist"])
    expect(target).toEqual({ kind: 'resume', id: 's-old' })
  })
})

describe('an existing session in the chosen directory', () => {
  it('resumes by id alone and never supplies a cwd', async () => {
    const { target, created, resumed } = await attach({ kind: 'resume', id: 's3' as SessionId })
    expect(created).toHaveLength(0)
    expect(resumed[0]).toMatchObject({ resumeSessionId: 's3' })
    expect(Object.keys(resumed[0] ?? {})).toEqual(['resumeSessionId'])
    // The resumed session's own header cwd remains authoritative; a `cwd` here
    // would re-root the conversation the reader asked to reopen.
    expect(target).toEqual({ kind: 'resume', id: 's3' })
  })
})

describe('the attachment vocabulary itself', () => {
  it('has no workspace identity on either transition', async () => {
    const fresh = await attach({ kind: 'new', cwd: '/home/me/src/dshline' })
    const resumed = await attach({ kind: 'resume', id: 's1' as SessionId })
    for (const target of [fresh.target, resumed.target]) {
      expect(Object.keys(target)).not.toContain('workspaceId')
    }
  })

  it('leaves an ordinary /new and /clear transition exactly as they were', async () => {
    const plain = await attach({ kind: 'new', cwd: '/home/me/src/dshline' })
    expect(plain.target).toEqual({ kind: 'new', cwd: '/home/me/src/dshline' })
    const cleared = await attach({ kind: 'new', cwd: '/home/me/src/dshline', clearDisplay: true })
    expect(cleared.target).toEqual({
      kind: 'new',
      cwd: '/home/me/src/dshline',
      clearDisplay: true,
    })
  })
})
