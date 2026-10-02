/**
 * An attachment that fails to establish must leave nothing behind.
 *
 * `attachSession()` acquires attachment-scoped resources across its whole
 * initialization and reaches its teardown only after `await switched` — which
 * resolves when the READER asks to leave. Anything that throws before that point
 * therefore never reaches the ordinary `scope.dispose()`, and the Agent handle,
 * which `attachTarget()` handed over and cannot reach again, is never disposed
 * either.
 *
 * The boundary these tests drive is `clear()` on a `/clear` target: it runs after
 * the keyboard handler is installed, so a failure there is both realistic (a
 * terminal write can fail) and the deepest point initialization can be made to
 * fail at without contrivance.
 * @module dshline/tests/attachment-init-failure
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import { pricingFrom } from '../src/usage.ts'
import type { Window } from '../src/window.ts'

/** Terminal size every frame below is drawn at. */
const COLUMNS = 120
const ROWS = 24

/** How a test makes this attachment fail while it is still establishing. */
type Failure = 'none' | 'clear'

/**
 * What the attachment should do once it is established.
 *
 * `stay` leaves it running, which is the state every leak assertion needs.
 * `switch` submits `/new`, the ordinary reader gesture for leaving a session for
 * another one, so the epoch reaches its own teardown through `switched`.
 */
type Fate = 'stay' | 'switch'

/** One assembled attachment, and everything a test can observe about it. */
interface Mounted {
  /** The window this attachment is driving. */
  readonly window: Window
  /** The context its listeners were registered on. */
  readonly ctx: Context
  /** The ordered trace of lifecycle events, for asserting sequence. */
  readonly trace: readonly string[]
  /** Whether the window currently has an exit hook installed. */
  readonly exitHook: () => boolean
  /** The window's key dispatch, or undefined when none is installed. */
  readonly dispatch: () => ((key: unknown) => void) | undefined
  /** How many times the Agent handle has been disposed. */
  readonly agentDisposals: () => number
  /** Rows currently in the bounded live region. */
  readonly liveRows: () => number
  /** Emit an activation change for one session and report whether it repainted. */
  readonly repaintsOnActivation: (sessionId: string) => Promise<boolean>
  /** Drive the installed key handler, if any. */
  readonly press: (key: unknown) => void
  /**
   * Run the exit hook the window owns, the way a `ctrl-d` reaches it.
   *
   * `ctrl-d` is read by the WINDOW before it delegates, so it never arrives on the
   * attachment's key dispatch. Driving the hook is therefore the faithful model
   * of what the reader's keystroke actually does.
   * @returns whether a hook was installed to run.
   */
  readonly exit: () => boolean
}

/**
 * Build the smallest window/agent/context triple an attachment accepts.
 * @param failure - where, if anywhere, initialization should fail.
 * @param sessionId - the id this attachment's session reports.
 * @param fate - what the attachment does once established.
 * @returns the assembled fixture.
 */
async function mount(failure: Failure = 'none', sessionId = 'probe', fate: Fate = 'stay'): Promise<Mounted> {
  const trace: string[] = []
  const ctx = new Context()
  await ctx.plugin(TuiSlots)
  let invalidations = 0
  let exitHook: unknown
  let dispatchHook: ((key: unknown) => void) | undefined
  let disposals = 0

  const window = {
    ctx,
    terminal: { columns: () => COLUMNS, rows: () => ROWS },
    exit: (code: number) => { trace.push(`window exit(${String(code)})`) },
    startup: { cwd: '/ws', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: undefined },
    modelInfo: { contextWindow: 1_000_000, reasoning: undefined },
    modelCompletionValues: () => Promise.resolve([]),
    prefs: { usageMode: 'cost', timing: false, cardDetail: 'compact', reasoningVisible: true },
    colorDepth: 0,
    palette: () => ({}),
    setPalette: () => {},
    themeSettings: {},
    pendingTask: fate === 'switch' ? '/new' : undefined,
    draw: () => {},
    paintNow: () => {},
    commit: () => {},
    clear: () => {
      if (failure === 'clear') throw new Error('terminal clear failed')
    },
    refreshModelInfo: () => {},
    // The scope clears BOTH of these by installing `undefined`, so the trace
    // records the exact moment attachment-owned resources come down.
    setDispatch: (fn: ((key: unknown) => void) | undefined): void => {
      dispatchHook = fn
      trace.push(fn === undefined ? 'key dispatch cleared' : 'key dispatch installed')
    },
    setExit: (fn: unknown): void => {
      exitHook = fn
      trace.push(fn === undefined ? 'exit hook cleared' : 'exit hook installed')
    },
  } as unknown as Window

  const realInvalidate = ctx.tuiSlots.invalidate.bind(ctx.tuiSlots)
  ctx.tuiSlots.invalidate = (): void => { invalidations += 1; realInvalidate() }
  ctx.provide('sessionProjections', {
    snapshot: () => ({ asOfSeq: 0, values: {} }),
    onChanged: () => () => {},
  } as never)
  ctx.provide('commands', { list: () => [], execute: async () => ({ kind: 'success' }) } as never)
  ctx.provide('tools', { get: () => undefined } as never)

  const session = { id: sessionId, header: { cwd: '/ws' }, events: [], append: () => {} }
  const agent = {
    session,
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup: () => {},
    steer: () => {},
    cancel: () => { trace.push('agent cancel') },
  } as unknown as Agent

  return {
    window,
    ctx,
    trace,
    exitHook: () => exitHook !== undefined,
    dispatch: () => dispatchHook,
    agentDisposals: () => disposals,
    liveRows: () => ctx.tuiSlots.compose(COLUMNS, ROWS).lines.length,
    repaintsOnActivation: async (id: string): Promise<boolean> => {
      const before = invalidations
      ctx.emit('goal/activation-changed', { sessionId: id } as never)
      await new Promise<void>(resolve => { setImmediate(resolve) })
      return invalidations > before
    },
    press: (key: unknown): void => { dispatchHook?.(key) },
    exit: (): boolean => {
      if (typeof exitHook !== 'function') return false
      ;(exitHook as () => void)()
      return true
    },
    // Captured by the outcome below so disposal stays observable.
    ...({ handle: { agent, dispose: async () => { disposals += 1; trace.push('agent disposed') } } }),
  } as Mounted & { handle: unknown }
}

/**
 * The Agent handle a `mount()` produced, ready to hand to `attachSession`.
 * @param fixture - the assembled fixture.
 * @param target - the attach target; `clearDisplay` is what reaches `clear()`.
 * @returns an outcome the attachment will accept.
 */
function outcome(fixture: Mounted, target: AttachOutcome['target']): AttachOutcome {
  const handle = (fixture as unknown as { handle: { agent: unknown; dispose: () => Promise<void> } }).handle
  return { target, attached: { handle: handle as never, reopened: false } } as AttachOutcome
}

describe('an attachment that fails while establishing', () => {
  it('disposes everything it acquired, and the Agent, before rejecting', async () => {
    // Deliberate break: without the failure path the whole scope survives, the
    // handle is never disposed, and the reader is left facing a session epoch
    // that no longer exists.
    const fixture = await mount('clear')
    const thrown = await attachSession(fixture.window, outcome(fixture, { kind: 'new', cwd: '/ws', clearDisplay: true }))
      .then(() => undefined, (error: Error) => error)
    expect(thrown?.message).toBe('terminal clear failed')

    // Every attachment-owned resource is gone...
    expect(fixture.exitHook()).toBe(false)
    expect(fixture.dispatch()).toBeUndefined()
    expect(fixture.liveRows()).toBe(0)
    // ...and the handle `attachTarget()` handed over is disposed with it.
    expect(fixture.agentDisposals()).toBe(1)
  })

  it('tears attachment resources down before the Agent handle', async () => {
    // The order is the whole point: a log listener still subscribed while its own
    // agent is torn down would project that teardown into the transcript.
    const fixture = await mount('clear')
    await attachSession(fixture.window, outcome(fixture, { kind: 'new', cwd: '/ws', clearDisplay: true }))
      .then(() => undefined, () => undefined)
    const cleared = fixture.trace.indexOf('key dispatch cleared')
    const disposed = fixture.trace.indexOf('agent disposed')
    expect(cleared).toBeGreaterThanOrEqual(0)
    expect(disposed).toBeGreaterThan(cleared)
  })

  it('leaves nothing that can still repaint the terminal', async () => {
    const fixture = await mount('clear')
    await attachSession(fixture.window, outcome(fixture, { kind: 'new', cwd: '/ws', clearDisplay: true }))
      .then(() => undefined, () => undefined)
    await expect(fixture.repaintsOnActivation('probe')).resolves.toBe(false)
  })

  it('does not stack the rows of a dead attachment under the next healthy one', async () => {
    // The compounding failure: one dead epoch's five live rows stay painted and
    // the next attachment adds its own five on top.
    const failed = await mount('clear')
    await attachSession(failed.window, outcome(failed, { kind: 'new', cwd: '/ws', clearDisplay: true }))
      .then(() => undefined, () => undefined)
    expect(failed.liveRows()).toBe(0)

    const healthy = await mount('none', 'probe-B')
    void attachSession(healthy.window, outcome(healthy, { kind: 'new', cwd: '/ws' })).catch(() => undefined)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    // A healthy attachment alone owns the five rows it registered.
    expect(healthy.liveRows()).toBe(5)
    expect(healthy.agentDisposals()).toBe(0)
    await expect(healthy.repaintsOnActivation('probe-B')).resolves.toBe(true)
  })

  it('cleans up exactly once', async () => {
    const fixture = await mount('clear')
    await attachSession(fixture.window, outcome(fixture, { kind: 'new', cwd: '/ws', clearDisplay: true }))
      .then(() => undefined, () => undefined)
    expect(fixture.trace.filter(entry => entry === 'key dispatch cleared')).toHaveLength(1)
    expect(fixture.agentDisposals()).toBe(1)
  })

  it('does not dispose the handle twice when the epoch fails after releasing it', async () => {
    // The switch path tears the scope down, releases the handle, and only then
    // takes its own closing row down. A failure in that last step escapes an epoch
    // that has ALREADY released everything, so a caller cleanup that cannot tell
    // the difference would release the same handle a second time.
    const fixture = await mount('none', 'probe', 'switch')
    const real = fixture.ctx.tuiSlots.register.bind(fixture.ctx.tuiSlots)
    let registrations = 0
    fixture.ctx.tuiSlots.register = ((...args: Parameters<typeof real>) => {
      registrations += 1
      // The five attachment rows are calls 1-5; the epoch's closing row is the
      // sixth, and its removal is the last thing the epoch does.
      if (registrations > 5) return () => { throw new Error('closing row removal failed') }
      return real(...args)
    }) as typeof real

    const thrown = await attachSession(fixture.window, outcome(fixture, { kind: 'new', cwd: '/ws' }))
      .then(() => undefined, (error: Error) => error)
    expect(thrown?.message).toBe('closing row removal failed')
    // The epoch released it once; the failed attempt must not release it again.
    expect(fixture.agentDisposals()).toBe(1)
    expect(fixture.trace.filter(entry => entry === 'key dispatch cleared')).toHaveLength(1)
  })

  it('still releases a handle the epoch never reached, after its scope came down', async () => {
    // The mirror image, and the reason the handle needs its OWN release rather
    // than inheriting the scope's: this failure lands between the epoch's scope
    // teardown and its handle teardown. A boundary keyed on the scope would read
    // "already released" here and leak the agent.
    const fixture = await mount('none', 'probe', 'switch')
    const real = fixture.ctx.tuiSlots.register.bind(fixture.ctx.tuiSlots)
    let registrations = 0
    fixture.ctx.tuiSlots.register = ((...args: Parameters<typeof real>) => {
      registrations += 1
      if (registrations > 5) throw new Error('closing row could not be registered')
      return real(...args)
    }) as typeof real

    const thrown = await attachSession(fixture.window, outcome(fixture, { kind: 'new', cwd: '/ws' }))
      .then(() => undefined, (error: Error) => error)
    expect(thrown?.message).toBe('closing row could not be registered')
    expect(fixture.agentDisposals()).toBe(1)
    expect(fixture.liveRows()).toBe(0)
  })

  it('keeps the initialization failure when cleanup fails too', async () => {
    // A disposer that throws must not replace the reason the attachment never
    // established, and must not hide that cleanup itself went wrong.
    const fixture = await mount('clear')
    const original = fixture.ctx.tuiSlots.register.bind(fixture.ctx.tuiSlots)
    fixture.ctx.tuiSlots.register = ((...args: Parameters<typeof original>) => {
      const dispose = original(...args)
      let called = false
      return () => { if (!called) { called = true; throw new Error('slot teardown failed') } ; dispose() }
    }) as typeof original
    const thrown = await attachSession(fixture.window, outcome(fixture, { kind: 'new', cwd: '/ws', clearDisplay: true }))
      .then(() => undefined, (error: unknown) => error)
    // Neither failure is lost, and the reason the attachment never established is
    // not buried under the one that happened while cleaning it up.
    expect(thrown).toBeInstanceOf(AggregateError)
    const errors = (thrown as AggregateError).errors
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe('terminal clear failed')
    expect(errors.map(error => (error as Error).message)).toContain('slot teardown failed')
  })

  it('reports the initialization failure alone when cleanup succeeds', async () => {
    const fixture = await mount('clear')
    const thrown = await attachSession(fixture.window, outcome(fixture, { kind: 'new', cwd: '/ws', clearDisplay: true }))
      .then(() => undefined, (error: Error) => error)
    expect(thrown?.message).toBe('terminal clear failed')
  })
})

describe('an attachment that establishes', () => {
  it('keeps owning its resources for the whole epoch', async () => {
    // The other half of the contract: a successful attachment must NOT have been
    // cleaned up by the failure path, or it could never be switched away from.
    const fixture = await mount('none')
    void attachSession(fixture.window, outcome(fixture, { kind: 'new', cwd: '/ws' })).catch(() => undefined)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(fixture.exitHook()).toBe(true)
    expect(fixture.dispatch()).toBeDefined()
    expect(fixture.liveRows()).toBe(5)
    expect(fixture.agentDisposals()).toBe(0)
    await expect(fixture.repaintsOnActivation('probe')).resolves.toBe(true)
    // The window owns quit and routes it to the attachment's exit handler.
    expect(fixture.exit()).toBe(true)
    expect(fixture.trace).toContain('agent cancel')
  })

  it('tears the epoch down and disposes the handle in that order on a switch', async () => {
    // `/new` is the ordinary gesture for leaving one session for another, and it
    // is the path that must dispose the handle after the presentation is gone.
    const fixture = await mount('none', 'probe', 'switch')
    const settled = attachSession(fixture.window, outcome(fixture, { kind: 'new', cwd: '/ws' }))
    await expect(settled).resolves.toEqual({ kind: 'new', cwd: '/ws' })
    const cleared = fixture.trace.indexOf('key dispatch cleared')
    const disposed = fixture.trace.indexOf('agent disposed')
    expect(cleared).toBeGreaterThanOrEqual(0)
    expect(disposed).toBeGreaterThan(cleared)
    expect(fixture.agentDisposals()).toBe(1)
    expect(fixture.liveRows()).toBe(0)
  })
})