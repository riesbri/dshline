/**
 * Running one Harness authorization flow in a terminal.
 *
 * This module implements nothing about any provider's login. Harness's
 * authorization seam owns the protocol and hands a surface exactly two things
 * to render — a notice, which is one-way and may carry a page and a code, and a
 * prompt, which is `text`, `secret`, or `select`. That vocabulary is
 * deliberately smaller than any one provider's, so a surface that renders one
 * flow renders all of them: OAuth, device code, and a key typed into a
 * provider library's own prompt arrive here as the same three shapes.
 *
 * Where each half goes is the terminal-specific decision:
 *
 * - A **notice** is committed to native scrollback. A sign-in URL and a device
 *   code are the two things a person most needs to select and copy, and this
 *   frontend's whole premise is that finished rows belong to the terminal's own
 *   buffer rather than to a redrawn region that will scroll them away.
 * - A **prompt** is a bounded overlay, because it takes the keyboard.
 *
 * Cancelling is done by aborting the attempt's signal rather than by rejecting
 * with the seam's decline error, which this package cannot import. The seam
 * treats a withdrawn attempt and a declined prompt as the same outcome —
 * `cancelled`, not a failure — so the observable result is identical.
 * @module dshline/connect/authorize
 */

import type { Context } from '@deepseek-ai/cordis'
import { BOX_CHROME_COLUMNS, escapeControls, paint, truncateToWidth } from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import { promptSelect } from '../select.ts'
import { promptText } from '../prompt.ts'
import type { TuiOverlay } from '../slots.ts'
import type {
  AuthorizationNoticeRead,
  AuthorizationPromptRead,
  ConnectAuthorization,
} from './harness.ts'
import type { ConnectActionOutcome } from './actions.ts'
import { messageOf } from './catalog.ts'

/** What running one flow needs from its owner. */
export interface AuthorizeSpec {
  /** Context carrying the slot registry, for the prompt overlays. */
  readonly ctx: Context
  /** The authorization seam. */
  readonly authorization: ConnectAuthorization
  /** The credential record to authorize. */
  readonly key: string
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** Which of the flow's methods to run; omitted takes the flow's first. */
  readonly method?: string
  /**
   * Withdraws the attempt from outside.
   *
   * The browser that started a sign-in owns this: an OAuth flow can sit waiting
   * on a browser callback with no prompt on screen, so closing Connect has to
   * take the attempt down through the seam's own lifecycle rather than walking
   * away from it and letting a prompt or a notice arrive over whatever the
   * reader is looking at next.
   */
  readonly signal?: AbortSignal
  /** Write finished rows into the terminal's own scrollback. */
  readonly commit: (lines: readonly string[]) => void
}

/**
 * Rows one notice becomes in the transcript.
 *
 * The page and the code are given lines of their own, unindented past a short
 * gutter, because a reader is about to select them with the mouse: burying a
 * URL inside a sentence makes a double-click take the sentence with it.
 * @param notice - what the flow reported.
 * @param label - what is being authorized.
 * @returns the lines to commit.
 */
export function noticeLines(notice: AuthorizationNoticeRead, label: string): string[] {
  // The label is a flow's own name for what it authorizes, so it is untrusted
  // for the same reason the message is, and is escaped before any styling.
  const lines = [paint(`· ${escapeControls(label)}: ${escapeControls(notice.message)}`, 'muted')]
  // Untrusted: a URL and a code come from a provider's own login response, so
  // both are escaped before any styling is applied, never after.
  if (notice.url !== undefined && notice.url !== '') {
    lines.push(`  ${paint(escapeControls(notice.url), 'link')}`)
  }
  if (notice.code !== undefined && notice.code !== '') {
    lines.push(`  ${paint(`code ${escapeControls(notice.code)}`, 'strong')}`)
  }
  return lines
}

/** Leading blank, four body rows, and two frame borders. */
const WAITING_MIN_ROWS = 7

/**
 * The attempt-owned surface shown while authorization needs no human answer.
 *
 * A prompt pushed by {@link render} sits above this overlay and dismisses back
 * to it, so an OAuth callback wait never exposes the Connect browser as though
 * its action had completed.
 * @param label - the flow's user-facing name.
 * @param withdraw - cancels the attempt when the reader leaves this surface.
 * @param invalidate - asks the window to redraw.
 * @returns the waiting overlay.
 */
function waitingOverlay(label: string, withdraw: () => void, invalidate: () => void): TuiOverlay {
  return {
    render(columns, terminalRows = 24) {
      const title = `Sign in · ${label}`
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      if (terminalRows < WAITING_MIN_ROWS || width >= columns) {
        return [paint(truncateToWidth('◌ Waiting for authorization… · esc cancel', Math.max(1, columns)), 'muted')]
          .slice(0, terminalRows)
      }
      return [
        '',
        ...rootFrame({
          columns,
          context: paint('Sign in', 'overlay-title'),
          body: [
            paint(truncateToWidth(escapeControls(title), inner), 'overlay-title'),
            '',
            paint(truncateToWidth('◌ Waiting for authorization…', inner), 'busy'),
            paint(truncateToWidth('The authorization flow is still in progress.', inner), 'muted'),
          ],
          footer: fitFooterHelp('esc cancel', footerBudget(columns)),
        }),
      ]
    },
    handleKey(key) {
      if (key.kind === 'key' && (key.name === 'escape' || key.name === 'ctrl-c')) withdraw()
      invalidate()
    },
  }
}

/**
 * Run one authorization flow and report how it ended.
 *
 * The attempt owns an `AbortController` this function holds: dismissing a
 * prompt aborts it, which withdraws the whole attempt through the seam's own
 * lifecycle rather than leaving a flow prompting into a closed overlay.
 * @param spec - the seam, the key, and where notices go.
 * @returns what Harness answered, worded for the transcript.
 */
export async function runAuthorization(spec: AuthorizeSpec): Promise<ConnectActionOutcome> {
  const { ctx, authorization, key, label, commit } = spec
  const controller = new AbortController()
  let dismissed = false
  // The owner's withdrawal and a dismissed prompt reach the seam the same way,
  // through this one signal, so a flow waiting on a browser callback with no
  // prompt on screen is still taken down when Connect closes.
  const owner = spec.signal
  // Read through a function, not a narrowed local: the guard below proves it is
  // unaborted NOW, and every later check is asking whether that has changed.
  const retiredByOwner = (): boolean => owner?.aborted === true
  if (retiredByOwner()) return retired(label)
  const unwatch = owner === undefined
    ? (): void => {}
    : ((): (() => void) => {
      const withdraw = (): void => { controller.abort() }
      owner.addEventListener('abort', withdraw, { once: true })
      return () => { owner.removeEventListener('abort', withdraw) }
    })()
  /**
   * Put one prompt to the reader, withdrawing the attempt when they dismiss it.
   * @param prompt - what the flow asked.
   * @returns the answer.
   * @throws when the reader dismissed the question, or the attempt is over.
   */
  const ask = async (prompt: AuthorizationPromptRead): Promise<string> => {
    // Nothing is mounted once the attempt is withdrawn. A flow that has not yet
    // observed its signal must not put a question on screen over whatever the
    // reader moved on to.
    if (controller.signal.aborted) throw new Error('the authorization attempt was withdrawn')
    const answer = await render(ctx, prompt, label, controller.signal)
    if (answer !== undefined) return answer
    // Three ways a prompt can come back unanswered, and only one of them is the
    // reader saying no. The attempt's signal means the owner withdrew, and the
    // prompt's own signal means the FLOW retired the losing half of a race it is
    // still running — treating either as a dismissal would misreport it.
    if (controller.signal.aborted) throw new Error('the authorization attempt was withdrawn')
    if (prompt.signal?.aborted === true) throw new Error('the authorization prompt was withdrawn')
    dismissed = true
    controller.abort()
    // The seam races this rejection against its own signal and settles the
    // attempt as `cancelled`; the message is only ever seen in a debug log.
    throw new Error('the authorization prompt was dismissed')
  }
  // An OAuth callback can take minutes without requesting terminal input. Keep
  // an attempt-owned overlay below any transient Harness prompt for that whole
  // interval, rather than revealing the Connect browser beneath it.
  const dismissWaiting = ctx.tuiSlots.pushOverlay(waitingOverlay(
    label,
    () => { controller.abort() },
    () => { ctx.tuiSlots.invalidate() },
  ))
  try {
    const outcome = await authorization.begin({
      key,
      ...spec.method === undefined ? {} : { method: spec.method },
      signal: controller.signal,
      interaction: {
        // A notice arriving after the withdrawal is dropped rather than
        // committed: the seam holds notices fire-and-forget precisely so a
        // surface that can no longer render one loses the notice, not the
        // attempt.
        notify: notice => {
          if (controller.signal.aborted) return
          commit(noticeLines(notice, label))
        },
        prompt: ask,
      },
    })
    if (retiredByOwner()) return retired(label)
    if (outcome.status === 'authorized') {
      // Just the fact this function is responsible for. Activating the route a
      // credential authenticates is a separate settings write with its own
      // authority and its own answer, and `connect/activation.ts` appends what
      // actually became of it — so a tail here saying routes "are activated
      // separately" would now either duplicate that or contradict it.
      return { kind: 'done', message: `${label}: signed in` }
    }
    return { kind: 'failed', message: dismissed ? `${label}: sign-in dismissed` : `${label}: sign-in cancelled` }
  } catch (error) {
    if (retiredByOwner()) return retired(label)
    return { kind: 'failed', message: `${label}: sign-in failed — ${messageOf(error)}` }
  } finally {
    dismissWaiting()
    unwatch()
  }
}

/**
 * What an attempt its owner withdrew reports.
 * @param label - what was being authorized.
 * @returns the outcome.
 */
function retired(label: string): ConnectActionOutcome {
  return { kind: 'failed', message: `${label}: sign-in withdrawn` }
}

/**
 * Show one prompt in the shape it asks for.
 *
 * `secret` differs from `text` only in presentation, which is exactly what the
 * seam says it means, so both reach the same overlay with one field changed.
 * @param ctx - context carrying the slot registry.
 * @param prompt - what the flow asked.
 * @param label - what is being authorized, for the overlay title.
 * @param attempt - the attempt's signal, so a withdrawal takes the overlay down.
 * @returns the answer, or undefined when the reader dismissed it or it was withdrawn.
 */
async function render(
  ctx: Context,
  prompt: AuthorizationPromptRead,
  label: string,
  attempt: AbortSignal,
): Promise<string | undefined> {
  const title = `Sign in · ${label}`
  // Either signal takes the overlay down: the flow retiring this one question,
  // or the owner retiring the whole attempt. Combining them here is what stops a
  // mounted prompt outliving the browser that raised it.
  const signal = prompt.signal === undefined ? attempt : AbortSignal.any([prompt.signal, attempt])
  const withdrawal = { signal }
  if (prompt.kind === 'select') {
    return promptSelect(ctx, {
      title,
      view: 'Sign in',
      ...withdrawal,
      detail: escapeControls(prompt.message),
      choices: prompt.options.map(option => ({
        value: option.id,
        label: option.label,
        ...option.description === undefined ? {} : { description: option.description },
      })),
    })
  }
  return promptText(ctx, {
    title,
    view: 'Sign in',
    ...withdrawal,
    message: prompt.message,
    kind: prompt.kind,
    ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
  })
}
