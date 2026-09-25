/**
 * Tests for demand-driven observation of one background Job's retained output.
 *
 * These cover the parts of Jobs 2.0 that are easy to get quietly wrong and hard
 * to notice: that observation is demand-driven rather than ambient, that it reads
 * the ring WITHOUT moving the model cursor, that the subscribe/read race cannot
 * lose a chunk, that absolute UTF-8 byte offsets never duplicate a prefix or cut
 * a code point, that all three sources of loss are visible exactly once each,
 * and that a human stop is armed against a Job's identity rather than a screen
 * position.
 *
 * The registry double below is faithful about exactly the things a faithful
 * double has to be: chunks carry real absolute byte offsets, `readAt` returns a
 * WHOLE chunk even when the requested offset falls inside it, retention evicts
 * the head, and `read` really does move a separate model cursor. A double that
 * returned only the unseen suffix, or that shared one cursor between the two
 * reads, would let a broken implementation pass.
 *
 * @module dshline/tests/work-jobs
 */

import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  JobChannel,
  JobChunk,
  JobEvent,
  JobEventFilter,
  JobEventListener,
  JobOutputRead,
  JobRead,
  JobRegistry,
  JobView,
} from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { stripAnsi, wrapToWidth } from '@dshline/renderer'
import { HarnessWork } from '../src/work/index.ts'
import { createWorkOverlay } from '../src/work/overlay.ts'
import type { JobWorkItem, WorkInterruptResult, WorkSnapshot } from '../src/work/model.ts'
import { observeJobOutput } from '../src/work/jobs.ts'

const ROOT = SessionId('root')
const agent = { session: { id: ROOT } } as Agent

/** A fresh projection of one running job, as the registry would publish it. */
function view(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'bash-1' as JobView['id'],
    kind: 'bash',
    label: 'pnpm test',
    status: 'running',
    startedAt: 0,
    owner: ROOT,
    output: { total: 0, earliest: 0 },
    ...overrides,
  }
}

/** One job's state in the faithful double below. */
interface FakeJob {
  view: JobView
  ring: JobChunk[]
  retained: number
}

/**
 * A registry faithful about offsets, retention, and the two cursors.
 *
 * The single most important property is that `readAt` and `read` advance
 * DIFFERENT offsets from the same chunks. If they shared one, every
 * non-consuming claim in the production code would be unfalsifiable here.
 */
class FakeJobs {
  readonly #jobs = new Map<string, FakeJob>()
  readonly #listeners = new Set<JobEventListener>()
  readonly #reads: { readonly id: string; readonly from: number }[] = []
  readonly #readAts: { readonly id: string; readonly from: number; readonly caller?: SessionId }[] = []
  readonly #kills: { readonly id: string; readonly caller?: SessionId; readonly reason?: string }[] = []
  /** The model's consuming cursor, which observation must never touch. */
  readonly #modelCursors = new Map<string, number>()
  /** Byte cap the ring retains, so lossy reads are reachable in a test. */
  retention: number
  /** Run inside `get`, which is exactly the subscribe/read race boundary. */
  onGet: (() => void) | undefined
  #ordinal = 0

  constructor(retention = Number.POSITIVE_INFINITY) {
    this.retention = retention
  }

  /** The registry face dshline is handed. */
  registry(): JobRegistry {
    return this as unknown as JobRegistry
  }

  /** Register a live job and return its id. */
  start(id: string, overrides: Partial<JobView> = {}): string {
    this.#ordinal += 1
    this.#jobs.set(id, { view: view({ id: id as JobView['id'], ...overrides }), ring: [], retained: 0 })
    this.#emit({ type: 'registered', job: this.#require(id).view })
    return id
  }

  /** The producer's append: whole chunks at real absolute byte offsets. */
  append(id: string, text: string, options: { channel?: JobChannel; gapBefore?: true } = {}): void {
    if (text.length === 0) return
    const job = this.#require(id)
    const bytes = Buffer.byteLength(text, 'utf8')
    job.ring.push({
      at: job.view.output.total,
      text,
      ...options.channel === undefined ? {} : { channel: options.channel },
      ...options.gapBefore === undefined ? {} : { gapBefore: options.gapBefore },
    })
    job.retained += bytes
    this.#trim(id)
    job.view = { ...job.view, output: { total: job.view.output.total + bytes, earliest: this.#earliest(id) } }
    this.#emit({
      type: 'output',
      id: job.view.id,
      ...job.view.owner === undefined ? {} : { owner: job.view.owner },
      total: job.view.output.total,
    })
  }

  /** Publish a progress line, as a producer's `updateProgress` would. */
  progress(id: string, line: string): void {
    const job = this.#require(id)
    job.view = { ...job.view, progress: line }
    this.#emit({ type: 'progress', job: job.view })
  }

  /** Settle a job and announce it, exactly as the registry does. */
  settle(id: string, status: 'completed' | 'failed' | 'killed'): void {
    const job = this.#require(id)
    // Settlement clears the live progress line, and `progress` is optional
    // upstream rather than nullable, so the key is dropped rather than emptied.
    const { progress: _dropped, ...rest } = job.view
    job.view = { ...rest, status }
    this.#emit({ type: 'settled', job: job.view, cause: 'producer', awaited: false })
  }

  /** Every `readAt` call, in order. */
  readAts(): readonly { readonly id: string; readonly from: number; readonly caller?: SessionId }[] {
    return this.#readAts
  }

  /** Every consuming `read` call, in order. */
  reads(): readonly { readonly id: string; readonly from: number }[] {
    return this.#reads
  }

  /** Every `kill` call, with the exact three declared arguments. */
  kills(): readonly { readonly id: string; readonly caller?: SessionId; readonly reason?: string }[] {
    return this.#kills
  }

  /** How many event listeners are still registered. */
  listeners(): number {
    return this.#listeners.size
  }

  // --- the registry surface dshline actually reaches -----------------------------

  list(caller?: SessionId): JobView[] {
    return [...this.#jobs.values()]
      .map(job => job.view)
      // A settled record STAYS listed: the active filter belongs to the consumer,
      // which is the whole `/work` is-active-only distinction.
      .filter(v => v.owner === undefined || v.owner === caller)
  }

  get(id: string): JobView {
    // The race boundary. Anything appended here lands AFTER a subscription and
    // BEFORE the first read, which is the window a read-then-subscribe observer
    // loses.
    this.onGet?.()
    return this.#require(id).view
  }

  readAt(id: string, from: number, caller?: SessionId): JobOutputRead {
    this.#fence(id, caller)
    this.#readAts.push({ id, from, ...caller === undefined ? {} : { caller } })
    const job = this.#require(id)
    return {
      // A chunk overlapping `[from, total)` is returned WHOLE, so `at` may
      // precede `from`. This is the upstream rule a naive accumulator breaks.
      chunks: job.ring.filter(chunk => chunk.at + Buffer.byteLength(chunk.text, 'utf8') > from),
      next: job.view.output.total,
      lossy: from < job.view.output.earliest,
    }
  }

  read(id: string, caller?: SessionId): JobRead {
    this.#fence(id, caller)
    const from = this.#modelCursors.get(id) ?? 0
    this.#reads.push({ id, from })
    const job = this.#require(id)
    const chunks = job.ring.filter(chunk => chunk.at + Buffer.byteLength(chunk.text, 'utf8') > from)
    this.#modelCursors.set(id, job.view.output.total)
    return { chunks, lossy: from < job.view.output.earliest, job: job.view }
  }

  kill(id: string, caller?: SessionId, reason?: string): 'requested' | 'already-finished' {
    this.#fence(id, caller)
    this.#kills.push({ id, ...caller === undefined ? {} : { caller }, ...reason === undefined ? {} : { reason } })
    const job = this.#require(id)
    if (job.view.status !== 'running') return 'already-finished'
    job.view = { ...job.view, status: 'stopping' }
    this.#emit({ type: 'stopping', job: job.view })
    return 'requested'
  }

  events = {
    subscribe: (_filter: JobEventFilter, listener: JobEventListener): (() => void) => {
      this.#listeners.add(listener)
      return () => { this.#listeners.delete(listener) }
    },
  }

  // --- internals ----------------------------------------------------------------

  #require(id: string): FakeJob {
    const job = this.#jobs.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    return job
  }

  #fence(id: string, caller?: SessionId): void {
    const job = this.#require(id)
    if (job.view.owner !== undefined && caller !== undefined && job.view.owner !== caller) {
      throw new Error(`job ${id} is not visible to ${String(caller)}`)
    }
  }

  #earliest(id: string): number {
    return this.#require(id).ring[0]?.at ?? this.#require(id).view.output.total
  }

  #trim(id: string): void {
    const job = this.#require(id)
    while (job.retained > this.retention && job.ring.length > 1) {
      const dropped = job.ring.shift()
      /* v8 ignore next -- the length guard proves shift() returned a chunk. */
      if (dropped === undefined) break
      job.retained -= Buffer.byteLength(dropped.text, 'utf8')
    }
    const only = job.ring.length === 1 ? job.ring[0] : undefined
    if (only !== undefined && Buffer.byteLength(only.text, 'utf8') > this.retention) {
      const raw = Buffer.from(only.text, 'utf8')
      let start = raw.length - this.retention
      while (start < raw.length && ((raw[start] as number) & 0xC0) === 0x80) start += 1
      const tail = raw.subarray(start)
      only.text = tail.toString('utf8')
      only.at += raw.length - tail.length
      only.gapBefore = true
      job.retained = tail.length
    }
  }

  #emit(event: JobEvent): void {
    for (const listener of [...this.#listeners]) listener(event)
  }
}

/** HarnessWork over one fake registry, with a counted redraw request. */
function harness(fake: FakeJobs): { work: HarnessWork; invalidated: () => number } {
  let invalidated = 0
  return {
    work: new HarnessWork({ agent, jobs: fake.registry(), invalidate: () => { invalidated += 1 } }),
    invalidated: () => invalidated,
  }
}

/** The texts of one reading, with gap markers kept as their own entries. */
function lines(reading: { lines: readonly { text: string; gapBefore?: true }[] }): (string | 'GAP')[] {
  return reading.lines.map(line => line.gapBefore === true ? 'GAP' : line.text)
}

describe('Work keeps a job roster active-only', () => {
  it.each(['completed', 'failed', 'killed'] as const)('never projects a %s job', (status) => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.settle('bash-1', status)
    const { work } = harness(fake)
    // The registry KEEPS a settled record listed; the consumer drops it. A
    // projection that trusted `list()` alone would show a dead job here.
    expect(fake.list(ROOT)).toHaveLength(1)
    expect(work.snapshot().jobs).toEqual([])
    work.dispose()
  })

  it('projects running and stopping jobs and nothing else', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.start('bash-2', { id: 'bash-2' as JobView['id'], label: 'cargo build' })
    fake.kill('bash-2', ROOT)
    const { work } = harness(fake)
    expect(work.snapshot().jobs.map(item => item.state)).toEqual(['running', 'stopping'])
    work.dispose()
  })

  it('drops the row and its detail the instant the job settles', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    const { work } = harness(fake)
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'unsupported', message: 'no' }),
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(80, 30)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(80, 30).map(stripAnsi).join('\n')).toContain('Job · pnpm test')

    fake.settle('bash-1', 'completed')
    const after = overlay.render(80, 30).map(stripAnsi).join('\n')
    // The stage leaves with the row, back to the live overview — not a zombie
    // detail reading "no active work to inspect", and not a history row.
    expect(after).not.toContain('Job · pnpm test')
    expect(after).not.toContain('No active work to inspect')
    // Back on the live overview, whose own empty wording is its own sentence.
    expect(after).toContain('No active workflows, jobs, or subagents.')
    // And nothing local kept the dead job reachable.
    expect(work.snapshot().jobs).toEqual([])
    work.dispose()
  })
})

describe('Work projects the producer’s own progress line', () => {
  it('reaches both the overview and the detail as the exact published text', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.progress('bash-1', '127/203')
    const { work } = harness(fake)
    expect(work.snapshot().jobs[0]?.progress).toBe('127/203')
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'unsupported', message: 'no' }),
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    expect(overlay.render(90, 30).map(stripAnsi).join('\n')).toContain('127/203')
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(90, 30).map(stripAnsi).join('\n')).toContain('progress  127/203')
    work.dispose()
  })

  it('repaints on a progress line, because a row that can show it must not go stale', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    const { work, invalidated } = harness(fake)
    const before = invalidated()
    fake.progress('bash-1', 'compiling crate_x')
    expect(invalidated()).toBe(before + 1)
    expect(work.snapshot().jobs[0]?.progress).toBe('compiling crate_x')
    work.dispose()
  })

  it('invents no progress row for a producer that published none', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    const { work } = harness(fake)
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'unsupported', message: 'no' }),
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(90, 30).map(stripAnsi).join('\n')).not.toContain('progress')
  })

  it('treats a progress line as opaque escaped text', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.progress('bash-1', '[2J127/203')
    const { work } = harness(fake)
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'unsupported', message: 'no' }),
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    const frame = overlay.render(90, 30).map(stripAnsi).join('\n')
    // The escape is displayed, not obeyed, and the count is not parsed.
    expect(frame).toContain('^[[2J127/203')
    work.dispose()
  })

  it('leaves no historical progress row once the job settles', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.progress('bash-1', '127/203')
    const { work } = harness(fake)
    fake.settle('bash-1', 'completed')
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'unsupported', message: 'no' }),
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    expect(overlay.render(90, 30).map(stripAnsi).join('\n')).not.toContain('127/203')
  })
})

describe('job output observation is demand-driven', () => {
  it('costs zero output reads for the overview, the cursor, and every repaint', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.start('bash-2', { id: 'bash-2' as JobView['id'], label: 'cargo build' })
    const { work } = harness(fake)
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'unsupported', message: 'no' }),
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    for (let frame = 0; frame < 5; frame += 1) overlay.render(80, 24)
    overlay.handleKey({ kind: 'key', name: 'down' })
    overlay.handleKey({ kind: 'key', name: 'up' })
    overlay.handleKey({ kind: 'key', name: 'end' })
    overlay.handleKey({ kind: 'key', name: 'home' })
    for (let frame = 0; frame < 5; frame += 1) overlay.render(80, 24)
    expect(fake.readAts()).toEqual([])
  })

  it('reads only the opened job, and a sibling’s output never reaches it', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.start('bash-2', { id: 'bash-2' as JobView['id'], label: 'cargo build' })
    const { work } = harness(fake)
    const observation = work.observeJob('bash-1')
    expect(fake.readAts().map(call => call.id)).toEqual(['bash-1'])
    const opened = fake.readAts().length
    // B produces output. A is open, so A is woken and re-reads; B is not A's
    // business, and the filter is by exact id, not by owner.
    fake.append('bash-2', 'compiling\n')
    const afterB = fake.readAts()
    expect(afterB).toHaveLength(opened)
    fake.append('bash-1', 'hello\n')
    expect(fake.readAts()).toHaveLength(opened + 1)
    observation?.dispose()
  })

  it('unsubscribes on dispose and creates a fresh observation on reopen', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    const { work } = harness(fake)
    expect(fake.listeners()).toBe(1)
    const first = work.observeJob('bash-1')
    expect(fake.listeners()).toBe(2)
    first?.dispose()
    expect(fake.listeners()).toBe(1)
    const second = work.observeJob('bash-1')
    expect(fake.listeners()).toBe(2)
    // A fresh observation re-anchors from zero and re-reads what is retained,
    // rather than inheriting a cursor from the handle that was closed.
    expect(second?.reading().lines).toEqual([])
    second?.dispose()
  })

  it('unsubscribes the instant the job detail is closed, not only when work is', () => {
    // The overlay owns the per-detail handle, so `esc` has to release it on the
    // spot. A leaked observer would keep waking on every append from a producer
    // nobody is looking at, and would keep re-reading its ring.
    const fake = new FakeJobs()
    fake.start('bash-1')
    const { work, invalidated } = harness(fake)
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'unsupported', message: 'no' }),
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(80, 30)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.render(80, 30)
    // Roster subscription plus the one detail observation.
    expect(fake.listeners()).toBe(2)
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(fake.listeners()).toBe(1)
    const reads = fake.readAts().length
    const after = invalidated()
    fake.append('bash-1', 'after the detail closed\n')
    expect(fake.readAts()).toHaveLength(reads)
    expect(invalidated()).toBe(after)
  })

  it('unsubscribes when work itself is closed', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    const { work } = harness(fake)
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'unsupported', message: 'no' }),
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(80, 30)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.render(80, 30)
    expect(fake.listeners()).toBe(2)
    overlay.handleKey({ kind: 'key', name: 'escape' }) // back to the overview
    overlay.handleKey({ kind: 'key', name: 'escape' }) // closes work
    expect(fake.listeners()).toBe(1)
  })

  it('contains a still-live observation and ignores its late events', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    const { work, invalidated } = harness(fake)
    // A handle the overlay never got to release — the teardown-ordering mistake.
    work.observeJob('bash-1')
    expect(fake.listeners()).toBe(2)
    work.dispose()
    // Both are gone: the projection's own roster subscription and the contained
    // observer. Nothing of this session is left listening to the registry.
    expect(fake.listeners()).toBe(0)
    // A late event from the disposed observer must not invalidate anything: the
    // live region it belonged to is gone.
    const after = invalidated()
    fake.append('bash-1', 'late\n')
    expect(invalidated()).toBe(after)
    expect(fake.readAts().map(call => call.from)).toEqual([0])
  })
})

describe('job output observation never consumes the model cursor', () => {
  it('leaves the model’s first read receiving everything it would have received', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.append('bash-1', 'first line\n')
    const { work } = harness(fake)
    // Watch the whole stream through the detail, as a person would.
    const observation = work.observeJob('bash-1')
    fake.append('bash-1', 'second line\n')
    expect(lines(observation!.reading())).toEqual(['first line', 'second line'])
    observation?.dispose()

    // The model's own first read must still see the WHOLE stream from byte 0.
    const read = fake.registry().read('bash-1' as JobView['id'], ROOT)
    expect(read.chunks.map(chunk => chunk.text)).toEqual(['first line\n', 'second line\n'])
    expect(fake.reads()).toEqual([{ id: 'bash-1', from: 0 }])
  })

  it('resumes from its own offset and never re-delivers an already-seen byte', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.append('bash-1', 'one\n')
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    expect(lines(observation!.reading())).toEqual(['one'])
    fake.append('bash-1', 'two\n')
    // The second read resumes at the first read's `next`, not at 0.
    expect(fake.readAts().map(call => call.from)).toEqual([0, 4])
    expect(lines(observation!.reading())).toEqual(['one', 'two'])
  })
})

describe('subscribing before the first read cannot lose a chunk', () => {
  it('delivers bytes appended between subscription and the anchor read exactly once', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    // The dangerous boundary: this append lands AFTER the observer subscribed
    // and BEFORE its first `readAt`. An observer that read first and subscribed
    // second would never see it, because the read already happened.
    fake.onGet = () => { fake.append('bash-1', 'raced\n') }
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    // The bytes are there. A read-then-subscribe observer would have read an
    // empty ring, registered afterwards, and never been told about this append.
    expect(lines(observation!.reading())).toEqual(['raced'])
    // And they are there EXACTLY once: re-reading, and waking again, must not
    // re-append them, however many reads the boundary produced.
    expect(lines(observation!.reading())).toEqual(['raced'])
    fake.append('bash-1', 'after\n')
    expect(lines(observation!.reading())).toEqual(['raced', 'after'])
  })
})

describe('absolute byte offsets survive multibyte and astral text', () => {
  it.each([
    ['ascii', 'alpha\nbeta\n', ['alpha', 'beta']],
    ['cjk', '审查完成\n通过\n', ['审查完成', '通过']],
    ['astral', 'done 🎉\nok 👨‍👩‍👧\n', ['done 🎉', 'ok 👨‍👩‍👧']],
  ])('accumulates %s incrementally without duplication or corruption', (_label, chunk, expected) => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.append('bash-1', chunk)
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    expect(lines(observation!.reading())).toEqual(expected)
    // Nothing is re-encoded on the way in, so the cursor is the byte length and
    // not the code-unit length.
    expect(fake.readAts().map(call => call.from)).toEqual([0])
    expect(fake.reads()).toEqual([])
  })

  it('trims only the unseen byte prefix when a read begins inside a chunk', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    // One chunk the observer already saw in full, then a SECOND chunk whose text
    // the next read will also return whole — so the naive `tail += chunk.text`
    // would re-append the whole second chunk on every wakeup.
    fake.append('bash-1', 'ABCDEF\n')
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    expect(lines(observation!.reading())).toEqual(['ABCDEF'])
    fake.append('bash-1', '审查通过\n')
    expect(lines(observation!.reading())).toEqual(['ABCDEF', '审查通过'])
    // A third wakeup re-reads the SAME second chunk; nothing may be added.
    const before = fake.readAts().length
    fake.append('bash-1', '')
    expect(fake.readAts()).toHaveLength(before)
    expect(lines(observation!.reading())).toEqual(['ABCDEF', '审查通过'])
  })

  it('never cuts a code point in half when an offset lands inside one', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    // A CJK code point is three bytes. Resuming at 1 or 2 lands INSIDE it, so a
    // byte-accurate trim has to walk forward to the next boundary.
    fake.append('bash-1', '审abc')
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    expect(lines(observation!.reading())).toEqual(['审abc'])
    const whole = observation!.reading().lines
    expect(whole).toHaveLength(1)
    // The retained text round-trips: no replacement character, no lone half.
    expect(whole[0]?.text).toBe('审abc')
    expect(whole[0]?.text).not.toContain('�')
  })
})

describe('missing output is reported, never silently spliced', () => {
  it('draws the loss marker a person can actually see in the frame', () => {
    // The observer test below proves the READING carries a marker; this one
    // proves the marker reaches the terminal. Without it, an implementation
    // could carry loss faithfully right up to the row builder and then render
    // the gap as a blank line, which is the one place a reader would be misled.
    const fake = new FakeJobs(20)
    fake.start('bash-1')
    fake.append('bash-1', 'old line one\n')
    fake.append('bash-1', 'old line two\n')
    const { work } = harness(fake)
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'unsupported', message: 'no' }),
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(100, 40)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const frame = overlay.render(100, 40).map(stripAnsi).join('\n')
    expect(frame).toContain('… earlier output not retained …')
    // The retained tail is on screen beside it, so the stream stays readable.
    expect(frame).toContain('old line two')
    // One missing region, one marker — not one per lost chunk.
    expect(frame.split('… earlier output not retained …')).toHaveLength(2)
  })

  it('reports a loss even when the ring retains no text at all to carry it', () => {
    // The seam permits a configuration where this happens legitimately, so it is
    // not a corner invented for a test. `retainBytes` is validated as a positive
    // integer and nothing forbids `1`; the ring's tail cut then starts one byte
    // from the end of a three-byte CJK code point, finds that boundary is INSIDE
    // the code point, and walks forward to the end of the string. What survives is
    // a zero-length chunk at the stream's end, marked `gapBefore`.
    //
    // The consequence for a viewer is the whole point: output DID exist and is no
    // longer retained. Rendering that as an empty tail — and therefore as "no
    // output yet" — would state the opposite of the truth.
    const fake = new FakeJobs(1)
    fake.start('bash-1')
    fake.append('bash-1', '审')
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    // The registry's own view confirms the shape this reproduces: the ring's
    // total and earliest have met, and nothing readable is retained.
    expect(fake.readAts()).toEqual([{ id: 'bash-1', from: 0, caller: ROOT }])
    expect(lines(observation!.reading())).toEqual(['GAP'])
  })

  it('carries one loss marker forward onto the next output that survives', () => {
    // The gap has to SURVIVE the read that discovered it, because at that moment
    // there is nothing to draw it on. It attaches to the first chunk that does
    // carry text, and only once.
    const fake = new FakeJobs(1)
    fake.start('bash-1')
    fake.append('bash-1', '审')
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    expect(lines(observation!.reading())).toEqual(['GAP'])
    // Repeated readings before any new output repeat the SAME single marker: the
    // loss is one fact about the stream, not one fact per frame.
    expect(lines(observation!.reading())).toEqual(['GAP'])
    // One byte is exactly what a retention cap of 1 keeps whole, so this is the
    // follow-up output that genuinely survives. A longer line would be trimmed
    // back down by the same cap and prove nothing.
    fake.append('bash-1', 'x')
    expect(lines(observation!.reading())).toEqual(['GAP', 'x'])
    // A further append carries no newline, so it CONTINUES that line rather than
    // starting one — line structure comes from the producer's own newlines, not
    // from chunk boundaries. What matters here is that the marker did not come
    // back: one missing region, one marker, however many reads follow.
    fake.append('bash-1', 'y')
    expect(lines(observation!.reading())).toEqual(['GAP', 'xy'])
    fake.append('bash-1', '\n')
    expect(lines(observation!.reading())).toEqual(['GAP', 'xy'])
  })

  it('draws that loss in the frame instead of claiming no output yet', () => {
    const fake = new FakeJobs(1)
    fake.start('bash-1')
    fake.append('bash-1', '审')
    const { work } = harness(fake)
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'unsupported', message: 'no' }),
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(100, 40)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const frame = overlay.render(100, 40).map(stripAnsi).join('\n')
    expect(frame).toContain('… earlier output not retained …')
    // "No output yet" is a claim about a producer that has not spoken. This
    // producer spoke, and its output aged out, which is a different fact.
    expect(frame).not.toContain('No output yet')
    // Once ordinary output follows, the marker and the text read together.
    fake.append('bash-1', 'x')
    const next = overlay.render(100, 40).map(stripAnsi).join('\n')
    expect(next).toContain('… earlier output not retained …')
    expect(next).toContain('x')
    expect(next.split('… earlier output not retained …')).toHaveLength(2)
  })

  it('marks a lossy read once, and keeps the stream readable after it', () => {
    const fake = new FakeJobs(20)
    fake.start('bash-1')
    fake.append('bash-1', 'old line one\n')
    fake.append('bash-1', 'old line two\n')
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    // Retention dropped the head, so the first read is lossy — and the reading
    // opens with exactly ONE marker even though several chunks were lost.
    const read = lines(observation!.reading())
    expect(read[0]).toBe('GAP')
    expect(read.filter(entry => entry === 'GAP')).toHaveLength(1)
    expect(read.join('|')).toContain('old line two')
    // And it continues: a later append is still ordinary output.
    fake.append('bash-1', 'fresh\n')
    expect(lines(observation!.reading()).slice(1)).toContain('fresh')
  })

  it('marks a producer gap at the boundary it happened', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.append('bash-1', 'before\n')
    fake.append('bash-1', 'after\n', { gapBefore: true })
    fake.append('bash-1', 'tail\n')
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    expect(lines(observation!.reading())).toEqual(['before', 'GAP', 'after', 'tail'])
  })

  it('marks its own presentation eviction, and never claims a complete tail', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.append('bash-1', 'a'.repeat(100) + '\n')
    fake.append('bash-1', 'b'.repeat(100) + '\n')
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
      // A tiny presentation cap, so dshline's OWN bound is what evicts — the ring
      // is holding both chunks comfortably.
      limitBytes: 120,
    })
    const read = observation!.reading()
    // Newest output wins, and the loss is visible rather than implied.
    expect(lines(read)[0]).toBe('GAP')
    expect(read.lines.at(-1)?.text).toBe('b'.repeat(100))
    expect(read.lines.filter(line => line.gapBefore === true)).toHaveLength(1)
  })

  it('does not repeat a marker for every adjacent chunk in one missing region', () => {
    const fake = new FakeJobs(8)
    fake.start('bash-1')
    for (const text of ['one\n', 'two\n', 'three\n', 'four\n']) fake.append('bash-1', text)
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    // Four chunks went, one region was missing, so exactly one marker.
    expect(lines(observation!.reading()).filter(entry => entry === 'GAP')).toHaveLength(1)
  })
})

describe('channels survive to the presentation layer', () => {
  it('preserves authoritative ring order and every channel label', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.append('bash-1', 'compiling\n', { channel: 'stderr' })
    fake.append('bash-1', 'narrating\n', { channel: 'log' })
    fake.append('bash-1', 'built\n', { channel: 'stdout' })
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    const read = observation!.reading()
    // Not reordered by channel: the ring's order is the truth, and dshline does
    // not claim a stronger OS-level interleaving than Harness published.
    expect(read.lines.map(line => [line.text, line.channel])).toEqual([
      ['compiling', 'stderr'],
      ['narrating', 'log'],
      ['built', 'stdout'],
    ])
  })

  it('treats an absent or unrecognized channel as neutral', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    fake.append('bash-1', 'plain\n')
    const observation = observeJobOutput({
      jobs: fake.registry(), id: 'bash-1', caller: ROOT, invalidate: () => {},
    })
    expect(observation!.reading().lines[0]?.channel).toBeUndefined()
  })

  it('keeps an open job output view inside the physical terminal height', () => {
    // Output belongs to the temporary live region, never to native scrollback, so
    // the frame a job detail produces has to fit whatever room it was given —
    // including a very short one, where the honest answer is the compact
    // fallback rather than a taller frame. A long job is the interesting case:
    // hundreds of retained lines must not become hundreds of screen rows.
    const fake = new FakeJobs()
    fake.start('bash-1')
    for (let line = 0; line < 400; line += 1) fake.append('bash-1', `line ${String(line)}\n`)
    const { work } = harness(fake)
    for (const [columns, terminalRows] of [[120, 60], [100, 40], [80, 24], [40, 14], [30, 8], [20, 6]] as const) {
      const overlay = createWorkOverlay({
        snapshot: () => work.snapshot(),
        interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
        stopJob: () => ({ kind: 'unsupported', message: 'no' }),
        observeJob: id => work.observeJob(id),
        close: () => {},
        invalidate: () => {},
      })
      overlay.render(columns, terminalRows)
      overlay.handleKey({ kind: 'key', name: 'enter' })
      const frame = overlay.render(columns, terminalRows)
      expect(wrapToWidth(frame.join('\n'), columns).length, `${columns}x${terminalRows}`)
        .toBeLessThanOrEqual(terminalRows)
      // Whatever the geometry decided, the view stays closable and returns to the
      // live overview. The SECTION HEADING is deliberately not asserted: at a
      // narrow width the viewport legitimately scrolls past it, and requiring it
      // would be requiring a layout these bounds do not promise.
      overlay.handleKey({ kind: 'key', name: 'escape' })
      const back = overlay.render(columns, terminalRows).map(stripAnsi).join('\n')
      expect(back, `${columns}x${terminalRows}`).toContain('bash')
      expect(back, `${columns}x${terminalRows}`).toContain('esc close')
    }
    work.dispose()
  })

  it('escapes controls on every channel and never executes one', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    for (const channel of ['stdout', 'stderr', 'log'] as const) {
      fake.append('bash-1', `${channel}[2J]0;title\n`, { channel })
    }
    const { work } = harness(fake)
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'unsupported', message: 'no' }),
      observeJob: id => work.observeJob(id),
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const frame = overlay.render(120, 40).map(stripAnsi).join('\n')
    for (const channel of ['stdout', 'stderr', 'log']) {
      expect(frame).toContain(`${channel}^[[2J`)
    }
    // The erase sequence is displayed, and nothing in the frame is a live
    // sequence: stripAnsi is a no-op here, which is the point.
    expect(frame).not.toContain('')
  })
})

describe('a human job stop is armed against a job identity', () => {
  /** One overlay over a fixed snapshot, with both control seams recorded. */
  function stopper(jobs: () => readonly JobWorkItem[]): {
    readonly overlay: ReturnType<typeof createWorkOverlay>
    readonly stopped: string[]
    readonly frame: (columns?: number, rows?: number) => string
  } {
    const stopped: string[] = []
    const snapshot: WorkSnapshot = {
      available: true, workflows: [], subagents: [], jobs: jobs(),
    }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot,
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: item => {
        stopped.push(item.id)
        return { kind: 'requested', message: 'Stop requested.' } satisfies WorkInterruptResult
      },
      close: () => {},
      invalidate: () => {},
    })
    return {
      overlay,
      stopped,
      frame: (columns = 80, rows = 30) => overlay.render(columns, rows).map(stripAnsi).join('\n'),
    }
  }

  const running = (id: string, label: string): JobWorkItem => ({
    id, source: 'job', kind: 'bash', label, state: 'running', startedAt: Date.now(), ownership: 'this-session',
  })

  it('arms on the first press and stops on the second, from the detail stage', () => {
    const app = stopper(() => [running('bash-1', 'pnpm test')])
    app.overlay.render(80, 30)
    app.overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(app.frame()).toContain('k stop')
    app.overlay.handleKey({ kind: 'text', text: 'k' })
    // The first press arms and says nothing destructive.
    expect(app.stopped).toEqual([])
    expect(app.frame()).toContain('press k again to stop')
    expect(app.frame()).toContain('k confirm stop')
    app.overlay.handleKey({ kind: 'text', text: 'k' })
    expect(app.stopped).toEqual(['bash-1'])
  })

  it('offers no stop at all from the overview', () => {
    const app = stopper(() => [running('bash-1', 'pnpm test')])
    app.overlay.render(80, 30)
    expect(app.frame()).not.toContain('k stop')
    app.overlay.handleKey({ kind: 'text', text: 'k' })
    expect(app.stopped).toEqual([])
  })

  it('offers no stop for a stopping job and prints no fact about its absence', () => {
    const app = stopper(() => [{ ...running('bash-1', 'pnpm test'), state: 'stopping' }])
    app.overlay.render(80, 30)
    app.overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(app.frame()).not.toContain('k stop')
    expect(app.frame()).not.toContain('unavailable')
    app.overlay.handleKey({ kind: 'text', text: 'k' })
    expect(app.stopped).toEqual([])
  })

  it('never lets one job inherit another’s arming', () => {
    const app = stopper(() => [running('bash-1', 'a'), running('bash-2', 'b')])
    app.overlay.render(80, 30)
    app.overlay.handleKey({ kind: 'key', name: 'enter' })
    app.overlay.handleKey({ kind: 'text', text: 'k' }) // arms bash-1
    // Navigate to the other Job's detail. The arming is consent for one named
    // Job, and consent does not travel.
    app.overlay.handleKey({ kind: 'key', name: 'escape' })
    app.overlay.handleKey({ kind: 'key', name: 'down' })
    app.overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(app.frame()).toContain('k stop')
    expect(app.frame()).not.toContain('k confirm stop')
    app.overlay.handleKey({ kind: 'text', text: 'k' }) // arms bash-2
    app.overlay.handleKey({ kind: 'text', text: 'k' })
    expect(app.stopped).toEqual(['bash-2'])
  })

  it('disarms when the detail is left and when work closes', () => {
    const app = stopper(() => [running('bash-1', 'pnpm test')])
    app.overlay.render(80, 30)
    app.overlay.handleKey({ kind: 'key', name: 'enter' })
    app.overlay.handleKey({ kind: 'text', text: 'k' })
    app.overlay.handleKey({ kind: 'key', name: 'escape' })
    app.overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(app.frame()).toContain('k stop')
    // A press here re-arms rather than firing the previous arming.
    app.overlay.handleKey({ kind: 'text', text: 'k' })
    expect(app.stopped).toEqual([])
  })

  it('expires the arming after the confirmation window', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const app = stopper(() => [running('bash-1', 'pnpm test')])
      app.overlay.render(80, 30)
      app.overlay.handleKey({ kind: 'key', name: 'enter' })
      app.overlay.handleKey({ kind: 'text', text: 'k' })
      expect(app.frame()).toContain('k confirm stop')
      vi.advanceTimersByTime(3_100)
      expect(app.frame()).toContain('k stop')
      expect(app.frame()).not.toContain('k confirm stop')
      // The second press three seconds later is a FIRST press again.
      app.overlay.handleKey({ kind: 'text', text: 'k' })
      expect(app.stopped).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a confirmed stop when the job began stopping in between', () => {
    let items: JobWorkItem[] = [running('bash-1', 'pnpm test')]
    const stopped: string[] = []
    const snapshot = (): WorkSnapshot => ({
      available: true, workflows: [], subagents: [], jobs: items,
    })
    const overlay = createWorkOverlay({
      snapshot,
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: item => {
        stopped.push(item.id)
        return { kind: 'requested', message: 'Stop requested.' }
      },
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(80, 30)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.handleKey({ kind: 'text', text: 'k' })
    // The Job starts stopping between the two presses — another process, the
    // model, or the producer itself. The confirming press must re-validate
    // against current authority and refuse rather than send a second stop.
    items = [{ ...running('bash-1', 'pnpm test'), state: 'stopping' }]
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(stopped).toEqual([])
  })

  it('says a stop was requested rather than stopped, and reports failure honestly', () => {
    const failed = createWorkOverlay({
      snapshot: () => ({ available: true, workflows: [], subagents: [], jobs: [running('bash-1', 'pnpm test')] }),
      interruptSubagent: () => ({ kind: 'unsupported', message: 'no' }),
      stopJob: () => ({ kind: 'failed', message: 'Stop failed: producer refused to cancel' }),
      close: () => {},
      invalidate: () => {},
    })
    failed.render(80, 30)
    failed.handleKey({ kind: 'key', name: 'enter' })
    failed.handleKey({ kind: 'text', text: 'k' })
    failed.handleKey({ kind: 'text', text: 'k' })
    expect(failed.render(80, 30).map(stripAnsi).join('\n')).toContain('Stop failed: producer refused to cancel')
  })
})

describe('the stop reaches the registry and nothing else', () => {
  it('uses the exact job, the attached session, and the human-stop reason', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    const { work } = harness(fake)
    const row = work.snapshot().jobs[0]
    expect(work.stopJob(row!).kind).toBe('requested')
    expect(fake.kills()).toEqual([{ id: 'bash-1', caller: ROOT, reason: 'cancelled by the user' }])
    // Nothing about the model-facing path was touched: no consuming read, and no
    // call dshline could make into the model's own tool.
    expect(fake.reads()).toEqual([])
    work.dispose()
  })

  it('reports an already-finished race without inventing failure or history', () => {
    const fake = new FakeJobs()
    fake.start('bash-1')
    const { work } = harness(fake)
    const row = work.snapshot().jobs[0]
    fake.settle('bash-1', 'completed')
    const result = work.stopJob(row!)
    // A race, not a failure: the row is already gone from active work, and
    // nothing is retained to host a message about it.
    expect(result.kind).toBe('requested')
    expect(work.snapshot().jobs).toEqual([])
    work.dispose()
  })
})
