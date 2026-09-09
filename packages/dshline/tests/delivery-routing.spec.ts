/**
 * Where a submitted line actually lands in Harness's inbox.
 *
 * `delivery.spec.ts` proves the decision; this proves the decision reaches
 * Harness. The agent here is a double in one respect only — it does not run a
 * model — but its inbox is upstream's own published `createInboxStub()`, and
 * its `followup`/`steer` are the same two boundary appends the upstream Agent's
 * wrappers are. So the assertions are about which boundary list the message is
 * on, not about which local function was called: a routing change that called
 * the right verb into the wrong list would fail here and pass a spy.
 *
 * A stub rather than a constructed Inbox because the adopted generation owns
 * that storage in the driver — `Inbox` is a contract, and the testkit exists to
 * supply exactly this double. The durable half, over a production Agent, is
 * `capability/inbox.probe.spec.ts`.
 *
 * Assembled the way `replay-gate.spec.ts` is, for the same reason — the
 * submission path runs from a keystroke through the composer, the replay gate,
 * the command registry, and the skill adjudication, and only the assembled seam
 * covers that whole route.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context as RealContext } from '@deepseek-ai/cordis'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import type { BusyEnter } from '../src/delivery.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/** Text of one pending message, for readable assertions. */
const textOf = (message: UserMessage): string =>
  message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join('')

/**
 * The assembled attachment, with a real Inbox behind a non-running agent.
 * @param options - the starting preference.
 * @returns the keyboard dispatch, the live inbox, and the window it attached to.
 */
async function fixture(options: { busyEnter?: BusyEnter } = {}) {
  const ctx = new RealContext()
  await ctx.plugin(TuiSlots)
  ctx.provide('tools', { get: () => undefined })
  ctx.provide('commands', { execute: vi.fn(async () => undefined), list: () => [] } as never)
  ctx.provide('userQuestions', {} as never)
  // Settled immediately: the replay gate is `replay-gate.spec.ts`'s subject, and
  // here it must be open so a submission reaches the agent at all.
  ctx.provide('sessionQuery', {
    readSession: async (): Promise<{ events: SessionEvent[] }> => ({ events: [] }),
  } as never)

  const commits: string[][] = []
  let dispatch: ((key: Key) => void) | undefined
  const compose = (): void => { ctx.tuiSlots.compose(80, 24) }
  const window = {
    ctx,
    terminal: { columns: () => 80, rows: () => 24 },
    exit: undefined,
    startup: { cwd: '/ws', task: undefined, resume: undefined },
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
      busyEnter: options.busyEnter ?? 'queue',
    },
    colorDepth: 0,
    palette: () => ({}),
    setPalette: () => {},
    themeSettings: {},
    busyEnterSettings: { current: () => options.busyEnter ?? 'queue', watch: () => () => {}, save: async () => undefined },
    pendingTask: undefined,
    draw: compose,
    paintNow: compose,
    commit: lines => { commits.push([...lines]) },
    clear: () => {},
    refreshModelInfo: () => {},
    setDispatch: handler => { dispatch = handler },
    setExit: () => {},
  } as unknown as Window

  const inbox = createInboxStub()
  const agent = {
    session: { id: 's-1', header: { cwd: '/ws' }, events: [] },
    status: 'idle' as 'idle' | 'running',
    inbox,
    // The upstream wrappers, verbatim in effect: `followup` is a next-turn
    // append and `steer` is a next-step append, both through the Inbox contract.
    followup: vi.fn((message: UserMessage) => { inbox.append('next-turn', message) }),
    steer: vi.fn((message: UserMessage) => { inbox.append('next-step', message) }),
    cancel: vi.fn(() => { inbox.clear() }),
  }
  const outcome = {
    target: { kind: 'resume', id: SessionId('s-1') },
    attached: { handle: { agent, dispose: async () => {} }, reopened: true },
  } as unknown as AttachOutcome

  /**
   * Attach a session to this window, as the plugin's own loop does.
   * @returns when the transcript read has settled and the gate is open.
   */
  const attach = async (): Promise<void> => {
    void attachSession(window, outcome)
    // Let the transcript read settle so the replay gate opens.
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  await attach()

  /**
   * Type a line and submit it with one of the two gestures.
   * @param text - the line to type.
   * @param key - the submitting key.
   */
  const submit = async (text: string, key: 'enter' | 'ctrl-enter' = 'enter'): Promise<void> => {
    dispatch?.({ kind: 'text', text })
    dispatch?.({ kind: 'key', name: key })
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  /** Press ctrl-c, which is the interrupt gesture the composer leaves ignored. */
  const dispatchCancel = (): void => { dispatch?.({ kind: 'key', name: 'ctrl-c' }) }

  return { agent, inbox, window, submit, commits, dispatchCancel, attach }
}

describe('while the agent is idle', () => {
  it('follows up, whatever the preference', async () => {
    for (const busyEnter of ['queue', 'steer'] as const) {
      const f = await fixture({ busyEnter })
      await f.submit('what changed here')
      expect(f.inbox.nextTurn.map(textOf)).toStrictEqual(['what changed here'])
      expect(f.inbox.nextStep).toStrictEqual([])
      expect(f.agent.steer).not.toHaveBeenCalled()
    }
  })

  it('follows up on the accelerated gesture too, inventing no idle distinction', async () => {
    const f = await fixture({ busyEnter: 'queue' })
    await f.submit('what changed here', 'ctrl-enter')
    expect(f.inbox.nextTurn.map(textOf)).toStrictEqual(['what changed here'])
    expect(f.inbox.nextStep).toStrictEqual([])
  })
})

describe('while a turn is running', () => {
  it('queues plain enter onto next-turn under the queue preference', async () => {
    const f = await fixture({ busyEnter: 'queue' })
    f.agent.status = 'running'
    await f.submit('also update the docs')
    expect(f.inbox.nextTurn.map(textOf)).toStrictEqual(['also update the docs'])
    expect(f.inbox.nextStep).toStrictEqual([])
    expect(f.agent.followup).toHaveBeenCalledTimes(1)
    expect(f.agent.steer).not.toHaveBeenCalled()
  })

  it('steers plain enter onto next-step under the steer preference', async () => {
    const f = await fixture({ busyEnter: 'steer' })
    f.agent.status = 'running'
    await f.submit('stop using that file')
    expect(f.inbox.nextStep.map(textOf)).toStrictEqual(['stop using that file'])
    expect(f.inbox.nextTurn).toStrictEqual([])
    expect(f.agent.steer).toHaveBeenCalledTimes(1)
    expect(f.agent.followup).not.toHaveBeenCalled()
  })

  it('sends the accelerated gesture the other way, from either preference', async () => {
    const queued = await fixture({ busyEnter: 'queue' })
    queued.agent.status = 'running'
    await queued.submit('actually, stop', 'ctrl-enter')
    expect(queued.inbox.nextStep.map(textOf)).toStrictEqual(['actually, stop'])
    expect(queued.inbox.nextTurn).toStrictEqual([])

    const steered = await fixture({ busyEnter: 'steer' })
    steered.agent.status = 'running'
    await steered.submit('and afterwards, the docs', 'ctrl-enter')
    expect(steered.inbox.nextTurn.map(textOf)).toStrictEqual(['and afterwards, the docs'])
    expect(steered.inbox.nextStep).toStrictEqual([])
  })

  it('delivers each line exactly once, on either gesture', async () => {
    // The one failure a routing change could hide: choosing a verb and then
    // falling through to the other, or dispatching before the choice.
    const f = await fixture({ busyEnter: 'queue' })
    f.agent.status = 'running'
    await f.submit('first')
    await f.submit('second', 'ctrl-enter')
    expect(f.inbox.nextTurn.map(textOf)).toStrictEqual(['first'])
    expect(f.inbox.nextStep.map(textOf)).toStrictEqual(['second'])
    expect(f.agent.followup).toHaveBeenCalledTimes(1)
    expect(f.agent.steer).toHaveBeenCalledTimes(1)
  })

  it('marks the message as the reader\'s own, which is what the status counts', async () => {
    const f = await fixture({ busyEnter: 'queue' })
    f.agent.status = 'running'
    await f.submit('mine')
    expect(f.inbox.nextTurn[0]?.source).toStrictEqual({ kind: 'user' })
  })
})

describe('changing the preference', () => {
  it('takes effect on the very next submission', async () => {
    const f = await fixture({ busyEnter: 'queue' })
    f.agent.status = 'running'
    await f.submit('queued one')
    // Exactly what `/enter` does: move the window's pref and nothing else.
    f.window.prefs.busyEnter = 'steer'
    await f.submit('steered one')
    expect(f.inbox.nextTurn.map(textOf)).toStrictEqual(['queued one'])
    expect(f.inbox.nextStep.map(textOf)).toStrictEqual(['steered one'])
  })
})

describe('interrupting with pending work', () => {
  it('names what it discarded, rather than dropping it silently', async () => {
    // Harness's `cancel` clears both lists unless told to keep them, and this
    // interface deliberately does not tell it to: ctrl-c means stop, and queued
    // work would otherwise start running on its own. So the cost is named.
    const f = await fixture({ busyEnter: 'queue' })
    f.agent.status = 'running'
    await f.submit('one')
    await f.submit('two')
    expect(f.inbox.nextTurn).toHaveLength(2)

    f.commits.length = 0
    f.dispatchCancel()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(f.inbox.nextTurn).toStrictEqual([])
    const said = f.commits.flat().map(stripAnsi).join('\n')
    expect(said).toContain('2 pending prompts discarded')
    expect(said).toContain('press ↑ to bring one back')
  })

  it('says nothing about pending work when there was none', async () => {
    const f = await fixture()
    f.agent.status = 'running'
    f.commits.length = 0
    f.dispatchCancel()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.commits.flat().map(stripAnsi).join('\n')).not.toContain('discarded')
  })
})

describe('reopening a session in the same window', () => {
  it('keeps the preference, because the window owns it and the session does not', async () => {
    // Rule 14 in one assertion: a window is not a session. The preference is a
    // reader setting, so `/sessions` must not put it back any more than it puts
    // the palette or the usage meter back.
    const f = await fixture({ busyEnter: 'queue' })
    f.window.prefs.busyEnter = 'steer'

    // Re-attach, which is what reopening does: the previous attachment's views
    // and listeners come down and are rebuilt around the agent.
    await f.attach()

    f.agent.status = 'running'
    await f.submit('after reopening')
    expect(f.window.prefs.busyEnter).toBe('steer')
    expect(f.inbox.nextStep.map(textOf)).toStrictEqual(['after reopening'])
    expect(f.inbox.nextTurn).toStrictEqual([])
  })
})
