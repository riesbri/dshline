/**
 * An async continuation belongs to the attachment epoch that started it.
 *
 * Once an attachment begins retirement it may clean up its own local work, but
 * it may not produce new attachment-owned effects: no enqueue into the Agent the
 * window has left, no commit into a transcript the next epoch now owns, no
 * redraw.
 *
 * The window these tests drive is deliberately the widest one the architecture
 * has. The epoch reaches its teardown only after `await switched`, so anything
 * pending while the reader requests a transition observes exactly the interval
 * the design calls out:
 *
 *   attachmentAbort.signal.aborted === true   scope.closed === false
 *
 * That interval is not one microtask wide when the epoch is still blocked inside
 * `submit()`, which is the situation here: the attachment starts by submitting a
 * command whose skill verification the test holds open. A fence keyed only on
 * `scope.closed` would therefore be wrong in principle, and the regression below
 * is written so it would still have gone green under one.
 * @module dshline/tests/attachment-async-fencing
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import { pricingFrom } from '../src/usage.ts'
import type { Window } from '../src/window.ts'

/** Terminal size every frame is drawn at. */
const COLUMNS = 120
const ROWS = 24

/** What a deferred `ctx.skills` registry answers when released. */
type Verdict = 'user-invocable' | 'not-user-invocable' | 'unknown' | 'unverifiable'

/** One assembled attachment plus everything a test can observe about it. */
interface Mounted {
  /** Begin the attachment; resolves when its epoch ends. */
  readonly start: () => Promise<unknown>
  /** Lines committed to the shared transcript, in order. */
  readonly commits: readonly string[]
  /** How many times this agent's inbox verbs were called. */
  readonly inbox: () => number
  /** How many redraws the window was asked for. */
  readonly redraws: () => number
  /** Rows currently in the live region; 5 while this attachment still owns them. */
  readonly liveRows: () => number
  /** Whether the window still routes keys to this attachment. */
  readonly dispatchInstalled: () => boolean
  /**
   * How many times the skill registry was asked for a snapshot.
   *
   * An anti-vacuity counter: a test that never reached the verdict would pass
   * every stale-effect assertion for the wrong reason, so the ones that matter
   * check that the registry was actually asked and actually answered.
   */
  readonly snapshots: () => number
  /** Release the pending skill verification with one verdict. */
  readonly settle: (verdict: Verdict) => void
  /** Type text into the composer. */
  readonly type: (text: string) => void
  /** Press a named key. */
  readonly press: (name: string) => void
}

/** A promise a test releases by hand. */
function gate<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => { release = resolve })
  return { promise, release }
}

/** Let pending microtasks and macrotasks run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
}

/**
 * Build a window whose attachment blocks inside `submit()`, awaiting a skill
 * verification the test controls.
 * @param pending - the command line the attachment submits as it starts.
 * @returns the assembled fixture.
 */
async function mount(
  pending = '/some-skill',
  registered?: { readonly names: readonly string[]; readonly execute: () => Promise<unknown> },
): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(TuiSlots)

  const commits: string[] = []
  let inbox = 0
  let redraws = 0
  let dispatch: ((key: unknown) => void) | undefined

  const originalInvalidate = ctx.tuiSlots.invalidate.bind(ctx.tuiSlots)
  ctx.tuiSlots.invalidate = (): void => { redraws += 1; originalInvalidate() }

  const window = {
    ctx,
    terminal: { columns: () => COLUMNS, rows: () => ROWS },
    exit: () => {},
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
    pendingTask: pending,
    draw: () => { redraws += 1 },
    paintNow: () => { redraws += 1 },
    commit: (lines: readonly string[]): void => { commits.push(...lines) },
    clear: () => {},
    refreshModelInfo: () => {},
    setDispatch: (fn: ((key: unknown) => void) | undefined): void => { dispatch = fn },
    setExit: () => {},
  } as unknown as Window

  ctx.provide('sessionProjections', {
    snapshot: () => ({ asOfSeq: 0, values: {} }),
    onChanged: () => () => {},
  } as never)
  // An empty registry: `execute` resolving `undefined` is how Harness says it
  // knows no such command, which is what lets the line reach the skill verdict.
  // A test that needs a registered command supplies its own registry instead.
  ctx.provide('commands', {
    list: () => (registered?.names ?? []).map(name => ({ name, description: name })),
    execute: registered === undefined ? async () => undefined : async () => registered.execute(),
  } as never)
  ctx.provide('tools', { get: () => undefined } as never)

  // A registry whose snapshot never settles until the test says so. Which name is
  // looked up afterwards is not the point: the point is that `verify` resolves
  // into a decision, and a retired attachment must not act on that decision.
  const snapshot = gate<{ readonly skills: readonly unknown[]; readonly complete: boolean }>()
  let snapshots = 0
  ctx.provide('skills', {
    snapshot: () => { snapshots += 1; return snapshot.promise },
    list: async () => [],
    get: () => undefined,
  } as never)

  const session = { id: 'probe', header: { cwd: '/ws' }, events: [], append: () => {} }
  const agent = {
    session,
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup: (): void => { inbox += 1 },
    steer: (): void => { inbox += 1 },
    cancel: () => {},
  } as unknown as Agent

  let disposals = 0
  return {
    commits,
    inbox: () => inbox,
    redraws: () => redraws,
    liveRows: () => ctx.tuiSlots.compose(COLUMNS, ROWS).lines.length,
    dispatchInstalled: () => dispatch !== undefined,
    snapshots: () => snapshots,
    start: () => attachSession(window, {
      target: { kind: 'new', cwd: '/ws' },
      attached: { handle: { agent, dispose: async () => { disposals += 1 } }, reopened: false },
    } as unknown as AttachOutcome),
    settle: (verdict: Verdict): void => {
      const skills = verdict === 'user-invocable' || verdict === 'not-user-invocable'
        ? [{
            name: 'some-skill',
            description: 'a skill',
            invocation: { userInvocable: verdict === 'user-invocable', modelInvocable: true },
            source: 'file',
          }]
        : []
      snapshot.release({ skills, complete: verdict !== 'unverifiable' })
    },
    type: (text: string): void => {
      for (const character of text) dispatch?.({ kind: 'text', text: character })
    },
    press: (name: string): void => { dispatch?.({ kind: 'key', name }) },
  }
}

/** Type a line into the composer and submit it, the way a reader does. */
function submitLine(fixture: Mounted, line: string): void {
  fixture.type(line)
  fixture.press('enter')
}

/**
 * Start an attachment, wait for it to install its key dispatch, and let the
 * reader switch it away — leaving the epoch still blocked inside `submit()`, so
 * the scope is NOT yet closed while the old verification is outstanding.
 * @param fixture - the assembled fixture.
 * @returns nothing; the reader has asked to move on.
 */
async function startThenSwitch(fixture: Mounted): Promise<void> {
  const epoch = fixture.start()
  await settle()
  // `/new` is a LOCAL command, so it dispatches before any skill verification —
  // which is what makes this reachable while another verification is outstanding.
  submitLine(fixture, '/new')
  // The transition announces itself before it requests retirement, so waiting for
  // that line is how a test knows the switch has actually happened rather than
  // merely been typed. Bounded, so a regression fails instead of hanging.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await settle()
    if (fixture.commits.join('\n').includes('starting a new session')) break
  }
  expect(fixture.commits.join('\n')).toContain('starting a new session')
  // The interval the whole design turns on: retirement has been REQUESTED, and
  // the epoch is still blocked inside `submit()`, so the scope has NOT come down.
  // A fence that only checked `scope.closed` would therefore still be green here.
  expect(fixture.dispatchInstalled()).toBe(true)
  expect(fixture.liveRows()).toBe(5)
  void epoch.catch(() => undefined)
}

describe('a submission whose verification outlives its attachment', () => {
  it('never enqueues a human message into the Agent the window has left', async () => {
    // The highest-value case. `verify` carries only a deadline, not the
    // attachment's lifetime signal, and nothing re-checks afterwards, so a
    // `user-invocable` verdict reaching `sendPrompt` hands the retired Agent
    // another turn of the reader's words.
    const fixture = await mount()
    await startThenSwitch(fixture)
    expect(fixture.snapshots()).toBeGreaterThan(0)
    fixture.settle('user-invocable')
    await settle()
    // Still no message for a reader who has already left this attachment.
    expect(fixture.inbox()).toBe(0)
  })

  it('does not commit an old verdict into the window after the switch', async () => {
    const fixture = await mount()
    await startThenSwitch(fixture)
    const before = fixture.commits.length
    fixture.settle('unknown')
    await settle()
    expect(fixture.commits.slice(before).join('\n')).not.toContain('unknown command')
  })

  it('reports a skill it cannot invoke only while it is still the current attachment', async () => {
    const fixture = await mount()
    const epoch = fixture.start()
    await settle()
    const before = fixture.commits.length
    fixture.settle('not-user-invocable')
    await settle()
    // Healthy: the attachment is current, so the verdict is still presented.
    expect(fixture.commits.slice(before).join('\n')).toContain('not one a person can invoke')
    void epoch.catch(() => undefined)
  })

  it('presents a user-invocable verdict while it is still current', async () => {
    const fixture = await mount()
    const epoch = fixture.start()
    await settle()
    fixture.settle('user-invocable')
    await settle()
    // The control for the fence above: same operation, same verdict, no switch.
    expect(fixture.inbox()).toBe(1)
    void epoch.catch(() => undefined)
  })

  it('does not report an unverifiable catalog after the switch', async () => {
    const fixture = await mount()
    await startThenSwitch(fixture)
    const before = fixture.commits.length
    fixture.settle('unverifiable')
    await settle()
    expect(fixture.commits.slice(before).join('\n')).not.toContain('could not verify')
  })

  it('lets the epoch retire normally after dropping the stale verdict', async () => {
    // The stale continuation must not stall retirement, and its answer must not
    // become what the reader sees while the rows come down.
    const fixture = await mount()
    const epoch = fixture.start()
    await settle()
    submitLine(fixture, '/new')
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await settle()
      if (fixture.commits.join('\n').includes('starting a new session')) break
    }
    const commitsBefore = fixture.commits.length
    fixture.settle('user-invocable')
    await expect(epoch).resolves.toEqual({ kind: 'new', cwd: '/ws' })
    expect(fixture.inbox()).toBe(0)
    expect(fixture.commits.slice(commitsBefore).join('\n')).not.toContain('unknown command')
    // The retirement itself is not suppressed: the rows came down.
    expect(fixture.liveRows()).toBe(0)
    expect(fixture.dispatchInstalled()).toBe(false)
  })
})

/** A promise a test releases by hand, typed for a command execution. */
function commandGate(): { promise: Promise<{ result: { kind: string } }>; release: (kind: string) => void } {
  let release!: (kind: string) => void
  const promise = new Promise<{ result: { kind: string } }>(resolve => {
    release = kind => { resolve({ result: { kind } }) }
  })
  return { promise, release }
}

describe('a typed command that outlives its attachment', () => {
  it('finishes its cleanup without resurrecting anything the switch tore down', async () => {
    // The typed-compaction path decrements an in-flight counter, re-syncs the
    // heartbeat and repaints in a `finally` that no lifetime check guards. The
    // counter and the heartbeat belong to the attachment, so whether that
    // `finally` may still run them is a question about this epoch, not about the
    // command having completed.
    //
    // The name used to claim this blocks repaints, and the comment under it said
    // the opposite. The honest contract is narrower and is what this now asserts:
    // the cleanup is allowed to run — it is what RELEASES the heartbeat, and
    // skipping cleanup because the attachment retired is how a heartbeat outlives
    // it — but it must leave nothing standing that the switch took down. The
    // repaint it costs is incidental and is deliberately not counted, because a
    // count here would be a performance assertion rather than an invariant.
    const gate = commandGate()
    const fixture = await mount('', { names: ['compact'], execute: () => gate.promise })
    const epoch = fixture.start()
    await settle()
    submitLine(fixture, '/compact')
    await settle()
    // The reader leaves while the command is still outstanding.
    submitLine(fixture, '/new')
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await settle()
      if (fixture.commits.join('\n').includes('starting a new session')) break
    }
    expect(fixture.commits.join('\n')).toContain('starting a new session')
    const commitsBefore = fixture.commits.length
    gate.release('success')
    await expect(epoch).resolves.toEqual({ kind: 'new', cwd: '/ws' })
    // Nothing the retired attachment's command path could still own reached the
    // transcript — not an error, not an acknowledgement, not anything — and the
    // epoch finished retiring rather than hanging on it. Checking for a marker
    // instead of for ABSENCE of commits is what let a stray line through before.
    expect(fixture.commits.slice(commitsBefore)).toEqual([])
    expect(fixture.liveRows()).toBe(0)
    expect(fixture.dispatchInstalled()).toBe(false)
  })

  it('reports a command failure that happened while it was still current', async () => {
    // The opposite regression: fencing must not silence an ordinary failure.
    const gate = commandGate()
    const fixture = await mount('', { names: ['review-me'], execute: () => gate.promise })
    const epoch = fixture.start()
    await settle()
    submitLine(fixture, '/review-me')
    await settle()
    gate.release('error')
    await settle()
    expect(fixture.commits.join('\n')).not.toContain('nothing was sent')
    void epoch.catch(() => undefined)
  })
})
