/**
 * Capability probe: `ctx.jobs`.
 *
 * `work.spec.ts` drives `HarnessWork` with hand-typed objects, which proves
 * dshline's own reducer logic but never asks the compiler whether that shape
 * still matches the real abstract class. This probe subclasses the actual
 * `@deepseek-ai/dsh-jobs` `JobRegistry` — the same package `ctx.jobs` publishes
 * — so an upstream rename or signature change fails this file at compile time,
 * by capability name, instead of only surfacing as an unrelated typecheck error
 * somewhere else in the graph. This file is in
 * `tests/tsconfig.capability.json`, which `pnpm run typecheck:capabilities`
 * and `pnpm typecheck` run; before that project existed the claim was false and
 * only Vitest would have noticed, after a full install and build.
 *
 * The adopted generation narrowed what this probe has to implement. Jobs are
 * projected as a `JobView` — `owner` replaces `ownerSession`, the ring's
 * coordinates are required, and the `reported` model-delivery flag is gone —
 * and the change feed is the filtered `events` stream rather than one
 * unfiltered listener that compared owners itself.
 *
 * Jobs 2.0 widened the surface this probe witnesses, deliberately and in one
 * direction. `/work` now reads retained output, so `get` and `readAt` are the
 * faces an observation seam relies on, and it can stop a running Job, so `kill`
 * is the face a human control relies on. The split that matters is not which
 * members exist but which side of the cursor they read from: `readAt` is
 * documented as NOT moving the model cursor and `read` is the member that does.
 * The probe therefore implements the first two faithfully, refuses `read` by
 * name, and the test below proves the refusal is a real guard rather than a
 * declaration.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import JobRegistry, {
  JobId,
  type JobChunk,
  type JobEvent,
  type JobEventFilter,
  type JobEventListener,
  type JobHandle,
  type JobHooks,
  type JobOutputRead,
  type JobSpec,
  type JobView,
} from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { HarnessWork } from '../../src/work/index.ts'

/**
 * Refuse a member the observation seam must never reach.
 *
 * The refusal set is now the CONSUMING and STATE-CHANGING half of the contract.
 * `read` would move the model cursor and may hand out the producer's terminal
 * result, so a `/work` observation that reached for it would take a Job's output
 * out of the model's mouth; `wait` and `remove` belong to callers that collect a
 * Job's terminal state themselves, and neither is a thing a viewer does. `get`,
 * `readAt`, and `kill` are no longer on this list: they are what Jobs 2.0 uses,
 * and they are implemented below against the real contract.
 * @param member - the member being refused.
 * @returns never, because it throws.
 */
function forbidden(member: string): never {
  throw new Error(`capability probe: HarnessWork must never call ${member}()`)
}

/** One registered listener and the filter it registered under. */
interface ProbeSubscription {
  readonly filter: JobEventFilter
  readonly listener: JobEventListener
}

/** What a producer was handed and what it returned. */
interface ProbeProducer {
  readonly handle: JobHandle
  readonly hooks: JobHooks
}

/**
 * Minimal in-memory registry satisfying the real abstract contract.
 *
 * It is a real service, not a hand-written stand-in: it extends the abstract
 * `JobRegistry`, registers as `ctx.jobs`, and installs the same archive
 * admission every implementation inherits. What it does not model is
 * controller-scoped admission, ring RETENTION, or waiter release — none of which
 * `/work` depends on. It does model the one coordinate rule an observer has to
 * get right: a read starting inside a retained chunk returns that whole chunk,
 * so its `at` may precede the requested `from`. An observer that appends
 * naively therefore duplicates its prefix, and only a faithful double can prove
 * dshline does not.
 */
class ProbeJobRegistry extends JobRegistry {
  readonly #jobs = new Map<JobId, JobView>()
  readonly #producers = new Map<JobId, ProbeProducer>()
  readonly #subscriptions = new Set<ProbeSubscription>()
  readonly #filters: JobEventFilter[] = []
  readonly #listCallers: (SessionId | undefined)[] = []
  readonly #controllers = new Set<string>()
  /** Retained chunks per job, in offset order — the ring without its cap. */
  readonly #rings = new Map<JobId, JobChunk[]>()
  /** Every `readAt` call, so a test can prove observation is demand-driven. */
  readonly #readAts: { readonly id: JobId; readonly from: number; readonly caller?: SessionId }[] = []
  /** Every `kill` call, with the exact three arguments the contract declares. */
  readonly #kills: { readonly id: JobId; readonly caller?: SessionId; readonly reason?: string }[] = []
  #counter = 0

  /**
   * The registry's event stream.
   *
   * `{ owner }` is the filter Work uses and the one this probe has to get
   * right: it delivers that session's own jobs plus every UNOWNED one, which is
   * exactly the set `list()` reports to the same caller. The `owners` arm needs
   * no decision here — the probe registers at the root of a fresh `Context`, so
   * a scope-composed and an everything listener both see the whole registry.
   */
  override readonly events = {
    subscribe: (filter: JobEventFilter, listener: JobEventListener): (() => void) => {
      const subscription: ProbeSubscription = { filter, listener }
      this.#filters.push(filter)
      this.#subscriptions.add(subscription)
      return () => { this.#subscriptions.delete(subscription) }
    },
  }

  /**
   * Register one job, announce it, and start its work.
   *
   * The registration commit is announced BEFORE the starter runs, so a job's
   * first event is always `registered` and the starter's own writes arrive as
   * the `progress` and `output` events they are.
   * @param spec - the producer's kind, label, optional owner, and starter.
   * @returns the registry-issued `<kind>-N` id.
   */
  override start(spec: JobSpec): JobId {
    if (this.#controllers.size === 0) throw new Error('capability probe: no controller attached')
    this.#counter += 1
    const id = JobId(`${spec.kind}-${String(this.#counter)}`)
    const view: JobView = {
      id,
      kind: spec.kind,
      label: spec.label,
      status: 'running',
      startedAt: Date.now(),
      // An unowned job omits the key; the seam treats that as visible to every
      // caller, which is the other half of what `{ owner }` delivers.
      ...spec.owner === undefined ? {} : { owner: spec.owner },
      output: { total: 0, earliest: 0 },
    }
    this.#jobs.set(id, view)
    this.#emit({ type: 'registered', job: view })
    this.#producers.set(id, {
      handle: this.#handle(id, view),
      hooks: spec.run(this.#handle(id, view)),
    })
    return id
  }

  /**
   * List caller-owned and unowned jobs in registration order.
   *
   * A settled record STAYS listed — the terminal filter belongs to the
   * consumer, which is exactly the distinction this probe exists to keep
   * honest: `HarnessWork` drops `completed`/`killed`/`failed` rows itself.
   * @param caller - the reading session, fenced against `owner`.
   * @returns fresh projections in registration order.
   */
  override list(caller?: SessionId): JobView[] {
    this.#listCallers.push(caller)
    return [...this.#jobs.values()].filter(view => view.owner === undefined || view.owner === caller)
  }

  /**
   * Project one job, fenced by the caller's session.
   *
   * `/work` reads this to establish the authoritative anchor before its first
   * `readAt`, so an unknown or foreign job throws here rather than letting an
   * observer attach itself to nothing.
   * @param id - the job to look up.
   * @param caller - the reading session, checked against `owner`.
   * @returns a fresh projection.
   */
  override get(id: JobId, caller?: SessionId): JobView {
    return this.#require(id, caller)
  }

  /**
   * The consuming read, refused.
   *
   * The declared parameters stay the REAL ones even though the body throws: a
   * stand-in that claimed zero parameters would not be standing in for the
   * contract at all, and the point of refusing this member is that a caller
   * CAN reach it with the right arguments and must fail loudly when it does.
   * @returns never, because it throws.
   */
  override read(_id: JobId, _caller?: SessionId): never {
    return forbidden('read')
  }

  /**
   * Read retained output WITHOUT moving any model cursor.
   *
   * Faithful on the coordinate rule that matters: a chunk overlapping `[from,
   * total)` is returned WHOLE, so a read resuming from the middle of a chunk
   * hands back a chunk whose `at` precedes `from`. That is exactly the case a
   * naive `tail += chunk.text` would duplicate, and it is why this is a real
   * ring rather than a list of strings.
   * @param id - the job to read.
   * @param from - absolute byte offset to resume from.
   * @param caller - the reading session, checked against `owner`.
   * @returns the overlapping chunks, the resume offset, and the lossy flag.
   */
  override readAt(id: JobId, from: number, caller?: SessionId): JobOutputRead {
    this.#require(id, caller)
    this.#readAts.push({ id, from, ...caller === undefined ? {} : { caller } })
    const ring = this.#rings.get(id) ?? []
    const chunks = ring.filter(chunk => {
      return chunk.at + Buffer.byteLength(chunk.text, 'utf8') > from
    })
    const view = this.#require(id, caller)
    return { chunks, next: view.output.total, lossy: from < view.output.earliest }
  }

  /**
   * Cancel one job on a caller's behalf, recording the exact three arguments.
   *
   * The reason is forwarded verbatim and the transition to `stopping` is
   * announced, because a human control is only correct if the rest of the
   * pipeline can see what it did. The `kill` ledger that suppresses a
   * completion notice belongs to `dsh-tool-jobs`, NOT to this registry: a human
   * stop must leave that notice due, and there is nothing here to express that
   * either way.
   * @param id - the job to cancel.
   * @param caller - the killing session, checked against `owner`.
   * @param reason - forwarded verbatim to the producer.
   * @returns `requested` for live work, `already-finished` otherwise.
   */
  override kill(id: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished' {
    const view = this.#require(id, caller)
    this.#kills.push({ id, ...caller === undefined ? {} : { caller }, ...reason === undefined ? {} : { reason } })
    if (view.status !== 'running' && view.status !== 'stopping') return 'already-finished'
    if (view.status === 'stopping') return 'already-finished'
    // A producer `cancel()` throw propagates and leaves the record untouched,
    // which is what makes "Stop failed" an honest thing to show.
    this.#producers.get(id)?.hooks.cancel(reason)
    const next: JobView = { ...view, status: 'stopping' }
    this.#jobs.set(id, next)
    this.#emit({ type: 'stopping', job: next })
    return 'requested'
  }

  override wait(_id: JobId, _timeoutMs: number, _caller?: SessionId, _signal?: AbortSignal): never {
    return forbidden('wait')
  }

  override remove(_id: JobId, _caller?: SessionId): never {
    return forbidden('remove')
  }

  override attachController(name: string): () => void {
    this.#controllers.add(name)
    return () => { this.#controllers.delete(name) }
  }

  /** The producer face and hooks the registry kept for one started job. */
  producer(id: JobId): ProbeProducer | undefined {
    return this.#producers.get(id)
  }

  /** Every filter a subscriber registered under, in call order. */
  filters(): readonly JobEventFilter[] {
    return this.#filters
  }

  /** Every caller `list` was asked for, in call order. */
  listCallers(): readonly (SessionId | undefined)[] {
    return this.#listCallers
  }

  /** Every `readAt` call, in order, so observation cost is assertable. */
  readAts(): readonly { readonly id: JobId; readonly from: number; readonly caller?: SessionId }[] {
    return this.#readAts
  }

  /** Every `kill` call, with the exact arguments the contract declares. */
  kills(): readonly { readonly id: JobId; readonly caller?: SessionId; readonly reason?: string }[] {
    return this.#kills
  }

  /** How many listeners are still registered. */
  listeners(): number {
    return this.#subscriptions.size
  }

  /**
   * Move a job to a terminal status and announce it, as the real contract does.
   * @param id - the job to settle.
   * @param status - the terminal status the producer reported.
   */
  settle(id: JobId, status: 'completed' | 'killed' | 'failed'): void {
    const live = this.#require(id)
    // Settlement CLEARS the live progress line, and `progress` is optional
    // upstream rather than nullable, so the key is dropped rather than emptied.
    const { progress, ...view } = live
    const terminal: JobView = { ...view, status }
    this.#jobs.set(id, terminal)
    // The event reports the terminal projection and whether the settlement
    // released a live `wait`.
    this.#emit({ type: 'settled', job: terminal, cause: 'producer', awaited: false })
  }

  /**
   * The producer face of one job, appending to the ring and replacing progress.
   *
   * The append keeps a real chunk list with real absolute offsets, because a
   * `readAt` that resumed from a chunk's interior has to be able to return that
   * whole chunk — the coordinate case the observer's byte arithmetic exists for.
   * @param id - the job whose producer face to build.
   * @param view - the projection the job was registered with.
   * @returns the handle the starter was handed.
   */
  #handle(id: JobId, view: JobView): JobHandle {
    return {
      id,
      append: (text, options) => {
        const current = this.#require(id)
        if (text.length === 0) return
        const bytes = Buffer.byteLength(text, 'utf8')
        const ring = this.#rings.get(id) ?? []
        ring.push({
          at: current.output.total,
          text,
          ...options?.channel === undefined ? {} : { channel: options.channel },
          ...options?.gapBefore === undefined ? {} : { gapBefore: options.gapBefore },
        })
        this.#rings.set(id, ring)
        const next: JobView = { ...current, output: { ...current.output, total: current.output.total + bytes } }
        this.#jobs.set(id, next)
        // An append carries only the id and the new total, so an observer
        // schedules its own read rather than having a payload pushed at it.
        this.#emit({ type: 'output', id, ...next.owner === undefined ? {} : { owner: next.owner }, total: next.output.total })
      },
      updateProgress: line => {
        const current = this.#require(id)
        const next: JobView = { ...current, progress: line }
        this.#jobs.set(id, next)
        this.#emit({ type: 'progress', job: next })
      },
    }
  }

  /**
   * The recorded projection of one job, fenced by the reading session.
   *
   * The fence is the seam's own access rule — ids are predictable, so
   * authorization rather than secrecy is the boundary — and a probe that skipped
   * it could not prove dshline passes a session id at all.
   * @param id - the job to resolve.
   * @param caller - the reading session, when the caller supplied one.
   * @returns the recorded projection.
   */
  #require(id: JobId, caller?: SessionId): JobView {
    const view = this.#jobs.get(id)
    if (view === undefined) throw new Error(`capability probe: unknown job ${String(id)}`)
    if (view.owner !== undefined && caller !== undefined && view.owner !== caller) {
      throw new Error(`capability probe: job ${String(id)} is not visible to ${String(caller)}`)
    }
    return view
  }

  /** Deliver one event to every listener whose filter admits it. */
  #emit(event: JobEvent): void {
    const owner = event.type === 'output' ? event.owner : event.job.owner
    for (const { filter, listener } of [...this.#subscriptions]) {
      if ('owner' in filter && owner !== undefined && owner !== filter.owner) continue
      listener(event)
    }
  }
}

describe('capability: jobs', () => {
  it('observes background job lifecycle through the real JobRegistry contract', () => {
    const registry = new ProbeJobRegistry(new Context())
    const disposeController = registry.attachController('capability-probe')
    const root = SessionId('root')
    const agent = { session: { id: root } } as Agent

    let invalidations = 0
    const work = new HarnessWork({ agent, jobs: registry, invalidate: () => { invalidations += 1 } })
    expect(work.snapshot()).toEqual({ available: true, workflows: [], subagents: [], jobs: [] })
    // The whole observation seam in one line: one owner-scoped subscription,
    // and `list` fenced by the same session id rather than by a whole Agent.
    expect(registry.filters()).toEqual([{ owner: root }])

    let progress: (line: string) => void = () => {}
    let append: (text: string) => void = () => {}
    const id = registry.start({
      kind: 'bash', label: 'capability probe job', owner: root,
      run: handle => {
        // The producer writes through the face the registry issued, so the
        // probe can publish the events the adopted generation added.
        progress = handle.updateProgress
        append = handle.append
        return { cancel: () => {}, done: new Promise<never>(() => {}) }
      },
    })
    // The handle carries the registry-issued id, not whatever the producer named.
    expect(registry.producer(id)?.handle.id).toBe(id)
    expect(invalidations).toBe(1)
    expect(work.snapshot().jobs).toEqual([
      expect.objectContaining({ source: 'job', kind: 'bash', label: 'capability probe job', state: 'running', ownership: 'this-session' }),
    ])

    // A progress line IS a row change now: the row can show it, and a row whose
    // producer just re-stated what it is doing cannot be left looking silent.
    progress('step 3/10')
    expect(invalidations).toBe(2)
    expect(work.snapshot().jobs).toEqual([
      expect.objectContaining({ state: 'running', progress: 'step 3/10' }),
    ])
    // A ring append is still NOT one. It arrives once per chunk, and nothing
    // about the overview row changes because of it.
    append('first partial answer\n')
    expect(invalidations).toBe(2)
    // And with no detail open, an append must not turn into an output read.
    expect(registry.readAts()).toEqual([])

    registry.settle(id, 'completed')
    // A settlement empties the section, so it IS a row change and does repaint.
    expect(invalidations).toBe(3)
    expect(work.snapshot().jobs).toEqual([])

    // Every read was fenced by the same session id the filter names.
    expect(new Set(registry.listCallers())).toEqual(new Set([root]))

    work.dispose()
    expect(registry.listeners()).toBe(0)
    disposeController()
  })

  it('observes one job through readAt and stops it through the generic registry call', () => {
    const registry = new ProbeJobRegistry(new Context())
    const disposeController = registry.attachController('capability-probe')
    const root = SessionId('root')
    const other = SessionId('other')
    const agent = { session: { id: root } } as Agent

    let invalidations = 0
    const work = new HarnessWork({ agent, jobs: registry, invalidate: () => { invalidations += 1 } })
    let append: (text: string) => void = () => {}
    let cancelled: (string | undefined)[] = []
    const id = registry.start({
      kind: 'bash', label: 'observed job', owner: root,
      run: handle => {
        append = handle.append
        return { cancel: reason => { cancelled.push(reason) }, done: new Promise<never>(() => {}) }
      },
    })
    append('built target\n')

    // The overview is a LIST surface: no detail, no output read.
    expect(work.snapshot().jobs).toHaveLength(1)
    expect(registry.readAts()).toEqual([])

    // Opening the detail is what buys observation, and it reads only this job.
    const observation = work.observeJob('bash-1')
    expect(observation).toBeDefined()
    expect(observation?.reading().lines).toEqual([{ text: 'built target' }])
    // One anchor `get` is not a read; the reads are the observer's own, and the
    // first resumes from 0 so a lossy ring is REPORTED rather than hidden.
    expect(registry.readAts()).toEqual([{ id, from: 0, caller: root }])

    // A later append wakes exactly this observer, which resumes from the
    // previous `next` instead of re-reading the whole ring.
    const before = registry.readAts().length
    append('done\n')
    expect(registry.readAts()).toHaveLength(before + 1)
    expect(registry.readAts()[before]?.from).toBe(13)
    expect(observation?.reading().lines).toEqual([{ text: 'built target' }, { text: 'done' }])

    // Disposing is synchronous and unsubscribes: a late event reaches nothing.
    const seen = invalidations
    observation?.dispose()
    append('after disposal\n')
    expect(invalidations).toBe(seen)
    expect(registry.readAts()).toHaveLength(before + 1)

    // The human stop is the GENERIC registry operation, addressed by id, fenced
    // by this session, and carrying upstream's own reason string. Nothing here
    // knows what kind of producer this is.
    const row = work.snapshot().jobs[0]
    expect(row).toBeDefined()
    const result = work.stopJob(row!)
    expect(result).toEqual({ kind: 'requested', message: 'Stop requested.' })
    expect(registry.kills()).toEqual([{ id, caller: root, reason: 'cancelled by the user' }])
    expect(cancelled).toEqual(['cancelled by the user'])
    // The authoritative transition is what re-states the row, not local state.
    expect(work.snapshot().jobs[0]?.state).toBe('stopping')

    // A `stopping` job offers nothing further, and a foreign session can never
    // reach this one through the owner fence.
    expect(work.stopJob(work.snapshot().jobs[0]!).kind).toBe('unsupported')
    expect(() => registry.readAt(id, 0, other)).toThrow(/not visible/u)

    work.dispose()
    disposeController()
  })

  it('refuses the consuming read so an accidental cursor move fails loudly', () => {
    const registry = new ProbeJobRegistry(new Context())
    const disposeController = registry.attachController('capability-probe')
    const root = SessionId('root')
    const agent = { session: { id: root } } as Agent
    const work = new HarnessWork({ agent, jobs: registry, invalidate: () => {} })
    registry.start({
      kind: 'bash', label: 'never consumed', owner: root,
      run: () => ({ cancel: () => {}, done: new Promise<never>(() => {}) }),
    })
    work.snapshot()
    work.observeJob('bash-1')?.reading()
    work.stopJob(work.snapshot().jobs[0]!)
    // The three members dshline reaches for all answer; the consuming one throws
    // by name. If a future change swapped `readAt` for `read`, this fails here
    // rather than silently taking bytes from the model.
    expect(() => registry.read('bash-1' as never, root)).toThrow(/must never call read\(\)/u)
    expect(() => registry.wait('bash-1' as never, 1, root)).toThrow(/must never call wait\(\)/u)
    expect(() => registry.remove('bash-1' as never, root)).toThrow(/must never call remove\(\)/u)
    work.dispose()
    disposeController()
  })

  it('reaches an unowned job through the same owner-scoped subscription', () => {
    // `{ owner }` delivers the session's own jobs PLUS every unowned one, so a
    // job nobody owns still appears — labelled `unowned` rather than claimed.
    const registry = new ProbeJobRegistry(new Context())
    const disposeController = registry.attachController('capability-probe')
    const root = SessionId('root')
    const agent = { session: { id: root } } as Agent

    const work = new HarnessWork({ agent, jobs: registry, invalidate: () => {} })
    registry.start({
      kind: 'bash', label: 'nobody owns this',
      run: () => ({ cancel: () => {}, done: new Promise<never>(() => {}) }),
    })
    expect(work.snapshot().jobs).toEqual([
      expect.objectContaining({ label: 'nobody owns this', ownership: 'unowned' }),
    ])

    work.dispose()
    disposeController()
  })
})
