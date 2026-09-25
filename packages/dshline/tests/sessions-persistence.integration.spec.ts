/**
 * Progressive title hydration against the real pinned JSONL persistence seam.
 *
 * The synthetic catalog tests prove the state machine. This test proves the
 * important boundary underneath it: `ctx.sessionQuery.listSessions()` reads
 * persisted headers and reaches the picker without waiting for the exact title
 * batch, and closing the catalog aborts that batch through Harness's signal.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, snapshotSessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionTitleObservationResult } from '@deepseek-ai/dsh-session-query'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionCatalog, TITLE_BATCH_SIZE } from '../src/sessions/catalog.ts'

/** Let real filesystem and service microtasks settle without a timing threshold. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** Query engine that counts exact title batches and lets the test hold one open. */
class GatedQuery extends SessionQueryEngine {
  readonly titleBatches: string[][] = []
  readonly titleSignals: AbortSignal[] = []
  private release!: () => void
  private markBatchStarted!: () => void
  private readonly gate: Promise<void>
  private readonly batchStarted: Promise<void>

  constructor(ctx: Context) {
    super(ctx)
    this.gate = new Promise<void>(resolve => { this.release = resolve })
    this.batchStarted = new Promise<void>(resolve => { this.markBatchStarted = resolve })
  }

  /** Wait until metadata has published and the first title batch has begun. */
  whenTitleBatchStarts(): Promise<void> {
    return this.batchStarted
  }

  /** Release the held title batch. */
  openTitles(): void {
    this.release()
  }

  override async readTitleSnapshots(
    sessionIds: readonly SessionId[],
    signal?: AbortSignal,
  ): Promise<SessionTitleObservationResult[]> {
    this.titleBatches.push([...sessionIds])
    this.markBatchStarted()
    if (signal !== undefined) this.titleSignals.push(signal)
    await this.gate
    return super.readTitleSnapshots(sessionIds, signal)
  }

  override async searchSessions(): Promise<never> {
    throw Object.assign(new Error('search disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
  }

  override async searchEvents(): Promise<never> {
    throw Object.assign(new Error('search disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
  }
}

/** Materialize a small real corpus with durable title events. */
async function seed(root: string, count: number): Promise<void> {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlPersistence, { root })
    for (let index = 0; index < count; index += 1) {
      const session = ctx.sessions.create(SessionId(`real-${String(index)}`), { meta: { cwd: root } })
      const message = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `benchmark prompt ${String(index)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const title = session.append('session/title', {
        title: `Real title ${String(index)}`,
        messageSeqs: [message.seq],
        source: { kind: 'fallback' },
      })
      const handle = await ctx.sessionPersistence.create(session.header, {
        inheritedEventCount: session.inheritedEventCount,
      })
      try {
        await handle.append([snapshotSessionEvent(message), snapshotSessionEvent(title)])
        await handle.flush()
      } finally {
        await handle.close()
      }
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('Sessions over real pinned JSONL persistence', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it('publishes metadata before exact title work and aborts it on close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshline-sessions-real-'))
    roots.push(root)
    await seed(root, TITLE_BATCH_SIZE + 5)

    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlPersistence, { root })
      await ctx.plugin(GatedQuery)
      const query = ctx.sessionQuery as GatedQuery
      const catalog = new SessionCatalog({ query, invalidate: () => {} })
      catalog.refresh()
      await query.whenTitleBatchStarts()
      await Promise.resolve()

      expect(catalog.listing()).toMatchObject({
        kind: 'ready',
        entries: expect.arrayContaining([
          expect.objectContaining({ title: undefined, titleState: { kind: 'pending' } }),
        ]),
      })
      expect(query.titleBatches).toHaveLength(1)
      expect(query.titleBatches[0]).toHaveLength(TITLE_BATCH_SIZE)

      catalog.dispose()
      expect(query.titleSignals[0]?.aborted).toBe(true)
      query.openTitles()
      await settled()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
