/**
 * Focused tests for the durable subagent-conversation catalog, inspector, and
 * human queue/steer path.
 *
 * The authority boundary is the point: discovery is `listChildren`, inspection
 * is a bounded `listEvents`+`readEvent` read, and a human follow-up is
 * `ctx.subagents.prompt` — never the model-authored `sendMessage`. These tests
 * fake only the Harness seams and drive the real presenter and overlays.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEventReadRequest, SessionEventRecord, SessionEventWindow } from '@deepseek-ai/dsh-session-query'
import type { SubagentListEntry, SubagentPromptReceipt, SubagentPromptRequest } from '@deepseek-ai/dsh-subagent'
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
import {
  createSubagentCatalogOverlay,
  createSubagentConversationOverlay,
  createSubagentMessageOverlay,
} from '../src/subagents/overlay.ts'
import { createSubagentsPresenter, type SubagentsPresenterDeps } from '../src/subagents/presenter.ts'
import { readTranscriptOlder, readTranscriptTail, TRANSCRIPT_PAGE } from '../src/subagents/transcript.ts'
import { HarnessWork } from '../src/work/index.ts'
import { activeWorkCount } from '../src/work/model.ts'

/** One durable direct-child discovery entry. */
function child(
  id: string,
  mode: 'one-shot' | 'continuable',
  activity: 'running' | 'inactive',
  label = id,
  hasChildren = false,
): SubagentListEntry {
  return { kind: 'child', id: id as never, mode, activity, label, hasChildren }
}

/** One uninterpretable discovery candidate. */
function diagnostic(id: string, reason: 'corrupt' | 'unavailable' | 'unsupported'): SubagentListEntry {
  return { kind: 'diagnostic', id: id as never, reason }
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

/** A fake `listChildren`/`prompt` seam that records every call. */
class FakeSubagent {
  readonly listCalls: SessionId[] = []
  readonly promptCalls: { request: SubagentPromptRequest; signal: AbortSignal }[] = []
  private children: SubagentListEntry[] = []
  private failure: unknown
  private settle: ((receipt: SubagentPromptReceipt) => void) | undefined
  private fail: ((error: unknown) => void) | undefined

  setChildren(entries: readonly SubagentListEntry[]): void {
    this.children = [...entries]
  }

  failList(error: unknown): void {
    this.failure = error
  }

  accept(messageId = 'm-1'): void {
    this.settle?.({ messageId: messageId as never })
  }

  listChildren(parentSessionId: SessionId): Promise<SubagentListEntry[]> {
    this.listCalls.push(parentSessionId)
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve(this.children)
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
  private readonly pending: (() => void)[] = []

  setLog(sessionId: string, events: readonly SessionEvent[]): void {
    this.logs.set(sessionId, [...events])
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
    const row = reading.kind === 'ready' ? reading.rows[0] : undefined
    expect(row).toEqual({
      kind: 'child', id: 'c', mode: 'continuable', residency: 'stored', hasChildren: false, label: 'c',
    })
    expect(subagentRowOpenable(row!)).toBe(true)
    expect(subagentRowFollowUp(row!, true)).toBe(true)
  })

  it('offers a one-shot child inspection but no follow-up', () => {
    const reading = catalogReading([child('one', 'one-shot', 'inactive')])
    const row = reading.kind === 'ready' ? reading.rows[0] : undefined
    expect(subagentRowOpenable(row!)).toBe(true)
    expect(subagentRowFollowUp(row!, true)).toBe(false)
  })

  it('reports the absence of the prompt seam rather than a one-shot mode', () => {
    const reading = catalogReading([child('c', 'continuable', 'running')])
    const row = reading.kind === 'ready' ? reading.rows[0] : undefined
    expect(subagentRowFollowUp(row!, false)).toBe(false)
  })

  it('keeps diagnostics distinct and honest instead of dropping them', () => {
    const reading = catalogReading([diagnostic('broken', 'corrupt'), child('ok', 'continuable', 'running')])
    const rows = reading.kind === 'ready' ? reading.rows : []
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ kind: 'diagnostic', id: 'broken', reason: 'corrupt' })
    expect(diagnosticReasonWord('corrupt')).not.toBe(diagnosticReasonWord('unavailable'))
    expect(subagentRowOpenable(rows[0]!)).toBe(false)
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
    subagents.setChildren([child('settled', 'continuable', 'inactive')])
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
    const calls = { older: 0, refresh: 0, message: [] as string[] }
    const overlay = createSubagentConversationOverlay({
      child: () => ({ kind: 'child', id: 'c', mode: 'continuable', residency: 'resident', hasChildren: false, label: 'review' }),
      reading: () => ({ kind: 'ready', events: [message(1, 'the child said hello')], hasOlder: true, stale: false }),
      followUp: true,
      steer: true,
      loadOlder: () => { calls.older += 1 },
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

  it('routes m, s, [, and r to their presenters', () => {
    const { overlay, calls } = inspector()
    overlay.handleKey(text('m'))
    overlay.handleKey(text('s'))
    overlay.handleKey(text('['))
    overlay.handleKey(text('r'))
    expect(calls.message).toEqual(['queue', 'steer'])
    expect(calls.older).toBe(1)
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
    expect(plain).not.toContain('k interrupt')
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
        stale: false,
      }),
    })
    for (const columns of [14, 18, 24, 30, 40, 60, 80]) {
      for (const rows of [3, 5, 7, 8, 10, 12, 24]) {
        expect(physicalRows(overlay.render(columns, rows), columns).length).toBeLessThanOrEqual(rows)
      }
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
  function mount(overrides: Partial<SubagentsPresenterDeps> = {}) {
    const slots = testSlots()
    const subagents = new FakeSubagent()
    const session = new FakeSession()
    let lifecycle: (() => void) | undefined
    let sessionEvent: ((sessionId: string) => void) | undefined
    const p = createSubagentsPresenter({
      slots,
      parentSessionId: 'parent' as never,
      invalidate: () => {},
      subagents,
      query: session,
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
    subagents.setChildren([child('c', 'continuable', 'running')])
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
    subagents.setChildren([child('c', 'continuable', 'running')])
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
    subagents.setChildren([child('c', 'continuable', 'running')])
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
    subagents.setChildren([child('c', 'continuable', 'running')])
    p.open()
    await flush()
    subagents.setChildren([child('c', 'continuable', 'inactive')])
    fireLifecycle()
    await flush()
    expect(stripAnsi(slots.overlays[0]?.render(80, 20).join('\n') ?? '')).toContain('stored')
  })

  it('queues a follow-up through the human prompt authority with the exact address', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setChildren([child('c', 'continuable', 'running', 'review')])
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
    subagents.setChildren([child('c', 'continuable', 'running', 'review')])
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
    subagents.setChildren([child('c', 'continuable', 'running')])
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
    subagents.setChildren([child('c', 'continuable', 'inactive')])
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
    const { slots, p } = mount({ subagents: undefined })
    p.open()
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 20).join('\n') ?? '')).toContain('not installed')
  })

  it('degrades honestly when ctx.sessionQuery is absent', async () => {
    const { slots, subagents, p } = mount({ query: undefined })
    subagents.setChildren([child('c', 'continuable', 'running')])
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
      subagents.setChildren([child('c', 'continuable', 'running')])
      session.setLog('c', [message(1, 'hello')])
      p.open()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(subagents.listCalls).toHaveLength(1)
      expect(session.listEventsCalls).toEqual([])
      expect(session.readEventCalls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('records staleness on a selected child event without re-reading', async () => {
    const { slots, subagents, session, p, fireSessionEvent } = mount()
    subagents.setChildren([child('c', 'continuable', 'running')])
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
    subagents.setChildren([child('c', 'continuable', 'running')])
    session.setLog('c', [message(1, 'hello')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('resident')
    subagents.setChildren([child('c', 'continuable', 'inactive')])
    fireLifecycle()
    await flush()
    expect(stripAnsi(slots.top()?.render(80, 24).join('\n') ?? '')).toContain('stored')
  })

  it('degrades honestly when discovery rejects', async () => {
    const { slots, subagents, p } = mount()
    subagents.failList(new Error('projection registry unavailable'))
    p.open()
    await flush()
    const plain = stripAnsi(slots.top()?.render(80, 20).join('\n') ?? '')
    expect(plain).toContain('Discovery failed')
    expect(plain).toContain('projection registry unavailable')
  })

  it('never opens a diagnostic row and reads nothing for it', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setChildren([diagnostic('broken', 'corrupt')])
    p.open()
    await flush()
    slots.top()?.handleKey(key('enter'))
    await flush()
    expect(session.listEventsCalls).toEqual([])
    expect(slots.overlays).toHaveLength(1)
  })

  it('pops exactly one surface per escape, back to the prior catalog', async () => {
    const { slots, subagents, session, p } = mount()
    subagents.setChildren([child('c', 'continuable', 'running')])
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
    subagents.setChildren([child('one', 'one-shot', 'inactive')])
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
    subagents.setChildren([child('c', 'continuable', 'inactive')])
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

  it('marks a replaced older page stale when an event arrives during its read', async () => {
    const { slots, subagents, session, p, fireSessionEvent } = mount()
    subagents.setChildren([child('c', 'continuable', 'inactive')])
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
    subagents.setChildren([child('c', 'continuable', 'inactive')])
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
    subagents.setChildren([child('c', 'continuable', 'inactive')])
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
    subagents.setChildren([child('c', 'continuable', 'inactive')])
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
})

describe('subagent navigation chrome', () => {
  it('uses width-stable ASCII rather than the ambiguous arrow glyphs', () => {
    const catalog = createSubagentCatalogOverlay({
      reading: () => catalogReading([child('c', 'continuable', 'running')]),
      inspect: () => {},
      refresh: () => {},
      close: () => {},
      invalidate: () => {},
    })
    const conversation = createSubagentConversationOverlay({
      child: () => ({ kind: 'child', id: 'c', mode: 'continuable', residency: 'resident', hasChildren: false, label: 'review' }),
      reading: () => ({ kind: 'ready', events: [message(1, 'x')], hasOlder: false, stale: false }),
      followUp: true,
      steer: true,
      loadOlder: () => {},
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
