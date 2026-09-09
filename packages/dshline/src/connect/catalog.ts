/**
 * Reading provider configuration through Harness, and keeping nothing.
 *
 * One pass over four surfaces produces the whole browser: the configurable
 * directory says which routes exist, the model registry says which are live,
 * the settings document says how each is configured, and the credential seam
 * says whether the secret each names is present. Between passes this class
 * holds a rendered snapshot and nothing else — there is no provider list, no
 * credential cache, and no settings mirror to fall out of date.
 *
 * A pass is generation-stamped. Actions cause re-reads and `llm/adapters-updated`
 * causes more, so two can overlap; the older one's result is dropped rather than
 * being allowed to repaint a browser that has already moved on.
 * @module dshline/connect/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {
  ConnectCredentials,
  ConnectSeams,
  ConnectSettings,
  SettingsDescriptorRead,
} from './harness.ts'
import type {
  ConnectCapabilities,
  ConnectCredentialReading,
  ConnectProviderRow,
  ConnectReadiness,
  ConnectRouteState,
  ConnectSignInRow,
  ConnectState,
} from './model.ts'
import { readinessOf } from './model.ts'
import { piAiDeclarationTarget, piAiSignInRoute } from './pi-ai.ts'
import { credentialRefFields, profileNode, valueAt } from './schema.ts'

/** What the catalog needs from its owner. */
export interface ConnectCatalogSpec {
  /** The Harness seams to read, each optional except the model registry. */
  readonly seams: ConnectSeams
  /** Redraw after a pass lands. */
  readonly invalidate: () => void
}

/** Reads Harness's provider configuration into rows, on demand. */
export class ConnectCatalog {
  private current: ConnectState = { kind: 'loading' }
  private generation = 0
  private disposed = false

  /**
   * @param spec - the seams to read and the redraw to call.
   */
  constructor(private readonly spec: ConnectCatalogSpec) {}

  /** The most recent complete reading, or what is standing in for one. */
  state(): ConnectState {
    return this.current
  }

  /**
   * Start a fresh pass over every surface.
   *
   * Never awaited by the caller: the browser is already on screen, and a read
   * that has not landed shows the previous reading rather than a blank frame.
   */
  refresh(): void {
    if (this.disposed) return
    const generation = ++this.generation
    void this.gather()
      .then(next => { this.settle(generation, next) })
      .catch((error: unknown) => {
        this.settle(generation, { kind: 'failed', message: messageOf(error) })
      })
  }

  /**
   * Read every surface once, adopt the result, and hand it back.
   *
   * {@link ConnectCatalog.refresh} exists because a browser already on screen
   * should not blank while a read lands; this exists because ONE caller needs
   * the reading itself before it may act. After a sign-in commits a credential
   * record, whether the matching route is dormant — and at which settings
   * revision — decides whether activation is offered at all, and offering it
   * from the pre-sign-in snapshot would mean writing an empty profile over a
   * route something else activated in the meantime. That write replaces a
   * profile wholesale, so a stale answer is not a cosmetic error.
   *
   * Generation-stamped like every other pass, so a reading this supersedes
   * cannot repaint over it, and a reading superseded BY one cannot either. The
   * value is still returned to its caller in that case: it is what this caller
   * asked Harness, and the caller is about to put a question to a human about
   * it rather than paint it.
   * @returns the reading this pass produced.
   */
  async reread(): Promise<ConnectState> {
    if (this.disposed) return this.current
    const generation = ++this.generation
    try {
      const next = await this.gather()
      this.settle(generation, next)
      return next
    } catch (error) {
      const failed: ConnectState = { kind: 'failed', message: messageOf(error) }
      this.settle(generation, failed)
      return failed
    }
  }

  /** Abandon in-flight passes; their results would repaint a closed browser. */
  dispose(): void {
    this.disposed = true
    // Bumping the generation is the whole cancellation: the reads themselves are
    // short registry and store calls with no signal to withdraw, so what matters
    // is that nothing they return reaches the live region.
    this.generation += 1
  }

  /**
   * Adopt a pass's result when it is still the newest one.
   * @param generation - the pass's stamp.
   * @param next - what it read.
   */
  private settle(generation: number, next: ConnectState): void {
    if (this.disposed || generation !== this.generation) return
    this.current = next
    this.spec.invalidate()
  }

  /**
   * Read every surface once and join them.
   * @returns the complete reading.
   */
  private async gather(): Promise<ConnectState> {
    const { llm, settings, credentials, authorization } = this.spec.seams
    const capabilities: ConnectCapabilities = {
      settings: settings !== undefined,
      credentials: credentials !== undefined,
      authorization: authorization !== undefined,
    }
    const active = new Set(llm.listProviders().map(provider => provider.id))
    const descriptors = describeSettings(settings)
    const directory = llm.listConfigurableProviders()
    const providers = await Promise.all(directory.map(async entry =>
      this.providerRow(entry, active, descriptors, credentials)))
    const signIns = await Promise.all((authorization?.list() ?? []).map(async entry => {
      // Resolved against the providers THIS pass produced, never a held copy:
      // the link carries a route state, and a state read at a different moment
      // from the rows beside it is how a row comes to contradict the list it
      // sits in.
      const linked = piAiSignInRoute(entry.key, providers)
      return {
        kind: 'sign-in' as const,
        key: entry.key,
        label: entry.label,
        methods: entry.methods,
        inFlight: entry.inFlight,
        record: await describeRecord(credentials, entry.key),
        route: linked === undefined ? undefined : { provider: linked.provider, state: linked.state },
      }
    }))
    // The one namespace this workspace knows how to declare a new route into,
    // when a presentation module has confirmed it can actually service one —
    // never inferred here from schema shape alone.
    const piAiTarget = piAiDeclarationTarget(directory, descriptors)
    const newRouteTargets = piAiTarget === undefined ? [] : [piAiTarget]
    return { kind: 'ready', providers, signIns, capabilities, newRouteTargets } satisfies ConnectState
  }

  /**
   * Join one directory entry with the registry, its settings section, and its
   * credential.
   * @param entry - the configurable-provider directory entry.
   * @param active - route keys an adapter has registered.
   * @param descriptors - every namespace descriptor, keyed by namespace.
   * @param credentials - the credential seam, when one is mounted.
   * @returns the row.
   */
  private async providerRow(
    entry: LlmConfigurableProvider,
    active: ReadonlySet<string>,
    descriptors: ReadonlyMap<string, SettingsDescriptorRead>,
    credentials: ConnectCredentials | undefined,
  ): Promise<ConnectProviderRow> {
    const descriptor = descriptors.get(entry.settingsNs)
    const profile = valueAt(descriptor?.value, entry.settingsPath)
    const state = routeState(active.has(entry.provider), profile !== undefined)
    const credential = await readRouteCredential(descriptor, entry.settingsPath, credentials)
    return {
      kind: 'provider',
      provider: entry.provider,
      displayName: entry.displayName,
      settingsNs: entry.settingsNs,
      settingsPath: entry.settingsPath,
      declared: entry.declared,
      ...entry.error === undefined ? {} : { error: entry.error },
      state,
      models: state === 'active' ? await countModels(this.spec.seams, entry.provider) : undefined,
      credential,
      // The whole profile need not come from the user layer for the row to be
      // removable — what matters is that the layer carries something at this
      // path, because unsetting it is what restores the composition base.
      userOwned: valueAt(descriptor?.user, entry.settingsPath) !== undefined,
      revision: descriptor?.revision,
    }
  }
}

/**
 * What one route's settings section says about its credential.
 *
 * The whole of Connect's credential reading for a single route, extracted so
 * the first-launch check reaches it without gathering the browser's entire
 * listing — that pass calls `listModels` for every active route to count
 * models, which is the one thing a startup check must not do.
 *
 * Reads the reference through the namespace's own schema role, never a field
 * name: `credential-ref` is the contract, and both shipped adapters calling it
 * `apiKeyEnv` is a coincidence this must not depend on.
 * @param descriptor - the owning namespace's descriptor, when it has one.
 * @param settingsPath - path from that section's root to the route's profile.
 * @param credentials - the credential seam, when one is mounted.
 * @returns the reading; never the secret itself.
 */
export async function readRouteCredential(
  descriptor: SettingsDescriptorRead | undefined,
  settingsPath: readonly string[],
  credentials: ConnectCredentials | undefined,
): Promise<ConnectCredentialReading> {
  const profile = valueAt(descriptor?.value, settingsPath)
  const field = credentialRefFields(profileNode(descriptor?.schema, settingsPath))[0]
  const ref = field === undefined ? undefined : readRef(profile, field)
  return { field, ref, info: await describeRef(credentials, ref) }
}

/** One route's readiness, and the reference the verdict was reached through. */
export interface ConnectRouteReadiness {
  /** Whether the route's credential is present, missing, or unestablished. */
  readonly readiness: ConnectReadiness
  /** The reference the route names, when it names one. */
  readonly ref: string | undefined
}

/**
 * Read the readiness of ONE route, and nothing else.
 *
 * Deliberately narrow: the directory and the registry are synchronous
 * in-memory reads, `settings.describe()` is in-memory too, and
 * `credentials.describe()` on the shipped local provider is a map lookup over
 * a snapshot loaded once at mount. No endpoint is contacted, and no other route
 * is examined. The catalog is not consulted here: its membership is advisory,
 * and exact model validity remains a Harness adapter responsibility.
 *
 * Total by construction. A provider nothing registered, a route the directory
 * does not declare configurable, and an absent settings or credential seam all
 * answer `unknown`, because none of them is evidence that a credential is
 * missing.
 * @param seams - the Harness seams.
 * @param provider - the route key to judge.
 * @returns its readiness and the reference behind it.
 */
export async function readRouteReadiness(
  seams: ConnectSeams,
  provider: string,
): Promise<ConnectRouteReadiness> {
  const entry = seams.llm.listConfigurableProviders().find(candidate => candidate.provider === provider)
  if (entry === undefined) return { readiness: 'unknown', ref: undefined }
  const descriptor = describeSettings(seams.settings).get(entry.settingsNs)
  const credential = await readRouteCredential(descriptor, entry.settingsPath, seams.credentials)
  const registered = seams.llm.listProviders().some(candidate => candidate.id === provider)
  const configured = valueAt(descriptor?.value, entry.settingsPath) !== undefined
  return { readiness: readinessOf(routeState(registered, configured), credential), ref: credential.ref }
}

/**
 * Where one route stands with the model registry.
 * @param registered - whether an adapter registered the route.
 * @param configured - whether settings describe a profile for it.
 * @returns the state.
 */
function routeState(registered: boolean, configured: boolean): ConnectRouteState {
  if (registered) return 'active'
  return configured ? 'configured' : 'dormant'
}

/**
 * Every namespace descriptor, keyed by namespace.
 *
 * Redacted, even though this frontend shares a process with the seam and could
 * read verbatim. Connect never needs a secret's value, and a descriptor that
 * cannot carry one cannot leak one into a rendered row.
 * @param settings - the settings seam, when one is mounted.
 * @returns the descriptors, or an empty map without a provider.
 */
function describeSettings(settings: ConnectSettings | undefined): ReadonlyMap<string, SettingsDescriptorRead> {
  const found = new Map<string, SettingsDescriptorRead>()
  for (const descriptor of settings?.describe({ redactSecrets: true }) ?? []) {
    found.set(descriptor.ns, descriptor)
  }
  return found
}

/**
 * The reference a profile's credential field currently names.
 * @param profile - the profile value, when the section has one.
 * @param field - the credential-reference property.
 * @returns the reference, or undefined when the field is unset or not a string.
 */
function readRef(profile: unknown, field: string): string | undefined {
  const value = valueAt(profile, [field])
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Ask the credential seam about one reference.
 * @param credentials - the credential seam, when one is mounted.
 * @param ref - the reference, when the profile names one.
 * @returns the facts, or undefined when there is nothing to ask or the ask failed.
 */
async function describeRef(
  credentials: ConnectCredentials | undefined,
  ref: string | undefined,
): Promise<Awaited<ReturnType<ConnectCredentials['describe']>> | undefined> {
  if (credentials === undefined || ref === undefined) return undefined
  try {
    return await credentials.describe(ref)
  } catch {
    // A reference the store cannot answer for is unknown, not missing. Reporting
    // it as unconfigured would put a red mark on a working provider.
    return undefined
  }
}

/**
 * Ask the credential seam about one record.
 * @param credentials - the credential seam, when one is mounted.
 * @param key - the record address.
 * @returns the facts, or undefined when there is nothing to ask or the ask failed.
 */
async function describeRecord(
  credentials: ConnectCredentials | undefined,
  key: string,
): Promise<Awaited<ReturnType<ConnectCredentials['describeRecord']>> | undefined> {
  if (credentials === undefined) return undefined
  try {
    return await credentials.describeRecord(key)
  } catch {
    return undefined
  }
}

/**
 * How many models one active route advertises.
 * @param seams - the Harness seams.
 * @param provider - the route key.
 * @returns the count, or undefined when the route could not be listed.
 */
async function countModels(seams: ConnectSeams, provider: string): Promise<number | undefined> {
  try {
    return (await seams.llm.listModels(provider)).length
  } catch {
    // A route that cannot be listed is still registered; saying nothing about
    // its catalog is more honest than reporting zero models.
    return undefined
  }
}

/**
 * A message for a failure, without leaking an object's shape into a row.
 * @param error - whatever was thrown.
 * @returns the sentence to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Re-read whenever something Connect renders could have changed underneath it.
 *
 * Four feeds, because Connect joins four surfaces and each can move on its
 * own: `llm/adapters-updated` fires when a settings write activates or retires
 * a route, `settings/updated` and `settings/document-updated` fire on any
 * namespace edit — the official web Models page, a hand-edited
 * `settings.yaml`, or another terminal — and `credentials/reference-updated` /
 * `credentials/record-updated` fire when a key is stored, cleared, or a
 * sign-in completes anywhere in the process. All five are registered
 * unconditionally: a deployment mounting none of the optional seams simply
 * never fires them, which is what keeps this function correct without asking
 * which services are present.
 *
 * One microtask coalesces a burst into a single pass. A single settings write
 * commonly fires `settings/updated` and `settings/document-updated` together,
 * and `setApiKey` writes settings and then a credential in the same action;
 * refreshing once after the burst settles is what a reader actually wants,
 * not a rendering read per event fighting the one the action's own call
 * already scheduled.
 * @param ctx - context carrying the model registry and the other seams' event
 *   vocabulary, once anything in the process has imported their types.
 * @param catalog - the catalog to refresh.
 * @returns the disposer removing every subscription.
 */
export function watchAdapters(ctx: Context, catalog: ConnectCatalog): () => void {
  let scheduled = false
  const request = (): void => {
    if (scheduled) return
    scheduled = true
    void Promise.resolve().then(() => {
      scheduled = false
      catalog.refresh()
    })
  }
  const disposers = [
    ctx.on('llm/adapters-updated', request),
    ctx.on('settings/updated', request),
    ctx.on('settings/document-updated', request),
    ctx.on('credentials/reference-updated', request),
    ctx.on('credentials/record-updated', request),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
