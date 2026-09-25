/**
 * Focused tests for the durable subagent-conversation catalog, inspector, and
 * human queue/steer path.
 *
 * The authority boundary is the point: discovery is the recursive
 * `listDescendants` walk, cut at the direct-child depth its rows report;
 * inspection is a bounded `listEvents`+`readEvent` read, and a human follow-up
 * is `ctx.subagents.prompt` — never the model-authored `sendMessage`. These
 * tests fake only the Harness seams and drive the real presenter and overlays.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEventReadRequest, SessionEventRecord, SessionEventWindow } from '@deepseek-ai/dsh-session-query'
import type {
  SubagentCatalogEntry,
  SubagentDescendantListEntry,
  SubagentListEntry,
  SubagentPromptReceipt,
  SubagentPromptRequest,
} from '@deepseek-ai/dsh-subagent'
import { BOX_CHROME_COLUMNS, stripAnsi } from '@dshline/renderer'
import type { Key } from '@dshline/renderer'
import { chromeWidth } from '../src/chrome.ts'
import type { TuiOverlay } from '../src/slots.ts'
import { physicalRows, SurfaceNotice } from '../src/surface.ts'
import {
  catalogReading,
  diagnosticReasonWord,
  subagentRowFollowUp,
  subagentRowKey,
  subagentRowOpenable,
} from '../src/subagents/model.ts'
import type { SubagentCatalogReading, SubagentCatalogRow } from '../src/subagents/model.ts'
import {
  createSubagentCatalogOverlay,
  createSubagentConversationOverlay,
  createSubagentMessageOverlay,
} from '../src/subagents/overlay.ts'
import { createSubagentsPresenter, type SubagentsPresenterDeps } from '../src/subagents/presenter.ts'
import { readTranscriptNewer, readTranscriptOlder, readTranscriptTail, transcriptReading, TRANSCRIPT_PAGE } from '../src/subagents/transcript.ts'
import type { SubagentTranscriptReading } from '../src/subagents/transcript.ts'
import { HarnessWork } from '../src/work/index.ts'
import { activeWorkCount } from '../src/work/model.ts'

/** The durable parent every fixture tree hangs from, and the address the presenter is given. */
const PARENT = 'parent'

/** The edge distance `listDescendants` reports for a child of {@link PARENT}. */
const DIRECT_CHILD_DEPTH = 1

/**
 * One durable direct child of {@link PARENT}, as the recursive seam reports it.
 *
 * A descendant row rather than a bare list entry, because residency, lineage,
 * and the branch diagnostics this catalog now depends on exist only on the
 * recursive walk — `listChildren` answers with the flat parent catalog, which
 * carries none of the three.
 * @param id - the durable child session id.
 * @param mode - Harness's descriptor mode for that child.
 * @param activity - session-store residency, not a model-turn claim.
 * @param label - the durable creation label.
 * @param hasChildren - whether that child's own catalog holds a direct child.
 * @returns the depth-one descendant row.
 */
function child(
  id: string,
  mode: 'one-shot' | 'continuable',
  activity: 'running' | 'inactive',
  label = id,
  hasChildren = false,
): SubagentDescendantListEntry {
  return {
    kind: 'child', id: id as never, parentId: PARENT as never,
    depth: DIRECT_CHILD_DEPTH, mode, activity, label, hasChildren,
  }
}

/**
 * One branch the recursive seam could not interpret, at the direct-child depth.
 * @param id - the candidate's session id.
 * @param reason - why Harness produced no child identity for it.
 * @returns the depth-one diagnostic row.
 */
function diagnostic(id: string, reason: 'corrupt' | 'unavailable' | 'unsupported'): SubagentDescendantListEntry {
  return { kind: 'diagnostic', id: id as never, parentId: PARENT as never, depth: DIRECT_CHILD_DEPTH, reason }
}

/**
 * Hang one row under a deeper branch of the same tree.
 *
 * The seam reports edge distance, not just membership, and this catalog is the
 * parent's DIRECT children: a grandchild is a real row the real walk returns,
 * and the one filter that has to remove it.
 * @param row - the row as built, positioned under {@link PARENT}.
 * @param parentId - the direct parent this row is really catalogued under.
 * @param depth - the edge distance from {@link PARENT}.
 * @returns the same row, one branch deeper.
 */
function deeper(
  row: SubagentDescendantListEntry,
  parentId: string,
  depth: number,
): SubagentDescendantListEntry {
  return { ...row, parentId: parentId as never, depth }
}

/**
 * The first row of a reading, or a failure that names the reading.
 *
 * A non-null assertion would instead hand `undefined` to whichever function
 * came next and fail there as a `TypeError`, which reads as a fault in that
 * function rather than in the mapping this test is about.
 * @param reading - the reading to take a row from.
 * @returns the row the cursor starts on.
 */
function firstRow(reading: SubagentCatalogReading): SubagentCatalogRow {
  const row = reading.kind === 'ready' ? reading.rows.at(0) : undefined
  if (row === undefined) throw new Error(`expected a ready reading with a first row, got ${reading.kind}`)
  return row
}

/** A semantic user-message event, enough for `extractSessionEventText`. */
function message(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: seq as never,
    time: 1_700_000_000_000 + seq,
    data: { content: [{ type: 'text', text }] },
  } as unknown as SessionEvent
}

/** Let the queued microtask chain settle. */
function flush(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve) })
}

/** A key keystroke. */
function key(name: string): Key {
  return { kind: 'key', name } as Key
}

/** A printable-text keystroke. */
function text(value: string): Key {
  return { kind: 'text', text: value }
}

/** One recorded descendant-listing call, exactly as the presenter makes it. */
interface DescendantCall {
  readonly parentSessionId: SessionId
  readonly signal?: AbortSignal
}

/**
 * The rows the recursive seam answers for one root: pre-order from that root,
 * one visit per row.
 *
 * A row catalogued under some other session's branch is not a descendant of
 * this root, which is what makes the presenter's depth cut a real filter rather
 * than a decoration — a fake that answered with every row it was given would
 * pass a catalog that forgot the cut.
 */
function descendantsOf(
  rows: readonly SubagentDescendantListEntry[],
  root: string,
): SubagentDescendantListEntry[] {
  const byParent = new Map<string, SubagentDescendantListEntry[]>()
  for (const row of rows) {
    const parentId = String(row.parentId)
    byParent.set(parentId, [...byParent.get(parentId) ?? [], row])
  }
  const reached: SubagentDescendantListEntry[] = []
  const visited = new Set<string>()
  const visit = (parentId: string): void => {
    for (const row of byParent.get(parentId) ?? []) {
      const id = String(row.id)
      // A catalog that loops back on itself must terminate the fake as well.
      if (visited.has(id)) continue
      visited.add(id)
      reached.push(row)
      visit(id)
    }
  }
  visit(root)
  return reached
}

/** A fake `listDescendants`/`prompt` seam that records every call. */
class FakeSubagent {
  readonly descendantCalls: DescendantCall[] = []
  readonly promptCalls: { request: SubagentPromptRequest; signal: AbortSignal }[] = []
  private descendants: SubagentDescendantListEntry[] = []
  private failure: unknown
  private settle: ((receipt: SubagentPromptReceipt) => void) | undefined
  private fail: ((error: unknown) => void) | undefined

  /**
   * Replace the whole tree the walk answers with, in parent-catalog pre-order.
   * @param rows - the descendants of {@link PARENT}, direct children first.
   */
  setDescendants(rows: readonly SubagentDescendantListEntry[]): void {
    this.descendants = [...rows]
  }

  /** Make every subsequent listing reject. */
  failDiscovery(error: unknown): void {
    this.failure = error
  }

  accept(messageId = 'm-1'): void {
    this.settle?.({ messageId: messageId as never })
  }

  listDescendants(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]> {
    this.descendantCalls.push({ parentSessionId, ...signal === undefined ? {} : { signal } })
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve(descendantsOf(this.descendants, String(parentSessionId)))
  }

  /**
   * The flat parent-catalog read, which this generation's presenter must never
   * perform: it carries no residency, no lineage, and no branch diagnostic, so a
   * catalog built from it would have to invent all three.
   *
   * The seam TYPE still names the operation because `HumanSubagentSeam` carries
   * `prompt` beside it, so the fake has to answer for it — but answering would
   * mean inventing `createdAt` and a mode this tree never supplied, and a fake
   * that quietly served discovery would be the compatibility path the migration
   * deleted. It refuses instead: any call here is that migration undone.
   */
  listChildren(): Promise<SubagentCatalogEntry[]> {
    throw new Error('listChildren is not the discovery seam this generation publishes')
  }

  prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt> {
    this.promptCalls.push({ request, signal })
    return new Promise<SubagentPromptReceipt>((resolve, reject) => {
      this.settle = resolve
      this.fail = reject
    })
  }

  refuse(error: unknown): void {
    this.fail?.(error)
  }
}

/** A fake bounded session read surface over in-memory logs. */
class FakeSession {
  readonly listEventsCalls: SessionId[] = []
  readonly readEventCalls: { request: SessionEventReadRequest; signal?: AbortSignal }[] = []
  private readonly logs = new Map<string, SessionEvent[]>()
  private held = false
  private failure: unknown
  private readonly pending: (() => void)[] = []

  setLog(sessionId: string, events: readonly SessionEvent[]): void {
    this.logs.set(sessionId, [...events])
  }

  /** Make every subsequent `readEvent` reject with this error. */
  failReads(error: unknown): void {
    this.failure = error
  }

  /** Defer every subsequent `readEvent` until {@link releaseRead}. */
  holdReads(): void {
    this.held = true
  }

  /** Resolve one held `readEvent`, oldest first. */
  releaseRead(index = 0): void {
    this.pending.splice(index, 1)[0]?.()
  }

  listEvents(sessionId: SessionId): Promise<SessionEventRecord[]> {
    this.listEventsCalls.push(sessionId)
    return Promise.resolve(recordsFor(this.logs.get(String(sessionId)) ?? []))
  }

  readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow> {
    this.readEventCalls.push({ request, ...signal === undefined ? {} : { signal } })
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const window = this.windowFor(request)
    if (!this.held) return Promise.resolve(window)
    return new Promise<SessionEventWindow>(resolve => { this.pending.push(() => { resolve(window) }) })
  }

  private windowFor(request: SessionEventReadRequest): SessionEventWindow {
    const log = this.logs.get(String(request.sessionId)) ?? []
    const at = log.findIndex(event => event.seq === request.seq)
    const start = Math.max(0, at - (request.before ?? 0))
    const end = Math.min(log.length - 1, at + (request.after ?? 0))
    const events = at < 0 ? [] : log.slice(start, end + 1)
    return {
      session: { id: request.sessionId } as SessionEventWindow['session'],
      inheritedEventCount: 0 as never,
      target: (at < 0 ? undefined : log[at]) as SessionEvent,
      events,
      startSeq: (events[0]?.seq ?? request.seq) as SessionSeq,
      endSeq: (events[events.length - 1]?.seq ?? request.seq) as SessionSeq,
    }
  }
}

/** Build lightweight records the way Harness would. */
function recordsFor(events: readonly SessionEvent[]): SessionEventRecord[] {
  return events.map(event => ({
    sessionId: 'child' as never,
    seq: event.seq,
    type: event.type,
    time: event.time,
    surface: 'current',
  }) as SessionEventRecord)
}

/** An in-memory overlay stack with the real `pushOverlay` contract. */
function testSlots(): {
  overlays: TuiOverlay[]
  pushOverlay(overlay: TuiOverlay): () => void
  top(): TuiOverlay | undefined
} {
  const overlays: TuiOverlay[] = []
  return {
    overlays,
    pushOverlay(overlay) {
      overlays.push(overlay)
      overlay.mounted?.()
      return () => {
        const at = overlays.indexOf(overlay)
        if (at >= 0) overlays.splice(at, 1)
        overlay.dispose?.()
      }
    },
    top: () => overlays.at(-1),
  }
}

describe('durable subagent discovery vocabulary', () => {
  it('keeps a settled stored continuable child browsable and follow-up-capable', () => {
    const reading = catalogReading([child('c', 'continuable', 'inactive')])
    const row = firstRow(reading)
    expect(row).toEqual({
      kind: 'child', id: 'c', mode: 'continuable', residency: 'stored', hasChildren: false, label: 'c',
    })
    expect(subagentRowOpenable(row)).toBe(true)
    expect(subagentRowFollowUp(row, true)).toBe(true)
  })

  it('offers a one-shot child inspection but no follow-up', () => {
    const reading = catalogReading([child('one', 'one-shot', 'inactive')])
    const row = firstRow(reading)
    expect(subagentRowOpenable(row)).toBe(true)
    expect(subagentRowFollowUp(row, true)).toBe(false)
  })

  it('reports the absence of the prompt seam rather than a one-shot mode', () => {
    const reading = catalogReading([child('c', 'continuable', 'running')])
    expect(subagentRowFollowUp(firstRow(reading), false)).toBe(false)
  })

  it('keeps diagnostics distinct and honest instead of dropping them', () => {
    const reading = catalogReading([diagnostic('broken', 'corrupt'), child('ok', 'continuable', 'running')])
    const rows = reading.kind === 'ready' ? reading.rows : []
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ kind: 'diagnostic', id: 'broken', reason: 'corrupt' })
    expect(diagnosticReasonWord('corrupt')).not.toBe(diagnosticReasonWord('unavailable'))
    expect(subagentRowOpenable(firstRow(reading))).toBe(false)
  })

  it('keys selection by the durable child id, stable across reordering', () => {
    const keysOf = (reading: ReturnType<typeof catalogReading>): string[] =>
      reading.kind === 'ready' ? reading.rows.map(subagentRowKey) : []
    expect(keysOf(catalogReading([
      child('a', 'continuable', 'running'), child('b', 'continuable', 'inactive'),
    ]))).toEqual(['child:a', 'child:b'])
    expect(keysOf(catalogReading([
      child('b', 'continuable', 'inactive'), child('a', 'continuable', 'running'),
    ]))).toEqual(['child:b', 'child:a'])
  })

  it('does not count a settled durable child as active work', async () => {
    const subagents = new FakeSubagent()
    subagents.setDescendants([child('settled', 'continuable', 'inactive')])
    const agent = { session: { id: 'parent' } } as unknown as Agent
    const work = new HarnessWork({ agent, subagents: subagents as never, invalidate: () => {} })
    await flush()
    expect(work.snapshot().subagents).toEqual([])
    expect(activeWorkCount(work.snapshot())).toBe(0)
    work.dispose()
  })
})

describe('subagent conversation catalog overlay', () => {
  it('renders durable facts, opens a child, and refreshes on request', () => {
    const inspected: string[] = []
    let refreshes = 0
    const overlay = createSubagentCatalogOverlay({
      reading: () => catalogReading([
        child('c', 'continuable', 'inactive', 'review task', true),
        diagnostic('broken', 'corrupt'),
      ]),
      origin: 'root',
      inspect: id => { inspected.push(id) },
      refresh: () => { refreshes += 1 },
      close: () => {},
      invalidate: () => {},
    })
    const plain = stripAnsi(overlay.render(80, 20).join('\n'))
    expect(plain).toContain('review task')
    expect(plain).toContain('continuable')
    expect(plain).toContain('stored')
    expect(plain).toContain('has children')
    expect(plain).toContain('unreadable record')
    overlay.handleKey(key('enter'))
    expect(inspected).toEqual(['c'])
    overlay.handleKey(text('r'))
    expect(refreshes).toBe(1)
  })

  it('never opens a diagnostic row and follows selection by identity', () => {
    const inspected: string[] = []
    let rows: SubagentListEntry[] = [diagnostic('broken', 'corrupt'), child('ok', 'continuable', 'running')]
    const overlay = createSubagentCatalogOverlay({
      reading: () => catalogReading(rows),
      origin: 'root',
      inspect: id => { inspected.push(id) },
      refresh: () => {},
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(80, 20)
    overlay.handleKey(key('enter'))
    expect(inspected).toEqual([])
    overlay.handleKey(key('down'))
    // Reorder and re-render: the aim stays on `ok`, not on a screen position.
    rows = [child('ok', 'continuable', 'running'), diagnostic('broken', 'corrupt')]
    overlay.render(80, 20)
    overlay.handleKey(key('enter'))
    expect(inspected).toEqual(['ok'])
  })

  it('lets the cursor land on a diagnostic row without opening it', () => {
    const inspected: string[] = []
    const overlay = createSubagentCatalogOverlay({
      reading: () => catalogReading([diagnostic('broken', 'unavailable'), child('ok', 'continuable', 'running')]),
      origin: 'root',
      inspect: id => { inspected.push(id) },
      refresh: () => {},
      close: () => {},
      invalidate: () => {},
    })
    const plain = stripAnsi(overlay.render(80, 20).join('\n'))
    expect(plain.split('\n').some(row => row.includes('❯') && row.includes('broken'))).toBe(true)
    overlay.handleKey(key('enter'))
    expect(inspected).toEqual([])
  })

  it('escapes a discovery failure message before drawing it', () => {
    const overlay = createSubagentCatalogOverlay({
      reading: () => ({ kind: 'failed', message: 'boom\u001b[2Jinjected' }),
      origin: 'root',
      inspect: () => {},
      refresh: () => {},
      close: () => {},
      invalidate: () => {},
    })
    const plain = stripAnsi(overlay.render(80, 20).join('\n'))
    expect(plain).toContain('^[')
    expect(plain).not.toContain('\u001b')
  })

  it('bounds every row at narrow and short geometries', () => {
    const overlay = createSubagentCatalogOverlay({
      reading: () => catalogReading([child('c', 'continuable', 'running', 'a deliberately long 标签 label')]),
      origin: 'root',
      inspect: () => {},
      refresh: () => {},
      close: () => {},
      invalidate: () => {},
    })
    for (const columns of [14, 18, 24, 30, 40, 60, 80]) {
      for (const rows of [3, 5, 7, 8, 10, 12, 24]) {
        expect(physicalRows(overlay.render(columns, rows), columns).length).toBeLessThanOrEqual(rows)
      }
    }
  })

  it('escapes control sequences in a child label', () => {
    const overlay = createSubagentCatalogOverlay({
      reading: () => catalogReading([child('c', 'continuable', 'running', 'bad\u001b[2Jlabel')]),
      origin: 'root',
      inspect: () => {},
      refresh: () => {},
      close: () => {},
      invalidate: () => {},
    })
    const plain = stripAnsi(overlay.render(80, 20).join('\n'))
    expect(plain).toContain('^[')
    expect(plain).not.toContain('\u001b')
  })
})

describe('subagent conversation inspector overlay', () => {
  function inspector(overrides: Partial<Parameters<typeof createSubagentConversationOverlay>[0]> = {}) {
    const calls = { older: 0, newer: 0, refresh: 0, message: [] as string[] }
    const overlay = createSubagentConversationOverlay({
      child: () => ({ kind: 'child', id: 'c', mode: 'continuable', residency: 'resident', hasChildren: false, label: 'review' }),
      reading: () => ({ kind: 'ready', events: [message(1, 'the child said hello')], hasOlder: true, hasNewer: true, stale: false }),
      followUp: true,
      steer: true,
      loadOlder: () => { calls.older += 1 },
      loadNewer: () => { calls.newer += 1 },
      refresh: () => { calls.refresh += 1 },
      message: delivery => { calls.message.push(delivery) },
      notice: new SurfaceNotice(1_000),
      close: () => {},
      invalidate: () => {},
      ...overrides,
    })
    return { overlay, calls }
  }

  it('shows durable facts and the loaded conversation window', () => {
    const { overlay } = inspector()
    const plain = stripAnsi(overlay.render(80, 24).join('\n'))
    expect(plain).toContain('review')
    expect(plain).toContain('continuable · resident')
    expect(plain).toContain('session  c')
    expect(plain).toContain('the child said hello')
  })

  it('routes m, s, [, ], and r to their presenters', () => {
    const { overlay, calls } = inspector()
    overlay.handleKey(text('m'))
    overlay.handleKey(text('s'))
    overlay.handleKey(text('['))
    overlay.handleKey(text(']'))
    overlay.handleKey(text('r'))
    expect(calls.message).toEqual(['queue', 'steer'])
    expect(calls.older).toBe(1)
    expect(calls.newer).toBe(1)
    expect(calls.refresh).toBe(1)
  })

  it('offers no follow-up or steer for a one-shot child', () => {
    const { overlay, calls } = inspector({
      child: () => ({ kind: 'child', id: 'one', mode: 'one-shot', residency: 'stored', hasChildren: false }),
      followUp: false,
      steer: false,
    })
    const plain = stripAnsi(overlay.render(80, 24).join('\n'))
    expect(plain).not.toContain('m message')
    expect(plain).not.toContain('s steer')
    overlay.handleKey(text('m'))
    overlay.handleKey(text('s'))
    expect(calls.message).toEqual([])
  })

  it('bounds every row at narrow and short geometries', () => {
    const { overlay } = inspector({
      reading: () => ({
        kind: 'ready',
        events: [message(1, 'a very long conversation body that must wrap and never leak a row 标签')],
        hasOlder: false,
        hasNewer: true,
        stale: false,
      }),
    })
    for (const columns of [14, 18, 24, 30, 40, 60, 80]) {
      for (const rows of [3, 5, 7, 8, 10, 12, 24]) {
        expect(physicalRows(overlay.render(columns, rows), columns).length).toBeLessThanOrEqual(rows)
      }
    }
  })

  it('advertises page directions only when the reading offers them', () => {
    const footerFor = (reading: SubagentTranscriptReading): string => {
      const overlay = createSubagentConversationOverlay({
        child: () => ({ kind: 'child', id: 'c', mode: 'continuable', residency: 'resident', hasChildren: false, label: 'review' }),
        reading: () => reading,
        followUp: true,
        steer: true,
        loadOlder: () => {},
        loadNewer: () => {},
        refresh: () => {},
        message: () => {},
        notice: new SurfaceNotice(1_000),
        close: () => {},
        invalidate: () => {},
      })
      return stripAnsi(overlay.render(160, 24).join('\n'))
    }
    const ready = (hasOlder: boolean, hasNewer: boolean): SubagentTranscriptReading =>
      ({ kind: 'ready', events: [message(1, 'x')], hasOlder, hasNewer, stale: false })
    expect(footerFor(ready(true, false))).toContain('[ older')
    expect(footerFor(ready(true, false))).not.toContain('] newer')
    expect(footerFor(ready(true, true))).toContain('[ older')
    expect(footerFor(ready(true, true))).toContain('] newer')
    expect(footerFor(ready(false, true))).toContain('] newer')
    expect(footerFor(ready(false, true))).not.toContain('[ older')
    expect(footerFor(ready(false, false))).not.toContain('[ older')
    expect(footerFor(ready(false, false))).not.toContain('] newer')
    for (const state of [
      { kind: 'loading' },
      { kind: 'unavailable' },
      { kind: 'empty' },
      { kind: 'failed', message: 'boom' },
    ] as const) {
      const plain = footerFor(state)
      expect(plain).not.toContain('[ older')
      expect(plain).not.toContain('] newer')
      expect(plain).toContain('r refresh')
    }
  })
})

describe('subagent message composer', () => {
  function composer(
    submit: (
      value: string,
      signal: AbortSignal,
    ) => Promise<{ kind: 'accepted'; messageId: string } | { kind: 'failed'; message: string } | { kind: 'unavailable' }>,
  ) {
    const accepted: string[] = []
    let closes = 0
    const overlay = createSubagentMessageOverlay({
      childLabel: 'review',
      delivery: 'queue',
      submit,
      onAccepted: id => { accepted.push(id) },
      close: () => { closes += 1 },
      invalidate: () => {},
    })
    return { overlay, accepted, closes: () => closes }
  }

  it('edits through the renderer Composer and submits on Enter', async () => {
    const requests: string[] = []
    const { overlay } = composer(async value => {
      requests.push(value)
      return { kind: 'accepted', messageId: 'm-1' }
    })
    overlay.handleKey(text('h'))
    overlay.handleKey(text('i'))
    expect(stripAnsi(overlay.render(80, 12).join('\n'))).toContain('❯ hi')
    overlay.handleKey(key('enter'))
    await flush()
    expect(requests).toEqual(['hi'])
  })

  it('keeps the draft until Harness accepts, then clears and closes', async () => {
    let resolve: ((outcome: { kind: 'accepted'; messageId: string }) => void) | undefined
    const { overlay, accepted, closes } = composer(() => new Promise(resolvePromise => { resolve = resolvePromise }))
    overlay.handleKey(text('h'))
    overlay.handleKey(text('i'))
    overlay.handleKey(key('enter'))
    expect(stripAnsi(overlay.render(80, 12).join('\n'))).toContain('❯ hi')
    expect(closes()).toBe(0)
    resolve?.({ kind: 'accepted', messageId: 'm-9' })
    await flush()
    expect(accepted).toEqual(['m-9'])
    expect(closes()).toBe(1)
  })

  it('keeps the draft and shows Harness’s reason after a refusal', async () => {
    const { overlay, closes } = composer(async () => ({
      kind: 'failed', message: 'subagent/not-resumable: no continuation state',
    }))
    overlay.handleKey(text('h'))
    overlay.handleKey(key('enter'))
    await flush()
    const plain = stripAnsi(overlay.render(80, 12).join('\n'))
    expect(plain).toContain('not-resumable')
    expect(plain).toContain('❯ h')
    expect(closes()).toBe(0)
  })

  it('aborts an in-flight submission when the surface is disposed', () => {
    const signals: AbortSignal[] = []
    const { overlay } = composer((_value, signal) => {
      signals.push(signal)
      return new Promise(() => {})
    })
    overlay.handleKey(text('h'))
    overlay.handleKey(key('enter'))
    overlay.dispose?.()
    expect(signals[0]?.aborted).toBe(true)
  })

  it('keeps the cursor row visible for a long multiline draft', () => {
    const { overlay } = composer(async () => ({ kind: 'accepted', messageId: 'm-1' }))
    const lines = Array.from({ length: 12 }, (_, index) => `line ${String(index).padStart(2, '0')}`)
    overlay.handleKey({ kind: 'paste', text: lines.join('\n') } as Key)
    const plain = stripAnsi(overlay.render(80, 8).join('\n'))
    // The caret row — the end of the paste — is inside the window, and the
    // window did not stay pinned to the draft's first line.
    expect(plain).toContain('█')
    expect(plain).toContain('line 11')
    expect(plain).not.toContain('line 00')
    expect(physicalRows(overlay.render(80, 8), 80).length).toBeLessThanOrEqual(8)
  })

  it('scrolls the draft window with the cursor on Up and back on Down', () => {
    const { overlay } = composer(async () => ({ kind: 'accepted', messageId: 'm-1' }))
    const lines = Array.from({ length: 12 }, (_, index) => `line ${String(index).padStart(2, '0')}`)
    overlay.handleKey({ kind: 'paste', text: lines.join('\n') } as Key)
    overlay.render(80, 8)
    expect(stripAnsi(overlay.render(80, 8).join('\n'))).toContain('line 11')
    for (let press = 0; press < 5; press += 1) overlay.handleKey(key('up'))
    const up = stripAnsi(overlay.render(80, 8).join('\n'))
    expect(up).not.toContain('line 11')
    expect(up).toContain('line 06')
    for (let press = 0; press < 5; press += 1) overlay.handleKey(key('down'))
    expect(stripAnsi(overlay.render(80, 8).join('\n'))).toContain('line 11')
  })

  it('keeps the cursor visible when a row is exactly full, through wide content', () => {
    const { overlay } = composer(async () => ({ kind: 'accepted', messageId: 'm-1' }))
    // Establish the width the body renders at before moving/editing.
    overlay.render(40, 8)
    const firstRowText = 'a'.repeat(chromeWidth(40) - BOX_CHROME_COLUMNS - 2)
    const draft = [
      firstRowText,
      '漢'.repeat(20),
      '😀'.repeat(4),
      'tail',
    ].join('\n')
    overlay.handleKey({ kind: 'paste', text: draft } as Key)
    const plain = stripAnsi(overlay.render(40, 8).join('\n'))
    expect(plain).toContain('tail')
    expect(plain).toContain('█')
    for (const rows of [4, 6, 8, 12]) {
      expect(physicalRows(overlay.render(40, rows), 40).length).toBeLessThanOrEqual(rows)
    }
  })
})

describe('bounded transcript paging', () => {
  /** A log far larger than the retained page. */
  const LARGE = TRANSCRIPT_PAGE * 5

  function seeded(): FakeSession {
    const session = new FakeSession()
    session.setLog('c', Array.from({ length: LARGE }, (_, index) => message(index + 1, `event ${String(index + 1).padStart(3, '0')}`)))
    return session
  }

  it('round-trips 53 events through a partial oldest page without gaps or overlap', async () => {
    const session = new FakeSession()
    session.setLog('c', Array.from({ length: 53 }, (_, i) => message(i + 1, `event ${i + 1}`)))
    let state = await readTranscriptTail(session, 'c' as never)
    const index = state.index
    const ranges = [[30, 53], [6, 29], [1, 5], [6, 29], [30, 53]] as const
    for (let step = 0; step < ranges.length; step += 1) {
      if (step > 0) state = await (step <= 2 ? readTranscriptOlder : readTranscriptNewer)(session, 'c' as never, state)
      const [start, end] = ranges[step]!
      expect(state.events.length).toBeLessThanOrEqual(TRANSCRIPT_PAGE)
      expect(state.events.map(event => event.seq)).toEqual(Array.from({ length: end - start + 1 }, (_, i) => start + i))
      expect(state).toMatchObject({ startSeq: start, endSeq: end, hasOlder: start > 1, hasNewer: end < 53 })
      expect(transcriptReading(state)).toMatchObject({ hasOlder: start > 1, hasNewer: end < 53 })
      expect(state.index).toBe(index)
    }
  })

  it('reuses the captured index for both directions until refresh', async () => {
    const session = seeded()
    let state = await readTranscriptTail(session, 'c' as never)
    const index = state.index
    for (let i = 0; i < 4; i += 1) state = await readTranscriptOlder(session, 'c' as never, state)
    expect(state.hasOlder).toBe(false)
    const reads = session.readEventCalls.length
    state = await readTranscriptOlder(session, 'c' as never, state)
    expect(session.readEventCalls).toHaveLength(reads)
    for (let i = 0; i < 4; i += 1) {
      state = await readTranscriptNewer(session, 'c' as never, state)
      expect(state.events.length).toBeLessThanOrEqual(TRANSCRIPT_PAGE)
      expect(state.index).toBe(index)
    }
    expect(state.hasNewer).toBe(false)
    await readTranscriptNewer(session, 'c' as never, state)
    expect(session.readEventCalls).toHaveLength(9)
    expect(session.listEventsCalls).toHaveLength(1)
    for (const { request } of session.readEventCalls) {
      expect((request.before ?? 0) + (request.after ?? 0) + 1).toBeLessThanOrEqual(TRANSCRIPT_PAGE)
    }
    await readTranscriptTail(session, 'c' as never)
    expect(session.listEventsCalls).toHaveLength(2)
  })

  it('keeps newer inside captured 72-event history until explicit refresh', async () => {
    const session = new FakeSession()
    const log = Array.from({ length: 75 }, (_, i) => message(i + 1, `event ${i + 1}`))
    session.setLog('c', log.slice(0, 72))
    let state = await readTranscriptTail(session, 'c' as never)
    expect(state).toMatchObject({ startSeq: 49, endSeq: 72, hasOlder: true, hasNewer: false })
    state = await readTranscriptOlder(session, 'c' as never, state)
    expect(state).toMatchObject({ startSeq: 25, endSeq: 48, hasOlder: true, hasNewer: true })
    session.setLog('c', log)
    state = await readTranscriptNewer(session, 'c' as never, { ...state, stale: true })
    expect(state.events.map(event => event.seq)).toEqual(log.slice(48, 72).map(event => event.seq))
    expect(state).toMatchObject({ endSeq: 72, hasNewer: false, stale: true })
    expect(session.listEventsCalls).toHaveLength(1)
    state = await readTranscriptTail(session, 'c' as never)
    expect(state.events.map(event => event.seq)).toEqual(log.slice(51).map(event => event.seq))
    expect(state).toMatchObject({ endSeq: 75, hasNewer: false, stale: false })
  })

  it('anchors newer requests at the captured destination end', async () => {
    const session = seeded()
    const tail = await readTranscriptTail(session, 'c' as never)
    const older = await readTranscriptOlder(session, 'c' as never, tail)
    await readTranscriptNewer(session, 'c' as never, older)
    expect(session.readEventCalls.at(-1)?.request).toEqual({ sessionId: 'c', seq: LARGE, before: 23, after: 0 })
  })

  it('preserves stale through both pure paging helpers', async () => {
    const session = seeded()
    const tail = await readTranscriptTail(session, 'c' as never)
    const older = await readTranscriptOlder(session, 'c' as never, { ...tail, stale: true })
    expect(older.stale).toBe(true)
    expect((await readTranscriptNewer(session, 'c' as never, older)).stale).toBe(true)
  })

  it('offers neither direction for a single page', async () => {
    const session = new FakeSession()
    session.setLog('c', [message(0, 'first')])
    const state = await readTranscriptTail(session, 'c' as never)
    expect(state).toMatchObject({ startSeq: 0, endSeq: 0, hasOlder: false, hasNewer: false })
    await readTranscriptOlder(session, 'c' as never, state)
    await readTranscriptNewer(session, 'c' as never, state)
    expect(session.readEventCalls).toHaveLength(1)
  })

  it('retains at most one page of full event bodies while paging backward', async () => {
    const session = seeded()
    let state = await readTranscriptTail(session, 'c' as never)
    expect(state.events.length).toBeLessThanOrEqual(TRANSCRIPT_PAGE)
    expect(state.hasOlder).toBe(true)
    let presses = 0
    while (state.hasOlder && presses < LARGE) {
      state = await readTranscriptOlder(session, 'c' as never, state)
      expect(state.events.length).toBeLessThanOrEqual(TRANSCRIPT_PAGE)
      const seqs = state.events.map(event => event.seq)
      expect(new Set(seqs).size).toBe(seqs.length)
      presses += 1
    }
    expect(state.hasOlder).toBe(false)
    expect(state.events[0]?.seq).toBe(1)
    // No full-log body read: every window asked for at most one page.
    expect(session.readEventCalls.every(call => (call.request.before ?? 0) <= TRANSCRIPT_PAGE - 1)).toBe(true)
  })
})

describe('subagent conversation presenter', () => {
  /** A seam a profile does not mount, named rather than faked. */
  type MissingSeam = 'subagents' | 'query'

  /**
   * Mount a presenter over the fake seams.
   * @param missing - seams this case leaves out of the deps object entirely,
   *   which is the only way a profile without `ctx.subagents` or
   *   `ctx.sessionQuery` is expressed: `exactOptionalPropertyTypes` makes
   *   "absent" and "present and undefined" different objects.
   * @param overrides - substitutions for seams that stay mounted.
   * @returns the stack, the fakes, the presenter, and the event triggers.
   */
  function mount(missing: readonly MissingSeam[] = [], overrides: Partial<SubagentsPresenterDeps> = {}) {
    const slots = testSlots()
    const subagents = new FakeSubagent()
    const session = new FakeSession()
    let lifecycle: (() => void) | undefined
    let sessionEvent: ((sessionId: string) => void) | undefined
    const p = createSubagentsPresenter({
      slots,
      parentSessionId: PARENT as never,
      invalidate: () => {},
      ...missing.includes('subagents') ? {} : { subagents },
      ...missing.includes('query') ? {} : { query: session },
      onLifecycle: listener => { lifecycle = listener; return () => {} },
      onSessionEvent: listener => { sessionEvent = listener; return () => {} },
      ...overrides,
    })
    return {
      slots, subagents, session, p,
      fireLifecycle: () => { lifecycle?.() },
      fireSessionEvent: (id: string) => { sessionEvent?.(id) },
    }
  }

  it('reads a child transcript only when the inspector opens', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'hello'), message(2, 'again')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('down'))
    slots.top()?.handleKey(key('up'))
    expect(session.listEventsCalls).toEqual([])
    expect(session.readEventCalls).toEqual([])
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(session.listEventsCalls.map(String)).toEqual(['c'])
    expect(session.readEventCalls).toHaveLength(1)
    expect(session.readEventCalls[0]?.request.before).toBe(TRANSCRIPT_PAGE - 1)
  })

  it('aborts an inspector’s in-flight read when it closes', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    session.holdReads()
    slots.top()?.handleKey(key('enter'))
    await flush()
    const signal = session.readEventCalls[0]?.signal
    expect(signal?.aborted).toBe(false)
    slots.top()?.handleKey(key('escape'))
    expect(signal?.aborted).toBe(true)
  })

  it('discards a transcript read that a newer refresh superseded', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'old')])
    p.open()
    await flush()
    session.holdReads()
    slots.top()?.handleKey(key('enter'))
    await flush()
    // The log grows, then a second refresh starts. The FIRST read (seq 1)
    // settles last and must not overwrite the newer window.
    session.setLog('c', [message(1, 'old'), message(2, 'new')])
    slots.top()?.handleKey(text('r'))
    await flush()
    session.releaseRead(1)
    await flush()
    session.releaseRead(0)
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('new')
  })

  it('keeps a settled child listed after a lifecycle edge reloads discovery', async () => {
    const { slots, subagents, p, fireLifecycle } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    p.open()
    await flush()
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    fireLifecycle()
    await flush()
    expect(stripAnsi(slots.overlays[0]?.render(80, 20).join('\n') ?? '')).toContain('stored')
  })

  it('queues a follow-up through the human prompt authority with the exact address', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running', 'review')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    slots.top()?.handleKey(text('m'))
    slots.top()?.handleKey(text('h'))
    slots.top()?.handleKey(text('i'))
    slots.top()?.handleKey(key('enter'))
    const call = subagents.promptCalls[0]
    expect(call?.request).toMatchObject({
      parentSessionId: 'parent',
      childSessionId: 'c',
      mode: 'continuable',
      delivery: 'queue',
      content: [{ type: 'text', text: 'hi' }],
    })
    expect(typeof call?.request.requestId).toBe('string')
    expect(call?.signal).toBeInstanceOf(AbortSignal)
  })

  it('steers with delivery steer and never claims the child is running', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running', 'review')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).not.toContain('running')
    slots.top()?.handleKey(text('s'))
    slots.top()?.handleKey(text('h'))
    slots.top()?.handleKey(key('enter'))
    expect(subagents.promptCalls[0]?.request.delivery).toBe('steer')
  })

  it('shows an accepted receipt without inserting an optimistic row', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    const before = session.readEventCalls.length
    slots.top()?.handleKey(text('m'))
    slots.top()?.handleKey(text('z'))
    slots.top()?.handleKey(key('enter'))
    subagents.accept()
    await flush()
    const plain = stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')
    expect(plain).toContain('Follow-up accepted')
    expect(plain).not.toContain('z')
    expect(session.readEventCalls.length).toBe(before)
  })

  it('never offers interrupt from the durable inspector, even for a continuable child', async () => {
    const { slots, subagents, session, p } = mount()
    // A settled/stored continuable child is exactly the case residency cannot
    // prove a live turn for, so no interrupt affordance may appear here.
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).not.toContain('interrupt')
    const reads = session.readEventCalls.length
    slots.top()?.handleKey(text('k'))
    expect(session.readEventCalls.length).toBe(reads)
    expect(slots.overlays).toHaveLength(2)
  })

  it('degrades honestly when ctx.subagents is absent', async () => {
    const { slots, p } = mount(['subagents'])
    p.open()
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 20).join('\n') ?? '')).toContain('not installed')
  })

  it('degrades honestly when ctx.sessionQuery is absent', async () => {
    const { slots, subagents, p } = mount(['query'])
    subagents.setDescendants([child('c', 'continuable', 'running')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 20).join('\n') ?? '')).toContain('Session query is not installed')
  })

  it('performs no discovery or transcript read on a timer', async () => {
    vi.useFakeTimers()
    try {
      const { subagents, session, p } = mount()
      subagents.setDescendants([child('c', 'continuable', 'running')])
      session.setLog('c', [message(1, 'hello')])
      p.open()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(subagents.descendantCalls).toHaveLength(1)
      expect(session.listEventsCalls).toEqual([])
      expect(session.readEventCalls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('records staleness on a selected child event without re-reading', async () => {
    const { slots, subagents, session, p, fireSessionEvent } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    const reads = session.readEventCalls.length
    const beforeStale = stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')
    expect(beforeStale).not.toContain('new events')
    fireSessionEvent('c')
    fireSessionEvent('unrelated')
    expect(session.readEventCalls.length).toBe(reads)
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('new events')
  })

  it('refreshes an open inspector’s residency facts after a discovery reload', async () => {
    const { slots, subagents, session, p, fireLifecycle } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('resident')
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    fireLifecycle()
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('stored')
  })

  it('degrades honestly when discovery rejects', async () => {
    const { slots, subagents, p } = mount()
    subagents.failDiscovery(new Error('projection registry unavailable'))
    p.open()
    await flush()
    const plain = stripAnsi(slots.top()?.render(80, 20).join('\n') ?? '')
    expect(plain).toContain('Discovery failed')
    expect(plain).toContain('projection registry unavailable')
  })

  it('reads discovery from the recursive seam, addressed to its own parent', async () => {
    const { subagents, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    p.open()
    await flush()
    // The flat parent-catalog read refuses in this fake, so reaching a catalog
    // at all is the evidence that discovery went through the descendant walk
    // and not back through the operation that lost residency, lineage, and
    // branch diagnostics.
    expect(subagents.descendantCalls).toHaveLength(1)
    expect(subagents.descendantCalls.map(call => String(call.parentSessionId))).toEqual([PARENT])
  })

  it('lists a depth-one branch diagnostic with its reason and never opens it', async () => {
    const { slots, subagents, session, p } = mount()
    // The reason the migration exists at all: a branch the recursive walk could
    // not interpret is a row now, where the old flat read could not produce one.
    subagents.setDescendants([diagnostic('broken', 'corrupt')])
    p.open()
    await flush()
    const plain = stripAnsi(slots.top()?.render(80, 20).join('\n') ?? '')
    expect(plain).toContain('broken')
    expect(plain).toContain('unreadable record')
    // No conversation exists behind a branch with no readable child catalog, so
    // the footer drops the action Enter refuses.
    expect(plain).not.toContain('enter inspect')
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(session.listEventsCalls).toEqual([])
    expect(slots.overlays).toHaveLength(1)
  })

  it('keeps a grandchild out of the direct-child catalog', async () => {
    const { slots, subagents, p } = mount()
    // `hasChildren` is the honest parent row: that child's own catalog does hold
    // a direct child, which is the only reason the deeper rows exist.
    subagents.setDescendants([
      child('c', 'continuable', 'running', 'review', true),
      deeper(child('g', 'one-shot', 'inactive', 'grandchild'), 'c', 2),
      deeper(diagnostic('deep', 'unsupported'), 'c', 2),
    ])
    // The walk really does hand both deeper rows back, so what follows is the
    // presenter's cut rather than a fixture that happened to withhold them.
    await expect(subagents.listDescendants(PARENT as never)).resolves.toHaveLength(3)
    p.open()
    await flush()
    const plain = stripAnsi(slots.top()?.render(80, 20).join('\n') ?? '')
    expect(plain).toContain('review')
    expect(plain).toContain('has children')
    // A deeper row belongs to another parent's branch, and being a diagnostic
    // is not a way around the cut.
    expect(plain).not.toContain('grandchild')
    expect(plain).not.toContain('deep')
    expect(plain).not.toContain('unsupported record')
  })

  it('pops exactly one surface per escape, back to the prior catalog', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(slots.overlays).toHaveLength(2)
    slots.top()?.handleKey(key('escape'))
    expect(slots.overlays).toHaveLength(1)
    expect(stripAnsi(slots.top()?.render(80, 20).join('\n') ?? '')).toContain('Subagent conversations')
    slots.top()?.handleKey(key('escape'))
    expect(slots.overlays).toHaveLength(0)
  })

  it('offers no follow-up composer for a one-shot child', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('one', 'one-shot', 'inactive')])
    session.setLog('one', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).not.toContain('m message')
    slots.top()?.handleKey(text('m'))
    expect(slots.overlays).toHaveLength(2)
  })

  it('marks a window stale when an event arrives during its first read', async () => {
    const { slots, subagents, session, p, fireSessionEvent } = mount()
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    session.holdReads()
    slots.top()?.handleKey(key('enter'))
    await flush()
    // The event lands while `transcript.kind` is still `loading`, which the old
    // guard dropped outright.
    fireSessionEvent('c')
    session.releaseRead(0)
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('new events')
    expect(session.readEventCalls.length).toBe(1)
  })

  it('keeps the loaded page when the newer read rejects', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    session.setLog('c', Array.from(
      { length: TRANSCRIPT_PAGE * 2 },
      (_, index) => message(index + 1, `event ${String(index + 1).padStart(3, '0')}`),
    ))
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    slots.top()?.handleKey(text('['))
    await flush()
    session.failReads(new Error('newer unavailable'))
    slots.top()?.handleKey(text(']'))
    await flush()
    const plain = stripAnsi(slots.top()?.render(80, 80).join('\n') ?? '')
    expect(plain).toContain('event 001')
    expect(plain).toContain('event 024')
    expect(plain).not.toContain('event 025')
    expect(plain).toContain('Newer events failed: newer unavailable')
    expect(session.readEventCalls.at(-1)?.request.after).toBe(0)
    expect(session.listEventsCalls).toHaveLength(1)
    // A later gesture navigates from the retained page, not from a guessed one.
    session.failReads(undefined)
    slots.top()?.handleKey(text(']'))
    await flush()
    expect(session.readEventCalls.at(-1)?.request.seq).toBe(TRANSCRIPT_PAGE * 2)
  })

  it('publishes the winning read when two newer gestures race', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    session.setLog('c', Array.from(
      { length: TRANSCRIPT_PAGE * 3 },
      (_, index) => message(index + 1, `event ${String(index + 1).padStart(3, '0')}`),
    ))
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    slots.top()?.handleKey(text('['))
    await flush()
    session.holdReads()
    // Two gestures before either settles: both derive from the published
    // page, the newest-started read wins, and neither re-indexes.
    slots.top()?.handleKey(text(']'))
    slots.top()?.handleKey(text(']'))
    await flush()
    session.releaseRead(1)
    await flush()
    session.releaseRead(0)
    await flush()
    const plain = stripAnsi(slots.top()?.render(80, 80).join('\n') ?? '')
    expect(plain).toContain('event 049')
    expect(plain).not.toContain('event 025')
    // Both gestures read the same captured slice: the settled page advances
    // one page (the winner publishes), never two.
    expect(session.readEventCalls).toHaveLength(4)
    expect(session.readEventCalls[2]?.request).toEqual({ sessionId: 'c', seq: TRANSCRIPT_PAGE * 3, before: TRANSCRIPT_PAGE - 1, after: 0 })
    expect(session.readEventCalls[3]?.request).toEqual(session.readEventCalls[2]?.request)
    expect(session.listEventsCalls).toHaveLength(1)
  })

  it('discards a newer page superseded by an explicit refresh', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    const log = Array.from({ length: 75 }, (_, i) => message(i + 1, `event ${i + 1}`))
    session.setLog('c', log.slice(0, 72))
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    slots.top()?.handleKey(text('['))
    await flush()
    session.holdReads()
    slots.top()?.handleKey(text(']'))
    await flush()
    session.setLog('c', log)
    slots.top()?.handleKey(text('r'))
    await flush()
    session.releaseRead(1)
    await flush()
    session.releaseRead(0)
    await flush()
    const plain = stripAnsi(slots.top()?.render(160, 80).join('\n') ?? '')
    expect(plain).toContain('event 75')
    expect(plain).not.toContain('event 49')
    expect(session.listEventsCalls).toHaveLength(2)
  })

  it.each(['before', 'during'] as const)('preserves stale when an event arrives %s newer navigation', async timing => {
    const { slots, subagents, session, p, fireSessionEvent } = mount()
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    session.setLog('c', Array.from({ length: 72 }, (_, i) => message(i + 1, `event ${i + 1}`)))
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    if (timing === 'before') fireSessionEvent('c')
    slots.top()?.handleKey(text('['))
    await flush()
    if (timing === 'before') expect(stripAnsi(slots.top()?.render(160, 80).join('\n') ?? '')).toContain('new events')
    session.holdReads()
    slots.top()?.handleKey(text(']'))
    await flush()
    if (timing === 'during') fireSessionEvent('c')
    session.releaseRead()
    await flush()
    const plain = stripAnsi(slots.top()?.render(160, 80).join('\n') ?? '')
    expect(plain).toContain('event 72')
    expect(plain).toContain('new events')
    expect(session.listEventsCalls).toHaveLength(1)
    slots.top()?.handleKey(text('r'))
    await flush()
    session.releaseRead()
    await flush()
    expect(stripAnsi(slots.top()?.render(160, 80).join('\n') ?? '')).not.toContain('new events')
  })

  it('marks a replaced older page stale when an event arrives during its read', async () => {
    const { slots, subagents, session, p, fireSessionEvent } = mount()
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    session.setLog('c', Array.from({ length: TRANSCRIPT_PAGE * 2 }, (_, index) => message(index + 1, `e${index + 1}`)))
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    session.holdReads()
    slots.top()?.handleKey(text('['))
    await flush()
    fireSessionEvent('c')
    session.releaseRead(0)
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('new events')
  })

  it('does not go stale for another child’s event', async () => {
    const { slots, subagents, session, p, fireSessionEvent } = mount()
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    fireSessionEvent('other')
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).not.toContain('new events')
  })

  it('clears stale after a refresh with no intervening child event', async () => {
    const { slots, subagents, session, p, fireSessionEvent } = mount()
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    fireSessionEvent('c')
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('new events')
    slots.top()?.handleKey(text('r'))
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).not.toContain('new events')
  })

  it('replaces the rendered page rather than accumulating events', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    session.setLog('c', Array.from(
      { length: TRANSCRIPT_PAGE * 2 },
      (_, index) => message(index + 1, `event ${String(index + 1).padStart(3, '0')}`),
    ))
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    const tail = stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')
    expect(tail).toContain('event 025')
    expect(tail).not.toContain('event 001')
    slots.top()?.handleKey(text('['))
    await flush()
    const older = stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')
    expect(older).toContain('event 001')
    expect(older).not.toContain('event 025')
  })

  it('opens a durable child directly with no catalog surface underneath', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'hello')])
    p.openChild({ kind: 'child', id: 'c', mode: 'continuable', residency: 'resident', hasChildren: false })
    await flush()
    // Exactly the inspector: no catalog was mounted to get here, so none may
    // appear beneath it.
    expect(slots.overlays).toHaveLength(1)
    const plain = stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')
    expect(plain).toContain('Subagent · c')
    expect(plain).not.toContain('Subagent conversations')
    expect(session.listEventsCalls.map(String)).toEqual(['c'])
    expect(session.readEventCalls.map(call => String(call.request.sessionId))).toEqual(['c'])
    slots.top()?.handleKey(key('escape'))
    expect(slots.overlays).toHaveLength(0)
  })

  it('opens a direct inspector read-only when sessionQuery is absent', async () => {
    const { slots, subagents, p } = mount(['query'])
    subagents.setDescendants([child('c', 'continuable', 'running')])
    // No bounded read surface: the direct path must still show the inspector and
    // say so, exactly as the catalog path does, rather than refusing to open.
    p.openChild({ kind: 'child', id: 'c', mode: 'continuable', residency: 'resident', hasChildren: false })
    await flush()
    expect(slots.overlays).toHaveLength(1)
    const plain = stripAnsi(slots.top()?.render(80, 20).join('\n') ?? '')
    expect(plain).toContain('Session query is not installed')
    expect(plain).not.toContain('Subagent conversations')
    slots.top()?.handleKey(key('escape'))
    expect(slots.overlays).toHaveLength(0)
  })

  it('takes follow-up authority from the directly supplied row, not the catalog', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running', 'review')])
    session.setLog('c', [message(1, 'hello')])
    p.openChild({ kind: 'child', id: 'c', mode: 'continuable', residency: 'resident', hasChildren: false })
    await flush()
    const plain = stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')
    expect(plain).toContain('m message')
    expect(plain).toContain('s steer')
    slots.top()?.handleKey(text('m'))
    expect(slots.overlays).toHaveLength(2)
    slots.top()?.handleKey(text('h'))
    slots.top()?.handleKey(key('enter'))
    expect(subagents.promptCalls[0]?.request).toMatchObject({
      childSessionId: 'c',
      mode: 'continuable',
      delivery: 'queue',
      content: [{ type: 'text', text: 'h' }],
    })
    // Steer is the same authority with the other scheduling, addressed to the
    // same durable child supplied to openChild.
    slots.top()?.handleKey(key('escape'))
    slots.top()?.handleKey(text('s'))
    expect(slots.overlays).toHaveLength(2)
    slots.top()?.handleKey(text('g'))
    slots.top()?.handleKey(key('enter'))
    expect(subagents.promptCalls[1]?.request).toMatchObject({
      childSessionId: 'c',
      delivery: 'steer',
    })
  })

  it('keeps a directly opened one-shot child read-only', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('one', 'one-shot', 'inactive')])
    session.setLog('one', [message(1, 'hello')])
    p.openChild({ kind: 'child', id: 'one', mode: 'one-shot', residency: 'stored', hasChildren: false })
    await flush()
    const plain = stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')
    expect(plain).not.toContain('m message')
    expect(plain).not.toContain('s steer')
    slots.top()?.handleKey(text('m'))
    // No composer surface: the one-shot mode has no continuation authority.
    expect(slots.overlays).toHaveLength(1)
  })

  it('opens the same inspector through the catalog and pops back one level', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(slots.overlays).toHaveLength(2)
    // The catalog path resolves the row and converges on the same inspector.
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('Subagent · c')
    slots.top()?.handleKey(key('escape'))
    expect(slots.overlays).toHaveLength(1)
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('Subagent conversations')
    slots.top()?.handleKey(key('escape'))
    expect(slots.overlays).toHaveLength(0)
  })

  it('writes the truthful escape for the catalog origin, not the stack depth', async () => {
    const root = mount()
    root.subagents.setDescendants([child('c', 'continuable', 'running')])
    root.p.open()
    await flush()
    expect(stripAnsi(root.slots.top()?.render(80, 20).join('\n') ?? '')).toContain('esc close')
    const work = mount()
    work.subagents.setDescendants([child('c', 'continuable', 'running')])
    work.p.openFromWork()
    await flush()
    expect(stripAnsi(work.slots.top()?.render(80, 20).join('\n') ?? '')).toContain('esc back')
  })

  it('returns from a Work-nested catalog child to the catalog, then to Work', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running', 'review')])
    session.setLog('c', [message(1, 'hello')])
    // Work is the surface below in the assembled app; here the stack proves the
    // nested catalog is what Esc reveals rather than the child skipping it.
    p.openFromWork()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(slots.overlays).toHaveLength(2)
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('Subagent · review')
    slots.top()?.handleKey(key('escape'))
    expect(slots.overlays).toHaveLength(1)
    expect(stripAnsi(slots.top()?.render(80, 20).join('\n') ?? '')).toContain('Subagent conversations')
    slots.top()?.handleKey(key('escape'))
    expect(slots.overlays).toHaveLength(0)
  })

  it('refreshes a direct inspector’s residency without pushing a catalog', async () => {
    const { slots, subagents, session, p, fireLifecycle } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'hello')])
    p.openChild({ kind: 'child', id: 'c', mode: 'continuable', residency: 'resident', hasChildren: false })
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('resident')
    subagents.setDescendants([child('c', 'continuable', 'inactive')])
    fireLifecycle()
    await flush()
    const plain = stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')
    expect(plain).toContain('stored')
    expect(plain).not.toContain('Subagent conversations')
    expect(slots.overlays).toHaveLength(1)
  })

  it('never closes a direct inspector or opens a catalog when discovery fails', async () => {
    const { slots, subagents, session, p, fireLifecycle } = mount()
    subagents.setDescendants([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'hello')])
    p.openChild({ kind: 'child', id: 'c', mode: 'continuable', residency: 'resident', hasChildren: false })
    await flush()
    subagents.failDiscovery(new Error('projection registry unavailable'))
    fireLifecycle()
    await flush()
    expect(slots.overlays).toHaveLength(1)
    const plain = stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')
    expect(plain).toContain('Subagent · c')
    expect(plain).not.toContain('Subagent conversations')
  })
})

describe('subagent catalog footer truthfulness', () => {
  it('advertises enter inspect only for a focused openable child, per origin', () => {
    for (const origin of ['root', 'work'] as const) {
      let reading: SubagentCatalogReading = catalogReading([child('c', 'continuable', 'running')])
      const overlay = createSubagentCatalogOverlay({
        reading: () => reading,
        origin,
        inspect: () => {},
        refresh: () => {},
        close: () => {},
        invalidate: () => {},
      })
      const footer = (): string => stripAnsi(overlay.render(80, 20).join('\n'))
      const escape = origin === 'work' ? 'esc back' : 'esc close'
      expect(footer()).toContain('enter inspect')
      const absent: SubagentCatalogReading[] = [
        { kind: 'loading' },
        { kind: 'unavailable' },
        { kind: 'failed', message: 'boom' },
        catalogReading([]),
        catalogReading([diagnostic('broken', 'corrupt')]),
      ]
      for (const state of absent) {
        reading = state
        const plain = footer()
        expect(plain).not.toContain('enter inspect')
        expect(plain).toContain('r refresh')
        expect(plain).toContain(escape)
      }
    }
  })
})

describe('subagent navigation chrome', () => {
  it('uses width-stable ASCII rather than the ambiguous arrow glyphs', () => {
    const catalog = createSubagentCatalogOverlay({
      reading: () => catalogReading([child('c', 'continuable', 'running')]),
      origin: 'root',
      inspect: () => {},
      refresh: () => {},
      close: () => {},
      invalidate: () => {},
    })
    const conversation = createSubagentConversationOverlay({
      child: () => ({ kind: 'child', id: 'c', mode: 'continuable', residency: 'resident', hasChildren: false, label: 'review' }),
      reading: () => ({ kind: 'ready', events: [message(1, 'x')], hasOlder: false, hasNewer: false, stale: false }),
      followUp: true,
      steer: true,
      loadOlder: () => {},
      loadNewer: () => {},
      refresh: () => {},
      message: () => {},
      notice: new SurfaceNotice(1_000),
      close: () => {},
      invalidate: () => {},
    })
    for (const overlay of [catalog, conversation]) {
      expect(stripAnsi(overlay.render(80, 24).join('\n'))).not.toMatch(/[\u2190-\u21ff]/u)
    }
  })
})
