/**
 * Workspace membership: written after a creation, never before, and never
 * unwound.
 *
 * Three orderings are asserted here, and each of them is a mistake this code
 * exists to avoid: attaching before `ctx.agents.create` resolved would leave
 * phantom membership behind a failed creation; deleting a created session
 * because the attach refused would throw away the only thing that worked; and
 * re-attaching a RESUMED session would re-root a conversation whose header is
 * the authority for where it lives.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { stripAnsi } from '@dshline/renderer'
import type { AgentOpener, AttachOutcome, AttachTarget } from '../src/sessions/reopen.ts'
import { attachTarget } from '../src/sessions/reopen.ts'
import type { WorkspaceEntry, WorkspaceRegistryReads } from '../src/worktrees/harness.ts'
import { recordWorkspaceMembership } from '../src/worktrees/harness.ts'
import { recordAttachmentMembership } from '../src/worktrees/membership.ts'

/** One attach the registry recorded. */
interface Attachment {
  readonly workspaceId: string
  readonly sessionId: SessionId
}

/** A registry over one workspace, recording what it was asked to attach. */
function registryOf(
  workspaces: readonly { readonly id: string; readonly path: string }[],
  rejects?: Error,
): { readonly registry: WorkspaceRegistryReads; readonly attached: Attachment[] } {
  const attached: Attachment[] = []
  const entry = (row: { readonly id: string; readonly path: string }): WorkspaceEntry => ({
    id: row.id,
    path: row.path,
    title: row.id,
    sessionIds: [],
    attachSession: async (sessionId) => {
      if (rejects !== undefined) throw rejects
      attached.push({ workspaceId: row.id, sessionId })
    },
    status: async () => 'ok',
  })
  return {
    attached,
    registry: {
      list: () => workspaces.map(entry),
      get: (id) => {
        const row = workspaces.find(candidate => candidate.id === id)
        return row === undefined ? undefined : entry(row)
      },
      resolveByPath: async (path) => {
        const row = workspaces.find(candidate => candidate.path === path)
        return row === undefined ? undefined : entry(row)
      },
      create: async path => entry({ id: 'ws-created', path }),
    },
  }
}

/**
 * A context carrying (or not carrying) the registry.
 * @param registry - the registry to publish, when this profile mounts one.
 * @returns the fake context.
 */
function contextOf(registry: WorkspaceRegistryReads | undefined): Context {
  return {
    get: (name: string) => (name === 'workspaceRegistry' ? registry : undefined),
  } as unknown as Context
}

/**
 * A handle whose agent reports one session id.
 * @param sessionId - the created session's id.
 * @returns the handle.
 */
function handle(sessionId: string): AgentHandle {
  return {
    agent: { session: { id: sessionId as SessionId } } as unknown as AgentHandle['agent'],
    dispose: async () => {},
  }
}

/**
 * The outcome the loop hands the membership write.
 * @param target - the target that succeeded.
 * @param sessionId - the created or resumed session id.
 * @returns the outcome.
 */
function outcomeOf(target: AttachTarget, sessionId: string): AttachOutcome {
  return { target, attached: { handle: handle(sessionId), reopened: target.kind === 'resume' } }
}

/**
 * A factory surface that records what it was asked for.
 * @param createRejects - a creation failure this case wants.
 * @returns the opener and its call log.
 */
function opener(createRejects?: Error): {
  readonly agents: AgentOpener
  readonly created: CreateAgentOptions[]
  readonly resumed: ResumeAgentOptions[]
} {
  const created: CreateAgentOptions[] = []
  const resumed: ResumeAgentOptions[] = []
  return {
    created,
    resumed,
    agents: {
      create: async (options) => {
        created.push(options)
        if (createRejects !== undefined) throw createRejects
        return handle(String(options.sessionId))
      },
      resume: async (options) => {
        resumed.push(options)
        return handle(String(options.resumeSessionId))
      },
    },
  }
}

describe('recording membership through the authoritative Workspace API', () => {
  it('attaches the created session to the workspace it was started from', async () => {
    const { registry, attached } = registryOf([{ id: 'ws-auth', path: '/src/auth' }])
    expect(await recordWorkspaceMembership(contextOf(registry), 'ws-auth', 'dshline-1' as SessionId))
      .toEqual({ kind: 'attached' })
    expect(attached).toEqual([{ workspaceId: 'ws-auth', sessionId: 'dshline-1' }])
  })

  it('reports a workspace the registry no longer holds instead of inventing one', async () => {
    const { registry, attached } = registryOf([{ id: 'ws-auth', path: '/src/auth' }])
    expect(await recordWorkspaceMembership(contextOf(registry), 'ws-gone', 'dshline-1' as SessionId))
      .toEqual({ kind: 'unknown' })
    expect(attached).toEqual([])
  })

  it('reports Harness\'s own refusal verbatim', async () => {
    const { registry } = registryOf(
      [{ id: 'ws-auth', path: '/src/auth' }],
      new Error("cannot attach session 'dshline-1': its cwd resolves to '/elsewhere'"),
    )
    expect(await recordWorkspaceMembership(contextOf(registry), 'ws-auth', 'dshline-1' as SessionId))
      .toEqual({
        kind: 'failed',
        message: "cannot attach session 'dshline-1': its cwd resolves to '/elsewhere'",
      })
  })

  it('says there was nothing to record when no registry is mounted', async () => {
    expect(await recordWorkspaceMembership(contextOf(undefined), 'ws-auth', 'dshline-1' as SessionId))
      .toEqual({ kind: 'unavailable' })
  })
})

describe('the membership write the loop performs', () => {
  it('records a /worktrees fresh session and commits nothing', async () => {
    const { registry, attached } = registryOf([{ id: 'ws-auth', path: '/src/auth' }])
    const committed: string[] = []
    await recordAttachmentMembership(
      contextOf(registry),
      outcomeOf({ kind: 'new', cwd: '/src/auth', workspaceId: 'ws-auth' }, 'dshline-1'),
      lines => committed.push(...lines.map(stripAnsi)),
    )
    expect(attached).toEqual([{ workspaceId: 'ws-auth', sessionId: 'dshline-1' }])
    expect(committed).toEqual([])
  })

  it('never re-roots a resumed session, whose own header is the authority', async () => {
    const { registry, attached } = registryOf([{ id: 'ws-auth', path: '/src/auth' }])
    await recordAttachmentMembership(
      contextOf(registry),
      outcomeOf({ kind: 'resume', id: 's-old' as SessionId }, 's-old'),
      () => {},
    )
    expect(attached).toEqual([])
  })

  it('records nothing for an ordinary /new or /clear transition', async () => {
    const { registry, attached } = registryOf([{ id: 'ws-auth', path: '/src/auth' }])
    await recordAttachmentMembership(
      contextOf(registry),
      outcomeOf({ kind: 'new', cwd: '/src/auth' }, 'dshline-2'),
      () => {},
    )
    expect(attached).toEqual([])
  })

  it('keeps the session and says the membership did not land', async () => {
    const { registry } = registryOf(
      [{ id: 'ws-auth', path: '/src/auth' }],
      new Error('session persistence holds no such session'),
    )
    const committed: string[] = []
    await recordAttachmentMembership(
      contextOf(registry),
      outcomeOf({ kind: 'new', cwd: '/src/auth', workspaceId: 'ws-auth' }, 'dshline-1'),
      lines => committed.push(...lines.map(stripAnsi)),
    )
    expect(committed[0]).toContain('the session started, but Harness did not record it')
    expect(committed[0]).toContain('session persistence holds no such session')
    expect(committed[1]).toContain('the conversation is fine')
  })

  it('reports a workspace that left the registry between the choice and the creation', async () => {
    const { registry } = registryOf([{ id: 'ws-auth', path: '/src/auth' }])
    const committed: string[] = []
    await recordAttachmentMembership(
      contextOf(registry),
      outcomeOf({ kind: 'new', cwd: '/src/gone', workspaceId: 'ws-gone' }, 'dshline-1'),
      lines => committed.push(...lines.map(stripAnsi)),
    )
    expect(committed[0]).toContain('no longer in the Harness registry')
  })

  it('stays quiet in a profile that mounts no Workspace registry', async () => {
    const committed: string[] = []
    await recordAttachmentMembership(
      contextOf(undefined),
      outcomeOf({ kind: 'new', cwd: '/src/auth', workspaceId: 'ws-auth' }, 'dshline-1'),
      lines => committed.push(...lines.map(stripAnsi)),
    )
    expect(committed).toEqual([])
  })
})

describe('the attachment transition a /worktrees choice produces', () => {
  it('creates the fresh session in the selected workspace and carries its identity out', async () => {
    const { agents, created, resumed } = opener()
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/launch/dir',
      options: {},
      report: () => {},
      ask: async () => ({ kind: 'new', afterDismissal: true }),
    }, { kind: 'new', cwd: '/src/auth', workspaceId: 'ws-auth' })
    expect(resumed).toHaveLength(0)
    expect(created[0]).toMatchObject({ meta: { cwd: '/src/auth' } })
    // The id reaches the loop's membership write on the target that SUCCEEDED,
    // which is the only place it is read.
    expect(outcome.target).toEqual({ kind: 'new', cwd: '/src/auth', workspaceId: 'ws-auth' })
  })

  it('resumes an existing session by id alone, naming no workspace', async () => {
    const { agents, created, resumed } = opener()
    const outcome = await attachTarget({
      agents,
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/launch/dir',
      options: {},
      report: () => {},
      ask: async () => ({ kind: 'new', afterDismissal: true }),
    }, { kind: 'resume', id: 's-old' as SessionId })
    expect(created).toHaveLength(0)
    expect(resumed[0]).toMatchObject({ resumeSessionId: 's-old' })
    // No `cwd` and no `workspaceId`: a resumed session's own header is the
    // authority for where it lives, and re-rooting it here is the exact
    // mistake this shape prevents.
    expect(outcome.target).toEqual({ kind: 'resume', id: 's-old' })
  })

  it('writes no membership for a creation that failed, because nothing was created', async () => {
    const { agents } = opener(new Error('provider route missing'))
    const { registry, attached } = registryOf([{ id: 'ws-auth', path: '/src/auth' }])
    const reported: string[] = []
    const outcome = await attachTarget({
      agents: {
        create: async (options) => {
          if (options.meta?.cwd === '/src/auth') return await agents.create(options)
          return handle(String(options.sessionId))
        },
        resume: agents.resume,
      },
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/launch/dir',
      options: {},
      report: (_kind, reason) => reported.push(reason),
      ask: async () => ({ kind: 'resume', id: 's-old' as SessionId }),
    }, { kind: 'new', cwd: '/src/auth', workspaceId: 'ws-auth' })
    expect(reported).toEqual(['provider route missing'])
    // The reader recovered onto a resumed session, so the workspace identity
    // is gone with the target that failed.
    expect(outcome.target).toEqual({ kind: 'resume', id: 's-old' })
    await recordAttachmentMembership(contextOf(registry), outcome, () => {})
    expect(attached).toEqual([])
  })

  it('keeps the chosen workspace alive across a retried fresh attempt', async () => {
    let attempts = 0
    const created: CreateAgentOptions[] = []
    const outcome = await attachTarget({
      agents: {
        create: async (options) => {
          created.push(options)
          attempts += 1
          if (attempts === 1) throw new Error('transient')
          return handle(String(options.sessionId))
        },
        resume: async () => { throw new Error('unused') },
      },
      newSessionId: () => 'dshline-new' as SessionId,
      newSessionPreset: () => undefined,
      cwd: '/launch/dir',
      options: {},
      report: () => {},
      // A plain dismissal, which carries neither a cwd nor a workspace of its own.
      ask: async () => ({ kind: 'new', afterDismissal: true }),
    }, { kind: 'new', cwd: '/src/auth', workspaceId: 'ws-auth' })
    expect(created).toHaveLength(2)
    expect(created[1]).toMatchObject({ meta: { cwd: '/src/auth' } })
    expect(outcome.target).toMatchObject({ cwd: '/src/auth', workspaceId: 'ws-auth' })
  })
})
