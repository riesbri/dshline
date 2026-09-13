/**
 * `TuiSlots.pushOverlay` is transactional.
 *
 * An overlay owns the whole live region and every keystroke while it is mounted,
 * so a mount that fails must not leave it registered: the caller has been told
 * the mount failed, and a half-mounted overlay would otherwise keep composing
 * rows and consuming input. The rollback covers only the registration
 * `pushOverlay` itself makes; an overlay a hook pushes on its own is a separate
 * registration with its own lifecycle. These tests drive the real registry
 * rather than a fake, because the invariant is about what context teardown and
 * later composition see in the registry's own stack.
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

  it('invalidates after rollback so the remaining stack is authoritative', () => {
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

  it('rolls back only the failed overlay when mounted() pushes another first', async () => {
    const ctx = new Context()
    const slots = new TuiSlots(ctx)
    const base = overlay({ render: () => ['base'] })
    slots.pushOverlay(base)

    const nestedDispose = vi.fn()
    const nested = overlay({ render: () => ['nested'], dispose: nestedDispose })
    const failedDispose = vi.fn()
    let dismissNested: (() => void) | undefined
    const failed = overlay({
      render: () => ['failed'],
      mounted: () => {
        dismissNested = slots.pushOverlay(nested)
        throw new Error('A failed')
      },
      dispose: failedDispose,
    })

    expect(() => slots.pushOverlay(failed)).toThrow('A failed')

    // A naive `pop()` would have removed B and left A registered; the failed
    // overlay is removed by identity instead.
    expect(failedDispose).toHaveBeenCalledTimes(1)
    expect(slots.activeOverlay).toBe(nested)
    expect(slots.compose(40, 8).lines).toEqual(['nested'])

    // B is a successful registration and keeps its own lifecycle.
    dismissNested?.()
    expect(slots.compose(40, 8).lines).toEqual(['base'])
    expect(nestedDispose).toHaveBeenCalledTimes(1)

    await ctx.fiber.dispose()
    expect(failedDispose).toHaveBeenCalledTimes(1)
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

  it('surfaces a rollback invalidation failure without masking the earlier failures', () => {
    const ctx = new Context()
    const slots = new TuiSlots(ctx)
    const mountFailure = new Error('mount failed')
    const disposeFailure = new Error('dispose failed')
    const invalidateFailure = new Error('redraw failed')
    ctx.on('tui/render', () => { throw invalidateFailure })
    const bad = overlay({
      mounted: () => { throw mountFailure },
      dispose: () => { throw disposeFailure },
    })

    let thrown: unknown
    try {
      slots.pushOverlay(bad)
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([mountFailure, disposeFailure, invalidateFailure])
    expect(slots.activeOverlay).toBeUndefined()
  })

  it('rolls back the registration when the initial redraw throws before the disposer exists', async () => {
    const ctx = new Context()
    const slots = new TuiSlots(ctx)
    const invalidateFailure = new Error('redraw failed')
    let renders = 0
    ctx.on('tui/render', () => {
      renders += 1
      // Only the initial registration redraw fails; the rollback redraw is the
      // listener's second call and must still run.
      if (renders === 1) throw invalidateFailure
    })
    const dispose = vi.fn()
    const view = overlay({ render: () => ['mounted'], dispose })

    expect(() => slots.pushOverlay(view)).toThrow(invalidateFailure)
    expect(slots.activeOverlay).toBeUndefined()
    expect(slots.compose(40, 8).lines).not.toContain('mounted')
    expect(dispose).toHaveBeenCalledTimes(1)

    await ctx.fiber.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(renders).toBe(2)
  })

  it('orders initial-invalidation, disposal, and rollback-invalidation failures', () => {
    const ctx = new Context()
    const slots = new TuiSlots(ctx)
    const initialFailure = new Error('initial redraw failed')
    const disposeFailure = new Error('dispose failed')
    const rollbackFailure = new Error('rollback redraw failed')
    let renders = 0
    ctx.on('tui/render', () => {
      renders += 1
      throw renders === 1 ? initialFailure : rollbackFailure
    })
    const bad = overlay({ dispose: () => { throw disposeFailure } })

    let thrown: unknown
    try {
      slots.pushOverlay(bad)
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([initialFailure, disposeFailure, rollbackFailure])
    expect(slots.activeOverlay).toBeUndefined()
  })
})

describe('TuiSlots overlay disposal', () => {
  it('still requests a redraw when a disposer throws, so the base UI is authoritative', () => {
    // Removal and disposal both happen before the redraw request, so an
    // unguarded disposer would skip it and leave a frame on screen that the
    // registry no longer knows about. The throw is still propagated.
    const ctx = new Context()
    const slots = new TuiSlots(ctx)
    slots.pushOverlay(overlay({ render: () => ['base'] }))
    const renders = vi.fn()
    ctx.on('tui/render', renders)
    const failure = new Error('dispose failed')
    const dismiss = slots.pushOverlay(overlay({ render: () => ['overlay'], dispose: () => { throw failure } }))
    renders.mockClear()

    expect(() => dismiss()).toThrow(failure)
    expect(slots.compose(40, 8).lines).toEqual(['base'])
    expect(renders).toHaveBeenCalled()
  })

  it('disposes every mounted overlay even when the first throws', async () => {
    // Teardown splices the whole stack out before disposing, so stopping at the
    // first failure would leak every overlay after it with nothing left to
    // dispose them.
    const ctx = new Context()
    const slots = new TuiSlots(ctx)
    const first = vi.fn(() => { throw new Error('first disposal failed') })
    const second = vi.fn()
    slots.pushOverlay(overlay({ dispose: first }))
    slots.pushOverlay(overlay({ dispose: second }))

    try {
      await ctx.fiber.dispose()
    } catch {
      // Cordis may surface the collected failure; the disposal contract is what
      // this test holds, not the wrapper's error policy.
    }

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(slots.activeOverlay).toBeUndefined()
  })
})

describe('TuiSlots.compose height backstop', () => {
  it('clips an over-granted view from the top and keeps the later views', () => {
    // A view that ignores the rows it was handed must not be able to push the
    // region past the screen. The composition order is the priority: dropping
    // from the top keeps the composer and status line, which sit later.
    const slots = new TuiSlots(new Context())
    slots.register('stream', { render: () => Array.from({ length: 50 }, (_, i) => `stream ${String(i)}`) })
    slots.register('composer', { render: () => ['input'], cursor: () => ({ row: 0, column: 2 }) })

    const { lines, cursor } = slots.compose(40, 4)
    expect(lines).toHaveLength(4)
    expect(lines.at(-1)).toBe('input')
    // The cursor is translated by the same drop, so it still names the drawn
    // input row rather than a row that was clipped away.
    expect(lines[cursor?.row ?? -1]).toBe('input')
    expect(cursor?.column).toBe(2)
  })

  it('keeps the cursor-bearing surface when a later view overspends', () => {
    // The composer owns the cursor and a LATER slot (`completion`, in the real
    // order stream → composer → completion → timing → status) returns far more
    // rows than it was granted. Dropping from the top would clip the composer
    // away and then clamp the cursor onto an unrelated surviving candidate row;
    // the interactive surface must win, and the later rows are surrendered.
    const slots = new TuiSlots(new Context())
    slots.register('composer', { render: () => ['input'], cursor: () => ({ row: 0, column: 2 }) })
    slots.register('completion', { render: () => Array.from({ length: 20 }, (_, i) => `candidate ${String(i)}`) })

    const { lines, cursor } = slots.compose(40, 4)
    expect(lines).toHaveLength(4)
    expect(lines[cursor?.row ?? -1]).toBe('input')
    expect(cursor?.column).toBe(2)
  })

  it('drops the whole region and its cursor when there is no height at all', () => {
    const slots = new TuiSlots(new Context())
    slots.register('composer', { render: () => ['input'], cursor: () => ({ row: 0, column: 0 }) })
    expect(slots.compose(40, 0)).toEqual({ lines: [], cursor: undefined })
  })

  it('bounds an overlay that returns more rows than the terminal has', () => {
    const slots = new TuiSlots(new Context())
    slots.pushOverlay({
      render: () => Array.from({ length: 30 }, (_, i) => `row ${String(i)}`),
      handleKey: () => {},
    })
    const { lines, cursor } = slots.compose(40, 3)
    expect(lines).toHaveLength(3)
    // An overlay owns no cursor.
    expect(cursor).toBeUndefined()
  })
})

describe('TuiSlots overlay disposal failures', () => {
  it('runs every disposer when more than one throws', async () => {
    const ctx = new Context()
    const slots = new TuiSlots(ctx)
    const calls: string[] = []
    slots.pushOverlay(overlay({ dispose: () => { calls.push('first'); throw new Error('first') } }))
    slots.pushOverlay(overlay({ dispose: () => { calls.push('second') } }))
    slots.pushOverlay(overlay({ dispose: () => { calls.push('third'); throw new Error('third') } }))

    // Cordis swallows an effect disposer's throw, so the point proven here is
    // that teardown does not ABORT at the first failure and leak the rest.
    try {
      await ctx.fiber.dispose()
    } catch {
      // The wrapper's error policy is not this test's contract.
    }
    expect(calls).toEqual(['first', 'second', 'third'])
    expect(slots.activeOverlay).toBeUndefined()
  })

  it('carries a redraw failure alongside the disposal failure, in order', () => {
    const ctx = new Context()
    const slots = new TuiSlots(ctx)
    slots.pushOverlay(overlay({ render: () => ['base'] }))
    const disposeFailure = new Error('dispose failed')
    const redrawFailure = new Error('redraw failed')
    const dismiss = slots.pushOverlay(overlay({ dispose: () => { throw disposeFailure } }))
    // Armed after the mount redraw so the failure under test is the DISPOSAL
    // redraw, not the initial one.
    ctx.on('tui/render', () => { throw redrawFailure })

    let thrown: unknown
    try {
      dismiss()
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([disposeFailure, redrawFailure])
    // The registration is gone, so a second dismissal is a no-op and does not
    // dispose again or attempt another redraw.
    dismiss()
    expect(slots.compose(40, 8).lines).toEqual(['base'])
  })
})
