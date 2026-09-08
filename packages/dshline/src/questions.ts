/**
 * The `ask_user_question` answerer.
 *
 * The service validates the request before it arrives (aborted signals, empty
 * question lists, a `plan-review` intent naming a real option, caller
 * liveness), so this answerer only renders, collects, and honours the signal.
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
import { createPlanReviewOverlay } from './plan-review.ts'
import { promptMultiSelect, promptSelect, type SelectChoice } from './select.ts'
import { promptText } from './prompt.ts'

/** Offered when a question carries no options of its own. */
const ACKNOWLEDGE = [{ value: 'ok', label: 'OK' }] as const

/**
 * The value of the appended row that opens a free-text answer instead of
 * confirming an offered option. The control character makes a collision with a
 * model-supplied option label impossible in practice; the label is what the
 * reader sees, and the value is never displayed.
 */
const OTHER_VALUE = '\u0000dshline-other'

/** The row appended to an option list that accepts typed text. */
const OTHER_CHOICE: SelectChoice = { value: OTHER_VALUE, label: 'Other\u2026' }

/** Greyed text in the free-text field an `Other…` row opens. */
const OTHER_PLACEHOLDER = 'Type an answer, or esc to go back'

/**
 * The offered options as picker rows, plus the free-text row: the answer
 * contract lets a custom answer accompany or replace a selection, and without
 * the row a terminal reader could never produce one.
 * @param item - the question being asked.
 * @returns the picker rows.
 */
function choicesOf(item: AskUserQuestionItem): SelectChoice[] {
  const offered = (item.options ?? []).map(option => ({
    value: option.label,
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }))
  return [...offered, OTHER_CHOICE]
}

/**
 * The overlay headline: the short heading when the question carries one.
 * @param item - the question being asked.
 * @returns the headline text.
 */
function titleOf(item: AskUserQuestionItem): string {
  return item.header === undefined ? item.question : `${item.header}: ${item.question}`
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
      choices: choices.length > 0 ? choices : ACKNOWLEDGE,
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
 * Collect free text through the shared bounded prompt. Dismissing the field
 * (esc) returns to whatever opened it rather than answering, so a reader who
 * opened `Other…` by mistake loses nothing but a keystroke.
 * @param ctx - the plugin context owning the overlay.
 * @param item - the question the text answers.
 * @param signal - abort signal for the calling tool.
 * @returns the trimmed answer, or undefined when the field was dismissed or
 *   left empty.
 */
async function askCustom(
  ctx: Context,
  item: AskUserQuestionItem,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const text = await promptText(ctx, {
    title: titleOf(item),
    view: 'Question',
    message: item.question,
    ...item.detail === undefined ? {} : { detail: item.detail },
    kind: 'text',
    placeholder: OTHER_PLACEHOLDER,
    ...signal === undefined ? {} : { signal },
  })
  if (aborted(signal)) throw abortedQuestion()
  const trimmed = text?.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Ask one multi-select question, resolving once the user confirms or cancels.
 *
 * The checked labels and a custom answer are independent halves of the answer
 * here: confirming `Other…` opens the text field and a typed answer accompanies
 * whatever else was checked, which is exactly the encoding the contract's
 * `selected` + `custom` pair defines for a multi-select.
 * @param ctx - the plugin context owning the overlay.
 * @param item - the question to ask; `multiSelect` is why this path exists.
 * @param signal - abort signal for the calling tool.
 * @returns the answer for this question.
 */
async function askMulti(
  ctx: Context,
  item: AskUserQuestionItem,
  signal: AbortSignal | undefined,
): Promise<AskUserQuestionAnswerItem> {
  let checked: string[] = []
  for (;;) {
    const picked = await promptMultiSelect(ctx, {
      title: titleOf(item),
      view: 'Question',
      ...item.detail === undefined ? {} : { detail: item.detail },
      choices: choicesOf(item),
      ...checked.length === 0 ? {} : { initialChecked: checked },
      ...signal === undefined ? {} : { signal },
    })
    // A withdrawal and an explicit cancel both answer nothing: the calling
    // tool sees an empty selection either way, as with the single-select.
    if (aborted(signal)) throw abortedQuestion()
    if (picked === undefined) return { id: item.id, selected: [] }
    if (!picked.includes(OTHER_VALUE)) return { id: item.id, selected: picked }
    // Keep what was checked so a dismissed text field reopens the list with
    // the reader's work still on it.
    checked = picked.filter(value => value !== OTHER_VALUE)
    const custom = await askCustom(ctx, item, signal)
    if (custom !== undefined) return { id: item.id, selected: checked, custom }
  }
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
  if (item.multiSelect === true) return askMulti(ctx, item, signal)
  if ((item.options ?? []).length === 0) {
    // An optionless question is acknowledged by enter, as it always was, and a
    // typed answer becomes the contract's free text — the two shapes the
    // `ask_user_question` caller can mean by asking without options.
    const custom = await askCustom(ctx, item, signal)
    return custom === undefined
      ? { id: item.id, selected: [ACKNOWLEDGE[0].value] }
      : { id: item.id, selected: [], custom }
  }
  for (;;) {
    const selected = await promptSelect(ctx, {
      title: titleOf(item),
      view: 'Question',
      ...item.detail === undefined ? {} : { detail: item.detail },
      choices: choicesOf(item),
      ...signal === undefined ? {} : { signal },
    })
    if (aborted(signal)) throw abortedQuestion()
    if (selected === OTHER_VALUE) {
      // A custom answer REPLACES the selection in single-select: the caller
      // reads one or the other, which is the encoding the web client uses.
      const custom = await askCustom(ctx, item, signal)
      if (custom !== undefined) return { id: item.id, selected: [], custom }
      continue
    }
    // `promptSelect` correctly removes a withdrawn overlay, but its `undefined`
    // result also represents an explicit reader dismissal. Harness keeps those
    // outcomes distinct at this answerer boundary.
    if (aborted(signal)) throw abortedQuestion()
    // Cancelling answers nothing rather than inventing a choice: the calling tool
    // sees an empty selection and decides what an unanswered question means.
    return { id: item.id, selected: selected === undefined ? [] : [selected] }
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
