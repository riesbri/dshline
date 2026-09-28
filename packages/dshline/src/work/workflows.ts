/**
 * The workflow authority behind `/work`.
 *
 * A separate adapter beside the jobs and subagents projections, for one reason:
 * its ownership rule is different. `ctx.jobs` answers per caller and the
 * subagent lifecycle edges are scoped to the delegating parent, but raw
 * `workflow/*` events carry only `{ id, meta }` — a run's identity, never the
 * Session that asked for it. Subscribing to them alone would show another
 * window's orchestration inside this one.
 *
 * So ownership comes from the durable side. `dsh-tool-workflow` appends
 * `tool-workflow/run-start` / `agent-start` / `agent-end` / `run-end` into the
 * PARENT Session of a top-level run, and nowhere else — a nested run started
 * inside a subagent records nothing. A run whose `run-start` reached the
 * attached session's own log is therefore provably this window's, and every
 * member fact this view shows is one of those records. Live `workflow/*` events
 * are accepted only for a run already proven owned, and only as enrichment:
 * the description, the current phase, the newest log line, and the terminal
 * stop reason.
 *
 * Reconstruction is deliberately live-feed only. A `run-start` left in an old
 * log by a process that died is not evidence that a script is executing now,
 * and `/work` is a live operational surface; durable workflow history belongs
 * to the transcript, which replays those records where they were written.
 * @module dshline/work/workflows
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// The `SessionEventMap` merge that gives the durable workflow records their
// types. Type-only, like every other optional Harness domain this file reads.
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import type { WorkflowMeta, WorkflowStopReason } from '@deepseek-ai/dsh-workflow/types'
import type { SubagentWorkItem, WorkflowMemberItem, WorkflowWorkItem } from './model.ts'

/** One live `workflow/*` event, reduced to the enrichment Work presents. */
export type WorkflowObservation =
  /** Any event whose only useful contribution is the run's validated meta. */
  | { readonly kind: 'meta' }
  /** A `phase(title)` call. */
  | { readonly kind: 'phase'; readonly title: string }
  /** A `log(message)` call. */
  | { readonly kind: 'log'; readonly message: string }
  /** The run settled. */
  | { readonly kind: 'end'; readonly stopReason: WorkflowStopReason; readonly agentsStarted: number }

/** Services and feeds the workflow projection consumes. */
export interface WorkflowCapabilities {
  /** The attached parent Session, and the only ownership authority. */
  readonly session: Session
  /** The process-wide session feed; the projection filters it by exact Session. */
  readonly onSessionEvent: (
    listener: (session: Session, event: SessionEvent) => void,
  ) => () => void
  /**
   * Live `workflow/*` enrichment, already folded into one callback. Absent when
   * the profile mounts no workflow engine, which costs only the enrichment.
   */
  readonly onWorkflowObservation?: (
    listener: (runId: string, meta: WorkflowMeta, observation: WorkflowObservation) => void,
  ) => () => void
  /** Redraw the live region after a record or an enrichment changed. */
  readonly invalidate: () => void
}

/** One owned run: durable facts, plus whatever live enrichment has arrived. */
interface OwnedRun {
  readonly runId: string
  readonly name: string
  readonly startedAt: number
  /** Members keyed by their record sequence number, in insertion order. */
  readonly members: Map<number, WorkflowMemberRecord>
  description?: string
  phase?: string
  log?: string
  state: 'running' | WorkflowStopReason
  agentsStarted?: number
}

/** One member's durable record, before the live child join. */
interface WorkflowMemberRecord {
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId: string
  outcome?: WorkflowMemberItem['outcome']
}

/**
 * Project the workflow runs the attached session owns.
 *
 * Holds no run handle and offers no control: `ctx.workflowEngine` publishes
 * `start()` and nothing a UI could use to reach a run it did not start, so
 * Work observes workflows and stops there.
 */
export class HarnessWorkflows {
  private readonly runs = new Map<string, OwnedRun>()
  private readonly disposers: (() => void)[] = []

  /**
   * @param capabilities - the session feed, optional live enrichment, and redraw.
   */
  constructor(private readonly capabilities: WorkflowCapabilities) {
    const { session, onSessionEvent, onWorkflowObservation, invalidate } = capabilities
    this.disposers.push(onSessionEvent((changed, event) => {
      // Session ids are durable names, not an authority boundary: a replacement
      // instance under the same id must not write into this projection.
      if (changed !== session) return
      if (this.foldRecord(event)) invalidate()
    }))
    if (onWorkflowObservation === undefined) return
    this.disposers.push(onWorkflowObservation((runId, meta, observation) => {
      const run = this.runs.get(runId)
      // THE ownership gate. Every workflow in the process reaches this listener,
      // because the event payload cannot say whose run it is. A run without a
      // durable record in THIS session's log is dropped here and never stored,
      // so another window's orchestration is neither shown nor remembered.
      if (run === undefined) return
      // Meta is adopted from whichever live event arrives first for an owned
      // run. `workflow/start` may fire before the tool appends its durable
      // record, so waiting for that one event alone would lose the description
      // and the declared phases of a perfectly ordinary run.
      // `meta.description` and nothing else: `meta.phases` is the script's
      // DECLARED progress vocabulary, and the phases this view groups members
      // under are the ones their records actually carry. Retaining the declared
      // list bought a row that would show a phase no member has entered, which
      // reads as pending work Harness never published.
      run.description = meta.description
      if (observation.kind === 'phase') run.phase = observation.title
      if (observation.kind === 'log') run.log = observation.message
      if (observation.kind === 'end') {
        run.state = observation.stopReason
        run.agentsStarted = observation.agentsStarted
      }
      invalidate()
    }))
  }

  /** Stop observing; nothing observed afterwards can repaint this projection. */
  dispose(): void {
    this.runs.clear()
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  /**
   * How the owned runs divide a status line's three counts.
   *
   * The two facts a footer segment needs, derived from the same records and the
   * same rules {@link items} applies to a full row — a run counts once whatever
   * it is doing, and only a RUNNING run with an unsettled member that has a live
   * epoch claims that child — without building a run, a member, or the child
   * rows they would join to.
   *
   * `live` is the set of child ids with an open lifecycle epoch, passed IN rather
   * than read here: joining a member to a child is the subagent projection's
   * authority, and taking the set from it is what keeps this a count of the same
   * children the rows are built from. It is why `claimed` can never exceed the
   * number of live epochs it is subtracted from.
   * @param live - durable child ids with an open lifecycle epoch right now.
   * @returns the owned run count, and how many live children a run presents.
   */
  counts(live: ReadonlySet<string>): { readonly runs: number; readonly claimed: number } {
    const claimed = new Set<string>()
    for (const run of this.runs.values()) {
      if (run.state !== 'running') continue
      for (const member of run.members.values()) {
        if (member.outcome === undefined && live.has(member.childId)) claimed.add(member.childId)
      }
    }
    return { runs: this.runs.size, claimed: claimed.size }
  }

  /**
   * Read the owned workflow runs, joined to their live children.
   * @param subagents - every active subagent epoch, for the `childId` join.
   * @returns one row per owned run, members in record order.
   */
  items(subagents: readonly SubagentWorkItem[]): WorkflowWorkItem[] {
    // First epoch wins for a given child session: a workflow member is a fresh
    // one-shot child, so a second epoch under the same id is not this member's.
    const byChild = new Map<string, SubagentWorkItem>()
    for (const item of subagents) if (!byChild.has(item.id)) byChild.set(item.id, item)
    return [...this.runs.values()].map(run => {
      const members = [...run.members.values()]
        .sort((left, right) => left.seq - right.seq)
        .map((record): WorkflowMemberItem => {
          const child = record.outcome === undefined ? byChild.get(record.childId) : undefined
          return {
            seq: record.seq,
            label: record.label,
            childId: record.childId,
            ...record.phase === undefined ? {} : { phase: record.phase },
            ...record.outcome === undefined ? {} : { outcome: record.outcome },
            ...child === undefined ? {} : { subagent: child },
          }
        })
      return {
        id: run.runId,
        source: 'workflow' as const,
        label: run.name,
        startedAt: run.startedAt,
        state: run.state,
        members,
        interruptible: false as const,
        ...run.description === undefined ? {} : { description: run.description },
        ...run.phase === undefined ? {} : { phase: run.phase },
        ...run.log === undefined ? {} : { log: run.log },
        ...run.agentsStarted === undefined ? {} : { agentsStarted: run.agentsStarted },
      }
    })
  }

  /**
   * Fold one durable record of the attached session.
   * @param event - one event from this session's own feed.
   * @returns whether the projection changed and a redraw is owed.
   */
  private foldRecord(event: SessionEvent): boolean {
    switch (event.type) {
      case 'tool-workflow/run-start': {
        const runId = String(event.data.runId)
        if (this.runs.has(runId)) return false
        this.runs.set(runId, {
          runId,
          name: event.data.name,
          // The record's own time, not the moment this UI folded it: a record
          // and its elapsed reading should agree with the log.
          startedAt: event.time,
          members: new Map(),
          state: 'running',
        })
        return true
      }
      case 'tool-workflow/agent-start': {
        const run = this.runs.get(String(event.data.runId))
        if (run === undefined) return false
        const { seq, label, phase, childId } = event.data
        if (run.members.has(seq)) return false
        run.members.set(seq, {
          seq,
          label,
          childId: String(childId),
          // Absent stays absent: an unphased call and a call whose phase title
          // is the empty string are different groups downstream.
          ...phase === undefined ? {} : { phase },
        })
        return true
      }
      case 'tool-workflow/agent-end': {
        const run = this.runs.get(String(event.data.runId))
        const member = run?.members.get(event.data.seq)
        if (member === undefined) return false
        member.outcome = event.data.outcome
        return true
      }
      case 'tool-workflow/run-end': {
        const runId = String(event.data.runId)
        if (!this.runs.has(runId)) return false
        // The record closes AFTER `run.dispose()`, so the run and its children
        // are already quiescent: there is nothing left for `/work` to observe,
        // and the row leaves without any timer deciding when.
        this.runs.delete(runId)
        return true
      }
      default:
        return false
    }
  }
}
