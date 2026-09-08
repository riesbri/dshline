/** The user-questions answerer: option pickers, free text, and plan review. */

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
 * A context just large enough to retain the questions answerer and its overlays.
 *
 * The registration is the real one: `ctx.on('user-questions/request', …)`, the
 * scoped waterfall Harness publishes. `ask()` is what the service's own
 * `ctx.waterfall(...)` would invoke. Overlays are kept as a STACK, not a single
 * slot: a question's Other… editor mounts on top of the list that raised it,
 * and only the topmost surface is on screen.
 * @returns the context plus readers for the answerer and the top overlay.
 */
function questionContext(): {
  ctx: Context
  ask(): Answerer | undefined
  send(request: AskUserQuestionRequestEvent): Promise<AskUserQuestionAnswer> | undefined
  overlay(): TuiOverlay | undefined
  events(): string[]
} {
  let answerer: Answerer | undefined
  const stack: TuiOverlay[] = []
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
        stack.push(next)
        return () => {
          const index = stack.indexOf(next)
          if (index >= 0) stack.splice(index, 1)
        }
      },
    },
  } as unknown as Context
  return {
    ctx,
    ask: () => answerer,
    // A `next` that fails loudly: this answerer is terminal, so reaching for
    // it is the regression, not a fallback.
    send: request => answerer?.(request, () => Promise.reject(new Error('delegated down the waterfall'))),
    overlay: () => stack.at(-1),
    events: () => events,
  }
}

/** The question every multi-select case below asks. */
const MULTI_QUESTION = {
  id: 'stack',
  question: 'Which layers?',
  multiSelect: true,
  options: [{ label: 'web' }, { label: 'api' }, { label: 'cli', description: 'command line' }],
} as const

/** The visible rows of whatever overlay is on top right now. */
function shown(overlay: TuiOverlay | undefined): string {
  return stripAnsi(overlay?.render(80).join('\n') ?? '')
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

describe('single-select questions', () => {
  it('offers an Other… route without offering it as an answer', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    expect(shown(overlay())).toContain('Other…')
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    // Confirming the ordinary option encodes only that option's label; the
    // Other… row itself is a route, never a value.
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: ['A'] }] })
  })

  it('takes a free-text answer through Other… as a replacement for the selection', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    // The picker settled before the editor mounted, so whatever is on top now
    // is the text field, not the list.
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    expect(shown(overlay())).toContain('Type your own answer')
    overlay()?.handleKey({ kind: 'text', text: 'Blue-ish' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: [], custom: 'Blue-ish' }] })
  })

  it('returns to the option list when the Other… editor is backed out, and the next escape dismisses', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(shown(overlay())).toContain('Type your own answer') })
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    // Backing out of the editor is not dismissing the question: the list comes
    // back, and dismissing IT is a second, separate escape.
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    const returned = shown(overlay())
    expect(returned).toContain('Pick')
    expect(returned).not.toContain('Type your own answer')
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
  })

  it('asks again when the Other… editor is committed empty, then accepts an ordinary option', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(shown(overlay())).toContain('Type your own answer') })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    // The re-presented list starts on the row that led here; one up, then
    // confirm, proves the loop still answers through the ordinary route.
    overlay()?.handleKey({ kind: 'key', name: 'up' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: ['B'] }] })
  })

  it('keeps a real Other… option selectable beside the renamed custom route', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'Other…' }] }],
    })
    // Harness reserves no label, so the offered option renders verbatim while
    // the route names itself out of its way: two rows, visibly not the same.
    // The frame's border columns come off each line before matching.
    const rows = shown(overlay()).split('\n').map(row => row.replaceAll('│', ' ').trim())
    expect(rows).toContain('Other…')
    expect(rows).toContain('Other… (free text)')
    overlay()?.handleKey({ kind: 'key', name: 'down' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: ['Other…'] }] })
  })

  it('routes the renamed custom row to the editor when a real option claims Other…', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'Other…' }] }],
    })
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(shown(overlay())).toContain('Type your own answer') })
    overlay()?.handleKey({ kind: 'text', text: 'off-menu' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: [], custom: 'off-menu' }] })
  })

  it('dismisses an unanswered picker without fabricating a selection', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
  })
})

describe('multi-select questions', () => {
  it('toggles several options and reports their labels in offer order', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({ questions: [MULTI_QUESTION] })
    expect(shown(overlay())).toContain('[ ] web')
    expect(shown(overlay())).toContain('[ ] api')
    expect(shown(overlay())).toContain('Other…')
    // The spacebar decodes as text, and it is the toggle.
    overlay()?.handleKey({ kind: 'text', text: ' ' })
    expect(shown(overlay())).toContain('[x] web')
    overlay()?.handleKey({ kind: 'key', name: 'down' })
    overlay()?.handleKey({ kind: 'key', name: 'down' })
    overlay()?.handleKey({ kind: 'text', text: ' ' })
    expect(shown(overlay())).toContain('[x] cli')
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'stack', selected: ['web', 'cli'] }] })
  })

  it('supplements the selections with custom text committed through Other…', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({ questions: [MULTI_QUESTION] })
    overlay()?.handleKey({ kind: 'text', text: ' ' })
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    // The editor mounts on top of the waiting list, which keeps its toggles.
    expect(shown(overlay())).toContain('kept alongside the selections')
    overlay()?.handleKey({ kind: 'text', text: 'embedded too' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(shown(overlay())).toContain('Other…: embedded too') })
    // The receipt row IS the finished answer: Enter confirms it in place, and
    // the footer says so instead of promising a toggle that cannot happen here.
    const receipt = shown(overlay())
    expect(receipt).toContain('tab edit')
    expect(receipt).toContain('enter confirm')
    expect(receipt).not.toContain('space toggle')
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({
      answers: [{ id: 'stack', selected: ['web'], custom: 'embedded too' }],
    })
  })

  it('confirms a custom-only answer from the Other… row without moving', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({ questions: [MULTI_QUESTION] })
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    expect(shown(overlay())).toContain('kept alongside the selections')
    overlay()?.handleKey({ kind: 'text', text: 'only this' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(shown(overlay())).toContain('Other…: only this') })
    // No ordinary option is touched, and none is needed to submit.
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({
      answers: [{ id: 'stack', selected: [], custom: 'only this' }],
    })
  })

  it('reopens the editor with the committed text, and a further commit replaces it', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({ questions: [MULTI_QUESTION] })
    overlay()?.handleKey({ kind: 'text', text: ' ' })
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    overlay()?.handleKey({ kind: 'text', text: 'first' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(shown(overlay())).toContain('Other…: first') })
    overlay()?.handleKey({ kind: 'key', name: 'tab' })
    // The editor alone is on top, so the visible 'first' is the field's
    // prefill, not the receipt row underneath.
    expect(shown(overlay())).toContain('kept alongside the selections')
    expect(shown(overlay())).toContain('first')
    overlay()?.handleKey({ kind: 'key', name: 'ctrl-u' })
    overlay()?.handleKey({ kind: 'text', text: 'round two' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(shown(overlay())).toContain('Other…: round two') })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({
      answers: [{ id: 'stack', selected: ['web'], custom: 'round two' }],
    })
  })

  it('states the true Enter behavior for the active row', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    send({ questions: [MULTI_QUESTION] })
    const onChoice = shown(overlay())
    expect(onChoice).toContain('space toggle')
    expect(onChoice).toContain('enter confirm')
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    const onRoute = shown(overlay())
    expect(onRoute).toContain('enter edit')
    expect(onRoute).not.toContain('space toggle')
  })

  it('answers a deliberate none with no labels and no custom text', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({ questions: [MULTI_QUESTION] })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'stack', selected: [] }] })
  })

  it('keeps a real Other… option checkable beside the renamed custom route', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{
        id: 'stack',
        question: 'Which layers?',
        multiSelect: true,
        options: [{ label: 'web' }, { label: 'Other…' }],
      }],
    })
    const rows = shown(overlay()).split('\n').map(row => row.replaceAll('│', ' ').trim())
    expect(rows).toContain('[ ] Other…')
    expect(rows).toContain('Other… (free text)')
    overlay()?.handleKey({ kind: 'key', name: 'down' })
    overlay()?.handleKey({ kind: 'text', text: ' ' })
    expect(shown(overlay())).toContain('[x] Other…')
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'stack', selected: ['Other…'] }] })
  })

  it('routes the renamed custom row to the editor when a real option claims Other…', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({
      questions: [{
        id: 'stack',
        question: 'Which layers?',
        multiSelect: true,
        options: [{ label: 'web' }, { label: 'Other…' }],
      }],
    })
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    expect(shown(overlay())).toContain('kept alongside the selections')
    overlay()?.handleKey({ kind: 'text', text: 'mine' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(shown(overlay())).toContain('Other… (free text): mine') })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({
      answers: [{ id: 'stack', selected: [], custom: 'mine' }],
    })
  })

  it('unregisters its withdrawal listener whenever the question settles', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    // A real signal, spied rather than mocked: settlement — confirmation or
    // dismissal alike — must end the prompt's stake in it.
    const confirmed = new AbortController()
    const confirmedRemovals = vi.spyOn(confirmed.signal, 'removeEventListener')
    const answer = send({ signal: confirmed.signal, questions: [MULTI_QUESTION] })
    overlay()?.handleKey({ kind: 'text', text: ' ' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'stack', selected: ['web'] }] })
    expect(confirmedRemovals).toHaveBeenCalledTimes(1)
    expect(confirmedRemovals).toHaveBeenCalledWith('abort', expect.any(Function))

    const dismissed = new AbortController()
    const dismissedRemovals = vi.spyOn(dismissed.signal, 'removeEventListener')
    const second = send({ signal: dismissed.signal, questions: [MULTI_QUESTION] })
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await expect(second).resolves.toEqual({ answers: [{ id: 'stack', selected: [] }] })
    expect(dismissedRemovals).toHaveBeenCalledTimes(1)
    expect(dismissedRemovals).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('dismisses without fabricating an answer', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({ questions: [MULTI_QUESTION] })
    overlay()?.handleKey({ kind: 'text', text: ' ' })
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    // The flip is discarded with the overlay; nothing checked, typed, or
    // offered is reported as the reader's answer.
    await expect(answer).resolves.toEqual({ answers: [{ id: 'stack', selected: [] }] })
  })
})

describe('option-less questions', () => {
  it('answers in free text, as the Harness answer contract permits', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({ questions: [{ id: 'q', question: 'Why?' }] })
    // No stand-in Acknowledge choice is offered: with no options, `custom` is
    // the only answer the contract can hold.
    expect(shown(overlay())).not.toContain('OK')
    overlay()?.handleKey({ kind: 'text', text: 'because' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: [], custom: 'because' }] })
  })

  it('asks again when the field is committed empty, and dismisses on escape', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const answer = send({ questions: [{ id: 'q', question: 'Why?' }] })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    overlay()?.handleKey({ kind: 'key', name: 'escape' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
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
        { id: 'second', question: 'Second?', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    })
    expect(bells).toBe(1)
    overlay()?.handleKey({ kind: 'text', text: 'done' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    // The remaining questions are deliberately sequential, but this request has
    // already claimed the single attention event for its whole batch.
    await vi.waitFor(() => { expect(overlay()).toBeDefined() })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toEqual({
      answers: [
        { id: 'first', selected: [], custom: 'done' },
        { id: 'second', selected: ['A'] },
      ],
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
    overlay()?.handleKey({ kind: 'text', text: 'done' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    // The first question has settled, but its async continuation has not begun
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

describe('withdrawal while a nested editor is open', () => {
  it('takes down the Other… editor and rejects when the calling tool is aborted', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const abort = new AbortController()
    const answer = send({
      signal: abort.signal,
      questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }] }],
    })
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    await vi.waitFor(() => { expect(shown(overlay())).toContain('Type your own answer') })
    abort.abort()
    await expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(overlay()).toBeUndefined()
  })

  it('unmounts both the multi-select and its editor when aborted mid-edit', async () => {
    const { ctx, send, overlay } = questionContext()
    installQuestionProvider(ctx, () => {})
    const abort = new AbortController()
    const answer = send({ signal: abort.signal, questions: [MULTI_QUESTION] })
    overlay()?.handleKey({ kind: 'key', name: 'end' })
    // The editor mounts synchronously on top of the still-mounted list, so an
    // abort here has TWO overlays to remove.
    overlay()?.handleKey({ kind: 'key', name: 'enter' })
    expect(shown(overlay())).toContain('kept alongside the selections')
    abort.abort()
    await expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
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
