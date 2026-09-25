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
 * unfiltered listener that compared owners itself. The evidence is therefore the
 * real abstract base contract plus Work observation: `list` and `events` are the
 * two faces `HarnessWork` is documented to consume, `start` and
 * `attachController` are what a lifecycle needs to be driven at all, and every
 * other member throws by name.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import JobRegistry, {
  JobId,
  type JobEvent,
  type JobEventFilter,
  type JobEventListener,
  type JobHandle,
  type JobHooks,
  type JobSpec,
  type JobView,
} from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { HarnessWork } from '../../src/work/index.ts'

/**
 * Refuse a member the observation seam must never reach.
 *
 * Work reads job state and nothing else. A registry that answered `read`,
 * `readAt`, or `wait` would let a producer's output cursor move under the
 * model, and one that answered `kill`, `get`, or `remove` would let the overlay
 * control or reach past what the owner published.
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
 * controller-scoped admission, the output ring's retention, or waiter release
 * — none of which Work observes.
 */
class ProbeJobRegistry extends JobRegistry {
  readonly #jobs = new Map<JobId, JobView>()
  readonly #producers = new Map<JobId, ProbeProducer>()
  readonly #subscriptions = new Set<ProbeSubscription>()
  readonly #filters: JobEventFilter[] = []
  readonly #listCallers: (SessionId | undefined)[] = []
  readonly #controllers = new Set<string>()
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

  override get(): never {
    return forbidden('get')
  }

  override read(): never {
    return forbidden('read')
  }

  override readAt(): never {
    return forbidden('readAt')
  }

  override kill(): never {
    return forbidden('kill')
  }

  override wait(): never {
    return forbidden('wait')
  }

  override remove(): never {
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

  /** The producer face of one job, appending to the ring and replacing progress. */
  #handle(id: JobId, view: JobView): JobHandle {
    return {
      id,
      append: text => {
        const current = this.#require(id)
        const total = current.output.total + Buffer.byteLength(text, 'utf8')
        const next: JobView = { ...current, output: { ...current.output, total } }
        this.#jobs.set(id, next)
        // An append carries only the id and the new total, so an observer
        // schedules its own read rather than having a payload pushed at it.
        this.#emit({ type: 'output', id, ...next.owner === undefined ? {} : { owner: next.owner }, total })
      },
      updateProgress: line => {
        const current = this.#require(id)
        const next: JobView = { ...current, progress: line }
        this.#jobs.set(id, next)
        this.#emit({ type: 'progress', job: next })
      },
    }
  }

  /** The recorded projection of one job. */
  #require(id: JobId): JobView {
    const view = this.#jobs.get(id)
    if (view === undefined) throw new Error(`capability probe: unknown job ${String(id)}`)
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

    // A progress line and a ring append are real events on this stream, and
    // neither changes what any Work row projects: repainting the live region
    // for a progress line, or once per output chunk, would be repaint.
    progress('step 3/10')
    append('first partial answer\n')
    expect(invalidations).toBe(1)
    expect(work.snapshot().jobs).toEqual([
      expect.objectContaining({ state: 'running', ownership: 'this-session' }),
    ])

    registry.settle(id, 'completed')
    // A settlement empties the section, so it IS a row change and does repaint.
    expect(invalidations).toBe(2)
    expect(work.snapshot().jobs).toEqual([])

    // Every read was fenced by the same session id the filter names.
    expect(new Set(registry.listCallers())).toEqual(new Set([root]))

    work.dispose()
    expect(registry.listeners()).toBe(0)
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
