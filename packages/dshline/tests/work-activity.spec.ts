/**
 * Live per-child semantic activity for Work rows.
 *
 * The observer must reuse the exact vocabulary the main status line uses —
 * `modelPhaseAfter`, `primaryActivity`, and the shared pending-tool fold — and
 * must stay strictly event-driven: attach by exact Agent identity, dispose with
 * the epoch, and never invent activity for a run with no local Agent.
 * @module dshline/tests/work-activity
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ToolCallView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { stripAnsi } from '@dshline/renderer'
import { HarnessWork } from '../src/work/index.ts'
import { createWorkOverlay } from '../src/work/overlay.ts'
import type { WorkInterruptResult, WorkSnapshot, SubagentWorkItem } from '../src/work/model.ts'
import { activeElapsedMs, subagentDuration } from '../src/work/model.ts'

/** Standard successful interrupt response for overlay-only tests. */
const INTERRUPT_REQUESTED: WorkInterruptResult = { kind: 'requested', message: 'Interrupt requested.' }

/** A minimal typed session event builder. */
function ev(type: string, data: unknown = {}): SessionEvent {
  return { type, data, seq: 0, time: 0 } as unknown as SessionEvent
}

/** A tool call by id, resolved through the lookup by tool name. */
function call(id: string, name: string): SessionEvent {
  return ev('tool/call', { turn: 1, step: 1, callId: id, name, arguments: '{}' })
}

/** A tool result settling one exact call id. */
function result(id: string): SessionEvent {
  return ev('tool/result', {
    turn: 1, step: 1,
    message: { content: [{ type: 'tool', toolCallId: id, content: [] }] },
  })
}

/** One transient assistant-stream chunk frame from the child's own attempt. */
function fr(chunk: unknown): AssistantStreamFrame {
  return { type: 'chunk', attemptId: 's:1', revision: 1, index: 0, time: 0, chunk } as unknown as AssistantStreamFrame
}

/** A reasoning delta chunk. */
function reasoning(text = 'thinking…'): AssistantStreamFrame {
  return fr({ type: 'reasoning-delta', index: 0, text })
}

/** A text delta chunk. */
function text(): AssistantStreamFrame {
  return fr({ type: 'text-delta', index: 0, text: 'answer' })
}

/** A per-name resolved call presentation, proving classification rides the definition. */
function lookup(views: Record<string, ToolCallView>): (name: string, _agent: Agent) => ToolDefinition | undefined {
  return name => {
    const view = views[name]
    return view === undefined ? undefined : { presentCall: () => view } as unknown as ToolDefinition
  }
}

/** Which seqs a child's session was actually asked for. */
const reads = new WeakMap<Agent, number[]>()

/** The latest logged request envelope each synthetic child's session reports. */
const headers = new WeakMap<Agent, EpochHeader>()

/**
 * Log an effective route for one child, exactly as a `request/header` snapshot would.
 * @param child - the synthetic child.
 * @param config - the call configuration the envelope carries.
 */
function logRoute(child: Agent, config: LlmCallConfig): void {
  headers.set(child, { config })
}

/**
 * A synthetic in-process child Agent the registry resolves.
 *
 * The session answers the Session reads the observer makes — `seq`,
 * `inheritedEventCount`, and `eventAt` — and records every position asked
 * for, so a test can assert what was NOT read as well as what was folded.
 * @param id - the child's id.
 * @param status - the live agent status to report.
 * @param events - the child's whole log, inherited prefix first.
 * @param inheritedEventCount - how many leading events came from the fork parent.
 * @returns the child agent.
 */
function makeChild(
  id: string,
  status: 'idle' | 'running' = 'idle',
  events: readonly SessionEvent[] = [],
  inheritedEventCount = 0,
  options: AgentOptions = {},
): Agent {
  const asked: number[] = []
  const child = {
    id,
    status,
    options,
    session: {
      id,
      seq: events.length,
      inheritedEventCount,
      eventAt: (seq: number) => {
        asked.push(seq)
        return events[seq]
      },
      // The canonical fold of this session's `request/header` snapshots, which
      // is undefined until a request has actually been made.
      requestHeader: () => headers.get(child),
    },
  } as unknown as Agent
  reads.set(child, asked)
  return child
}

/**
 * A projection registry serving one exact cut per child session id.
 * @param cuts - client-visible values keyed by child session id.
 * @returns the narrow registry face `HarnessWork` consumes, plus the keys it asked for.
 */
function projectionRegistry(cuts: Record<string, ProjectionSnapshot['values']>): {
  projections: { snapshot: (session: Session, keys?: readonly string[]) => ProjectionSnapshot }
  keysAsked: () => readonly (readonly string[] | undefined)[]
} {
  const keysAsked: (readonly string[] | undefined)[] = []
  return {
    projections: {
      snapshot: (session, keys) => {
        keysAsked.push(keys)
        return { asOfSeq: 7 as ProjectionSnapshot['asOfSeq'], values: cuts[String(session.id)] ?? {} }
      },
    },
    keysAsked: () => keysAsked,
  }
}

/** A started subagent harness keyed to one real root context. */
function harness(
  rootCtx: Context,
  views: Record<string, ToolCallView>,
  registry: Map<string, Agent>,
  projections?: { snapshot: (session: Session, keys?: readonly string[]) => ProjectionSnapshot },
): {
  work: HarnessWork
  start: (info: { runId: string; provider: string; id: string; local: boolean }) => void
  end: (info: { runId: string; provider: string; id: string; local: boolean; stopReason: 'completed' }) => void
  invalidations: () => number
} {
  let invalidations = 0
  let started: ((info: { runId: string; provider: string; id: string; local: boolean }) => void) | undefined
  let ended: ((info: { runId: string; provider: string; id: string; local: boolean; stopReason: 'completed' }) => void) | undefined
  const root = { session: { id: 'root' }, ctx: rootCtx } as unknown as Agent
  const work = new HarnessWork({
    agent: root,
    subagents: {
      listChildren: async () => [],
      interrupt: () => {},
    } as unknown as SubagentRuntime,
    agents: { get: id => registry.get(String(id)) },
    resolveTool: lookup(views),
    onSubagentStart: listener => { started = listener as typeof started; return () => {} },
    onSubagentEnd: listener => { ended = listener as typeof ended; return () => {} },
    invalidate: () => { invalidations += 1 },
    ...projections === undefined ? {} : { projections: projections as never },
  })
  return {
    work,
    start: info => started?.(info),
    end: info => ended?.(info),
    invalidations: () => invalidations,
  }
}

describe('per-child semantic activity for Work', () => {
  it('folds a live child\'s activity with the main status vocabulary', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'codex', id: 'child', local: true })
    expect(work.snapshot().subagents[0]).toMatchObject({ id: 'child', busy: false })

    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('waiting')
    rootCtx.emit('agent/assistant-stream', { agent: child, frame: reasoning() })
    expect(work.snapshot().subagents[0]?.activityWord).toBe('thinking')
    rootCtx.emit('agent/assistant-stream', { agent: child, frame: text() })
    expect(work.snapshot().subagents[0]?.activityWord).toBe('responding')
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'reading', activityTitle: 'overlay.ts',
    })
    rootCtx.emit('agent/status', { agent: child, status: 'running' })
    expect(work.snapshot().subagents[0]).toMatchObject({ busy: true, agentStatus: 'running' })
    rootCtx.emit('session/event', child.session, result('c1'))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('waiting')
    work.dispose()
  })

  it('classifies terminal, diff, and undeclared tool presentations conservatively', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      bash: { card: 'terminal', title: 'pnpm test', cwd: '/w' },
      edit: { card: 'generic', title: 'edit model.ts', kind: 'edit' },
      custom: undefined as never,
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'bash'))
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'running', activityTitle: 'pnpm test',
    })
    rootCtx.emit('session/event', child.session, result('c1'))
    rootCtx.emit('session/event', child.session, call('c2', 'edit'))
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'editing', activityTitle: 'edit model.ts',
    })
    rootCtx.emit('session/event', child.session, result('c2'))
    // A tool with no declaration still folds: `working`, no invented title.
    rootCtx.emit('session/event', child.session, call('c3', 'custom'))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('working')
    expect(work.snapshot().subagents[0]?.activityTitle).toBeUndefined()
    work.dispose()
  })

  it('never invents activity for a remote run with no local Agent', () => {
    const rootCtx = new Context()
    const { work, start } = harness(rootCtx, {}, new Map())
    start({ runId: 'r1', provider: 'codex', id: 'remote', local: false })
    const row = work.snapshot().subagents[0]
    expect(row?.local).toBe(false)
    expect(row?.activityWord).toBeUndefined()
    expect(row?.busy).toBeUndefined()
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    const plain = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(plain).toContain('● codex')
    expect(plain).not.toContain('· thinking')
    expect(plain).not.toContain('· reading')
    work.dispose()
  })

  it('attaches when the child Agent becomes live after lifecycle publication', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map<string, Agent>()
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    // The child is NOT in the registry at the start edge.
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]?.activityWord).toBeUndefined()
    // The child publishes; `agent/created` attaches the observer.
    registry.set('child', child)
    rootCtx.emit('agent/created', { agent: child })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'reading', activityTitle: 'overlay.ts',
    })
    work.dispose()
  })

  it('disposes observers with the epoch and lets late events repaint nothing', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start, end, invalidations } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    const afterStart = invalidations()
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(invalidations()).toBeGreaterThan(afterStart)
    end({ runId: 'r1', provider: 'spawn', id: 'child', local: true, stopReason: 'completed' })
    expect(work.snapshot().subagents).toEqual([])
    const afterEnd = invalidations()
    // A late event for the settled epoch must not repaint a live region.
    rootCtx.emit('session/event', child.session, call('c2', 'read'))
    expect(invalidations()).toBe(afterEnd)
    work.dispose()
  })

  it('drops activity when the observed Agent disappears before the epoch settles', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('reading')
    rootCtx.emit('agent/disposed', { agent: child })
    const row = work.snapshot().subagents[0]
    expect(row?.id).toBe('child') // lifecycle edge still open
    expect(row?.activityWord).toBeUndefined() // but no stale granular activity
    expect(row?.busy).toBe(false)
    work.dispose()
  })

  it('renders the overview row with the child\'s live activity', () => {
    const rootCtx = new Context()
    const child = makeChild('child', 'running')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      bash: { card: 'terminal', title: 'pnpm test', cwd: '/w' },
    }, registry)
    start({ runId: 'r1', provider: 'codex', id: 'child', local: true })
    rootCtx.emit('agent/status', { agent: child, status: 'running' })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'bash'))
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    const plain = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(plain).toContain('· running pnpm test')
    work.dispose()
  })

  it('keeps independent activity states per child', () => {
    const rootCtx = new Context()
    const first = makeChild('first')
    const second = makeChild('second')
    const registry = new Map([
      ['first', first],
      ['second', second],
    ])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
      bash: { card: 'terminal', title: 'pnpm test', cwd: '/w' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'first', local: true })
    start({ runId: 'r2', provider: 'spawn', id: 'second', local: true })
    rootCtx.emit('session/event', first.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', first.session, call('c1', 'read'))
    rootCtx.emit('session/event', second.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', second.session, call('c2', 'bash'))
    const rows = work.snapshot().subagents
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('first')).toMatchObject({ activityWord: 'reading', activityTitle: 'overlay.ts' })
    expect(byId.get('second')).toMatchObject({ activityWord: 'running', activityTitle: 'pnpm test' })
    work.dispose()
  })

  it('lets the detail stage expose the same live facts it shows in the row', () => {
    const rootCtx = new Context()
    const child = makeChild('child', 'running')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'codex', id: 'child', local: true })
    rootCtx.emit('agent/status', { agent: child, status: 'running' })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(detail).toContain('reading · overlay.ts')
    expect(detail).toContain('backend  codex')
    expect(detail).toContain('agent status  running')
    work.dispose()
  })

  it('seeds busy from a child already running before the lifecycle start edge', () => {
    const rootCtx = new Context()
    // Harness can already be executing the child when dshline observes the
    // start: the state must come from the live Agent, never from a later
    // `agent/status` transition that may already have happened.
    const child = makeChild('child', 'running')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {}, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]).toMatchObject({
      busy: true,
      agentStatus: 'running',
    })
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    // The overview uses the animated mark immediately, with no synthetic
    // `agent/status` ever emitted.
    const plain = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(plain).toContain('◜')
    work.dispose()
  })

  it('reads an already-open current turn from the session at attach', () => {
    const rootCtx = new Context()
    // The child is mid-turn with a read already outstanding when Work attaches:
    // the session holds the turn's events, and the observer must fold exactly
    // that open-turn suffix rather than waiting for synthetic live events.
    const child = makeChild('child', 'running', [
      ev('turn/start', { turn: 1 }),
      call('c1', 'read'),
    ])
    const registry = new Map([['child', child]])
    const { work, start, invalidations } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'reading',
      activityTitle: 'overlay.ts',
      busy: true,
      agentStatus: 'running',
    })
    const afterStart = invalidations()
    // The reconstruction established the snapshot with ONE redraw: emitting no
    // further events must leave the redraw count untouched.
    expect(invalidations()).toBe(afterStart)
    work.dispose()
  })

  it('never folds a fork-inherited prefix as the child’s own activity', () => {
    const rootCtx = new Context()
    // `/work` says what the CHILD is doing. A subagent child opens with its
    // parent's history in front of its own, and the parent's outstanding read
    // is not this child's — so the backward scan stops at the durable lineage
    // cut, `inheritedEventCount`, and never reads below it. Deliberately NOT
    // `firstLiveSeq`: that marks where THIS process began appending, which
    // would also exclude the child's own setup writes.
    const child = makeChild('child', 'running', [
      ev('turn/start', { turn: 1 }),
      call('parent-read', 'read'),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], 3)
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'parent-file.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'waiting',
      busy: true,
    })
    expect(work.snapshot().subagents[0]?.activityTitle).toBeUndefined()
    // Not one inherited position was even read: the floor is a bound on the
    // scan, not a filter applied after materializing the log.
    expect(reads.get(child)?.filter(seq => seq < 3)).toEqual([])
    work.dispose()
  })

  it('folds the child’s own open turn that sits above the inherited prefix', () => {
    const rootCtx = new Context()
    // The same lineage cut must not hide the child's real work: everything
    // from `inheritedEventCount` up is the child's, setup writes included.
    const child = makeChild('child', 'running', [
      ev('turn/start', { turn: 1 }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ev('turn/start', { turn: 1 }),
      call('c1', 'read'),
    ], 2)
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'reading',
      activityTitle: 'overlay.ts',
    })
    // The scan stopped at the child's own `turn/start`, so seq 1 — the last
    // inherited event — was never read either.
    expect(reads.get(child)?.filter(seq => seq < 2)).toEqual([])
    work.dispose()
  })

  it('never turns historical turns into current activity at attach', () => {
    const rootCtx = new Context()
    // A cold-resumed child opens with a whole persisted log: a completed turn
    // and even an aborted interrupted turn must both stay history.
    const child = makeChild('child', 'idle', [
      ev('turn/start', { turn: 1 }),
      ev('assistant/message', { turn: 1, step: 1, stream: [] }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ev('turn/start', { turn: 2 }),
      // The durable trace of a turn interrupted mid-stream: an attempt that
      // settled without committing a surface message.
      ev('assistant/attempt', { turn: 2, step: 1, stream: [] }),
      ev('turn/end', { turn: 2, reason: { kind: 'aborted' } }),
    ])
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]?.activityWord).toBe('waiting')
    expect(work.snapshot().subagents[0]?.activityTitle).toBeUndefined()
    // Live folding still works afterwards.
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 3 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('reading')
    work.dispose()
  })

  it('clears pending tool activity when a turn ends without its results', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    expect(work.snapshot().subagents[0]).toMatchObject({
      activityWord: 'reading', activityTitle: 'overlay.ts',
    })
    // The turn is aborted; the call's result never arrives.
    rootCtx.emit('session/event', child.session, ev('turn/end', { turn: 1, reason: { kind: 'aborted' } }))
    const row = work.snapshot().subagents[0]
    expect(row?.activityWord).toBe('waiting')
    expect(row?.activityTitle).toBeUndefined()
    work.dispose()
  })

  it('still pairs a normal completed tool result across turn/end', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    rootCtx.emit('session/event', child.session, result('c1'))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('waiting')
    rootCtx.emit('session/event', child.session, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(work.snapshot().subagents[0]?.activityWord).toBe('waiting')
    expect(work.snapshot().subagents[0]?.activityTitle).toBeUndefined()
    work.dispose()
  })

  it('suppresses the operation title for an ambiguous mixed pending set', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
      bash: { card: 'terminal', title: 'pnpm test', cwd: '/w' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    rootCtx.emit('session/event', child.session, call('c2', 'bash'))
    const row = work.snapshot().subagents[0]
    expect(row?.activityWord).toBe('working') // mixed, conservative aggregate
    expect(row?.activityTitle).toBeUndefined() // no single call is "the" current one
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    const plain = overlay.render(80, 12).map(stripAnsi).join('\n')
    expect(plain).toContain('· working')
    expect(plain).not.toContain('· working pnpm test')
    work.dispose()
  })

  it('keeps the newest operation title for a same-activity pending set', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'overlay.ts', kind: 'read' },
      lookup: { card: 'generic', title: 'model.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('session/event', child.session, ev('turn/start', { turn: 1 }))
    rootCtx.emit('session/event', child.session, call('c1', 'read'))
    rootCtx.emit('session/event', child.session, call('c2', 'lookup'))
    const row = work.snapshot().subagents[0]
    expect(row?.activityWord).toBe('reading') // one activity, no ambiguity
    expect(row?.activityTitle).toBe('model.ts') // the newest declared title
    work.dispose()
  })

  it('falls back to the child\u2019s creation options before its first request', () => {
    const rootCtx = new Context()
    // Nothing has been logged yet, so `requestHeader()` is undefined and
    // `Agent.options` is the only route the child has.
    const child = makeChild('child', 'idle', [], 0, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const registry = new Map([['child', child]])
    const { work, start } = harness(rootCtx, {}, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]?.route).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    work.dispose()
  })

  it('lets the logged request envelope beat the creation options, and follows a later change', () => {
    const rootCtx = new Context()
    // Creation-time options that carry a reasoning effort of their own, so a
    // fold that mixed the two sources field by field would be caught below.
    const child = makeChild('child', 'running', [], 0, {
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' as never,
    })
    const registry = new Map([['child', child]])
    const { work, start, invalidations } = harness(rootCtx, {}, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    // The child made a request under a different route than it was created
    // with \u2014 a delegated model selection, or a route change. The header is
    // what the request actually used, so it wins outright.
    logRoute(child, { provider: 'openai-codex', model: 'gpt-x', reasoningEffort: 'high' as never })
    rootCtx.emit('session/event', child.session, ev('request/header', { header: { config: {} }, reason: 'initial' }))
    expect(work.snapshot().subagents[0]?.route).toEqual({
      provider: 'openai-codex', model: 'gpt-x', reasoningEffort: 'high',
    })
    const before = invalidations()
    // A later route change is another header snapshot; the same read returns it
    // and the header event itself is what asks the live region to repaint.
    logRoute(child, { provider: 'openrouter', model: 'some/model' })
    rootCtx.emit('session/event', child.session, ev('request/header', { header: { config: {} }, reason: 'change' }))
    expect(invalidations()).toBeGreaterThan(before)
    const row = work.snapshot().subagents[0]
    expect(row?.route).toEqual({ provider: 'openrouter', model: 'some/model' })
    // A reasoning effort the new envelope does not carry is GONE, not inherited
    // from the previous route or from the creation options.
    expect(row?.route?.reasoningEffort).toBeUndefined()
    work.dispose()
  })

  it('presents an arbitrary provider route with no provider-specific branch', () => {
    const rootCtx = new Context()
    // The whole point of the seam: `openai-codex` is a registered LLM route
    // like any other, so a child powered by it renders through exactly the code
    // an in-house route renders through. The BACKEND stays `spawn`.
    const child = makeChild('codex-child', 'running', [
      ev('turn/start', { turn: 1 }),
      call('c1', 'read'),
    ], 0, { provider: 'openai-codex', model: 'gpt-x' })
    const registry = new Map([['codex-child', child]])
    const { work, start } = harness(rootCtx, {
      read: { card: 'generic', title: 'connect/model.ts', kind: 'read' },
    }, registry)
    start({ runId: 'r1', provider: 'spawn', id: 'codex-child', local: true })
    expect(work.snapshot().subagents[0]).toMatchObject({
      provider: 'spawn',
      activityWord: 'reading',
      activityTitle: 'connect/model.ts',
      route: { provider: 'openai-codex', model: 'gpt-x' },
    })
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    const plain = overlay.render(100, 12).map(stripAnsi).join('\n')
    expect(plain).toContain('reading connect/model.ts · openai-codex/gpt-x')
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(100, 24).map(stripAnsi).join('\n')
    // Two authorities, two rows, two words.
    expect(detail).toContain('model  openai-codex/gpt-x')
    expect(detail).toContain('backend  spawn')
    work.dispose()
  })

  it('never invents a model route for a provider-managed child', () => {
    const rootCtx = new Context()
    const { work, start } = harness(rootCtx, {}, new Map(), projectionRegistry({
      // Even a cut that WOULD answer for this id is never asked for: there is
      // no local Agent, so there is no session this projection may speak for.
      remote: { subagentTiming: { settledMs: 90_000 }, tokenUsage: {
        uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      } },
    }).projections)
    start({ runId: 'r1', provider: 'codex', id: 'remote', local: false })
    const row = work.snapshot().subagents[0]
    expect(row?.route).toBeUndefined()
    expect(row?.timing).toBeUndefined()
    expect(row?.tokens).toBeUndefined()
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(detail).toContain('backend  codex')
    expect(detail).toContain('activity  provider-managed')
    expect(detail).not.toContain('model  ')
    expect(detail).not.toContain('tokens  ')
    expect(detail).not.toContain('active time  ')
    // The honest fallback clock, and only one of them.
    expect(detail).toContain('elapsed  ')
    work.dispose()
  })

  it('takes active time from the subagentTiming projection, advancing only while running', () => {
    const rootCtx = new Context()
    const child = makeChild('child', 'running')
    const registry = new Map([['child', child]])
    const now = Date.now()
    const { projections } = projectionRegistry({
      // One completed turn of 42s, plus an open turn that began 10s ago and
      // whose newest folded event was 4s ago.
      child: { subagentTiming: { settledMs: 42_000, active: { since: now - 10_000, through: now - 4_000 } } },
    })
    const { work, start } = harness(rootCtx, {}, registry, projections)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    rootCtx.emit('agent/status', { agent: child, status: 'running' })
    const running = work.snapshot().subagents[0]
    expect(running?.timing).toEqual({ settledMs: 42_000, active: { since: now - 10_000, through: now - 4_000 } })
    // Running: the open turn is still accruing, so it advances to the frame clock.
    expect(activeElapsedMs(running!.timing!, true, now)).toBe(52_000)
    // Not running: the interval will never close, so it freezes at the
    // projection's own bound rather than inventing six more seconds of work.
    expect(activeElapsedMs(running!.timing!, false, now)).toBe(48_000)
    expect(subagentDuration({ ...running!, busy: true }, now)).toEqual({ ms: 52_000, kind: 'active' })
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(detail).toContain('active time  ')
    // One clock per row: the observed epoch elapsed is not shown beside it.
    expect(detail).not.toContain('elapsed  ')
    work.dispose()
  })

  it('reports a settled child\u2019s active time with no open interval at all', () => {
    const rootCtx = new Context()
    const child = makeChild('child')
    const registry = new Map([['child', child]])
    const { projections } = projectionRegistry({ child: { subagentTiming: { settledMs: 7_500 } } })
    const { work, start } = harness(rootCtx, {}, registry, projections)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    const row = work.snapshot().subagents[0]
    expect(subagentDuration(row!, Date.now())).toEqual({ ms: 7_500, kind: 'active' })
    work.dispose()
  })

  it('sums the four disjoint token buckets, and omits the metric when unmetered', () => {
    const rootCtx = new Context()
    const metered = makeChild('metered')
    const bare = makeChild('bare')
    const registry = new Map([['metered', metered], ['bare', bare]])
    const { projections, keysAsked } = projectionRegistry({
      metered: { tokenUsage: {
        uncachedInputTokens: 40_000, outputTokens: 8_000, cacheReadTokens: 200, cacheWriteTokens: 0,
      } },
      // A registered timing unit with NO token meter mounted: the key is simply
      // absent, which is capability absence rather than a child that spent nothing.
      bare: { subagentTiming: { settledMs: 1_000 } },
    })
    const { work, start } = harness(rootCtx, {}, registry, projections)
    start({ runId: 'r1', provider: 'spawn', id: 'metered', local: true })
    start({ runId: 'r2', provider: 'spawn', id: 'bare', local: true })
    const rows = new Map(work.snapshot().subagents.map(row => [row.id, row]))
    expect(rows.get('metered')?.tokens).toBe(48_200)
    expect(rows.get('bare')?.tokens).toBeUndefined()
    // The cheap projection cut, narrowed to the two keys \u2014 never a
    // `tokenMeter.measure()`, which prices the whole surface per call. The
    // harness mounts no meter at all, so a call would have thrown.
    expect(keysAsked().every(keys => keys?.join() === 'subagentTiming,tokenUsage')).toBe(true)
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    // The shared `formatTokens` the whole frontend uses, not a Work-local one.
    expect(overlay.render(80, 24).map(stripAnsi).join('\n')).toContain('tokens  48k')
    work.dispose()
  })

  it('omits the token fact for a child whose Session carries inherited history', () => {
    const rootCtx = new Context()
    // A fork-seeded child: three inherited events in front of its own work.
    // `subagentTiming` resets at the child's own descriptor, so it stays
    // child-relative; `tokenUsage` folds the complete log and does not, so the
    // same figure would include the parent's spend.
    const seeded = makeChild('seeded', 'running', [
      ev('turn/start', { turn: 1 }),
      ev('assistant/attempt', { turn: 1, step: 1, stream: [] }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], 3)
    const own = makeChild('own')
    const registry = new Map([['seeded', seeded], ['own', own]])
    const usage = {
      uncachedInputTokens: 58_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    const { projections } = projectionRegistry({
      seeded: { subagentTiming: { settledMs: 42_000 }, tokenUsage: usage },
      own: { subagentTiming: { settledMs: 42_000 }, tokenUsage: usage },
    })
    const { work, start } = harness(rootCtx, {}, registry, projections)
    start({ runId: 'r1', provider: 'fork', id: 'seeded', local: true })
    start({ runId: 'r2', provider: 'spawn', id: 'own', local: true })
    const rows = new Map(work.snapshot().subagents.map(row => [row.id, row]))
    expect(rows.get('seeded')?.tokens).toBeUndefined()
    // The asymmetry, on the same row: active time is still honest.
    expect(rows.get('seeded')?.timing).toEqual({ settledMs: 42_000 })
    // An unseeded child owns its whole log, so the same projection is its own.
    expect(rows.get('own')?.tokens).toBe(60_000)
    const overlay = createWorkOverlay({
      snapshot: () => work.snapshot(),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 24).map(stripAnsi).join('\n')
    expect(detail).toContain('session  seeded')
    expect(detail).toContain('active time  42s')
    expect(detail).not.toContain('tokens  ')
    work.dispose()
  })

  it('releases route, timing, and tokens with the child Agent, not later', () => {
    const rootCtx = new Context()
    const child = makeChild('child', 'running', [], 0, { provider: 'openai-codex', model: 'gpt-x' })
    const registry = new Map([['child', child]])
    const { projections } = projectionRegistry({ child: {
      subagentTiming: { settledMs: 5_000 },
      tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } })
    const { work, start } = harness(rootCtx, {}, registry, projections)
    start({ runId: 'r1', provider: 'spawn', id: 'child', local: true })
    expect(work.snapshot().subagents[0]?.route).toBeDefined()
    // The lifecycle edge stays open while the Agent goes. A route with no
    // activity beside it would read as a live worker; the row degrades whole.
    rootCtx.emit('agent/disposed', { agent: child })
    const row = work.snapshot().subagents[0]
    expect(row?.id).toBe('child')
    expect(row?.route).toBeUndefined()
    expect(row?.timing).toBeUndefined()
    expect(row?.tokens).toBeUndefined()
    expect(row?.activityWord).toBeUndefined()
    work.dispose()
  })
})
