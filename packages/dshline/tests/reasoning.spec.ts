import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { LlmModelReasoningInfo, LlmReasoningEffortInfo } from '@deepseek-ai/dsh-llm'
import { stripAnsi } from '@dshline/renderer'
import type { Key } from '@dshline/renderer'
import { effortLabel, pickReasoning, reasoningValues, resolveEffort } from '../src/reasoning.ts'
import type { TuiOverlay } from '../src/slots.ts'

/** What a DeepSeek route advertises, in the adapter's own display order. */
const EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
] as unknown as readonly LlmReasoningEffortInfo[]

/** The same list with a default, as an adapter that configures one reports it. */
const REASONING = { efforts: EFFORTS, defaultEffort: 'high' } as unknown as LlmModelReasoningInfo

/**
 * A selection ref on a real route.
 * @param effort - the effort it starts on, if any.
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

/**
 * A context offering only the slot registry the picker touches.
 * @returns the context, and a reader for whatever overlay was pushed.
 */
function slotContext(): {
  ctx: Context
  overlay: () => TuiOverlay | undefined
  saved: { provider: string; model: string; reasoningEffort?: string }[]
} {
  let pushed: TuiOverlay | undefined
  const saved: { provider: string; model: string; reasoningEffort?: string }[] = []
  const services: Record<string, unknown> = {
    agentDefaultModel: {
      saveSelection: async (next: { provider: string; model: string; reasoningEffort?: string }) => {
        saved.push(next)
      },
    },
    settings: {},
  }
  const ctx = {
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay) => {
        pushed = overlay
        return (): void => { pushed = undefined }
      },
      invalidate: (): void => {},
    },
    get: (name: string) => services[name],
  } as unknown as Context
  return { ctx, overlay: () => pushed, saved }
}

/** One decoded keypress. */
const press = (name: string): Key => ({ kind: 'key', name } as unknown as Key)

describe('resolveEffort()', () => {
  it('matches an id the adapter published, whatever case it was typed in', () => {
    expect(resolveEffort('max', EFFORTS)?.id).toBe('max')
    expect(resolveEffort('MAX', EFFORTS)?.id).toBe('max')
    expect(resolveEffort('  High  ', EFFORTS)?.id).toBe('high')
  })

  it('rejects a word the adapter never advertised', () => {
    // Branding an unmatched word on trust would defer the failure to the
    // provider, one turn later, with an error the user cannot act on.
    expect(resolveEffort('low', EFFORTS)).toBeUndefined()
    expect(resolveEffort('', EFFORTS)).toBeUndefined()
  })
})

describe('reasoningValues()', () => {
  it('offers the adapter levels, with the clearing word last', () => {
    // Clearing is not one of the levels, so it does not sit among them: it
    // removes a selection rather than making one.
    expect(reasoningValues(REASONING).map(one => one.value)).toEqual(['off', 'high', 'max', 'default'])
  })

  it('offers nothing at all for a route with no levels', () => {
    // Not even the clearing word: there is no selection to clear, and a lone
    // `default` would advertise a setting the route does not have.
    expect(reasoningValues(undefined)).toEqual([])
  })
})

describe('effortLabel()', () => {
  it('stays quiet about the level the deployment already defaults to', () => {
    expect(effortLabel('high', REASONING)).toBeUndefined()
  })

  it('names a level the user chose over the default', () => {
    expect(effortLabel('max', REASONING)).toBe('max')
    expect(effortLabel('off', REASONING)).toBe('off')
  })

  it('says nothing when no level is set', () => {
    expect(effortLabel(undefined, REASONING)).toBeUndefined()
  })

  it('names any level when the adapter publishes no default to be the same as', () => {
    expect(effortLabel('high', { efforts: EFFORTS } as unknown as LlmModelReasoningInfo)).toBe('high')
  })
})

describe('pickReasoning()', () => {
  const { ctx } = slotContext()

  it('sets the level an argument names, and never opens anything', async () => {
    // `/reasoning high` is an instruction, not a question. Anything on screen
    // afterwards is something to dismiss before typing again.
    const named = slotContext()
    const selection = selectionOn('high')
    const outcome = await pickReasoning(named.ctx, selection, REASONING, 'max')
    expect(outcome).toContain('max')
    expect(selection.current?.reasoningEffort).toBe('max')
    expect(named.overlay()).toBeUndefined()
  })

  it('stores the level beside the route it applies to', async () => {
    // One selection, stored whole: a level saved without its model would be a
    // level for whichever model the next session happened to open on.
    const named = slotContext()
    await pickReasoning(named.ctx, selectionOn('high'), REASONING, 'max')
    expect(named.saved).toEqual([{
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    }])
  })

  it('stores the cleared level as an absence, not as a word', async () => {
    const named = slotContext()
    await pickReasoning(named.ctx, selectionOn('max'), REASONING, 'default')
    expect(named.saved).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }])
  })

  it('stores nothing when the argument matched no level', async () => {
    const named = slotContext()
    await pickReasoning(named.ctx, selectionOn('high'), REASONING, 'turbo')
    expect(named.saved).toEqual([])
  })

  it('opens nothing even when the argument is rejected', async () => {
    // Falling back to the picker on a typo would be a popup arriving precisely
    // when the user was told they had got something wrong.
    const named = slotContext()
    await pickReasoning(named.ctx, selectionOn('high'), REASONING, 'turbo')
    expect(named.overlay()).toBeUndefined()
  })

  it('keeps the route the level applies to', () => {
    const selection = selectionOn()
    return pickReasoning(ctx, selection, REASONING, 'off').then(() => {
      expect(selection.current?.provider).toBe('deepseek-official')
      expect(selection.current?.model).toBe('deepseek-v4-flash')
    })
  })

  it('clears the level rather than setting one, on the default word', () => {
    // Clearing is not a level of its own: an absent effort restores the
    // provider's own behavior, which `off` — telling it not to think — is not.
    const selection = selectionOn('max')
    return pickReasoning(ctx, selection, REASONING, 'default').then(outcome => {
      expect(outcome).toContain('cleared')
      expect(selection.current?.reasoningEffort).toBeUndefined()
    })
  })

  it('names what IS accepted when a word matched nothing, and changes nothing', () => {
    // A bare rejection leaves the user guessing at a list only the adapter knows.
    const selection = selectionOn('high')
    return pickReasoning(ctx, selection, REASONING, 'turbo').then(outcome => {
      expect(outcome).toContain('off, high, max, default')
      expect(selection.current?.reasoningEffort).toBe('high')
    })
  })

  it('says so when the route advertises no levels at all', () => {
    const selection = selectionOn()
    return pickReasoning(ctx, selection, undefined, 'max').then(outcome => {
      expect(outcome).toContain('deepseek-v4-flash')
      expect(selection.current?.reasoningEffort).toBeUndefined()
    })
  })

  it('says so on a bare /reasoning too, when the route advertises no levels', () => {
    const selection = selectionOn()
    return pickReasoning(ctx, selection, undefined, '').then(outcome => {
      expect(outcome).toContain('deepseek-v4-flash')
      expect(outcome).toContain('advertises no reasoning levels')
    })
  })

  it('clears a stale effort via /reasoning default even when the route advertises no levels', () => {
    // `default` deletes the stored effort; it is not one of the adapter's
    // levels, so a route naming none — reached with an effort a previous
    // model's switch left behind — must still be able to reach it.
    const selection = selectionOn('high')
    return pickReasoning(ctx, selection, undefined, 'default').then(outcome => {
      expect(outcome).toContain('cleared')
      expect(selection.current?.reasoningEffort).toBeUndefined()
    })
  })

  it('saves the complete selection without reasoningEffort when defaulted on a levelless route', () => {
    const named = slotContext()
    return pickReasoning(named.ctx, selectionOn('high'), undefined, 'default').then(() => {
      expect(named.saved).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }])
    })
  })

  it('asks for a model first when none is selected', () => {
    const selection = { current: undefined, assembled: undefined } as ModelSelectionRef
    return pickReasoning(ctx, selection, REASONING, 'max').then(outcome => {
      expect(outcome).toContain('/model')
    })
  })
})

describe('the reasoning picker', () => {
  it('opens on the current explicit level, not the first row', async () => {
    // `max` is row 2. Entering immediately must keep the level in force; a
    // picker that opened on row 0 would silently choose `off`.
    const { ctx, overlay } = slotContext()
    const selection = selectionOn('max')
    const settled = pickReasoning(ctx, selection, REASONING, '')
    expect(stripAnsi(overlay()?.render(80, 24).join('\n') ?? '')).toContain('❯ Max')
    overlay()?.handleKey(press('enter'))
    expect(await settled).toContain('max')
    expect(selection.current?.reasoningEffort).toBe('max')
  })

  it('opens on Default when no explicit effort is stored', async () => {
    // `default` is semantic absence, not the adapter's `defaultEffort` of
    // `high`: an unset selection must not become the first advertised level.
    const { ctx, overlay } = slotContext()
    const selection = selectionOn()
    const settled = pickReasoning(ctx, selection, REASONING, '')
    expect(stripAnsi(overlay()?.render(80, 24).join('\n') ?? '')).toContain('❯ Default')
    overlay()?.handleKey(press('enter'))
    expect(await settled).toContain('cleared')
    expect(selection.current?.reasoningEffort).toBeUndefined()
  })

  it('keeps an explicit level that happens to match the provider default', async () => {
    // `high` is both the stored selection and `defaultEffort`; the picker must
    // highlight the explicit `High` row, not `Default`, because the stored
    // choice is semantically an explicit one.
    const { ctx, overlay } = slotContext()
    const selection = selectionOn('high')
    const settled = pickReasoning(ctx, selection, REASONING, '')
    expect(stripAnsi(overlay()?.render(80, 24).join('\n') ?? '')).toContain('❯ High')
    overlay()?.handleKey(press('enter'))
    expect(await settled).toContain('high')
    expect(selection.current?.reasoningEffort).toBe('high')
  })

  it('moves from the current level one row at a time', async () => {
    const { ctx, overlay } = slotContext()
    const selection = selectionOn('off')
    const settled = pickReasoning(ctx, selection, REASONING, '')
    overlay()?.handleKey(press('down'))
    overlay()?.handleKey(press('enter'))
    expect(await settled).toContain('high')
    expect(selection.current?.reasoningEffort).toBe('high')
  })

  it('offers clearing the level as the last choice', async () => {
    const { ctx, overlay } = slotContext()
    const selection = selectionOn('max')
    const settled = pickReasoning(ctx, selection, REASONING, '')
    overlay()?.handleKey(press('end'))
    overlay()?.handleKey(press('enter'))
    expect(await settled).toContain('cleared')
    expect(selection.current?.reasoningEffort).toBeUndefined()
  })

  it('leaves the level alone when the picker is dismissed', async () => {
    const { ctx, overlay } = slotContext()
    const selection = selectionOn('max')
    const settled = pickReasoning(ctx, selection, REASONING, '')
    overlay()?.handleKey(press('escape'))
    expect(await settled).toBeUndefined()
    expect(selection.current?.reasoningEffort).toBe('max')
  })
})
