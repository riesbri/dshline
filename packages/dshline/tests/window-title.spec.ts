/** Terminal identity belongs to the window, not its changing Agent. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Key } from '@dshline/renderer'
import { createWindow } from '../src/window.ts'
import { runWindowSessions } from '../src/index.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'

const terminal = vi.hoisted(() => ({
  setTitle: vi.fn(), close: vi.fn(),
  key: undefined as ((key: Key) => void) | undefined,
}))
vi.mock('@dshline/renderer', async importOriginal => ({
  ...await importOriginal<typeof import('@dshline/renderer')>(),
  acquireTerminal: () => ({
    columns: () => 80, rows: () => 24, write: () => {},
    setTitle: terminal.setTitle, close: terminal.close,
    onResize: () => () => {},
    onKey: (listener: (key: Key) => void) => {
      terminal.key = listener
      return () => { terminal.key = undefined }
    },
  }),
}))
// Title tests do not need the unrelated process-global stderr shim.
vi.mock('../src/stderr.ts', () => ({ holdStderrOffTerminal: () => () => {} }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

/** Real window and slots; fake only the external Harness/terminal capabilities. */
async function fixture(cwd: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TuiSlots)
  ctx.provide('tuiStartup', { options: { cwd, resume: undefined, task: undefined } } as never)
  const exit = vi.fn()
  ctx.provide('appExit', exit)
  ctx.provide('tools', { get: () => undefined } as never)
  ctx.provide('commands', { list: () => [] } as never)
  ctx.provide('userQuestions', {} as never)
  const preference = <T>(value: T) => ({ current: () => value, watch: () => () => {}, save: async () => {} })
  const w = await createWindow(ctx, {
    pricing: pricingFrom(undefined), peakHours: [], version: 'test',
    settings: { theme: preference('default'), busyEnter: preference('queue' as const) },
  })
  return { ctx, w, exit }
}

/** Send a terminal-local command through the window's actual key subscription. */
function submit(line: string): void {
  for (const text of line) terminal.key?.({ kind: 'text', text })
  terminal.key?.({ kind: 'key', name: 'enter' })
}

describe('window terminal title', () => {
  it.each([
    ['/code/dshline', 'dshline'], ['/code/eastbound-for-us/', 'eastbound-for-us'],
    ['/code/portfolio///', 'portfolio'], ['/code/portfolio/.', 'portfolio'],
    ['/code/portfolio/..', 'code'], ['.', 'portfolio'], ['..', 'code'],
    ['../eastbound', 'eastbound'], ['/', '/'], ['///', '/'], ['', 'workspace'],
    ['/code/工作🚀', '工作🚀'], ['/code/a\\b', 'a\\b'],
    ['/code/unsafe\u001b\u0007\u009c', 'unsafe\u001b\u0007\u009c'],
  ])('identifies startup workspace %j, leaving payload security to renderer', async (cwd, name) => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    vi.spyOn(process, 'cwd').mockReturnValue('/code/portfolio')
    await fixture(cwd)
    expect(terminal.setTitle.mock.calls).toEqual([[`dshline · ${name}`]])
  })

  it.each([
    ['C:\\code\\portfolio\\', 'portfolio'], ['C:\\', 'C:\\'], ['C:/', 'C:\\'],
    ['.', 'portfolio'], ['..', 'code'], ['..\\eastbound', 'eastbound'],
    ['C:\\code\\portfolio\\.', 'portfolio'],
    ['\\\\server\\share\\', 'share'],
  ])('uses native Windows basename/root semantics for %j', async (cwd, name) => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\code\\portfolio')
    await fixture(cwd)
    expect(terminal.setTitle.mock.calls).toEqual([[`dshline · ${name}`]])
  })

  it('keeps launch identity through real /sessions and /new attachment replacements', async () => {
    const { ctx, w, exit } = await fixture('/launch/portfolio')
    const selectedId = SessionId('elsewhere')
    const selected = Session.create(selectedId, undefined, {
      version: SESSION_FORMAT_VERSION, id: selectedId, createdAt: 0,
      cwd: '/another/workspace', isSeeded: false,
    })
    const handles: AgentHandle[] = []
    const handle = (session: Session): AgentHandle => {
      const result = {
        agent: { session, status: 'idle', inbox: { nextStep: [], nextTurn: [] },
          followup: vi.fn(), steer: vi.fn(), cancel: vi.fn() },
        dispose: vi.fn(async () => {}),
      } as unknown as AgentHandle
      handles.push(result)
      return result
    }
    const create = vi.fn(async (options: CreateAgentOptions) => handle(Session.create(options.sessionId!, undefined, {
      version: SESSION_FORMAT_VERSION, id: options.sessionId!, createdAt: 0, isSeeded: false, ...options.meta,
    })))
    const resume = vi.fn(async () => handle(selected))
    ctx.provide('agents', { create, resume } as never)
    ctx.provide('sessionQuery', {
      listSessions: async () => [{ header: selected.header, live: false, persisted: true }],
      filterSessions: async () => [{ header: selected.header, live: false, persisted: true }],
      readTitleSnapshots: async () => [],
    } as never)
    // Like the real launcher, appExit owns shutdown rather than settling a turn.
    void runWindowSessions(w)
    await vi.waitFor(() => expect(handles).toHaveLength(1))
    await new Promise<void>(resolve => setImmediate(resolve))
    submit('/sessions')
    await vi.waitFor(() => expect(ctx.tuiSlots.activeOverlay).toBeDefined())
    await new Promise<void>(resolve => setImmediate(resolve))
    ctx.tuiSlots.activeOverlay?.render(80, 24)
    terminal.key?.({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(ctx.tuiSlots.activeOverlay).toBeUndefined())
    submit('/new')
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1]?.[0].meta?.cwd).toBe('/another/workspace')
    w.draw()
    w.selection.current = undefined
    w.refreshModelInfo()
    expect(terminal.setTitle.mock.calls).toEqual([['dshline · portfolio']])
    expect(terminal.close).not.toHaveBeenCalled()
    terminal.key?.({ kind: 'key', name: 'ctrl-d' })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce())
    await ctx.fiber.dispose()
    expect(terminal.close).toHaveBeenCalledOnce()
    expect(terminal.setTitle.mock.calls).toEqual([['dshline · portfolio']])
  })
})
