/**
 * Tests for the Harness workflow authority behind `/work`.
 *
 * Two properties matter more than any single row: ownership comes from the
 * attached session's own durable `tool-workflow/*` records, and the live
 * `workflow/*` feed — which names a run but never a session — may only enrich a
 * run those records already proved is this window's.
 */

import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow/types'
import { stripAnsi } from '@dshline/renderer'
import { HarnessWorkflows } from '../src/work/workflows.ts'
import type { WorkflowObservation } from '../src/work/workflows.ts'
import { createWorkOverlay } from '../src/work/overlay.ts'
import type {
  SubagentWorkItem,
  WorkflowMemberItem,
  WorkflowWorkItem,
  WorkInterruptResult,
  WorkSnapshot,
} from '../src/work/model.ts'
import { activeWorkCount, looseSubagents, memberMark, workflowClaimedChildren, workMark, workSummary } from '../src/work/model.ts'

/** Standard successful interrupt response for overlay-only tests. */
const INTERRUPT_REQUESTED: WorkInterruptResult = { kind: 'requested', message: 'Interrupt requested.' }

/** A no-work projection overlay tests extend. */
const EMPTY: WorkSnapshot = { available: true, workflows: [], subagents: [], jobs: [] }

/** The session this window is attached to. */
const session = { id: 'root' } as unknown as Session

/** A DIFFERENT session instance, for the ownership boundary. */
const otherSession = { id: 'other' } as unknown as Session

/** The validated meta a live run publishes on every one of its events. */
const META: WorkflowMeta = {
  name: 'repo-audit',
  description: 'Audit Work architecture',
  phases: [{ title: 'Review' }, { title: 'Verification' }],
}

/** Build one durable session record without needing a real Session. */
function record(type: string, data: unknown, time = 1_000): SessionEvent {
  return { type, seq: 1, time, data } as unknown as SessionEvent
}

/** A live subagent epoch for the `childId` join. */
function subagentItem(overrides: Partial<SubagentWorkItem> = {}): SubagentWorkItem {
  return {
    id: 'child-1', source: 'subagent', runId: 'epoch-1', provider: 'spawn', local: true,
    state: 'running', startedAt: Date.now(), interruptible: false, ...overrides,
  }
}

/** A workflow row for presentation-focused tests. */
function workflowItem(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: 'run-1', source: 'workflow', label: 'repo-audit', startedAt: Date.now(),
    state: 'running', members: [], interruptible: false, ...overrides,
  }
}

/** A published workflow member. */
function memberItem(overrides: Partial<WorkflowMemberItem> = {}): WorkflowMemberItem {
  return { seq: 1, label: 'architecture', childId: 'child-1', ...overrides }
}

/** The projection plus the two feeds a test drives it through. */
function harness(options: { readonly live?: boolean } = {}): {
  readonly workflows: HarnessWorkflows
  readonly append: (session: Session, event: SessionEvent) => void
  readonly observe: (runId: string, meta: WorkflowMeta, observation: WorkflowObservation) => void
  readonly invalidations: () => number
  readonly subscriptions: () => number
} {
  let append: (session: Session, event: SessionEvent) => void = () => {}
  let observe: (runId: string, meta: WorkflowMeta, observation: WorkflowObservation) => void = () => {}
  let invalidations = 0
  let subscriptions = 0
  const workflows = new HarnessWorkflows({
    session,
    onSessionEvent: listener => {
      append = listener
      subscriptions += 1
      return () => { subscriptions -= 1 }
    },
    ...options.live === false
      ? {}
      : {
        onWorkflowObservation: listener => {
          observe = listener
          subscriptions += 1
          return () => { subscriptions -= 1 }
        },
      },
    invalidate: () => { invalidations += 1 },
  })
  return {
    workflows,
    append: (target, event) => { append(target, event) },
    observe: (runId, meta, observation) => { observe(runId, meta, observation) },
    invalidations: () => invalidations,
    subscriptions: () => subscriptions,
  }
}

/** Open one owned run, optionally with live meta already adopted. */
function openRun(driver: ReturnType<typeof harness>, runId = 'run-1', name = 'repo-audit'): void {
  driver.append(session, record('tool-workflow/run-start', { runId, name }))
}

describe('the owned-workflow projection', () => {
  it('opens a run from this session\'s own durable record', () => {
    const driver = harness()
    openRun(driver)
    const [run] = driver.workflows.items([])
    expect(run).toMatchObject({ source: 'workflow', id: 'run-1', label: 'repo-audit', state: 'running', members: [] })
    // The record's own time, so the elapsed reading agrees with the log.
    expect(run?.startedAt).toBe(1_000)
    expect(driver.invalidations()).toBe(1)
  })

  it('never opens a run from another session\'s log', () => {
    const driver = harness()
    driver.append(otherSession, record('tool-workflow/run-start', { runId: 'run-1', name: 'foreign' }))
    expect(driver.workflows.items([])).toEqual([])
    expect(driver.invalidations()).toBe(0)
  })

  it('drops every live event of a run this session does not own', () => {
    const driver = harness()
    // The whole point of the ownership gate: `workflow/*` payloads carry a run
    // identity and no session, so another window's run reaches this listener.
    driver.observe('foreign-run', META, { kind: 'meta' })
    driver.observe('foreign-run', META, { kind: 'phase', title: 'Review' })
    driver.observe('foreign-run', META, { kind: 'end', stopReason: 'completed', agentsStarted: 4 })
    expect(driver.workflows.items([])).toEqual([])
    expect(driver.invalidations()).toBe(0)
  })

  it('adopts the description from any live event of an owned run', () => {
    const driver = harness()
    openRun(driver)
    // `workflow/start` is emitted inside `workflowEngine.start()`, before the
    // tool appends its durable record, so the description has to be adoptable
    // from a later event of the same run.
    driver.observe('run-1', META, { kind: 'phase', title: 'Review' })
    const [run] = driver.workflows.items([])
    expect(run?.description).toBe('Audit Work architecture')
    expect(run?.phase).toBe('Review')
  })

  it('retains no declared phase vocabulary, only the phases members recorded', () => {
    const driver = harness()
    openRun(driver)
    driver.observe('run-1', META, { kind: 'meta' })
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 1, label: 'a', phase: 'Review', childId: 'c1',
    }))
    // `meta.phases` declares two phases; only the one a member actually entered
    // exists here. Keeping the declared list would put a phase on screen that
    // no member has reached, which reads as pending work Harness never published.
    expect(META.phases).toHaveLength(2)
    expect(Object.hasOwn(driver.workflows.items([])[0] ?? {}, 'declaredPhases')).toBe(false)
    expect(driver.workflows.items([])[0]?.members.map(member => member.phase)).toEqual(['Review'])
  })

  it('keeps the newest live log line', () => {
    const driver = harness()
    openRun(driver)
    driver.observe('run-1', META, { kind: 'log', message: 'first' })
    driver.observe('run-1', META, { kind: 'log', message: 'second' })
    expect(driver.workflows.items([])[0]?.log).toBe('second')
  })

  it('records members, their phases, and their settlements from durable records', () => {
    const driver = harness()
    openRun(driver)
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 1, label: 'architecture', phase: 'Review', childId: 'child-1',
    }))
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 2, label: 'renderer', phase: 'Review', childId: 'child-2',
    }))
    driver.append(session, record('tool-workflow/agent-end', { runId: 'run-1', seq: 1, outcome: 'completed' }))
    const [run] = driver.workflows.items([])
    expect(run?.members).toEqual([
      { seq: 1, label: 'architecture', childId: 'child-1', phase: 'Review', outcome: 'completed' },
      { seq: 2, label: 'renderer', childId: 'child-2', phase: 'Review' },
    ])
  })

  it('distinguishes an unphased member from one whose phase title is empty', () => {
    const driver = harness()
    openRun(driver)
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 1, label: 'unphased', childId: 'child-1',
    }))
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 2, label: 'empty', phase: '', childId: 'child-2',
    }))
    const members = driver.workflows.items([])[0]?.members ?? []
    expect(Object.hasOwn(members[0] ?? {}, 'phase')).toBe(false)
    expect(members[1]?.phase).toBe('')
  })

  it('ignores member records for a run it does not hold', () => {
    const driver = harness()
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'unknown', seq: 1, label: 'orphan', childId: 'child-1',
    }))
    driver.append(session, record('tool-workflow/agent-end', { runId: 'unknown', seq: 1, outcome: 'failed' }))
    expect(driver.workflows.items([])).toEqual([])
    expect(driver.invalidations()).toBe(0)
  })

  it('shows the terminal state the engine published, then leaves on the durable close', () => {
    const driver = harness()
    openRun(driver)
    driver.observe('run-1', META, { kind: 'end', stopReason: 'error', agentsStarted: 4 })
    expect(driver.workflows.items([])[0]).toMatchObject({ state: 'error', agentsStarted: 4 })
    // `tool-workflow/run-end` is appended AFTER `run.dispose()`, so the row
    // leaves when the run is quiescent — no timer decides that.
    driver.append(session, record('tool-workflow/run-end', { runId: 'run-1', stopReason: 'error' }))
    expect(driver.workflows.items([])).toEqual([])
  })

  it('stays useful with no live enrichment at all', () => {
    const driver = harness({ live: false })
    openRun(driver)
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 1, label: 'architecture', childId: 'child-1',
    }))
    const [run] = driver.workflows.items([])
    expect(run).toMatchObject({ label: 'repo-audit', state: 'running' })
    expect(run?.description).toBeUndefined()
    expect(run?.declaredPhases).toBeUndefined()
    expect(run?.members).toHaveLength(1)
  })

  it('joins a member to a live child only on the Harness-published childId', () => {
    const driver = harness()
    openRun(driver)
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 1, label: 'renderer', childId: 'child-1',
    }))
    const joined = driver.workflows.items([subagentItem({ id: 'child-1', busy: true })])
    expect(joined[0]?.members[0]?.subagent?.runId).toBe('epoch-1')
    // A different child session is not this member's, whatever else it looks like.
    const unrelated = driver.workflows.items([subagentItem({ id: 'child-9', label: 'renderer' })])
    expect(unrelated[0]?.members[0]?.subagent).toBeUndefined()
  })

  it('keeps a stopping child joined until its workflow member settles', () => {
    const driver = harness()
    openRun(driver)
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 1, label: 'renderer', childId: 'child-1',
    }))
    const stopping = subagentItem({ id: 'child-1', state: 'stopping' })
    const items = driver.workflows.items([stopping])
    expect(items[0]?.members[0]?.subagent?.state).toBe('stopping')
    expect(workflowClaimedChildren(items)).toEqual(new Set(['child-1']))
    expect(looseSubagents({ ...EMPTY, workflows: items, subagents: [stopping] })).toEqual([])
  })

  it('releases the child join once the member has settled, even while disposal remains', () => {
    const driver = harness()
    openRun(driver)
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 1, label: 'renderer', childId: 'child-1',
    }))
    driver.append(session, record('tool-workflow/agent-end', { runId: 'run-1', seq: 1, outcome: 'completed' }))
    const stopping = subagentItem({ id: 'child-1', state: 'stopping' })
    const items = driver.workflows.items([stopping])
    expect(items[0]?.members[0]?.subagent).toBeUndefined()
    expect(workflowClaimedChildren(items).size).toBe(0)
    // The retained epoch is now a flat lifecycle row, not a child of a settled
    // workflow member; disposal removes that row from the next snapshot.
    expect(looseSubagents({ ...EMPTY, workflows: items, subagents: [stopping] })).toEqual([stopping])
    expect(looseSubagents({ ...EMPTY, workflows: items, subagents: [] })).toEqual([])
  })

  it('reconstructs the same state from a replayed record sequence', () => {
    const feed = [
      record('tool-workflow/run-start', { runId: 'run-1', name: 'repo-audit' }),
      record('tool-workflow/agent-start', { runId: 'run-1', seq: 1, label: 'a', phase: 'Review', childId: 'c1' }),
      record('tool-workflow/agent-start', { runId: 'run-1', seq: 2, label: 'b', phase: 'Review', childId: 'c2' }),
      record('tool-workflow/agent-end', { runId: 'run-1', seq: 1, outcome: 'completed' }),
      record('tool-workflow/agent-end', { runId: 'run-1', seq: 2, outcome: 'cancelled' }),
    ]
    const driver = harness({ live: false })
    for (const event of feed) driver.append(session, event)
    expect(driver.workflows.items([])[0]?.members.map(member => member.outcome))
      .toEqual(['completed', 'cancelled'])
  })

  it('is idempotent under a duplicated record', () => {
    const driver = harness()
    openRun(driver)
    openRun(driver)
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 1, label: 'a', childId: 'c1',
    }))
    driver.append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 1, label: 'renamed', childId: 'c9',
    }))
    const [run] = driver.workflows.items([])
    expect(driver.workflows.items([])).toHaveLength(1)
    expect(run?.members).toEqual([{ seq: 1, label: 'a', childId: 'c1' }])
  })

  it('releases both feeds and forgets every run on disposal', () => {
    const driver = harness()
    openRun(driver)
    expect(driver.subscriptions()).toBe(2)
    driver.workflows.dispose()
    expect(driver.subscriptions()).toBe(0)
    expect(driver.workflows.items([])).toEqual([])
  })

  it('ignores an unrelated session event without asking for a redraw', () => {
    const driver = harness()
    driver.append(session, record('turn/start', { turn: 1 }))
    expect(driver.invalidations()).toBe(0)
  })
})

describe('workflow marks and counts', () => {
  it('animates a run only while one of its own members is observably executing', () => {
    const idle = workflowItem({ members: [memberItem({ subagent: subagentItem({ busy: false }) })] })
    expect(workMark(idle)).toBe('active')
    const executing = workflowItem({ members: [memberItem({ subagent: subagentItem({ busy: true }) })] })
    expect(workMark(executing)).toBe('executing')
    // A member with no observable child is a lifecycle fact, never an animation.
    expect(workMark(workflowItem({ members: [memberItem()] }))).toBe('active')
  })

  it('maps every published settlement to its own terminal mark', () => {
    expect(workMark(workflowItem({ state: 'completed' }))).toBe('completed')
    expect(workMark(workflowItem({ state: 'error' }))).toBe('failed')
    expect(workMark(workflowItem({ state: 'cancelled' }))).toBe('cancelled')
    expect(memberMark(memberItem({ outcome: 'completed' }))).toBe('completed')
    expect(memberMark(memberItem({ outcome: 'failed' }))).toBe('failed')
    expect(memberMark(memberItem({ outcome: 'cancelled' }))).toBe('cancelled')
  })

  it('counts a workflow in the status summary as its own authority', () => {
    expect(workSummary({ ...EMPTY, workflows: [workflowItem()] })).toBe('1 workflow')
    expect(workSummary({
      ...EMPTY,
      workflows: [workflowItem(), workflowItem({ id: 'run-2' })],
      subagents: [subagentItem()],
    })).toBe('2 workflows · 1 subagent')
  })

  it('never counts a workflow member a second time as a loose subagent', () => {
    const claimed = subagentItem({ id: 'child-1', runId: 'epoch-1' })
    const loose = subagentItem({ id: 'child-9', runId: 'epoch-9' })
    const snapshot: WorkSnapshot = {
      ...EMPTY,
      workflows: [workflowItem({ members: [memberItem({ subagent: claimed })] })],
      subagents: [claimed, loose],
    }
    // The status line counts what `/work` SHOWS: one workflow presenting its own
    // child, and the one subagent that belongs to no workflow.
    expect(looseSubagents(snapshot).map(item => item.id)).toEqual(['child-9'])
    expect(workSummary(snapshot)).toBe('1 workflow · 1 subagent')
    // The lifecycle question is a different one, and still counts both children.
    expect(activeWorkCount(snapshot)).toBe(2)
  })

  it('counts every subagent again once its workflow settles', () => {
    const claimed = subagentItem({ id: 'child-1', runId: 'epoch-1' })
    const settled: WorkSnapshot = {
      ...EMPTY,
      workflows: [workflowItem({ state: 'completed', members: [memberItem({ subagent: claimed })] })],
      subagents: [claimed],
    }
    expect(workSummary(settled)).toBe('1 workflow · 1 subagent')
  })
})

describe('the Work overview with workflows', () => {
  /** Render the overview of one snapshot. */
  function overview(snapshot: WorkSnapshot, columns = 80, rows = 24): string {
    const overlay = createWorkOverlay({
      snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {},
    })
    return overlay.render(columns, rows).map(stripAnsi).join('\n')
  }

  it('gives workflows their own section above subagents and jobs', () => {
    const text = overview({
      ...EMPTY,
      workflows: [workflowItem({ phase: 'Review', members: [memberItem(), memberItem({ seq: 2, childId: 'child-2' })] })],
      subagents: [subagentItem({ id: 'loose', runId: 'loose', provider: 'codex' })],
      jobs: [{
        id: 'bash-1', source: 'job', kind: 'bash', label: 'pnpm test', state: 'running',
        startedAt: Date.now(), ownership: 'this-session', interruptible: false,
      }],
    })
    expect(text.indexOf('Workflows')).toBeLessThan(text.indexOf('Subagents'))
    expect(text.indexOf('Subagents')).toBeLessThan(text.indexOf('Jobs'))
    expect(text).toContain('repo-audit')
  })

  it('claims a live member out of the flat Subagents section, and only that member', () => {
    const claimed = subagentItem({ id: 'child-1', runId: 'epoch-1', provider: 'spawn' })
    const loose = subagentItem({ id: 'child-9', runId: 'epoch-9', provider: 'codex', label: 'unrelated' })
    const text = overview({
      ...EMPTY,
      workflows: [workflowItem({ members: [memberItem({ subagent: claimed })] })],
      subagents: [claimed, loose],
    })
    // The workflow presents its own child; the flat section keeps the other one.
    expect(text).toContain('unrelated')
    expect(text.match(/Subagents/gu)).toHaveLength(1)
    expect(text).not.toContain('spawn')
  })

  it('shows an owned run even where neither work seam is mounted', () => {
    // `available` reports the two capability seams; a run is proved by this
    // session's own durable records instead, so it must not vanish with them.
    const text = overview({ ...EMPTY, available: false, workflows: [workflowItem()] })
    expect(text).toContain('repo-audit')
    expect(text).not.toContain('not installed in this profile')
  })

  it('never shows a denominator a Harness contract cannot supply', () => {
    const text = overview({
      ...EMPTY,
      workflows: [workflowItem({
        declaredPhases: [{ title: 'Review' }, { title: 'Verification' }],
        members: [memberItem(), memberItem({ seq: 2, childId: 'c2', outcome: 'completed' })],
      })],
    })
    expect(text).toContain('1 active · 2 started')
    expect(text).not.toContain('/2')
  })

  it('reports a settled run by its agent count rather than by live counters', () => {
    const text = overview({
      ...EMPTY,
      workflows: [workflowItem({ state: 'completed', agentsStarted: 4, members: [memberItem({ outcome: 'completed' })] })],
    })
    expect(text).toContain('completed')
    expect(text).toContain('4 agents')
  })
})

describe('the workflow detail stage', () => {
  /** Open the first workflow row's stage, as visible rows. */
  function openRows(snapshot: WorkSnapshot, rows = 30): string[] {
    const overlay = createWorkOverlay({
      snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {},
    })
    overlay.render(80, rows)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    return overlay.render(80, rows).map(stripAnsi)
  }

  /** Open the first workflow row's stage. */
  function open(snapshot: WorkSnapshot, rows = 30): string {
    return openRows(snapshot, rows).join('\n')
  }

  it('gives a member joined to a live child that child\u2019s own activity and route', () => {
    const text = open({
      ...EMPTY,
      workflows: [workflowItem({
        members: [
          memberItem({
            seq: 1, label: 'Codex route check', phase: 'Verify', childId: 'c1',
            subagent: subagentItem({
              id: 'c1', busy: true, activityWord: 'reading', activityTitle: 'connect/model.ts',
              route: { provider: 'openai-codex', model: 'gpt-x' },
            }),
          }),
        ],
      })],
    })
    // The one cross-authority join Work makes carries the whole Work 3.0
    // presentation with it: the member's label, then what its child is doing,
    // then which LLM is actually powering that child. There is no second
    // workflow-specific activity observer behind this.
    expect(text).toContain('◜ Codex route check · reading connect/model.ts · openai-codex/gpt-x')
  })

  it('lets a settled member keep no activity, route, or animation from a past child', () => {
    // A settled member releases its `childId` claim in the projection, so the
    // row has no child to inherit from — the outcome is the only live fact.
    const settled = open({
      ...EMPTY,
      workflows: [workflowItem({
        members: [memberItem({ seq: 1, label: 'Codex route check', childId: 'c1', outcome: 'completed' })],
      })],
    })
    expect(settled).toContain('✓ Codex route check')
    expect(settled).not.toContain('reading')
    expect(settled).not.toContain('openai-codex')
    expect(settled).not.toContain('◜')
  })

  it('never substitutes a workflow\u2019s declared phase metadata for a child\u2019s actual route', () => {
    const { workflows, append, observe } = harness({ live: true })
    append(session, record('tool-workflow/run-start', { runId: 'run-1', name: 'repo-audit' }))
    append(session, record('tool-workflow/agent-start', {
      runId: 'run-1', seq: 1, label: 'Codex route check', phase: 'Review', childId: 'c1',
    }))
    // `meta.phases` may well declare the provider and model a phase EXPECTS.
    // That is a script's intent, not proof of the route that executed, so the
    // projection retains none of it and the child's own state is the only
    // answer the row can give.
    observe('run-1', {
      ...META,
      phases: [{ title: 'Review', provider: 'expected-provider', model: 'expected-model' } as never],
    }, { kind: 'meta' })
    const child = subagentItem({ id: 'c1', route: { provider: 'openai-codex', model: 'gpt-x' } })
    const member = workflows.items([child])[0]?.members[0]
    expect(member?.subagent?.route).toEqual({ provider: 'openai-codex', model: 'gpt-x' })
    expect(JSON.stringify(workflows.items([child]))).not.toContain('expected-provider')
    expect(JSON.stringify(workflows.items([child]))).not.toContain('expected-model')
  })

  it('shows the run facts and groups members under their exact phase', () => {
    const rows = openRows({
      ...EMPTY,
      workflows: [workflowItem({
        description: 'Audit Work architecture',
        phase: 'Verification',
        log: 'verifying 3 findings',
        members: [
          memberItem({ seq: 1, label: 'architecture', phase: 'Review', outcome: 'completed' }),
          memberItem({ seq: 2, label: 'renderer', phase: 'Review', childId: 'c2', subagent: subagentItem({ id: 'c2', busy: true, activityWord: 'editing', activityTitle: 'overlay.ts' }) }),
          memberItem({ seq: 3, label: 'regression', phase: 'Verification', childId: 'c3', outcome: 'failed' }),
        ],
      })],
    })
    const text = rows.join('\n')
    expect(text).toContain('Workflow · repo-audit')
    expect(text).toContain('description  Audit Work architecture')
    expect(text).toContain('state  running')
    expect(text).toContain('phase  Verification')
    expect(text).toContain('log  verifying 3 findings')
    expect(text).toContain('agents  1 active · 3 started')
    expect(text).toContain('✓ architecture')
    expect(text).toContain('✗ regression')
    // The member's own label leads and the joined child's activity follows it;
    // the `spawn` BACKEND is not overview material for a child whose work is
    // observable, and the member row inherits that rule from the shared builder.
    expect(text).toContain('◜ renderer · editing overlay.ts')
    expect(text).not.toContain('renderer spawn')
    // A phase HEADING is an unindented row carrying only its title, so the two
    // groups can be located without confusing them with the `phase` fact row.
    const heading = (title: string): number => rows.findIndex(row => new RegExp(`\u2502 ${title} +\u2502`, 'u').test(row))
    expect(heading('Review')).toBeGreaterThan(-1)
    expect(heading('Verification')).toBeGreaterThan(heading('Review'))
    const memberAt = (label: string): number => rows.findIndex(row => row.includes(label))
    expect(memberAt('✓ architecture')).toBeGreaterThan(heading('Review'))
    expect(memberAt('◜ renderer')).toBeLessThan(heading('Verification'))
    expect(memberAt('✗ regression')).toBeGreaterThan(heading('Verification'))
  })

  it('says nothing about members before any has been published', () => {
    const text = open({ ...EMPTY, workflows: [workflowItem()] })
    expect(text).toContain('No members published yet.')
    // Not a padded list of calls the script has not made.
    expect(text).not.toContain('waiting')
  })

  it('opens the shared subagent stage from a member whose child is live', () => {
    const child = subagentItem({ id: 'c2', runId: 'epoch-2', provider: 'spawn', mode: 'continuable', interruptible: true })
    const snapshot: WorkSnapshot = {
      ...EMPTY,
      workflows: [workflowItem({
        members: [
          memberItem({ seq: 1, label: 'architecture', phase: 'Review', outcome: 'completed' }),
          memberItem({ seq: 2, label: 'renderer', phase: 'Review', childId: 'c2', subagent: child }),
        ],
      })],
      subagents: [child],
    }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {},
    })
    overlay.render(80, 30)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    // Walk down to the live member. The settled one above it is a record and
    // must not be a place to navigate to.
    let text = overlay.render(80, 30).map(stripAnsi).join('\n')
    while (!text.includes('❯ ● renderer') && !text.includes('❯ ◜ renderer')) {
      overlay.handleKey({ kind: 'key', name: 'down' })
      text = overlay.render(80, 30).map(stripAnsi).join('\n')
    }
    overlay.handleKey({ kind: 'key', name: 'enter' })
    const detail = overlay.render(80, 30).map(stripAnsi).join('\n')
    // The SHARED subagent presentation, enriched with the proven workflow context.
    expect(detail).toContain('Subagent · spawn')
    expect(detail).toContain('workflow  repo-audit')
    expect(detail).toContain('phase  Review')
    expect(detail).toContain('member  renderer')
    expect(detail).toContain('run id  epoch-2')
    // Esc returns ONE level: to the workflow it was reached from.
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(overlay.render(80, 30).map(stripAnsi).join('\n')).toContain('Workflow · repo-audit')
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(overlay.render(80, 30).map(stripAnsi).join('\n')).toContain('Workflows')
  })

  it('refuses to navigate from a member whose child is not live', () => {
    const snapshot: WorkSnapshot = {
      ...EMPTY,
      workflows: [workflowItem({ members: [memberItem({ label: 'architecture', outcome: 'completed' })] })],
    }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {},
    })
    overlay.render(80, 30)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.handleKey({ kind: 'key', name: 'end' })
    const before = overlay.render(80, 30).map(stripAnsi).join('\n')
    expect(before).toContain('❯ ✓ architecture')
    overlay.handleKey({ kind: 'key', name: 'enter' })
    // Enter on a row with no action does nothing at all.
    expect(overlay.render(80, 30).map(stripAnsi).join('\n')).toBe(before)
  })

  it('keeps a workflow being inspected while its members start and settle beneath it', () => {
    let snapshot: WorkSnapshot = { ...EMPTY, workflows: [workflowItem({ members: [memberItem({ label: 'first' })] })] }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {},
    })
    overlay.render(80, 30)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(80, 30).map(stripAnsi).join('\n')).toContain('first')
    snapshot = {
      ...EMPTY,
      workflows: [workflowItem({
        members: [memberItem({ label: 'first', outcome: 'completed' }), memberItem({ seq: 2, label: 'second', childId: 'c2' })],
      })],
    }
    const text = overlay.render(80, 30).map(stripAnsi).join('\n')
    expect(text).toContain('Workflow · repo-audit')
    expect(text).toContain('✓ first')
    expect(text).toContain('second')
  })

  it('leaves the workflow stage when the run itself closes', () => {
    let snapshot: WorkSnapshot = { ...EMPTY, workflows: [workflowItem()] }
    const overlay = createWorkOverlay({
      snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {},
    })
    overlay.render(80, 30)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(80, 30).map(stripAnsi).join('\n')).toContain('Workflow · repo-audit')
    // The engine settled and the durable record closed while it was selected.
    snapshot = { ...EMPTY }
    const after = overlay.render(80, 30).map(stripAnsi).join('\n')
    expect(after).not.toContain('Workflow · repo-audit')
    expect(after).toContain('No active workflows, jobs, or subagents.')
  })

  it('offers no control over a run, because the engine publishes none', () => {
    const text = open({ ...EMPTY, workflows: [workflowItem({ members: [memberItem()] })] })
    expect(text).not.toContain('k interrupt')
    expect(text).not.toContain('cancel')
  })
})

describe('workflow geometry', () => {
  it('keeps every workflow stage inside its terminal across a size matrix', () => {
    const snapshot: WorkSnapshot = {
      ...EMPTY,
      workflows: [workflowItem({
        label: '仓库审计工作流的一个非常长的名称',
        description: 'A deliberately long description that must never leak a row into scrollback',
        phase: '审查阶段',
        log: 'a long narration line that also must not leak',
        members: Array.from({ length: 12 }, (_, index) => memberItem({
          seq: index + 1,
          label: `成员 ${String(index)} with a long trailing label`,
          phase: index % 2 === 0 ? 'Review' : 'Verification',
          childId: `c${String(index)}`,
          ...index % 3 === 0 ? { subagent: subagentItem({ id: `c${String(index)}`, busy: true, activityWord: 'editing', activityTitle: 'a/very/long/path/overlay.ts' }) } : {},
        })),
      })],
    }
    for (const columns of [14, 18, 24, 40, 80]) {
      for (const rows of [5, 7, 9, 12, 24]) {
        const overlay = createWorkOverlay({
          snapshot: () => snapshot, interrupt: () => INTERRUPT_REQUESTED, close: () => {}, invalidate: () => {},
        })
        for (const key of ['enter', 'down', 'down', 'down', 'enter'] as const) {
          overlay.render(columns, rows)
          overlay.handleKey({ kind: 'key', name: key })
        }
        const frame = overlay.render(columns, rows)
        expect(frame.flatMap(line => line.split('\n')).length, `${String(columns)}x${String(rows)}`)
          .toBeLessThanOrEqual(rows)
      }
    }
  })
})
