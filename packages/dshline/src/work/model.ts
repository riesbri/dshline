/**
 * Small, presentation-facing vocabulary for Harness work.
 *
 * These rows are snapshots of capability-owned records. Jobs, subagents, and
 * workflow runs remain a discriminated union because their identifiers,
 * lifecycle facts, and human controls come from different Harness authorities;
 * a shared shape would imply a relationship Harness never publishes.
 *
 * The ONE correlation this module accepts is the workflow member's
 * `childId` — the subagent-seam session id Harness itself publishes on
 * `workflow/agent-start` and in the durable `tool-workflow/agent-start`
 * record. Everything else stays separate.
 * @module dshline/work/model
 */

import type { WorkflowAgentOutcome, WorkflowStopReason } from '@deepseek-ai/dsh-workflow/types'
import type { ActivityWord } from '../activity.ts'

/**
 * The LLM route a live local child's requests actually use.
 *
 * Deliberately NOT called `provider`: a subagent already has a Harness
 * subagent provider — its BACKEND, such as `spawn` or `codex` — and that is a
 * different authority from the model route the child's own requests go to. A
 * `spawn` child can be powered by any registered LLM route at all, so the two
 * facts are separate fields here and separate words in the presentation.
 */
export interface SubagentRoute {
  /** Registered LLM provider route the child's requests resolved to. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Adapter-owned reasoning effort, present only when the route carries one. */
  readonly reasoningEffort?: string
}

/**
 * Harness's own active-turn timing for one descriptor-backed child session.
 *
 * The shape of the `subagentTiming` session projection, retained verbatim
 * rather than pre-folded into a number: the open interval must advance with
 * the frame clock while the child runs and freeze at the projection's own
 * bound when it does not, and only the renderer knows when a frame is.
 */
export interface SubagentActiveTiming {
  /** Milliseconds accumulated across turns completed after the child's own descriptor. */
  readonly settledMs: number
  /** Bounds of the turn that has not reached `turn/end`, when one is open. */
  readonly active?: {
    /** Start of the open turn. */
    readonly since: number
    /** Latest event time the projection folded. */
    readonly through: number
  }
}

/** Facts common to a current Work row. */
interface WorkItemBase {
  /** Stable identity inside the owning capability. */
  readonly id: string
  /** Harness-provided one-line label, when that authority supplied one. */
  readonly label?: string
  /** Epoch milliseconds when the record or observed lifecycle edge began. */
  readonly startedAt: number
}

/** A non-terminal background Job projected from `ctx.jobs`. */
export interface JobWorkItem extends WorkItemBase {
  /** The capability authority that owns this record. */
  readonly source: 'job'
  /** Producer-defined opaque Job kind. */
  readonly kind: string
  /** Harness requires a one-line label for every Job record. */
  readonly label: string
  /** Current Job lifecycle state. */
  readonly state: 'running' | 'stopping'
  /** Producer-defined active detail, when the Job supplied it. */
  readonly detail?: string
  /** Whether the listing proves this Job belongs to this session or is unowned. */
  readonly ownership: 'this-session' | 'unowned'
  /** Jobs have no human Work interrupt: `jobs.kill()` changes delivery semantics. */
  readonly interruptible: false
}

/** A currently open subagent lifecycle epoch projected from `ctx.subagents`. */
export interface SubagentWorkItem extends WorkItemBase {
  /** The capability authority that owns this record. */
  readonly source: 'subagent'
  /** Lifecycle identity for this run or continuable Activation epoch. */
  readonly runId: string
  /** Provider recorded by Harness when this lifecycle epoch started. */
  readonly provider: string
  /**
   * Snapshot of whether `SubagentRun.localAgent` was present when the run
   * started: whether the child was published as an in-process agent. It says
   * nothing about where the provider's model traffic goes.
   */
  readonly local: boolean
  /** Harness lifecycle state retained until successful disposal observation. */
  readonly state: 'running' | 'stopping'
  /** Durable descriptor mode, when direct-child discovery has resolved it. */
  readonly mode?: 'one-shot' | 'continuable'
  /**
   * Durable session-store residency from direct-child discovery, when available.
   * `resident` is deliberately not a claim that a model turn is executing.
   */
  readonly residency?: 'resident' | 'stored'
  /** Whether direct-child discovery reported any durable subagent children. */
  readonly hasChildren?: boolean
  /**
   * The live child's semantic activity, folded from its own session events and
   * tool presentations. Absent when no in-process child Agent is observable —
   * a remote one-shot run exposes no granular state here.
   */
  readonly activityWord?: ActivityWord
  /**
   * The newest pending tool call's presentation title, present only when the
   * declaring tool supplied one in its `presentCall` view.
   */
  readonly activityTitle?: string
  /** Whether the live child Agent is running, driving the row's spinner. */
  readonly busy?: boolean
  /** The live child Agent's published status, for the detail stage. */
  readonly agentStatus?: 'idle' | 'running'
  /**
   * The LLM route the live child's requests actually use — its logged request
   * envelope when it has made one, otherwise the route it was created with.
   * Absent whenever no in-process child Agent is observable, because nothing
   * else in this projection knows what a provider-managed child talks to.
   */
  readonly route?: SubagentRoute
  /**
   * Harness's `subagentTiming` projection for this child, when the profile
   * registered it. Absent is capability absence, never zero.
   */
  readonly timing?: SubagentActiveTiming
  /**
   * Provider-reported tokens attributable to this child: the sum of the four
   * disjoint `tokenUsage` buckets. Absent when the token meter is not mounted
   * AND absent for a child whose Session carries fork-inherited history, where
   * that projection's complete-log fold includes usage this worker did not
   * spend. Unlike {@link timing}, it has no descriptor reset to make it
   * child-relative.
   */
  readonly tokens?: number
  /** Continuable children alone expose Harness's human interrupt authority. */
  readonly interruptible: boolean
}

/**
 * One published `agent()` call of an owned workflow run.
 *
 * Every field is a durable `tool-workflow/agent-start` / `agent-end` fact.
 * A call the provider never published emits no record at all, so this list is
 * never padded with invented pending members.
 */
export interface WorkflowMemberItem {
  /** 1-based sequence number of the `agent()` call inside its run. */
  readonly seq: number
  /** The member's display label, verbatim from the record. */
  readonly label: string
  /**
   * The phase the member belongs to, exactly as recorded. Absent and empty are
   * DIFFERENT groups: the record omits the field for an unphased call, and an
   * empty title is a phase the script actually named that way.
   */
  readonly phase?: string
  /** The child agent's id on the subagent seam — Harness's own correlation. */
  readonly childId: string
  /** How the call settled; absent while it is still open. */
  readonly outcome?: WorkflowAgentOutcome
  /**
   * The live subagent row this member's `childId` resolves to, when an open
   * lifecycle epoch for that exact child session exists right now. This is the
   * only place Work joins two authorities, and only on a Harness-published id.
   */
  readonly subagent?: SubagentWorkItem
}

/** One workflow run owned by the attached session, from its durable records. */
export interface WorkflowWorkItem extends WorkItemBase {
  /** The capability authority that owns this record. */
  readonly source: 'workflow'
  /** The run id; also this row's identity. */
  readonly id: string
  /** The workflow's `meta.name`, recorded durably when the run opened. */
  readonly label: string
  /** `meta.description`, available only from live `workflow/*` enrichment. */
  readonly description?: string
  /** The newest `phase(title)` narration, from live enrichment. */
  readonly phase?: string
  /** The newest `log(message)` narration, from live enrichment. */
  readonly log?: string
  /**
   * `running` until the engine reports a stop reason. A settled run keeps its
   * row only until its durable `tool-workflow/run-end` closes the record, so
   * the terminal state is visible without any timer owning it.
   */
  readonly state: 'running' | WorkflowStopReason
  /** The run's published members, in record order. */
  readonly members: readonly WorkflowMemberItem[]
  /** `agentsStarted` from the live `workflow/end` payload, once it settled. */
  readonly agentsStarted?: number
  /** The engine publishes no run handle to a UI, so Work exposes no control. */
  readonly interruptible: false
}

/** A unit of active work the terminal can present. */
export type WorkItem = JobWorkItem | SubagentWorkItem | WorkflowWorkItem

/** The current projection of the optional work capabilities. */
export interface WorkSnapshot {
  /** Whether either optional work capability is available. */
  readonly available: boolean
  /** Workflow runs this session's own durable records prove it owns. */
  readonly workflows: readonly WorkflowWorkItem[]
  /**
   * Every active subagent lifecycle epoch, workflow members included. The
   * projection reports each authority in full; grouping a member under its
   * workflow is a presentation decision, made where the rows are drawn.
   */
  readonly subagents: readonly SubagentWorkItem[]
  /** Current job-registry snapshots that have not settled. */
  readonly jobs: readonly JobWorkItem[]
}

/** The outcome of asking Harness to interrupt one selected Work row. */
export interface WorkInterruptResult {
  /** Whether Harness accepted, rejected, or cannot interrupt the request. */
  readonly kind: 'requested' | 'unsupported' | 'failed'
  /** A short, user-facing account of the request outcome. */
  readonly message: string
}

/**
 * What a Work mark claims, before any glyph is chosen.
 *
 * The rule the whole view obeys: `executing` — the only animated mark — means
 * dshline holds EVIDENCE of running computation, which today means a live
 * in-process child Agent whose status is `running`. `active` means a lifecycle
 * exists while its internals are not observable, and `record` means a
 * background registry record exists, which is weaker still. Terminal marks
 * report a settlement Harness published.
 */
export type WorkMark =
  | 'executing'
  | 'active'
  | 'record'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * The one-line route text a row shows for a live local child.
 * @param route - the child's effective LLM route.
 * @returns `provider/model`, the form every Harness route id is written in.
 */
export function routeLabel(route: SubagentRoute): string {
  return `${route.provider}/${route.model}`
}

/**
 * The child's active-turn duration, as Harness's own projection defines it.
 *
 * `settledMs` plus the open turn, and the open turn is where the two honest
 * bounds differ: while the child is genuinely running, the turn is still
 * accruing and must advance with the frame clock, but an interrupted or idle
 * child has an interval that will never close, and advancing it would invent
 * work. That one freezes at `through`, the last event time the projection
 * folded. Nothing here re-folds the projection; both figures are read from it.
 * @param timing - the `subagentTiming` value for this child.
 * @param busy - whether the live child Agent is running right now.
 * @param now - the frame clock.
 * @returns milliseconds of child active work.
 */
export function activeElapsedMs(timing: SubagentActiveTiming, busy: boolean, now: number): number {
  const open = timing.active
  if (open === undefined) return Math.max(0, timing.settledMs)
  const bound = busy ? Math.max(open.through, now) : open.through
  return Math.max(0, timing.settledMs) + Math.max(0, bound - open.since)
}

/**
 * The ONE duration a subagent row shows, and which question it answers.
 *
 * Two clocks on one row would be a puzzle rather than a reading, so the
 * authoritative Harness timing wins wherever it exists and the observed
 * lifecycle elapsed is the fallback for a child whose timing the profile does
 * not project — a provider-managed run, above all. The detail stage labels the
 * result with the returned `kind`; the overview shows the figure alone.
 * @param item - the subagent row.
 * @param now - the frame clock.
 * @returns the duration and what it measures.
 */
export function subagentDuration(
  item: SubagentWorkItem,
  now: number,
): { readonly ms: number; readonly kind: 'active' | 'elapsed' } {
  if (item.state === 'stopping' || item.timing === undefined) {
    return { ms: Math.max(0, now - item.startedAt), kind: 'elapsed' }
  }
  return { ms: activeElapsedMs(item.timing, item.busy === true, now), kind: 'active' }
}

/**
 * Whether an open workflow member is observably executing right now.
 * @param member - one published workflow member.
 * @returns true only with a joined live child Agent that Harness says is running.
 */
function memberExecuting(member: WorkflowMemberItem): boolean {
  return member.outcome === undefined && member.subagent?.busy === true
}

/**
 * Classify one workflow member's mark.
 * @param member - one published workflow member.
 * @returns the mark its recorded outcome and joined child justify.
 */
export function memberMark(member: WorkflowMemberItem): WorkMark {
  switch (member.outcome) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return memberExecuting(member) ? 'executing' : 'active'
  }
}

/**
 * Classify one Work row's mark from the authority that owns it.
 *
 * A Job in `running` is deliberately NOT animated: the registry record says a
 * producer holds the job, not that computation is being observed. A workflow
 * animates only while one of its own members does, because the engine publishes
 * no execution signal of its own between `agent()` calls.
 * @param item - the row to classify.
 * @returns the mark the row's authoritative facts justify.
 */
export function workMark(item: WorkItem): WorkMark {
  if (item.source === 'job') return item.state === 'stopping' ? 'stopping' : 'record'
  if (item.source === 'subagent') {
    if (item.state === 'stopping') return 'stopping'
    return item.busy === true ? 'executing' : 'active'
  }
  switch (item.state) {
    case 'completed':
      return 'completed'
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return item.members.some(memberExecuting) ? 'executing' : 'active'
  }
}

/**
 * Members of an owned, still-running workflow whose child is live right now.
 *
 * Presentation uses this to show a workflow's own subagents under the workflow
 * instead of a second time in the flat Subagents section. It is a join on
 * Harness's `childId`, so the two rows are provably the same child; a settled
 * member releases its claim, and so does a settled run.
 * @param workflows - the owned workflow rows.
 * @returns child session ids currently presented by a workflow.
 */
export function workflowClaimedChildren(workflows: readonly WorkflowWorkItem[]): ReadonlySet<string> {
  const claimed = new Set<string>()
  for (const workflow of workflows) {
    if (workflow.state !== 'running') continue
    for (const member of workflow.members) {
      if (member.outcome === undefined && member.subagent !== undefined) claimed.add(member.childId)
    }
  }
  return claimed
}

/**
 * Active subagents no owned workflow is already presenting.
 *
 * The single rule behind both the overview's Subagents section and the status
 * summary's subagent count. Having one function is the point: a child shown
 * under its workflow and also counted as a loose subagent would report two
 * pieces of work where Harness published one child.
 * @param snapshot - current work projection.
 * @returns the subagent epochs no live workflow member claims.
 */
export function looseSubagents(snapshot: WorkSnapshot): readonly SubagentWorkItem[] {
  const claimed = workflowClaimedChildren(snapshot.workflows)
  return claimed.size === 0 ? snapshot.subagents : snapshot.subagents.filter(item => !claimed.has(item.id))
}

/**
 * Build the optional work summary without abbreviating its counts.
 *
 * Counts what `/work` would SHOW, so the status line and the overview cannot
 * disagree: a workflow counts once as its own authority, and its live members
 * are counted there rather than a second time as subagents.
 * @param snapshot - current work projection.
 * @returns a whole-segment status label, or undefined when there is no work.
 */
export function workSummary(snapshot: WorkSnapshot): string | undefined {
  const workflows = snapshot.workflows.length
  const subagents = looseSubagents(snapshot).length
  const jobs = snapshot.jobs.length
  if (workflows === 0 && subagents === 0 && jobs === 0) return undefined
  const parts: string[] = []
  if (workflows > 0) parts.push(`${String(workflows)} ${workflows === 1 ? 'workflow' : 'workflows'}`)
  if (subagents > 0) parts.push(`${String(subagents)} ${subagents === 1 ? 'subagent' : 'subagents'}`)
  if (jobs > 0) parts.push(`${String(jobs)} ${jobs === 1 ? 'job' : 'jobs'}`)
  return parts.join(' · ')
}

/**
 * How many work items are attached to a session.
 *
 * Counted across the two capabilities that own real execution, without merging
 * them: the sum answers one question — is anything still running under this
 * agent — which is what a lifecycle decision such as retiring the agent needs,
 * and it needs no correlation between a job and a subagent to be true. Workflow
 * runs are deliberately NOT added: a run's work is its members, and those are
 * already counted as subagents, so adding the run would count it twice.
 *
 * This is also why it counts every subagent rather than only the loose ones
 * {@link workSummary} shows. The question here is a LIFECYCLE one — may this
 * agent be retired — and a workflow member is running work whether or not the
 * presentation lists it under its workflow.
 * @param snapshot - current work projection.
 * @returns the number of active jobs and subagents.
 */
export function activeWorkCount(snapshot: WorkSnapshot): number {
  return snapshot.subagents.length + snapshot.jobs.length
}

/**
 * Stable selection identity for a Work row.
 *
 * A continuable child may later acquire another lifecycle epoch with the same
 * durable session id, so its run id is part of the identity while the overlay
 * is open.
 * @param item - row whose identity the overlay retains.
 * @returns capability-scoped selection key.
 */
export function workItemKey(item: WorkItem): string {
  if (item.source === 'subagent') return `subagent:${item.runId}`
  if (item.source === 'workflow') return `workflow:${item.id}`
  return `job:${item.id}`
}

/**
 * Stable selection identity for one workflow member row.
 * @param workflow - the run the member belongs to.
 * @param member - the published member.
 * @returns a run-scoped member key, stable across live updates.
 */
export function workflowMemberKey(workflow: WorkflowWorkItem, member: WorkflowMemberItem): string {
  return `member:${workflow.id}:${String(member.seq)}`
}
