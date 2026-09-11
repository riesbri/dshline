/**
 * The one Dshline adapter for human-authored subagent messages.
 *
 * A human terminal follow-up must go through Harness's browser/human prompt
 * operation, `ctx.subagents.prompt`. That operation is not the same contract as
 * `SubagentRuntime.sendMessage`: `sendMessage` takes an exact live `Agent`
 * sender and stamps `agent-message` provenance, so calling it here would
 * impersonate the parent Agent and record the human's words as the model's.
 * `prompt` instead carries a durable parent/child address, a client-minted
 * request identity, human `kind: 'user'` provenance, the Queue versus Steer
 * choice, cold materialization, and the accepted `MessageId` receipt.
 *
 * This module builds exactly that request and maps its failure honestly. It
 * owns no scheduling, authorization, or lifecycle: Harness accepts, rejects,
 * cold-resumes, and schedules, and Dshline only reports which happened.
 * @module dshline/subagents/control
 */

import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import type { HumanSubagentSeam } from './seam.ts'

/**
 * Which Harness scheduling a human message asks for.
 *
 * `queue` is an ordinary later turn; `steer` targets the nearest step and, for
 * an idle or freshly cold-resumed child, starts a turn exactly as `queue`
 * would. Both are Harness's own accepted values, and neither is inferred from
 * anything Dshline observed about the child.
 */
export type HumanPromptDelivery = 'queue' | 'steer'

/** The outcome of asking Harness to accept one human follow-up. */
export type SubagentPromptOutcome =
  /** Harness's child inbox accepted the message and returned its identity. */
  | { readonly kind: 'accepted'; readonly messageId: string }
  /** No human prompt operation is mounted in this profile. */
  | { readonly kind: 'unavailable' }
  /** Harness refused; the message is its own typed refusal. */
  | { readonly kind: 'failed'; readonly message: string }

/** One human follow-up addressed to a durable direct child. */
export interface HumanPromptInput {
  /** The attached session, which is the durable direct parent Harness authorizes. */
  readonly parentSessionId: SessionId
  /** The durable direct child the message is addressed to. */
  readonly childId: SessionId
  /** The typed message body. Text-only for this PR. */
  readonly text: string
  /** Harness's Queue or Steer scheduling. */
  readonly delivery: HumanPromptDelivery
}

/**
 * Deliver one human message through Harness's human prompt authority.
 *
 * The request identity is minted here because Harness persists it on the
 * accepted message and treats it as caller-owned; a fresh id per submission is
 * what makes an accepted receipt attributable to this exact keystroke.
 * @param seam - the human-authoritative subagent operations, or undefined without one.
 * @param input - the durable address, delivery, and message text.
 * @param signal - caller cancellation, owning the call only until inbox acceptance.
 * @returns the accepted receipt, the capability absence, or Harness's refusal.
 */
export async function deliverHumanPrompt(
  seam: HumanSubagentSeam | undefined,
  input: HumanPromptInput,
  signal: AbortSignal,
): Promise<SubagentPromptOutcome> {
  if (seam === undefined) return { kind: 'unavailable' }
  try {
    const receipt = await seam.prompt({
      requestId: randomUUID() as SubagentPromptRequestId,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childId,
      mode: 'continuable',
      delivery: input.delivery,
      content: [{ type: 'text', text: input.text }],
    }, signal)
    return { kind: 'accepted', messageId: String(receipt.messageId) }
  } catch (error: unknown) {
    return { kind: 'failed', message: humanReason(error) }
  }
}

/**
 * A short, safe account of a refused prompt.
 *
 * Harness's typed refusal code is kept when the error carries one, because
 * `subagent/not-resumable` and `subagent/unauthorized` are actionable
 * different facts; the message itself is untrusted text the composer escapes
 * before drawing.
 * @param error - the thrown value.
 * @returns a one-line reason.
 */
function humanReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code !== '' ? `${code}: ${error.message}` : error.message
}
