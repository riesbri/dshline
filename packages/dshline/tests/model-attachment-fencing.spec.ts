/**
 * A model selection is WINDOW state, but the gesture editing it belongs to one
 * attachment epoch. Gates hold real catalog, exact-info, and persistence seams;
 * keys always pass through the real window quit routing and attachment dispatch.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import { SessionScope } from '../src/session-scope.ts'
import { createWindowExitRequest, routeWindowKey, type Window } from '../src/window.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'

/** Wide enough that footer truncation cannot obscure the attachment's live rows. */
const COLUMNS = 120
const ROWS = 24
const INITIAL = { provider: 'route', model: 'old', reasoningEffort: 'high' } as ModelSelection
const CATALOG = [{ id: 'old', name: 'Old' }, { id: 'next', name: 'Next' }]
const INFO = {
  provider: 'route', id: 'next', name: 'Next',
  reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] },
} as LlmResolvedModelInfo

/** Producer-controlled settlement, independent of time and cooperative abort. */
function gate<T>() {
  let release!: (value: T) => void
  let fail!: (error: Error) => void
  const promise = new Promise<T>((resolve, reject) => { release = resolve; fail = reject })
  return { promise, release, fail }
}

/** Drain continuations after releasing a gate; never wait by elapsed time. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve) })
}

/** One shared window, with real attachment epochs and separately observed effects. */
async function fixture({ delaySave = false } = {}) {
  const ctx = new Context()
  await ctx.plugin(TuiSlots)
  // Keep the real dynamic import in /model, but make the catalog-request gate
  // independent of the test runner's first-time module transformation.
  await import('../src/subagent-model-selection/index.ts')
  const catalog = gate<typeof CATALOG>()
  const catalogRequested = gate<void>()
  const info = gate<LlmResolvedModelInfo>()
  const infoRequested = gate<void>()
  const saved = gate<void>()
  const saveRequested = gate<void>()
  const startup = gate<unknown>()
  const startupRequested = gate<AbortSignal>()
  const listModels = vi.fn(async () => {
    catalogRequested.release()
    return catalog.promise // listModels has no AbortSignal in the adopted API.
  })
  const resolveModelInfo = vi.fn(async (_provider: string, model: string, _signal?: AbortSignal) => {
    infoRequested.release()
    return { ...await info.promise, id: model }
  })
  const saveSelection = vi.fn(async (_selection: ModelSelection) => {
    saveRequested.release()
    if (delaySave) await saved.promise
  })
  ctx.provide('llm', {
    listProviders: () => [{ id: 'route', name: 'Route' }], listModels, resolveModelInfo,
  } as never)
  ctx.provide('agentDefaultModel', { saveSelection } as never)
  ctx.provide('tools', { get: () => undefined } as never)
  ctx.provide('commands', {
    list: () => [{ name: 'hold', description: 'Hold startup submission' }],
    execute: async (_agent: unknown, line: string, _attachments: unknown, signal: AbortSignal) => {
      if (line !== '/hold') return undefined
      startupRequested.release(signal)
      return startup.promise // Deliberately ignores abort: this keeps period 2 open.
    },
  } as never)
  // Record the real scope instance without replacing any ownership behavior.
  // Period 2 can then assert closed=false directly, not infer it from a fake flag.
  const scopeOwnership = vi.spyOn(SessionScope.prototype, 'own')
  const pushOverlay = vi.spyOn(ctx.tuiSlots, 'pushOverlay')
  const invalidate = vi.spyOn(ctx.tuiSlots, 'invalidate')
  const commits: string[] = []
  const draw = vi.fn()
  const refreshModelInfo = vi.fn()
  const stateWrites = vi.fn()
  let current: ModelSelection | undefined = { ...INITIAL }
  const selection = {
    get current() { return current },
    set current(next: ModelSelection | undefined) { stateWrites(next); current = next },
  } as ModelSelectionRef
  let dispatch: ((key: Key) => void) | undefined
  let exitHandler: (() => void) | undefined
  const exit = vi.fn()
  const requestExit = createWindowExitRequest(exit, () => exitHandler)
  const window = {
    ctx, terminal: { columns: () => COLUMNS, rows: () => ROWS }, exit, requestExit,
    startup: { cwd: '/ws', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined), peakHours: [], version: 'test', selection,
    modelInfo: { contextWindow: undefined, reasoning: INFO.reasoning },
    modelCompletionValues: () => Promise.resolve([]),
    prefs: { usageMode: 'cost', timing: false, cardDetail: 'compact', reasoningVisible: true, busyEnter: 'queue' },
    colorDepth: 0, palette: () => ({}), setPalette: () => {}, themeSettings: {},
    pendingTask: undefined, draw, paintNow: draw,
    commit: (lines: readonly string[]) => { commits.push(...lines.map(stripAnsi)) },
    clear: () => {}, refreshModelInfo,
    setDispatch: (handler?: (key: Key) => void) => { dispatch = handler },
    setExit: (handler?: () => void) => { exitHandler = handler },
  } as unknown as Window
  const disposals = vi.fn()
  let epochs = 0
  const press = (name: Extract<Key, { kind: 'key' }>['name']): void => {
    routeWindowKey({ kind: 'key', name }, requestExit, dispatch)
  }
  const type = (line: string): void => {
    for (const text of line) routeWindowKey({ kind: 'text', text }, requestExit, dispatch)
  }
  const submit = (line: string): void => { type(line); press('enter') }
  return {
    ctx, window, selection, stateWrites, listModels, resolveModelInfo, saveSelection,
    refreshModelInfo, pushOverlay, invalidate, commits, draw, exit, disposals,
    catalog, catalogRequested, info, infoRequested, saved, saveRequested, startup, startupRequested,
    press, type, submit,
    start: (holdStartup = false) => {
      epochs += 1
      window.pendingTask = holdStartup ? '/hold' : undefined
      const agent = {
        session: { id: `epoch-${String(epochs)}`, header: { cwd: '/ws' }, events: [] },
        status: 'idle', inbox: { nextStep: [], nextTurn: [] },
        followup: vi.fn(), steer: vi.fn(), cancel: vi.fn(),
      }
      return attachSession(window, {
        target: { kind: 'new', cwd: '/ws' },
        attached: { handle: { agent, dispose: async () => { disposals() } }, reopened: false },
      } as unknown as AttachOutcome)
    },
    scope: () => scopeOwnership.mock.contexts[0] as SessionScope,
    dispatchInstalled: () => dispatch !== undefined,
    frame: () => ctx.tuiSlots.compose(COLUMNS, ROWS).lines.map(stripAnsi),
    snapshot: () => ({
      opened: pushOverlay.mock.calls.length,
      selection: { ...selection.current }, writes: stateWrites.mock.calls.length,
      saves: saveSelection.mock.calls.length, refreshes: refreshModelInfo.mock.calls.length,
      commits: [...commits], draws: draw.mock.calls.length, invalidations: invalidate.mock.calls.length,
    }),
    stop: async () => {
      requestExit()
      catalog.release(CATALOG)
      info.release(INFO)
      saved.release()
      startup.release({ commandId: 'hold', result: { kind: 'success' } })
      await flush()
      // Registry disposers are legitimate local cleanup, not manufactured input
      // to an old picker. Also removes an orphan when the unfixed regression fails.
      for (const result of pushOverlay.mock.results) {
        if (result.type === 'return') result.value()
      }
      await flush()
      scopeOwnership.mockRestore()
    },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** Prove discovery happened, then let the real picker mount. */
async function openModel(f: Fixture): Promise<void> {
  f.submit('/model')
  await f.catalogRequested.promise
  expect(f.listModels).toHaveBeenCalledOnce()
  f.catalog.release(CATALOG)
  await flush()
  expect(f.pushOverlay).toHaveBeenCalledOnce()
  expect(f.frame().join('\n')).toContain('Select a model')
}

/** Choose the next model, leaving apply blocked BEFORE any shared-state write. */
async function chooseNext(f: Fixture): Promise<void> {
  await openModel(f)
  f.press('down')
  f.press('enter')
  await f.infoRequested.promise
  expect(f.ctx.tuiSlots.activeOverlay).toBeUndefined()
  expect(f.resolveModelInfo).toHaveBeenCalledOnce()
  expect(f.stateWrites).not.toHaveBeenCalled()
  expect(f.saveSelection).not.toHaveBeenCalled()
}

/** Actual requested-retirement / still-open-presentation interval, not handle disposal. */
async function retireWhileStartupPending(f: Fixture): Promise<void> {
  const signal = await f.startupRequested.promise
  expect(signal.aborted).toBe(false)
  f.submit('/new')
  await flush()
  expect(f.commits.join('\n')).toContain('starting a new session')
  expect(signal.aborted).toBe(true)
  expect(f.scope().closed).toBe(false)
  expect(f.dispatchInstalled()).toBe(true)
  expect(f.frame()).toHaveLength(5)
  expect(f.disposals).not.toHaveBeenCalled()
}

describe('attachment authority for window model selection', () => {
  it('keeps healthy model discovery, picker, apply, persistence, refresh, and acknowledgement', async () => {
    const f = await fixture()
    f.start()
    try {
      await chooseNext(f)
      f.info.release(INFO)
      await flush()
      expect(f.selection.current).toEqual({ ...INITIAL, model: 'next' })
      expect(f.stateWrites).toHaveBeenCalledOnce()
      expect(f.saveSelection).toHaveBeenCalledExactlyOnceWith(f.selection.current)
      expect(f.refreshModelInfo).toHaveBeenCalledOnce()
      expect(f.commits.join('\n')).toContain('model set to route / next')
      expect(f.frame()).toHaveLength(5)
    } finally { await f.stop() }
  })

  it.each(['escape', 'ctrl-c'] as const)('dismisses a healthy model picker with %s without changing selection or defaults', async key => {
    const f = await fixture()
    f.start()
    try {
      await openModel(f)
      f.press(key)
      await flush()
      expect(f.ctx.tuiSlots.activeOverlay).toBeUndefined()
      expect(f.selection.current).toEqual(INITIAL)
      expect(f.stateWrites).not.toHaveBeenCalled()
      expect(f.saveSelection).not.toHaveBeenCalled()
      expect(f.refreshModelInfo).not.toHaveBeenCalled()
      expect(f.frame()).toHaveLength(5)
    } finally { await f.stop() }
  })

  it('keeps healthy reasoning selection, persistence, and acknowledgement', async () => {
    const f = await fixture()
    f.start()
    try {
      f.submit('/reasoning')
      await flush()
      expect(f.pushOverlay).toHaveBeenCalledOnce()
      expect(f.frame().join('\n')).toContain('Select a reasoning level')
      f.press('down')
      f.press('enter')
      await flush()
      expect(f.selection.current).toEqual({ ...INITIAL, reasoningEffort: 'low' })
      expect(f.stateWrites).toHaveBeenCalledOnce()
      expect(f.saveSelection).toHaveBeenCalledExactlyOnceWith(f.selection.current)
      expect(f.commits.join('\n')).toContain('reasoning effort set to low')
    } finally { await f.stop() }
  })

  it.each(['escape', 'ctrl-c'] as const)('dismisses a healthy reasoning picker with %s without changing selection or defaults', async key => {
    const f = await fixture()
    f.start()
    try {
      f.submit('/reasoning')
      await flush()
      expect(f.pushOverlay).toHaveBeenCalledOnce()
      f.press(key)
      await flush()
      expect(f.ctx.tuiSlots.activeOverlay).toBeUndefined()
      expect(f.stateWrites).not.toHaveBeenCalled()
      expect(f.saveSelection).not.toHaveBeenCalled()
      expect(f.frame()).toHaveLength(5)
    } finally { await f.stop() }
  })

  it.each(['/new', '/clear', '/sessions', '/worktrees'])('does not dispatch %s through an open model picker', async command => {
    const f = await fixture()
    f.start()
    try {
      await openModel(f)
      f.submit(command) // These keys belong to the picker, not the composer.
      await f.infoRequested.promise
      expect(f.resolveModelInfo.mock.calls[0]?.[1]).toBe('old')
      expect(f.dispatchInstalled()).toBe(true)
      expect(f.disposals).not.toHaveBeenCalled()
      expect(f.commits.join('\n')).not.toContain('starting a new session')
    } finally { await f.stop() }
  })

  it('does not mount a picker when discovery resolves during requested retirement, before scope teardown', async () => {
    const f = await fixture()
    const epoch = f.start(true)
    try {
      await f.startupRequested.promise
      f.submit('/model')
      await f.catalogRequested.promise
      expect(f.listModels).toHaveBeenCalledOnce()
      await retireWhileStartupPending(f)
      const before = f.snapshot()
      f.catalog.release(CATALOG)
      await flush()
      expect(f.snapshot()).toEqual(before)
      expect(f.ctx.tuiSlots.activeOverlay).toBeUndefined()
      f.startup.release({ commandId: 'hold', result: { kind: 'success' } })
      await epoch
    } finally { await f.stop() }
  })

  it.each(['/model', '/model route/next'])('cannot let late discovery from A affect B through %s', async command => {
    const f = await fixture()
    const a = f.start()
    try {
      f.submit(command)
      await f.catalogRequested.promise
      expect(f.listModels).toHaveBeenCalledOnce()
      f.submit('/new')
      await a
      f.start()
      expect(f.dispatchInstalled()).toBe(true)
      const before = f.snapshot()
      f.catalog.release(CATALOG)
      f.info.release(INFO)
      await flush()
      expect(f.snapshot()).toEqual(before)
      expect(f.ctx.tuiSlots.activeOverlay).toBeUndefined()
    } finally { await f.stop() }
  })

  it.each(['resolves', 'rejects'] as const)('does not apply or persist a picked model when exact-info %s during period 2', async settlement => {
    const f = await fixture()
    const epoch = f.start(true)
    try {
      await f.startupRequested.promise
      await chooseNext(f)
      await retireWhileStartupPending(f)
      const before = f.snapshot()
      if (settlement === 'resolves') f.info.release(INFO) // Ignores cancellation.
      else f.info.fail(new Error('provider cancelled exact-model resolution'))
      await flush()
      expect(f.snapshot()).toEqual(before)
      f.startup.release({ commandId: 'hold', result: { kind: 'success' } })
      await epoch
    } finally { await f.stop() }
  })

  it('cannot apply or persist A\'s picked result after B becomes current', async () => {
    const f = await fixture()
    const a = f.start()
    try {
      await chooseNext(f)
      f.submit('/new') // Valid composer input: Enter already dismissed the picker.
      await a
      f.start()
      const before = f.snapshot()
      f.info.release(INFO)
      await flush()
      expect(f.snapshot()).toEqual(before)
    } finally { await f.stop() }
  })

  it.each(['/model', '/reasoning'])('does not apply a %s result when Enter and global quit share a key batch', async command => {
    const f = await fixture()
    f.start()
    try {
      if (command === '/model') await openModel(f)
      else {
        f.submit(command)
        await flush()
        expect(f.pushOverlay).toHaveBeenCalledOnce()
      }
      f.info.release(INFO)
      f.press('down')
      // terminal.ts delivers a decoded batch synchronously. Do not await between
      // these keys: global quit retires the epoch before the picker continuation.
      f.press('enter')
      f.press('ctrl-d')
      const before = f.snapshot()
      expect(f.exit).toHaveBeenCalledOnce()
      await flush()
      expect(f.snapshot()).toEqual(before)
      expect(f.selection.current).toEqual(INITIAL)
    } finally { await f.stop() }
  })

  it('fences reasoning apply in the requested-retirement/open-scope interval', async () => {
    const f = await fixture()
    const epoch = f.start(true)
    try {
      const signal = await f.startupRequested.promise
      f.submit('/reasoning')
      await flush()
      expect(f.pushOverlay).toHaveBeenCalledOnce()
      f.press('down')
      f.press('enter')
      f.submit('/new') // One decoded key batch, now through the real composer.
      expect(signal.aborted).toBe(true)
      expect(f.scope().closed).toBe(false)
      expect(f.dispatchInstalled()).toBe(true)
      expect(f.frame()).toHaveLength(5)
      expect(f.disposals).not.toHaveBeenCalled()
      const commitsBefore = [...f.commits]
      await flush()
      // Typing /new also queued completion redraws before retirement. Those are
      // not the reasoning gesture: observe its state/save/ack effects separately.
      expect(f.stateWrites).not.toHaveBeenCalled()
      expect(f.saveSelection).not.toHaveBeenCalled()
      expect(f.refreshModelInfo).not.toHaveBeenCalled()
      expect(f.commits).toEqual(commitsBefore)
      expect(f.selection.current).toEqual(INITIAL)
      f.startup.release({ commandId: 'hold', result: { kind: 'success' } })
      await epoch
    } finally { await f.stop() }
  })

  it.each(['/model', '/reasoning'])('withdraws the unconfirmed %s picker on window exit', async command => {
    const f = await fixture()
    f.start()
    try {
      if (command === '/model') await openModel(f)
      else { f.submit(command); await flush() }
      expect(f.ctx.tuiSlots.activeOverlay).toBeDefined()
      f.press('ctrl-d')
      const before = f.snapshot()
      await flush()
      expect(f.ctx.tuiSlots.activeOverlay).toBeUndefined()
      expect(f.snapshot()).toEqual(before)
      expect(f.stateWrites).not.toHaveBeenCalled()
      expect(f.saveSelection).not.toHaveBeenCalled()
    } finally { await f.stop() }
  })

  it('withdraws the ctrl-k editor with the epoch that opened it', async () => {
    // The editor is a CHILD of the model picker, so it inherits that gesture's
    // epoch rather than owning one. Withdrawing the parent removes only the
    // parent's own registration, so before this the child stayed mounted over
    // whatever replaced the attachment.
    const f = await fixture()
    f.start()
    try {
      await openModel(f)
      f.press('ctrl-k')
      await flush()
      // Two surfaces: the model picker, and the editor it opened over it.
      expect(f.snapshot().opened).toBe(2)
      expect(f.ctx.tuiSlots.activeOverlay).toBeDefined()
      f.press('ctrl-d')
      const before = f.snapshot()
      await flush()
      expect(f.ctx.tuiSlots.activeOverlay).toBeUndefined()
      expect(f.snapshot()).toEqual(before)
    } finally { await f.stop() }
  })

  it('keeps admitted reasoning state and default save but suppresses its late acknowledgement in B', async () => {
    const f = await fixture({ delaySave: true })
    const a = f.start()
    try {
      f.submit('/reasoning low')
      await f.saveRequested.promise
      expect(f.selection.current).toEqual({ ...INITIAL, reasoningEffort: 'low' })
      f.submit('/new')
      await a
      f.start()
      const before = f.snapshot()
      f.saved.release()
      await flush()
      expect(f.snapshot()).toEqual(before)
    } finally { await f.stop() }
  })

  it('preserves an already-admitted window model change while fencing late persistence acknowledgement', async () => {
    const f = await fixture({ delaySave: true })
    const a = f.start()
    try {
      await chooseNext(f)
      f.info.release(INFO)
      await f.saveRequested.promise
      expect(f.selection.current).toEqual({ ...INITIAL, model: 'next' })
      expect(f.saveSelection).toHaveBeenCalledOnce()
      // The accepted WINDOW change needs its metadata even if persistence waits
      // across retirement; suppressing the entire return path must not lose it.
      expect(f.refreshModelInfo).toHaveBeenCalledOnce()
      f.submit('/new')
      await a
      f.start()
      const before = f.snapshot()
      f.saved.release()
      await flush()
      expect(f.snapshot()).toEqual(before)
      expect(f.selection.current).toEqual({ ...INITIAL, model: 'next' })
    } finally { await f.stop() }
  })
})
