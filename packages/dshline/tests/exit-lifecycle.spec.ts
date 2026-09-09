/**
 * The attachment-specific shutdown prelude, exercised through real input paths.
 *
 * The window still owns the global key boundary; this fixture only captures the
 * handler the attachment installs there. A real attachment then proves that
 * local quit commands, idle ctrl-c, Agent cancellation, and lifetime signals all
 * converge on the same ordered prelude before the launcher's app-exit seam.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context as RealContext } from '@deepseek-ai/cordis'
import { type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import { createWindowExitRequest, routeWindowKey } from '../src/window.ts'
import type { Window } from '../src/window.ts'

/** Configuration for one attachment shutdown fixture. */
interface FixtureOptions {
  /** Lifecycle state visible to the attachment. */
  readonly status?: 'idle' | 'running'
  /** Mount a pending `/compact` command to capture its lifetime signal. */
  readonly pendingCommand?: boolean
  /** Make the window's exit-handler cleanup throw when it is cleared. */
  readonly cleanupFailure?: boolean
  /** Make the public Agent cancellation seam throw synchronously. */
  readonly cancelFailure?: boolean
  /** Publish one owned nonterminal Job through the generic Work seam. */
  readonly activeJob?: boolean
  /** Publish a subagent that has settled but is awaiting disposal observation. */
  readonly activeStoppingSubagent?: boolean
}

/** One assembled attachment and the controls needed by these tests. */
interface Fixture {
  readonly dispatch: () => ((key: Key) => void) | undefined
  readonly requestExit: () => void
  readonly globalQuit: () => void
  readonly exit: ReturnType<typeof vi.fn>
  readonly events: string[]
  readonly agent: { readonly status: 'idle' | 'running'; readonly cancel: ReturnType<typeof vi.fn> }
  readonly commandSignal: () => AbortSignal | undefined
  readonly publishStoppingSubagent: () => void
}

/** Let the attachment's submitted command reach its Harness double. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve) })
}

/** Type and submit one line through the real attachment composer. */
function submit(dispatch: ((key: Key) => void) | undefined, line: string): void {
  expect(dispatch).toBeDefined()
  for (const text of [...line]) dispatch?.({ kind: 'text', text })
  dispatch?.({ kind: 'key', name: 'enter' })
}

/** Build one fresh attached session with captured exit and command seams. */
async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const ctx = new RealContext()
  const lifecycle = new Map<string, (info: unknown) => void>()
  const parentCtx = {
    on: (name: string, listener: (info: unknown) => void) => {
      lifecycle.set(name, listener)
      return () => {}
    },
  }
  await ctx.plugin(TuiSlots)
  ctx.provide('tools', { get: () => undefined })
  ctx.provide('userQuestions', {} as never)

  let commandSignal: AbortSignal | undefined
  const commands = {
    list: () => options.pendingCommand
      ? [{ name: 'compact', description: 'Compact older conversation history' }]
      : [],
    execute: vi.fn(async (
      _agent: unknown,
      _line: string,
      _images: readonly unknown[],
      signal: AbortSignal,
    ) => {
      commandSignal = signal
      if (options.pendingCommand) await new Promise<never>(() => {})
      return { commandId: 'exit-test', result: { kind: 'success' as const } }
    }),
  }
  ctx.provide('commands', commands as never)
  ctx.provide('jobs', {
    list: () => options.activeJob
      ? [{
        id: 'job-1', kind: 'subagent', label: 'long child', status: 'running', startedAt: 0,
        ownerSession: 'exit-test', reported: false,
      }]
      : [],
    onJobsChanged: () => () => {},
  } as never)
  if (options.activeStoppingSubagent) {
    ctx.provide('subagents', {
      listChildren: async () => [],
      interrupt: vi.fn(),
    } as never)
  }

  const events: string[] = []
  const exit = vi.fn(() => { events.push('appExit') })
  let exitHandler: (() => void) | undefined
  const setExit = (handler: (() => void) | undefined): void => {
    if (handler === undefined && options.cleanupFailure) throw new Error('cleanup failed')
    exitHandler = handler
  }
  let dispatch: ((key: Key) => void) | undefined
  const windowRequestExit = createWindowExitRequest(exit, () => exitHandler)
  const window = {
    ctx,
    terminal: { columns: () => 80, rows: () => 24 },
    exit,
    startup: { cwd: '/workspace', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: undefined },
    modelInfo: { contextWindow: undefined, reasoning: undefined },
    prefs: {
      usageMode: 'cost',
      timing: false,
      cardDetail: 'compact',
      reasoningVisible: true,
      busyEnter: 'queue',
    },
    colorDepth: 0,
    palette: () => ({}),
    setPalette: () => {},
    themeSettings: {},
    pendingTask: undefined,
    draw: () => {},
    paintNow: () => {},
    commit: () => {},
    clear: () => {},
    refreshModelInfo: () => {},
    requestExit: windowRequestExit,
    setDispatch: (handler: ((key: Key) => void) | undefined) => { dispatch = handler },
    setExit,
  } as unknown as Window
  const agent = {
    ctx: parentCtx,
    session: { id: 'exit-test', header: { cwd: '/workspace' }, events: [] },
    status: options.status ?? 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(() => {
      events.push('cancel')
      if (options.cancelFailure) throw new Error('Agent cancellation failed')
    }),
  }
  const outcome = {
    target: { kind: 'new', cwd: '/workspace' },
    attached: { handle: { agent, dispose: async () => {} }, reopened: false },
  } as unknown as AttachOutcome

  void attachSession(window, outcome)
  expect(exitHandler).toBeDefined()
  return {
    dispatch: () => dispatch,
    requestExit: () => { windowRequestExit() },
    globalQuit: () => { routeWindowKey({ kind: 'key', name: 'ctrl-d' }, windowRequestExit, dispatch) },
    exit,
    events,
    agent,
    commandSignal: () => commandSignal,
    publishStoppingSubagent: () => {
      lifecycle.get('subagent/start')?.({ runId: 'stopping-run', provider: 'probe', id: 'stopping-child', local: false })
      lifecycle.get('subagent/end')?.({
        runId: 'stopping-run', provider: 'probe', id: 'stopping-child', local: false, stopReason: 'completed',
      })
    },
  }
}

describe('attachment exit lifecycle', () => {
  it('routes the local exit and quit commands through one exit behavior', async () => {
    for (const command of ['/exit', '/quit']) {
      const f = await fixture()
      submit(f.dispatch(), command)
      f.globalQuit()
      expect(f.exit).toHaveBeenCalledOnce()
      expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
      expect(f.events).toEqual(['cancel', 'appExit'])
    }
  })

  it('cancels an idle Agent on the same exit path as any other Agent', async () => {
    const f = await fixture()
    f.dispatch()?.({ kind: 'key', name: 'ctrl-c' })
    f.globalQuit()
    expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(f.exit).toHaveBeenCalledOnce()
    expect(f.events).toEqual(['cancel', 'appExit'])
  })

  it('keeps attached ctrl-d one-shot after the prelude clears its handler', async () => {
    const f = await fixture()
    f.globalQuit()
    f.globalQuit()
    expect(f.agent.cancel).toHaveBeenCalledOnce()
    expect(f.exit).toHaveBeenCalledOnce()
  })

  it('does not turn idle ctrl-c into exit while an owned Job remains active', async () => {
    // A background one-shot is result-settled before its consumer-owned dispose
    // finishes; its Job stays nonterminal through that interval. The generic Job
    // snapshot, not the provider process, is the authority this guard consumes.
    const f = await fixture({ activeJob: true })
    f.dispatch()?.({ kind: 'key', name: 'ctrl-c' })
    expect(f.agent.cancel).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
  })

  it('keeps idle ctrl-c attached while a subagent waits for disposal confirmation', async () => {
    const f = await fixture({ activeStoppingSubagent: true })
    f.publishStoppingSubagent()
    f.dispatch()?.({ kind: 'key', name: 'ctrl-c' })
    expect(f.agent.cancel).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
  })

  it('cancels a running Agent instead of exiting on ctrl-c', async () => {
    // This is the foreground result→dispose gap: the parent remains running
    // while its tool awaits consumer-owned provider teardown.
    const f = await fixture({ status: 'running' })
    f.dispatch()?.({ kind: 'key', name: 'ctrl-c' })
    expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(f.exit).not.toHaveBeenCalled()
  })

  it('cancels a running Agent before requesting app exit', async () => {
    const f = await fixture({ status: 'running' })
    submit(f.dispatch(), '/exit')
    expect(f.events).toEqual(['cancel', 'appExit'])
    expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
  })

  it('still requests app exit when Agent cancellation throws synchronously', async () => {
    const f = await fixture({ cancelFailure: true })
    f.requestExit()
    expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(f.exit).toHaveBeenCalledOnce()
    expect(f.events).toEqual(['cancel', 'appExit'])
  })

  it('aborts a pending registered command through the attachment lifetime', async () => {
    const f = await fixture({ pendingCommand: true })
    submit(f.dispatch(), '/compact')
    await flush()
    const signal = f.commandSignal()
    expect(signal).toBeDefined()
    expect(signal?.aborted).toBe(false)

    f.requestExit()
    expect(signal?.aborted).toBe(true)
    expect(f.exit).toHaveBeenCalledOnce()
  })

  it('contains cleanup failure and still requests Harness shutdown', async () => {
    const f = await fixture({ cleanupFailure: true })
    f.requestExit()
    expect(f.exit).toHaveBeenCalledOnce()
  })
})
