import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { stripAnsi } from '@dshline/renderer'
import type { TuiOverlay } from '../src/slots.ts'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { ModelOption } from '../src/model.ts'
import { modelCompletionValues, pickModel, resolveModel } from '../src/model.ts'

/** Two routes serving overlapping model ids, which is the case worth pinning. */
const CATALOG: Record<string, { id: string; name: string }[]> = {
  'deepseek-official': [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ],
  opencode: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
}

/** Every option the catalog above yields, in discovery order. */
const OPTIONS: readonly ModelOption[] = [
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  { provider: 'opencode', model: 'deepseek-v4-pro' },
]

/**
 * One target route's answer to `resolveModelInfo`: the reasoning efforts it
 * advertises, or `'fail'` when resolution itself should reject.
 */
type ReasoningByRoute = Record<string, readonly string[] | 'fail'>

/** A `listModels` stand-in, for a test that controls when a route catalog lands. */
type ListModels = (provider: string) => Promise<readonly { id: string; name: string }[]>

/**
 * A context offering the llm registry and a slot registry that records pushes.
 * @param reasoning - what each route's `resolveModelInfo` advertises.
 * @param overrides - substitutes for the catalog read and the registry itself,
 *   when a test needs to control when a route answers or pretend none is mounted.
 * @returns the context, whether an overlay was pushed, and the one that was.
 */
function llmContext(
  reasoning: ReasoningByRoute = {},
  overrides: {
    listModels?: ListModels
    listProviders?: () => readonly { id: string; name: string }[]
    saveSelectionError?: Error
  } = {},
): {
  ctx: Context
  pushed: () => boolean
  overlay: () => TuiOverlay | undefined
  saved: ModelSelection[]
} {
  let opened = false
  let mounted: TuiOverlay | undefined
  const saved: ModelSelection[] = []
  const services: Record<string, unknown> = {
    agentDefaultModel: {
      saveSelection: async (next: ModelSelection) => {
        if (overrides.saveSelectionError !== undefined) throw overrides.saveSelectionError
        saved.push(next)
      },
    },
    settings: {},
  }
  const ctx = {
    llm: {
      listProviders: overrides.listProviders ?? (() => Object.keys(CATALOG).map(id => ({ id, name: id }))),
      listModels: overrides.listModels ?? (async (provider: string) => CATALOG[provider] ?? []),
      resolveModelInfo: async (provider: string, model: string): Promise<LlmResolvedModelInfo> => {
        const entry = reasoning[`${provider}/${model}`]
        if (entry === 'fail') throw new Error('model info unavailable')
        const info = { provider, id: model, name: model }
        if (entry === undefined) return info
        return { ...info, reasoning: { efforts: entry.map(id => ({ id, name: id })) } }
      },
    },
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay) => {
        opened = true
        mounted = overlay
        return (): void => { mounted = undefined }
      },
      invalidate: (): void => {},
    },
    get: (name: string) => services[name],
  } as unknown as Context
  return { ctx, pushed: () => opened, overlay: () => mounted, saved }
}

/**
 * A `listModels` whose route catalogs settle only when the test says so.
 * @returns the stand-in, the route keys it was called for in order, and the
 *   controls to settle or fail one route.
 */
function deferredCatalogs(): {
  listModels: ListModels
  called: string[]
  settle: (provider: string, models: readonly { id: string; name: string }[]) => void
  fail: (provider: string, error: Error) => void
} {
  const called: string[] = []
  const pending = new Map<string, {
    resolve: (models: readonly { id: string; name: string }[]) => void
    reject: (error: Error) => void
  }>()
  return {
    called,
    listModels: provider => {
      called.push(provider)
      return new Promise((resolve, reject) => { pending.set(provider, { resolve, reject }) })
    },
    settle: (provider, models) => { pending.get(provider)?.resolve(models) },
    fail: (provider, error) => { pending.get(provider)?.reject(error) },
  }
}

/**
 * Let queued microtasks and a macrotask run, so a promise that will not settle
 * is distinguishable from one that has simply not settled yet.
 * @returns a promise resolving after the pending work.
 */
async function settled(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/**
 * A selection ref on the flash route.
 * @param effort - the reasoning effort it starts on, if any.
 * @returns the ref.
 */
function selectionOn(effort?: string): ModelSelectionRef {
  return {
    current: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      ...effort === undefined ? {} : { reasoningEffort: effort },
    },
    assembled: undefined,
  } as unknown as ModelSelectionRef
}

describe('resolveModel()', () => {
  it('takes a bare model id when one route serves it', () => {
    expect(resolveModel('deepseek-v4-flash', OPTIONS)?.provider).toBe('deepseek-official')
  })

  it('matches whatever case it was typed in', () => {
    expect(resolveModel('  DeepSeek-V4-Flash ', OPTIONS)?.model).toBe('deepseek-v4-flash')
  })

  it('lets provider/model say which route, when two serve the same id', () => {
    // The bare id is ambiguous here and resolves to the first route discovered,
    // so the qualified spelling is the only way to reach the other one.
    expect(resolveModel('opencode/deepseek-v4-pro', OPTIONS)?.provider).toBe('opencode')
    expect(resolveModel('deepseek-v4-pro', OPTIONS)?.provider).toBe('deepseek-official')
  })

  it('matches nothing for a name no route offers', () => {
    expect(resolveModel('gpt-9', OPTIONS)).toBeUndefined()
    expect(resolveModel('', OPTIONS)).toBeUndefined()
  })
})

describe('modelCompletionValues()', () => {
  it('qualifies every value with its route, so two routes never share one', async () => {
    const { ctx } = llmContext()
    expect((await modelCompletionValues(ctx)).map(choice => choice.value)).toEqual([
      'deepseek-official/deepseek-v4-flash',
      'deepseek-official/deepseek-v4-pro',
      'opencode/deepseek-v4-pro',
    ])
  })

  it('keeps the bare model id as a search alias, never as the value', async () => {
    // Completion inserts the qualified route; the alias only lets a reader
    // discover the row by typing the model id they know.
    const { ctx } = llmContext()
    expect((await modelCompletionValues(ctx))[2]?.aliases).toEqual(['deepseek-v4-pro'])
  })

  it('round-trips every value back to the exact route and model it names', async () => {
    const { ctx } = llmContext()
    const values = await modelCompletionValues(ctx)
    values.forEach((choice, index) => {
      expect(resolveModel(choice.value, OPTIONS)).toEqual(OPTIONS[index])
    })
    // The overlapping id is the one a bare spelling cannot disambiguate.
    expect(resolveModel('opencode/deepseek-v4-pro', OPTIONS))
      .toEqual({ provider: 'opencode', model: 'deepseek-v4-pro' })
  })

  it('notes a display name only when it says something the id does not', async () => {
    // `DeepSeek-V4-Flash` differs from its id only in capitals, so repeating it
    // would spend columns saying nothing. `DeepSeek V4 Pro` earns its note.
    const { ctx } = llmContext()
    const values = await modelCompletionValues(ctx)
    expect(values[0]?.note).toBeUndefined()
    expect(values[2]?.note).toBe('DeepSeek V4 Pro')
  })
})

describe('provider catalog reads', () => {
  it('begins every route before awaiting any, and keeps listProviders order', async () => {
    // The two catalogs are independent: a slow first route must not delay the
    // start of the second, and settling the second first must not reorder them.
    const arena = deferredCatalogs()
    const { ctx } = llmContext({}, { listModels: arena.listModels })
    const running = modelCompletionValues(ctx)
    expect(arena.called).toEqual(['deepseek-official', 'opencode'])

    // Settling the later route alone cannot finish discovery: the earlier one
    // is still outstanding, which is what proves they were read together.
    let landed = false
    void running.then(() => { landed = true })
    arena.settle('opencode', [{ id: 'later-model', name: '' }])
    await settled()
    expect(landed).toBe(false)

    arena.settle('deepseek-official', [{ id: 'earlier-model', name: '' }])
    expect((await running).map(choice => choice.value)).toEqual([
      'deepseek-official/earlier-model',
      'opencode/later-model',
    ])
  })

  it('keeps a healthy route when another route fails, and never rejects', async () => {
    const arena = deferredCatalogs()
    const { ctx } = llmContext({}, { listModels: arena.listModels })
    const running = modelCompletionValues(ctx)
    arena.fail('deepseek-official', new Error('route down'))
    arena.settle('opencode', [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }])
    await expect(running).resolves.toEqual([
      { value: 'opencode/deepseek-v4-pro', aliases: ['deepseek-v4-pro'], note: 'DeepSeek V4 Pro' },
    ])
  })

  it('names every route that could not be listed when none is available', async () => {
    const arena = deferredCatalogs()
    const { ctx } = llmContext({}, { listModels: arena.listModels })
    const running = pickModel(ctx, selectionOn(), '')
    arena.fail('deepseek-official', new Error('route down'))
    arena.fail('opencode', new Error('route down'))
    await expect(running).resolves.toEqual({
      kind: 'failed',
      message: 'no models available: deepseek-official, opencode could not be listed',
    })
  })

  it('refuses with a failed outcome when no provider advertises any model', async () => {
    // Nothing was offered and nothing changed, so this is an error to show, not
    // an acknowledgement.
    const { ctx } = llmContext({}, { listProviders: () => [] })
    const selection = selectionOn()
    await expect(pickModel(ctx, selection, '')).resolves.toEqual({
      kind: 'failed',
      message: 'no provider route advertises a model; configure one first',
    })
    expect(selection.current?.model).toBe('deepseek-v4-flash')
  })
})

describe('what the picker offers', () => {
  it('labels every row with the argument /model accepts', async () => {
    // A gateway route advertises hundreds of models and the list is reached by
    // typing, so a row that showed a display name while the command took an id
    // would make the reader translate between the two.
    const { ctx, overlay } = llmContext()
    const running = pickModel(ctx, selectionOn())
    // Discovery awaits `listModels` per route, so the overlay is not mounted
    // until those have landed.
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    const shown = stripAnsi(overlay()?.render(80, 24).join('\n') ?? '')
    expect(shown).toContain('deepseek-official/deepseek-v4-flash')
    expect(shown).toContain('opencode/deepseek-v4-pro')
    expect(shown).toContain('current: deepseek-official/deepseek-v4-flash')
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    expect(await running).toBeUndefined()
  })

  it('puts a display name under the selection only when it adds something', async () => {
    // `DeepSeek-V4-Flash` is its own id with different capitals, so repeating it
    // under the row would spend a line saying nothing. `DeepSeek V4 Pro` is not,
    // so it earns one.
    const { ctx, overlay } = llmContext()
    const running = pickModel(ctx, selectionOn())
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    const first = stripAnsi(overlay()?.render(80, 24).join('\n') ?? '')
    expect(first).toContain('deepseek-official/deepseek-v4-flash')
    expect(first).not.toContain('DeepSeek-V4-Flash')
    // Walk to the opencode row, whose name differs by more than its capitals.
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    expect(stripAnsi(overlay()?.render(80, 24).join('\n') ?? '')).toContain('DeepSeek V4 Pro')
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await running
  })

  it('opens on the exact current route and model, not the first discovery', async () => {
    // `opencode/deepseek-v4-pro` is the third discovered option and shares its
    // model id with a direct route, so a first-row fallback would switch the
    // route out from under the user on a bare Enter.
    const { ctx, overlay, saved } = llmContext()
    const selection = {
      current: { provider: 'opencode', model: 'deepseek-v4-pro' },
      assembled: undefined,
    } as unknown as ModelSelectionRef
    const running = pickModel(ctx, selection, '')
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    expect(stripAnsi(overlay()?.render(80, 24).join('\n') ?? ''))
      .toContain('❯ opencode/deepseek-v4-pro')
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await running
    expect(selection.current?.provider).toBe('opencode')
    expect(selection.current?.model).toBe('deepseek-v4-pro')
    expect(saved).toEqual([{ provider: 'opencode', model: 'deepseek-v4-pro' }])
  })
})

describe('the bare picker advertises its auxiliary action', () => {
  it('names ctrl-k subagents when the caller supplied the editor opener', async () => {
    const { ctx, overlay } = llmContext()
    const running = pickModel(ctx, selectionOn(), '', { onSubagentModels: () => {} })
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    // What a person sees: the shortcut is discoverable on the screen itself,
    // not only from the usage guide.
    expect(stripAnsi(overlay()?.render(100, 30).join('\n') ?? '')).toContain('ctrl-k subagents')
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await running
  })

  it('names nothing and leaves ctrl-k inert when the caller supplied no opener', async () => {
    // `/setup` reaches a picker by exactly this call — `pickModel` with no
    // options — so what that screen must not advertise is pinned here.
    const { ctx, overlay } = llmContext()
    const running = pickModel(ctx, selectionOn(), '')
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    expect(stripAnsi(overlay()?.render(100, 30).join('\n') ?? '')).not.toContain('ctrl-k')
    overlay()?.handleKey({ kind: 'key', name: 'ctrl-k' })
    // No auxiliary surface exists, so the same picker is still the mounted
    // screen; nothing opened and nothing settled.
    const after = stripAnsi(overlay()?.render(100, 30).join('\n') ?? '')
    expect(after).toContain('Select a model')
    expect(after).not.toContain('Subagent models')
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await running
  })
})

describe('pickModel() with an argument', () => {
  it('switches without opening the picker', async () => {
    const { ctx, pushed } = llmContext()
    const selection = selectionOn()
    const outcome = await pickModel(ctx, selection, ' deepseek-v4-pro ')
    expect(outcome).toMatchObject({ kind: 'done' })
    expect(outcome?.message).toContain('deepseek-v4-pro')
    expect(selection.current?.model).toBe('deepseek-v4-pro')
    expect(pushed()).toBe(false)
  })

  it('keeps the reasoning effort when the target still advertises it', async () => {
    // The effort belongs to the selection, and dropping it on a model switch
    // would silently reset a deliberate choice — but only when the target can
    // actually serve it.
    const { ctx } = llmContext({ 'deepseek-official/deepseek-v4-pro': ['high', 'max'] })
    const selection = selectionOn('max')
    await pickModel(ctx, selection, 'deepseek-v4-pro')
    expect(selection.current?.reasoningEffort).toBe('max')
  })

  it('stores the switch as the default every surface reads', async () => {
    // What makes a model chosen here the one the web interface opens with.
    const { ctx, saved } = llmContext({ 'deepseek-official/deepseek-v4-pro': ['high', 'max'] })
    const outcome = await pickModel(ctx, selectionOn('max'), 'deepseek-v4-pro')
    expect(saved).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }])
    expect(outcome?.message).toContain('also the default for new sessions')
  })

  it('does not touch reasoning when the current selection carries none', async () => {
    const { ctx, saved } = llmContext()
    await pickModel(ctx, selectionOn(), 'deepseek-v4-pro')
    expect(saved).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }])
  })

  it('is done when it re-selects the model already in force', async () => {
    // Nothing has to differ for the change to have landed: the ref is written
    // to the state the user asked for, so the acknowledgement is truthful.
    const { ctx } = llmContext()
    const selection = selectionOn()
    const outcome = await pickModel(ctx, selection, 'deepseek-v4-flash')
    expect(outcome).toMatchObject({ kind: 'done' })
    expect(selection.current?.model).toBe('deepseek-v4-flash')
  })

  it('stays done when the switch landed but the default could not be saved', async () => {
    // The ref is written before persistence is attempted, so the next turn
    // already uses the new model. A failed save is a note about a LATER session,
    // never a reason to report the change as failed or roll it back.
    const failure = new Error('settings.yaml is read-only')
    const { ctx, saved } = llmContext({}, { saveSelectionError: failure })
    const selection = selectionOn()
    const outcome = await pickModel(ctx, selection, 'deepseek-v4-pro')
    expect(selection.current).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(saved).toEqual([])
    expect(outcome).toMatchObject({ kind: 'done' })
    expect(outcome?.message).toContain('model set to deepseek-official / deepseek-v4-pro')
    expect(outcome?.message).toContain('could not save it as the default')
    expect(outcome?.message).toContain('read-only')
  })

  it('stores nothing when the name matched nothing', async () => {
    const { ctx, saved } = llmContext()
    await pickModel(ctx, selectionOn(), 'gpt-9')
    expect(saved).toEqual([])
  })

  it('says how many there are rather than listing every model', async () => {
    const { ctx, pushed } = llmContext()
    const selection = selectionOn()
    const outcome = await pickModel(ctx, selection, 'gpt-9')
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect(outcome?.message).toContain('no model named gpt-9')
    expect(outcome?.message).toContain('3')
    expect(selection.current?.model).toBe('deepseek-v4-flash')
    expect(pushed()).toBe(false)
  })

  it('opens the picker when nothing was named', async () => {
    const { ctx, pushed } = llmContext()
    // Left unsettled on purpose: what matters is that the overlay went up, which
    // happens only after discovery has awaited every route's catalog.
    void pickModel(ctx, selectionOn(), '')
    await vi.waitFor(() => { expect(pushed()).toBe(true) })
  })
})

describe('reasoning effort across a model switch', () => {
  it('clears an effort the target does not advertise', async () => {
    // Carrying it forward would send the next turn straight into Harness's
    // own UNSUPPORTED_REASONING_EFFORT rejection.
    const { ctx, saved } = llmContext({ 'deepseek-official/deepseek-v4-pro': ['off', 'high'] })
    const selection = selectionOn('max')
    const outcome = await pickModel(ctx, selection, 'deepseek-v4-pro')
    expect(selection.current?.reasoningEffort).toBeUndefined()
    expect(saved).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }])
    expect(outcome?.message).toContain('reasoning reset to provider default')
  })

  it('clears an effort when the target resolves with no reasoning field at all', async () => {
    // A route exposing no selectable reasoning metadata resolves with
    // `reasoning: undefined`, never an explicit empty `efforts` array — Harness
    // rejects that shape as INVALID_MODEL_REASONING. This is also the shape the
    // default `/connect` custom route resolves to when no reasoning efforts are
    // configured.
    const { ctx, saved } = llmContext()
    const selection = selectionOn('high')
    await pickModel(ctx, selection, 'deepseek-v4-pro')
    expect(selection.current?.reasoningEffort).toBeUndefined()
    expect(saved).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }])
  })

  it('keeps the effort when the target route cannot be resolved', async () => {
    // Resolution failure means unknown, not unsupported: the target's
    // capability was never actually disproved, so the deliberate choice
    // survives rather than being cleared on a guess.
    const { ctx, saved } = llmContext({ 'deepseek-official/deepseek-v4-pro': 'fail' })
    const selection = selectionOn('max')
    await pickModel(ctx, selection, 'deepseek-v4-pro')
    expect(selection.current?.reasoningEffort).toBe('max')
    expect(saved).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }])
  })
})
