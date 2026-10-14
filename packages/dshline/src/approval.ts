/**
 * The approval answerer.
 *
 * `ctx.approval` is a waterfall with many possible answerers, so this listener
 * claims only requests for the agent this frontend owns and delegates the rest
 * with `next()` — returning without calling it would silently deny every other
 * agent's approvals, including a subagent's.
 *
 * The abort check is synchronous and deliberate: dispatch rides a microtask, so
 * an abort landing in that window would leave a prompt on screen for a request
 * that has already settled `'cancelled'`, and nothing would ever dismiss it.
 * @module dshline/approval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { createSelectOverlay } from './select.ts'

/** Outcomes this frontend can produce, in the order they are offered. */
const CHOICES = [
  { value: 'allowed-once', label: 'Allow once', description: 'Run this call and ask again next time.' },
  { value: 'rejected', label: 'Reject', description: 'Refuse this call and tell the model why it stopped.' },
] as const

/**
 * Answer approval requests for `owned` by prompting in the live region.
 * @param ctx - the plugin context owning the listener effect.
 * @param owned - the agent whose requests this frontend answers.
 * @param bell - emits terminal BEL after this frontend presents an approval.
 * @returns the disposer removing the listener.
 */
export function installApprovalAnswerer(
  ctx: Context,
  owned: () => Agent | undefined,
  bell: () => void,
): () => void {
  return ctx.on('approval/request', async (request, next) => {
    if (request.agent !== owned()) return next()
    if (request.signal?.aborted === true) return 'cancelled'
    return new Promise<ApprovalOutcome>(resolve => {
      let dismiss = (): void => {}
      let answered = false
      // Named so settlement can detach it. `request.signal` belongs to whatever
      // asked for approval and may outlive this one question, so an anonymous
      // once-only listener accumulates on it. `once` stops it firing twice, not
      // accumulating.
      const withdraw = (): void => { settled('cancelled') }
      const settled = (outcome: ApprovalOutcome): void => {
        // Once-only, so a keypress and a withdrawal racing cannot dismiss the
        // overlay twice or answer the same request twice.
        if (answered) return
        answered = true
        request.signal?.removeEventListener('abort', withdraw)
        dismiss()
        resolve(outcome)
      }
      const reason = request.reason === undefined ? '' : `\n${request.reason}`
      const overlay = createSelectOverlay({
        title: `Allow ${request.toolName}?`,
        view: 'Approval',
        detail: `The agent needs approval to run this tool.${reason}`,
        choices: CHOICES,
        invalidate: () => { ctx.tuiSlots.invalidate() },
        settle: value => { settled(value === 'allowed-once' ? 'allowed-once' : 'rejected') },
      })
      dismiss = ctx.tuiSlots.pushOverlay(overlay)
      bell()
      // A withdrawn request must take its prompt down even though no key was
      // pressed, or the user is left answering a question nobody is waiting on.
      request.signal?.addEventListener('abort', withdraw, { once: true })
    })
  })
}
