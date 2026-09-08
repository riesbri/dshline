/**
 * Capability probe: `ctx.jobs`.
 *
 * `work.spec.ts` drives `HarnessWork` with hand-typed objects cast through
 * `as unknown as JobRegistry`, which proves dshline's own reducer logic but
 * never asks the compiler whether that shape still matches the real abstract
 * class. This probe subclasses the actual `@deepseek-ai/dsh-jobs` `JobRegistry`
 * — the same package `ctx.jobs` publishes — so an upstream rename or signature
 * change fails this file at compile time, by capability name, instead of only
 * surfacing as an unrelated typecheck error somewhere else in the graph.
 *
 * The local registry implements only what `HarnessWork` is documented to use
 * (`list`, `onJobsChanged`, `attachController`, `start`) and makes every method
 * `HarnessWork` must NOT call (`read`, `kill`, `wait`, `onJobDone`) throw. The
 * evidence is the real abstract base contract plus Work observation; it is not
 * concrete provider, controller, or authorization behavior.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import JobRegistry, { JobId, type JobsChangedListener, type JobSnapshot, type JobStart } from '@deepseek-ai/dsh-jobs'
import { describe, expect, it } from 'vitest'
import { HarnessWork } from '../../src/work/index.ts'

/** Minimal in-memory registry satisfying the real abstract contract, nothing more. */
class ProbeJobRegistry extends JobRegistry {
  readonly #jobs = new Map<JobId, JobSnapshot>()
  readonly #owners = new Map<JobId, Agent | undefined>()
  readonly #changed = new Set<JobsChangedListener>()
  readonly #controllers = new Set<string>()
  #counter = 0

  override start(spec: JobStart): JobId {
    if (this.#controllers.size === 0) throw new Error('capability probe: no controller attached')
    this.#counter += 1
    const id = JobId(`${spec.kind}-${String(this.#counter)}`)
    const snapshot: JobSnapshot = {
      id, kind: spec.kind, label: spec.label, status: 'running',
      startedAt: Date.now(), ownerSession: spec.owner?.session.id, reported: false,
    }
    this.#jobs.set(id, snapshot)
    this.#owners.set(id, spec.owner)
    spec.run()
    this.#notify(spec.owner)
    return id
  }

  override list(caller?: Agent): JobSnapshot[] {
    return [...this.#jobs.values()].filter(snapshot => snapshot.ownerSession === undefined || snapshot.ownerSession === caller?.session.id)
  }

  override get(id: JobId, _caller?: Agent): JobSnapshot {
    const snapshot = this.#jobs.get(id)
    if (snapshot === undefined) throw new Error(`capability probe: unknown job ${String(id)}`)
    return snapshot
  }

  override read(): never {
    throw new Error('capability probe: HarnessWork must never consume a job output cursor')
  }

  override kill(): never {
    throw new Error('capability probe: HarnessWork must never cancel a job from Work')
  }

  override wait(): never {
    throw new Error('capability probe: HarnessWork must never wait on a job')
  }

  override onJobDone(): () => void {
    throw new Error('capability probe: HarnessWork must never subscribe to completion delivery')
  }

  override onJobsChanged(listener: JobsChangedListener): () => void {
    this.#changed.add(listener)
    return () => this.#changed.delete(listener)
  }

  override attachController(name: string): () => void {
    this.#controllers.add(name)
    return () => this.#controllers.delete(name)
  }

  /** Move a job to a terminal status and notify observers, as the real contract requires. */
  settle(id: JobId, status: 'completed' | 'killed' | 'failed'): void {
    const snapshot = this.#jobs.get(id)
    if (snapshot === undefined) throw new Error(`capability probe: unknown job ${String(id)}`)
    this.#jobs.set(id, { ...snapshot, status })
    this.#notify(this.#owners.get(id))
  }

  #notify(owner: Agent | undefined): void {
    for (const listener of this.#changed) listener(owner)
  }
}

describe('capability: jobs', () => {
  it('observes background job lifecycle through the real JobRegistry contract', () => {
    const registry = new ProbeJobRegistry(new Context())
    const disposeController = registry.attachController('capability-probe')
    const agent = { session: { id: 'root' } } as unknown as Agent

    let invalidations = 0
    const work = new HarnessWork({ agent, jobs: registry, invalidate: () => { invalidations += 1 } })
    expect(work.snapshot()).toEqual({ available: true, workflows: [], subagents: [], jobs: [] })

    const id = registry.start({
      kind: 'bash', label: 'capability probe job', owner: agent,
      run: () => ({ cancel: () => {}, done: new Promise(() => {}) }),
    })
    expect(invalidations).toBeGreaterThan(0)
    expect(work.snapshot().jobs).toEqual([
      expect.objectContaining({ source: 'job', kind: 'bash', label: 'capability probe job', state: 'running', ownership: 'this-session' }),
    ])

    registry.settle(id, 'completed')
    expect(work.snapshot().jobs).toEqual([])

    work.dispose()
    disposeController()
  })
})
