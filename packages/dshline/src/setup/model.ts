/**
 * The setup report, and what it offers to do about itself.
 *
 * Everything here is pure: facts in, rows and offers out. Nothing reads a
 * seam, nothing writes one, and nothing decides on its own that a step should
 * run — {@link "./index.ts"} does the acting, this decides what is true and
 * what is worth offering.
 *
 * Two rules shape every line below.
 *
 * **A mark is a claim, so an unknown gets no mark.** `✓` means a surface
 * confirmed something, `⚠` means a surface confirmed it is missing, and `·`
 * means nobody established either — a Harness generation that could not be
 * read, a profile whose root is unreadable. The third case is common and is
 * not a fault, so it must not look like one; the same distinction
 * `providerReadiness` already draws for a credential dot.
 *
 * **A step is offered only when the seams would accept it, and the missing
 * piece leads.** `Choose a model` appears only once a route is registered —
 * `/model` answers "no provider route advertises a model" otherwise, and an
 * offer that opens an empty picker is worse than no offer — and when it does
 * appear it goes first, because by then it is the step between the reader and
 * a working session.
 * @module dshline/setup/model
 */

import type { ConnectCapabilities, ConnectState } from '../connect/index.ts'
import type { HarnessGeneration, SetupFacts, SetupSelection } from './harness.ts'

/**
 * How confidently one row can be stated.
 *
 * `⚠` is deliberately not an error mark. Every state it appears on here is a
 * reachable, fixable configuration — no route active, no authorization seam —
 * and setup exists precisely to be the place a reader meets those calmly.
 */
export type SetupMark = '✓' | '⚠' | '·'

/** One line of the report. */
export interface SetupCheck {
  /** The mark, or `·` where nothing was established. */
  readonly mark: SetupMark
  /** Left column: what was checked. */
  readonly name: string
  /** Right column: what was found. */
  readonly detail: string
  /** Indented follow-up lines, for a finding that needs an action spelled out. */
  readonly notes: readonly string[]
}

/** Why a launch cannot send a turn as it stands. */
export type SetupReason =
  /** No adapter registered any route, so nothing can be selected at all. */
  | 'no-route'
  /** Routes exist, but nothing resolved a selection for the next turn. */
  | 'no-selection'
  /** A selection exists, but no adapter has registered the route it names. */
  | 'unregistered-selection'

/** Something setup can hand the reader on to. */
export type SetupStepId =
  /** Open `/connect`, the browser that configures and authenticates providers. */
  | 'connect'
  /** Open `/model`, once at least one route advertises something. */
  | 'model'
  /** Leave setup and go to the composer. */
  | 'skip'

/** One offered next action, already worded for a picker. */
export interface SetupStep {
  readonly id: SetupStepId
  readonly label: string
  readonly description: string
}

/**
 * Why this launch would reach the composer without a model it can send to.
 *
 * Three states, each read from something already in memory — the registry the
 * window holds and the selection ref `/model` writes — so the question costs
 * no adapter call and no network at startup.
 *
 * Route registration alone is NOT the question, which is what the first
 * version of this got wrong: a registered route is only what `/model` offers
 * FROM, and a launch reaches the composer with whatever `selection.current`
 * resolved to, which may be nothing or may name a route nothing registered.
 *
 * The selection is checked at PROVIDER granularity and no finer. Whether the
 * route still serves that exact model id is a question only `listModels` can
 * answer, and asking it here would put a possible network call in front of
 * every launch to refine a verdict the picker gives anyway.
 * @param registered - route keys an adapter has registered, from `listProviders`.
 * @param selected - the selection the next turn would use, if any.
 * @returns why setup should open, or undefined when this launch can send a turn.
 */
export function setupReason(
  registered: readonly string[],
  selected: { readonly provider: string } | undefined,
): SetupReason | undefined {
  if (registered.length === 0) return 'no-route'
  if (selected === undefined) return 'no-selection'
  // A remembered model whose route is gone: the profile changed under a stored
  // default, and the composer would open on a selection no adapter serves.
  if (!registered.includes(selected.provider)) return 'unregistered-selection'
  return undefined
}

/** Whether at least one route is registered, so `/model` has something to offer. */
export function hasActiveRoute(connect: ConnectState): boolean {
  return connect.kind === 'ready' && connect.providers.some(row => row.state === 'active')
}

/**
 * Whether the model step is the piece that is actually missing.
 *
 * What separates "offer a model picker" from "open one": setup hands straight
 * into `/model` only when a route can serve it and the selection is the thing
 * that is absent or stale — never when a usable model is already selected.
 * @param facts - what one setup pass established.
 * @returns whether choosing a model is the next obvious step.
 */
export function needsModelChoice(facts: SetupFacts): boolean {
  if (!hasActiveRoute(facts.connect)) return false
  return facts.reason === 'no-selection' || facts.reason === 'unregistered-selection'
}

/**
 * Sign-ins that succeeded against a route nothing has registered.
 *
 * The failure this whole change exists for, stated as data. A credential
 * record and a settings profile are separate writes, so a person can finish an
 * account login and still have no model — and before the link existed, the
 * only evidence on screen was two unrelated-looking rows.
 * @param connect - the reading.
 * @returns each such sign-in as `<label> · <route>`, in reading order.
 */
export function awaitingActivation(connect: ConnectState): string[] {
  if (connect.kind !== 'ready') return []
  return connect.signIns
    .filter(row => row.record?.configured === true && row.route !== undefined && row.route.state !== 'active')
    .map(row => `${row.label} is signed in, but its ${String(row.route?.provider)} route is not active`)
}

/**
 * What to do about a mismatched pair, without overstating either direction.
 *
 * Only ONE of these is deterministic, and the wording now says so. Installing
 * the generation this build targets is a fact the report already holds — the
 * version is right there in the manifest. Updating dshline is not the mirror
 * image of it: `update` moves to whatever release the registry currently
 * serves, and nothing here knows whether any released dshline targets the
 * installed generation, or whether the one it would fetch does. Establishing
 * that would mean resolving releases against their peer pins, which is the
 * version engine this repository refuses to grow.
 *
 * So the second line is offered as a condition rather than an instruction. A
 * reader told "run this and they will match" who then runs it and still has a
 * mismatch has been misinformed by the tool that was supposed to orient them.
 * @param generation - the mismatch.
 * @returns the note lines.
 */
function mismatchNotes(generation: { adopted: string; installed: string }): string[] {
  return [
    'dshline supports one Harness generation at a time.',
    `Install the generation this dshline targets: npm install -g @deepseek-ai/dsh@${generation.adopted}`,
    `Or move to a dshline release that targets ${generation.installed}, if one exists — updating dshline`,
    'does not by itself land on the installed generation, and this report cannot tell you which release would.',
  ]
}

/**
 * How the Harness generation reads as one row.
 * @param generation - the comparison.
 * @returns the row.
 */
function harnessCheck(generation: HarnessGeneration): SetupCheck {
  if (generation.kind === 'match') {
    return { mark: '✓', name: 'Harness', detail: generation.version, notes: [] }
  }
  if (generation.kind === 'mismatch') {
    return {
      mark: '⚠',
      name: 'Harness',
      detail: `${generation.installed} installed · dshline targets ${generation.adopted}`,
      notes: mismatchNotes(generation),
    }
  }
  const known = generation.installed ?? generation.adopted
  return {
    mark: '·',
    name: 'Harness',
    // Never "incompatible", and never "fine". Both would be claims about a
    // comparison that was not made.
    detail: known === undefined
      ? 'version could not be read'
      : generation.installed === undefined
        ? `dshline targets ${known}; the installed version could not be read`
        : `${known} installed; the targeted version could not be read`,
    notes: [],
  }
}

/**
 * How the mounted seams read as one row.
 *
 * One row rather than three, because a reader is not being asked about seams —
 * they are being told whether the two ways of connecting a provider are open.
 * The names are the ones the reader will meet next in `/connect`'s own action
 * picker (`Sign in to …`, `Connect with an API key`), not the service names.
 * @param capabilities - which optional seams this deployment mounts.
 * @param signIns - how many authorization flows are registered.
 * @returns the row.
 */
function connectingCheck(capabilities: ConnectCapabilities, signIns: number): SetupCheck {
  const ways: string[] = []
  if (capabilities.credentials && capabilities.settings) ways.push('API key')
  if (capabilities.authorization && signIns > 0) ways.push('account sign-in')
  if (ways.length === 0) {
    return {
      mark: '⚠',
      name: 'Connecting',
      detail: 'this profile mounts nothing that can configure a provider',
      notes: [
        capabilities.authorization
          ? 'No plugin has registered an authorization flow, and no settings or credential provider is mounted.'
          : 'Its composition mounts no authorization seam, so no account sign-in is offered.',
        'A provider has to be configured in settings.yaml by hand until that changes.',
      ],
    }
  }
  return { mark: '✓', name: 'Connecting', detail: ways.join(' · '), notes: [] }
}

/**
 * How the model situation reads as one row.
 *
 * Reports the SELECTION as well as the routes, because those are two different
 * ways of having no model and the reader has to act differently on each: with
 * no active route the next step is `/connect`, and with an active route but a
 * missing or stale selection it is `/model`.
 * @param connect - the reading.
 * @param selected - the selection the next turn would use, if any.
 * @param reason - why this launch cannot send a turn, when it cannot.
 * @returns the row.
 */
function modelsCheck(
  connect: ConnectState,
  selected: SetupSelection | undefined,
  reason: SetupReason | undefined,
): SetupCheck {
  if (connect.kind === 'failed') {
    return { mark: '·', name: 'Models', detail: `could not be read: ${connect.message}`, notes: [] }
  }
  if (connect.kind !== 'ready') {
    return { mark: '·', name: 'Models', detail: 'not read', notes: [] }
  }
  const active = connect.providers.filter(row => row.state === 'active')
  if (active.length === 0) {
    return {
      mark: '⚠',
      name: 'Models',
      detail: 'no provider route is active, so /model has nothing to offer',
      // The pending-activation sentences are the useful half of this row when
      // they apply: they name a fix the reader is one keystroke from.
      notes: awaitingActivation(connect),
    }
  }
  const routes = `${String(active.length)} route${active.length === 1 ? '' : 's'} active`
    + ` · ${active.map(row => row.provider).join(', ')}`
  if (reason === 'no-selection') {
    return { mark: '⚠', name: 'Models', detail: `${routes}, but no model is selected`, notes: [] }
  }
  if (reason === 'unregistered-selection' && selected !== undefined) {
    return {
      mark: '⚠',
      name: 'Models',
      detail: `${routes} · the selected ${selected.provider}/${selected.model} names no registered route`,
      notes: [],
    }
  }
  return {
    mark: '✓',
    name: 'Models',
    detail: selected === undefined ? routes : `${selected.provider}/${selected.model} · ${routes}`,
    notes: [],
  }
}

/**
 * The whole report, as rows.
 * @param facts - what one setup pass established.
 * @returns the rows, in reading order.
 */
export function setupChecks(facts: SetupFacts): SetupCheck[] {
  const connect = facts.connect
  const capabilities: ConnectCapabilities = connect.kind === 'ready'
    ? connect.capabilities
    // A reading that did not land says nothing about which seams are mounted,
    // and the `Connecting` row reports that rather than assuming absence.
    : { settings: false, credentials: false, authorization: false }
  const signIns = connect.kind === 'ready' ? connect.signIns.length : 0
  return [
    // No mark: this process is already running on it, so a tick would be
    // circular and a warning would need a semver range evaluator.
    { mark: '·', name: 'Node', detail: facts.node, notes: [] },
    { mark: '·', name: 'dshline', detail: facts.dshline, notes: [] },
    harnessCheck(facts.harness),
    facts.profile === undefined
      ? { mark: '·', name: 'Profile', detail: 'could not be determined', notes: [] }
      : { mark: '✓', name: 'Profile', detail: facts.profile, notes: [] },
    connectingCheck(capabilities, signIns),
    modelsCheck(connect, facts.selected, facts.reason),
  ]
}

/**
 * Whether the report has anything a reader has to act on.
 * @param checks - the rows.
 * @returns whether any row is marked `⚠`.
 */
export function hasWarning(checks: readonly SetupCheck[]): boolean {
  return checks.some(check => check.mark === '⚠')
}

/**
 * What setup offers to do next, given what it just read.
 *
 * Ordered by what the reader most likely needs, and filtered by what the
 * mounted seams would actually accept — so no offer here can open a surface
 * that has nothing in it.
 * @param facts - what one setup pass established.
 * @returns the offered steps, most useful first; never empty.
 */
export function setupSteps(facts: SetupFacts): SetupStep[] {
  const connect = facts.connect
  const steps: SetupStep[] = []
  const active = hasActiveRoute(connect)
  const canConfigure = connect.kind === 'ready'
    && (connect.capabilities.settings || connect.capabilities.credentials || connect.capabilities.authorization)
  // The model first whenever there is one to choose. Once a route can serve a
  // turn, choosing what to send is the step a beginner needs next, and burying
  // it under "connect another provider" is how a first run stalls one keystroke
  // short of working.
  if (active) {
    steps.push({
      id: 'model',
      label: 'Choose a model',
      description: 'Opens /model over the routes that are active now',
    })
  }
  if (canConfigure) {
    steps.push({
      id: 'connect',
      label: active ? 'Connect another provider' : 'Connect a provider',
      description: 'Opens /connect: sign in to an account, store an API key, or activate a route',
    })
  }
  // Worded from what a turn would actually do, not from route count: a window
  // whose selection is missing or stale reaches a composer that cannot send,
  // and calling that "start the session" would be the one untrue line here.
  const ready = facts.reason === undefined
  steps.push({
    id: 'skip',
    label: ready ? 'Start the session' : 'Not now',
    description: ready
      ? 'Go to the composer with the model selected above'
      : 'Go to the composer; run /setup again whenever you want this back',
  })
  return steps
}
