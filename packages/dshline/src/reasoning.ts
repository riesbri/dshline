/**
 * The reasoning-effort picker.
 *
 * Effort is part of the same mutable selection ref `/model` writes, and the
 * agent's scoped prompt assembly reads it per step — so setting it is one
 * assignment, and a change made mid-turn lands on the next step rather than
 * splitting a request. The levels are NOT hardcoded: an adapter publishes the
 * efforts it accepts for one exact route, and a deployment that disables thinking
 * publishes only `off`. Offering a level the adapter never advertised would fail
 * at the provider, one turn later, with an error the user cannot act on.
 * @module dshline/reasoning
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { LlmModelReasoningInfo, LlmReasoningEffortInfo } from '@deepseek-ai/dsh-llm'
import { promptSelect } from './select.ts'
import type { SelectChoice } from './select.ts'
import { rememberSelection } from './selection.ts'

/**
 * The word that clears the effort, in both the argument and the picker.
 *
 * Clearing is not a level of its own: the harness documents an absent effort as
 * restoring the provider's own behavior, which is a different thing from every
 * effort the adapter lists — including `off`, where a provider that reasons by
 * default is explicitly told not to.
 */
const DEFAULT_CHOICE = 'default'

/**
 * The effort an argument names, if any.
 *
 * Matched case-insensitively against the ids the adapter published, and the
 * adapter's own entry is returned rather than the typed text. Those ids are
 * already branded, so carrying one through needs no cast — and a word that
 * matched nothing is rejected instead of being branded on trust.
 * @param argument - the text after the command name.
 * @param efforts - what the adapter advertises for the current route.
 * @returns the matching effort, or undefined when nothing matched.
 */
export function resolveEffort(
  argument: string,
  efforts: readonly LlmReasoningEffortInfo[],
): LlmReasoningEffortInfo | undefined {
  const wanted = argument.trim().toLowerCase()
  if (wanted === '') return undefined
  return efforts.find(effort => effort.id.toLowerCase() === wanted)
}

/**
 * The values `/reasoning` accepts, for completing its argument.
 *
 * The clearing word is listed last, after the adapter's own levels, because it
 * is not one of them: it removes a selection rather than making one.
 * @param reasoning - what the adapter published for the current route.
 * @returns each accepted word and what it does.
 */
export function reasoningValues(
  reasoning: LlmModelReasoningInfo | undefined,
): readonly { value: string; note?: string }[] {
  const efforts = (reasoning?.efforts ?? []).map(effort => ({
    value: effort.id,
    note: effort.description ?? effort.name,
  }))
  if (efforts.length === 0) return []
  return [...efforts, { value: DEFAULT_CHOICE, note: 'Whatever the provider does when nothing is set' }]
}

/**
 * How the status line names the current effort, when it is worth naming.
 *
 * Only a non-default level is reported, for the reason the card-detail segment is:
 * the deployment's default is a fact the user did not choose, and printing it on
 * every frame spends columns to say nothing. An adapter that publishes no default
 * makes any explicit choice worth showing, since there is nothing to be the same as.
 * @param effort - the effort the selection carries, when it carries one.
 * @param reasoning - what the adapter published for the current route.
 * @returns the level's id, or undefined when it should stay quiet.
 */
export function effortLabel(
  effort: string | undefined,
  reasoning: LlmModelReasoningInfo | undefined,
): string | undefined {
  if (effort === undefined) return undefined
  return effort === reasoning?.defaultEffort ? undefined : effort
}

/**
 * The picker value for the effort already in force.
 *
 * Absence is its own row (`default`), NOT the adapter's `defaultEffort`: a
 * provider that happens to default to `high` is still unset until the user
 * chooses it, and the user did not choose the provider's default. An explicit
 * effort that is no longer among the advertised levels has no row, so this
 * returns undefined and the picker falls back to its first row rather than
 * highlighting a level the adapter would reject.
 * @param effort - the effort the selection carries, when it carries one.
 * @param efforts - what the adapter advertises for the current route.
 * @returns the opaque choice value, or undefined when an explicit effort is
 *   absent from the advertised levels.
 */
function currentReasoningChoiceValue(
  effort: string | undefined,
  efforts: readonly LlmReasoningEffortInfo[],
): string | undefined {
  if (effort === undefined) return DEFAULT_CHOICE
  const index = efforts.findIndex(one => one.id === effort)
  return index < 0 ? undefined : String(index)
}

/**
 * Apply one effort to the selection, preserving the route, and remember it.
 *
 * The effort is stored alongside the route rather than on its own, because the
 * settings section holds one selection: writing half of it would leave the model
 * and the level disagreeing about which session they came from.
 * @param ctx - context carrying the default-model service.
 * @param selection - the agent's mutable selection ref.
 * @param effort - the effort to set, or undefined to restore the provider's default.
 * @returns a line to report in the transcript.
 */
async function apply(
  ctx: Context,
  selection: ModelSelectionRef,
  effort: LlmReasoningEffortInfo | undefined,
): Promise<string> {
  const current = selection.current
  if (current === undefined) return 'no model is selected; choose one with /model first'
  const next = {
    provider: current.provider,
    model: current.model,
    ...effort === undefined ? {} : { reasoningEffort: effort.id },
  }
  // Written to the ref first and unconditionally, as the model switch is: the
  // next step reads it, and a storage failure must not send that step at a level
  // the user has just been told is no longer set.
  selection.current = next
  const note = await rememberSelection(ctx, next)
  const said = effort === undefined
    ? 'reasoning effort cleared; the provider decides again'
    : `reasoning effort set to ${effort.id}`
  return note === undefined ? said : `${said} \u00b7 ${note}`
}

/**
 * Set the reasoning effort, from an argument or from a picker.
 * @param ctx - context carrying the slot registry.
 * @param selection - the agent's mutable selection ref.
 * @param reasoning - what the adapter published for the current route, when resolved.
 * @param argument - the text after `/reasoning`; empty opens the picker.
 * @returns a line to report in the transcript, or undefined when the user
 *   dismissed the picker without choosing.
 */
export async function pickReasoning(
  ctx: Context,
  selection: ModelSelectionRef,
  reasoning: LlmModelReasoningInfo | undefined,
  argument: string,
): Promise<string | undefined> {
  if (selection.current === undefined) return 'no model is selected; choose one with /model first'
  const efforts = reasoning?.efforts ?? []
  const wanted = argument.trim()
  // `default` is not one of the adapter's levels — it deletes the stored
  // effort — so it must work even when the route advertises none, including a
  // route reached with a stale effort a previous model's switch left behind.
  if (wanted.toLowerCase() === DEFAULT_CHOICE) return apply(ctx, selection, undefined)
  // An unresolved route and one that genuinely reasons at a fixed level look the
  // same from here, so the message names the route rather than claiming either.
  if (efforts.length === 0) {
    return `${selection.current.model} advertises no reasoning levels`
  }

  if (wanted !== '') {
    const effort = resolveEffort(wanted, efforts)
    // Naming what IS accepted is the whole value of the message: a bare rejection
    // leaves the user typing guesses at a list only the adapter knows.
    if (effort === undefined) {
      const names = [...efforts.map(one => one.id), DEFAULT_CHOICE].join(', ')
      return `no reasoning level named ${wanted}; try one of: ${names}`
    }
    return apply(ctx, selection, effort)
  }

  const choices: SelectChoice[] = efforts.map((effort, index) => ({
    // The index is the choice value, as the model picker does it, so no adapter
    // id has to survive a round trip through a delimiter it might contain.
    value: String(index),
    label: effort.name,
    ...effort.description === undefined ? {} : { description: effort.description },
  }))
  choices.push({
    value: DEFAULT_CHOICE,
    label: 'Default',
    description: 'Let the provider decide, as it does when nothing is set',
  })
  const current = selection.current.reasoningEffort
  const initialValue = currentReasoningChoiceValue(current, efforts)
  const picked = await promptSelect(ctx, {
    title: 'Select a reasoning level',
    view: 'Reasoning',
    detail: `current: ${current ?? 'whatever the provider decides'}`,
    ...initialValue === undefined ? {} : { initialValue },
    choices,
  })
  if (picked === undefined) return undefined
  if (picked === DEFAULT_CHOICE) return apply(ctx, selection, undefined)
  const chosen = efforts[Number(picked)]
  if (chosen === undefined) return undefined
  return apply(ctx, selection, chosen)
}
