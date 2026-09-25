/** Tests for the optional generic Harness Work projection and live overlay. */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  JobId,
  type JobEvent,
  type JobEventFilter,
  type JobEventListener,
  type JobRegistry,
  type JobView,
} from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { SubagentDescendantListEntry, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { displayWidth, Screen, SPINNER_INTERVAL_MS, stripAnsi, wrapToWidth } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { HarnessWork } from '../src/work/index.ts'
import type { WorkCapabilities } from '../src/work/index.ts'
import { createWorkOverlay } from '../src/work/overlay.ts'
import type { JobWorkItem, SubagentWorkItem, WorkInterruptResult, WorkSnapshot } from '../src/work/model.ts'
import { activeWorkCount, workItemKey, workSummary } from '../src/work/model.ts'

/** The session every row in this file belongs to. */
const ROOT = SessionId('root')

/** The root agent shape the capability contracts use for ownership. */
const agent = { session: { id: ROOT } } as Agent

/** The exact listener `HarnessWork` registers for a `subagent/start` edge. */
type StartListener = Parameters<NonNullable<WorkCapabilities['onSubagentStart']>>[0]

/** The exact listener `HarnessWork` registers for a `subagent/end` edge. */
type EndListener = Parameters<NonNullable<WorkCapabilities['onSubagentEnd']>>[0]

/**
 * The edge distance `listDescendants` reports for a direct child of this
 * session. The seam walks the whole tree, so every other depth belongs to some
 * other parent's branch.
 */
const DIRECT_CHILD_DEPTH = 1

/** A grandchild row: two edges away, and therefore not this session's work. */
const GRANDCHILD_DEPTH = 2

/** Standard successful interrupt response for overlay-only tests. */
const INTERRUPT_REQUESTED: WorkInterruptResult = { kind: 'requested', message: 'Interrupt requested.' }

/**
 * Make a job projection with only the facts Work is allowed to present.
 *
 * `output` is present because the real `JobView` always publishes the ring's
 * absolute coordinates, and `reported` is gone: the adopted generation replaced
 * that model-delivery flag with the owning session itself.
 * @param status - lifecycle state the registry is reporting.
 * @param label - the producer's one-line label.
 * @returns a fresh projection, as `list()` hands out.
 */
function job(status: JobView['status'] = 'running', label = 'pnpm test'): JobView {
  return {
    id: JobId('bash-1'),
    kind: 'bash',
    label,
    status,
    startedAt: 0,
    owner: ROOT,
    output: { total: 0, earliest: 0 },
  }
}

/**
 * The same job with no owner at all.
 *
 * `owner` is optional upstream rather than nullable, so an unowned job omits
 * the key; reading that absence as a session would claim an association the
 * registry never published.
 * @returns a projection carrying no `owner`.
 */
function unownedJob(): JobView {
  const { owner, ...view } = job()
  return view
}

/** A registry event announcing one committed change to a job's row. */
function rowEvent(type: 'registered' | 'progress' | 'stopping' | 'removed'): JobEvent {
  return { type, job: job() }
}

/** A registry event announcing that a job reached its terminal status. */
function settledEvent(): JobEvent {
  return { type: 'settled', job: job('completed'), cause: 'producer', awaited: false }
}

/** A registry event announcing that the output ring grew. */
function outputEvent(): JobEvent {
  return { type: 'output', id: JobId('bash-1'), owner: ROOT, total: 64 }
}

/** What one jobs double answers, and everything it recorded being asked. */
interface JobsSeam {
  /** The registry, handed to `HarnessWork`. */
  readonly jobs: JobRegistry
  /** Every filter `subscribe` was called with, in call order. */
  readonly filters: () => readonly JobEventFilter[]
  /** Every caller `list` was called with, in call order. */
  readonly listCallers: () => readonly unknown[]
  /** Names of the forbidden members a projection reached for. */
  readonly forbidden: () => readonly string[]
  /** Deliver one event to every registered listener, as the registry would. */
  readonly emit: (event: JobEvent) => void
  /** How many listeners are still registered. */
  readonly live: () => number
}

/**
 * Build a jobs double serving `views`, recording what Work asked of it.
 *
 * Everything upstream deleted simply has no slot here: there is no
 * `onJobsChanged` owner-comparison feed to answer, and no `onJobDone`
 * completion-delivery subscription left to refuse. What remains forbidden is
 * the reading and control surface, because Work observes jobs and must never
 * consume a producer's output cursor or cancel its work.
 * @param views - what `list()` answers on every read.
 * @returns the double and everything it recorded.
 */
function jobsSeam(views: () => JobView[]): JobsSeam {
  const filters: JobEventFilter[] = []
  const listeners: JobEventListener[] = []
  const listCallers: unknown[] = []
  const forbidden: string[] = []
  const refuse = (member: string): never => {
    forbidden.push(member)
    throw new Error(`HarnessWork must never call ${member}()`)
  }
  return {
    jobs: {
      list: (caller?: SessionId) => {
        listCallers.push(caller)
        return views()
      },
      events: {
        subscribe: (filter: JobEventFilter, listener: JobEventListener) => {
          filters.push(filter)
          listeners.push(listener)
          return () => {
            filters.splice(filters.indexOf(filter), 1)
            listeners.splice(listeners.indexOf(listener), 1)
          }
        },
      },
      get: () => refuse('get'),
      read: () => refuse('read'),
      readAt: () => refuse('readAt'),
      kill: () => refuse('kill'),
      wait: () => refuse('wait'),
      remove: () => refuse('remove'),
    } as JobRegistry,
    filters: () => filters,
    listCallers: () => listCallers,
    forbidden: () => forbidden,
    emit: event => { for (const listener of [...listeners]) listener(event) },
    live: () => listeners.length,
  }
}

/** A Job Work row for overlay- and summary-focused tests. */
function jobItem(overrides: Partial<JobWorkItem> = {}): JobWorkItem {
  return {
    id: 'bash-1', source: 'job', kind: 'bash', label: 'pnpm test',
    state: 'running', startedAt: Date.now(), ownership: 'this-session', interruptible: false, ...overrides,
  }
}

/** A subagent Work row for overlay- and summary-focused tests. */
function subagentItem(overrides: Partial<SubagentWorkItem> = {}): SubagentWorkItem {
  return {
    id: 'child', source: 'subagent', runId: 'r1', provider: 'codex', local: true, state: 'running',
    startedAt: Date.now(), interruptible: true, ...overrides,
  }
}

/** Three distinct subagent rows for selection-identity scenarios. */
function trio(): WorkSnapshot {
  return {
    ...EMPTY,
    available: true,
    subagents: [
      subagentItem({ id: 'a', runId: 'a', label: 'A' }),
      subagentItem({ id: 'b', runId: 'b', label: 'B', mode: 'continuable' }),
      subagentItem({ id: 'c', runId: 'c', label: 'C' }),
    ],
    jobs: [],
  }
}

/** Let an async discovery read publish its harmless enrichment. */
async function settled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** A no-work projection used by overlay-focused tests. */
const EMPTY: WorkSnapshot = { available: false, workflows: [], subagents: [], jobs: [] }

/**
 * One direct child row served by the authoritative descendant discovery seam.
 *
 * `parentId` and `depth` are what make a row attributable: the traversal walks
 * whole catalogs, so the parent is what says which branch a row belongs to and
 * the depth is what says how far from the requested root it sits.
 */
const CONTINUABLE_CHILD: SubagentDescendantListEntry = {
  kind: 'child', id: SessionId('child'), mode: 'continuable',
  label: '审查 renderer', activity: 'running', hasChildren: false,
  parentId: ROOT, depth: DIRECT_CHILD_DEPTH,
}

/** A settled durable child: discoverable, but never active Work by itself. */
const INACTIVE_CHILD: SubagentDescendantListEntry = {
  kind: 'child', id: SessionId('durable'), mode: 'continuable',
  label: 'history', activity: 'inactive', hasChildren: true,
  parentId: ROOT, depth: DIRECT_CHILD_DEPTH,
}

/** A grandchild of this session, discoverable only because the walk is recursive. */
const GRANDCHILD: SubagentDescendantListEntry = {
  kind: 'child', id: SessionId('grandchild'), mode: 'continuable',
  label: 'deep reviewer', activity: 'running', hasChildren: false,
  parentId: SessionId('child'), depth: GRANDCHILD_DEPTH,
}

/**
 * A direct child the seam has no descriptor for: its own catalog could not be
 * read, so the row carries the failure and nothing else.
 */
const CORRUPT_CHILD: SubagentDescendantListEntry = {
  kind: 'diagnostic', id: SessionId('broken'), reason: 'corrupt',
  parentId: ROOT, depth: DIRECT_CHILD_DEPTH,
}

describe('generic Harness Work capability projection', () => {
  it('boots without jobs or subagents', () => {
    const work = new HarnessWork({ agent, invalidate: () => {} })
    expect(work.snapshot()).toEqual(EMPTY)
    work.dispose()
  })

  it('boots with jobs only and never reads a job output cursor', () => {
    const seam = jobsSeam(() => [job()])
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => {} })
    const running = work.snapshot().jobs[0]
    expect(running).toMatchObject({
      source: 'job', kind: 'bash', label: 'pnpm test', state: 'running', ownership: 'this-session',
    })
    // `read` and `readAt` would consume a producer's ring; the double throws.
    expect(seam.forbidden()).toEqual([])
    work.dispose()
  })

  it('marks an unowned job without inventing a session association', () => {
    // `owner` is absent, not null: the projection publishes the key only for an
    // owned job, and reading a missing key as a session would claim authority.
    const seam = jobsSeam(() => [unownedJob()])
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => {} })
    expect(work.snapshot().jobs[0]?.ownership).toBe('unowned')
    work.dispose()
  })

  it('scopes the job event subscription to this session and lists by session id', () => {
    const seam = jobsSeam(() => [job()])
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => {} })
    work.snapshot()
    // The `{ owner }` filter IS the owner scoping: the seam delivers that
    // session's own jobs plus every unowned one, so no other session's change
    // can reach this listener at all. A second, unscoped subscription would.
    expect(seam.filters()).toEqual([{ owner: ROOT }])
    // The registry fences reads by SESSION ID, not by the whole Agent: the
    // argument is the id itself, so there is no object to walk back into.
    expect(seam.listCallers()).toEqual([ROOT])
    work.dispose()
    expect(seam.live()).toBe(0)
  })

  it('repaints for the four row-changing job events and never for output chatter', () => {
    let invalidated = 0
    const seam = jobsSeam(() => [job()])
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => { invalidated += 1 } })
    // A registration adds a row, a stop and a settlement change what `list()`
    // filters to, and a removal empties the section.
    for (const type of ['registered', 'stopping', 'removed'] as const) {
      const before = invalidated
      seam.emit(rowEvent(type))
      expect(invalidated, type).toBe(before + 1)
    }
    const afterRows = invalidated
    seam.emit(settledEvent())
    expect(invalidated).toBe(afterRows + 1)
    // A progress line and a ring append are producer chatter no Work row
    // projects, and an append lands once per chunk: repainting the live region
    // for either would be repaint, not information.
    const afterSettle = invalidated
    seam.emit(rowEvent('progress'))
    seam.emit(outputEvent())
    expect(invalidated).toBe(afterSettle)
    work.dispose()
  })

  it('stops repainting on job events once the projection is disposed', () => {
    let invalidated = 0
    const seam = jobsSeam(() => [job()])
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => { invalidated += 1 } })
    work.dispose()
    const afterDispose = invalidated
    seam.emit(rowEvent('registered'))
    seam.emit(settledEvent())
    expect(invalidated).toBe(afterDispose)
  })

  it('uses direct-child discovery and generic lifecycle edges for subagents', async () => {
    let started: StartListener | undefined
    let ended: EndListener | undefined
    const scans: unknown[] = []
    const subagents = {
      listDescendants: async (root: SessionId) => {
        scans.push(root)
        return [CONTINUABLE_CHILD]
      },
    } as SubagentRuntime
    const work = new HarnessWork({
      agent,
      subagents,
      onSubagentStart: listener => { started = listener; return () => {} },
      onSubagentEnd: listener => { ended = listener; return () => {} },
      invalidate: () => {},
    })
    await settled()
    started?.({ runId: SubagentRunId('r1'), provider: 'provider-中文', id: SessionId('child'), local: false })
    await settled()
    // Discovery is the recursive walk, asked for THIS session each time a
    // lifecycle edge opens — a flat parent catalog could not answer with
    // residency, lineage, or a branch diagnostic at all.
    expect(scans.length).toBeGreaterThanOrEqual(2)
    expect(new Set(scans)).toEqual(new Set([ROOT]))
    expect(work.snapshot().subagents).toMatchObject([{
      provider: 'provider-中文', label: '审查 renderer', mode: 'continuable',
      residency: 'resident', hasChildren: false, interruptible: true, local: false,
    }])
    ended?.({ runId: SubagentRunId('r1'), provider: 'provider-中文', id: SessionId('child'), local: false, stopReason: 'completed' })
    expect(work.snapshot().subagents).toEqual([])
  })

  it('keeps sequential lifecycle epochs of one durable child distinct', async () => {
    let started: StartListener | undefined
    let ended: EndListener | undefined
    const work = new HarnessWork({
      agent,
      subagents: { listDescendants: async () => [] } as SubagentRuntime,
      onSubagentStart: listener => { started = listener; return () => {} },
      onSubagentEnd: listener => { ended = listener; return () => {} },
      invalidate: () => {},
    })
    // A cold-resumed continuable child opens a NEW epoch under the same durable
    // session id: the first epoch must fully settle before the second begins.
    started?.({ runId: SubagentRunId('epoch-1'), provider: 'codex', id: SessionId('child'), local: true })
    expect(work.snapshot().subagents.map(row => row.runId)).toEqual(['epoch-1'])
    ended?.({ runId: SubagentRunId('epoch-1'), provider: 'codex', id: SessionId('child'), local: true, stopReason: 'completed' })
    expect(work.snapshot().subagents).toEqual([])
    started?.({ runId: SubagentRunId('epoch-2'), provider: 'codex', id: SessionId('child'), local: true })
    expect(work.snapshot().subagents.map(row => row.runId)).toEqual(['epoch-2'])
    expect(work.snapshot().subagents[0]?.id).toBe('child')
    expect(workItemKey(subagentItem({ id: 'child', runId: 'epoch-1' }))).toBe('subagent:epoch-1')
    expect(workItemKey(subagentItem({ id: 'child', runId: 'epoch-2' }))).toBe('subagent:epoch-2')
    work.dispose()
  })

  it('does not promote inactive durable children into active Work', async () => {
    const work = new HarnessWork({
      agent,
      subagents: { listDescendants: async () => [INACTIVE_CHILD] } as SubagentRuntime,
      invalidate: () => {},
    })
    await settled()
    expect(work.snapshot().subagents).toEqual([])
    work.dispose()
  })

  it('keeps lifecycle truth even when discovery reports the durable child as stored', async () => {
    let started: StartListener | undefined
    const work = new HarnessWork({
      agent,
      subagents: { listDescendants: async () => [INACTIVE_CHILD] } as SubagentRuntime,
      onSubagentStart: listener => { started = listener; return () => {} },
      invalidate: () => {},
    })
    await settled()
    started?.({ runId: SubagentRunId('r1'), provider: 'codex', id: SessionId('durable'), local: true })
    await settled()
    // The open lifecycle edge is the active row; discovery only enriches it.
    expect(work.snapshot().subagents).toMatchObject([{
      id: 'durable', runId: 'r1', mode: 'continuable', residency: 'stored',
      hasChildren: true, interruptible: true,
    }])
    work.dispose()
  })

  it('keeps lifecycle truth when discovery fails', async () => {
    let started: StartListener | undefined
    const work = new HarnessWork({
      agent,
      subagents: { listDescendants: async () => { throw new Error('projection unavailable') } } as SubagentRuntime,
      onSubagentStart: listener => { started = listener; return () => {} },
      invalidate: () => {},
    })
    started?.({ runId: SubagentRunId('r1'), provider: 'codex', id: SessionId('child'), local: false })
    await settled()
    expect(work.snapshot().subagents).toMatchObject([{ id: 'child', provider: 'codex' }])
    work.dispose()
  })

  it('marks a discovered one-shot subagent as non-interruptible', async () => {
    let started: StartListener | undefined
    const work = new HarnessWork({
      agent,
      subagents: { listDescendants: async () => [{ ...CONTINUABLE_CHILD, mode: 'one-shot' as const }] } as SubagentRuntime,
      onSubagentStart: listener => { started = listener; return () => {} },
      invalidate: () => {},
    })
    await settled()
    started?.({ runId: SubagentRunId('one'), provider: 'generic', id: SessionId('child'), local: false })
    await settled()
    expect(work.snapshot().subagents[0]?.interruptible).toBe(false)
  })

  it('lets a deeper descendant row enrich nothing', async () => {
    let started: StartListener | undefined
    const work = new HarnessWork({
      agent,
      // The walk returns whole catalogs, so a grandchild arrives beside the
      // direct children. Work's lifecycle edges are scoped to THIS parent, so a
      // deeper row belongs to some other parent's branch.
      subagents: { listDescendants: async () => [CONTINUABLE_CHILD, GRANDCHILD] } as SubagentRuntime,
      onSubagentStart: listener => { started = listener; return () => {} },
      invalidate: () => {},
    })
    await settled()
    started?.({ runId: SubagentRunId('r1'), provider: 'codex', id: SessionId('child'), local: false })
    started?.({ runId: SubagentRunId('r2'), provider: 'codex', id: SessionId('grandchild'), local: false })
    await settled()
    const rows = new Map(work.snapshot().subagents.map(row => [row.id, row]))
    expect(rows.get('child')).toMatchObject({ mode: 'continuable', label: '审查 renderer', interruptible: true })
    const grandchild = rows.get('grandchild')
    expect(grandchild).toMatchObject({ id: 'grandchild', local: false })
    expect(grandchild?.mode).toBeUndefined()
    expect(grandchild?.label).toBeUndefined()
    expect(grandchild?.residency).toBeUndefined()
    // No proven mode means no authorized interrupt, exactly as for an unknown child.
    expect(grandchild?.interruptible).toBe(false)
    work.dispose()
  })

  it('keeps a diagnostic direct child as a lifecycle-only, non-interruptible row', async () => {
    let started: StartListener | undefined
    const work = new HarnessWork({
      agent,
      subagents: { listDescendants: async () => [CORRUPT_CHILD] } as SubagentRuntime,
      onSubagentStart: listener => { started = listener; return () => {} },
      invalidate: () => {},
    })
    await settled()
    started?.({ runId: SubagentRunId('r1'), provider: 'codex', id: SessionId('broken'), local: false })
    await settled()
    // A diagnostic is the seam saying it has no descriptor to give. No mode,
    // residency, or lineage follows from it, and none is recoverable by
    // choosing one, so the row keeps its lifecycle edge alone.
    const row = work.snapshot().subagents[0]
    expect(row).toMatchObject({ id: 'broken', runId: 'r1', local: false, interruptible: false })
    expect(row?.mode).toBeUndefined()
    expect(row?.label).toBeUndefined()
    expect(row?.residency).toBeUndefined()
    expect(row?.hasChildren).toBeUndefined()
    // Interrupt is authorized only for a PROVEN continuable child, and the
    // durable-conversation target refuses a session the catalog would not return.
    const refused = row === undefined ? work.interrupt(subagentItem({ id: 'broken', interruptible: false })) : work.interrupt(row)
    expect(refused).toEqual({ kind: 'unsupported', message: 'This subagent cannot be interrupted here.' })
    work.dispose()
  })

  it('does not let a disposed pending discovery mutate the projection', async () => {
    let resolve!: (entries: readonly SubagentDescendantListEntry[]) => void
    const pending = new Promise<readonly SubagentDescendantListEntry[]>(done => { resolve = done })
    let invalidated = 0
    const work = new HarnessWork({
      agent,
      subagents: { listDescendants: () => pending } as SubagentRuntime,
      invalidate: () => { invalidated += 1 },
    })
    work.dispose()
    resolve([CONTINUABLE_CHILD])
    await settled()
    expect(invalidated).toBe(0)
  })

  it('renders running jobs as non-interruptible and never calls jobs.kill', () => {
    const seam = jobsSeam(() => [job()])
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => {} })
    const running = work.snapshot().jobs[0]
    expect(running?.interruptible).toBe(false)
    expect(work.interrupt(running ?? jobItem())).toEqual({
      kind: 'unsupported', message: 'Jobs cannot be stopped from Work.',
    })
    // `kill` marks a job reported for model delivery; the double throws if the
    // overlay ever gets a control that reaches it.
    expect(seam.forbidden()).toEqual([])
  })

  it('interrupts continuable children with exact user parent authority and leaves one-shots unstopped', () => {
    const calls: unknown[][] = []
    const subagents = {
      listDescendants: async () => [],
      interrupt: (...args: unknown[]) => { calls.push(args) },
    } as SubagentRuntime
    const work = new HarnessWork({ agent, subagents, invalidate: () => {} })
    expect(work.interrupt(subagentItem({ id: 'child', interruptible: true }))).toEqual(INTERRUPT_REQUESTED)
    // The authority is the exact parent SESSION, not a loose provider name.
    expect(calls).toEqual([['child', { kind: 'user', parentSessionId: ROOT }]])
    expect(work.interrupt(subagentItem({ id: 'one-shot', interruptible: false }))).toEqual({
      kind: 'unsupported', message: 'This subagent cannot be interrupted here.',
    })
    expect(calls).toHaveLength(1)
  })
})

describe('the Work status summary', () => {
  it('derives the summary solely from the snapshot arrays', () => {
    expect(workSummary(EMPTY)).toBeUndefined()
    expect(workSummary({ ...EMPTY, available: true })).toBeUndefined()
    const cases = [
      [0, 1, '1 job'],
      [0, 2, '2 jobs'],
      [1, 0, '1 subagent'],
      [2, 0, '2 subagents'],
      [1, 1, '1 subagent · 1 job'],
      [1, 2, '1 subagent · 2 jobs'],
      [2, 1, '2 subagents · 1 job'],
      [2, 2, '2 subagents · 2 jobs'],
    ] as const
    for (const [subagents, jobs, expected] of cases) {
      expect(workSummary({
        ...EMPTY,
        available: true,
        subagents: Array.from({ length: subagents }, (_, index) => subagentItem({ id: `subagent-${String(index)}`, runId: `subagent-${String(index)}` })),
        jobs: Array.from({ length: jobs }, (_, index) => jobItem({ id: `job-${String(index)}` })),
      })).toBe(expected)
    }
  })

  it('keys subagent rows by lifecycle run, not by the durable session id', () => {
    expect(workItemKey(subagentItem({ id: 'child', runId: 'epoch-1' }))).toBe('subagent:epoch-1')
    expect(workItemKey(subagentItem({ id: 'child', runId: 'epoch-2' }))).toBe('subagent:epoch-2')
    expect(workItemKey(jobItem({ id: 'bash-1' }))).toBe('job:bash-1')
  })
})

describe('the Work live-region overlay', () => {
  it('never exceeds its physical terminal height across narrow state and size matrices', () => {
    const states: readonly WorkSnapshot[] = [
      EMPTY,
      { ...EMPTY, available: true },
      { ...EMPTY, available: true, subagents: [subagentItem({
        provider: '提供者', label: 'a deliberately long label that must not leak a row', interruptible: false,
      })], jobs: [] },
    ]
    for (const snapshot of states) {
      for (const columns of [14, 18, 24, 30]) {
        for (const rows of [7, 8, 10, 12]) {
          const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
          const frame = overlay.render(columns, rows)
          expect(frame.flatMap(line => wrapToWidth(line, columns)).length, `${String(columns)}x${String(rows)}`)
            .toBeLessThanOrEqual(rows)
        }
      }
    }
  })

  it('never exceeds its physical terminal height with a detail stage open', () => {
    const snapshot: WorkSnapshot = {
      ...EMPTY,
      available: true,
      subagents: [subagentItem({ label: '审查 renderer', mode: 'continuable', residency: 'resident', hasChildren: true })],
      jobs: [jobItem({ detail: 'exit code: 3' })],
    }
    for (const columns of [24, 40, 80]) {
      for (const rows of [7, 9, 12, 24]) {
        const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
        overlay.handleKey({ kind: 'key', name: 'enter' })
        const frame = overlay.render(columns, rows)
        expect(frame.flatMap(line => wrapToWidth(line, columns)).length, `${String(columns)}x${String(rows)}`)
          .toBeLessThanOrEqual(rows)
      }
    }
  })

  it('renders generic provider names safely and accounts for wide labels', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      provider: '提供者', label: '审查\u001b[2J renderer', interruptible: false,
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    const lines = overlay.render(60, 12)
    const plain = lines.map(stripAnsi).join('\n')
    expect(plain).toContain('提供者')
    expect(plain).toContain('^[')
    expect(plain).not.toContain('\u001b[2J')
    expect(lines.every(line => displayWidth(line) <= 60)).toBe(true)
    // On a truly narrow terminal the durable label is the identity worth
    // keeping, so it is truncated rather than yielded — and because escaping
    // happens BEFORE any fitting, what a cut lands in the middle of is already
    // inert text, never half of a live control sequence.
    const narrow = overlay.render(24, 12)
    expect(narrow.map(stripAnsi).join('\n')).toContain('审查')
    expect(narrow.map(stripAnsi).join('\n')).not.toContain('\u001b[2J')
    expect(narrow.every(line => displayWidth(line) <= 24)).toBe(true)
  })

  it('sheds a subagent row task-last: the clock, then the route, then the operation', () => {
    // The Work 3.0 priority, proved by what survives rather than described:
    // the durable task label never yields, the semantic word outlives the
    // route, and the elapsed reading is the first thing a narrowing terminal
    // gives up — the opposite of the order that once put `spawn` first.
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      label: 'Fix OAuth flow', provider: 'spawn', activityWord: 'reading', activityTitle: 'route-editor.ts',
      route: { provider: 'openai-codex', model: 'gpt-x' }, interruptible: false,
      startedAt: Date.now() - 18_000,
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    const at = (columns: number): string => overlay.render(columns, 12).map(stripAnsi).join('\n')
    expect(at(80)).toContain('Fix OAuth flow · reading route-editor.ts · openai-codex/gpt-x 18s')
    // The clock goes first: it is the least useful answer to "what is this doing".
    expect(at(70)).toContain('Fix OAuth flow · reading route-editor.ts · openai-codex/gpt-x')
    expect(at(70)).not.toContain('18s')
    expect(at(60)).toContain('Fix OAuth flow · reading route-editor.ts')
    expect(at(60)).not.toContain('openai-codex')
    expect(at(40)).toContain('Fix OAuth flow · reading')
    expect(at(40)).not.toContain('route-editor.ts')
    // The task label alone, and never a fragment of the word beside it.
    expect(at(30)).toContain('Fix OAuth flow')
    expect(at(30)).not.toContain('· reading')
    expect(at(30)).not.toContain('readin')
    // The backend never took overview space away from any of that.
    for (const columns of [80, 70, 60, 40, 30]) expect(at(columns)).not.toContain('spawn')
  })

  it('pluralizes snapshot counts in the compact headline', () => {
    let snapshot: WorkSnapshot = EMPTY
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    const cases = [
      [0, 0, 'No active work · esc close'],
      [0, 1, '0 subagents · 1 job · esc close'],
      [0, 2, '0 subagents · 2 jobs · esc close'],
      [1, 0, '1 subagent · 0 jobs · esc close'],
      [2, 0, '2 subagents · 0 jobs · esc close'],
      [1, 1, '1 subagent · 1 job · esc close'],
      [1, 2, '1 subagent · 2 jobs · esc close'],
      [2, 1, '2 subagents · 1 job · esc close'],
      [2, 2, '2 subagents · 2 jobs · esc close'],
    ] as const
    for (const [subagents, jobs, expected] of cases) {
      snapshot = {
        ...EMPTY,
        available: true,
        subagents: Array.from({ length: subagents }, (_, index) => subagentItem({ id: `subagent-${String(index)}`, runId: `subagent-${String(index)}` })),
        jobs: Array.from({ length: jobs }, (_, index) => jobItem({ id: `job-${String(index)}` })),
      }
      expect(stripAnsi(overlay.render(80, 5)[0] ?? '')).toBe(expected)
    }
  })

  it('frames one listing row at the exact height boundary and falls back below it', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, jobs: [jobItem()] }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    const framed = overlay.render(80, 6).map(stripAnsi)
    expect(framed).toHaveLength(6)
    expect(framed[1]).toMatch(/^╭─ dshline/u)
    expect(framed.at(-1)).toMatch(/^╰─ .*─╯$/u)
    const compact = overlay.render(80, 5).map(stripAnsi)
    expect(compact[0]).toBe('0 subagents · 1 job · esc close')
    expect(compact.join('\n')).not.toContain('╭')
  })

  it('shows an interrupt hint only for the aimed interruptible item', () => {
    const oneShot = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [subagentItem({ interruptible: false })] }),
      interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {},
    })
    expect(oneShot.render(80, 12).map(stripAnsi).join('\n')).not.toContain('k interrupt')
    let jobInterrupts = 0
    const jobRow = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, jobs: [jobItem()] }),
      interrupt: () => { jobInterrupts += 1; return INTERRUPT_REQUESTED }, close: () => {}, invalidate: () => {},
    })
    expect(jobRow.render(80, 12).map(stripAnsi).join('\n')).not.toContain('k interrupt')
    jobRow.handleKey({ kind: 'text', text: 'k' })
    expect(jobInterrupts).toBe(0)
    const continuable = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [subagentItem()] }),
      interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {},
    })
    expect(continuable.render(80, 12).map(stripAnsi).join('\n')).toContain('k interrupt')
    // The seam is an interrupt of one turn, never a generic "stop" claim.
    expect(continuable.render(80, 12).map(stripAnsi).join('\n')).not.toContain('k stop')
  })

  it('hands the durable conversation catalog off only when the seam is mounted', () => {
    let opened = 0
    const withCatalog = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [subagentItem()] }),
      interrupt: () => INTERRUPT_REQUESTED,
      conversations: () => { opened += 1 },
      close: () => {},
      invalidate: () => {},
    })
    expect(withCatalog.render(80, 12).map(stripAnsi).join('\n')).toContain('c conversations')
    withCatalog.handleKey({ kind: 'text', text: 'c' })
    expect(opened).toBe(1)

    const without = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [subagentItem()] }),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    expect(without.render(80, 12).map(stripAnsi).join('\n')).not.toContain('c conversations')
    without.handleKey({ kind: 'text', text: 'c' })
    expect(opened).toBe(1)
  })

  it('opens a detail stage on Enter and returns with Esc and Esc close', () => {
    let closed = 0
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({ label: '审查 renderer', mode: 'continuable', hasChildren: true })], jobs: [] }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => { closed += 1 },
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(detail).toContain('Subagent · 审查 renderer')
    expect(detail).toContain('backend  codex')
    expect(detail).toContain('mode  continuable')
    expect(detail).toContain('local agent  yes')
    expect(detail).toContain('child sessions  yes')
    expect(detail).toContain('lineage  direct child of this session')
    expect(detail).toContain('interrupt  available')
    overlay.handleKey({ kind: 'key', name: 'escape' })
    const list = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(list).not.toContain('Subagent · 审查 renderer')
    expect(list).toContain('Subagents')
    expect(closed).toBe(0)
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(closed).toBe(1)
  })

  it('shows the deep live facts in the subagent detail stage', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      id: 'child-1', label: 'review', mode: 'continuable', activityWord: 'reading',
      activityTitle: 'overlay.ts', busy: true, agentStatus: 'running', residency: 'resident', hasChildren: true,
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 24).map(stripAnsi).join('\n')
    // The live activity leads the view as a headline, not as a diagnostic row.
    expect(detail).toContain('reading · overlay.ts')
    expect(detail).toContain('agent status  running')
    expect(detail).toContain('residency  live session')
    expect(detail).toContain('session  child-1')
  })

  it('shows a live output tail in the subagent detail stage only', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      id: 'child-1', label: 'review', outputTail: 'hello from the child',
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    // The overview list is unchanged: the tail belongs to the inspected subject.
    expect(overlay.render(80, 24).map(stripAnsi).join('\n')).not.toContain('hello from the child')
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(80, 24).map(stripAnsi).join('\n')).toContain('output  hello from the child')
  })

  it('renders no output row and no empty row when the tail is absent', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      id: 'child-1', label: 'review',
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const lines = overlay.render(80, 24).map(stripAnsi)
    expect(lines.join('\n')).not.toContain('output')
    // An absent tail must not leave the row's place behind as an empty line.
    expect(lines.some(line => /^\s*output\s*$/u.test(line))).toBe(false)
  })

  it('renders no output row for a layout-only tail', () => {
    // The producer stores whatever a `text-delta` carried, so a stream that has
    // only emitted line structure or spacing would otherwise advertise an answer
    // that is not visible yet.
    for (const value of ['   ', '\n', '\r\n', '\t']) {
      const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
        label: 'review', outputTail: value,
      })], jobs: [] }
      const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
      overlay.handleKey({ kind: 'key', name: 'enter' })
      const lines = overlay.render(80, 24).map(stripAnsi)
      expect(lines.join('\n'), JSON.stringify(value)).not.toContain('output')
      expect(lines.some(line => /^\s*output\s*$/u.test(line)), JSON.stringify(value)).toBe(false)
    }
  })

  it('keeps an escaped control visible rather than treating it as layout', () => {
    // A control character is not suppressed: `escapeControls` makes it visible,
    // so a tail carrying one is real content and keeps its row.
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      label: 'review', outputTail: '\u0001',
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(detail).toContain('output  ^A')
  })

  it('collapses CR and LF runs into one physical row before escaping', () => {
    for (const text of ['a\nb', 'a\r\nb', 'a\rb']) {
      const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
        label: 'review', outputTail: text,
      })], jobs: [] }
      const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
      overlay.handleKey({ kind: 'key', name: 'enter' })
      const lines = overlay.render(60, 24)
      // Both fragments survive on the ONE row, separated rather than wrapped.
      expect(lines.map(stripAnsi).join('\n')).toContain('a b')
      expect(lines.every(line => !line.includes('\n'))).toBe(true)
      expect(lines.flatMap(line => wrapToWidth(line, 60)).length).toBeLessThanOrEqual(24)
    }
  })

  it('renders an ANSI escape sequence in the tail as inert caret text', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      label: 'review', outputTail: '\u001b[31mred\u001b[0m',
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const raw = overlay.render(60, 24).join('\n')
    const visible = stripAnsi(raw)
    expect(visible).toContain('^[[31mred^[[0m')
    // The model's escape is neutralized, so the visible text carries no ESC byte.
    expect(visible).not.toContain('\u001b')
    expect(raw).toContain('^[[31mred^[[0m')
    expect(raw).not.toContain('\u001b[31mred')
  })

  it('cuts a wide-character tail to display columns rather than code units', () => {
    const columns = 30
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      label: '审查', outputTail: '你好世界'.repeat(30),
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const lines = overlay.render(columns, 24)
    expect(lines.every(line => displayWidth(line) <= columns)).toBe(true)
    const physical = lines.flatMap(line => wrapToWidth(line, columns))
    expect(physical.length).toBeLessThanOrEqual(24)
    expect(physical.every(row => displayWidth(row) <= columns)).toBe(true)
  })

  it('keeps the newest tail text when the row must cut from the front', () => {
    const outputTail = `OLDEST-${'x'.repeat(400)}-NEWEST`
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      label: 'review', outputTail,
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(40, 24).map(stripAnsi).join('\n')
    expect(detail).toContain('NEWEST')
    expect(detail).not.toContain('OLDEST')
  })

  it('keeps the bounded live tail inside the physical height across a size matrix', () => {
    const snapshot: WorkSnapshot = {
      ...EMPTY,
      available: true,
      subagents: [subagentItem({
        label: '审查 renderer', mode: 'continuable', residency: 'resident', hasChildren: true,
        outputTail: '新到的输出\u001b[31m tail\r\n' + 'x'.repeat(200),
      })],
      jobs: [jobItem()],
    }
    for (const columns of [14, 18, 24, 30, 40, 60, 80]) {
      for (const rows of [7, 8, 10, 12, 24]) {
        const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
        overlay.handleKey({ kind: 'key', name: 'enter' })
        const frame = overlay.render(columns, rows)
        expect(frame.flatMap(line => wrapToWidth(line, columns)).length, `${String(columns)}x${String(rows)}`)
          .toBeLessThanOrEqual(rows)
      }
    }
  })

  it('still renders the state headline and facts for an item that also has a live tail', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      id: 'child-1', label: 'review', activityWord: 'reading', activityTitle: 'overlay.ts',
      outputTail: 'streaming the newest text',
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(detail).toContain('reading · overlay.ts')
    expect(detail).toContain('backend  codex')
    expect(detail).toContain('output  streaming the newest text')
  })

  it('draws a live tail through a real terminal without leaking committed scrollback', async () => {
    const emulator = createEmulator(60, 12)
    const screen = new Screen(emulator.target)
    screen.commit(['committed transcript row'])
    const before = await emulator.scrollback()
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      label: '审查 renderer', outputTail: '新输出\u001b[31mred\r\n继续',
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    screen.setLive(overlay.render(60, 12))
    const visible = await emulator.screen()
    expect(visible.join('\n')).toContain('^[[31mred')
    expect(visible.join('\n')).not.toContain('\u001b')
    expect(screen.height).toBeLessThanOrEqual(12)
    const after = await emulator.scrollback()
    expect(after.filter(row => row.includes('committed transcript row')))
      .toEqual(before.filter(row => row.includes('committed transcript row')))
    emulator.dispose()
  })

  it('shows job facts without consuming output or inventing controls', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, jobs: [jobItem({ detail: 'exit code: 3' })], subagents: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 16).map(stripAnsi).join('\n')
    expect(detail).toContain('Job · pnpm test')
    expect(detail).toContain('kind  bash')
    expect(detail).toContain('job id  bash-1')
    expect(detail).toContain('status  running')
    expect(detail).toContain('detail  exit code: 3')
    expect(detail).toContain('owner  this session')
    // Announcing the absence of an action is noise; a control appears only when
    // it genuinely exists.
    expect(detail).not.toContain('interrupt')
    expect(detail).not.toContain('k interrupt')
  })

  it('never renders a missing Job label as the literal "undefined"', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, jobs: [jobItem({ id: 'j1', label: '' })], subagents: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    const rows = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(rows).not.toContain('undefined')
    expect(rows).toContain('bash')
  })

  it('keeps a detail stage on its own subject while its arrows move the fact cursor', () => {
    const snapshot: WorkSnapshot = {
      ...EMPTY,
      available: true,
      subagents: [subagentItem({ id: 'a', runId: 'a' }), subagentItem({ id: 'b', runId: 'b' })],
      jobs: [],
    }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.handleKey({ kind: 'key', name: 'down' })
    const detail = overlay.render(80, 24).map(stripAnsi)
    // The arrows moved the cursor INSIDE this stage; they did not switch subject.
    expect(detail.join('\n')).toContain('session  a')
    expect(detail.join('\n')).not.toContain('session  b')
    expect(detail.filter(row => row.includes('❯'))).toHaveLength(1)
  })

  it('escapes control sequences in detail values and keeps every row in the frame', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      provider: '提供者', label: '审查\u001b[2J renderer', mode: 'continuable',
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const lines = overlay.render(60, 10)
    const plain = lines.map(stripAnsi).join('\n')
    expect(plain).toContain('^[')
    expect(plain).not.toContain('\u001b[2J')
    expect(lines.every(line => displayWidth(line) <= 60)).toBe(true)
  })

  it('keeps the inspected row fixed when a sibling above it settles', () => {
    let snapshot: WorkSnapshot = trio()
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'down' }) // B
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(80, 24).map(stripAnsi).join('\n')).toContain('session  b')
    // A settles; the detail must remain B, never silently switch to C.
    snapshot = { ...EMPTY, available: true, subagents: snapshot.subagents.slice(1), jobs: [] }
    const after = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(after).toContain('session  b')
    expect(after).not.toContain('session  c')
  })

  it('interrupts B, never C, when A disappears before a repaint', () => {
    let snapshot: WorkSnapshot = trio()
    const interrupted: string[] = []
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED },
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'down' }) // B
    overlay.handleKey({ kind: 'key', name: 'enter' })
    snapshot = { ...EMPTY, available: true, subagents: [snapshot.subagents[1]!, snapshot.subagents[2]!], jobs: [] }
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual(['b'])
    expect(interrupted).not.toContain('c')
  })

  it('refuses to interrupt anyone when the aimed row itself disappears', () => {
    let snapshot: WorkSnapshot = trio()
    const interrupted: string[] = []
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED },
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'down' }) // B
    overlay.handleKey({ kind: 'key', name: 'enter' })
    // B settles while the user still aims at it: k before a repaint must act on
    // NOBODY, because the item that inherited B's screen position is not the aim.
    snapshot = { ...EMPTY, available: true, subagents: [snapshot.subagents[0]!, snapshot.subagents[2]!], jobs: [] }
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual([])
    // The next paint re-anchors the selection onto the neighbor deliberately;
    // a fresh k against the now-visible selection targets that neighbor.
    overlay.render(80, 12)
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual(['c'])
  })

  it('interrupts the aimed row in the plain list, not its successor', () => {
    let snapshot: WorkSnapshot = trio()
    const interrupted: string[] = []
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED },
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'down' }) // B
    snapshot = { ...EMPTY, available: true, subagents: snapshot.subagents.slice(1), jobs: [] }
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual(['b'])
  })

  it('never carries an interrupt across a cold-resumed epoch of the same child', () => {
    let items: SubagentWorkItem[] = [
      subagentItem({ id: 'child', runId: 'epoch-1', label: 'review', mode: 'continuable' }),
    ]
    const interrupted: string[] = []
    const overlay = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: items, jobs: [] }),
      interrupt: item => { interrupted.push(item.runId); return INTERRUPT_REQUESTED },
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' }) // detail on epoch-1
    // The child cold-resumes: epoch-2 opens under the same durable session id.
    items = [subagentItem({ id: 'child', runId: 'epoch-2', label: 'review', mode: 'continuable' })]
    overlay.render(80, 12) // detail on epoch-1 exits; the list re-aims on epoch-2
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual(['epoch-2'])
  })

  it('shares one spinner phase across animated rows and leaves idle rows static', () => {
    vi.useFakeTimers()
    const snapshot: WorkSnapshot = {
      ...EMPTY,
      available: true,
      subagents: [
        subagentItem({ id: 'busy-a', runId: 'busy-a', provider: 'codex', label: 'one', busy: true }),
        subagentItem({ id: 'busy-b', runId: 'busy-b', provider: 'spawn', label: 'two', busy: true }),
        subagentItem({ id: 'idle', runId: 'idle', provider: 'codex', label: 'three' }),
      ],
      jobs: [jobItem({ id: 'j1' })],
    }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.mounted?.()
    const first = overlay.render(80, 14).map(stripAnsi).join('\n')
    expect(first).toContain('◜')
    // Exactly the two children Harness says are executing, and nothing else:
    // the idle child and the background Job are lifecycle facts, not evidence.
    expect(first.match(/◜/gu)?.length).toBe(2)
    // A child with no observable activity still names the backend that owns
    // its lifecycle, after its own label: that is the fact explaining why
    // there is nothing else to show.
    expect(first).toContain('● three · codex')
    expect(first).toContain('• bash pnpm test')
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS)
    const second = overlay.render(80, 14).map(stripAnsi).join('\n')
    expect(second).toContain('◠')
    expect(second).not.toContain('◜')
    expect(second).toContain('● three · codex')
    expect(second).toContain('• bash pnpm test')
    overlay.dispose?.()
    vi.useRealTimers()
  })

  it('never animates a background Job, and keeps a stopping one distinct', () => {
    vi.useFakeTimers()
    const snapshot: WorkSnapshot = {
      ...EMPTY,
      available: true,
      jobs: [
        jobItem({ id: 'running' }),
        jobItem({ id: 'stopping', state: 'stopping' }),
      ],
      subagents: [],
    }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.mounted?.()
    const first = overlay.render(80, 12).map(stripAnsi).join('\n')
    // A Job in `running` is a registry record, not an observation of computation.
    expect(first).not.toContain('◜')
    expect(first).toContain('•') // the running Job keeps the quiet record mark
    expect(first).toContain('◐') // the stopping Job keeps its own transition mark
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS)
    const second = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(second).not.toContain('◠')
    expect(second).toContain('•')
    expect(second).toContain('◐')
    overlay.dispose?.()
    vi.useRealTimers()
  })

  it('exits cleanly when the inspected row disappears instead of showing stale authority', () => {
    let snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({ id: 'child' })], jobs: [] }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(80, 24).map(stripAnsi).join('\n')).toContain('session  child')
    snapshot = { ...EMPTY, available: true, subagents: [], jobs: [] }
    const after = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(after).not.toContain('session  child')
    expect(after).toContain('No active workflows, jobs, or subagents.')
  })

  it('sends ctrl-c in the detail stage back to the list, matching the child-panel convention', () => {
    let closed = 0
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem()], jobs: [] }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => { closed += 1 },
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.handleKey({ kind: 'key', name: 'ctrl-c' })
    expect(overlay.render(80, 12).map(stripAnsi).join('\n')).toContain('Subagents')
    expect(closed).toBe(0)
  })

  it('shows a failed interrupt result temporarily instead of swallowing it', () => {
    const overlay = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [subagentItem()] }),
      interrupt: () => ({ kind: 'failed', message: 'Interrupt failed: not authorized' }),
      close: () => {}, invalidate: () => {},
    })
    overlay.render(80, 12)
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(overlay.render(80, 12).map(stripAnsi).join('\n')).toContain('Interrupt failed: not authorized')
    // A failed action must not disappear merely because the full frame cannot
    // reserve both a notice row and a list row on the smallest usable terminal.
    expect(overlay.render(14, 5).map(stripAnsi).join('\n')).toContain('Interrupt fail')
  })

  it('ticks only while mounted, so elapsed and the spinner update while the parent is idle', () => {
    vi.useFakeTimers()
    let invalidated = 0
    const overlay = createWorkOverlay({ snapshot: () => ({ ...EMPTY, available: true, jobs: [jobItem()] }), interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => { invalidated += 1 } })
    overlay.mounted?.()
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS)
    expect(invalidated).toBe(1)
    overlay.dispose?.()
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS)
    expect(invalidated).toBe(1)
    vi.useRealTimers()
  })

  it("leaves ctrl-d for the runner's global quit handler", () => {
    let closed = 0
    const overlay = createWorkOverlay({ snapshot: () => EMPTY, interrupt: () => INTERRUPT_REQUESTED, close: () => { closed += 1 }, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'ctrl-d' })
    expect(closed).toBe(0)
  })

  it('closes cleanly without changing committed scrollback', async () => {
    const emulator = createEmulator(60, 12)
    const screen = new Screen(emulator.target)
    screen.commit(['committed transcript row'])
    const before = await emulator.scrollback()
    let overlay!: ReturnType<typeof createWorkOverlay>
    const draw = (): void => { screen.setLive(overlay.render(60, 12)) }
    overlay = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true }),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => { screen.setLive(['composer', 'status']) },
      invalidate: draw,
    })
    draw()
    overlay.handleKey({ kind: 'key', name: 'escape' })
    const after = await emulator.scrollback()
    expect(after.filter(row => row.includes('committed transcript row'))).toEqual(before.filter(row => row.includes('committed transcript row')))
    expect(after.join('\n')).not.toContain('Work')
  })

  it('keeps the Codex provider out of every published TUI runtime surface', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const runtimeFiles = [
      ...publishedFiles(`${root}src`),
      ...publishedFiles(`${root}bin`),
      `${root}cordis.patch.yml`,
    ].map(path => readFileSync(path, 'utf8'))
    // The publishable manifest itself must stay provider-neutral: runtime,
    // optional, peer, bundle, and future published fields are all covered by
    // reading the complete document rather than maintaining an allowlist.
    const manifest = readFileSync(`${root}package.json`, 'utf8')
    expect([...runtimeFiles, manifest].join('\n')).not.toContain('@deepseek-ai/dsh-subagent-codex')
  })
})

describe('how much work is attached to a session', () => {
  it('counts both capabilities without merging them', () => {
    // The sum answers one question — is anything still running under this agent —
    // which a lifecycle decision such as retiring it needs, and which needs no
    // correlation between a job and a subagent to be true.
    expect(activeWorkCount(EMPTY)).toBe(0)
    expect(activeWorkCount({
      ...EMPTY,
      available: true,
      subagents: [subagentItem({ id: 'a', runId: 'a' })],
      jobs: [jobItem({ id: 'j1' }), jobItem({ id: 'j2' })],
    })).toBe(3)
  })
})

/** Find every source file shipped in one production runtime directory. */
function publishedFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? publishedFiles(path) : [path]
  })
}
