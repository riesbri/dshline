/**
 * The status line's Work segment, read as counts rather than as rows.
 *
 * Two things are held here at once, and they are why this file exists beside
 * the Work row tests rather than inside them:
 *
 * - the SEGMENT must be exactly what `workSummary(work.snapshot())` said. The
 *   narrow read is an optimization, so the text it produces is checked against
 *   the text the full projection produces, over every combination of jobs, loose
 *   subagents, workflow-owned children, and absent optional capabilities;
 * - the READ must be cheap. Every enrichment the row path reaches for — the
 *   child's route fold, its child projection cut, its inherited-event count — is
 *   instrumented, and the doubles are proven live by first showing the full
 *   snapshot driving all three.
 *
 * The doubles double as the live-change evidence. Nothing is memoized between
 * calls, so a job settling, a subagent starting or ending, and a workflow member
 * moving are all visible on the very next read, with no invalidation step of
 * this frontend's own in between.
 * @module dshline/tests/work-status
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobRegistry, JobView } from '@deepseek-ai/dsh-jobs'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo, SubagentRunInfo, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { HarnessWork } from '../src/work/index.ts'
import type { WorkCapabilities } from '../src/work/index.ts'
import { workSummary } from '../src/work/model.ts'

/** The session every count in this file belongs to. */
const ROOT = SessionId('root')

/** The exact listener `HarnessWork` registers for a `subagent/start` edge. */
type StartListener = Parameters<NonNullable<WorkCapabilities['onSubagentStart']>>[0]

/** The exact listener `HarnessWork` registers for a `subagent/end` edge. */
type EndListener = Parameters<NonNullable<WorkCapabilities['onSubagentEnd']>>[0]

/**
 * The child projection cut the double publishes.
 *
 * A real `tokenUsage` bucket, because the row's token total is gated behind it:
 * with no usage value the row would stop before reading the child's lineage, and
 * an assertion that the count skips that read would then be true of a double
 * that is wired to nothing.
 */
const CHILD_CUT: ProjectionSnapshot = {
  asOfSeq: 0,
  values: {
    tokenUsage: {
      uncachedInputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    },
  },
}

/** A registry view carrying only what Work is allowed to present. */
function view(overrides: Partial<JobView> = {}): JobView {
  return {
    id: JobId('bash-1'),
    kind: 'bash',
    label: 'pnpm test',
    status: 'running',
    startedAt: 0,
    owner: ROOT,
    output: { total: 0, earliest: 0 },
    ...overrides,
  } as JobView
}

/** What the jobs double publishes, and how often it was asked. */
interface JobsSeam {
  readonly jobs: JobRegistry
  /** Publish a different view list, as the registry would after an event. */
  publish: (views: JobView[]) => void
  /** How many times `list()` was read; a count must still be a read. */
  lists: () => number
}

/**
 * A jobs double whose `list()` answer a test can change between reads.
 * @param initial - what it publishes first.
 * @returns the registry, its publisher, and its read counter.
 */
function jobsSeam(initial: JobView[]): JobsSeam {
  let published = initial
  let lists = 0
  return {
    jobs: {
      list: (): JobView[] => {
        lists += 1
        return published
      },
      events: { subscribe: () => () => {} },
    } as unknown as JobRegistry,
    publish: views => { published = views },
    lists: () => lists,
  }
}

/** What the child-enrichment instrumentation recorded since the last reset. */
interface Enrichment {
  /** `session.requestHeader()` folds, which is how a row learns its route. */
  routes: number
  /** Child projection cuts, each keyed and validated by the registry. */
  projections: number
  /** `inheritedEventCount` reads, which gate a child's token total. */
  inherited: number
}

/** One live child Agent, with every row-only read counted. */
function childAgent(enrichment: Enrichment): Agent {
  const session = {
    id: SessionId('child'),
    seq: 0,
    eventAt: () => undefined,
    requestHeader: (): undefined => {
      enrichment.routes += 1
      return undefined
    },
    surface: { nodes: [], replaceGeneration: 0 },
  }
  return {
    session: Object.defineProperty(session, 'inheritedEventCount', {
      get: (): number => {
        enrichment.inherited += 1
        return 0
      },
    }) as unknown as Session,
    status: 'running',
    options: {},
    ctx: new Context(),
  } as unknown as Agent
}

/** A child projection seam that records every cut it is asked for. */
function projectionSeam(enrichment: Enrichment): { snapshot: () => ProjectionSnapshot } {
  return {
    snapshot: (): ProjectionSnapshot => {
      enrichment.projections += 1
      return CHILD_CUT
    },
  }
}

/** What a driver is built with: which optional capabilities exist at all. */
interface DriverOptions {
  /** The jobs double, or omitted for a profile with no jobs registry. */
  readonly jobs?: JobsSeam
  /** Whether the subagent runtime and its lifecycle edges are composed. */
  readonly subagents?: boolean
  /** Whether durable workflow records are folded for this session. */
  readonly workflows?: boolean
  /** Whether a live in-process child resolves through the agent registry. */
  readonly child?: boolean
  /** Whether the child projection registry is composed. */
  readonly projections?: boolean
  /** Where the instrumentation is recorded; shared with the child doubles. */
  readonly enrichment?: Enrichment
}

/** A driven projection: the counts it can be asked for, and its instrumentation. */
interface Driver {
  readonly work: HarnessWork
  /** Open a subagent lifecycle epoch, as `subagent/start` would. */
  start: (id: string, runId: string) => void
  /** Close one, as `subagent/end` would. */
  end: (id: string, runId: string) => void
  /** Append a durable workflow record to the attached session's log. */
  append: (event: SessionEvent) => void
  /** Forget the recorded enrichment, so one read can be measured alone. */
  reset: () => void
  /** The instrumentation itself, shared with the doubles that fill it. */
  readonly enrichment: Enrichment
}

/** One durable `tool-workflow/*` record, in the shape the fold reads. */
function record(type: string, data: unknown): SessionEvent {
  return { type, seq: 1, time: 1_000, data } as unknown as SessionEvent
}

/** Open an owned run in the attached session's log. */
function runStart(runId: string, name = 'audit'): SessionEvent {
  return record('tool-workflow/run-start', { runId, name })
}

/** Publish one member of an owned run, bound to a durable child session. */
function agentStart(runId: string, childId: string, seq = 1): SessionEvent {
  return record('tool-workflow/agent-start', { runId, seq, label: 'architecture', childId })
}

/** Settle one member of an owned run. */
function agentEnd(runId: string, seq = 1): SessionEvent {
  return record('tool-workflow/agent-end', { runId, seq, outcome: 'completed' })
}

/**
 * Build a projection over whichever capabilities the options compose.
 * @param options - which optional seams exist, and what they publish.
 * @returns the projection plus every way a test can drive it.
 */
function driver(options: DriverOptions = {}): Driver {
  const enrichment = options.enrichment ?? { routes: 0, projections: 0, inherited: 0 }
  const ctx = new Context()
  const projections = options.projections === true ? projectionSeam(enrichment) : undefined
  const subagents = options.subagents === false
    ? undefined
    : ({ listDescendants: async () => [] } as unknown as SubagentRuntime)
  let started: StartListener | undefined
  let ended: EndListener | undefined
  let append: (session: Session, event: SessionEvent) => void = () => {}
  const agent = {
    session: { id: ROOT, header: { cwd: '/ws' } },
    ctx,
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
  } as unknown as Agent
  const work = new HarnessWork({
    agent,
    invalidate: () => {},
    ...options.jobs === undefined ? {} : { jobs: options.jobs.jobs },
    ...subagents === undefined
      ? {}
      : {
        subagents,
        onSubagentStart: listener => { started = listener; return () => { started = undefined } },
        onSubagentEnd: listener => { ended = listener; return () => { ended = undefined } },
      },
    // A live child resolves through the agent registry, so the row path and the
    // count path are looking at one object identity.
    ...options.child === true
      ? { agents: { get: () => childAgent(enrichment) } as never }
      : {},
    ...projections === undefined ? {} : { projections },
    ...options.workflows === false
      ? {}
      : {
        workflows: {
          session: agent.session,
          onSessionEvent: listener => {
            append = listener
            return () => { append = () => {} }
          },
          invalidate: () => {},
        },
      },
  })
  return {
    work,
    start: (id, runId) => {
      const info: SubagentRunInfo = {
        runId: SubagentRunId(runId),
        id: SessionId(id),
        provider: 'codex',
        local: true,
      }
      started?.(info)
    },
    end: (id, runId) => {
      const info: SubagentRunEndInfo = {
        runId: SubagentRunId(runId),
        id: SessionId(id),
        provider: 'codex',
        local: true,
        stopReason: 'completed',
      }
      ended?.(info)
    },
    append: event => { append(agent.session, event) },
    reset: () => { enrichment.routes = 0; enrichment.projections = 0; enrichment.inherited = 0 },
    enrichment,
  }
}

/** Let an async discovery read publish its harmless enrichment. */
async function settled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('the status line work segment', () => {
  it('agrees with the full snapshot across jobs, loose children, and workflow members', async () => {
    // Each case arranges a state, then asks the two readers the same question.
    // The row path is the reference: it is the text the footer drew before, and
    // the narrow read has to be indistinguishable from it in every one. The job
    // list is part of the case, and `undefined` is a profile with no registry.
    const cases: readonly (readonly [
      string,
      readonly JobView[] | undefined,
      (drive: Driver) => void,
    ])[] = [
      ['nothing at all', [], () => {}],
      ['no jobs capability', undefined, () => {}],
      ['one job', [view()], () => {}],
      ['three jobs', [view({ id: JobId('a') }), view({ id: JobId('b') }), view({ id: JobId('c') })], () => {}],
      ['a settled job is not work', [view({ status: 'completed' })], () => {}],
      ['a stopping job still is', [view({ status: 'stopping' })], () => {}],
      ['one loose subagent', [], drive => { drive.start('child', 'r1') }],
      ['three loose subagents', [], drive => {
        drive.start('a', 'ra')
        drive.start('b', 'rb')
        drive.start('c', 'rc')
      }],
      ['a workflow and no children yet', [], drive => { drive.append(runStart('run-1')) }],
      ['a workflow whose member is the live child', [], drive => {
        drive.append(runStart('run-1'))
        drive.append(agentStart('run-1', 'child'))
        drive.start('child', 'r1')
      }],
      ['a workflow, a claimed child, and a loose one', [], drive => {
        drive.append(runStart('run-1'))
        drive.append(agentStart('run-1', 'child'))
        drive.start('child', 'r1')
        drive.start('loose', 'r2')
      }],
      ['two members of one run, both live', [], drive => {
        drive.append(runStart('run-1'))
        drive.append(agentStart('run-1', 'a', 1))
        drive.append(agentStart('run-1', 'b', 2))
        drive.start('a', 'r1')
        drive.start('b', 'r2')
      }],
      ['a settled member releases its claim', [], drive => {
        drive.append(runStart('run-1'))
        drive.append(agentStart('run-1', 'child'))
        drive.append(agentEnd('run-1'))
        drive.start('child', 'r1')
      }],
      ['a settled run releases every claim', [], drive => {
        drive.append(runStart('run-1'))
        drive.append(agentStart('run-1', 'child'))
        drive.append(record('tool-workflow/run-end', { runId: 'run-1' }))
        drive.start('child', 'r1')
      }],
      ['a live child no workflow claims', [], drive => { drive.start('child', 'r1') }],
      ['two workflows', [], drive => {
        drive.append(runStart('run-1', 'one'))
        drive.append(runStart('run-2', 'two'))
      }],
      ['everything at once', [view({ id: JobId('a') }), view({ id: JobId('b') })], drive => {
        drive.append(runStart('run-1'))
        drive.append(agentStart('run-1', 'child'))
        drive.start('child', 'r1')
        drive.start('loose', 'r2')
      }],
    ]
    for (const [name, jobViews, arrange] of cases) {
      const drive = driver({ jobs: jobViews === undefined ? undefined : jobsSeam(jobViews) })
      await settled()
      arrange(drive)
      const narrow = drive.work.summary()
      const rows = drive.work.snapshot()
      expect(narrow, name).toBe(workSummary(rows))
      drive.work.dispose()
    }
  })

  it('counts a workflow once and never a child it already presents', async () => {
    const drive = driver({})
    await settled()
    drive.append(runStart('run-1'))
    drive.append(agentStart('run-1', 'child'))
    drive.start('child', 'r1')
    // One child, shown under its workflow: the segment names the workflow.
    expect(drive.work.summary()).toBe('1 workflow')
    // A second, unclaimed child counts as itself.
    drive.start('loose', 'r2')
    expect(drive.work.summary()).toBe('1 workflow · 1 subagent')
    // Settling the member releases the claim, and the child is counted again.
    drive.append(agentEnd('run-1'))
    expect(drive.work.summary()).toBe('1 workflow · 2 subagents')
    drive.work.dispose()
  })

  it('keeps jobs, subagents, and workflows as three separate authorities', async () => {
    const seams = jobsSeam([view()])
    const drive = driver({ jobs: seams })
    await settled()
    expect(drive.work.summary()).toBe('1 job')
    drive.start('child', 'r1')
    expect(drive.work.summary()).toBe('1 subagent · 1 job')
    drive.append(runStart('run-1'))
    expect(drive.work.summary()).toBe('1 workflow · 1 subagent · 1 job')
    drive.work.dispose()
  })

  it('reads no child route, activity, or projection cut for a count', async () => {
    const drive = driver({ child: true, projections: true })
    await settled()
    drive.start('child', 'r1')
    drive.append(runStart('run-1'))
    drive.append(agentStart('run-1', 'child'))

    // The doubles are live: the row path drives all three, every time it runs.
    drive.reset()
    drive.work.snapshot()
    expect(drive.enrichment.routes, 'the row reads the child route').toBeGreaterThan(0)
    expect(drive.enrichment.projections, 'the row reads child projections').toBeGreaterThan(0)
    expect(drive.enrichment.inherited, 'the row reads the child lineage').toBeGreaterThan(0)

    // The count drives none of them.
    drive.reset()
    expect(drive.work.summary()).toBe('1 workflow')
    expect(drive.enrichment).toEqual({ routes: 0, projections: 0, inherited: 0 })
    drive.work.dispose()
  })

  it('follows every live change on the next read, with nothing to invalidate', async () => {
    const seams = jobsSeam([view()])
    const drive = driver({ jobs: seams })
    await settled()
    expect(drive.work.summary()).toBe('1 job')
    const readsBefore = seams.lists()

    // A job settles: the registry stops publishing it, and the count follows.
    seams.publish([])
    expect(drive.work.summary()).toBeUndefined()
    // …by reading the registry again, not from a remembered count.
    expect(seams.lists()).toBeGreaterThan(readsBefore)

    // A subagent starts, a second one joins, and one ends.
    seams.publish([view()])
    drive.start('child', 'r1')
    expect(drive.work.summary()).toBe('1 subagent · 1 job')
    drive.start('other', 'r2')
    expect(drive.work.summary()).toBe('2 subagents · 1 job')
    drive.end('other', 'r2')
    expect(drive.work.summary()).toBe('1 subagent · 1 job')

    // A workflow opens and claims that child, so it is counted under the workflow
    // and not again as a loose subagent — and settling the member releases the
    // claim on the very next read, with nothing of this frontend's own to
    // invalidate in between.
    drive.append(runStart('run-1'))
    drive.append(agentStart('run-1', 'child'))
    expect(drive.work.summary()).toBe('1 workflow · 1 job')
    drive.append(agentEnd('run-1'))
    expect(drive.work.summary()).toBe('1 workflow · 1 subagent · 1 job')
    drive.work.dispose()
  })

  it('reports nothing when the optional seams are absent entirely', async () => {
    const drive = driver({ subagents: false, workflows: false })
    await settled()
    expect(drive.work.summary()).toBeUndefined()
    expect(drive.work.summary()).toBe(workSummary(drive.work.snapshot()))
    drive.work.dispose()
  })
})
