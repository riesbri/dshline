/** Read-only goal inspection through the real attachment and Harness registries. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore, { AttachmentId, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import CommandRuntime, { CommandDefinitionId, type CommandInvocation } from '@deepseek-ai/dsh-commands'
import GoalService, { type GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

const NATIVE_ID = CommandDefinitionId('@deepseek-ai/dsh-command-goal')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** No filesystem or image decoder is needed to test registry admission. */
class Images extends AttachmentStore {
  override get imageLimits() {
    return {
      maxImageBytes: 32, maxMessageImageBytes: 64, maxImagesPerMessage: 2,
      maxImagePixels: 100, maxImageDimension: 10,
      mediaTypes: ['image/png'] as const,
    }
  }
  override async validateImage(_input: SaveImageAttachment): Promise<void> {}
  override async saveImage(input: SaveImageAttachment) {
    return { attachmentId: AttachmentId('goal-image'), mediaType: input.mediaType,
      bytes: input.data.byteLength, width: 1, height: 1, name: input.name }
  }
}

/** Flush only queued callbacks; the fixture never mounts a model or goal driver. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

/** Create a genuine registered agent identity, with inert model-delivery methods. */
async function makeAgent(ctx: Context, id: string, seed?: readonly SessionEvent[]) {
  const session = ctx.sessions.create(SessionId(id), seed === undefined ? {} : { seed })
  const agent = {
    id: session.id, session, ctx, options: {}, status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup: vi.fn(), steer: vi.fn(), cancel: vi.fn(), send: vi.fn(), inject: vi.fn(),
    whenIdle: async () => {}, runMaintenance: vi.fn(),
  } as unknown as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['commands'] }))
  await ctx.agents.register(agent)
  return { agent, session, scope }
}

/** Seed valid durable rounds, not a fabricated revision-four create event. */
function rounds(session: Session, goal: GoalView): void {
  for (let round = 1; round <= 3; round += 1) {
    session.append('turn/start', { turn: round })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `admitted round ${String(round)}` }],
      source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: round, reason: { kind: 'completed' } })
  }
}

/** Real service composition; only the terminal and model execution are doubles. */
async function fixture(options: { resumed?: boolean; registered?: boolean; goals?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(TuiSlots)
  if (options.goals !== false) await ctx.plugin(GoalService)
  ctx.provide('tools', { get: () => undefined } as never)
  ctx.provide('userQuestions', {} as never)
  ctx.provide('fs', {
    resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
    readBytes: async () => Uint8Array.of(1, 2, 3), listDir: async () => [],
  } as never)
  new Images(ctx)
  // Identity fixture, NOT the native goal implementation: exercising argued
  // routing must never start the automatic goal driver during a UI test.
  const handler = vi.fn((invocation: CommandInvocation) => invocation.attachments.length > 0 && invocation.rawInput.trim() === ''
    ? { kind: 'error' as const, text: 'Attachments only accompany a goal objective.' }
    : { kind: 'success' as const, text: 'native fixture executed' })
  if (options.registered !== false) ctx.commands.register({
    name: 'goal', definitionId: NATIVE_ID, description: 'Set or view a goal',
    input: { hint: 'objective', attachments: true }, handler,
  })
  const first = await makeAgent(ctx, 'goal-first')
  let active = first
  if (options.resumed) {
    let goal = ctx.goals.create(first.agent, { objective: 'Durable projected objective', maxGoalRounds: 8 })
    rounds(first.session, goal)
    for (let revision = 2; revision <= 4; revision += 1) {
      goal = ctx.goals.edit(first.agent, goal, { objective: 'Durable projected objective' })
    }
    active = await makeAgent(ctx, 'goal-resumed', first.session.snapshotEvents())
    await agentEvents(ctx, active.agent).serial('agent/created', { source: 'resume' })
    expect(ctx.goals.get(active.agent)).toMatchObject({ phase: 'active', activation: 'disarmed', revision: 4, roundsStarted: 3 })
  }
  let dispatch: ((key: Key) => void) | undefined
  let exitHandler: (() => void) | undefined
  let latest = ''
  const commits: string[][] = []
  const draw = vi.fn(() => { latest = stripAnsi(ctx.tuiSlots.compose(100, 40).lines.join('\n')) })
  const window = {
    ctx, terminal: { columns: () => 100, rows: () => 40 }, exit: vi.fn(),
    startup: { cwd: '/scratch', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined), peakHours: [], version: 'test',
    selection: { current: undefined }, modelInfo: { inputModalities: ['text', 'image'] },
    prefs: { usageMode: 'cost', timing: false, cardDetail: 'compact', reasoningVisible: true, busyEnter: 'queue' },
    colorDepth: 0, palette: () => ({}), setPalette: () => {}, themeSettings: {},
    pendingTask: undefined, draw, paintNow: draw,
    commit: (lines: readonly string[]) => { commits.push([...lines]) },
    clear: () => {}, refreshModelInfo: () => {},
    setDispatch: (handler?: (key: Key) => void) => { dispatch = handler },
    setExit: (handler?: () => void) => { exitHandler = handler },
  } as unknown as Window
  const outcome = {
    target: { kind: 'new', cwd: '/scratch' },
    attached: { handle: { agent: active.agent, dispose: async () => {} }, reopened: options.resumed ?? false },
  } as unknown as AttachOutcome
  void attachSession(window, outcome)
  const renderDisposer = ctx.on('tui/render', draw)
  const close = (): void => { exitHandler?.() }
  cleanups.push(async () => { close(); renderDisposer(); await ctx.fiber.dispose() })
  await flush()
  const key = (key: Key): void => { expect(dispatch).toBeDefined(); dispatch?.(key) }
  const submit = async (line: string): Promise<void> => {
    for (const text of [...line]) key({ kind: 'text', text })
    key({ kind: 'key', name: 'enter' })
    await flush()
  }
  return { ctx, ...active, first, handler, draw, commits, close, key, submit, frame: () => latest }
}

describe('native bare /goal inspection through attachSession', () => {
  it.each(['/goal', '/goal   ', '/goal\t'])('opens %j without any command, goal, or session mutation', async line => {
    const f = await fixture({ resumed: true })
    const before = f.session.snapshotEvents()
    const execute = vi.spyOn(f.ctx.commands, 'execute')
    const register = vi.spyOn(f.ctx.commands, 'register')
    const mutations = (['create', 'edit', 'pause', 'resume', 'clear', 'complete', 'block', 'disarm'] as const)
      .map(name => vi.spyOn(f.ctx.goals, name))
    await f.submit(line)
    expect(f.frame()).toContain('Goal')
    expect(f.frame()).toMatch(/Phase\s+active/)
    expect(f.frame()).toMatch(/Continuation\s+disarmed/)
    expect(f.frame()).toMatch(/Rounds\s+3\/8/)
    expect(f.frame()).toMatch(/Revision\s+4/)
    expect(f.frame()).toContain('Durable projected objective')
    expect(f.frame()).toContain(new Date(f.ctx.goals.get(f.agent)!.createdAt).toISOString())
    expect(execute).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
    expect(f.handler).not.toHaveBeenCalled()
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled()
    expect(f.session.snapshotEvents()).toEqual(before)
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.agent.steer).not.toHaveBeenCalled()
    f.key({ kind: 'key', name: 'escape' })
    expect(f.session.snapshotEvents()).toEqual(before)
  })

  it('paints a bare-open inspector through TUI invalidation, not a direct repaint', async () => {
    // Type the line and let every completion refresh settle first, so the only
    // repaint left that can show the overlay is the invalidation `pushOverlay`
    // emits as it mounts. A stray explicit `draw()` after the push would mask a
    // broken invalidation here; none exists, which is the point.
    const f = await fixture({ resumed: true })
    for (const text of [...'/goal']) f.key({ kind: 'text', text })
    await flush()
    f.draw.mockClear()
    f.key({ kind: 'key', name: 'enter' })
    await flush()
    expect(f.frame()).toContain('Goal')
    expect(f.frame()).toMatch(/Phase\s+active/)
  })

  it.each([' edit replacement', ' pause', ' resume', ' clear', ' ordinary objective', '\nedit objective'])('leaves argued /goal%s to Harness execution', async suffix => {
    const f = await fixture()
    await f.submit(`/goal${suffix}`)
    expect(f.handler).toHaveBeenCalledOnce()
    expect(f.handler.mock.calls[0]?.[0].rawInput).toBe(suffix)
    expect(f.session.snapshotEvents().map(event => event.type)).toEqual(['command/run', 'command/done'])
  })

  it.each(['example/scoped-goal', undefined])('honours a real scoped shadow with identity %j', async id => {
    const f = await fixture()
    const shadow = vi.fn(() => ({ kind: 'success' as const, text: 'scoped shadow ran' }))
    const dispose = f.scope.ctx.commands.register({ name: 'goal', description: 'Scoped goal',
      ...(id === undefined ? {} : { definitionId: CommandDefinitionId(id) }), handler: shadow })
    await f.submit('/goal')
    expect(shadow).toHaveBeenCalledOnce()
    expect(f.handler).not.toHaveBeenCalled()
    expect(f.session.snapshotEvents().map(event => event.type)).toEqual(['command/run', 'command/done'])
    dispose()
    await f.submit('/goal')
    expect(f.handler).not.toHaveBeenCalled()
    expect(f.frame()).toContain('Goal')
  })

  it('does not invent an absent native registration', async () => {
    const f = await fixture({ registered: false })
    await f.submit('/goal')
    expect(f.ctx.commands.list(f.agent)).toEqual([])
    expect(f.session.snapshotEvents()).toEqual([])
    expect(f.frame()).not.toMatch(/Continuation\s+/)
    expect(f.agent.followup).not.toHaveBeenCalled()
  })

  it('opens an honest no-goal reading when the native command exists without a goal', async () => {
    // Availability, not absence: the native command resolves, the goal unit is
    // registered, and the goal domain simply has no current goal. The inspector
    // opens and says which of those is true rather than refusing.
    const f = await fixture()
    await f.submit('/goal')
    expect(f.frame()).toContain('Goal')
    expect(f.frame()).toContain('No goal is set for this session.')
    expect(f.frame()).not.toMatch(/Continuation\s+/)
    expect(f.session.snapshotEvents()).toEqual([])
    expect(f.handler).not.toHaveBeenCalled()
  })

  it('keeps staged images on the original command route, including native show rejection', async () => {
    const f = await fixture()
    const execute = vi.spyOn(f.ctx.commands, 'execute')
    await f.submit('/image reference.png')
    await f.submit('/goal')
    expect(execute).toHaveBeenCalledWith(f.agent, '/goal', [expect.objectContaining({ type: 'image', data: 'AQID', name: 'reference.png' })], expect.any(AbortSignal))
    expect(f.handler.mock.calls[0]?.[0].attachments).toEqual([expect.objectContaining({ type: 'image' })])
    expect(f.commits.flat().join('\n')).toContain('Attachments only accompany a goal objective.')
    // Harness rejection restores the composer text; the DRAFT survives. Clearing
    // the restored text makes the empty-composer hint name the kept draft.
    f.key({ kind: 'key', name: 'ctrl-u' })
    await flush()
    expect(f.frame()).toContain('1 image')
    await f.submit('/goal edit new objective')
    expect(f.handler).toHaveBeenCalledTimes(2)
    expect(f.handler.mock.calls[1]?.[0].rawInput).toBe(' edit new objective')
    expect(f.handler.mock.calls[1]?.[0].attachments).toHaveLength(1)
    expect(f.frame()).not.toContain('1 image')
  })

  it('reads all durable fields from projection even when the live service disagrees', async () => {
    const f = await fixture({ resumed: true })
    const actual = f.ctx.goals.get(f.agent)!
    vi.spyOn(f.ctx.goals, 'get').mockReturnValue({ ...actual, activation: 'armed',
      objective: 'WRONG LIVE OBJECTIVE', phase: 'blocked', revision: 99, roundsStarted: 7,
      maxGoalRounds: 100, createdAt: 0, updatedAt: 0,
      blockedReason: { code: 'wrong-blocker', message: 'WRONG LIVE BLOCKER' } })
    await f.submit('/goal')
    expect(f.frame()).toContain('Durable projected objective')
    expect(f.frame()).toMatch(/Phase\s+active/)
    expect(f.frame()).toMatch(/Continuation\s+armed/)
    expect(f.frame()).toMatch(/Rounds\s+3\/8/)
    expect(f.frame()).toMatch(/Revision\s+4/)
    expect(f.frame()).not.toContain('WRONG')
    expect(f.frame()).not.toContain('wrong-blocker')
  })

  it('updates on same-session activation-only edges, filters other sessions, and releases listeners', async () => {
    const f = await fixture({ resumed: true })
    await f.submit('/goal')
    let goal = f.ctx.goals.get(f.agent)!
    goal = f.ctx.goals.resume(f.agent, goal)
    await flush()
    expect(f.frame()).toMatch(/Continuation\s+armed/)
    const before = f.session.snapshotEvents()
    f.draw.mockClear()
    f.ctx.goals.disarm(f.first.agent)
    await flush()
    expect(f.draw).not.toHaveBeenCalled()
    f.ctx.goals.disarm(f.agent)
    await flush()
    expect(f.draw).toHaveBeenCalled()
    expect(f.frame()).toMatch(/Phase\s+active/)
    expect(f.frame()).toMatch(/Continuation\s+disarmed/)
    expect(f.session.snapshotEvents()).toEqual(before)
    f.close()
    f.draw.mockClear()
    f.ctx.emit('goal/activation-changed', { sessionId: f.session.id, goal: { id: goal.id, revision: goal.revision, activation: 'armed' } })
    await flush()
    expect(f.draw).not.toHaveBeenCalled()
  })

  it('shows live durable edits, blocker, and clear without closing inspection', async () => {
    const f = await fixture({ resumed: true })
    await f.submit('/goal')
    let goal = f.ctx.goals.get(f.agent)!
    goal = f.ctx.goals.edit(f.agent, goal, { objective: 'Changed while open' })
    await flush()
    expect(f.frame()).toContain('Changed while open')
    goal = f.ctx.goals.block(f.agent, goal, { code: 'awaiting-input', message: 'Need the approved specification' })
    await flush()
    expect(f.frame()).toContain('awaiting-input')
    expect(f.frame()).toContain('Need the approved specification')
    expect(f.frame()).toMatch(/Phase\s+blocked/)
    f.ctx.goals.clear(f.agent, goal)
    await flush()
    expect(f.frame()).not.toContain('Changed while open')
    expect(f.frame()).toContain('Goal')
  })
})
