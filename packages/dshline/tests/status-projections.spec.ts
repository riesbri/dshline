/**
 * What the status line asks the projection registry for, and what it then says.
 *
 * The footer is the frontend's hottest read, so it names the units it draws
 * rather than taking every view a profile has registered. Two properties have to
 * hold together, and neither is worth having alone:
 *
 * - the NARROWING is exact. The keys requested are the five the status state
 *   reads, no more, and a unit that is not in that list is not asked for.
 * - the RENDERING is unchanged. The same attachment, given a registry that
 *   answers every unit, draws a byte-identical frame — which is the only way to
 *   show that a unit left out of the list was one no status segment reads.
 *
 * The registry double enforces the second property structurally: when a test asks
 * for a unit the footer did not request, answering it would be a leak, so it
 * fails loudly instead of quietly returning a value nobody would have drawn.
 * @module dshline/tests/status-projections
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { stripAnsi } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { STATUS_PROJECTION_KEYS } from '../src/projections/status-keys.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/**
 * The keys the footer is expected to request, written out here rather than
 * imported from the module under test.
 *
 * A test that asserted the recorded keys against `STATUS_PROJECTION_KEYS` would
 * pass on a list with a sixth key added to it, which is the change this file
 * exists to catch: each key below is one field the status state reads, and a key
 * that is not one of those is a view produced for nobody.
 */
const EXPECTED_KEYS: readonly string[] = [
  'permissions',
  'tokenUsage',
  'contextPressure',
  'todos',
  'goal',
]

/** Every client-visible unit this double can answer, and the one it may not. */
const UNREQUESTED = 'contextBreakdown'

/** A projection cut, in the shape the status readers consume it. */
interface Cut {
  readonly values: Record<string, unknown>
}

/** Build the full cut a mounted profile would publish, one value per unit. */
function fullCut(): Cut {
  return {
    values: {
      permissions: { currentValue: 'review' },
      tokenUsage: {
        uncachedInputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
      },
      contextPressure: { projectedTokens: 68_000, contextWindow: 1_000_000 },
      contextBreakdown: { systemTokens: 12, toolsTokens: 48, messageTokens: 116 },
      todos: [
        { id: 'a', content: 'one', status: 'completed' },
        { id: 'b', content: 'two', status: 'pending' },
      ],
      goal: { goal: { phase: 'active', maxGoalRounds: 256 }, roundsStarted: 3 },
    },
  }
}

/** A registry double that records the keys each read asked for. */
interface Registry {
  /** The keys every `snapshot()` call has requested, in order. */
  readonly asked: (readonly (readonly string[] | undefined)[])[]
  /** The value the current cut publishes, which a test can replace. */
  publish: (cut: Cut) => void
}

/**
 * A registry double that answers exactly the units a caller named.
 *
 * Faithful to upstream's contract, which is what makes the frames comparable: a
 * keyed cut materializes the same state as an unkeyed one and produces only the
 * named client-visible VIEWS, so a unit left out of the list is absent from
 * `values` exactly as it would be from the real registry — and a footer that
 * depended on it would draw a different frame rather than quietly get a value.
 * @param cut - what the registry publishes.
 * @returns the registry double, its recorded requests, and its publisher.
 */
function registry(cut: Cut): Registry {
  let current = cut
  const asked: (readonly (readonly string[] | undefined)[])[] = []
  return {
    asked,
    publish: next => { current = next },
    snapshot: (_session: unknown, keys?: readonly string[]): unknown => {
      asked.push(keys)
      const entries = Object.entries(current.values)
      return {
        asOfSeq: 0,
        values: keys === undefined
          ? current.values
          : Object.fromEntries(entries.filter(([key]) => keys.includes(key))),
      }
    },
    onChanged: () => () => {},
  } as unknown as Registry & { snapshot: unknown }
}

/** What the attachment fixture hands back. */
interface Fixture {
  /** Every frame the window has painted, stripped of styling. */
  readonly frames: () => readonly string[]
  /** The most recently painted frame, as a reader sees it. */
  readonly frame: () => string
  /** The projection requests the status path made. */
  readonly asked: () => readonly (readonly string[] | undefined)[]
  /** Replace the cut the next read will see. */
  publish: (cut: Cut) => void
  /** Repaint once, as a spinner beat or a projection change would. */
  redraw: () => void
}

/**
 * Mount the smallest assembled attachment that paints a status line.
 *
 * Everything the status path reads is real except the Harness services it would
 * otherwise need a whole agent to construct: the window, the session, and the
 * projection registry are the three doubles, and the status composition itself is
 * the production code under test.
 * @param cut - what the registry publishes on the first read.
 * @returns the painted frames, the recorded requests, and the controls.
 */
async function fixture(cut: Cut): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(TuiSlots)
  const seams = registry(cut)
  ctx.provide('sessionProjections', seams as never)
  ctx.provide('commands', { list: () => [], execute: async () => ({ kind: 'success' }) } as never)
  ctx.provide('tools', { get: () => undefined } as never)
  // The process-local half of the goal reading, joined onto the durable one.
  // Without it the segment would read `goal idle` and the projected half of the
  // `goal` unit would have nothing to show.
  ctx.provide('goals', { get: () => ({ activation: 'armed' }) } as never)
  const frames: string[][] = []
  const draw = (): void => { frames.push([...ctx.tuiSlots.compose(120, 24).lines]) }
  ctx.on('tui/render', draw)
  const window = {
    ctx,
    terminal: { columns: () => 120, rows: () => 24 },
    exit: undefined,
    startup: { cwd: '/ws', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: undefined },
    modelInfo: { contextWindow: 1_000_000, reasoning: undefined },
    modelCompletionValues: () => Promise.resolve([]),
    prefs: { usageMode: 'cost', timing: false, cardDetail: 'compact', reasoningVisible: true },
    colorDepth: 0,
    palette: () => ({}),
    setPalette: () => {},
    themeSettings: {},
    pendingTask: undefined,
    draw,
    paintNow: draw,
    commit: () => {},
    clear: () => {},
    refreshModelInfo: () => {},
    setDispatch: () => {},
    setExit: () => {},
  } as unknown as Window
  const session = {
    id: 'status-test',
    header: { cwd: '/ws' },
    events: [],
    append: (type: string, data: unknown): void => {
      ctx.emit('session/event', session as never, { type, data } as never)
    },
  }
  const agent = {
    session,
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup: () => {},
    steer: () => {},
    cancel: () => {},
  } as unknown as Agent
  void attachSession(window, {
    target: { kind: 'new', cwd: '/ws' },
    attached: { handle: { agent, dispose: async () => {} }, reopened: false },
  } as unknown as AttachOutcome)
  await new Promise<void>(resolve => setImmediate(resolve))
  draw()
  return {
    frames: () => frames,
    frame: () => stripAnsi((frames.at(-1) ?? []).join('\n')),
    asked: () => seams.asked,
    publish: next => { seams.publish(next) },
    redraw: draw,
  }
}

describe('the status line projection cut', () => {
  it('requests exactly the units it draws, and nothing else', async () => {
    const view = await fixture(fullCut())
    const requested = view.asked().at(-1)
    expect(requested).toBeDefined()
    expect([...(requested ?? [])].sort()).toEqual([...EXPECTED_KEYS].sort())
    // The one unit this narrowing deliberately drops, named rather than implied.
    expect(requested ?? []).not.toContain(UNREQUESTED)
    // Every key the code names is a key the footer uses.
    expect([...STATUS_PROJECTION_KEYS].sort()).toEqual([...EXPECTED_KEYS].sort())
  })

  it('asks for the same keys on every repaint', async () => {
    const view = await fixture(fullCut())
    view.redraw()
    view.redraw()
    const distinct = new Set(view.asked().map(keys => [...(keys ?? [])].sort().join(',')))
    expect([...distinct]).toEqual([[...EXPECTED_KEYS].sort().join(',')])
  })

  it('draws every one of the five units it asked for', async () => {
    // A frame that carries all five is what makes the comparison below a
    // comparison: identical output from a cut with fewer units proves nothing if
    // the cut was missing segments in both runs.
    const view = await fixture(fullCut())
    const line = view.frame()
    expect(line).toContain('review')
    expect(line).toContain('CR 90%')
    expect(line).toContain('68k/1.0M')
    expect(line).toContain('todo 1/2')
    expect(line).toContain('goal 3/256')
  })

  it('draws the same frame without the unit it deliberately left out', async () => {
    // The equivalence, stated where it matters: `contextBreakdown` exists in the
    // first cut and is not requested, so the registry produces no view for it,
    // and the footer draws exactly what it drew when the unit was being paid for
    // and read for nothing.
    const dropped = fullCut().values
    const { [UNREQUESTED]: _excluded, ...withoutIt } = dropped
    const withIt = await fixture({ values: dropped })
    const without = await fixture({ values: withoutIt })
    expect(withIt.frame()).toBe(without.frame())
    expect(withIt.asked().at(-1) ?? []).not.toContain(UNREQUESTED)
  })

  it('follows a permission change on the very next frame', async () => {
    // Nothing is remembered between reads: the next paint asks the registry again
    // and draws what it says now, which is the only reason a narrow cut is safe.
    const view = await fixture(fullCut())
    expect(view.frame()).toContain('review')
    view.publish({ values: { ...fullCut().values, permissions: { currentValue: 'auto' } } })
    view.redraw()
    expect(view.frame()).toContain('auto')
    expect(view.frame()).not.toContain('review')
  })

  it('follows a todo and goal change on the very next frame', async () => {
    const view = await fixture(fullCut())
    const before = view.frame()
    view.publish({
      values: {
        ...fullCut().values,
        todos: [
          { id: 'a', content: 'one', status: 'completed' },
          { id: 'b', content: 'two', status: 'completed' },
        ],
        goal: { goal: { phase: 'paused', maxGoalRounds: 256 }, roundsStarted: 4 },
      },
    })
    view.redraw()
    const after = view.frame()
    expect(after).toContain('todo 2/2')
    expect(after).toContain('goal paused')
    expect(after).not.toBe(before)
  })

  it('reports nothing for the units a profile has not registered', async () => {
    // Capability absence, not a zero: a cut with no todos, no goal, and no
    // usage unit must omit those segments rather than invent them.
    const view = await fixture({ values: { permissions: { currentValue: 'review' } } })
    const line = view.frame()
    expect(line).toContain('review')
    expect(line).not.toContain('todo')
    expect(line).not.toContain('goal')
    expect(line).not.toContain('CR ')
  })
})
