/**
 * Optional adapters for the Harness jobs and subagents seams.
 *
 * The class retains only lifecycle edges that Harness publishes and re-reads
 * snapshots/discovery from the services. It is intentionally not a second job
 * or subagent runtime.
 * @module dshline/work
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { JobRegistry, JobSnapshot } from '@deepseek-ai/dsh-jobs'
// The projection registry is read type-only through `ctx.get`, like every other
// optional Harness domain here: a profile may mount no projections at all, and
// the two units Work reads are contributed by the subagent runtime and the
// token meter rather than by this frontend.
import type { ProjectionSnapshot, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
// Activates the `subagentTiming` key on `SessionProjectionMap`. Type-only.
import type {} from '@deepseek-ai/dsh-subagent/client'
// Activates the `tokenUsage` key on the same map. Type-only, and a
// devDependency: the meter is an optional plugin, and its absence is a missing
// key rather than a zero.
import type {} from '@deepseek-ai/dsh-token-meter/client'
// The workflow seam's Context and Events merges, read type-only: a profile
// without an engine simply publishes no workflow events, and Work degrades to
// its jobs and subagents sections.
import type {} from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentInfo,
  WorkflowResultInfo,
  WorkflowRunInfo,
} from '@deepseek-ai/dsh-workflow/types'
import type {
  SubagentListEntry,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentRuntime,
} from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ChildActivityObserver } from './activity.ts'
import { HarnessWorkflows } from './workflows.ts'
import type { WorkflowCapabilities } from './workflows.ts'
import type {
  JobWorkItem,
  SubagentActiveTiming,
  SubagentRoute,
  SubagentWorkItem,
  WorkflowWorkItem,
  WorkInterruptResult,
  WorkSnapshot,
} from './model.ts'

/** The two projection units a live local child's Work row reads, and no others. */
const CHILD_PROJECTION_KEYS = ['subagentTiming', 'tokenUsage'] as const

/** Discovery facts retained only when the direct-child projection served them. */
interface DiscoveredSubagent {
  readonly mode?: 'one-shot' | 'continuable'
  readonly label?: string
  readonly residency?: 'resident' | 'stored'
  readonly hasChildren?: boolean
}

/**
 * One open lifecycle epoch. Keyed by the harness `runId` so a continuable
 * child that cold-resumes acquires a new epoch under the same durable session
 * id without collapsing two different residency observations into one row.
 */
interface LiveSubagent {
  readonly runId: string
  /** Durable child session id, stable across Activations. */
  readonly id: string
  readonly provider: string
  /** Snapshot of whether `SubagentRun.localAgent` was present at start. */
  readonly local: boolean
  readonly startedAt: number
  /**
   * Live-activity observer for an in-process child, disposed with this epoch.
   * Absent for a remote run with no local Agent and for an epoch whose child
   * never materialized; the row degrades to backend, label, and elapsed.
   * Mutated only by {@link HarnessWork.attachChild}, which is the sole owner.
   */
  activity?: ChildActivityObserver
  /**
   * The exact live child Agent, when one was resolvable. Held by object
   * identity beside the observer and released the moment Harness disposes it,
   * because it is what the row's route and projection reads go through: a
   * disposed Agent's session is not a fact about work in flight.
   */
  child?: Agent | undefined
}

/** Services and lifecycle observers the work projection consumes. */
export interface WorkCapabilities {
  /** The current agent owns job reads and interruption authorization. */
  readonly agent: Agent
  /** Optional generic background-job registry. */
  readonly jobs?: JobRegistry
  /** Optional generic subagent runtime. */
  readonly subagents?: SubagentRuntime
  /**
   * Optional live Agent registry, used to resolve an in-process child and fold
   * its semantic activity. A profile or provider without it gets no invented
   * activity — only the lifecycle row.
   */
  readonly agents?: Pick<AgentRegistry, 'get'>
  /** Optional tool definition resolution, for the child's own presentation. */
  readonly resolveTool?: (name: string, agent: Agent) => ToolDefinition | undefined
  /**
   * Optional session-projection registry, read ONLY for a resolved live child.
   * `snapshot()` is the cheap watermark-cached cut the seam exists to serve;
   * `tokenMeter.measure()` is O(surface) and belongs to `/context`, never to a
   * Work frame.
   */
  readonly projections?: Pick<SessionProjectionRegistry, 'snapshot'>
  /** Ask the scoped parent context for lifecycle starts. */
  readonly onSubagentStart?: (listener: (info: SubagentRunInfo) => void) => () => void
  /** Ask the scoped parent context for lifecycle ends. */
  readonly onSubagentEnd?: (listener: (info: SubagentRunEndInfo) => void) => () => void
  /**
   * Optional workflow projection. Owned here so consumers keep one snapshot and
   * one disposal, while the ownership rule that makes it safe stays in its own
   * module: workflow events name a run, never the session that started it.
   */
  readonly workflows?: WorkflowCapabilities
  /** Redraw the live region after a capability projection changes. */
  readonly invalidate: () => void
}

/**
 * Projects optional Harness work capabilities for terminal views.
 *
 * The only retained subagent state is the open lifecycle edge. Labels, mode,
 * residency, and child presence are repeatedly read from the direct-parent
 * `listChildren()` projection, while jobs are read directly from `list()` and
 * never through the consuming `read()` API. Live activity is an optional
 * enrichment: a resolved in-process child Agent is observed with the same
 * event-driven fold the main status uses, and everything disposes with the
 * epoch or with this projection.
 */
export class HarnessWork {
  private readonly liveSubagents = new Map<string, LiveSubagent>()
  private readonly discovered = new Map<string, DiscoveredSubagent>()
  private readonly disposers: (() => void)[] = []
  private readonly workflows: HarnessWorkflows | undefined
  private listingGeneration = 0

  constructor(private readonly capabilities: WorkCapabilities) {
    const { jobs, subagents, agent, onSubagentStart, onSubagentEnd } = capabilities
    this.workflows = capabilities.workflows === undefined
      ? undefined
      : new HarnessWorkflows(capabilities.workflows)
    if (jobs !== undefined) {
      // This is the pure observation seam. Completion delivery has model-facing
      // reporting semantics, so the view must not subscribe to it just to redraw.
      this.disposers.push(jobs.onJobsChanged(owner => {
        if (owner === undefined || owner === capabilities.agent) capabilities.invalidate()
      }))
    }
    if (subagents !== undefined) {
      if (onSubagentStart !== undefined) this.disposers.push(onSubagentStart(info => {
        const run: LiveSubagent = {
          runId: String(info.runId),
          id: String(info.id),
          provider: info.provider,
          local: info.local,
          startedAt: Date.now(),
        }
        this.liveSubagents.set(run.runId, run)
        this.attachChild(run)
        this.refreshSubagents()
        capabilities.invalidate()
      }))
      if (onSubagentEnd !== undefined) this.disposers.push(onSubagentEnd(info => {
        const run = this.liveSubagents.get(String(info.runId))
        run?.activity?.dispose()
        if (run !== undefined) run.child = undefined
        this.liveSubagents.delete(String(info.runId))
        this.refreshSubagents()
        capabilities.invalidate()
      }))
      // A local child can publish after its lifecycle start reaches this UI
      // (the start edge and Agent publication are separate events). Attach on
      // `agent/created` instead of polling; a run whose child never appears
      // simply keeps its lifecycle-only row.
      if (capabilities.agents !== undefined) {
        this.disposers.push(agent.ctx.on('agent/created', payload => {
          const id = String(payload.agent.session.id)
          for (const run of this.liveSubagents.values()) {
            if (run.local && run.id === id && run.child === undefined) this.attachChild(run)
          }
        }))
        // Release the Agent by the same object identity it was captured with.
        // The lifecycle edge may still be open — a settling run whose child has
        // already gone — and a disposed Agent's route, timing, and token
        // figures are last-known state, not current work. The observer stops
        // reporting activity at exactly the same edge, so the row degrades as
        // one fact rather than keeping a model route with no activity beside it.
        this.disposers.push(agent.ctx.on('agent/disposed', (payload: { agent: Agent }) => {
          for (const run of this.liveSubagents.values()) {
            if (run.child === payload.agent) run.child = undefined
          }
        }))
      }
      this.refreshSubagents()
    }
  }

  /** Stop listening to capability changes and release every child observer. */
  dispose(): void {
    this.listingGeneration += 1
    this.workflows?.dispose()
    for (const run of this.liveSubagents.values()) {
      run.activity?.dispose()
      run.child = undefined
    }
    this.liveSubagents.clear()
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  /**
   * Read the current capability-owned work records.
   * @returns active jobs and observed active subagent lifecycle epochs.
   */
  snapshot(): WorkSnapshot {
    const { jobs, subagents, agent } = this.capabilities
    const active = [...this.liveSubagents.values()].map(run => this.subagentItem(run))
    return {
      available: jobs !== undefined || subagents !== undefined,
      // Joined here and nowhere else: the workflow projection owns the records,
      // the subagent projection owns the epochs, and the `childId` Harness
      // publishes on a member is the one fact that relates them.
      workflows: this.workflows?.items(active) ?? [],
      subagents: active,
      jobs: jobs === undefined ? [] : this.jobItems(jobs, agent),
    }
  }

  /**
   * Interrupt work only where the owning generic seam exposes authority to do so.
   *
   * The operation is Harness `interrupt()` on a live continuable child: it
   * cancels the current turn, keeps the Activation, inbox, and descendants, and
   * is a fire-and-return signal rather than a deletion of the durable child.
   * @param item - selected work item.
   */
  interrupt(item: JobWorkItem | SubagentWorkItem | WorkflowWorkItem): WorkInterruptResult {
    const { agent, subagents } = this.capabilities
    // Job cancellation marks a record reported, changing model-delivery
    // semantics. `/work` observes jobs but must not recreate that control path.
    if (item.source === 'job') return { kind: 'unsupported', message: 'Jobs cannot be stopped from Work.' }
    // `ctx.workflowEngine` publishes `start()` alone: a run handle reaches only
    // its caller, so there is no authority here to cancel one from the terminal.
    if (item.source === 'workflow') return { kind: 'unsupported', message: 'Workflow runs cannot be stopped from Work.' }
    try {
      // One-shot runs have no service-level interrupt operation. Pretending they
      // do would lie about a capability that only their holder owns.
      if (subagents === undefined || !item.interruptible) {
        return { kind: 'unsupported', message: 'This subagent cannot be interrupted here.' }
      }
      subagents.interrupt(item.id as Parameters<SubagentRuntime['interrupt']>[0], {
        kind: 'user', parentSessionId: agent.session.id,
      })
      this.capabilities.invalidate()
      return { kind: 'requested', message: 'Interrupt requested.' }
    } catch (error: unknown) {
      // Authorization and producer-cancellation errors are actionable. Return
      // them to the overlay rather than letting a stale row make failure silent.
      const message = error instanceof Error ? error.message : String(error)
      this.capabilities.invalidate()
      return { kind: 'failed', message: `Interrupt failed: ${message}` }
    }
  }

  /**
   * Resolve this epoch's in-process child Agent and start observing it.
   *
   * The Agent is captured by exact object identity, so a later same-id
   * replacement can never fold into this epoch — and holding it, rather than
   * re-resolving an id per frame, is what lets the row read the child's own
   * route and projections from the same instance the activity fold is watching.
   */
  private attachChild(run: LiveSubagent): void {
    const { agents, agent, resolveTool, invalidate } = this.capabilities
    if (agents === undefined) return
    if (!run.local) return
    const child = agents.get(run.id as SessionId)
    if (child === undefined) return
    run.child = child
    run.activity = new ChildActivityObserver(
      agent.ctx,
      child,
      resolveTool === undefined ? () => undefined : name => resolveTool(name, child),
      invalidate,
    )
  }

  /** Read labels, mode, residency, and child presence from direct-child discovery. */
  private refreshSubagents(): void {
    const subagents = this.capabilities.subagents
    if (subagents === undefined) return
    const generation = ++this.listingGeneration
    void subagents.listChildren(this.capabilities.agent.session.id)
      .then(entries => {
        if (generation !== this.listingGeneration) return
        this.discovered.clear()
        for (const entry of entries) this.remember(entry)
        this.capabilities.invalidate()
      })
      // Discovery is optional enrichment. The lifecycle edges remain useful if a
      // profile intentionally lacks the projection or persistence services.
      .catch(() => {})
  }

  /**
   * Store only discovery facts the service explicitly returned.
   *
   * `activity` is session-store residency — a live or persisted record slot,
   * not a model turn in flight — so it is mapped to residency wording rather
   * than presented as progress.
   */
  private remember(entry: SubagentListEntry): void {
    if (entry.kind !== 'child') return
    this.discovered.set(String(entry.id), {
      mode: entry.mode,
      residency: entry.activity === 'running' ? 'resident' : 'stored',
      hasChildren: entry.hasChildren,
      ...entry.label === undefined ? {} : { label: entry.label },
    })
  }

  /** Convert non-terminal job snapshots without consuming their output cursor. */
  private jobItems(jobs: JobRegistry, agent: Agent): JobWorkItem[] {
    let snapshots: JobSnapshot[]
    try {
      snapshots = jobs.list(agent)
    } catch {
      return []
    }
    return snapshots
      .filter((snapshot): snapshot is JobSnapshot & { status: 'running' | 'stopping' } => (
        snapshot.status === 'running' || snapshot.status === 'stopping'
      ))
      .map(snapshot => ({
        id: String(snapshot.id),
        source: 'job' as const,
        kind: snapshot.kind,
        label: snapshot.label,
        state: snapshot.status,
        startedAt: snapshot.startedAt,
        ...snapshot.detail === undefined ? {} : { detail: snapshot.detail },
        // `jobs.kill()` changes model-delivery (`reported`) semantics. It is a
        // model control operation, not a human-safe Work action.
        ownership: snapshot.ownerSession === agent.session.id ? 'this-session' as const : 'unowned' as const,
        interruptible: false as const,
      }))
  }

  /**
   * Read the two child projection units, for a live local child only.
   *
   * Deliberately keyed off the resolved Agent rather than the child's session
   * id: a provider-managed child may well have a durable session somewhere,
   * and reading projections off it by id would let `/work` publish telemetry
   * about a worker whose computation it cannot observe. The projection cut is
   * the seam's cheap read face — a watermark-cached snapshot narrowed to the
   * two keys — not `tokenMeter.measure()`.
   */
  private childProjections(child: Agent | undefined): ProjectionSnapshot | undefined {
    const { projections } = this.capabilities
    if (child === undefined || projections === undefined) return undefined
    try {
      return projections.snapshot(child.session, CHILD_PROJECTION_KEYS)
    } catch {
      // A projection value that fails its own wire schema is the registry's
      // problem, not a reason for the live region to stop drawing the row.
      return undefined
    }
  }

  /** Convert a published lifecycle edge, enriching it only with discovery data. */
  private subagentItem(run: LiveSubagent): SubagentWorkItem {
    const discovered = this.discovered.get(run.id)
    const reading = run.activity?.reading()
    const route = childRoute(run.child)
    const projected = this.childProjections(run.child)
    const timing = projected?.values.subagentTiming
    const tokens = childTokens(run.child, projected)
    return {
      id: run.id,
      source: 'subagent',
      runId: run.runId,
      provider: run.provider,
      local: run.local,
      state: 'running',
      startedAt: run.startedAt,
      interruptible: discovered?.mode === 'continuable',
      ...discovered?.label === undefined ? {} : { label: discovered.label },
      ...discovered?.mode === undefined ? {} : { mode: discovered.mode },
      ...discovered?.residency === undefined ? {} : { residency: discovered.residency },
      ...discovered?.hasChildren === undefined ? {} : { hasChildren: discovered.hasChildren },
      // Live activity is optional enrichment; every fact below is omitted when
      // no in-process child Agent was observable, never guessed.
      ...reading?.word === undefined ? {} : { activityWord: reading.word },
      ...reading?.title === undefined ? {} : { activityTitle: reading.title },
      ...reading === undefined ? {} : { busy: reading.busy },
      ...reading?.status === undefined ? {} : { agentStatus: reading.status },
      ...route === undefined ? {} : { route },
      ...timing === undefined ? {} : { timing: timing satisfies SubagentActiveTiming },
      ...tokens === undefined ? {} : { tokens },
    }
  }
}

/**
 * The LLM route a live child's requests actually use.
 *
 * `Session.requestHeader()` is the canonical fold of the log's `request/header`
 * snapshots — the envelope the next request will be compared against — so once
 * the child has made a request it is the effective route, and a later route
 * change is simply a later header snapshot that the same fold returns. It wins
 * over `Agent.options`, which is only what the child was CREATED with and can
 * be stale the moment a delegated model selection or a route change lands.
 *
 * The two sources are never mixed field by field. A header is one envelope: if
 * it carries no reasoning effort, that route has none, and borrowing the
 * creation-time value would report an effort no request used. `Agent.options`
 * is the whole fallback, and only before the first header exists.
 * @param child - the live child Agent, or undefined for a provider-managed run.
 * @returns the route, or undefined when neither source names a provider and model.
 */
function childRoute(child: Agent | undefined): SubagentRoute | undefined {
  if (child === undefined) return undefined
  const logged = child.session.requestHeader()?.config
  if (logged !== undefined) {
    return {
      provider: logged.provider,
      model: logged.model,
      ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
    }
  }
  const created = child.options
  // Both fields are optional on `AgentOptions`: a child that named neither
  // inherits whatever the loop resolves, and this projection does not guess it.
  if (created.provider === undefined || created.model === undefined) return undefined
  return {
    provider: created.provider,
    model: created.model,
    ...created.reasoningEffort === undefined ? {} : { reasoningEffort: created.reasoningEffort },
  }
}

/**
 * The token total attributable to THIS child, from the `tokenUsage` projection.
 *
 * The four buckets are disjoint by upstream's contract — reasoning tokens are
 * already inside `outputTokens` — so their sum is the total and nothing is
 * counted twice. An unregistered unit yields undefined rather than 0: a zero
 * would read as "this child spent nothing", which is a different claim from
 * "this profile does not meter tokens".
 *
 * The inherited-history gate is the load-bearing part, and it is where
 * `tokenUsage` and `subagentTiming` genuinely differ. `subagentTiming` resets
 * its accumulation at every `subagent/descriptor`, deliberately, so a forked
 * child's own descriptor makes that projection child-relative. `tokenUsage`
 * has no such reset: it folds provider-reported usage over the COMPLETE log,
 * and the registry builds every cell from seq 0, so a child seeded with its
 * parent's completed-turn prefix inherits that prefix's usage into the same
 * figure. Labelling the sum `tokens` inside one worker's detail view would
 * then claim this worker spent what its parent had already spent.
 *
 * `Session.inheritedEventCount` is the generic Harness lineage fact that
 * decides it — the durable fork cut, not a backend name and not a re-fold of
 * `ownEvents()`. A zero cut means the whole log is the child's, so the whole
 * projection is attributable to it; anything above zero means it is not, and
 * the fact is omitted. Absence beats a plausible but unproven number.
 * @param child - the live child Agent, whose Session carries the lineage cut.
 * @param projected - the child's projection cut, when one was read.
 * @returns the total, or undefined when the unit is absent or the log is seeded.
 */
function childTokens(
  child: Agent | undefined,
  projected: ProjectionSnapshot | undefined,
): number | undefined {
  const usage = projected?.values.tokenUsage
  if (child === undefined || usage === undefined) return undefined
  if (child.session.inheritedEventCount > 0) return undefined
  return usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/**
 * Fold the live `workflow/*` events worth observing into one enrichment callback.
 *
 * The events are subscribed on the plugin context, not the agent's scoped one:
 * the engine emits them unscoped, so a scoped listener would be a guess about
 * routing. Ownership is not solved here at all — the projection drops every run
 * whose durable record is absent from the attached session's own log.
 *
 * Four of the six `workflow/*` events are subscribed, and the two that are not
 * are omitted because they can carry nothing this view could keep:
 *
 * - `workflow/start` is emitted synchronously INSIDE `workflowEngine.start()`,
 *   so it always precedes the `tool-workflow/run-start` record the tool appends
 *   after that call returns. The ownership gate therefore drops it every time,
 *   and buffering unowned runs to catch it is the retention the gate exists to
 *   prevent. Nothing is lost: its only payload is meta, which every later event
 *   of the same run carries, and `workflow/end` always fires.
 * - `workflow/agent-end` is emitted exactly once per STARTED call, so a
 *   preceding `workflow/agent-start` for that same run has already delivered
 *   the identical meta. Members come from the durable records either way.
 * @param ctx - host context the engine emits on.
 * @returns a subscription for the reduced observation stream.
 */
function workflowObservations(
  ctx: Context,
): NonNullable<WorkflowCapabilities['onWorkflowObservation']> {
  return listener => {
    const disposers = [
      ctx.on('workflow/phase', (info: WorkflowRunInfo, title: string) => {
        listener(String(info.id), info.meta, { kind: 'phase', title })
      }),
      ctx.on('workflow/log', (info: WorkflowRunInfo, message: string) => {
        listener(String(info.id), info.meta, { kind: 'log', message })
      }),
      // META only. Members come from the durable records — the same facts
      // written by the same tool — and having one source removes any question
      // of which won a race. This subscription exists so a script that only
      // calls `agent()` still recovers its description before it settles.
      ctx.on('workflow/agent-start', (info: WorkflowRunInfo, _agent: WorkflowAgentInfo) => {
        listener(String(info.id), info.meta, { kind: 'meta' })
      }),
      ctx.on('workflow/end', (info: WorkflowRunInfo, result: WorkflowResultInfo) => {
        listener(String(info.id), info.meta, {
          kind: 'end', stopReason: result.stopReason, agentsStarted: result.agentsStarted,
        })
      }),
    ]
    return () => { for (const dispose of disposers.splice(0)) dispose() }
  }
}

/**
 * Connect the work projection to this runner's optional services and scoped
 * parent lifecycle events.
 * @param ctx - host context holding optional generic services.
 * @param agent - session agent whose work the view may present.
 * @param invalidate - redraw request for projection changes.
 * @returns the internal work integration.
 */
export function createHarnessWork(ctx: Context, agent: Agent, invalidate: () => void): HarnessWork {
  const jobs = ctx.get('jobs')
  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents')
  const tools = ctx.get('tools')
  const projections = ctx.get('sessionProjections')
  // The durable records live in the session log whether or not this process
  // mounted an engine, so the record listener is unconditional; only the live
  // enrichment depends on the optional seam being present.
  const workflows: WorkflowCapabilities = {
    session: agent.session,
    onSessionEvent: listener => ctx.on(
      'session/event',
      (session: Session, event: SessionEvent) => { listener(session, event) },
    ),
    ...ctx.get('workflowEngine') === undefined
      ? {}
      : { onWorkflowObservation: workflowObservations(ctx) },
    invalidate,
  }
  return new HarnessWork({
    agent,
    workflows,
    invalidate,
    ...jobs === undefined ? {} : { jobs },
    ...agents === undefined ? {} : { agents },
    ...projections === undefined ? {} : { projections },
    ...tools === undefined
      ? {}
      : { resolveTool: (name: string, child: Agent) => tools.get(name, child) },
    ...subagents === undefined
      ? {}
      : {
        subagents,
        // Register on the parent agent's context: Harness scopes these lifecycle
        // edges by the delegating parent, so another session cannot leak into this UI.
        onSubagentStart: (listener: (info: SubagentRunInfo) => void) => agent.ctx.on('subagent/start', listener),
        onSubagentEnd: (listener: (info: SubagentRunEndInfo) => void) => agent.ctx.on('subagent/end', listener),
      },
  })
}
