/** Tests for when reopening a session is allowed, and what happens when it fails. */

import { describe, expect, it } from 'vitest'
import type { AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { stripAnsi } from '@dshline/renderer'
import type { SessionEntry } from '../src/sessions/model.ts'
import { planNew, planResume } from '../src/sessions/plan.ts'
import type { AgentOpener, AttachTarget } from '../src/sessions/reopen.ts'
import { attachTarget, newSessionFailureLines, reopenFailureLines, shouldClearDisplay } from '../src/sessions/reopen.ts'

/**
 * A persisted, reopenable session with only the facts the policy reads.
 * @param overrides - fields to replace.
 * @returns the entry.
 */
function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'past' as SessionId,
    title: 'Earlier work',
    createdAt: 0,
    cwd: '/w',
    live: false,
    persisted: true,
    parent: undefined,
    origin: 'own',
    ...overrides,
  }
}

/** The conditions of a quiet, idle window driving one other session. */
const IDLE = { currentSessionId: 'current' as SessionId, busy: false, activeWork: 0 }

describe('whether a session may be reopened', () => {
  it('accepts a persisted session while the window is idle', () => {
    expect(planResume({ target: entry(), ...IDLE })).toEqual({ kind: 'resume' })
  })

  it('accepts from a launch, where there is no session to leave', () => {
    expect(planResume({ target: entry(), currentSessionId: undefined, busy: false, activeWork: 0 }))
      .toEqual({ kind: 'resume' })
  })

  it('refuses the session already open in this window', () => {
    const plan = planResume({ target: entry({ id: 'current' as SessionId, live: true }), ...IDLE })
    expect(plan).toMatchObject({ kind: 'refused' })
    expect(plan.kind === 'refused' && plan.message).toContain('already open')
  })

  it('refuses a live id before it can collide in the session store', () => {
    // Resume prepares the persisted log and enters it into `ctx.sessions`, which
    // refuses a duplicate id. Saying so beats letting the factory throw a store
    // error at a reader who only picked a row.
    const plan = planResume({ target: entry({ live: true }), ...IDLE })
    expect(plan.kind === 'refused' && plan.message).toContain('already live')
  })

  it('refuses a session with no persisted log, which also covers no backend', () => {
    const plan = planResume({ target: entry({ persisted: false }), ...IDLE })
    expect(plan.kind === 'refused' && plan.message).toContain('persistence')
  })

  it('refuses mid-turn rather than retiring an agent that is answering', () => {
    const plan = planResume({ target: entry(), ...IDLE, busy: true })
    expect(plan.kind === 'refused' && plan.message).toContain('current turn')
  })

  it('refuses while work is still attached, which Harness does not model', () => {
    // `AgentHandle.dispose()` unwinds the agent's whole scoped world. No generic
    // seam says whether a job or a delegated child whose owner disappears should
    // stop, be orphaned, or be waited for — so the frontend does not guess.
    const one = planResume({ target: entry(), ...IDLE, activeWork: 1 })
    expect(one.kind === 'refused' && one.message).toBe('1 job or subagent is still attached to this session.')
    const many = planResume({ target: entry(), ...IDLE, activeWork: 3 })
    expect(many.kind === 'refused' && many.message).toBe('3 jobs or subagents are still attached to this session.')
  })

  it('names the reader’s own situation before the capability rules', () => {
    // A busy window looking at its own session should hear "already open", not
    // "finish the turn": the first is true whatever the deployment mounts.
    const plan = planResume({
      target: entry({ id: 'current' as SessionId, live: true, persisted: false }),
      currentSessionId: 'current' as SessionId,
      busy: true,
      activeWork: 2,
    })
    expect(plan.kind === 'refused' && plan.message).toContain('already open')
  })
})

describe('whether a fresh session may be started', () => {
  it('accepts while the current session is idle', () => {
    expect(planNew({ busy: false, activeWork: 0 })).toEqual({ kind: 'new' })
  })

  it('refuses mid-turn with the new-session instruction', () => {
    const plan = planNew({ busy: true, activeWork: 0 })
    expect(plan.kind === 'refused' && plan.message)
      .toBe('Finish or interrupt the current turn before starting a new session.')
  })

  it('refuses while one job or subagent is still attached', () => {
    const plan = planNew({ busy: false, activeWork: 1 })
    expect(plan.kind === 'refused' && plan.message)
      .toBe('1 job or subagent is still attached to this session.')
  })

  it('refuses while several jobs or subagents are still attached', () => {
    const plan = planNew({ busy: false, activeWork: 3 })
    expect(plan.kind === 'refused' && plan.message)
      .toBe('3 jobs or subagents are still attached to this session.')
  })

  it('names the current turn before attached work', () => {
    const plan = planNew({ busy: true, activeWork: 2 })
    expect(plan.kind === 'refused' && plan.message)
      .toBe('Finish or interrupt the current turn before starting a new session.')
  })
})

/**
 * A factory surface that records what it was asked for.
 * @param resume - what `resume` should do, called once per attempt.
 * @returns the opener and its call log.
 */
function opener(resume: (options: ResumeAgentOptions) => Promise<AgentHandle>): {
  agents: AgentOpener
  created: CreateAgentOptions[]
  resumed: ResumeAgentOptions[]
} {
  const created: CreateAgentOptions[] = []
  const resumed: ResumeAgentOptions[] = []
  return {
    created,
    resumed,
    agents: {
      create: async options => {
        created.push(options)
        return handle('created')
      },
      resume: async options => {
        resumed.push(options)
        return resume(options)
      },
    },
  }
}

/**
 * A resolved handle standing in for a live agent.
 * @param label - a marker the assertions can recognise.
 * @returns the handle.
 */
function handle(label: string): AgentHandle {
  return { agent: { label } as unknown as AgentHandle['agent'], dispose: async () => {} }
}

/**
 * The window callbacks {@link attachTarget} drives, with their transcript.
 * @param answers - what the browser answers, in order; exhausted answers dismiss.
 * @returns the spec fields and the recorded reports.
 */
function windowSide(answers: readonly Extract<AttachTarget, { kind: 'resume' }>[]): {
  report: (kind: 'new' | 'resume', reason: string) => void
  ask: () => Promise<Extract<AttachTarget, { kind: 'resume' }> | undefined>
  reportedKinds: Array<'new' | 'resume'>
  reported: string[]
  asked: () => number
} {
  const reported: string[] = []
  const reportedKinds: Array<'new' | 'resume'> = []
  let index = 0
  return {
    reported,
    reportedKinds,
    asked: () => index,
    report: (kind, reason) => {
      reportedKinds.push(kind)
      reported.push(reason)
    },
    ask: async () => answers[index++],
  }
}

describe('attaching the agent a window drives', () => {
  it('creates a fresh session when none was requested', async () => {
    const { agents, created, resumed } = opener(async () => { throw new Error('unused') })
    const side = windowSide([])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'new' })
    expect(outcome!.attached.reopened).toBe(false)
    expect(outcome!.target).toEqual({ kind: 'new' })
    expect(resumed).toHaveLength(0)
    expect(created[0]).toMatchObject({ sessionId: 'dshline-new', meta: { cwd: '/w' } })
    expect(side.reported).toEqual([])
  })

  it('creates an in-window /new in the current resumed workspace, not the startup workspace', async () => {
    const { agents, created } = opener(async () => { throw new Error('unused') })
    const side = windowSide([])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/foo',
      options: {},
      ...side,
    }, { kind: 'new', cwd: '/bar' })
    expect(created[0]).toMatchObject({ meta: { cwd: '/bar' } })
    expect(outcome!.target).toEqual({ kind: 'new', cwd: '/bar' })
  })

  it('stamps a new session\'s header with the resolved preset, when one is mounted', async () => {
    const { agents, created } = opener(async () => { throw new Error('unused') })
    const side = windowSide([])
    await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => 'standard',
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'new' })
    expect(created[0]).toMatchObject({ meta: { cwd: '/w', agentPreset: 'standard' } })
  })

  it('stamps no preset field at all when no roster is mounted', async () => {
    // Not `agentPreset: undefined` — an absent field, so a session created
    // under a profile with no preset roster never looks like one that WAS
    // given a preset and had it cleared.
    const { agents, created } = opener(async () => { throw new Error('unused') })
    const side = windowSide([])
    await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'new' })
    expect(created[0]?.meta).not.toHaveProperty('agentPreset')
  })

  it('reopens the requested session and reports that it replayed one', async () => {
    const { agents, created, resumed } = opener(async () => handle('resumed'))
    const side = windowSide([])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/w',
      options: { agentOptions: { provider: 'p', model: 'm' } },
      ...side,
    }, { kind: 'resume', id: 'past' as SessionId })
    expect(outcome!.attached.reopened).toBe(true)
    expect(created).toHaveLength(0)
    expect(resumed[0]).toMatchObject({ resumeSessionId: 'past', agentOptions: { provider: 'p', model: 'm' } })
  })

  it('reports the reason and asks again rather than substituting a session', async () => {
    // The previous agent is already retired by the time a reopen fails, so a
    // quiet fallback would put the reader in a brand-new session in the launch
    // directory — a different thing wearing the place of what they asked for.
    const { agents, resumed, created } = opener(async options =>
      options.resumeSessionId === 'broken'
        ? Promise.reject(new Error('replay validation failed'))
        : Promise.resolve(handle('resumed')))
    const side = windowSide([{ kind: 'resume', id: 'sound' as SessionId }])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'resume', id: 'broken' as SessionId })
    expect(side.reported).toEqual(['replay validation failed'])
    expect(side.asked()).toBe(1)
    expect(resumed.map(options => options.resumeSessionId)).toEqual(['broken', 'sound'])
    expect(created).toHaveLength(0)
    expect(outcome!.target).toEqual({ kind: 'resume', id: 'sound' })
    expect(outcome!.attached.reopened).toBe(true)
  })

  it('cancels opening without creating when the reader dismisses after resume failure', async () => {
    // A resume request never grants permission for a different Session.
    const { agents, created } = opener(async () => { throw new Error('session persistence is not configured') })
    const side = windowSide([])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'resume', id: 'past' as SessionId })
    expect(side.reported).toEqual(['session persistence is not configured'])
    expect(outcome).toBeUndefined()
    expect(created).toHaveLength(0)
  })

  it('keeps asking while reopening keeps failing, and never loops on its own', async () => {
    // Bounded by the reader, not by a retry count: every attempt is reported and
    // re-asked, and dismissing ends it without inventing a replacement Session.
    const { agents, created, resumed } = opener(async () => { throw new Error('unreadable') })
    const side = windowSide([
      { kind: 'resume', id: 'second' as SessionId },
      { kind: 'resume', id: 'third' as SessionId },
    ])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'resume', id: 'first' as SessionId })
    expect(resumed.map(options => options.resumeSessionId)).toEqual(['first', 'second', 'third'])
    expect(side.reported).toEqual(['unreadable', 'unreadable', 'unreadable'])
    expect(outcome).toBeUndefined()
    expect(created).toHaveLength(0)
  })

  it('reports a thrown non-error too', async () => {
    const { agents } = opener(async () => { throw 'corrupt log' })
    const side = windowSide([])
    await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'resume', id: 'past' as SessionId })
    expect(side.reported).toEqual(['corrupt log'])
  })

  it('lets a failed create reach the boot-failure path', async () => {
    // There is nothing to fall back to and nothing to ask, so this one is not
    // caught: the runner reports it on stderr and exits non-zero.
    const agents: AgentOpener = {
      create: async () => { throw new Error('no factory registered') },
      resume: async () => handle('resumed'),
    }
    const side = windowSide([])
    await expect(attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/w',
      options: {},
      ...side,
    }, { kind: 'new' })).rejects.toThrow('no factory registered')
    expect(side.reported).toEqual([])
    expect(side.asked()).toBe(0)
  })

  it('reports an in-window /new failure and opens the chooser instead of substituting fresh', async () => {
    const created: CreateAgentOptions[] = []
    const resumed: ResumeAgentOptions[] = []
    const agents: AgentOpener = {
      create: async options => {
        created.push(options)
        throw new Error('factory setup failed')
      },
      resume: async options => {
        resumed.push(options)
        return handle('resumed')
      },
    }
    const side = windowSide([{ kind: 'resume', id: 'left-session' as SessionId }])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/foo',
      options: {},
      ...side,
    }, { kind: 'new', cwd: '/bar' })
    expect(side.reportedKinds).toEqual(['new'])
    expect(side.reported).toEqual(['factory setup failed'])
    expect(side.asked()).toBe(1)
    expect(created).toHaveLength(1)
    expect(resumed.map(options => options.resumeSessionId)).toEqual(['left-session'])
    expect(outcome!.target).toEqual({ kind: 'resume', id: 'left-session' })
    expect(outcome!.attached.reopened).toBe(true)
  })

  it('cancels a failed /new without retrying creation on dismissal', async () => {
    const created: CreateAgentOptions[] = []
    const agents: AgentOpener = {
      create: async options => {
        created.push(options)
        if (created.length === 1) throw new Error('first setup failed')
        return handle('created')
      },
      resume: async () => { throw new Error('unused') },
    }
    const side = windowSide([])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => `dshline-new-${created.length}` as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/foo',
      options: {},
      ...side,
    }, { kind: 'new', cwd: '/bar' })
    expect(side.asked()).toBe(1)
    expect(created.map(options => options.meta?.cwd)).toEqual(['/bar'])
    expect(outcome).toBeUndefined()
  })
})

describe('whether a fresh attach should clear the visible display', () => {
  it('clears only a fresh target that carried /clear intent', () => {
    expect(shouldClearDisplay({ kind: 'new', cwd: '/w', clearDisplay: true })).toBe(true)
    // A plain /new and a resumed session keep the existing display.
    expect(shouldClearDisplay({ kind: 'new', cwd: '/w' })).toBe(false)
    expect(shouldClearDisplay({ kind: 'resume', id: 'past' as SessionId })).toBe(false)
  })

  it('carries /clear intent through a successful fresh attach, without leaking it into session metadata', async () => {
    const { agents, created } = opener(async () => { throw new Error('unused') })
    const side = windowSide([])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/foo',
      options: {},
      ...side,
    }, { kind: 'new', cwd: '/bar', clearDisplay: true })
    expect(outcome!.target).toEqual({ kind: 'new', cwd: '/bar', clearDisplay: true })
    expect(shouldClearDisplay(outcome!.target)).toBe(true)
    // `clearDisplay` is presentation, never a fact about the session: the
    // created header stays exactly what a plain /new would record.
    expect(created[0]).toMatchObject({ meta: { cwd: '/bar' } })
    expect(created[0]?.meta).not.toHaveProperty('clearDisplay')
  })

  it('cancels a failed /clear without a fresh attachment or display-clear target', async () => {
    const created: CreateAgentOptions[] = []
    const agents: AgentOpener = {
      create: async options => {
        created.push(options)
        if (created.length === 1) throw new Error('first setup failed')
        return handle('created')
      },
      resume: async () => { throw new Error('unused') },
    }
    const side = windowSide([])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => `dshline-new-${created.length}` as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/foo',
      options: {},
      ...side,
    }, { kind: 'new', cwd: '/bar', clearDisplay: true })
    expect(side.reported).toEqual(['first setup failed'])
    expect(created.map(options => options.meta?.cwd)).toEqual(['/bar'])
    expect(outcome).toBeUndefined()
  })

  it('drops /clear intent when a failed create is answered by resuming a session', async () => {
    const agents: AgentOpener = {
      create: async () => { throw new Error('factory setup failed') },
      resume: async options => handle(String(options.resumeSessionId)),
    }
    const side = windowSide([{ kind: 'resume', id: 'left-session' as SessionId }])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/foo',
      options: {},
      ...side,
    }, { kind: 'new', cwd: '/bar', clearDisplay: true })
    expect(outcome!.target).toEqual({ kind: 'resume', id: 'left-session' })
    expect(shouldClearDisplay(outcome!.target)).toBe(false)
  })

  it('cancels after failed /clear and failed resume without resurrecting creation intent', async () => {
    const created: CreateAgentOptions[] = []
    const agents: AgentOpener = {
      create: async options => {
        created.push(options)
        if (created.length === 1) throw new Error('first setup failed')
        return handle('created')
      },
      resume: async () => { throw new Error('cannot resume') },
    }
    const side = windowSide([
      { kind: 'resume', id: 'first' as SessionId },
    ])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => `dshline-new-${created.length}` as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/foo',
      options: {},
      ...side,
    }, { kind: 'new', cwd: '/bar', clearDisplay: true })
    expect(side.reported).toEqual(['first setup failed', 'cannot resume'])
    expect(created.map(options => options.meta?.cwd)).toEqual(['/bar'])
    expect(outcome).toBeUndefined()
  })

  it('keeps a plain /new indistinguishable from the pre-/clear target', async () => {
    const { agents, created } = opener(async () => { throw new Error('unused') })
    const side = windowSide([])
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/foo',
      options: {},
      ...side,
    }, { kind: 'new', cwd: '/bar' })
    expect(outcome!.target).toEqual({ kind: 'new', cwd: '/bar' })
    expect(shouldClearDisplay(outcome!.target)).toBe(false)
    expect(created[0]).toMatchObject({ meta: { cwd: '/bar' } })
    expect(created[0]?.meta).not.toHaveProperty('clearDisplay')
  })
})

describe('what a failed reopen says', () => {
  it('names the reason and the way out of the browser it is about to open', () => {
    const lines = reopenFailureLines('replay validation failed').map(stripAnsi)
    expect(lines[0]).toContain('could not reopen that session: replay validation failed')
    expect(lines[1]).toContain('close the browser to exit')
  })

  it('escapes a reason it did not compose', () => {
    // Harness messages can carry a filesystem path, and a persisted log can put
    // anything in one.
    const lines = reopenFailureLines(`before${String.fromCharCode(27)}[2Jafter`)
    expect(lines.join('\n')).not.toContain(String.fromCharCode(27) + '[2J')
    expect(stripAnsi(lines[0] ?? '')).toContain('after')
  })
})

describe('what a failed in-window /new says', () => {
  it('names the actual create reason and returns control to Sessions', () => {
    const lines = newSessionFailureLines('factory setup failed').map(stripAnsi)
    expect(lines[0]).toContain('could not start a new session: factory setup failed')
    expect(lines[1]).toContain('choose a session')
    expect(lines[1]).toContain('close the browser to exit')
  })

  it('escapes a create reason it did not compose', () => {
    const lines = newSessionFailureLines(`before${String.fromCharCode(27)}[2Jafter`)
    expect(lines.join('\n')).not.toContain(String.fromCharCode(27) + '[2J')
    expect(stripAnsi(lines[0] ?? '')).toContain('after')
  })
})
