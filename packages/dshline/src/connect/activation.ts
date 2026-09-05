/**
 * The one step between a successful sign-in and a model: activating the route
 * that credential authenticates.
 *
 * Harness splits provider setup across two stores that never write to each
 * other, and both writes are necessary:
 *
 * ```
 * ctx.credentials   the RECORD an authorization flow commits  llm-pi-ai/openai
 * ctx.settings      the PROFILE that registers a route        llm-pi-ai.providers.openai
 * ```
 *
 * `dsh-llm-pi-ai` registers its flows "independent of the route set" — signing
 * in is what makes a route worth adding, so every installed catalog provider
 * offers a login before any profile names it — while its adapter registers
 * routes only for `[...profiles().keys()]`. The two are correct apart and add
 * up to one bad minute: a person signs into their account, the flow reports
 * success, and `/model` still says nothing is configured. Nothing was broken
 * and nothing said so.
 *
 * This module is the sentence that was missing, and deliberately not more than
 * that. It performs no write of its own — {@link activateRoute} does, through
 * `ctx.settings.mutate`, exactly as the `Activate this route` action in the
 * browser already did — and it performs none at all until a human chooses it
 * from a picker. **A successful authentication is not consent to change
 * provider configuration.** The two are separate decisions upstream, so they
 * stay separate here; what changes is only that the second one is now asked
 * rather than left to be discovered.
 *
 * Everything it says is read back from Harness at the moment it speaks. The
 * offer is made against a FRESH reading (see {@link ConnectCatalog.reread}),
 * never the snapshot the browser was showing when the sign-in began: an empty
 * profile written over a route that has since been configured would replace
 * that configuration wholesale.
 * @module dshline/connect/activation
 */

import type { Context } from '@deepseek-ai/cordis'
import { promptSelect } from '../select.ts'
import { activateRoute } from './actions.ts'
import type { ConnectActionOutcome } from './actions.ts'
import type { ConnectSeams } from './harness.ts'
import type { ConnectSignInRow, ConnectState } from './model.ts'
import { rowActions } from './model.ts'
import { piAiSignInRoute } from './pi-ai.ts'

/** The picker value that writes; anything else leaves configuration alone. */
const ACTIVATE = 'activate'

/** What one post-sign-in offer needs from the browser that ran the sign-in. */
export interface ActivationOfferSpec {
  /** Context carrying the slot registry, for the picker. */
  readonly ctx: Context
  /** The Harness seams, for the write itself. */
  readonly seams: ConnectSeams
  /** The sign-in that just succeeded. */
  readonly row: ConnectSignInRow
  /** What {@link runAuthorization} answered; returned unchanged when nothing is offered. */
  readonly outcome: ConnectActionOutcome
  /** Re-read every surface, so the offer is made against facts as they are now. */
  readonly reread: () => Promise<ConnectState>
  /**
   * The browser's own signal. A closed browser must not raise a picker over
   * whatever the reader moved on to, so the question comes down with it and
   * counts as unanswered — which, for a question whose only other answer is a
   * settings write, is the right way to lose.
   */
  readonly signal: AbortSignal
}

/**
 * Offer to activate the route a completed sign-in authenticates.
 *
 * Five outcomes, and only one of them writes anything:
 *
 * 1. **No link.** Nothing published by Harness ties this credential to a route
 *    (see {@link piAiSignInRoute}), so the sign-in's own outcome stands
 *    unchanged. This is the honest default, not a fallback.
 * 2. **Already active.** The route is registered, so the reader is told the
 *    thing they actually want to know — that `/model` has it now — and no
 *    question is raised for a decision that is already made.
 * 3. **Not activatable from here.** A route whose activation the seams would
 *    refuse (no settings provider, a stale or unreadable revision, a
 *    whole-section profile, or a route already carrying configuration that did
 *    not register) is REPORTED, never offered. The same {@link rowActions} the
 *    browser's own picker consults decides that, so this can never offer an
 *    action the browser would not.
 * 4. **Declined.** The reader chose `Not now`, dismissed the picker, or the
 *    browser closed under it. Nothing is written and the row says so.
 * 5. **Activated.** {@link activateRoute} wrote the profile through
 *    `ctx.settings.mutate`, and its own answer is reported verbatim, refusals
 *    included.
 * @param spec - the seams, the sign-in, and the fresh reading to judge from.
 * @returns the outcome to report, with the sign-in's own words kept in it.
 */
export async function offerRouteActivation(spec: ActivationOfferSpec): Promise<ConnectActionOutcome> {
  const { ctx, seams, row, outcome, signal } = spec
  // Read before asking. The browser's snapshot predates the sign-in and, more
  // importantly, predates whatever else has written settings since — and the
  // revision this write is checked against comes out of this reading.
  const state = await spec.reread()
  if (state.kind !== 'ready') return outcome
  const route = piAiSignInRoute(row.key, state.providers)
  if (route === undefined) return outcome
  if (route.state === 'active') {
    return done(`${row.label}: signed in · ${route.provider} is active`)
  }
  if (!rowActions(route, state.capabilities).some(action => action.id === ACTIVATE)) {
    // Deliberately not a failure: the sign-in worked, and this is the next step
    // being named rather than a refusal of what was asked for.
    return done(`${row.label}: signed in · ${route.provider} is not active, and this profile cannot activate it here`)
  }
  if (signal.aborted) return done(`${row.label}: signed in · ${route.provider} route left inactive`)
  const picked = await promptSelect(ctx, {
    title: `Signed in · ${row.label}`,
    view: 'Connect',
    signal,
    detail: `This account is authorized, but the ${route.provider} model route is not active,`
      + ' so /model still offers nothing from it.',
    choices: [
      {
        value: ACTIVATE,
        label: `Activate the ${route.provider} route`,
        description: `Writes a profile in ${route.settingsNs} so the adapter registers it and /model can offer its models`,
      },
      {
        value: 'later',
        label: 'Not now',
        description: 'Writes nothing; the route stays in this list and can be activated at any time',
      },
    ],
  })
  // Dismissal and `Not now` are one answer, and it is the answer that changes
  // nothing. Only the explicit choice writes.
  if (picked !== ACTIVATE) {
    return done(`${row.label}: signed in · ${route.provider} route left inactive`)
  }
  const activated = await activateRoute(seams, route)
  return activated.kind === 'done'
    ? done(`${row.label}: signed in · ${route.provider} route activated · choose a model with /model`)
    // The sign-in still succeeded, so the refusal has to say which half failed.
    : { kind: 'failed', message: `${row.label}: signed in, but ${activated.message}` }
}

/**
 * An accepted outcome, worded like every other one this domain reports.
 * @param message - what happened.
 * @returns the outcome.
 */
function done(message: string): ConnectActionOutcome {
  return { kind: 'done', message }
}
