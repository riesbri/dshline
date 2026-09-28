/**
 * Descendant discovery, when lifecycle edges arrive faster than the catalog reads.
 *
 * `listDescendants()` is the only authority for a child's label, mode, residency
 * and lineage, and it is a RECURSIVE walk of parent catalogs — the most expensive
 * thing this projection asks for. A burst of lifecycle edges used to start one
 * walk per edge, all but the last running to completion to be thrown away by the
 * generation guard. These tests hold the coalescing in place, and hold it against
 * the three things that could make it wrong: a superseded result being applied, a
 * teardown being mutated by a late walk, and a failed walk being treated as
 * anything worse than missing enrichment.
 * @module dshline/tests/work-discovery
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type {
  SubagentDescendantListEntry,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentRuntime,
} from '@deepseek-ai/dsh-subagent'
import { HarnessWork } from '../src/work/index.ts'
import type { WorkCapabilities } from '../src/work/index.ts'

/** The session whose catalog is walked, and the only one this file is about. */
const ROOT = SessionId('root')

/** The exact listener `HarnessWork` registers for a `subagent/start` edge. */
type StartListener = Parameters<NonNullable<WorkCapabilities['onSubagentStart']>>[0]

/** The exact listener `HarnessWork` registers for a `subagent/end` edge. */
type EndListener = Parameters<NonNullable<WorkCapabilities['onSubagentEnd']>>[0]

/** A direct child row, at the depth the projection reads. */
function child(id: string, label: string): SubagentDescendantListEntry {
  return {
    kind: 'child',
    id: SessionId(id),
    mode: 'continuable',
    label,
    activity: 'running',
    hasChildren: false,
    parentId: ROOT,
    depth: 1,
  }
}

/** One pending `listDescendants` call. */
interface Walk {
  readonly entries: SubagentDescendantListEntry[]
  /** Whether the call was given a signal, and whether it was aborted. */
  aborted: () => boolean
  signalled: () => boolean
}

/** A driven projection over a catalog seam the test settles by hand. */
interface Driver {
  readonly work: HarnessWork
  /** How many walks the seam has been asked for. */
  readonly walks: () => number
  /** The walks still in flight, oldest first. */
  pending: () => readonly Walk[]
  /** Settle the oldest pending walk with these entries. */
  settle: (entries: SubagentDescendantListEntry[]) => Promise<void>
  /** Settle the oldest pending walk with a failure, as an unavailable catalog would. */
  fail: () => Promise<void>
  /** Open a lifecycle epoch, as `subagent/start` would. */
  start: (id: string) => void
  /** Close one, as `subagent/end` would. */
  end: (id: string) => void
  /** How many times the projection asked for a redraw. */
  readonly invalidations: () => number
}

/**
 * A projection whose catalog walks resolve only when the test says so.
 * @returns the driver.
 */
function driver(): Driver {
  const open: (Walk & { resolve: (entries: SubagentDescendantListEntry[]) => void, reject: () => void })[] = []
  let started = 0
  let invalidations = 0
  const ctx = new Context()
  const agent = { session: { id: ROOT, header: { cwd: '/ws' } }, ctx, status: 'idle' } as unknown as Agent
  let startListener: StartListener | undefined
  let endListener: EndListener | undefined
  const subagents = {
    listDescendants: (_root: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]> => {
      started += 1
      return new Promise<SubagentDescendantListEntry[]>((resolve, reject) => {
        open.push({
          entries: [],
          signalled: () => signal !== undefined,
          aborted: () => signal?.aborted === true,
          resolve: entries => { resolve(entries) },
          reject: () => { reject(new Error('catalog unavailable')) },
        })
      })
    },
  } as unknown as SubagentRuntime
  const work = new HarnessWork({
    agent,
    subagents,
    invalidate: () => { invalidations += 1 },
    onSubagentStart: listener => { startListener = listener; return () => { startListener = undefined } },
    onSubagentEnd: listener => { endListener = listener; return () => { endListener = undefined } },
  })
  const take = (): (Walk & { resolve: (entries: SubagentDescendantListEntry[]) => void, reject: () => void }) | undefined =>
    open.shift()
  return {
    work,
    walks: () => started,
    pending: () => open.map(walk => ({ entries: walk.entries, aborted: walk.aborted, signalled: walk.signalled })),
    settle: async entries => {
      take()?.resolve(entries)
      await Promise.resolve()
      await Promise.resolve()
    },
    fail: async () => {
      take()?.reject()
      await Promise.resolve()
      await Promise.resolve()
    },
    start: id => {
      const info: SubagentRunInfo = {
        runId: SubagentRunId(`run-${id}`), id: SessionId(id), provider: 'codex', local: false,
      }
      startListener?.(info)
    },
    end: id => {
      const info: SubagentRunEndInfo = {
        runId: SubagentRunId(`run-${id}`), id: SessionId(id), provider: 'codex', local: false, stopReason: 'completed',
      }
      endListener?.(info)
    },
    invalidations: () => invalidations,
  }
}

describe('coalescing descendant discovery', () => {
  it('walks the catalog once for a burst and applies the newest walk', async () => {
    // Five lifecycle edges, none of them able to wait for the walk the first one
    // started. Before the coalescing that was five recursive walks, four of them
    // discarded. It is two: the one in flight, and the one owed behind it.
    const drive = driver()
    // The constructor's own discovery read, in flight before any edge arrives.
    expect(drive.walks()).toBe(1)
    for (const id of ['a', 'b', 'c', 'd', 'e']) drive.start(id)
    expect(drive.walks()).toBe(1)

    await drive.settle([child('a', 'stale')])
    expect(drive.walks()).toBe(2)
    await drive.settle([child('a', 'fresh'), child('b', 'also fresh')])

    // The applied discovery is the newest walk's, never the one it superseded:
    // the two children the last walk found carry ITS labels, and the three it
    // never mentioned carry none at all rather than a stale one.
    const rows = drive.work.snapshot().subagents
    expect(rows.map(row => row.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(rows.map(row => row.label)).toEqual(['fresh', 'also fresh', undefined, undefined, undefined])
    drive.work.dispose()
  })

  it('asks again for a later edge once the walk in flight has settled', async () => {
    // Coalescing is about OVERLAP, not about answering from a remembered walk: an
    // edge that arrives after the last walk settled must reach the catalog again.
    const drive = driver()
    await drive.settle([])
    expect(drive.walks()).toBe(1)
    drive.start('a')
    expect(drive.walks()).toBe(2)
    await drive.settle([child('a', 'from the second walk')])
    expect(drive.work.snapshot().subagents[0]?.label).toBe('from the second walk')
    drive.work.dispose()
  })

  it('spends one walk on a burst of ends as well as of starts', async () => {
    // Ends are the same edge from the projection's point of view, and a teardown
    // storm is a burst like any other.
    const drive = driver()
    await drive.settle([child('a', 'a')])
    // Nothing is in flight when the storm arrives, so the first end reads and the
    // other two share the walk behind it.
    for (const id of ['a', 'b', 'c']) drive.end(id)
    expect(drive.walks()).toBe(2)
    await drive.settle([])
    await drive.settle([])
    expect(drive.walks()).toBe(3)
    // A settled end is no child to enrich, and the row is gone with it.
    expect(drive.work.snapshot().subagents).toEqual([])
    drive.work.dispose()
  })

  it('keeps a lifecycle row whole when the catalog read fails', async () => {
    // Discovery is enrichment. A refused walk leaves the row with its lifecycle
    // edge, which is the whole promise of the generation guard's sibling: no
    // label, no mode, no interrupt claim — and no exception.
    const drive = driver()
    drive.start('a')
    await drive.fail()
    expect(drive.work.snapshot().subagents).toMatchObject([{ id: 'a', source: 'subagent' }])
    expect(drive.work.snapshot().subagents[0]?.label).toBeUndefined()
    expect(drive.work.snapshot().subagents[0]?.interruptible).toBe(false)
    drive.work.dispose()
  })

  it('still reads after a failed walk, because a refusal is not a cache', async () => {
    const drive = driver()
    await drive.fail()
    drive.start('a')
    expect(drive.walks()).toBe(2)
    await drive.settle([child('a', 'recovered')])
    expect(drive.work.snapshot().subagents[0]?.label).toBe('recovered')
    drive.work.dispose()
  })

  it('does not apply a walk that a later edge superseded', async () => {
    // The generation guard is unchanged and still load-bearing: a coalesced walk
    // answers the newest request or none of them, never a stale one. The walk that
    // lands here began before the `b` edge, so it is dropped even though it was
    // the only walk in flight when the burst began.
    const drive = driver()
    drive.start('a')
    await drive.settle([child('a', 'superseded')])
    drive.start('b')
    await drive.settle([child('a', 'also superseded')])
    expect(drive.work.snapshot().subagents.map(row => row.label)).toEqual([undefined, undefined])
    // The walk owed behind the burst is the one that started after the last edge,
    // and it is the one that answers.
    await drive.settle([child('a', 'current'), child('b', 'current')])
    expect(drive.work.snapshot().subagents.map(row => row.label)).toEqual(['current', 'current'])
    drive.work.dispose()
  })
})

describe('disposal while discovery is in flight', () => {
  it('abandons the walk and repaints nothing', async () => {
    const drive = driver()
    drive.start('a')
    const before = drive.invalidations()
    // The seam takes a real signal, so a teardown can stop the walk rather than
    // let a recursive read finish for a projection that no longer exists.
    drive.work.dispose()
    expect(drive.pending()[0]?.signalled()).toBe(true)
    expect(drive.pending()[0]?.aborted()).toBe(true)

    // Whatever the abandoned walk answers, nothing it carries may be applied and
    // nothing may redraw the NEXT attachment.
    await drive.settle([child('a', 'too late')])
    expect(drive.invalidations()).toBe(before)
    expect(drive.work.snapshot().subagents).toEqual([])
  })

  it('starts no trailing walk for a teardown that arrived mid-burst', async () => {
    const drive = driver()
    drive.start('a')
    drive.start('b')
    expect(drive.walks()).toBe(1)
    // The lifecycle edges have already asked for redraws of their own; what must
    // not follow is one from a walk that landed after the teardown.
    const before = drive.invalidations()
    drive.work.dispose()
    await drive.settle([child('a', 'too late')])
    expect(drive.walks()).toBe(1)
    expect(drive.invalidations()).toBe(before)
  })
})
