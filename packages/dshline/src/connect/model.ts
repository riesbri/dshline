/**
 * What Harness says about provider configuration, as rows a terminal can draw.
 *
 * Every value here is a join of facts four Harness surfaces already publish.
 * Nothing is inferred from a provider's name, and nothing is remembered between
 * reads: Connect owns no provider registry, no credential cache, and no idea of
 * which providers "exist" beyond the directory the mounted adapters declare.
 *
 * The two row kinds are deliberately NOT merged. A configurable provider is a
 * route that configuration can activate; an authorization flow is a
 * conversation that obtains a credential. Harness publishes no correlation
 * between them — a flow's `CredentialKey` is scoped by its owning plugin's
 * registered name, which is not the directory entry's `settingsNs` by contract
 * — so joining them would be the frontend inventing a relationship, the same
 * mistake Work refuses when it keeps jobs and subagents apart. Both are listed,
 * each addressed by the identity Harness gave it.
 *
 * {@link ConnectSignInLink} is the one thing that narrows, and it narrows the
 * claim rather than the refusal. This module still derives no link — it holds
 * a field a presentation module may FILL, for the one adapter family that
 * documents the correspondence on both sides of it (see
 * {@link "./pi-ai.ts".piAiSignInRoute}). Every sign-in whose link nobody
 * established reads exactly as it did before the field existed, which is what
 * keeps "we do not know" the default rather than a special case.
 * @module dshline/connect/model
 */

import type {
  AuthorizationMethodRead,
  CredentialInfoRead,
  CredentialRecordInfoRead,
} from './harness.ts'

/** Where one configurable route stands with the model registry. */
export type ConnectRouteState =
  /** An adapter has registered the route; `/model` can already offer its models. */
  | 'active'
  /** Configuration describes a profile, but no adapter registered the route. */
  | 'configured'
  /** Declared configurable, with nothing configured for it yet. */
  | 'dormant'

/** What Connect knows about one route's credential, without ever holding one. */
export interface ConnectCredentialReading {
  /**
   * Profile property that carries a credential reference, taken from the
   * namespace's own schema role rather than from a field name this frontend
   * knows. Undefined when the schema declares none, which is what makes
   * "set an API key" unavailable rather than a guess.
   */
  readonly field: string | undefined
  /** The reference that property currently names, when the profile names one. */
  readonly ref: string | undefined
  /** What the credential seam says about that reference; never its value. */
  readonly info: CredentialInfoRead | undefined
}

/** One configurable provider route, joined across the surfaces that describe it. */
export interface ConnectProviderRow {
  /** Discriminant, so one list can carry both row kinds. */
  readonly kind: 'provider'
  /** Route key `GenerateOptions.provider` takes. */
  readonly provider: string
  /** Human-readable name the owning adapter chose. */
  readonly displayName: string
  /** Settings namespace whose section configures this route. */
  readonly settingsNs: string
  /** Path from that section's root to this route's profile. */
  readonly settingsPath: readonly string[]
  /** Whether the adapter knows this route only because configuration declared it. */
  readonly declared: boolean | undefined
  /** Where the route stands with the model registry. */
  readonly state: ConnectRouteState
  /** Models the route advertises, when it is active and could be listed. */
  readonly models: number | undefined
  /** The credential reading for this route. */
  readonly credential: ConnectCredentialReading
  /** Whether the user layer alone carries this profile, so removing it restores the base. */
  readonly userOwned: boolean
  /** The namespace revision this row was read at, for a conflict-checked write. */
  readonly revision: number | undefined
}

/**
 * The provider route one sign-in authenticates, when a presentation module for
 * a known configuration domain has established the correspondence.
 *
 * A plain data shape, and — like {@link ConnectNewRouteTarget} — not a claim
 * this module makes. Nothing here derives a link from a key's spelling: the
 * only producer is a presentation module that read one adapter family's own
 * documented identity (`pi-ai.ts`'s {@link "./pi-ai.ts".piAiSignInRoute}), and
 * a sign-in with no such producer keeps `route: undefined` and is presented
 * exactly as it was before this field existed.
 *
 * It exists because the alternative is worse than the refusal it relaxes. A
 * credential record and a settings profile are separate writes to separate
 * stores, so a successful sign-in leaves `/model` offering nothing until the
 * route is ALSO activated — and with the two rows asserting nothing about each
 * other, the only thing on screen after a successful login was a row that said
 * "signed in" beside a route that said "not active", with no stated relation
 * between them. Naming the relation where it is documented is what turns that
 * into an answerable question.
 */
export interface ConnectSignInLink {
  /** Route key the sign-in's credential authenticates. */
  readonly provider: string
  /** Where that route stands with the model registry, at the same reading. */
  readonly state: ConnectRouteState
}

/** One registered authorization flow, joined with the record it writes. */
export interface ConnectSignInRow {
  /** Discriminant, so one list can carry both row kinds. */
  readonly kind: 'sign-in'
  /** The `<scope>/<id>` credential record this flow writes. */
  readonly key: string
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** The methods this flow offers, most preferred first. */
  readonly methods: readonly AuthorizationMethodRead[]
  /** Whether an attempt for this key is running right now. */
  readonly inFlight: boolean
  /** What the credential seam says about the record; undefined when unreadable. */
  readonly record: CredentialRecordInfoRead | undefined
  /**
   * The route this sign-in authenticates, when a presentation module
   * established the link. Undefined is the ordinary case and asserts nothing.
   */
  readonly route: ConnectSignInLink | undefined
}

/**
 * The one entry point for declaring a route nothing lists yet.
 *
 * Shown once, at the foot of the provider section, only when a presentation
 * module for a known configuration domain — `llm-pi-ai`'s
 * {@link "./pi-ai.ts".piAiDeclarationTarget}, today — has confirmed it can
 * actually service a write there. Its label is generic on purpose — "custom
 * provider", never a namespace name — so this row stays something
 * `overlay.ts` can render without knowing which domain produced it; deciding
 * whether one CAN be produced is deliberately not this module's job. A
 * schema shaping a namespace's routes as a `dict` proves only that arbitrary
 * keys are structurally accepted, never that writing one declares a new LLM
 * route — that is a fact about one namespace's semantics, not about schema
 * shape in general, so it is asserted only inside the presentation module
 * that actually knows it.
 */
export interface ConnectCreateRow {
  /** Discriminant, so one list can carry all three row kinds. */
  readonly kind: 'create'
  /** What the row says: "Add custom provider". */
  readonly label: string
  /** Every address a new route could be declared at, in directory order. */
  readonly targets: readonly ConnectNewRouteTarget[]
}

/** Any of the three row kinds the browser lists. */
export type ConnectRow = ConnectProviderRow | ConnectSignInRow | ConnectCreateRow

/**
 * One address where a brand-new provider route can be declared.
 *
 * A plain data shape, not a claim: nothing in this module asserts that any
 * particular namespace can be written to this way, or derives one from schema
 * shape alone. A target is only ever produced by a presentation module that
 * has already confirmed, using knowledge specific to the one domain it
 * presents, that it can carry out the write end to end.
 */
export interface ConnectNewRouteTarget {
  /** The namespace a new route's profile would be written into. */
  readonly settingsNs: string
  /** Path from that namespace's section root to the dict holding every route. */
  readonly parentPath: readonly string[]
  /** The namespace revision this target was read at, for a conflict-checked write. */
  readonly revision: number | undefined
}

/** Which of the optional seams this deployment mounts. */
export interface ConnectCapabilities {
  /** Whether a settings provider is mounted, so profiles can be written. */
  readonly settings: boolean
  /** Whether a credential provider is mounted, so keys can be stored. */
  readonly credentials: boolean
  /** Whether the authorization seam is mounted, so sign-ins can run. */
  readonly authorization: boolean
}

/** What one gathering pass produced. */
export type ConnectState =
  /** The first read has not landed yet. */
  | { readonly kind: 'loading' }
  /** Harness could not answer; the message is its own. */
  | { readonly kind: 'failed'; readonly message: string }
  /** A complete reading. */
  | {
    readonly kind: 'ready'
    readonly providers: readonly ConnectProviderRow[]
    readonly signIns: readonly ConnectSignInRow[]
    readonly capabilities: ConnectCapabilities
    readonly newRouteTargets: readonly ConnectNewRouteTarget[]
  }

/** Something Connect can ask Harness to do for one row. */
export type ConnectActionId =
  /** Run the row's authorization flow. */
  | 'sign-in'
  /** Delete the credential record a flow wrote. */
  | 'sign-out'
  /** Store an API key behind this route's credential reference. */
  | 'set-key'
  /** Forget the value behind that reference. */
  | 'clear-key'
  /** Write a minimal profile so the adapter registers the route. */
  | 'activate'
  /** Remove the user layer's profile for this route. */
  | 'deactivate'
  /**
   * Open the curated editor for a route's endpoint, protocol, and model
   * catalog. Never offered by {@link rowActions} itself — no generic seam
   * publishes which profile fields are worth curating — but a presentation
   * module for one known configuration domain may add it for the rows that
   * domain owns.
   */
  | 'edit-route'

/** One offered action, already worded for a picker. */
export interface ConnectAction {
  /** Which action this is. */
  readonly id: ConnectActionId
  /** The row label. */
  readonly label: string
  /** The second line, explaining what Harness will do. */
  readonly description: string
}

/**
 * How confidently a row can be said to be usable right now.
 *
 * Three states rather than two, because "we cannot tell" is a real answer here:
 * a deployment without a credential provider, or a route that authenticates
 * through its provider's own ambient discovery, is not misconfigured. Only a
 * reference the seam confirms is missing earns the negative mark — the same
 * rule the official Models page applies to its dots.
 */
export type ConnectReadiness = 'ready' | 'missing' | 'unknown'

/**
 * Normalize text for matching: case-folded, with runs of space collapsed.
 * @param value - raw text.
 * @returns the comparable form.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ')
}

/**
 * The user-facing state of one configurable route.
 * @param state - the internal registry state.
 * @returns the state wording a Connect surface presents.
 */
function providerStateLabel(state: ConnectRouteState): string {
  return state === 'dormant' ? 'not active' : state
}

/**
 * Whether one row answers a typed query.
 *
 * Matched against what the row SHOWS, which is the whole contract of a filter:
 * a reader who cannot see why a row matched cannot trust the ones that did not.
 * @param row - the row.
 * @param query - raw query text.
 * @returns true when the row should stay visible.
 */
export function matchesRow(row: ConnectRow, query: string): boolean {
  const needle = normalize(query)
  if (needle === '') return true
  const words = row.kind === 'provider'
    ? [row.provider, row.displayName, row.settingsNs, providerStateLabel(row.state)]
    : row.kind === 'sign-in'
      ? [
          row.key,
          row.label,
          ...row.methods.map(method => method.label),
          // Drawn by `signInFacts`, so matchable — a reader who can see a route
          // key on a row and cannot find that row by typing it is being told
          // the filter is broken.
          ...row.route === undefined ? [] : [row.route.provider],
        ]
      : [row.label]
  return normalize(words.join(' ')).includes(needle)
}

/**
 * Apply a query to rows, preserving Harness's declaration order.
 *
 * Order is never re-ranked. The directory's order is the owning adapters'
 * registration order, and a frontend that re-sorted it would be inventing a
 * preference no adapter expressed.
 * @param rows - the rows.
 * @param query - raw query text.
 * @returns the matching rows, in their original order.
 */
export function filterRows<T extends ConnectRow>(rows: readonly T[], query: string): readonly T[] {
  return normalize(query) === '' ? rows : rows.filter(row => matchesRow(row, query))
}

/**
 * Whether a provider row is usable, as far as Harness will say.
 * @param row - the provider row.
 * @returns the readiness mark.
 */
export function providerReadiness(row: ConnectProviderRow): ConnectReadiness {
  if (row.state !== 'active') return 'unknown'
  const { ref, info } = row.credential
  // A route naming no reference authenticates through its provider's own
  // discovery or a stored sign-in. That is a supported posture, not a fault, so
  // it is unmarked rather than marked bad.
  if (ref === undefined) return 'unknown'
  if (info === undefined) return 'unknown'
  return info.configured ? 'ready' : 'missing'
}

/**
 * The right-hand column of a provider row: its state, then what qualifies it.
 *
 * Whole facts, joined with a separator the row's renderer may drop from the
 * left. Each is something a surface asked Harness rather than concluded.
 * @param row - the provider row.
 * @param capabilities - mounted seams, when the caller can determine whether activation is offered.
 * @returns the facts, most important first.
 */
export function providerFacts(row: ConnectProviderRow, capabilities?: ConnectCapabilities): string[] {
  const facts: string[] = [providerStateLabel(row.state)]
  // A dormant route is actionable only when the same offer the picker uses says
  // it is. Naming activation without that check would promise a settings write
  // to a profile that cannot make one.
  if (row.state === 'dormant'
    && capabilities !== undefined
    && rowActions(row, capabilities).some(action => action.id === 'activate')) {
    facts.push('activate to add models')
  }
  if (row.state === 'active' && row.models !== undefined) {
    facts.push(`${String(row.models)} model${row.models === 1 ? '' : 's'}`)
  }
  const { ref, info } = row.credential
  if (ref === undefined) facts.push('no key reference')
  else if (info === undefined) facts.push(ref)
  else if (info.configured) facts.push(`key from ${info.source ?? 'store'}`)
  else facts.push(`${ref} unset`)
  return facts
}

/**
 * The indented facts under a selected provider row.
 * @param row - the provider row.
 * @returns one line's worth of facts, in decreasing usefulness.
 */
export function providerDetail(row: ConnectProviderRow): string[] {
  const facts: string[] = [`${row.settingsNs}${settingsAddress(row.settingsPath)}`]
  if (row.declared === true) facts.push('custom route')
  if (row.credential.field !== undefined) facts.push(`credential field ${row.credential.field}`)
  if (row.credential.info?.writable === false) facts.push('key is read-only here')
  if (row.userOwned) facts.push('from your settings')
  return facts
}

/**
 * The indented facts under a selected sign-in row.
 * @param row - the sign-in row.
 * @returns one line's worth of facts.
 */
export function signInDetail(row: ConnectSignInRow): string[] {
  const facts: string[] = [row.key]
  const methods = row.methods.map(method => method.label).join(', ')
  if (methods !== '') facts.push(methods)
  if (row.record?.kind !== undefined) facts.push(row.record.kind)
  return facts
}

/**
 * The right-hand column of a sign-in row.
 * @param row - the sign-in row.
 * @returns the facts, most important first.
 */
export function signInFacts(row: ConnectSignInRow): string[] {
  if (row.inFlight) return ['signing in…']
  if (row.record === undefined) return ['sign-in available']
  if (row.record.configured !== true) return ['not signed in']
  // The one state worth a second fact, and the reason {@link ConnectSignInLink}
  // exists: a credential this account authorized, against a route no adapter
  // has registered, is a provider `/model` still offers nothing from. Said only
  // where the link is known — an unlinked sign-in reports what it always did.
  const route = row.route
  if (route === undefined || route.state === 'active') return ['signed in']
  return ['signed in', `${route.provider} route not active`]
}

/**
 * A settings path spelled the way the stored document reads.
 * @param path - the profile path; empty means the section root.
 * @returns the suffix to append to a namespace name.
 */
function settingsAddress(path: readonly string[]): string {
  return path.length === 0 ? '' : ` · ${path.join('.')}`
}

/**
 * The reference a route would store a typed key under, when its profile names
 * none yet.
 *
 * `<ROUTE>_API_KEY` is the convention the official Models page derives, and
 * matching it is the point: a key stored from the terminal must be the same
 * reference the web UI would read, or the two surfaces would disagree about
 * whether the same provider is configured.
 *
 * A reference is a POSIX shell identifier, so a route id that cannot become one
 * — a leading digit survives every other check and then fails at the credential
 * seam with a raw regular expression — is refused here instead.
 * @param provider - the route key.
 * @returns the derived reference, or undefined when the id cannot name one.
 */
export function derivedCredentialRef(provider: string): string | undefined {
  // Character for character the official page's rule, including the order:
  // uppercase FIRST, then collapse each RUN of non-alphanumerics to one `_`.
  // Replacing per character instead would turn `foo--bar` into `FOO__BAR_API_KEY`
  // where the web page derives `FOO_BAR_API_KEY`, and the two surfaces would
  // read different references for the same route — the one failure this shared
  // derivation exists to rule out.
  const candidate = `${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(candidate) ? candidate : undefined
}

/**
 * Whether a typed id could become a brand-new route at one declarable target.
 *
 * The grammar is the official Models page's own create-card rule, adopted
 * character for character rather than invented here: a route id is both a
 * settings dict key AND — through {@link derivedCredentialRef} — the stem of a
 * credential reference, which is a POSIX shell identifier and so cannot start
 * with a digit. A leading digit passes every other check a route id could face
 * and then fails at the credential seam with a raw regular expression the
 * reader cannot act on; refusing it here, where the field is still on screen,
 * is what that page's own card does.
 * @param id - the typed route id.
 * @param taken - route keys already declared at this target's namespace.
 * @returns why the id cannot be used, or undefined when it can.
 */
export function newRouteIdProblem(id: string, taken: ReadonlySet<string>): string | undefined {
  if (id === '') return 'a provider id is required'
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id)) {
    return 'lowercase letters, digits, and single hyphens between them — starting with a letter'
  }
  if (derivedCredentialRef(id) === undefined) return 'no credential reference can be derived from this id'
  if (taken.has(id)) return `${id} is already declared`
  return undefined
}

/**
 * What Harness will let a reader do to one row, right now.
 *
 * Availability is derived from the seams and the row's own state, never from a
 * provider's identity: an action that is offered is one the owning surface has
 * already said it would accept, so a picker never lists a row that answers with
 * a refusal.
 * @param row - the selected row.
 * @param capabilities - which optional seams this deployment mounts.
 * @returns the offered actions, most useful first; empty when there are none.
 */
export function rowActions(row: ConnectRow, capabilities: ConnectCapabilities): ConnectAction[] {
  if (row.kind === 'create') return []
  return row.kind === 'sign-in' ? signInActions(row, capabilities) : providerActions(row, capabilities)
}

/**
 * Actions for one authorization flow.
 * @param row - the sign-in row.
 * @param capabilities - which optional seams this deployment mounts.
 * @returns the offered actions.
 */
function signInActions(row: ConnectSignInRow, capabilities: ConnectCapabilities): ConnectAction[] {
  const actions: ConnectAction[] = []
  // One attempt per key at a time is the seam's rule, and it publishes
  // `inFlight` so a surface can render the action unavailable rather than
  // discovering it through an ALREADY_IN_FLIGHT error.
  if (capabilities.authorization && !row.inFlight) {
    actions.push({
      id: 'sign-in',
      label: row.record?.configured === true ? `Sign in to ${row.label} again` : `Sign in to ${row.label}`,
      description: 'Harness runs the owning plugin’s flow and stores what it returns',
    })
  }
  if (capabilities.credentials && row.record?.configured === true && row.record.writable) {
    actions.push({
      id: 'sign-out',
      label: 'Forget this sign-in',
      description: 'Deletes the local credential record; the issuer is not told',
    })
  }
  return actions
}

/**
 * Actions for one configurable provider route.
 * @param row - the provider row.
 * @param capabilities - which optional seams this deployment mounts.
 * @returns the offered actions.
 */
function providerActions(row: ConnectProviderRow, capabilities: ConnectCapabilities): ConnectAction[] {
  const actions: ConnectAction[] = []
  const { field, ref, info } = row.credential
  // A whole-section profile (`settingsPath: []`) has no path to set or unset:
  // either op would replace the namespace's entire user section, which is a far
  // bigger action than a row describes and is refused by the writes themselves.
  // Offering it anyway would put a choice in the picker that is known to fail.
  const addressable = row.settingsPath.length > 0
  const writable = capabilities.settings && row.revision !== undefined && addressable
  // Storing a key needs somewhere to store it AND somewhere to record which
  // reference holds it. A schema that declares no credential-reference field is
  // an adapter that does not authenticate this way, so the action is absent
  // rather than offered and then failing.
  if (capabilities.credentials && field !== undefined && info?.writable !== false) {
    const derivable = ref !== undefined || derivedCredentialRef(row.provider) !== undefined
    // Recording a reference writes the FIELD's own path, which exists even for a
    // whole-section profile — so this needs a settings provider and a revision,
    // but not the addressable-profile rule the two profile-level ops need.
    const recordable = capabilities.settings && row.revision !== undefined
    if (derivable && (ref !== undefined || recordable)) {
      actions.push({
        id: 'set-key',
        label: info?.configured === true ? 'Replace the API key' : 'Connect with an API key',
        description: ref === undefined
          ? `Stores it as ${String(derivedCredentialRef(row.provider))} and records the reference`
          : `Stores it behind ${ref}`,
      })
    }
  }
  if (writable && row.state === 'dormant') {
    actions.push({
      id: 'activate',
      label: 'Activate this route',
      description: 'Writes a profile so the adapter registers it and /model can offer its models',
    })
  }
  if (capabilities.credentials && ref !== undefined && info?.configured === true && info.writable) {
    actions.push({
      id: 'clear-key',
      label: 'Forget the stored API key',
      description: `Removes the value behind ${ref}`,
    })
  }
  if (writable && row.userOwned) {
    actions.push({
      id: 'deactivate',
      label: 'Remove this route from your settings',
      description: 'Unsets the profile your settings document carries',
    })
  }
  return actions
}

/**
 * Why a row offers nothing, when it offers nothing.
 *
 * A picker with no rows tells a reader only that they were ignored; naming the
 * missing capability tells them what their deployment would need.
 * @param row - the selected row.
 * @param capabilities - which optional seams this deployment mounts.
 * @returns the sentence to show instead of a picker.
 */
export function noActionsReason(row: ConnectRow, capabilities: ConnectCapabilities): string {
  if (row.kind === 'create') return 'Selecting this row starts the create flow directly.'
  if (row.kind === 'sign-in') {
    if (!capabilities.authorization) return 'This profile mounts no authorization service.'
    return row.inFlight ? 'A sign-in for this key is already running.' : 'Harness offers nothing for this sign-in.'
  }
  if (!capabilities.settings && !capabilities.credentials) {
    return 'This profile mounts neither a settings nor a credential provider.'
  }
  if (!capabilities.credentials) return 'This profile mounts no credential provider.'
  if (row.credential.field === undefined) {
    return `Nothing in ${row.settingsNs} names a credential reference for this route.`
  }
  if (row.credential.info?.writable === false) {
    return `${String(row.credential.ref)} is supplied by a read-only source and cannot be written here.`
  }
  if (row.settingsPath.length === 0) {
    return `${row.settingsNs} configures this route as its whole section; edit it in settings.`
  }
  return 'Harness offers nothing to change for this route.'
}
