/**
 * Capability probe: `Agent.inbox`, the Agent-owned authority over pending work.
 *
 * Pending work belongs to the Agent in the adopted generation. `Inbox` is a
 * contract rather than a constructible class, its concrete storage is the
 * driver's, and `hasPending`/`claim` are no longer public — so a frontend can
 * only read `agent.inbox` and mutate it through the operations the contract
 * publishes. dshline holds no queue of its own and counts nothing it submitted;
 * `steering.ts` recomputes the status segment from this object on every paint.
 *
 * This probe drives PRODUCTION Agents from `@deepseek-ai/dsh-agent-loop-testkit`,
 * so the Inbox under test is the real driver implementation over a real durable
 * Session, and the routing assertions read the durable `agent/inbox/spliced`
 * record rather than a spy. What it does not claim: no LLM adapter is mounted,
 * so a woken turn reaches no provider and nothing here proves request or
 * settlement behavior.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, InboxTarget } from '@deepseek-ai/dsh-agent'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { pendingUserInput } from '../../src/steering.ts'

/** The workspace every probe Agent is created in. */
const CWD = '/ws'

/** One prompt the reader typed. */
const prompt = (text: string) => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/** One message a plugin assembled, which the status segment must not count. */
const injection = (text: string) => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: 'inbox-probe' },
})

/**
 * Mount the real AgentLoop and its prerequisites.
 * @returns the owning context and the harness that creates production Agents.
 */
async function mounted(): Promise<{ ctx: Context; harness: AgentLoopTestHarness }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  return { ctx, harness: await mountAgentLoopTestHarness(ctx) }
}

/** The durable boundary each inserting splice recorded, oldest first. */
function insertTargets(agent: Agent): InboxTarget[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0)
    .map(event => (event.data as { target: InboxTarget }).target)
}

describe('capability: agent.inbox', () => {
  it('routes followup to next-turn and steer to next-step, durably', async () => {
    const { ctx, harness } = await mounted()
    try {
      const agent = await harness.create(SessionId('inbox-probe-routing'), {}, { cwd: CWD })
      // The two verbs dshline's delivery decision resolves to. Asserted on the
      // durable splice record rather than the live lists, because a waking verb
      // opens a turn that claims its own message straight back off the list: the
      // log is what still says which boundary it went to.
      agent.followup(prompt('after this turn'))
      await agent.whenIdle()
      agent.steer(prompt('while you are in there'))
      await agent.whenIdle()

      expect(insertTargets(agent)).toEqual(['next-turn', 'next-step'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('parks non-waking input on the boundary it was addressed to', async () => {
    const { ctx, harness } = await mounted()
    try {
      const agent = await harness.create(SessionId('inbox-probe-parked'), {}, { cwd: CWD })
      // `send(..., wakeup: false)` is the documented non-waking delivery, so the
      // lists can be read while the driver stays idle.
      agent.send(prompt('queued'), 'next-turn', false)
      agent.send(prompt('steering'), 'next-step', false)
      agent.send(injection('assembled context'), 'next-step', false)

      expect(agent.inbox.nextTurn.map(m => m.content[0])).toEqual([{ type: 'text', text: 'queued' }])
      expect(agent.inbox.nextStep).toHaveLength(2)
      expect(agent.status).toBe('idle')
      // What the status line actually draws: user-sourced messages only, counted
      // per boundary from this exact object.
      expect(pendingUserInput(agent.inbox)).toEqual({ queued: 1, steering: 1 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drains next-step before one queued turn when the driver claims a boundary', async () => {
    const { ctx, harness } = await mounted()
    try {
      const agent = await harness.create(SessionId('inbox-probe-claim'), {}, { cwd: CWD })
      agent.send(prompt('first turn'), 'next-turn', false)
      agent.send(prompt('second turn'), 'next-turn', false)
      agent.send(prompt('steering'), 'next-step', false)

      // The driver's own claim, reached through the testkit rather than
      // reimplemented: next-step's whole batch, then one queued turn.
      const claimed = harness.claim(agent, 'next-turn', 1)
      expect(claimed).toHaveLength(2)
      expect(pendingUserInput(agent.inbox)).toEqual({ queued: 1, steering: 0 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears pending work on cancel, and keeps it when the caller asks to', async () => {
    const { ctx, harness } = await mounted()
    try {
      const agent = await harness.create(SessionId('inbox-probe-cancel'), {}, { cwd: CWD })
      agent.send(prompt('queued'), 'next-turn', false)
      agent.send(prompt('steering'), 'next-step', false)

      agent.cancel({ kind: 'user' }, { keepInbox: true })
      expect(pendingUserInput(agent.inbox)).toEqual({ queued: 1, steering: 1 })

      // dshline's ctrl-c takes the default, which is why the interrupt notice can
      // truthfully say what it discarded.
      agent.cancel({ kind: 'user' })
      expect(pendingUserInput(agent.inbox)).toEqual({ queued: 0, steering: 0 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the pending work of two live Agents completely apart', async () => {
    const { ctx, harness } = await mounted()
    try {
      // The property a window switching sessions depends on: one attachment's
      // pending work must never be visible through another's Agent, and the
      // status line reads whichever Agent is attached.
      const first = await harness.create(SessionId('inbox-probe-first'), {}, { cwd: CWD })
      const second = await harness.create(SessionId('inbox-probe-second'), {}, { cwd: CWD })

      first.send(prompt('for the first session'), 'next-turn', false)
      second.send(prompt('for the second'), 'next-step', false)
      second.send(prompt('and another'), 'next-step', false)

      expect(pendingUserInput(first.inbox)).toEqual({ queued: 1, steering: 0 })
      expect(pendingUserInput(second.inbox)).toEqual({ queued: 0, steering: 2 })

      first.cancel({ kind: 'user' })
      expect(pendingUserInput(first.inbox)).toEqual({ queued: 0, steering: 0 })
      expect(pendingUserInput(second.inbox)).toEqual({ queued: 0, steering: 2 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
