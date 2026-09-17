/** The real window loop and shared Sessions browser over captured Harness opening seams. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import { runWindowSessions } from '../src/index.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import { createWindowExitRequest, routeWindowKey } from '../src/window.ts'
import type { Window } from '../src/window.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

/** Build a window with real slots, browser, attachment and loop; only external services are fake. */
async function fixture(resume: boolean | string | undefined, failure?: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TuiSlots)
  ctx.provide('tools', { get: () => undefined })
  ctx.provide('commands', { list: () => [] } as never)
  ctx.provide('userQuestions', {} as never)
  const selectedId = SessionId('selected')
  const selected = Session.create(selectedId, undefined, {
    version: SESSION_FORMAT_VERSION, id: selectedId, createdAt: 0, cwd: '/original', isSeeded: false,
  })
  const records = [{ header: selected.header, live: false, persisted: true }]
  const listing = vi.fn(async () => records)
  ctx.provide('sessionQuery', {
    listSessions: listing,
    filterSessions: listing,
    readTitleSnapshots: async () => [],
  } as never)
  const handles: AgentHandle[] = []
  const makeHandle = (session: Session): AgentHandle => {
    const handle = {
      agent: {
        session, status: 'idle', inbox: { nextStep: [], nextTurn: [] },
        followup: vi.fn(), steer: vi.fn(), cancel: vi.fn(),
      },
      dispose: vi.fn(async () => {}),
    } as unknown as AgentHandle
    handles.push(handle)
    return handle
  }
  const create = vi.fn(async (options: CreateAgentOptions) => makeHandle(
    Session.create(options.sessionId!, undefined, {
      version: SESSION_FORMAT_VERSION, id: options.sessionId!, createdAt: 0, isSeeded: false,
      ...options.meta,
    }),
  ))
  const openResume = vi.fn(async (options: ResumeAgentOptions) => {
    if (failure !== undefined && options.resumeSessionId !== 'selected') throw new Error(failure)
    return makeHandle(selected)
  })
  ctx.provide('agents', { create, resume: openResume } as never)
  let dispatch: ((key: Key) => void) | undefined
  let exitHandler: (() => void) | undefined
  const exit = vi.fn()
  const requestExit = createWindowExitRequest(exit, () => exitHandler)
  const commits: string[] = []
  const clear = vi.fn()
  const w = {
    ctx, terminal: { columns: () => 80, rows: () => 24 }, exit, requestExit,
    startup: { cwd: '/launch', resume, task: undefined },
    pricing: pricingFrom(undefined), peakHours: [], version: 'test',
    selection: { current: undefined, assembled: undefined },
    modelInfo: { contextWindow: undefined, reasoning: undefined, inputModalities: undefined },
    prefs: { usageMode: 'cost', timing: false, cardDetail: 'compact', reasoningVisible: true, busyEnter: 'queue' },
    colorDepth: 0, pendingTask: undefined,
    draw: () => {}, paintNow: () => {}, clear,
    commit: (lines: readonly string[]) => commits.push(...lines.map(stripAnsi)),
    setDispatch: (handler: typeof dispatch) => { dispatch = handler },
    setExit: (handler: typeof exitHandler) => { exitHandler = handler },
  } as unknown as Window
  const loop = runWindowSessions(w)
  const key = (name: Extract<Key, { kind: 'key' }>['name']) => {
    ctx.tuiSlots.activeOverlay?.render(80, 24)
    routeWindowKey({ kind: 'key', name }, requestExit, dispatch)
  }
  const submit = (line: string) => {
    for (const text of line) routeWindowKey({ kind: 'text', text }, requestExit, dispatch)
    key('enter')
  }
  const browser = async () => {
    await vi.waitFor(() => expect(ctx.tuiSlots.activeOverlay).toBeDefined())
    await vi.waitFor(() => expect(listing).toHaveBeenCalled())
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return { ctx, w, loop, key, submit, browser, create, resume: openResume, handles, exit, commits, clear }
}

describe('session launch intent lifecycle', () => {
  it('explicit resume cancellation exits without creating or resuming a Session', async () => {
    const f = await fixture(true)
    f.w.pendingTask = 'must not submit on cancellation'
    await f.browser()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
    f.key('escape')
    await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(0))
    await f.loop
    expect(f.create).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.handles).toHaveLength(0)
    expect(f.commits).toEqual([])
    expect(f.w.pendingTask).toBe('must not submit on cancellation')
    expect(f.ctx.tuiSlots.activeOverlay).toBeUndefined()
  })

  it('explicit resume success opens the selected durable id without a create-new target', async () => {
    const f = await fixture(true)
    await f.browser()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
    f.key('enter')
    await vi.waitFor(() => expect(f.resume).toHaveBeenCalledOnce())
    expect(f.resume.mock.calls[0]?.[0].resumeSessionId).toBe('selected')
    expect(f.handles[0]?.agent.session.id).toBe('selected')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.commits.join('\n')).toContain('resumed an empty session')
    f.key('ctrl-d')
  })

  it('global quit exits from the launch resume browser without a fresh Session', async () => {
    const f = await fixture(true)
    await f.browser()
    f.key('ctrl-d')
    f.key('ctrl-d')
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
    // Harness shuts down through appExit rather than settling the browser.
    // Close it in the fixture too, proving later cancellation still cannot create.
    f.key('escape')
    await f.loop
    expect(f.exit).toHaveBeenCalledOnce()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('resume failure reports Harness reason and cancellation never creates a replacement', async () => {
    const f = await fixture('broken', 'writer is already owned')
    await f.browser()
    expect(f.commits.join('\n')).toContain('could not reopen that session: writer is already owned')
    expect(f.create).not.toHaveBeenCalled()
    f.key('escape')
    await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(0))
    await f.loop
    expect(f.resume).toHaveBeenCalledOnce()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.handles).toHaveLength(0)
  })

  it('resume failure retries only the session explicitly selected in the recovery browser', async () => {
    const f = await fixture('broken', 'replay validation failed')
    await f.browser()
    f.key('enter')
    await vi.waitFor(() => expect(f.handles).toHaveLength(1))
    expect(f.resume.mock.calls.map(([options]) => options.resumeSessionId)).toEqual(['broken', 'selected'])
    expect(f.create).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
    f.key('ctrl-d')
  })

  it('normal launch creates once and in-session /sessions cancellation keeps that attachment', async () => {
    const f = await fixture(undefined)
    await vi.waitFor(() => expect(f.handles).toHaveLength(1))
    const original = f.handles[0]!
    f.submit('/sessions')
    await f.browser()
    f.key('escape')
    await vi.waitFor(() => expect(f.ctx.tuiSlots.activeOverlay).toBeUndefined())
    expect(f.handles).toEqual([original])
    expect(original.dispose).not.toHaveBeenCalled()
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
    f.key('ctrl-d')
  })

  it.each(['/new', '/clear'])('explicit %s still creates a fresh Session in the resumed workspace', async command => {
    const f = await fixture('selected')
    await vi.waitFor(() => expect(f.handles).toHaveLength(1))
    f.submit(command)
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce())
    expect(f.create.mock.calls[0]?.[0].meta?.cwd).toBe('/original')
    expect(f.handles[1]?.agent.session.id).not.toBe('selected')
    expect(f.handles[0]?.dispose).toHaveBeenCalledOnce()
    expect(f.clear).toHaveBeenCalledTimes(command === '/clear' ? 1 : 0)
    f.key('ctrl-d')
  })

  it('query Esc clears before root Esc cancels, and dismissal stays cancellation', async () => {
    // Not a planResume refusal — the query simply matches nothing, so the row
    // a real refusal needs does not exist. planResume's refusals are held by
    // sessions-plan.spec.ts through the browser's own `resume` callback.
    const f = await fixture(true)
    await f.browser()
    f.submit('no matching session')
    f.key('escape')
    expect(f.exit).not.toHaveBeenCalled()
    expect(f.ctx.tuiSlots.activeOverlay).toBeDefined()
    f.key('escape')
    await f.loop
    expect(f.create).not.toHaveBeenCalled()
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.exit).toHaveBeenCalledOnce()
  })
})
