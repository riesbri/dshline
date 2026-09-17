/**
 * Presentation-facing reading of the Harness goal domain's two authorities.
 *
 * The goal is owned in halves, and this adapter is where they are joined for
 * the terminal — nowhere else:
 *
 * ```text
 * Harness `goal` projection   durable, log-derived: identity, revision,
 *   (ctx.sessionProjections)  objective, phase, blocked reason, round count,
 *                             round cap, timestamps
 *
 * ctx.goals                   live, process-local: activation alone, the one
 *                             fact no replay can reconstruct
 * ```
 *
 * Activation is deliberately never persisted, so a resumed session can hold a
 * durably `active` goal while this process is `disarmed` and will continue
 * nothing. That is the distinction the whole reading exists to make, and it is
 * why the durable half comes from the projection: reading those fields off
 * `ctx.goals.get(agent)` would make the service the presentation authority for
 * state Harness already publishes generically.
 *
 * Activation is asked for lazily, at render time, and never cached. Upstream's
 * `disarm()` is process-local by design: it changes activation without a
 * `goal/change` event, without a revision, and without a `goal/changed`
 * notification, so a projection observer cannot own it and a remembered copy
 * would go stale silently.
 * @module dshline/goals/model
 */

import type { GoalActivation, GoalSnapshot } from '@deepseek-ai/dsh-goal'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'

/** The goal state shown in the footer and whether this process will continue it. */
export interface GoalReading {
  /** One indivisible state/progress label such as `goal armed` or `goal 3/256`. */
  label: string
  /** Whether this session will continue the goal by itself. */
  running: boolean
}

/**
 * Live process-local activation, asked for only when it can change the reading.
 *
 * A thunk rather than a value so this adapter decides whether the service is
 * consulted at all. `undefined` means the answer could not be obtained — no goal
 * service, no live agent, or a refusal — and is never read as `armed`.
 */
export type GoalActivationSource = () => GoalActivation | undefined

/**
 * How the status line reports a goal, or nothing when there is none.
 *
 * The status line carries only the state. The objective is model-authored prose and
 * belongs to the explicit `/goal` report, not persistent footer chrome; this still
 * makes an automatically-created goal visible without repeating its full text on
 * every redraw.
 *
 * The count appears only once a round has been taken. Before then it is
 * `roundsStarted` against a deployment's cap — `0/256` — which reads as a meter
 * stuck at zero when it is really a safety limit that has not been approached.
 * `armed` says the same thing in the words that are true.
 *
 * A phase that is not `active` replaces the count: the round number of a paused
 * goal is history, not progress. `idle` marks the case the count alone would
 * misrepresent — a goal that is durably active while this process holds no
 * authority to continue it, which is what every reopened session starts as. It
 * reads as a goal that is set and going nowhere, which is what it is.
 *
 * Only an `active` projected goal consults `activation`: a paused, blocked, or
 * complete goal reads the same either way, and a session with no projected goal
 * has nothing to ask about.
 * @param snapshot - the status frame's shared projection cut, or undefined without the registry.
 * @param activation - live process-local activation, called at most once.
 * @returns the reading, or undefined when nothing is worth reporting.
 */
export function goalReading(
  snapshot: ProjectionSnapshot | undefined,
  activation: GoalActivationSource,
): GoalReading | undefined {
  // `undefined` is the typed absence of an unregistered process-wide unit;
  // `null` is the goal domain's distinct no-current-goal value. Neither is a
  // goal, and a missing registry is not one either.
  const current = snapshot?.values.goal
  if (current === undefined || current === null) return undefined
  const { goal, roundsStarted } = current
  // An unobtainable activation is not `armed`. Inferring one from
  // `phase === 'active'` is exactly the claim this split exists to refuse.
  const running = goal.phase === 'active' && activation() === 'armed'
  const state = goal.phase !== 'active'
    ? goal.phase
    : !running
      ? 'idle'
      : roundsStarted > 0 ? `${String(roundsStarted)}/${String(goal.maxGoalRounds)}` : 'armed'
  const label = `goal ${state}`
  return {
    // `/goal` is the explicit surface for the objective; the footer keeps only
    // the compact state that remains useful on every redraw and terminal width.
    label,
    running,
  }
}

/**
 * Detailed inspector reading: the whole current goal, or a named absence.
 *
 * The footer's {@link GoalReading} deliberately drops everything but one
 * indivisible state label. This is the other half of the same adapter: the
 * explicit `/goal` report needs the objective, the durable counts and
 * timestamps, the blocker, and — separately from all of those — whether this
 * process will continue the goal. Every durable field still comes from the
 * projection, and the service is still consulted only when it can change the
 * answer.
 *
 * The three absences are kept apart rather than collapsed, because they call
 * for different actions from a reader: a profile with no projection
 * infrastructure at all, a profile whose goal unit was never registered, and a
 * session whose goal domain reports no current goal after a clear. Only the
 * last is a statement about this session's goal.
 */
export type GoalInspection =
  | { readonly kind: 'projections-unavailable' }
  | { readonly kind: 'unregistered' }
  | { readonly kind: 'none' }
  | {
    readonly kind: 'goal'
    /** The durable snapshot: identity, revision, objective, phase, cap, blocker. */
    readonly goal: GoalSnapshot
    /** Highest admitted round number, folded from the log by the projection. */
    readonly roundsStarted: number
    /** Epoch milliseconds of the create mutation. */
    readonly createdAt: number
    /** Epoch milliseconds of the latest durable mutation. */
    readonly updatedAt: number
    /**
     * Live process-local activation, asked for only while the durable phase is
     * `active`; `undefined` when it could not be obtained. Never inferred.
     */
    readonly activation: GoalActivation | undefined
  }

/**
 * How the explicit inspector reports a goal, or why it has none.
 *
 * The durable half is read from the projection exactly as {@link goalReading}
 * reads it, for the same reason: the goal service also remembers durable fields,
 * and only the projection is authoritative after a replay. The live half is
 * asked for ONLY for an `active` projected phase, matching the footer: a paused,
 * blocked, or complete goal reads the same whatever activation says, so asking
 * would be a pointless call on a surface that repaints on every activation edge.
 * @param snapshot - the attachment's shared projection cut, or undefined without the registry.
 * @param activation - live process-local activation, called at most once and only for an active phase.
 * @returns the detailed reading, never undefined: an absence is a named kind.
 */
export function goalInspection(
  snapshot: ProjectionSnapshot | undefined,
  activation: GoalActivationSource,
): GoalInspection {
  // `undefined` is the absence of the projection registry; an absent `goal` key
  // is the absence of goal support inside a registry that exists; `null` is the
  // goal domain's own no-current-goal. Only the last is about this session.
  if (snapshot === undefined) return { kind: 'projections-unavailable' }
  const current = snapshot.values.goal
  if (current === undefined) return { kind: 'unregistered' }
  if (current === null) return { kind: 'none' }
  const { goal, roundsStarted, createdAt, updatedAt } = current
  return {
    kind: 'goal',
    goal,
    roundsStarted,
    createdAt,
    updatedAt,
    activation: goal.phase === 'active' ? activation() : undefined,
  }
}
