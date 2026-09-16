/**
 * Tests for Work's detail-row navigation.
 *
 * The property under test is that every stage is a real inspectable list: the
 * visible cursor moves with the arrows in a detail view exactly as it does on
 * the overview, a focused row does not have to be actionable, and the scroll
 * position follows the cursor instead of drifting independently of it.
 */

import { describe, expect, it } from 'vitest'
import { stripAnsi } from '@dshline/renderer'
import { createWorkOverlay } from '../src/work/overlay.ts'
import type {
  JobWorkItem,
  SubagentWorkItem,
  WorkConversationTarget,
  WorkflowMemberItem,
  WorkflowWorkItem,
  WorkInterruptResult,
  WorkSnapshot,
} from '../src/work/model.ts'

/** Standard successful interrupt response. */
const INTERRUPT_REQUESTED: WorkInterruptResult = { kind: 'requested', message: 'Interrupt requested.' }

/** A no-work projection tests extend. */
const EMPTY: WorkSnapshot = { available: true, workflows: [], subagents: [], jobs: [] }

/** A live subagent epoch. */
function subagentItem(overrides: Partial<SubagentWorkItem> = {}): SubagentWorkItem {
  return {
    id: 'child-1', source: 'subagent', runId: 'epoch-1', provider: 'spawn', local: true,
    state: 'running', startedAt: Date.now(), mode: 'continuable', interruptible: true,
    residency: 'resident', hasChildren: true, agentStatus: 'running', busy: true,
    activityWord: 'editing', activityTitle: 'overlay.ts', label: 'renderer review', ...overrides,
  }
}

/** A background job record. */
function jobItem(overrides: Partial<JobWorkItem> = {}): JobWorkItem {
  return {
    id: 'bash-1', source: 'job', kind: 'bash', label: 'pnpm test', state: 'running',
    startedAt: Date.now(), ownership: 'this-session', detail: 'exit code pending', interruptible: false, ...overrides,
  }
}

/** A workflow row. */
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

/** One overlay plus a reader for the row the cursor is on. */
function driver(snapshot: () => WorkSnapshot, options: {
  readonly interrupt?: (item: { id: string }) => WorkInterruptResult
  readonly conversations?: () => void
  readonly conversation?: (target: WorkConversationTarget) => void
} = {}): {
  readonly overlay: ReturnType<typeof createWorkOverlay>
  readonly rows: (columns?: number, rows?: number) => string[]
  readonly cursor: (columns?: number, rows?: number) => string
  readonly press: (name: 'up' | 'down' | 'enter' | 'escape' | 'home' | 'end') => void
} {
  const overlay = createWorkOverlay({
    snapshot,
    interrupt: item => options.interrupt?.(item) ?? INTERRUPT_REQUESTED,
    // Mirrors the owner's conditional spread: a profile without the seam mounts
    // neither callback, which is exactly the capability-absence case under test.
    ...options.conversations === undefined ? {} : { conversations: options.conversations },
    ...options.conversation === undefined ? {} : { conversation: options.conversation },
    close: () => {},
    invalidate: () => {},
  })
  const rows = (columns = 80, terminalRows = 40): string[] => overlay.render(columns, terminalRows).map(stripAnsi)
  return {
    overlay,
    rows,
    cursor: (columns = 80, terminalRows = 40) => {
      const found = rows(columns, terminalRows).find(row => row.includes('❯')) ?? ''
      return found.replace(/^│ /u, '').replace(/\s*│$/u, '').replace(/^❯ /u, '').trim()
    },
    press: name => {
      overlay.render(80, 40)
      overlay.handleKey({ kind: 'key', name })
    },
  }
}

/**
 * Whether the footer advertises the direct open.
 *
 * The negative lookahead separates it from the catalog wording, which contains
 * `c conversation` as a prefix; asserting on the whole segment is what makes
 * the footer/action parity test meaningful.
 */
function saysDirect(text: string): boolean {
  return /· c conversation(?!s)/u.test(text)
}

/** Whether the footer advertises the catalog fallback. */
function saysCatalog(text: string): boolean {
  return /· c conversations/u.test(text)
}

describe('Work detail-row navigation', () => {
  it('moves the visible cursor through a subagent detail with the arrows', () => {
    const app = driver(() => ({ ...EMPTY, subagents: [subagentItem()] }))
    app.press('enter')
    const first = app.cursor()
    expect(first).toContain('editing · overlay.ts')
    app.press('down')
    expect(app.cursor()).toBe('backend  spawn')
    app.press('down')
    expect(app.cursor()).toMatch(/^elapsed /u)
    app.press('up')
    expect(app.cursor()).toBe('backend  spawn')
    // Exactly one row is ever highlighted.
    expect(app.rows().filter(row => row.includes('❯'))).toHaveLength(1)
  })

  it('moves the visible cursor through a job detail with the arrows', () => {
    const app = driver(() => ({ ...EMPTY, jobs: [jobItem()] }))
    app.press('enter')
    expect(app.cursor()).toBe('status  running')
    app.press('down')
    expect(app.cursor()).toBe('kind  bash')
    app.press('down')
    expect(app.cursor()).toBe('detail  exit code pending')
    app.press('end')
    expect(app.cursor()).toBe('job id  bash-1')
  })

  it('moves the visible cursor through a workflow detail with the arrows', () => {
    const app = driver(() => ({
      ...EMPTY,
      workflows: [workflowItem({ description: 'Audit Work architecture', members: [memberItem()] })],
    }))
    app.press('enter')
    expect(app.cursor()).toBe('description  Audit Work architecture')
    app.press('down')
    expect(app.cursor()).toBe('state  running')
    app.press('end')
    expect(app.cursor()).toBe('● architecture')
  })

  it('wraps the cursor at both ends of a detail stage', () => {
    const app = driver(() => ({ ...EMPTY, jobs: [jobItem()] }))
    app.press('enter')
    const top = app.cursor()
    app.press('up')
    expect(app.cursor()).toBe('job id  bash-1')
    app.press('down')
    expect(app.cursor()).toBe(top)
  })

  it('ignores Enter on a fact row instead of inventing an action', () => {
    const app = driver(() => ({ ...EMPTY, jobs: [jobItem()] }))
    app.press('enter')
    const before = app.rows().join('\n')
    app.press('enter')
    app.press('enter')
    expect(app.rows().join('\n')).toBe(before)
  })

  it('scrolls the detail viewport to keep the focused row visible', () => {
    const app = driver(() => ({ ...EMPTY, subagents: [subagentItem()] }))
    app.press('enter')
    // A short terminal shows only the head of the view. Every step must keep the
    // cursor on screen instead of scrolling out from under it.
    const short = 11
    expect(app.rows(80, short).join('\n')).not.toContain('local agent')
    for (let step = 0; step < 12; step += 1) {
      app.overlay.render(80, short)
      app.overlay.handleKey({ kind: 'key', name: 'down' })
      expect(app.rows(80, short).filter(row => row.includes('❯')), `step ${String(step)}`).toHaveLength(1)
    }
    app.overlay.render(80, short)
    app.overlay.handleKey({ kind: 'key', name: 'end' })
    const rows = app.rows(80, short)
    expect(rows.filter(row => row.includes('❯'))).toHaveLength(1)
    expect(rows.join('\n')).toContain('local agent  yes')
  })

  it('keeps the detail cursor on its fact while the subject\'s live facts change', () => {
    let word: SubagentWorkItem['activityWord'] = 'editing'
    const app = driver(() => ({ ...EMPTY, subagents: [subagentItem({ activityWord: word })] }))
    app.press('enter')
    app.press('down')
    app.press('down')
    expect(app.cursor()).toMatch(/^elapsed /u)
    word = 'thinking'
    // The activity headline changed above the cursor; the cursor is an identity,
    // so it stays on `elapsed` instead of sliding with the row order.
    expect(app.cursor()).toMatch(/^elapsed /u)
  })

  it('gains the interrupt row on a continuable child and never announces its absence', () => {
    const app = driver(() => ({ ...EMPTY, subagents: [subagentItem()] }))
    app.press('enter')
    expect(app.rows().join('\n')).toContain('interrupt  available')
    const oneShot = driver(() => ({ ...EMPTY, subagents: [subagentItem({ mode: 'one-shot', interruptible: false })] }))
    oneShot.press('enter')
    expect(oneShot.rows().join('\n')).not.toContain('interrupt')
  })

  it('keeps k aimed at the inspected subject while the cursor sits on a fact row', () => {
    const interrupted: string[] = []
    const app = driver(
      () => ({ ...EMPTY, subagents: [subagentItem()] }),
      { interrupt: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED } },
    )
    app.press('enter')
    app.press('down')
    app.press('down')
    app.overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual(['child-1'])
  })

  it('never navigates to a successor when the aimed member disappears first', () => {
    const live = subagentItem({ id: 'child-2', runId: 'epoch-2', label: 'renderer' })
    const survivor = subagentItem({ id: 'child-3', runId: 'epoch-3', label: 'security' })
    let members: WorkflowMemberItem[] = [
      memberItem({ seq: 1, label: 'renderer', childId: 'child-2', subagent: live }),
      memberItem({ seq: 2, label: 'security', childId: 'child-3', subagent: survivor }),
    ]
    let subagents: SubagentWorkItem[] = [live, survivor]
    const app = driver(() => ({ ...EMPTY, workflows: [workflowItem({ members })], subagents }))
    app.press('enter')
    app.press('end')
    app.press('up')
    expect(app.cursor()).toContain('renderer')
    // The aimed member settles before the keystroke is read.
    members = [
      memberItem({ seq: 1, label: 'renderer', childId: 'child-2', outcome: 'completed' }),
      memberItem({ seq: 2, label: 'security', childId: 'child-3', subagent: survivor }),
    ]
    subagents = [survivor]
    app.overlay.handleKey({ kind: 'key', name: 'enter' })
    const after = app.rows().join('\n')
    // Still the workflow: Enter must not have opened the member that inherited
    // the aimed row's screen position.
    expect(after).toContain('Workflow · repo-audit')
    expect(after).not.toContain('Subagent · security')
  })

  it('never opens a successor when the aimed overview row disappears first', () => {
    let workflows = [workflowItem({ id: 'run-1', label: 'first' }), workflowItem({ id: 'run-2', label: 'second' })]
    const app = driver(() => ({ ...EMPTY, workflows }))
    app.press('down')
    expect(app.cursor()).toContain('second')
    // The aimed run closes before the keystroke is read.
    workflows = [workflowItem({ id: 'run-1', label: 'first' })]
    app.overlay.handleKey({ kind: 'key', name: 'enter' })
    const after = app.rows().join('\n')
    expect(after).toContain('Workflows')
    expect(after).not.toContain('Workflow · first')
    // The next paint re-anchors deliberately; Enter then opens what is visible.
    app.press('enter')
    expect(app.rows().join('\n')).toContain('Workflow · first')
  })

  it('returns one hierarchy level per Esc and closes only from the overview', () => {
    let closed = 0
    const child = subagentItem({ id: 'child-1', runId: 'epoch-1' })
    const overlay = createWorkOverlay({
      snapshot: () => ({
        ...EMPTY,
        workflows: [workflowItem({ members: [memberItem({ subagent: child })] })],
        subagents: [child],
      }),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => { closed += 1 },
      invalidate: () => {},
    })
    const read = (): string => overlay.render(80, 40).map(stripAnsi).join('\n')
    read()
    overlay.handleKey({ kind: 'key', name: 'enter' })
    read()
    overlay.handleKey({ kind: 'key', name: 'end' })
    read()
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(read()).toContain('Subagent ·')
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(read()).toContain('Workflow · repo-audit')
    expect(closed).toBe(0)
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(read()).toContain('Workflows')
    expect(closed).toBe(0)
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(closed).toBe(1)
  })

  it('acts on nothing while the compact fallback hides the cursor', () => {
    const interrupted: string[] = []
    let closed = 0
    const child = subagentItem({ id: 'child-1', runId: 'epoch-1' })
    const overlay = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, subagents: [child] }),
      interrupt: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED },
      close: () => { closed += 1 },
      invalidate: () => {},
    })
    // A terminal too small for the framed list. This frame shows no rows and no
    // cursor, so nothing may be opened or interrupted from it.
    const compact = overlay.render(14, 5).map(stripAnsi).join('\n')
    expect(compact).not.toContain('❯')
    expect(compact).toContain('esc close')
    overlay.handleKey({ kind: 'text', text: 'k' })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(interrupted).toEqual([])
    // Enter opened no hidden stage: the next full-size paint is still the overview.
    expect(overlay.render(80, 24).map(stripAnsi).join('\n')).toContain('Subagents')
    expect(closed).toBe(0)
  })

  it('closes outright on esc from the compact fallback, as that frame promises', () => {
    let closed = 0
    const child = subagentItem({ id: 'child-1', runId: 'epoch-1' })
    const overlay = createWorkOverlay({
      snapshot: () => ({
        ...EMPTY,
        workflows: [workflowItem({ members: [memberItem({ subagent: child })] })],
        subagents: [child],
      }),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => { closed += 1 },
      invalidate: () => {},
    })
    // Walk two levels deep at a usable size, then shrink under the reader.
    overlay.render(80, 40)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.render(80, 40)
    overlay.handleKey({ kind: 'key', name: 'end' })
    overlay.render(80, 40)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(overlay.render(80, 40).map(stripAnsi).join('\n')).toContain('Subagent ·')
    expect(overlay.render(14, 5).map(stripAnsi).join('\n')).toContain('esc close')
    // The fallback advertises `esc close`, so esc closes — it does not pop two
    // invisible stages first while the reader presses a key that says otherwise.
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(closed).toBe(1)
  })

  it('resumes normal interaction once the terminal can show the cursor again', () => {
    const interrupted: string[] = []
    const child = subagentItem({ id: 'child-1', runId: 'epoch-1' })
    const overlay = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, subagents: [child] }),
      interrupt: item => { interrupted.push(item.id); return INTERRUPT_REQUESTED },
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(14, 5)
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual([])
    overlay.render(80, 24)
    overlay.handleKey({ kind: 'text', text: 'k' })
    expect(interrupted).toEqual(['child-1'])
  })

  it('describes Enter in the footer only while the focused row can be opened', () => {
    const child = subagentItem({ id: 'child-1', runId: 'epoch-1' })
    const app = driver(() => ({
      ...EMPTY,
      workflows: [workflowItem({ members: [memberItem({ subagent: child })] })],
      subagents: [child],
    }))
    expect(app.rows().join('\n')).toContain('↵ inspect')
    app.press('enter')
    // Parked on a fact row, Enter does nothing and the footer says nothing about it.
    expect(app.rows().join('\n')).not.toContain('↵ inspect')
    app.press('end')
    expect(app.rows().join('\n')).toContain('↵ inspect')
  })
})

describe('Work conversation action', () => {
  it('opens the catalog from the overview when the focused row is not a child', () => {
    const singular: WorkConversationTarget[] = []
    let catalog = 0
    const app = driver(() => ({ ...EMPTY, jobs: [jobItem()] }), {
      conversations: () => { catalog += 1 },
      conversation: target => { singular.push(target) },
    })
    app.rows()
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(catalog).toBe(1)
    expect(singular).toEqual([])
  })

  it('opens the catalog from a workflow detail', () => {
    const singular: WorkConversationTarget[] = []
    let catalog = 0
    const app = driver(() => ({ ...EMPTY, workflows: [workflowItem()] }), {
      conversations: () => { catalog += 1 },
      conversation: target => { singular.push(target) },
    })
    app.press('enter')
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(catalog).toBe(1)
    expect(singular).toEqual([])
  })

  it('opens the catalog from a job detail', () => {
    const singular: WorkConversationTarget[] = []
    let catalog = 0
    const app = driver(() => ({ ...EMPTY, jobs: [jobItem()] }), {
      conversations: () => { catalog += 1 },
      conversation: target => { singular.push(target) },
    })
    app.press('enter')
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(catalog).toBe(1)
    expect(singular).toEqual([])
  })

  it('opens the selected child conversation directly from its detail', () => {
    const singular: WorkConversationTarget[] = []
    let catalog = 0
    const app = driver(() => ({ ...EMPTY, subagents: [subagentItem()] }), {
      conversations: () => { catalog += 1 },
      conversation: target => { singular.push(target) },
    })
    app.press('enter')
    expect(saysDirect(app.rows().join('\n'))).toBe(true)
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(singular).toHaveLength(1)
    expect(catalog).toBe(0)
  })

  it('passes the selected child\'s exact durable facts to the direct opener', () => {
    const singular: WorkConversationTarget[] = []
    const app = driver(() => ({
      ...EMPTY,
      subagents: [subagentItem({
        id: 'child-session-123',
        runId: 'run-epoch-999',
        mode: 'continuable',
        residency: 'stored',
        hasChildren: false,
        label: 'exact label',
      })],
    }), { conversation: target => { singular.push(target) } })
    app.press('enter')
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(singular).toEqual([{
      id: 'child-session-123',
      mode: 'continuable',
      residency: 'stored',
      hasChildren: false,
      label: 'exact label',
    }])
  })

  it('addresses the durable child id and never the lifecycle run id', () => {
    const singular: WorkConversationTarget[] = []
    const app = driver(() => ({
      ...EMPTY,
      subagents: [subagentItem({ id: 'child-session-123', runId: 'run-epoch-999' })],
    }), { conversation: target => { singular.push(target) } })
    app.press('enter')
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(singular[0]?.id).toBe('child-session-123')
    expect(JSON.stringify(singular)).not.toContain('run-epoch-999')
  })

  it('still opens a one-shot child directly', () => {
    const singular: WorkConversationTarget[] = []
    const app = driver(() => ({
      ...EMPTY,
      subagents: [subagentItem({ mode: 'one-shot', interruptible: false })],
    }), { conversation: target => { singular.push(target) } })
    app.press('enter')
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(singular[0]?.mode).toBe('one-shot')
  })

  it('opens a provider-managed child directly even though local is false', () => {
    const singular: WorkConversationTarget[] = []
    const app = driver(() => ({
      ...EMPTY,
      subagents: [subagentItem({ local: false })],
    }), { conversation: target => { singular.push(target) } })
    app.press('enter')
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(singular).toHaveLength(1)
  })

  it('falls back to the catalog when discovery carried no mode', () => {
    const singular: WorkConversationTarget[] = []
    let catalog = 0
    const app = driver(() => ({
      ...EMPTY,
      subagents: [subagentItem({ mode: undefined })],
    }), {
      conversations: () => { catalog += 1 },
      conversation: target => { singular.push(target) },
    })
    app.press('enter')
    const footer = app.rows().join('\n')
    expect(saysCatalog(footer)).toBe(true)
    expect(saysDirect(footer)).toBe(false)
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(catalog).toBe(1)
    expect(singular).toEqual([])
  })

  it('falls back to the catalog when discovery carried no residency', () => {
    const singular: WorkConversationTarget[] = []
    let catalog = 0
    const app = driver(() => ({
      ...EMPTY,
      subagents: [subagentItem({ residency: undefined })],
    }), {
      conversations: () => { catalog += 1 },
      conversation: target => { singular.push(target) },
    })
    app.press('enter')
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(catalog).toBe(1)
    expect(singular).toEqual([])
  })

  it('falls back to the catalog when discovery carried no lineage', () => {
    const singular: WorkConversationTarget[] = []
    let catalog = 0
    const app = driver(() => ({
      ...EMPTY,
      subagents: [subagentItem({ hasChildren: undefined })],
    }), {
      conversations: () => { catalog += 1 },
      conversation: target => { singular.push(target) },
    })
    app.press('enter')
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(catalog).toBe(1)
    expect(singular).toEqual([])
  })

  it('does not require a label to open a child directly', () => {
    const singular: WorkConversationTarget[] = []
    const app = driver(() => ({
      ...EMPTY,
      subagents: [subagentItem({ label: undefined })],
    }), { conversation: target => { singular.push(target) } })
    app.press('enter')
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(singular).toHaveLength(1)
    expect(Object.hasOwn(singular[0] ?? {}, 'label')).toBe(false)
  })

  it('keeps the footer wording and the c key on one decision', () => {
    const scenarios: { readonly name: string; readonly snapshot: WorkSnapshot; readonly enter: boolean }[] = [
      { name: 'direct child', snapshot: { ...EMPTY, subagents: [subagentItem()] }, enter: true },
      {
        name: 'incomplete child',
        snapshot: { ...EMPTY, subagents: [subagentItem({ residency: undefined })] },
        enter: true,
      },
      { name: 'job overview', snapshot: { ...EMPTY, jobs: [jobItem()] }, enter: false },
    ]
    for (const scenario of scenarios) {
      const singular: WorkConversationTarget[] = []
      let catalog = 0
      const app = driver(() => scenario.snapshot, {
        conversations: () => { catalog += 1 },
        conversation: target => { singular.push(target) },
      })
      if (scenario.enter) app.press('enter')
      const footer = app.rows().join('\n')
      app.overlay.handleKey({ kind: 'text', text: 'c' })
      expect(saysDirect(footer), scenario.name).toBe(singular.length === 1)
      expect(saysCatalog(footer), scenario.name).toBe(catalog === 1)
    }
  })

  it('shows and does nothing for c when no conversation capability is mounted', () => {
    let invalidated = 0
    const overlay = createWorkOverlay({
      snapshot: () => ({ ...EMPTY, subagents: [subagentItem()] }),
      interrupt: () => INTERRUPT_REQUESTED,
      close: () => {},
      invalidate: () => { invalidated += 1 },
    })
    const text = overlay.render(80, 40).map(stripAnsi).join('\n')
    expect(saysDirect(text)).toBe(false)
    expect(saysCatalog(text)).toBe(false)
    overlay.handleKey({ kind: 'text', text: 'c' })
    expect(invalidated).toBe(0)
  })

  it('never retargets a stale cursor onto a successor identity', () => {
    const first = subagentItem({ id: 'child-A', runId: 'epoch-A', label: 'alpha' })
    const successor = subagentItem({ id: 'child-B', runId: 'epoch-B', label: 'beta' })
    let items: SubagentWorkItem[] = [first]
    const singular: WorkConversationTarget[] = []
    let catalog = 0
    const app = driver(() => ({ ...EMPTY, subagents: items }), {
      conversations: () => { catalog += 1 },
      conversation: target => { singular.push(target) },
    })
    // Paint with A aimed, then let A vanish while B takes the same row.
    app.rows()
    items = [successor]
    // No render between the removal and the keypress: a render would
    // legitimately re-anchor the cursor, and this test is about the stale aim a
    // human ACTION must refuse rather than transfer.
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(singular).toEqual([])
    // Falling back to the catalog is safe; what must never happen is a direct
    // open addressed to the successor that inherited the dead cursor.
    expect(catalog).toBe(1)
  })

  it('keeps the overview on the catalog even with a complete child row focused', () => {
    // The overview row is a list ENTRY, not an inspected subject. The descriptor
    // is complete, so the only thing keeping this on the catalog path is the
    // stage: the direct open belongs to the subagent detail stage alone.
    const singular: WorkConversationTarget[] = []
    let catalog = 0
    const app = driver(() => ({ ...EMPTY, subagents: [subagentItem()] }), {
      conversations: () => { catalog += 1 },
      conversation: target => { singular.push(target) },
    })
    const footer = app.rows().join('\n')
    expect(saysCatalog(footer)).toBe(true)
    expect(saysDirect(footer)).toBe(false)
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(catalog).toBe(1)
    expect(singular).toEqual([])
  })

  it('never retargets a vanished subagent detail onto the successor row', () => {
    const first = subagentItem({ id: 'child-A', runId: 'epoch-A', label: 'alpha' })
    const successor = subagentItem({ id: 'child-B', runId: 'epoch-B', label: 'beta' })
    let items: SubagentWorkItem[] = [first]
    const singular: WorkConversationTarget[] = []
    let catalog = 0
    const app = driver(() => ({ ...EMPTY, subagents: items }), {
      conversations: () => { catalog += 1 },
      conversation: target => { singular.push(target) },
    })
    // Inspect A, so the direct action is genuinely available for it.
    app.press('enter')
    expect(saysDirect(app.rows().join('\n'))).toBe(true)
    // A settles and B takes the row before the keypress is read. No render in
    // between: a render re-anchors deliberately, and this is about the stale
    // subject a human ACTION must refuse rather than transfer.
    items = [successor]
    app.overlay.handleKey({ kind: 'text', text: 'c' })
    expect(singular).toEqual([])
    // The dead stage pops, so the truthful fallback is the catalog, never a
    // direct open addressed to the child that inherited A's screen position.
    expect(catalog).toBe(1)
  })
})
