/**
 * Capability probe: Harness's `approval` seam, against the real service.
 *
 * `approval.spec.ts` proves dshline's answerer over a captured `ctx.on`, which
 * exercises the overlay logic but never the real `@deepseek-ai/dsh-user-approval`
 * waterfall the listener rides. This probe mounts the real `ApprovalService`
 * beside a real `SessionStore`, registers dshline's actual
 * `installApprovalAnswerer`, and asks through the service's own `request()` —
 * asserting exactly what production depends on:
 *
 * - the real waterfall hands dshline's answerer an owned request, and the
 *   answerer's overlay decision returns as the service's closed outcome, with
 *   the audit pair appended to the requesting session's durable log;
 * - a request for a different agent identity this frontend does NOT own falls
 *   through `next()`, reaching the service's fail-closed `unavailable` — never
 *   dshline answering for an agent outside its ownership;
 * - a withdrawn request settles `cancelled` through the real service.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { TuiSlots } from '../../src/slots.ts'
import type { TuiOverlay } from '../../src/slots.ts'
import { installApprovalAnswerer } from '../../src/approval.ts'

/** The agent this frontend owns in the probe. */
const OWNED = SessionId('probe-owned')

/** A distinct identity is all the ownership check requires. */
function agentOf(id: string, session?: Session): Agent {
  return session === undefined ? { id: SessionId(id) } as Agent : { id: SessionId(id), session } as Agent
}

/**
 * Mount the real approval service and dshline's real answerer.
 * @returns the pieces a case needs to ask and answer.
 */
async function mounted(): Promise<{
  ctx: Context
  session: Session
  presented: TuiOverlay[]
  ask: (agent: Agent, signal?: AbortSignal) => Promise<ApprovalOutcome>
}> {
  const ctx = new Context()
  await ctx.plugin(TuiSlots)
  await ctx.plugin(SessionStore)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  const session = ctx.sessions.create(OWNED)
  // The real service requires an open turn: the audit pair must sit inside
  // the durable log's commit/replay boundary.
  session.append('turn/start', { turn: 1 })
  // Ownership is object identity, exactly as in production: the window's
  // `owned()` returns the one live agent, so the probe holds one instance too.
  const owned = agentOf('probe-owned', session)
  installApprovalAnswerer(ctx, () => owned, () => {})
  // Capture what the answerer pushes onto the live region; TuiSlots has no
  // reader for mounted overlays, and the probe needs to answer the prompt.
  const presented: TuiOverlay[] = []
  const pushOverlay = ctx.tuiSlots.pushOverlay.bind(ctx.tuiSlots)
  ctx.tuiSlots.pushOverlay = overlay => {
    presented.push(overlay)
    return pushOverlay(overlay)
  }
  return {
    ctx,
    session,
    presented,
    ask: (agent, signal) => ctx.approval.request({
      agent: agent ?? owned, toolName: 'bash', ...signal === undefined ? {} : { signal },
    } satisfies ApprovalRequest),
  }
}

describe('capability: approval', () => {
  /** Let the real service's microtask-dispatched waterfall reach the answerer. */
  async function flush(): Promise<void> {
    await new Promise(resolve => setImmediate(resolve))
  }

  it('answers an owned request through the real waterfall and logs the audit pair', async () => {
    const { ctx, session, presented, ask } = await mounted()
    try {
      const pending = ask(undefined)
      await flush()
      expect(presented, 'the real service must reach the terminal answerer').toHaveLength(1)
      presented[0]?.handleKey({ kind: 'key', name: 'enter' })
      await expect(pending).resolves.toBe('allowed-once')
      // The service logged the ask and the decision onto the durable log.
      const logged = session.snapshotEvents().filter(event => event.type.startsWith('approval/'))
      expect(logged.map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('delegates a request for an agent it does not own, answering nothing', async () => {
    const { ctx, session, presented, ask } = await mounted()
    try {
      // A waterfall with no further answerer is fail-closed `unavailable` for
      // this different agent identity.
      await expect(ask(agentOf('probe-child', session))).resolves.toBe('unavailable')
      await flush()
      expect(presented).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('settles a withdrawn request as cancelled through the real service', async () => {
    const { ctx, presented, ask } = await mounted()
    try {
      const signal = new AbortController()
      const pending = ask(undefined, signal.signal)
      signal.abort()
      await expect(pending).resolves.toBe('cancelled')
      await flush()
      expect(presented).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
