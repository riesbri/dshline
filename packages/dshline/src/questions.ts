/**
 * The `ask_user_question` answerer.
 *
 * The service validates the request before it arrives (aborted signals, empty
 * question lists, a `plan-review` intent naming a real option, caller
 * liveness), so this answerer only renders, collects, and honours the signal.
 *
 * Presentation follows the pinned Harness answer contract exactly: a question
 * with options is a picker (single- or multi-select per `multiSelect`), and
 * every question also admits a free-text `custom` answer — for a single-select
 * question it replaces the selected option, for a multi-select one it
 * supplements the selected labels, and a question with no options can only be
 * answered with it. All three encodings come from the Harness types; nothing
 * here invents a protocol.
 *
 * dshline is one concrete terminal answerer on Harness's scoped
 * `user-questions/request` waterfall: when a request reaches it and its active
 * terminal surface can present that request, it claims the request by
 * returning the structured answer. It never calls `next()` — not because no
 * other answerer could exist, but because the terminal it presents through is
 * always available to answer whatever reaches it. The waterfall's own contract
 * is exactly that: "return an answer to claim the request or call `next()` to
 * delegate", and an unclaimed request bottoms out in the service's
 * `NO_PROVIDER` failure.
 * @module dshline/questions
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionRequestEvent,
} from '@deepseek-ai/dsh-user-questions/types'
// The error class is a value, so it comes from the service entry point;
// importing from there also carries the `ctx.userQuestions` Context merge and
// the `user-questions/request` waterfall declaration this module registers on.
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { otherDisplay, promptMultiSelect } from './multiselect.ts'
import { createPlanReviewOverlay } from './plan-review.ts'
import { promptText } from './prompt.ts'
import { promptSelect } from './select.ts'

/**
 * Offered when a plan-review question carries no options of its own. The
 * service rejects such a request before dispatch, so this is a direct-caller
 * backstop only; generic questions no longer need it, because an option-less
 * question is answered in free text.
 */
const PLAN_REVIEW_ACKNOWLEDGE = [{ value: 'ok', label: 'OK' }] as const

/**
 * A `promptSelect` value reserved for the Other… row.
 * @param offered - every label the question itself offers.
 * @returns a value no offered label can collide with, so a Harness option can
 *   never be mistaken for the custom-answer route.
 */
function otherValue(offered: readonly string[]): string {
  let sentinel = '\u0000other'
  while (offered.includes(sentinel)) sentinel += '\u0000'
  return sentinel
}

/** Whether a borrowed request signal has already been withdrawn. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Harness's distinct outcome when its caller withdraws a question request. */
function abortedQuestion(): UserQuestionError {
  return new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
}

/**
 * The headline every presentation of one question shares.
 * @param item - the question being presented.
 * @returns the header-prefixed question, or the question alone.
 */
function questionTitle(item: AskUserQuestionItem): string {
  return item.header === undefined ? item.question : `${item.header}: ${item.question}`
}

/** The editor prompt behind an Other… row, shared by both option flows. */
const OTHER_EDITOR_MESSAGE = 'Type your own answer'

/**
 * Ask for a completed plan's approval, keeping cancellation distinct from a
 * declined choice. The plan-mode tool uses that distinction to tell the model a
 * person dismissed the review to speak, rather than asking it to revise.
 * @param ctx - the plugin context owning the overlay.
 * @param item - the plan-review question and its markdown detail.
 * @param signal - abort signal for the calling tool.
 * @returns the selected option label.
 */
function askPlanReview(ctx: Context, item: AskUserQuestionItem, signal: AbortSignal | undefined): Promise<string> {
  const choices = (item.options ?? []).map(option => ({
    value: option.label,
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }))
  return new Promise<string>((resolve, reject) => {
    let dismiss = (): void => {}
    let settled = false
    const finish = (value: string | undefined, error: UserQuestionError | undefined): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      dismiss()
      if (error !== undefined) reject(error)
      else resolve(value ?? '')
    }
    const abort = (): void => {
      finish(undefined, abortedQuestion())
    }
    const overlay = createPlanReviewOverlay({
      plan: item.detail ?? '',
      question: item.question,
      choices: choices.length > 0 ? choices : PLAN_REVIEW_ACKNOWLEDGE,
      invalidate: () => { ctx.tuiSlots.invalidate() },
      settle: value => {
        finish(value, value === undefined
          ? new UserQuestionError('The user dismissed the plan review to speak instead.', 'ASK_CANCELLED')
          : undefined)
      },
    })
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
    if (signal?.aborted === true) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Ask one question, resolving once the user answers or cancels.
 * @param ctx - the plugin context owning the overlay.
 * @param item - the question to ask.
 * @param signal - abort signal for the calling tool.
 * @returns the answer for this question.
 */
async function askOne(
  ctx: Context,
  item: AskUserQuestionItem,
  signal: AbortSignal | undefined,
): Promise<AskUserQuestionAnswerItem> {
  if (item.intent?.kind === 'plan-review' && item.detail !== undefined) {
    return { id: item.id, selected: [await askPlanReview(ctx, item, signal)] }
  }
  const answer = (item.options ?? []).length > 0
    ? item.multiSelect === true
      ? await askMultiSelect(ctx, item, signal)
      : await askSingleSelect(ctx, item, signal)
    : await askFreeText(ctx, item, signal)
  // Harness keeps caller withdrawal and reader dismissal distinct at this
  // boundary: a withdrawn signal is an error, while a reader who dismissed the
  // overlay answered nothing rather than inventing a choice — the calling tool
  // sees an empty selection and decides what an unanswered question means.
  if (aborted(signal)) throw abortedQuestion()
  return answer ?? { id: item.id, selected: [] }
}

/**
 * Ask a question that offers no options.
 *
 * Harness's answer contract carries a free-text `custom` answer, and with no
 * labels to select it is the only thing the contract can hold — so no
 * stand-in Acknowledge choice is invented for the reader to click past.
 * Enter on an empty field answers nothing and asks again.
 * @param ctx - the plugin context owning the overlay.
 * @param item - the question to ask.
 * @param signal - abort signal for the calling tool.
 * @returns the answer, or undefined when the reader dismissed the question.
 */
async function askFreeText(
  ctx: Context,
  item: AskUserQuestionItem,
  signal: AbortSignal | undefined,
): Promise<AskUserQuestionAnswerItem | undefined> {
  for (;;) {
    // The shared title already carries the question, so the field's message
    // row would only repeat it; the field itself is the answer surface.
    const typed = await promptText(ctx, {
      title: questionTitle(item),
      view: 'Question',
      message: '',
      ...item.detail === undefined ? {} : { detail: item.detail },
      kind: 'text',
      ...signal === undefined ? {} : { signal },
    })
    if (aborted(signal)) throw abortedQuestion()
    if (typed === undefined) return undefined
    if (typed.trim() !== '') return { id: item.id, selected: [], custom: typed }
  }
}

/**
 * Ask a single-select question: pick an offered option, or answer in free text.
 *
 * The Other… route is one more picker row, not a second question surface;
 * backing out of its editor (or committing nothing) returns to the list, so a
 * dismissed editor never reads as a dismissed question.
 * @param ctx - the plugin context owning the overlay.
 * @param item - the question to ask.
 * @param signal - abort signal for the calling tool.
 * @returns the answer, or undefined when the reader dismissed the question.
 */
async function askSingleSelect(
  ctx: Context,
  item: AskUserQuestionItem,
  signal: AbortSignal | undefined,
): Promise<AskUserQuestionAnswerItem | undefined> {
  const choices = (item.options ?? []).map(option => ({
    value: option.label,
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }))
  const other = otherValue(choices.map(choice => choice.value))
  // The route's display label names itself out of the way of any offered
  // option, so a question may offer `Other…` itself and the two rows still
  // read apart; routing stays on the private sentinel value either way.
  const offer = [...choices, { value: other, label: otherDisplay(choices.map(choice => choice.label)) }]
  let initial: string | undefined
  for (;;) {
    const picked = await promptSelect(ctx, {
      title: questionTitle(item),
      view: 'Question',
      ...item.detail === undefined ? {} : { detail: item.detail },
      choices: offer,
      ...initial === undefined ? {} : { initialValue: initial },
      ...signal === undefined ? {} : { signal },
    })
    if (aborted(signal)) throw abortedQuestion()
    if (picked === undefined) return undefined
    // A custom answer REPLACES the selection: Harness's contract keeps the
    // two encodings apart, so `selected` stays empty beside it.
    if (picked !== other) return { id: item.id, selected: [picked] }
    const typed = await promptText(ctx, {
      title: questionTitle(item),
      view: 'Question',
      message: OTHER_EDITOR_MESSAGE,
      kind: 'text',
      ...signal === undefined ? {} : { signal },
    })
    if (aborted(signal)) throw abortedQuestion()
    if (typed !== undefined && typed.trim() !== '') {
      return { id: item.id, selected: [], custom: typed }
    }
    // Not an answer yet: the list comes back with the cursor on the row that
    // led here, and the next escape dismisses the question itself.
    initial = other
  }
}

/**
 * Ask a multi-select question: flip any number of offered options, optionally
 * supplementing them with free text.
 * @param ctx - the plugin context owning the overlay.
 * @param item - the question to ask.
 * @param signal - abort signal for the calling tool.
 * @returns the answer, or undefined when the reader dismissed the question.
 */
async function askMultiSelect(
  ctx: Context,
  item: AskUserQuestionItem,
  signal: AbortSignal | undefined,
): Promise<AskUserQuestionAnswerItem | undefined> {
  const choices = (item.options ?? []).map(option => ({
    value: option.label,
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }))
  const answer = await promptMultiSelect(ctx, {
    title: questionTitle(item),
    view: 'Question',
    ...item.detail === undefined ? {} : { detail: item.detail },
    choices,
    editCustom: current => promptText(ctx, {
      title: questionTitle(item),
      view: 'Question',
      // The supplement semantics are the one thing this editor must say:
      // unlike the single-select route, the text is kept BESIDE the selections.
      message: `${OTHER_EDITOR_MESSAGE}, kept alongside the selections`,
      ...current === '' ? {} : { initial: current },
      kind: 'text',
      ...signal === undefined ? {} : { signal },
    }),
    ...signal === undefined ? {} : { signal },
  })
  if (aborted(signal)) throw abortedQuestion()
  if (answer === undefined) return undefined
  return {
    id: item.id,
    selected: [...answer.selected],
    ...answer.custom === undefined ? {} : { custom: answer.custom },
  }
}

/**
 * Answer one request: every question in order, honouring the signal.
 * @param ctx - the plugin context owning the overlay.
 * @param request - the pending question batch.
 * @param bell - emits terminal BEL once this frontend accepts the batch.
 * @returns the structured answer.
 */
async function answerRequest(
  ctx: Context,
  request: AskUserQuestionRequestEvent,
  bell: () => void,
): Promise<AskUserQuestionAnswer> {
  const answers: AskUserQuestionAnswerItem[] = []
  // The service rejects either case before dispatch. Keeping this guard makes a
  // direct caller equally quiet, rather than announcing a request no UI will show.
  if (aborted(request.signal) || request.questions.length === 0) return { answers }
  // One request can contain several sequential overlays, but accepting this
  // batch is one attention event. The first overlay is pushed synchronously by
  // askOne before its promise yields.
  bell()
  // Questions are asked one at a time and in order: the overlay stack shows
  // only its top, so rendering several at once would hide all but the last.
  for (const item of request.questions) {
    if (aborted(request.signal)) throw abortedQuestion()
    answers.push(await askOne(ctx, item, request.signal))
  }
  return { answers }
}

/**
 * Register this frontend as a user-questions answerer.
 *
 * Straight onto the scoped waterfall Harness publishes, with no `next()`: this
 * answerer's terminal is always able to present whatever reaches it, so every
 * request it sees is one it claims.
 * @param ctx - the plugin context owning the registration.
 * @param bell - emits terminal BEL when this answerer accepts a request.
 * @returns the disposer unregistering the answerer.
 */
export function installQuestionProvider(ctx: Context, bell: () => void): () => void {
  return ctx.on('user-questions/request', request => answerRequest(ctx, request, bell))
}
