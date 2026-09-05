/**
 * Guided first run: from an installed dshline to a model that answers.
 *
 * This is a conductor, not a surface. Every step it hands the reader on to is
 * a browser that already exists and is already the authority for what it does
 * — `/connect` configures and authenticates providers, `/model` chooses among
 * the routes that resulted — and setup neither reimplements nor wraps either
 * of them. It contributes exactly two things neither could:
 *
 * 1. **A reading, committed to scrollback.** What the installation actually
 *    is, gathered once from the surfaces that own each answer, written as
 *    finished rows a person can scroll back to and paste into a bug report.
 *    Deliberately not an overlay: a bounded live region would scroll the
 *    version numbers away the moment the next thing was drawn, and this is the
 *    output most worth keeping.
 * 2. **An ordering.** Configure, then choose, then go — with the second step
 *    offered only once the first produced something to choose from.
 *
 * ## Why it is not a wizard
 *
 * There is no state machine here and nothing is remembered between runs. Each
 * pass re-reads Harness from scratch and offers what is true NOW, so backing
 * out halfway leaves nothing behind, running it twice is the same as running
 * it once, and there is no "have I been set up" flag anywhere on disk to
 * disagree with the configuration it claims to describe. The loop below is the
 * whole control flow.
 *
 * ## Why it opens at all
 *
 * {@link setupNeeded} asks whether this launch would reach a composer that
 * cannot send: nothing registered, nothing selected, or a selection naming a
 * route no adapter registered. Two synchronous reads, no I/O — see
 * {@link setupReason} for why a route count is not that question. That is the
 * one condition worth interrupting for, and an installation that works never
 * sees this flow. `/setup` runs it on demand regardless.
 * @module dshline/setup
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { escapeControls, paint } from '@dshline/renderer'
import { openConnect } from '../connect/index.ts'
import { pickModel } from '../model.ts'
import { promptSelect } from '../select.ts'
import { gatherSetupFacts } from './harness.ts'
import type { SetupFacts } from './harness.ts'
import { hasActiveRoute, needsModelChoice, setupChecks, setupReason, setupSteps } from './model.ts'
import type { SetupCheck } from './model.ts'

export type { HarnessGeneration, SetupFacts, SetupSelection } from './harness.ts'
export { adoptedGeneration, compareGenerations, gatherSetupFacts } from './harness.ts'
export type { SetupCheck, SetupMark, SetupReason, SetupStep, SetupStepId } from './model.ts'
export {
  awaitingActivation,
  hasActiveRoute,
  hasWarning,
  needsModelChoice,
  setupChecks,
  setupReason,
  setupSteps,
} from './model.ts'

/** Columns the left column of the report is padded to, so the values line up. */
const NAME_COLUMN = 11

/** What the flow needs from the window running it. */
export interface SetupSpec {
  /** Context carrying the Harness seams and the slot registry. */
  readonly ctx: Context
  /** Write finished rows into the terminal's own scrollback. */
  readonly commit: (lines: readonly string[]) => void
  /** This frontend's version, for the report's own row. */
  readonly version: string
  /** The route the next turn will use, which `/model` writes through. */
  readonly selection: ModelSelectionRef
  /** Re-resolve model metadata after the route changes; the window owns it. */
  readonly onModelChanged: () => void
}

/**
 * Whether this launch would otherwise reach a composer that cannot send.
 *
 * Two synchronous reads and no I/O: the route registry, and the selection ref
 * the window already holds. Between them they answer the only question worth
 * interrupting a launch for — see {@link setupReason} for why a registered
 * route is not that question on its own.
 * @param ctx - context carrying the model registry.
 * @param selection - the window's model selection ref, as `/model` writes it.
 * @returns whether the guided flow should be offered before the first session.
 */
export function setupNeeded(ctx: Context, selection: ModelSelectionRef): boolean {
  return setupReason(ctx.llm.listProviders().map(provider => provider.id), selection.current) !== undefined
}

/**
 * One report row as committed lines.
 *
 * Escaped whole and then styled per row, in that order and never the reverse:
 * a version string, a provider id, and a Harness error message all reach here
 * from outside this frontend, and `escapeControls` neutralizes the escape
 * character itself — so running it over already-coloured text would destroy
 * the colour, and running it after styling would leave the untrusted halves
 * unescaped.
 * @param check - the row.
 * @returns its lines, the mark's own colour carrying the verdict.
 */
export function checkLines(check: SetupCheck): string[] {
  const role = check.mark === '✓' ? 'success' : check.mark === '⚠' ? 'warning' : 'muted'
  // Padded rather than measured: every name is ASCII and chosen here, so
  // display width and length agree for this one column by construction.
  const name = check.name.padEnd(NAME_COLUMN)
  return [
    `${paint(check.mark, role)} ${paint(escapeControls(name), 'section-heading')}${paint(escapeControls(check.detail), 'muted')}`,
    ...check.notes.map(note => `  ${paint(escapeControls(note), 'muted')}`),
  ]
}

/**
 * The whole report as committed lines.
 * @param facts - what one pass established.
 * @returns the lines, blank-separated from whatever is above them.
 */
export function reportLines(facts: SetupFacts): string[] {
  return [
    '',
    paint('Setup', 'section-heading'),
    '',
    ...setupChecks(facts).flatMap(checkLines),
    '',
  ]
}

/**
 * Run the guided flow until the reader leaves it.
 *
 * The caller owns key routing for the duration — the pickers this opens are
 * overlays, and something has to be delegating keystrokes to them — exactly as
 * the session browser's caller does.
 * @param spec - the context, the transcript, and the model selection.
 * @returns when the reader has chosen to go on to the composer.
 */
export async function runSetup(spec: SetupSpec): Promise<void> {
  const { ctx, commit } = spec
  for (;;) {
    // Re-read every pass. The reader has just been inside `/connect`, so the
    // previous reading is exactly the thing most likely to be out of date, and
    // showing the checklist again is how they see what their own action did.
    const facts = await gatherSetupFacts(ctx, spec.version, spec.selection.current)
    commit(reportLines(facts))
    const steps = setupSteps(facts)
    const picked = await promptSelect(ctx, {
      title: 'Setup',
      view: 'Setup',
      detail: setupDetail(facts),
      choices: steps.map(step => ({
        value: step.id,
        label: step.label,
        description: step.description,
      })),
    })
    // Dismissal is the same answer as `Not now`: leave, having changed nothing
    // that was not changed by an action the reader took inside a browser.
    if (picked === undefined || picked === 'skip') {
      commit(leavingLines(facts))
      return
    }
    if (picked === 'connect') {
      await openConnect({ ctx, commit })
      // Connecting is only ever half the job, and the other half is one
      // keystroke a beginner has no way to know is waiting. So the conductor —
      // never `/connect`, which stays a browser and knows nothing about setup —
      // re-reads, and if configuring produced a route while the selection is
      // still missing or stale, it opens the picker instead of returning to a
      // checklist that would just say "now choose a model".
      //
      // Only then. A selection that already works is not replaced, because
      // adding a second provider is not a request to change models.
      const after = await gatherSetupFacts(ctx, spec.version, spec.selection.current)
      if (!needsModelChoice(after)) continue
      if (await chooseModel(spec)) return
      continue
    }
    if (picked === 'model' && await chooseModel(spec)) return
  }
}

/**
 * Put the model picker up and report what came of it.
 *
 * A dismissal deliberately does NOT end the flow: the reader is returned to the
 * checklist, which by then says a route is active and no model is chosen, with
 * `Choose a model` at the top. Leaving on a dismissal would drop them at a
 * composer that still cannot send, having just declined the one thing that
 * would fix it.
 * @param spec - the context, the transcript, and the selection to write.
 * @returns whether the flow is finished.
 */
async function chooseModel(spec: SetupSpec): Promise<boolean> {
  const outcome = await pickModel(spec.ctx, spec.selection)
  // `pickModel` answers undefined only for a dismissed picker, and reports its
  // own sentence otherwise — including the refusals, which are its to word, not
  // this module's to restate.
  if (outcome === undefined) return false
  spec.onModelChanged()
  spec.commit([paint(escapeControls(`· ${outcome}`), 'muted')])
  // A selection that can actually serve a turn is the end of the flow; staying
  // would put the checklist back on screen to say what the line above said.
  if (setupReason(spec.ctx.llm.listProviders().map(provider => provider.id), spec.selection.current) !== undefined) {
    return false
  }
  spec.commit(['', paint('✓ Ready.', 'success'), ''])
  return true
}

/**
 * The line under the step picker's title, naming what is missing.
 * @param facts - what the pass established.
 * @returns the subtitle.
 */
function setupDetail(facts: SetupFacts): string {
  if (!hasActiveRoute(facts.connect)) {
    return 'No provider route is active yet, so there is no model to send a turn to.'
  }
  if (facts.reason === 'no-selection') return 'A provider route is active, but no model is selected yet.'
  if (facts.reason === 'unregistered-selection') {
    return 'The selected model names a route no adapter has registered, so the next turn would fail.'
  }
  return 'A model is selected and ready. Change it, connect another provider, or start the session.'
}

/**
 * The closing line, worded from what is actually configured.
 * @param facts - the last reading taken.
 * @returns the lines to commit.
 */
function leavingLines(facts: SetupFacts): string[] {
  if (facts.reason === undefined) {
    return [paint('· setup closed · /connect and /model are always available', 'muted'), '']
  }
  // The one thing worth repeating on the way out, because the composer the
  // reader is about to land in cannot send a turn as it stands.
  const why = facts.reason === 'no-route'
    ? 'no provider is configured yet · run /setup, or /connect, when you want to'
    : facts.reason === 'no-selection'
      ? 'no model is selected yet · run /model, or /setup, when you want to'
      : 'the selected model names no registered route · run /model to choose another'
  return [paint(`· ${why}`, 'muted'), '']
}
