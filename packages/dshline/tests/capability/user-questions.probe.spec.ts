/**
 * Capability probe: `ctx.userQuestions`.
 *
 * Exercises the exact seam `installQuestionProvider` consumes against the
 * real `@deepseek-ai/dsh-user-questions` service — not a dshline-shaped fake
 * — through a real `TuiSlots` overlay stack, so a real request reaches a real
 * terminal-provider boundary and a real structured answer comes back.
 * dshline registers on the one registration the adopted Harness generation
 * publishes — the Agent-scoped `user-questions/request` waterfall — so what
 * this proves is that the real service's own dispatch reaches it and that its
 * disposal really unregisters. Presentation behavior (plan-review,
 * cancellation, …) is covered by the ordinary `tests/questions.spec.ts`; this
 * file is only the capability contract.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { stripAnsi } from '@dshline/renderer'
import { describe, expect, it, vi } from 'vitest'
import { installQuestionProvider } from '../../src/questions.ts'
import { TuiSlots } from '../../src/slots.ts'

describe('capability: userQuestions', () => {
  it('carries a real Harness question request to a real terminal answer', async () => {
    const ctx = new Context()
    await ctx.plugin(TuiSlots)
    await ctx.plugin(UserQuestionService)
    let bells = 0
    const dispose = installQuestionProvider(ctx, () => { bells += 1 })
    try {
      const answer = ctx.userQuestions.ask({
        questions: [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'yes' }] }],
      })
      // Waterfall dispatch is synchronous up to the overlay push — cordis
      // never inserts a microtask before calling the first listener — so the
      // overlay is already mounted here; no wait needed.
      expect(bells).toBe(1)
      ctx.tuiSlots.activeOverlay?.handleKey({ kind: 'key', name: 'enter' })
      await expect(answer).resolves.toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
      expect(ctx.tuiSlots.activeOverlay).toBeUndefined()
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('carries a real multiSelect request and its custom supplement through the real service', async () => {
    const ctx = new Context()
    await ctx.plugin(TuiSlots)
    await ctx.plugin(UserQuestionService)
    const dispose = installQuestionProvider(ctx, () => {})
    try {
      const answer = ctx.userQuestions.ask({
        questions: [{
          id: 'stack',
          question: 'Which layers?',
          multiSelect: true,
          options: [{ label: 'web' }, { label: 'api' }],
        }],
      })
      const shown = (): string => stripAnsi(ctx.tuiSlots.activeOverlay?.render(80).join('\n') ?? '')
      expect(shown()).toContain('[ ] web')
      ctx.tuiSlots.activeOverlay?.handleKey({ kind: 'text', text: ' ' })
      ctx.tuiSlots.activeOverlay?.handleKey({ kind: 'key', name: 'end' })
      ctx.tuiSlots.activeOverlay?.handleKey({ kind: 'key', name: 'enter' })
      expect(shown()).toContain('kept alongside the selections')
      ctx.tuiSlots.activeOverlay?.handleKey({ kind: 'text', text: 'cli too' })
      ctx.tuiSlots.activeOverlay?.handleKey({ kind: 'key', name: 'enter' })
      // The committed supplement lands on the waiting list one microtask later.
      await vi.waitFor(() => { expect(shown()).toContain('Other…: cli too') })
      ctx.tuiSlots.activeOverlay?.handleKey({ kind: 'key', name: 'up' })
      ctx.tuiSlots.activeOverlay?.handleKey({ kind: 'key', name: 'enter' })
      await expect(answer).resolves.toEqual({
        answers: [{ id: 'stack', selected: ['web'], custom: 'cli too' }],
      })
      expect(ctx.tuiSlots.activeOverlay).toBeUndefined()
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects a withdrawn real Harness request as ASK_ABORTED', async () => {
    const ctx = new Context()
    await ctx.plugin(TuiSlots)
    await ctx.plugin(UserQuestionService)
    let bells = 0
    const dispose = installQuestionProvider(ctx, () => { bells += 1 })
    try {
      const controller = new AbortController()
      const answer = ctx.userQuestions.ask({
        questions: [{ id: 'confirm', question: 'Proceed?' }],
        signal: controller.signal,
      })
      expect(bells).toBe(1)
      expect(ctx.tuiSlots.activeOverlay).toBeDefined()
      controller.abort()
      await expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
      expect(ctx.tuiSlots.activeOverlay).toBeUndefined()
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('disposes cleanly: no answerer remains registered afterward', async () => {
    const ctx = new Context()
    await ctx.plugin(TuiSlots)
    await ctx.plugin(UserQuestionService)
    const dispose = installQuestionProvider(ctx, () => {})
    dispose()
    dispose() // idempotent, matching Harness's own HMR-safe disposal contract
    try {
      await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
        .rejects.toMatchObject({ code: 'NO_PROVIDER' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
