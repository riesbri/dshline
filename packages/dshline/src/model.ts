/**
 * The model picker.
 *
 * Selection is a mutable ref the agent's scoped prompt assembly reads
 * (`installModelSelection`): assembly snapshots it when a step enters, so a
 * switch made mid-turn takes effect on the NEXT step rather than splitting a
 * request across two models. Writing `ref.current` is therefore the whole
 * mechanism — there is no separate apply step to get wrong.
 * @module dshline/model
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LocalCommandChoice } from './local-commands.ts'
import { readModelCatalog } from './model-catalog.ts'
import { createSelectOverlay } from './select.ts'
import type { SelectChoice, SelectSpec } from './select.ts'
import { rememberSelection } from './selection.ts'
import type { SelectionOutcome } from './selection.ts'

/** One offered model, kept beside its choice so nothing has to be parsed back. */
export interface ModelOption {
  /** Provider ROUTE key, the value `GenerateOptions.provider` takes. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** What discovery found, and what it could not reach. */
interface Discovery {
  options: ModelOption[]
  choices: SelectChoice[]
  /** Canonical completion values, built from the same catalog as `choices`. */
  completions: LocalCommandChoice[]
  /** Route keys whose listing failed, for a message that says so. */
  failed: string[]
}

/**
 * Every model the mounted adapters currently advertise.
 *
 * `listProviders()` returns `{ id, name }` where **`id`** is the route key
 * `listModels` and `GenerateOptions.provider` take, and `name` is a label for
 * humans. A route whose listing fails is recorded rather than silently dropped:
 * an unreachable provider must not hide the ones that work, but it must also not
 * be reported as "nothing is configured".
 *
 * Route catalogs are independent, so every read begins before any of them is
 * awaited. `Promise.all` over the mapped array then keeps `listProviders()`
 * order in the result no matter which adapter settles first, which is what makes
 * the concurrency invisible to the picker and to completion.
 * @param ctx - context carrying the llm registry.
 * @returns the discovered options, their rendered choices, their completion
 *   values, and any failures.
 */
async function discover(ctx: Context): Promise<Discovery> {
  const options: ModelOption[] = []
  const choices: SelectChoice[] = []
  const completions: LocalCommandChoice[] = []
  const { routes, failedProviders } = await readModelCatalog(ctx)
  for (const route of routes) {
    // The index is the choice value, so no id has to survive a round trip
    // through a delimiter that a provider or model name might contain.
    //
    // The LABEL is the qualified route and model id — exactly the argument
    // `/model` accepts — rather than the two display names it used to join.
    // A gateway route advertises hundreds of models, so the list is filtered
    // by typing, and a picker whose rows show a name while the command takes
    // an id makes the reader translate between them. The display name goes
    // under the selection, where it disambiguates without being the thing
    // that has to be matched.
    const label = `${route.provider}/${route.model}`
    const named = route.modelName !== '' && route.modelName.toLowerCase() !== route.model.toLowerCase()
    choices.push({
      value: String(options.length),
      label,
      ...named ? { description: route.modelName } : {},
    })
    // Completion inserts the QUALIFIED route. `/model` resolves a bare id to
    // the first route that serves it, so two rows inserting the same bare id
    // could show different providers and submit the same one. The bare id is
    // kept as a search alias so typing it still finds every route, and the
    // display name becomes the note once the provider no longer needs to be.
    completions.push({
      value: label,
      aliases: [route.model],
      ...named ? { note: route.modelName } : {},
    })
    options.push({ provider: route.provider, model: route.model })
  }
  return { options, choices, completions, failed: failedProviders }
}

/**
 * Canonical completion candidates for `/model`'s argument.
 *
 * A value is `provider/model`, the exact route the row names, and the bare model
 * id is carried as a search alias rather than as the inserted text. Built from
 * the same discovery pass the picker uses, so the metadata costs no second round
 * of `listModels` reads.
 * @param ctx - context carrying the llm registry.
 * @returns each route and model, in the order the picker lists them.
 */
export async function modelCompletionValues(ctx: Context): Promise<readonly LocalCommandChoice[]> {
  return (await discover(ctx)).completions
}

/**
 * The option an argument names, if any.
 *
 * A bare model id is enough when only one route serves it, which is the case
 * worth optimizing for: `provider/model` is accepted too, and is the only way to
 * say which one when a gateway and a direct route both offer the same id.
 * @param argument - the text after the command name.
 * @param options - every model on offer.
 * @returns the matching option, or undefined when nothing matched.
 */
export function resolveModel(
  argument: string,
  options: readonly ModelOption[],
): ModelOption | undefined {
  const wanted = argument.trim().toLowerCase()
  if (wanted === '') return undefined
  return options.find(option => pricingKeyOf(option).toLowerCase() === wanted)
    ?? options.find(option => option.model.toLowerCase() === wanted)
}

/**
 * The `provider/model` spelling of one option.
 * @param option - the option.
 * @returns the qualified name.
 */
function pricingKeyOf(option: ModelOption): string {
  return `${option.provider}/${option.model}`
}

/**
 * The picker value for the route and model already in force.
 *
 * Choices carry their discovery index as an opaque value, so the current
 * selection is mapped back to that same index rather than to a
 * `provider/model` string — nothing has to parse an id back out of a label.
 * A selection no longer in the discovered catalog has no row, and this returns
 * undefined so the picker falls back to its first row rather than claiming a
 * different route is current.
 * @param current - the selection being replaced, when there is one.
 * @param options - every option discovery returned, in choice order.
 * @returns the opaque choice value, or undefined when the selection is absent
 *   or no longer offered.
 */
function currentModelChoiceValue(
  current: ModelSelectionRef['current'],
  options: readonly ModelOption[],
): string | undefined {
  const index = current === undefined
    ? -1
    : options.findIndex(option =>
      option.provider === current.provider && option.model === current.model)
  return index < 0 ? undefined : String(index)
}

/**
 * What the `/model` command may attach to the picker it opens.
 *
 * The picker itself stays generic: this is the only seam it exposes, and the
 * one key it reserves.
 */
export interface PickModelOptions {
  /**
   * Open the subagent-model authorization editor.
   *
   * This is the bare `/model` picker's `ctrl-k`. `/setup` passes no callback,
   * so `ctrl-k` is inert there and the setup flow can never reach the Host
   * setting. The editor is a separate overlay stacked on top of the picker,
   * so dismissing it returns to the picker rather than to this command.
   */
  readonly onSubagentModels?: () => void
}

/**
 * Show the model picker, reserving `ctrl-k` for one auxiliary surface.
 *
 * A thin owner around {@link createSelectOverlay}, not a change to it. The
 * generic picker stays a single-choice interaction with no knowledge of the
 * subagent setting, and every ordinary key is forwarded to it unchanged.
 * `ctrl-k` is a `key`, never `text`, so intercepting it cannot swallow a
 * character the search query was about to use — a bare `k` still filters.
 *
 * The push-await-dismiss dance is the same one `promptSelect` owns; it is
 * repeated rather than widened because the wrapper has to sit between the
 * overlay and its keystrokes, which is exactly what `promptSelect` hides.
 * @param ctx - context carrying the slot registry.
 * @param spec - the prompt and its choices; settlement is this function's.
 * @param onSubagentModels - the auxiliary editor opener, when the caller owns
 *   one.
 * @returns the confirmed value, or undefined when the user cancelled.
 */
async function promptModelPicker(
  ctx: Context,
  spec: Omit<SelectSpec, 'settle' | 'invalidate'>,
  onSubagentModels: (() => void) | undefined,
): Promise<string | undefined> {
  return new Promise<string | undefined>(resolve => {
    let dismiss = (): void => {}
    let settled = false
    // Shared with the overlay only: either side can finish first, and the
    // loser must not dismiss an overlay someone else already replaced.
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      dismiss()
      resolve(value)
    }
    const base = createSelectOverlay({
      ...spec,
      invalidate: () => { ctx.tuiSlots.invalidate() },
      settle: finish,
    })
    dismiss = ctx.tuiSlots.pushOverlay({
      render: (columns, rows) => base.render(columns, rows),
      handleKey: key => {
        if (onSubagentModels !== undefined && key.kind === 'key' && key.name === 'ctrl-k') {
          onSubagentModels()
          return
        }
        base.handleKey(key)
      },
      mounted: () => { base.mounted?.() },
      dispose: () => { base.dispose?.() },
    })
  })
}

/**
 * Prompt for a model and apply the choice to `selection`.
 * @param ctx - context carrying the llm registry and the slot registry.
 * @param selection - the agent's mutable selection ref.
 * @param argument - the text after `/model`; empty opens the picker.
 * @param options - the picker's one reserved key, when the caller owns an
 *   auxiliary surface.
 * @returns a typed line to report in the transcript, or undefined when the user
 *   dismissed the picker without choosing.
 */
export async function pickModel(
  ctx: Context,
  selection: ModelSelectionRef,
  argument = '',
  options: PickModelOptions = {},
): Promise<SelectionOutcome | undefined> {
  const { options: models, choices, failed } = await discover(ctx)
  if (choices.length === 0) {
    return {
      kind: 'failed',
      message: failed.length === 0
        ? 'no provider route advertises a model; configure one first'
        : `no models available: ${failed.join(', ')} could not be listed`,
    }
  }
  const current = selection.current
  const named = argument.trim()
  if (named !== '') {
    const wanted = resolveModel(named, models)
    // Naming what IS on offer would mean listing every model every provider
    // advertises, which is what the picker is for; the count says how far it is.
    if (wanted === undefined) {
      return {
        kind: 'failed',
        message: `no model named ${named}; type /model to choose from ${String(models.length)}`,
      }
    }
    return apply(ctx, selection, wanted, current)
  }
  const initialValue = currentModelChoiceValue(current, models)
  const picked = await promptModelPicker(ctx, {
    title: 'Select a model',
    view: 'Model',
    ...current === undefined ? {} : { detail: `current: ${current.provider}/${current.model}` },
    ...initialValue === undefined ? {} : { initialValue },
    choices,
  }, options.onSubagentModels)
  if (picked === undefined) return undefined
  const chosen = models[Number(picked)]
  if (chosen === undefined) return undefined
  return apply(ctx, selection, chosen, current)
}

/**
 * Whether the target route still accepts an effort the previous route had
 * selected.
 *
 * Resolution failure answers "unknown", not "unsupported": the target's
 * capability could not be proven either way, so the deliberate choice is kept
 * rather than cleared on a guess. This is the same distinction the adapter's
 * own `UNSUPPORTED_REASONING_EFFORT` rejection draws \u2014 an exact-model fact,
 * not one this frontend approximates.
 * @param ctx - context carrying the llm registry.
 * @param chosen - the model being switched to.
 * @param wanted - the effort the previous selection carried.
 * @returns `wanted` when the target advertises it, or when capability
 *   resolution fails and support is therefore unknown; undefined when exact
 *   model resolution succeeds but the target does not advertise `wanted`,
 *   including when it exposes no reasoning metadata at all.
 */
async function stillSupported(
  ctx: Context,
  chosen: ModelOption,
  wanted: ReasoningEffortId,
): Promise<ReasoningEffortId | undefined> {
  try {
    const info = await ctx.llm.resolveModelInfo(chosen.provider, chosen.model)
    return info.reasoning?.efforts.some(effort => effort.id === wanted) === true ? wanted : undefined
  } catch {
    return wanted
  }
}

/**
 * Point the selection at one model, and remember it.
 * @param ctx - context carrying the default-model service and the llm registry.
 * @param selection - the agent's mutable selection ref.
 * @param chosen - the model to select.
 * @param current - the selection being replaced, for what it carries forward.
 * @returns the applied change, always `done`: the ref above is written before
 *   persistence is attempted, so a save failure only adds a note.
 */
async function apply(
  ctx: Context,
  selection: ModelSelectionRef,
  chosen: ModelOption,
  current: ModelSelectionRef['current'],
): Promise<SelectionOutcome> {
  // Preserve the reasoning effort across the switch, but only when the target
  // route still advertises it \u2014 carrying forward one it does not would send
  // the very next model step straight into UNSUPPORTED_REASONING_EFFORT.
  const wanted = current?.reasoningEffort
  const reasoningEffort = wanted === undefined ? undefined : await stillSupported(ctx, chosen, wanted)
  const next = {
    provider: chosen.provider,
    model: chosen.model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
  // The ref is written FIRST and unconditionally. The turn about to run reads it,
  // and a storage failure is no reason for that turn to use the old model.
  selection.current = next
  const said = [`model set to ${chosen.provider} / ${chosen.model}`]
  if (wanted !== undefined && reasoningEffort === undefined) said.push('reasoning reset to provider default')
  const note = await rememberSelection(ctx, next)
  if (note !== undefined) said.push(note)
  return { kind: 'done', message: said.join(' \u00b7 ') }
}
