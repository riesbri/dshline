/**
 * `TuiSlots.pushOverlay` is transactional.
 *
 * An overlay owns the whole live region and every keystroke while it is mounted,
 * so a mount that fails must not leave it registered: the caller has been told
 * the mount failed, and a half-mounted overlay would otherwise keep composing
 * rows and consuming input. These tests drive the real registry rather than a
 * fake, because the invariant is about what context teardown and later
 * composition see in the registry's own stack.
 * @module dshline/tests/slots
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TuiSlots } from '../src/slots.ts'
import type { TuiOverlay } from '../src/slots.ts'

/** An overlay that draws one row and answers no keys. */
function overlay(overrides: Partial<TuiOverlay> = {}): TuiOverlay {
  return { render: () => ['overlay'], handleKey: () => {}, ...overrides }
}

describe('TuiSlots.pushOverlay', () => {
  it('mounts, composes, and disposes a normal overlay exactly once', () => {
    const slots = new TuiSlots(new Context())
    const dispose = vi.fn()
    const view = overlay({ render: () => ['normal'], dispose })
    const dismiss = slots.pushOverlay(view)

    expect(slots.activeOverlay).toBe(view)
    expect(slots.compose(40, 8).lines).toEqual(['normal'])

    dismiss()
    expect(slots.activeOverlay).toBeUndefined()
    expect(dispose).toHaveBeenCalledTimes(1)
    dismiss()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('removes and disposes an overlay whose mounted() throws', () => {
    const slots = new TuiSlots(new Context())
    const failure = new Error('mount failed')
    const dispose = vi.fn()
    const bad = overlay({ render: () => ['bad'], mounted: () => { throw failure }, dispose })

    expect(() => slots.pushOverlay(bad)).toThrow(failure)
    expect(slots.activeOverlay).toBeUndefined()
    expect(slots.compose(40, 8).lines).not.toContain('bad')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('leaves the previous overlay active when a later mount fails', () => {
    const slots = new TuiSlots(new Context())
    const baseDispose = vi.fn()
    const base = overlay({ render: () => ['base'], dispose: baseDispose })
    slots.pushOverlay(base)

    expect(() => slots.pushOverlay(overlay({ render: () => ['bad'], mounted: () => { throw new Error('nope') } })))
      .toThrow('nope')

    expect(slots.activeOverlay).toBe(base)
    expect(slots.compose(40, 8).lines).toEqual(['base'])
    expect(baseDispose).not.toHaveBeenCalled()
  })

  it('invalidates after rollback so the previous region is authoritative', () => {
    const ctx = new Context()
    const slots = new TuiSlots(ctx)
    slots.pushOverlay(overlay({ render: () => ['base'] }))
    const renders = vi.fn()
    ctx.on('tui/render', renders)

    expect(() => slots.pushOverlay(overlay({ mounted: () => { throw new Error('x') } }))).toThrow('x')
    expect(renders).toHaveBeenCalled()
  })

  it('does not dispose the failed overlay again at context teardown', async () => {
    const ctx = new Context()
    const slots = new TuiSlots(ctx)
    const dispose = vi.fn()
    const bad = overlay({ mounted: () => { throw new Error('boom') }, dispose })

    expect(() => slots.pushOverlay(bad)).toThrow('boom')
    expect(dispose).toHaveBeenCalledTimes(1)

    await ctx.fiber.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(slots.activeOverlay).toBeUndefined()
  })

  it('still composes the restored stack after a failed mount', () => {
    const slots = new TuiSlots(new Context())
    slots.pushOverlay(overlay({ render: () => ['base'] }))
    expect(() => slots.pushOverlay(overlay({ mounted: () => { throw new Error('x') } }))).toThrow('x')

    // A later overlay mounts on top of the restored stack...
    const next = overlay({ render: () => ['next'] })
    const dismiss = slots.pushOverlay(next)
    expect(slots.compose(40, 8).lines).toEqual(['next'])

    // ...and taking it down restores the original rather than the failed one.
    dismiss()
    expect(slots.compose(40, 8).lines).toEqual(['base'])
  })

  it('surfaces both failures and still unregisters when rollback dispose throws', () => {
    const slots = new TuiSlots(new Context())
    const mountFailure = new Error('mount failed')
    const disposeFailure = new Error('dispose failed')
    const dispose = vi.fn(() => { throw disposeFailure })
    const bad = overlay({ mounted: () => { throw mountFailure }, dispose })

    let thrown: unknown
    try {
      slots.pushOverlay(bad)
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([mountFailure, disposeFailure])
    expect(slots.activeOverlay).toBeUndefined()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
