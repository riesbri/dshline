/** Plan-review questions take their dedicated overlay instead of a generic detail picker. */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import { stripAnsi } from '@dshline/renderer'
import type { TuiOverlay } from '../src/slots.ts'
import { installQuestionProvider } from '../src/questions.ts'

/** One answerer as Harness's `user-questions/request` waterfall would call it. */
type Answerer = (
  request: AskUserQuestionRequestEvent,
  next: () => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer>

/**
 * A context just large enough to retain the questions answerer and its overlay.
 *
 * The registration is the real one: `ctx.on('user-questions/request', …)`, the
 * scoped waterfall Harness publishes. `ask()` is what the service's own
 * `ctx.waterfall(...)` would invoke.
 * @returns the context plus readers for the answerer and active overlay.
 */
function questionContext(): {
  ctx: Context
  ask(): Answerer | undefined
  send(request: AskUserQuestionRequestEvent): Promise<AskUserQuestionAnswer> | undefined
  overlay(): TuiOverlay | undefined
  events(): string[]
} {
  let answerer: Answerer | undefined
  let active: TuiOverlay | undefined
  const events: string[] = []
  const ctx = {
    on(event: string, listener: Answerer) {
      events.push(event)
      answerer = listener
      return () => { answerer = undefined }
    },
    tuiSlots: {
      invalidate: () => {},
      pushOverlay(next: TuiOverlay) {
        active = next
        return () => { active = undefined }
      },
    },
  } as unknown as Context
  return {
    ctx,
    ask: () => answerer,
    // A `next` that fails loudly: this answerer is terminal, so reaching for
    // it is the regression, not a fallback.
    send: request => answerer?.(request, () => Promise.reject(new Error('delegated down the waterfall'))),
    overlay: () => active,
    events: () => events,
  }
}

describe('the user-questions registration', () => {
  it('registers on the scoped waterfall Harness publishes, and unregisters on dispose', () => {
    const { ctx, ask, events } = questionContext()
    const dispose = installQuestionProvider(ctx, () => {})
    expect(events()).toEqual(['user-questions/request'])
    expect(ask()).toBeDefined()
    dispose()
    expect(ask()).toBeUndefined()
  })

  it('claims every request that reaches it rather than delegating down the waterfall', async () => {
    const { ctx, ask, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    let delegated = false
    // The waterfall hands every listener a `next`; a terminal answerer never
    // reaches for it, and an unclaimed request would bottom out in the
    // service's own `NO_PROVIDER` failure instead.
    const answer = ask()?.(
      { questions: [{ id: 'q', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] },
      () => { delegated = true; return Promise.resolve({ answers: [] }) },
    )
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: ['A'] }] })
    expect(delegated).toBe(false)
  })
})

describe('question attention', () => {
  it('rings once for a multi-question request before presenting its first overlay', async () => {
    const { ctx, send, overlay } = questionContext()
    let bells = 0
    installQuestionProvider(ctx, () => { bells += 1 })
    const answer = send({
      questions: [
        { id: 'first', question: 'First?' },
        { id: 'second', question: 'Second?' },
      ],
    })
    expect(bells).toBe(1)
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    // The remaining questions are deliberately sequential, but this request has
    // already claimed the single attention event for its whole batch.
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({
      answers: [{ id: 'first', selected: ['ok'] }, { id: 'second', selected: ['ok'] }],
    })
    expect(bells).toBe(1)
  })

  it('rejects the whole batch when its caller aborts between questions', async () => {
    const { ctx, send, overlay } = questionContext()
    let bells = 0
    installQuestionProvider(ctx, () => { bells += 1 })
    const abort = new AbortController()

    const answer = send({
      signal: abort.signal,
      questions: [
        { id: 'first', question: 'First?' },
        { id: 'second', question: 'Second?' },
      ],
    })
    expect(bells).toBe(1)
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    // The first picker has settled, but its async continuation has not begun
    // presenting the second. A caller withdrawal wins the whole request.
    abort.abort()
    await expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(bells).toBe(1)
    expect(overlay()).toBeUndefined()
  })

  it('does not ring for an already-aborted request', async () => {
    const { ctx, send, overlay } = questionContext()
    let bells = 0
    installQuestionProvider(ctx, () => { bells += 1 })

    await expect(send({ signal: AbortSignal.abort(), questions: [{ id: 'q', question: 'Pick?' }] }))
      .resolves.toEqual({ answers: [] })
    expect(bells).toBe(0)
    expect(overlay()).toBeUndefined()
  })

  it('keeps its one bell when a displayed question is later withdrawn', async () => {
    const { ctx, send, overlay } = questionContext()
    let bells = 0
    installQuestionProvider(ctx, () => { bells += 1 })
    const abort = new AbortController()

    const answer = send({ signal: abort.signal, questions: [{ id: 'q', question: 'Pick?' }] })
    expect(bells).toBe(1)
    expect(overlay()).toBeDefined()
    abort.abort()
    await expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(bells).toBe(1)
    expect(overlay()).toBeUndefined()
  })
})

describe('plan-review questions', () => {
  it('uses the scrollable plan presentation and preserves the ordinary answer protocol', async () => {
    const { ctx, ask, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    expect(ask()).toBeDefined()

    const answer = send({
      questions: [{
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode?',
        detail: '# Clear outcome\n\n- read every line',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    const shown = stripAnsi(overlay()?.render(80).join('\n') ?? '')
    expect(shown).toContain('Plan review')
    expect(shown).toContain('Clear outcome')
    expect(shown).toContain('• read every line')

    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
  })

  it('reports a dismissed plan as a cancellation, not a request to keep planning', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{
        id: 'plan-review',
        question: 'Approve this plan?',
        detail: '# Plan',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await expect(answer).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('dismisses the review and rejects when its calling tool is aborted', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const abort = new AbortController()
    const answer = send({
      signal: abort.signal,
      questions: [{
        id: 'plan-review',
        question: 'Approve this plan?',
        detail: '# Plan',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    abort.abort()
    await expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(overlay()).toBeUndefined()
  })
})


/**
 * Press keys in order onto the active overlay; `handleKey` takes exactly one.
 * @param overlay - the active overlay, when one is mounted.
 * @param keys - the keys to deliver.
 * @returns nothing.
 */
function press(overlay: TuiOverlay | undefined, ...keys: Parameters<TuiOverlay['handleKey']>): void {
  for (const k of keys) overlay?.handleKey(k)
}

describe('multi-select questions', () => {
  it('answers with every checked label in the offered order', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{
        id: 'q',
        question: 'Which facets?',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      }],
    })
    // Check C, then A: the answer still lists A before C.
    const view = overlay()
    press(view, { kind: 'key', name: 'down' }, { kind: 'key', name: 'down' }, { kind: 'text', text: ' ' })
    press(view, { kind: 'key', name: 'up' }, { kind: 'key', name: 'up' }, { kind: 'text', text: ' ' })
    press(view, { kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: ['A', 'C'] }] })
  })

  it('answers an empty confirmation with an empty selection', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{ id: 'q', question: 'Which?', multiSelect: true, options: [{ label: 'A' }] }],
    })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
  })

  it('pairs a custom answer with the checked labels when Other… confirms', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{
        id: 'q',
        question: 'Which facets?',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    })
    const view = overlay()
    press(view, { kind: 'text', text: ' ' }, key('down'), key('down'), { kind: 'text', text: ' ' }, { kind: 'key', name: 'enter' })
    // The checked A survived into the text overlay's question; the free-text
    // field is now the active overlay.
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    press(overlay(), { kind: 'text', text: 'something else' }, { kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({
      answers: [{ id: 'q', selected: ['A'], custom: 'something else' }],
    })
  })

  it('returns to the list with checks intact when the Other… field is dismissed', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{ id: 'q', question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
    })
    press(overlay(), key('down'), key('down'), { kind: 'text', text: ' ' }, { kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    // Dismissing the text field is not an answer; the list returns.
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
  })

  it('rejects with ASK_ABORTED when the request is withdrawn mid-overlay', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const abort = new AbortController()
    const answer = send({
      signal: abort.signal,
      questions: [{ id: 'q', question: 'Which?', multiSelect: true, options: [{ label: 'A' }] }],
    })
    abort.abort()
    await expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(overlay()).toBeUndefined()
  })
})

describe('custom answers on single-select questions', () => {
  it('replaces the selection when Other… is answered with text', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{ id: 'q', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    press(overlay(), key('down'), key('down'), { kind: 'text', text: ' ' }, { kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    press(overlay(), { kind: 'text', text: 'neither of those' }, { kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({
      answers: [{ id: 'q', selected: [], custom: 'neither of those' }],
    })
  })

  it('returns to the list when the Other… field is left empty', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{ id: 'q', question: 'Pick one', options: [{ label: 'A' }] }],
    })
    press(overlay(), key('down'), { kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    // Empty text returns to the list, where confirming A is an ordinary answer.
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: ['A'] }] })
  })
})

describe('optionless questions', () => {
  it('acknowledges on empty enter, exactly as the OK row used to', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({ questions: [{ id: 'q', question: 'Ready?' }] })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: ['ok'] }] })
  })

  it('turns typed text into the contract free-text answer', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({ questions: [{ id: 'q', question: 'What is missing?' }] })
    press(overlay(), { kind: 'text', text: 'the endpoint URL' }, { kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({
      answers: [{ id: 'q', selected: [], custom: 'the endpoint URL' }],
    })
  })
})

/**
 * One decoded key press.
 * @param name - the key.
 * @returns the key event.
 */
function key(name: Extract<import('@dshline/renderer').Key, { kind: 'key' }>['name']):
  import('@dshline/renderer').Key {
  return { kind: 'key', name }
}
