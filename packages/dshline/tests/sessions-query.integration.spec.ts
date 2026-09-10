/**
 * The Sessions catalog against the real `ctx.sessionQuery` engine.
 *
 * The other catalog tests use a fake surface to drive states a real corpus is
 * hard to force. This one uses Harness's actual `SessionQueryEngine` over a real
 * `ctx.sessions` store, so the concrete reads the frontend depends on —
 * `listSessions()`, `readTitleSnapshots()`, `listEvents()` — are the upstream
 * implementations, not this repository's idea of them. The two abstract full-text
 * methods are the only thing a test has to supply, because the engine has none:
 * a deployment's backend owns them, and one that owns neither is the
 * degradation path this frontend has to survive.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import type {
  SessionEventSearchRequest,
  SessionEventSearchPage,
  SessionSearchHit,
  SessionSearchPage,
} from '@deepseek-ai/dsh-session-query'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SessionCatalog } from '../src/sessions/catalog.ts'
import { planResume } from '../src/sessions/plan.ts'

/** Absolute workspaces, since the store validates that headers carry one. */
const FIRST_WORKSPACE = '/tmp/dshline-sessions-one'
const SECOND_WORKSPACE = '/tmp/dshline-sessions-two'

/** Let the catalog's awaits over a real engine settle. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

/**
 * A backend whose full-text search is switched off, as many deployments are.
 *
 * The published taxonomy member is what the frontend keys its degradation on, so
 * this raises exactly that rather than a bespoke error.
 */
class UnindexedSessionQuery extends SessionQueryEngine {
  override async searchSessions(): Promise<SessionSearchPage<SessionSearchHit>> {
    throw Object.assign(new Error('no full-text backend'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
  }

  override async searchEvents(): Promise<SessionEventSearchPage> {
    throw Object.assign(new Error('no full-text backend'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
  }
}

/**
 * A backend whose full-text search is the engine's own literal-text scan.
 *
 * Not a realistic index — a real one owns ranking, generations, and cursors —
 * but every part below the search itself is upstream code: `filterSessions` and
 * `filterEvents` are the engine's concrete implementations over the real
 * first-party document projection. That is what makes this a check of the
 * contract the browser consumes rather than of a fake.
 */
class ScanningSessionQuery extends SessionQueryEngine {
  override async searchSessions(request: { query: string }): Promise<SessionSearchPage<SessionSearchHit>> {
    const items: SessionSearchHit[] = []
    for (const record of await this.filterSessions([])) {
      const documents = await this.filterEvents(record.header.id, [{ kind: 'text', text: request.query }])
      const best = documents[0]
      if (best === undefined) continue
      items.push({ ...record, bestMatch: { ...best, snippet: best.text } })
    }
    return { items }
  }

  override async searchEvents(): Promise<SessionEventSearchPage> {
    throw new Error('not needed by the Sessions browser')
  }
}

/** A scanning test backend that also exercises within-session browsing. */
class SearchingSessionQuery extends ScanningSessionQuery {
  override async searchEvents(request: SessionEventSearchRequest): Promise<SessionEventSearchPage> {
    const [record] = await this.filterSessions([{ kind: 'id', values: [request.sessionId] }])
    if (record === undefined) {
      throw Object.assign(new Error(`session "${request.sessionId}" not found`), {
        code: 'SESSION_QUERY_SESSION_NOT_FOUND',
      })
    }
    const documents = await this.filterEvents(request.sessionId, [{ kind: 'text', text: request.query }])
    return {
      session: record.header,
      items: documents.slice(0, request.limit).map(document => ({
        ...document,
        snippet: document.text,
      })),
    }
  }
}

/**
 * Compose a live session store and a session-query engine over it.
 * @returns the context, ready for `ctx.sessions` and `ctx.sessionQuery`.
 */
async function harness(engine: typeof UnindexedSessionQuery = UnindexedSessionQuery): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(engine)
  return ctx
}

describe('the Sessions catalog over the real session-query engine', () => {
  it('folds a real user rename and rejects a session outside the live store', async () => {
    const ctx = await harness()
    // dsh-session-title now injects `sessionProjections` alongside `sessions`.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, {
      fallbackMaxWords: 5,
      fallbackMaxBytes: 40,
      maxTitleBytes: 80,
    })
    const session = ctx.sessions.create(SessionId('dshline-int-rename'), {
      meta: { cwd: FIRST_WORKSPACE },
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'give this session an initial title source' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const accepted = ctx.sessionTitle.rename(session, '  New   Name  ')
    expect(accepted).toMatchObject({
      title: 'New Name',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    const observed = await ctx.sessionQuery.readTitleSnapshots([session.id])
    expect(observed).toMatchObject([{
      sessionId: session.id,
      status: 'fulfilled',
      value: { session: { id: session.id }, title: { title: 'New Name', source: { kind: 'user' } } },
    }])

    const detached = ctx.sessions.prepare(SessionId('dshline-int-rename-detached'), {
      meta: { cwd: FIRST_WORKSPACE },
    })
    expect(() => ctx.sessionTitle.rename(detached, 'Not live')).toThrow('is not live in this store')
    await ctx.fiber.dispose()
  })

  it('lists the live corpus with the headers Harness recorded', async () => {
    const ctx = await harness()
    const first = ctx.sessions.create(SessionId('dshline-int-one'), { meta: { cwd: FIRST_WORKSPACE } })
    const second = ctx.sessions.create(SessionId('dshline-int-two'), {
      meta: { cwd: SECOND_WORKSPACE, parentSession: first.id, origin: 'subagent' },
    })
    first.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'fix the wrap bug' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const catalog = new SessionCatalog({ query: ctx.sessionQuery, invalidate: () => {} })
    catalog.refresh()
    await settled()

    const listing = catalog.listing()
    expect(listing.kind).toBe('ready')
    const entries = listing.kind === 'ready' ? listing.entries : []
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    expect(byId.get(first.id)).toMatchObject({
      cwd: FIRST_WORKSPACE,
      live: true,
      // No persistence backend is mounted, so nothing materializes the id.
      persisted: false,
      origin: 'own',
      parent: undefined,
      // The real batch title observation folds nothing: no `session/title` event
      // has been appended, and the engine reports that as an absent title rather
      // than inventing one.
      title: undefined,
    })
    expect(byId.get(second.id)).toMatchObject({
      cwd: SECOND_WORKSPACE,
      parent: first.id,
      origin: 'delegated',
    })
    await ctx.fiber.dispose()
  })

  it('counts a real log through the engine, including its last activity', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('dshline-int-detail'), { meta: { cwd: FIRST_WORKSPACE } })
    session.append('turn/start', { turn: 0 })
    const last = session.append('turn/end', { turn: 0, reason: 'completed' })

    const catalog = new SessionCatalog({ query: ctx.sessionQuery, invalidate: () => {} })
    catalog.requestDetail(session.id)
    await settled()

    expect(catalog.detail(session.id)).toEqual({ events: 2, lastActivityAt: last.time })
    await ctx.fiber.dispose()
  })

  it('filters the real corpus by exact workspace and inclusive creation time', async () => {
    const ctx = await harness()
    const edge = 2_000
    const wanted = ctx.sessions.create(SessionId('dshline-int-filter-hit'), {
      meta: { cwd: FIRST_WORKSPACE, createdAt: edge },
    })
    ctx.sessions.create(SessionId('dshline-int-filter-old'), {
      meta: { cwd: FIRST_WORKSPACE, createdAt: edge - 1 },
    })
    ctx.sessions.create(SessionId('dshline-int-filter-workspace'), {
      meta: { cwd: SECOND_WORKSPACE, createdAt: edge },
    })

    const records = await ctx.sessionQuery.filterSessions([
      { kind: 'cwd', values: [FIRST_WORKSPACE] },
      { kind: 'created-at', from: edge, to: edge },
    ])
    expect(records.map(record => record.header.id)).toEqual([wanted.id])
    await ctx.fiber.dispose()
  })

  it('traces a real delegated child back to its parent', async () => {
    const ctx = await harness()
    const parent = ctx.sessions.create(SessionId('dshline-int-lineage-parent'), {
      meta: { cwd: FIRST_WORKSPACE },
    })
    const child = ctx.sessions.create(SessionId('dshline-int-lineage-child'), {
      meta: { cwd: FIRST_WORKSPACE, parentSession: parent.id, origin: 'subagent' },
    })

    const trace = await ctx.sessionQuery.traceSession(child.id)
    expect(trace.complete).toBe(true)
    expect(trace.target.header).toMatchObject({ id: child.id, origin: 'subagent' })
    expect(trace.ancestors.map(record => record.header.id)).toEqual([parent.id])
    expect(trace.descendants).toEqual([])
    await ctx.fiber.dispose()
  })

  it('traces a real FORKED child, whose header carries the inherited prefix', async () => {
    // The other lineage child above is an unseeded subagent: `parentSession`
    // and `origin` without an inherited prefix. This one is the other
    // semantics — a real `fork`, which is what makes a header `isSeeded` — so
    // the corpus the browser presents covers both, and neither is inferred
    // from the other.
    const ctx = await harness()
    const parent = ctx.sessions.create(SessionId('dshline-int-fork-parent'), {
      meta: { cwd: FIRST_WORKSPACE },
    })
    parent.append('turn/start', { turn: 1 })
    parent.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'inherited history' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const child = ctx.sessions.fork(parent, undefined, SessionId('dshline-int-fork-child'))
    // Harness fills its own header: the fork is seeded, and the inherited cut
    // is exactly the parent prefix — NOT the child's log length, which the
    // constructor's own `session/end-seed` marker already exceeds.
    expect(child.header.isSeeded).toBe(true)
    expect(child.header.parentSession).toBe(parent.id)
    expect(child.inheritedEventCount).toBe(parent.seq)
    expect(child.seq).toBeGreaterThan(child.inheritedEventCount)
    expect(child.ownEvents().map(event => event.type)).toEqual(['session/end-seed'])

    const trace = await ctx.sessionQuery.traceSession(child.id)
    expect(trace.target.header).toMatchObject({ id: child.id, isSeeded: true })
    expect(trace.ancestors.map(record => record.header.id)).toEqual([parent.id])
    await ctx.fiber.dispose()
  })

  it('degrades when the deployment’s backend indexes nothing', async () => {
    // `searchSessions` is one of the engine's two abstract methods. A deployment
    // may implement neither, and the browser has to keep working when it does.
    const ctx = await harness()
    const catalog = new SessionCatalog({ query: ctx.sessionQuery, invalidate: () => {} })
    catalog.search('wrap bug')
    await settled()
    expect(catalog.content()).toEqual({ kind: 'unsupported' })
    await ctx.fiber.dispose()
  })

  it('carries a real search hit and its excerpt into the browser', async () => {
    const ctx = await harness(ScanningSessionQuery)
    const wanted = ctx.sessions.create(SessionId('dshline-int-hit'), { meta: { cwd: FIRST_WORKSPACE } })
    const other = ctx.sessions.create(SessionId('dshline-int-miss'), { meta: { cwd: SECOND_WORKSPACE } })
    wanted.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'the renderer wraps CJK at the wrong column' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    other.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated roadmap work' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const catalog = new SessionCatalog({ query: ctx.sessionQuery, invalidate: () => {} })
    catalog.search('wraps cjk')
    await settled()

    const content = catalog.content()
    expect(content.kind).toBe('ready')
    const entries = content.kind === 'ready' ? content.entries : []
    expect(entries.map(entry => entry.id)).toEqual([wanted.id])
    expect(entries[0]?.snippet).toContain('wraps CJK')
    await ctx.fiber.dispose()
  })

  it('carries real within-session event hits through the catalog path', async () => {
    const ctx = await harness(SearchingSessionQuery)
    const session = ctx.sessions.create(SessionId('dshline-int-event-hit'), {
      meta: { cwd: FIRST_WORKSPACE },
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'the cursor must remain opaque between pages' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated event' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const catalog = new SessionCatalog({ query: ctx.sessionQuery, invalidate: () => {} })
    catalog.searchEvents(session.id, 'remain opaque')
    await settled()
    const events = catalog.events()
    expect(events.kind).toBe('ready')
    expect(events.kind === 'ready' ? events.hits : []).toMatchObject([
      { sessionId: session.id, seq: 0 },
    ])
    expect(events.kind === 'ready' ? events.hits[0]?.snippet : '').toContain('cursor must remain opaque')
    await ctx.fiber.dispose()
  })

  it('reads a real bounded event window around one hit', async () => {
    // The disclosure path against the adopted engine: the concrete `readEvent()`
    // returns the exact target plus the raw events physically around it, clamped
    // to the log's ends, and the catalog surfaces exactly that window.
    const ctx = await harness(SearchingSessionQuery)
    const session = ctx.sessions.create(SessionId('dshline-int-event-context'), {
      meta: { cwd: FIRST_WORKSPACE },
    })
    session.append('turn/start', { turn: 0 })
    const wanted = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'the surrounding events matter' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

    const catalog = new SessionCatalog({ query: ctx.sessionQuery, invalidate: () => {} })
    catalog.requestEventContext(session.id, wanted.seq)
    await settled()
    const state = catalog.eventContext(session.id, wanted.seq)
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') return
    expect(state.window.target.seq).toBe(wanted.seq)
    expect(state.window.target.type).toBe('user/message')
    // The three-event log is shorter than the bound on either side, so the whole
    // log is the window and both ends are clamped rather than padded.
    expect(state.window.events.map(one => one.seq)).toEqual([0, 1, 2])
    expect(state.window.startSeq).toBe(0)
    expect(state.window.endSeq).toBe(2)
    await ctx.fiber.dispose()
  })

  it('refuses to reopen a session the store still holds live', async () => {
    // End to end: the record the real engine produced is the record the resume
    // policy reads, and a live id cannot be resumed because the store refuses a
    // duplicate. Better to say so than to let the agent factory throw.
    const ctx = await harness()
    ctx.sessions.create(SessionId('dshline-int-live'), { meta: { cwd: FIRST_WORKSPACE } })
    const catalog = new SessionCatalog({ query: ctx.sessionQuery, invalidate: () => {} })
    catalog.refresh()
    await settled()
    const listing = catalog.listing()
    const target = listing.kind === 'ready' ? listing.entries[0] : undefined
    expect(target).toBeDefined()
    const plan = planResume({
      target: target!,
      currentSessionId: SessionId('other'),
      busy: false,
      activeWork: 0,
    })
    expect(plan.kind).toBe('refused')
    await ctx.fiber.dispose()
  })
})
