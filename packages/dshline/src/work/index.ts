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
import type { JobRegistry, JobView } from '@deepseek-ai/dsh-jobs'
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
  SubagentDescendantListEntry,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentRuntime,
} from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ChildActivityObserver } from './activity.ts'
import { HarnessWorkflows } from './workflows.ts'
import type { WorkflowCapabilities } from './workflows.ts'
import { observeJobOutput } from './jobs.ts'
import type { JobOutputObservation } from './jobs.ts'
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

/**
 * The edge distance `listDescendants` reports for a child of the requested
 * parent; every deeper row belongs to some other parent's branch.
 */
const DIRECT_CHILD_DEPTH = 1

/**
 * The reason dshline records when a HUMAN stops a Job from `/work`.
 *
 * Harness's own human-facing controller uses this exact string, and the string
 * matters: the registry merges it into the killed Job's terminal `detail`, so
 * it reaches the owning agent inside the ordinary completion notice as
 * `[stopped: cancelled by the user]`. Reusing the upstream wording is what keeps
 * one cancellation reason in the product rather than two, and it is deliberately
 * NOT phrased as anything the model asked for — the adopted generation's whole
 * point is that a human stop and a model stop are different acts.
 */
const JOB_STOP_REASON = 'cancelled by the user'

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
 * residency, and child presence are repeatedly read from the parent-relative
 * `listDescendants()` catalog, while jobs are read directly from `list()` and
 * never through the consuming `read()` API. Live activity is an optional
 * enrichment: a resolved in-process child Agent is observed with the same
 * event-driven fold the main status uses, and everything disposes with the
 * epoch or with this projection.
 */
export class HarnessWork {
  private readonly liveSubagents = new Map<string, LiveSubagent>()
  private readonly discovered = new Map<string, DiscoveredSubagent>()
  private readonly disposers: (() => void)[] = []
  /**
   * Job output observations handed out and not yet disposed.
   *
   * The overlay owns the handle it is given and disposes it on every path out
   * of a Job detail; this set exists so {@link dispose} can contain a
   * still-live one. It is emptied as handles are released, so it reads as "what
   * a teardown mistake would leak", not as a second owner.
   */
  private readonly jobObservations = new Set<JobOutputObservation>()
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
      // `{ owner }` already selects what this session can see — its own jobs
      // plus every unowned one — so the filter does the work the old owner
      // comparison did, and no other session's change can reach this listener.
      this.disposers.push(jobs.events.subscribe({ owner: capabilities.agent.session.id }, event => {
        switch (event.type) {
          // The events that can add, re-state, or retire a Work row: a
          // registration is a new row, a progress line re-states one, a stop or
          // a settlement changes what `list()` filters to, and a removal empties
          // the section.
          //
          // `progress` became a row change with Jobs 2.0. It was ignored while
          // Work threw the fact away, and a fact a row can now show is a fact
          // whose silence would leave the row lying about what the Job is doing.
          case 'registered':
          case 'progress':
          case 'stopping':
          case 'settled':
          case 'removed':
            capabilities.invalidate()
            break
          // A ring append is NOT a row change, and must stay out of this switch
          // for the cost reason rather than an information one: it arrives once
          // per chunk, so repainting the whole live region per chunk would be
          // repaint. The one place output is read is the open Job detail stage,
          // which subscribes to exactly its own Job — see `observeJob`.
          case 'output':
            break
        }
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
    // Containment, not ownership. The overlay disposes its Job observer the
    // moment a detail stage closes, so this set is normally empty; it exists so
    // that a teardown ORDERING mistake — a stage still open when the attachment
    // tears down — cannot leave a live registry subscription calling
    // `invalidate()` into the next attached session's live region.
    for (const observation of this.jobObservations) observation.dispose()
    this.jobObservations.clear()
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
   * Interrupt a subagent only where the owning generic seam exposes authority.
   *
   * The operation is Harness `interrupt()` on a live continuable child: it
   * cancels the current turn, keeps the Activation, inbox, and descendants, and
   * is a fire-and-return signal rather than a deletion of the durable child. A
   * Job stop is deliberately NOT this method — see {@link stopJob} — and a
   * workflow run has no authority here at all, because `ctx.workflowEngine`
   * publishes `start()` alone.
   * @param item - the selected subagent row.
   * @returns the outcome as one short user-facing sentence.
   */
  interruptSubagent(item: SubagentWorkItem | WorkflowWorkItem): WorkInterruptResult {
    const { agent, subagents } = this.capabilities
    // A workflow run handle reaches only its caller, so there is no authority
    // here to cancel one from the terminal.
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
   * Ask Harness to stop one running Job, on a human's behalf.
   *
   * This is the generic registry cancellation, and it is safe for a HUMAN to
   * call in a way an older generation's registry was not. That generation kept
   * a "reported" bit on the record: calling `kill()` from anywhere meant the
   * model would never be told the Job had stopped, which is a correct
   * optimization for the ONE caller that existed — the model's own `job_kill`,
   * whose tool result already says what it did — and a stale world model for
   * anyone else. The adopted generation separates the two: the registry owns
   * cancellation, and `dsh-tool-jobs` owns a private ledger of the jobs its own
   * tool already delivered. A human stop enters no such ledger, so Harness
   * settlement and the completion reporter deliver the ordinary outcome to the
   * owning agent, with the reason merged into its detail. dshline's own
   * responsibility is therefore narrow and exactly what this method does: call
   * the registry, with this session as the fenced caller, and claim nothing
   * about delivery.
   *
   * Every Job kind the registry holds gains the control at once, because the
   * call names an id and never a kind, a provider, or a subprocess.
   * @param item - the inspected Job row.
   * @returns the outcome as one short user-facing sentence.
   */
  stopJob(item: JobWorkItem): WorkInterruptResult {
    const { jobs, agent } = this.capabilities
    if (jobs === undefined) return { kind: 'unsupported', message: 'Jobs are not installed in this profile.' }
    // A Job that is already stopping asked for this already. A second stop is
    // not a decision, so it is not offered and saying so would only add a row.
    if (item.state !== 'running') return { kind: 'unsupported', message: 'This job is already stopping.' }
    try {
      const outcome = jobs.kill(
        item.id as Parameters<JobRegistry['kill']>[0],
        agent.session.id,
        JOB_STOP_REASON,
      )
      // Refresh in every outcome. `requested` re-states the row through the
      // authoritative `stopping` transition, and settlement is what removes the
      // row — the refresh is what lets both be seen, so no local state is
      // mutated to stand in for the registry.
      this.capabilities.invalidate()
      if (outcome === 'already-finished') {
        // A race, not a failure: the Job settled between the row being drawn and
        // the press landing. The refresh above empties the section, and the row
        // is NOT kept around to host this sentence — `/work` is active-only.
        return { kind: 'requested', message: 'That job has already finished.' }
      }
      return { kind: 'requested', message: 'Stop requested.' }
    } catch (error: unknown) {
      // A producer `cancel()` throw propagates by the registry's own contract
      // and leaves the Job exactly as it was, so nothing local is changed here
      // and the next snapshot remains the truth. Authorization and unknown-job
      // errors surface the same way rather than being swallowed.
      const message = error instanceof Error ? error.message : String(error)
      this.capabilities.invalidate()
      return { kind: 'failed', message: `Stop failed: ${message}` }
    }
  }

  /**
   * Begin observing one Job's retained output, non-consumingly.
   *
   * Demand-driven by construction: nothing here runs until a Job detail stage is
   * actually opened, the `/work` overview does exactly zero output reads, and
   * the handle is dead the moment the stage closes. The read is `readAt`, never
   * the consuming `read`, so a human watching a Job's output cannot take a
   * single byte from the model's own cursor.
   *
   * The caller OWNS the returned handle and must dispose it. This projection
   * keeps a containment set so {@link dispose} can catch a leaked one.
   * @param id - the exact Job id to inspect.
   * @returns an open observation, or undefined when the Job is not observable.
   */
  observeJob(id: string): JobOutputObservation | undefined {
    const { jobs, agent } = this.capabilities
    if (jobs === undefined) return undefined
    const observation = observeJobOutput({
      jobs,
      id,
      caller: agent.session.id,
      invalidate: this.capabilities.invalidate,
    })
    if (observation === undefined) return undefined
    this.jobObservations.add(observation)
    const release = (): void => {
      this.jobObservations.delete(observation)
      observation.dispose()
    }
    return {
      reading: () => observation.reading(),
      dispose: release,
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

  /**
   * Read labels, mode, residency, and child presence from direct-child discovery.
   *
   * The recursive catalog is the only seam that publishes those four as one
   * row: `listChildren` answers with the flat parent catalog, which carries no
   * session-store residency, no lineage, and no branch diagnostic, so a row
   * built from it could never name a durable conversation to open. Depth one
   * is this parent's direct child; the traversal reads deeper only because the
   * seam publishes no direct-children-only form of these rows.
   */
  private refreshSubagents(): void {
    const subagents = this.capabilities.subagents
    if (subagents === undefined) return
    const generation = ++this.listingGeneration
    void subagents.listDescendants(this.capabilities.agent.session.id)
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
  private remember(entry: SubagentDescendantListEntry): void {
    // A diagnostic is the seam reporting that it has no descriptor to give:
    // the child's own catalog read failed (`corrupt`/`unavailable`), or the
    // parent records a child mode this generation does not know
    // (`unsupported`). None of the three yields a mode, a residency, or a
    // lineage, and none is recoverable by choosing one, so the row keeps its
    // lifecycle edge alone — which is also what keeps the two controls honest,
    // since interrupt is authorized only for a PROVEN continuable child and
    // the durable-conversation target refuses a session whose descriptor the
    // catalog would not return.
    if (entry.kind === 'diagnostic') return
    // A deeper row is some other parent's branch. The lifecycle edges Work
    // observes are scoped to the direct delegating parent, so a grandchild has
    // no row here for a deeper row to enrich.
    if (entry.depth !== DIRECT_CHILD_DEPTH) return
    this.discovered.set(String(entry.id), {
      mode: entry.mode,
      residency: entry.activity === 'running' ? 'resident' : 'stored',
      hasChildren: entry.hasChildren,
      ...entry.label === undefined ? {} : { label: entry.label },
    })
  }

  /**
   * Project the ACTIVE jobs only, never consuming a producer's output cursor.
   *
   * The active filter is the product's own decision and is not a limitation of
   * the seam: the registry keeps a settled record listed until its owner is
   * disposed, precisely so a caller that collected the terminal state can still
   * read it, and `/work` deliberately does not. A Job that settles disappears
   * here, takes its row with it, and takes its open detail stage with it too.
   */
  private jobItems(jobs: JobRegistry, agent: Agent): JobWorkItem[] {
    let views: JobView[]
    try {
      views = jobs.list(agent.session.id)
    } catch {
      return []
    }
    return views
      .filter((view): view is JobView & { status: 'running' | 'stopping' } => (
        view.status === 'running' || view.status === 'stopping'
      ))
      .map(view => ({
        id: String(view.id),
        source: 'job' as const,
        kind: view.kind,
        label: view.label,
        state: view.status,
        startedAt: view.startedAt,
        // The producer's own progress line, carried verbatim. Opaque text, not
        // a counter: the producer owns what `127/203` or `compiling crate_x`
        // means, so inventing a denominator or a percentage from it would be
        // dshline claiming a fact Harness never published.
        ...view.progress === undefined ? {} : { progress: view.progress },
        ...view.detail === undefined ? {} : { detail: view.detail },
        ownership: view.owner === agent.session.id ? 'this-session' as const : 'unowned' as const,
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
      ...reading?.outputTail === undefined ? {} : { outputTail: reading.outputTail },
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
