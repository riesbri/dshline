/**
 * Tests for the optional generic Harness Work projection and live overlay.
 *
 * The doubles below stand in for two Harness services, and each is written
 * against the adopted generation's own vocabulary: `JobView` (with `owner` and
 * the ring's coordinates, and no `reported`), the filtered `events` stream, and
 * `listDescendants` rows discriminated on `kind` and `depth`. Where such a
 * double is asserted, it is asserted as `never` at the single boundary where it
 * becomes the service: `JobRegistry` and `SubagentRuntime` both descend from
 * cordis' `Service`, whose protected members make a class type comparable only
 * to itself and its own subclasses, so no partial object can satisfy one no
 * matter how its shape is fixed. Every member a double DOES implement is typed
 * against the real contract, and the service-typed field it lands in is what
 * checks the rest.
 * @module dshline/tests/work
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  JobId,
  type JobChannel,
  type JobChunk,
  type JobEvent,
  type JobEventFilter,
  type JobEventListener,
  type JobOutputRead,
  type JobRead,
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
 * Standard successful Job stop response.
 *
 * "Requested", never "stopped": the registry only moves a Job to `stopping` and
 * settlement is what ends it, so a claim that it stopped would be a lie about a
 * producer nobody has watched die.
 */
const STOP_REQUESTED: WorkInterruptResult = { kind: 'requested', message: 'Stop requested.' }

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
  /**
   * Every consuming `read` call, with the offset it resumed from.
   *
   * Recorded SEPARATELY from `readAts` on purpose: the whole point of the
   * observation design is that one of these is empty no matter how much the
   * other is used, and a single combined counter could not say that.
   */
  readonly reads: () => readonly { readonly id: string; readonly from: number }[]
  /** Every `readAt` call, in order, with the offset it resumed from. */
  readonly readAts: () => readonly { readonly id: string; readonly from: number; readonly caller?: SessionId }[]
  /** Every `kill` call, with the exact three arguments the contract declares. */
  readonly kills: () => readonly { readonly id: string; readonly caller?: SessionId; readonly reason?: string }[]
  /** Append producer text to the ring at an absolute offset, as a producer would. */
  readonly append: (text: string, options?: { channel?: JobChannel; gapBefore?: true }) => void
  /** Publish a progress line, as a producer would. */
  readonly progress: (line: string) => void
  /** Move the ring's retained window forward, as harness-side retention would. */
  readonly evictHead: (bytes: number) => void
  /**
   * Consume the ring the way the MODEL does, from the registry's own cursor.
   *
   * This is the strong half of the non-consuming proof: it is the member dshline
   * must never call, so it lives on the double rather than on dshline's code, and
   * a test can therefore show that watching `/work` first leaves the model's
   * first read receiving exactly the bytes it would have received anyway.
   */
  readonly modelRead: (id?: string) => JobRead
  /** Deliver one event to every registered listener, as the registry would. */
  readonly emit: (event: JobEvent) => void
  /** How many listeners are still registered. */
  readonly live: () => number
}

/**
 * Build a jobs double serving `views`, recording what Work asked of it.
 *
 * The three members divide exactly as the real contract does, and the division
 * is the point of this double:
 *
 * ```text
 * read()    consuming — the MODEL's cursor, and the terminal result. Refused.
 * readAt()  non-consuming observation. Supported, and the ring is real.
 * kill()    explicit human control. Supported, and the arguments are recorded.
 * ```
 *
 * The ring is faithful where faithfulness is hard: chunks carry real absolute
 * UTF-8 byte offsets, and `readAt` returns a WHOLE chunk even when the requested
 * offset falls inside it, so its `at` can precede `from`. A double that returned
 * only the unseen suffix would let a `tail += chunk.text` implementation pass.
 *
 * Everything upstream deleted simply has no slot here, and `wait`/`remove` stay
 * refused: both belong to a caller that collects a Job's terminal state itself.
 * @param views - what `list()` answers on every read.
 * @returns the double and everything it recorded.
 */
function jobsSeam(views: () => JobView[]): JobsSeam {
  const filters: JobEventFilter[] = []
  const listeners: JobEventListener[] = []
  const listCallers: unknown[] = []
  const forbidden: string[] = []
  const reads: { id: string; from: number }[] = []
  const readAts: { id: string; from: number; caller?: SessionId }[] = []
  const kills: { id: string; caller?: SessionId; reason?: string }[] = []
  /** Retained chunks in offset order, the ring without its retention cap. */
  let ring: JobChunk[] = []
  let retained = 0
  let earliest = 0
  let total = 0
  /** The model's own consuming cursor, which observation must never move. */
  let modelCursor = 0
  let published: JobView = job()
  const refuse = (member: string): never => {
    forbidden.push(member)
    throw new Error(`HarnessWork must never call ${member}()`)
  }
  /** Retained chunks overlapping `[from, total)`, whole, as the seam does. */
  const overlapping = (from: number): JobChunk[] => ring.filter(chunk => {
    return chunk.at + Buffer.byteLength(chunk.text, 'utf8') > from
  })
  const rebase = (): void => {
    published = { ...published, output: { total, earliest } }
  }
  return {
    jobs: {
      list: (caller?: SessionId): JobView[] => {
        listCallers.push(caller)
        return views()
      },
      events: {
        subscribe: (filter: JobEventFilter, listener: JobEventListener): (() => void) => {
          filters.push(filter)
          listeners.push(listener)
          return () => {
            filters.splice(filters.indexOf(filter), 1)
            listeners.splice(listeners.indexOf(listener), 1)
          }
        },
      },
      get: (id?: JobId): JobView => {
        if (id !== undefined && String(id) !== 'bash-1') throw new Error(`unknown job ${String(id)}`)
        return published
      },
      read: (id?: JobId, _caller?: SessionId): JobRead => {
        const key = String(id ?? 'bash-1')
        const from = modelCursor
        reads.push({ id: key, from })
        const chunks = overlapping(from)
        modelCursor = total
        return { chunks, lossy: from < earliest, job: { ...published, output: { total, earliest } } }
      },
      readAt: (id?: JobId, from = 0, caller?: SessionId): JobOutputRead => {
        const key = String(id ?? 'bash-1')
        readAts.push({ id: key, from, ...caller === undefined ? {} : { caller } })
        return { chunks: overlapping(from), next: total, lossy: from < earliest }
      },
      kill: (id?: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished' => {
        const key = String(id ?? 'bash-1')
        kills.push({ id: key, ...caller === undefined ? {} : { caller }, ...reason === undefined ? {} : { reason } })
        if (published.status !== 'running') return 'already-finished'
        published = { ...published, status: 'stopping' }
        return 'requested'
      },
      wait: (): Promise<JobView> => refuse('wait'),
      remove: (): void => refuse('remove'),
    } as never,
    filters: () => filters,
    listCallers: () => listCallers,
    forbidden: () => forbidden,
    reads: () => reads,
    readAts: () => readAts,
    kills: () => kills,
    append: (text, options) => {
      if (text.length === 0) return
      const bytes = Buffer.byteLength(text, 'utf8')
      ring.push({
        at: total,
        text,
        ...options?.channel === undefined ? {} : { channel: options.channel },
        ...options?.gapBefore === undefined ? {} : { gapBefore: options.gapBefore },
      })
      total += bytes
      retained += bytes
      rebase()
    },
    progress: line => {
      published = { ...published, progress: line }
    },
    evictHead: bytes => {
      while (retained > bytes && ring.length > 1) {
        const dropped = ring.shift()
        /* v8 ignore next -- the length guard proves shift() returned a chunk. */
        if (dropped === undefined) break
        retained -= Buffer.byteLength(dropped.text, 'utf8')
      }
      // A single oversized chunk keeps only its UTF-8-safe tail, advanced to
      // match — the ring's own rule, and the reason offsets never move once
      // assigned.
      if (ring.length === 1) {
        const only = ring[0]
        if (only !== undefined && Buffer.byteLength(only.text, 'utf8') > bytes) {
          const raw = Buffer.from(only.text, 'utf8')
          let start = raw.length - bytes
          while (start < raw.length && ((raw[start] as number) & 0xC0) === 0x80) start += 1
          const tail = raw.subarray(start)
          only.text = tail.toString('utf8')
          only.at += raw.length - tail.length
          retained = tail.length
          only.gapBefore = true
        }
      }
      earliest = ring[0]?.at ?? total
      rebase()
    },
    modelRead: (id = 'bash-1') => (jobs as unknown as { read: (i: JobId) => JobRead }).read(JobId(id)),
    emit: event => { for (const listener of [...listeners]) listener(event) },
    live: () => listeners.length,
  }
}

/** A Job Work row for overlay- and summary-focused tests. */
function jobItem(overrides: Partial<JobWorkItem> = {}): JobWorkItem {
  return {
    id: 'bash-1', source: 'job', kind: 'bash', label: 'pnpm test',
    state: 'running', startedAt: Date.now(), ownership: 'this-session', ...overrides,
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

  it('boots with jobs only and never consumes a job output cursor', () => {
    const seam = jobsSeam(() => [job()])
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => {} })
    const running = work.snapshot().jobs[0]
    expect(running).toMatchObject({
      source: 'job', kind: 'bash', label: 'pnpm test', state: 'running', ownership: 'this-session',
    })
    // Building the roster touches no output member at all: the overview is a
    // `list()` surface, and observation only exists once a detail is open.
    expect(seam.readAts()).toEqual([])
    expect(seam.reads()).toEqual([])
    // `read` is still refused outright, so an accidental swap fails loudly.
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
    // A registration adds a row, a progress line re-states one, a stop and a
    // settlement change what `list()` filters to, and a removal empties it.
    for (const type of ['registered', 'progress', 'stopping', 'removed'] as const) {
      const before = invalidated
      seam.emit(rowEvent(type))
      expect(invalidated, type).toBe(before + 1)
    }
    const afterRows = invalidated
    seam.emit(settledEvent())
    expect(invalidated).toBe(afterRows + 1)
    // A ring append is the one event that is not a row change, and it lands once
    // per chunk. It must also never become an output READ on its own: a noisy
    // producer whose detail is closed repaints nothing and costs no `readAt`.
    const afterSettle = invalidated
    seam.emit(outputEvent())
    expect(invalidated).toBe(afterSettle)
    expect(seam.readAts()).toEqual([])
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
    } as never
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
      subagents: { listDescendants: async () => [] } as never,
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
      subagents: { listDescendants: async () => [INACTIVE_CHILD] } as never,
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
      subagents: { listDescendants: async () => [INACTIVE_CHILD] } as never,
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
      subagents: { listDescendants: async () => { throw new Error('projection unavailable') } } as never,
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
      subagents: { listDescendants: async () => [{ ...CONTINUABLE_CHILD, mode: 'one-shot' as const }] } as never,
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
      subagents: { listDescendants: async () => [CONTINUABLE_CHILD, GRANDCHILD] } as never,
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
      subagents: { listDescendants: async () => [CORRUPT_CHILD] } as never,
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
    const refused = row === undefined ? work.interruptSubagent(subagentItem({ id: 'broken', interruptible: false })) : work.interruptSubagent(row)
    expect(refused).toEqual({ kind: 'unsupported', message: 'This subagent cannot be interrupted here.' })
    work.dispose()
  })

  it('does not let a disposed pending discovery mutate the projection', async () => {
    let resolve!: (entries: readonly SubagentDescendantListEntry[]) => void
    const pending = new Promise<readonly SubagentDescendantListEntry[]>(done => { resolve = done })
    let invalidated = 0
    const work = new HarnessWork({
      agent,
      subagents: { listDescendants: () => pending } as never,
      invalidate: () => { invalidated += 1 },
    })
    work.dispose()
    resolve([CONTINUABLE_CHILD])
    await settled()
    expect(invalidated).toBe(0)
  })

  it('stops a running job through the generic registry call and nothing else', () => {
    const seam = jobsSeam(() => [job()])
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => {} })
    const running = work.snapshot().jobs[0]
    expect(running).toBeDefined()
    expect(work.stopJob(running!)).toEqual({ kind: 'requested', message: 'Stop requested.' })
    // The three arguments are the whole contract: the exact id, the attached
    // session as the fenced caller, and upstream's own human-stop reason string.
    // dshline adds no delivery claim of its own, so the owning agent's ordinary
    // completion notice stays due — which is why this is safe for a human to do
    // and why the reason is worth passing verbatim.
    expect(seam.kills()).toEqual([{ id: 'bash-1', caller: ROOT, reason: 'cancelled by the user' }])
    // A subagent interrupt is a different operation and must never be reachable
    // through the Job seam.
    expect(seam.forbidden()).toEqual([])
    work.dispose()
  })

  it('refuses a second stop for a job that is already stopping', () => {
    const seam = jobsSeam(() => [job('stopping')])
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => {} })
    const stopping = work.snapshot().jobs[0]
    expect(stopping?.state).toBe('stopping')
    expect(work.stopJob(stopping!)).toEqual({
      kind: 'unsupported', message: 'This job is already stopping.',
    })
    expect(seam.kills()).toEqual([])
    work.dispose()
  })

  it('reports a settled-job race as a race rather than a failure or a history', () => {
    // The Job settled between the row being drawn and the press landing. The
    // registry says `already-finished`, the active filter has already dropped the
    // row, and the sentence must not claim a stop happened or imply the row is
    // kept around to be explained.
    const seam = jobsSeam(() => [job('completed')])
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => {} })
    expect(work.snapshot().jobs).toEqual([])
    expect(seam.forbidden()).toEqual([])
    work.dispose()
  })

  it('surfaces a producer cancel failure and leaves the row exactly as it was', () => {
    // The registry deliberately propagates a throwing `cancel()` and leaves Job
    // state unchanged, so a local `stopping` would be a lie. There is nothing to
    // report from the double here beyond the call itself, which is the point:
    // dshline's own failure path is proven against the overlay in the
    // "Stop failed" test below.
    const seam = jobsSeam(() => [job()])
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => {} })
    const running = work.snapshot().jobs[0]
    work.stopJob(running!)
    expect(work.snapshot().jobs[0]?.state).toBe('running')
    work.dispose()
  })

  it('interrupts continuable children with exact user parent authority and leaves one-shots unstopped', () => {
    const calls: unknown[][] = []
    const subagents = {
      listDescendants: async () => [],
      interrupt: (...args: unknown[]) => { calls.push(args) },
    } as never
    const work = new HarnessWork({ agent, subagents, invalidate: () => {} })
    expect(work.interruptSubagent(subagentItem({ id: 'child', interruptible: true }))).toEqual(INTERRUPT_REQUESTED)
    // The authority is the exact parent SESSION, not a loose provider name.
    expect(calls).toEqual([['child', { kind: 'user', parentSessionId: ROOT }]])
    expect(work.interruptSubagent(subagentItem({ id: 'one-shot', interruptible: false }))).toEqual({
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
          const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
        const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
      interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED,
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
      interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED,
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
      interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {},
    })
    expect(oneShot.render(80, 12).map(stripAnsi).join('\n')).not.toContain('k interrupt')
    let jobInterrupts = 0
    const jobRow = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, jobs: [jobItem()] }),
      interruptSubagent: () => { jobInterrupts += 1; return INTERRUPT_REQUESTED },
      stopJob: () => { jobInterrupts += 1; return STOP_REQUESTED }, close: () => {}, invalidate: () => {},
    })
    expect(jobRow.render(80, 12).map(stripAnsi).join('\n')).not.toContain('k interrupt')
    jobRow.handleKey({ kind: 'text', text: 'k' })
    expect(jobInterrupts).toBe(0)
    const continuable = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [subagentItem()] }),
      interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {},
    })
    expect(continuable.render(80, 12).map(stripAnsi).join('\n')).toContain('k interrupt')
    // The seam is an interrupt of one turn, never a generic "stop" claim.
    expect(continuable.render(80, 12).map(stripAnsi).join('\n')).not.toContain('k stop')
  })

  it('hands the durable conversation catalog off only when the seam is mounted', () => {
    let opened = 0
    const withCatalog = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [subagentItem()] }),
      interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED,
      conversations: () => { opened += 1 },
      close: () => {},
      invalidate: () => {},
    })
    expect(withCatalog.render(80, 12).map(stripAnsi).join('\n')).toContain('c conversations')
    withCatalog.handleKey({ kind: 'text', text: 'c' })
    expect(opened).toBe(1)

    const without = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, available: true, subagents: [subagentItem()] }),
      interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED,
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
      interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED,
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
    // The overview list is unchanged: the tail belongs to the inspected subject.
    expect(overlay.render(80, 24).map(stripAnsi).join('\n')).not.toContain('hello from the child')
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(80, 24).map(stripAnsi).join('\n')).toContain('output  hello from the child')
  })

  it('renders no output row and no empty row when the tail is absent', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
      id: 'child-1', label: 'review',
    })], jobs: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
      const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(detail).toContain('output  ^A')
  })

  it('collapses CR and LF runs into one physical row before escaping', () => {
    for (const text of ['a\nb', 'a\r\nb', 'a\rb']) {
      const snapshot: WorkSnapshot = { ...EMPTY, available: true, subagents: [subagentItem({
        label: 'review', outputTail: text,
      })], jobs: [] }
      const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
        const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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

  it('draws a job’s retained output through a real terminal without leaking scrollback', async () => {
    // The strongest statement the overlay can make about a job's output: it is
    // drawn as ordinary bounded live-region rows in a real terminal, its control
    // characters are DISPLAYED rather than obeyed, and not one byte of it reaches
    // the committed history behind the overlay.
    const emulator = createEmulator(60, 24)
    const screen = new Screen(emulator.target)
    screen.commit(['committed transcript row'])
    const before = await emulator.scrollback()
    const seam = jobsSeam(() => [job()])
    seam.append('第一行[31m红色\n')
    seam.append('[2Ksecond line\n')
    const work = new HarnessWork({ agent, jobs: seam.jobs, invalidate: () => {} })
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => INTERRUPT_REQUESTED,
      stopJob: () => STOP_REQUESTED,
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(60, 24)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    screen.setLive(overlay.render(60, 24))
    const visible = await emulator.screen()
    // Wide glyphs and controls are on screen as text, and the erase sequence was
    // not executed — a real terminal would have blanked the frame if it were.
    expect(visible.join('\n')).toContain('第一行')
    expect(visible.join('\n')).toContain('^[[31m红色')
    expect(visible.join('\n')).toContain('^[[2Ksecond line')
    expect(visible.join('\n')).not.toContain('')
    expect(screen.height).toBeLessThanOrEqual(24)
    // The overlay covered the frame and committed nothing.
    const after = await emulator.scrollback()
    expect(after.filter(row => row.includes('committed transcript row')))
      .toEqual(before.filter(row => row.includes('committed transcript row')))
    expect(after.filter(row => row.includes('committed transcript row'))).toHaveLength(1)
    // `scrollback()` reads the ACTIVE buffer, which includes the viewport, so the
    // live rows are legitimately in it. What must not have happened is a commit:
    // the transcript row the overlay covered is still exactly one row, in place.
    emulator.dispose()
    work.dispose()
  })

  it('shows job facts without consuming output or inventing controls', () => {
    const snapshot: WorkSnapshot = { ...EMPTY, available: true, jobs: [jobItem({ detail: 'exit code: 3' })], subagents: [] }
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
      interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED,
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
      interruptSubagent: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED },
      stopJob: () => { throw new Error('a subagent test must never stop a job') },
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
      interruptSubagent: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED },
      stopJob: () => { throw new Error('a subagent test must never stop a job') },
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
      interruptSubagent: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED },
      stopJob: () => { throw new Error('a subagent test must never stop a job') },
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
      interruptSubagent: item => { interrupted.push(item.runId); return INTERRUPT_REQUESTED },
      stopJob: () => { throw new Error('a subagent test must never stop a job') },
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
    const overlay = createWorkOverlay({ snapshot: () => snapshot, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => {} })
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
      interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED,
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
      interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED,
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
      interruptSubagent: () => ({ kind: 'failed', message: 'Interrupt failed: not authorized' }),
      stopJob: () => STOP_REQUESTED,
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
    const overlay = createWorkOverlay({ snapshot: () => ({ ...EMPTY, available: true, jobs: [jobItem()] }), interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => {}, invalidate: () => { invalidated += 1 } })
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
    const overlay = createWorkOverlay({ snapshot: () => EMPTY, interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED, close: () => { closed += 1 }, invalidate: () => {} })
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
      interruptSubagent: () => INTERRUPT_REQUESTED, stopJob: () => STOP_REQUESTED,
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
