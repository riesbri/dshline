/** Native durable model selection through the real registry and Session log. */
import { Context } from '@deepseek-ai/cordis'
import { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { attachOptions, type Window } from '../../src/window.ts'
import { WindowModel } from '../../src/window-model.ts'

const INITIAL = { provider: 'probe', model: 'initial', reasoningEffort: ReasoningEffortId('high') }
const NEXT = { provider: 'probe', model: 'next' }

describe('capability: native model selection', () => {
  it('records the complete choice durably and restores it instead of window defaults', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    try {
      const handle = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
      const session = ctx.sessions.create()
      const native = new AgentModel(handle.readerFor(session), session, INITIAL)
      const window = new WindowModel({ provider: 'other', model: 'window-default' })
      const release = window.bind(native)
      expect(window.current()).toEqual(INITIAL)
      window.select(NEXT)
      expect(session.snapshotEvents().filter(event => event.type === 'model/selection').map(event => event.data)).toEqual([NEXT])
      expect(window.current()).toEqual(NEXT)
      expect(window.current()).not.toHaveProperty('reasoningEffort')
      const resumed = new AgentModel(handle.readerFor(session), session, INITIAL)
      expect(resumed.current()).toEqual(NEXT)
      release()
      expect(window.current()).toEqual(NEXT)
      await handle.dispose()
      // Retained native readers keep working after global unregistration.
      expect(resumed.current()).toEqual(NEXT)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never replaces the attached authority or launch defaults after a failed durable write', () => {
    const window = new WindowModel(INITIAL)
    const release = window.bind({
      current: () => INITIAL,
      select: () => { throw new Error('persistence failed') },
    })
    expect(() => window.select(NEXT)).toThrow('persistence failed')
    expect(window.current()).toEqual(INITIAL)
    release()
    expect(window.current()).toEqual(INITIAL)
  })

  it('passes explicit effort into native startup and releases the bound Agent with its scope', async () => {
    const ctx = new Context()
    const window = {
      selection: new WindowModel(INITIAL),
      refreshModelInfo: vi.fn(), commit: () => {},
    } as unknown as Window
    const options = attachOptions(window)
    expect(options.agentOptions).toEqual(INITIAL)
    try {
      await options.setup?.(ctx, { model: { current: () => NEXT, select: () => {} } } as never)
      expect(window.selection.current()).toEqual(NEXT)
      expect(window.refreshModelInfo).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
    }
    expect(window.selection.current()).toEqual(INITIAL)
  })

  it('does not let an older attachment release the newer model', () => {
    const window = new WindowModel(undefined)
    const older = window.bind({ current: () => INITIAL, select: () => {} })
    const newer = window.bind({ current: () => NEXT, select: () => {} })
    older()
    expect(window.current()).toEqual(NEXT)
    newer()
    expect(window.current()).toBeUndefined()
  })
})
