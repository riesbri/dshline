/**
 * Editing and declaring one `llm-pi-ai` route from a terminal.
 *
 * Two flows live here, both sequences of the same `promptSelect`/`promptText`
 * overlays every other Connect action already uses — there is no new overlay
 * type, because a menu that edits a few named fields does not need one.
 * {@link runRouteEditor} opens on a route the directory already lists;
 * {@link runCreateRoute} opens on an address `pi-ai.ts`'s
 * `piAiDeclarationTarget` already confirmed it can service, where no route
 * exists yet. Both build a draft in memory, let the reader fetch or type
 * model candidates through {@link editModels}, and commit through a single
 * revision-checked `settings.mutate` — never a wholesale replace, so a
 * sibling field this pass does not render survives untouched. Neither
 * persists anything before its final explicit action: {@link runCreateRoute}
 * in particular walks the whole draft through one review menu, so leaving a
 * submenu never mutates settings on its own.
 *
 * A route that serves no explicit `models` list inherits the installed
 * catalog, and there per-model edits are written as `modelOverrides.<id>`
 * path ops — one model corrected, the other thirty-seven untouched. A route
 * whose profile DOES list models writes that whole array back with every
 * uncurated field (including `compat`) carried through. The two are never
 * written into one profile at once, because `llm-pi-ai` refuses an override
 * beside a list.
 *
 * A save that loses a revision race does not retry. {@link runRouteEditor}
 * keeps the draft on screen, re-reads the descriptor and the provider
 * directory, says plainly that the route changed elsewhere, and waits for a
 * second explicit Save before writing against the fresh revision. A route
 * deleted underneath the editor is never resurrected: the draft stays for
 * inspection and the reader is told to back out and add it again.
 *
 * Nothing here imports `@deepseek-ai/dsh-llm-pi-ai` or performs network I/O.
 * The one seam that touches an endpoint is `ctx.llm.discoverModels`, and its
 * result is candidates a reader chooses from, never a fact adopted automatically.
 * @module dshline/connect/route-editor
 */

import type { Context } from '@deepseek-ai/cordis'
import { promptSelect } from '../select.ts'
import { promptText } from '../prompt.ts'
import type { ConnectActionOutcome } from './actions.ts'
import { isSettingsConflict, messageOf } from './catalog.ts'
import type { ConnectSeams, LlmModelDiscoveryRequestRead, SettingsPathOp } from './harness.ts'
import { normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { ConnectNewRouteTarget, ConnectProviderRow } from './model.ts'
import { derivedCredentialRef, newRouteIdProblem } from './model.ts'
import {
  addCandidates,
  addManual,
  entriesFromOverrides,
  entriesFromRaw,
  includedEntries,
  parseCapacity,
  sameModelSet,
  sameOverrideSet,
  toRawEntries,
  toRawOverrides,
  toggleIncluded,
  updateFields,
} from './model-editor.ts'
import type { ModelDraftEntry, ModelStorage } from './model-editor.ts'
import {
  entriesFromRawHeaders,
  headerNameProblem,
  headerValueProblem,
  sameHeaderSet,
  toRawHeaders,
  upsertHeader,
} from './header-editor.ts'
import type { HeaderDraftEntry } from './header-editor.ts'
import {
  API_FIELD,
  BASE_URL_FIELD,
  createRouteOp,
  DISPLAY_NAME_FIELD,
  fieldOps,
  headersCurated,
  INPUT_FIELD,
  protocolChoices,
  rawHeaders,
  rawModelOverrides,
  rawModels,
  REASONING_EFFORTS_FIELD,
  routeModelSchema,
  setHeadersOp,
  setModelsOp,
  setOverrideOp,
  unsetHeadersOp,
  unsetModelsOp,
  unsetOverrideOp,
} from './pi-ai.ts'
import type { ModelEntrySchema, ReasoningEffortsValue, RouteModelSchema } from './pi-ai.ts'
import { credentialRefFields, profileNode, valueAt } from './schema.ts'
import type { CuratedFieldChange } from './pi-ai.ts'

/** A refused action, worded the same way {@link runCreateRoute} and `actions.ts` do. */
function failed(message: string): ConnectActionOutcome {
  return { kind: 'failed', message }
}

/** A string field's current value, or undefined when the profile carries none. */
function stringField(profile: unknown, field: string): string | undefined {
  const value = valueAt(profile, [field])
  return typeof value === 'string' ? value : undefined
}

/** One route's editable state, kept apart from the profile it was read from. */
interface RouteDraft {
  readonly displayName: string | undefined
  readonly baseURL: string
  readonly api: string
  readonly headers: HeaderDraftEntry[]
  readonly models: ModelDraftEntry[]
  /** Which field the model entries write: an explicit list, or per-id overrides. */
  readonly storage: ModelStorage
}

/**
 * Read a route's curated fields into a draft.
 *
 * The mode is decided from the EFFECTIVE resolved value, never from whether a
 * key exists: `llm-pi-ai`'s schema materializes `[]` for an absent `models`
 * array, and absent and empty are the same "serve the installed catalog"
 * request. So a route is explicit exactly when its resolved list has entries,
 * and otherwise its per-model edits address `modelOverrides`.
 * @param effective - the resolved profile value at the route's settings path.
 * @returns the draft, ready to compare edits against.
 */
function readDraft(effective: unknown): RouteDraft {
  const listed = rawModels(effective)
  const explicit = listed !== undefined && listed.length > 0
  return {
    displayName: stringField(effective, DISPLAY_NAME_FIELD),
    baseURL: stringField(effective, BASE_URL_FIELD) ?? '',
    api: stringField(effective, API_FIELD) ?? '',
    headers: entriesFromRawHeaders(rawHeaders(effective)),
    models: explicit ? entriesFromRaw(listed) : entriesFromOverrides(rawModelOverrides(effective)),
    storage: explicit ? 'models' : 'override',
  }
}

/**
 * The one-line reading of a header set for a menu row.
 *
 * NAMES only, never values. The row is on the route's own menu, which a reader
 * passes through on the way to anything else, and a header value is where a
 * gateway token lives — an `Authorization` bearer, a signed proxy token. Such a
 * value reaches this frontend unredacted because `headers` carries no
 * `credential-ref` role, so `describe({ redactSecrets: true })` does not strip
 * it; that says the field is outside Harness's redaction contract, NOT that
 * what it holds is harmless. Nothing here can tell one apart from a tenant tag,
 * so the summary treats every value as sensitive and shows none of them. A
 * value is shown one level in, on the header's own row, where a reader
 * deliberately went to inspect or edit exactly that.
 * @param entries - the draft as it stands.
 * @returns the description text for the summary row.
 */
function headersSummary(entries: readonly HeaderDraftEntry[]): string {
  if (entries.length === 0) return '(none)'
  return `${String(entries.length)} set · ${entries.map(entry => entry.name).join(', ')}`
}

/**
 * Edit one route the directory already lists.
 *
 * The route menu and every submenu are side-effect free; a save is the only
 * write, and it is one revision-checked `settings.mutate`. A rejected write
 * never discards the draft: the cause is shown, the descriptor and directory
 * are re-read, and the reader must Save again — so a revision race is resolved
 * by a person, not by an automatic retry that could apply a stale intent.
 * @param ctx - context carrying the slot registry.
 * @param seams - the Harness seams.
 * @param row - the route being edited.
 * @returns what Harness answered, or undefined when the reader left without saving.
 */
export async function runRouteEditor(
  ctx: Context,
  seams: ConnectSeams,
  row: ConnectProviderRow,
): Promise<ConnectActionOutcome | undefined> {
  const { settings } = seams
  if (settings === undefined) return failed('this profile mounts no settings provider')
  let descriptor = settings.describe({ redactSecrets: true }).find(entry => entry.ns === row.settingsNs)
  if (descriptor === undefined) return failed(`${row.settingsNs} is no longer available`)
  const original = readDraft(valueAt(descriptor.value, row.settingsPath))
  const editableIdentity = row.declared === true
  let draft = original
  let notice: string | undefined
  // Set when a re-read finds the route gone. The draft survives for
  // inspection, but no save may write it back: a declared route's profile was
  // removed (or the directory dropped the route), and a path op would recreate
  // it through the settings schema's intermediate-object creation.
  let removed = false
  for (;;) {
    const protocolOptions = protocolChoices(descriptor.schema, row.settingsPath)
    // Not gated on `declared`, unlike protocol and display name: a header is
    // additive and means the same thing on a catalog route as on a declared one
    // — a tenant tag or an egress token the deployment needs on requests to an
    // endpoint it did not itself describe.
    const headersOffered = headersCurated(descriptor.schema, row.settingsPath)
    const modelSchema = routeModelSchema(descriptor.schema, row.settingsPath)
    const ownedOverrideIds = new Set(Object.keys(rawModelOverrides(valueAt(descriptor.user, row.settingsPath))))
    for (;;) {
      const modelsLabel = draft.storage === 'override'
        ? draft.models.length === 0
          ? 'inherited from adapter'
          : `overrides · ${String(includedEntries(draft.models).length)}`
        : `customized · ${String(includedEntries(draft.models).length)}`
      const choice = await promptSelect(ctx, {
        title: `Edit ${row.displayName}`,
        view: 'Edit route',
        detail: notice ?? `${row.settingsNs}${row.settingsPath.length > 0 ? ` · ${row.settingsPath.join('.')}` : ''}`,
        choices: [
          { value: 'base-url', label: 'Base URL', description: draft.baseURL === '' ? '(not set)' : draft.baseURL },
          ...editableIdentity && protocolOptions.length > 0
            ? [{ value: 'protocol', label: 'Protocol', description: draft.api === '' ? '(not set)' : draft.api }]
            : [],
          ...editableIdentity
            ? [{ value: 'display-name', label: 'Display name', description: draft.displayName ?? '(none)' }]
            : [],
          ...headersOffered
            ? [{ value: 'headers', label: 'Request headers', description: headersSummary(draft.headers) }]
            : [],
          { value: 'models', label: 'Models', description: modelsLabel },
          ...draft.storage === 'models'
            ? [{ value: 'reset-models', label: 'Reset models to adapter catalog' }]
            : [],
          { value: 'save', label: 'Save changes' },
          { value: 'cancel', label: 'Discard changes' },
        ],
      })
      notice = undefined
      if (choice === undefined || choice === 'cancel') return undefined
      if (choice === 'base-url') {
        const typed = await promptText(ctx, {
          title: 'Base URL',
          view: 'Edit route',
          message: 'The base URL this route calls.',
          kind: 'text',
          initial: draft.baseURL,
        })
        if (typed !== undefined) draft = { ...draft, baseURL: typed.trim() }
        continue
      }
      if (choice === 'protocol') {
        const picked = await promptSelect(ctx, {
          title: 'Protocol',
          view: 'Edit route',
          choices: protocolOptions.map(option => ({ value: option, label: option })),
        })
        if (picked !== undefined) draft = { ...draft, api: picked }
        continue
      }
      if (choice === 'display-name') {
        const typed = await promptText(ctx, {
          title: 'Display name',
          view: 'Edit route',
          message: 'Shown in /connect and /model. Leave blank to show the route id instead.',
          kind: 'text',
          initial: draft.displayName ?? '',
        })
        if (typed !== undefined) draft = { ...draft, displayName: typed.trim() === '' ? undefined : typed.trim() }
        continue
      }
      if (choice === 'headers') {
        draft = { ...draft, headers: await editHeaders(ctx, 'Edit route', draft.headers) }
        continue
      }
      if (choice === 'models') {
        // Opening the submenu must be side-effect free: a route that inherits
        // its catalog and leaves the submenu without an actual adoption must
        // still inherit it. `changed` is measured against what would be
        // WRITTEN, so a fetch that finds candidates nobody adopted counts the
        // same as never having fetched at all.
        //
        // Discovery for an existing route is identified by `provider` alone, so
        // the owning adapter resolves this route's STORED headers and credential
        // itself — which is also why an unsaved header edit cannot reach the
        // fetch, and why the reader is told so rather than left to wonder why a
        // gateway still refuses the listing.
        const result = await editModels(
          ctx,
          seams,
          row.settingsNs,
          { provider: row.provider },
          draft.baseURL,
          draft.api,
          draft.models,
          draft.storage,
          modelSchema,
          ownedOverrideIds,
          sameHeaderSet(draft.headers, original.headers)
            ? undefined
            : 'Fetching uses this route’s saved headers; unsaved header edits are not sent.',
        )
        if (result.changed) draft = { ...draft, models: result.entries }
        continue
      }
      if (choice === 'reset-models') {
        // Back to the adapter's catalog: drop the explicit list, and with it
        // any per-model edits it carried. A route that never had overrides
        // therefore resolves exactly as an untouched catalog route does.
        draft = { ...draft, models: [], storage: 'override' }
        continue
      }
      if (choice === 'save') {
        if (removed) {
          notice = `${row.provider} is no longer configured here; back out and add the route again to save this draft.`
          continue
        }
        break
      }
    }
    const ops = buildRouteOps(draft, original, row.settingsPath, editableIdentity, headersOffered)
    if (ops.length === 0) return { kind: 'done', message: `${row.provider}: nothing changed` }
    try {
      await settings.mutate(row.settingsNs, ops, descriptor.revision)
      return { kind: 'done', message: `${row.provider}: route updated` }
    } catch (error) {
      // The draft is never recomputed from a re-read: a field the reader never
      // touched must keep the value it was shown, so the next save cannot
      // silently revert someone else's edit to it.
      const conflict = isSettingsConflict(error)
      const fresh = settings.describe({ redactSecrets: true }).find(entry => entry.ns === row.settingsNs)
      const stillListed = seams.llm.listConfigurableProviders().some(entry =>
        entry.settingsNs === row.settingsNs && samePath(entry.settingsPath, row.settingsPath))
      if (fresh === undefined || !stillListed) {
        removed = true
        notice = `${row.provider} was removed elsewhere; the draft is kept for inspection. Back out and add the route again to save it.`
        continue
      }
      descriptor = fresh
      removed = false
      // A non-conflict refusal — an owner-invalid reasoning mapping, a
      // catalog-unknown override id — is shown verbatim and keeps the draft,
      // because only Harness is allowed to judge those semantics.
      notice = conflict
        ? `${row.provider} changed elsewhere since this editor opened. Review the draft, then Save again to apply it to the current revision.`
        : `${row.settingsNs} refused the edit: ${messageOf(error)}`
      continue
    }
  }
}

/**
 * The ordered path ops one route draft would write.
 *
 * One array for one `settings.mutate`. An explicit catalog writes its whole
 * `models` array — carrying every uncurated field forward — while an inherited
 * route writes per-id `modelOverrides` and unsets only the ids it dropped.
 * Switching from a list back to the catalog unsets `models`; the two are never
 * both present, which `llm-pi-ai` would refuse.
 * @param draft - the draft as it stands.
 * @param original - the draft as first read; the comparison basis, never refreshed.
 * @param routePath - the route's settings path.
 * @param editableIdentity - whether protocol and display name are user-editable.
 * @param headersOffered - whether the schema still offers the header editor.
 * @returns the ops, in the order they should apply; empty when nothing changed.
 */
function buildRouteOps(
  draft: RouteDraft,
  original: RouteDraft,
  routePath: readonly string[],
  editableIdentity: boolean,
  headersOffered: boolean,
): SettingsPathOp[] {
  const changes: CuratedFieldChange[] = []
  if (draft.baseURL !== original.baseURL) {
    changes.push({ field: BASE_URL_FIELD, value: draft.baseURL === '' ? undefined : draft.baseURL })
  }
  if (editableIdentity) {
    if (draft.api !== original.api) changes.push({ field: API_FIELD, value: draft.api === '' ? undefined : draft.api })
    if (draft.displayName !== original.displayName) changes.push({ field: DISPLAY_NAME_FIELD, value: draft.displayName })
  }
  const ops = fieldOps(routePath, changes)
  if (headersOffered && !sameHeaderSet(draft.headers, original.headers)) {
    ops.push(draft.headers.length === 0
      ? unsetHeadersOp(routePath)
      : setHeadersOp(routePath, toRawHeaders(draft.headers)))
  }
  if (original.storage === 'models' && draft.storage === 'override') {
    ops.push(unsetModelsOp(routePath))
  }
  if (draft.storage === 'models') {
    if (original.storage === 'models' && !sameModelSet(draft.models, original.models)) {
      ops.push(setModelsOp(routePath, toRawEntries(draft.models)))
    }
    return ops
  }
  const before = original.storage === 'override' ? toRawOverrides(original.models) : {}
  const after = toRawOverrides(draft.models)
  for (const id of Object.keys(before)) {
    if (!(id in after)) ops.push(unsetOverrideOp(routePath, id))
  }
  for (const [id, value] of Object.entries(after)) {
    if (JSON.stringify(before[id]) !== JSON.stringify(value)) ops.push(setOverrideOp(routePath, id, value))
  }
  return ops
}

/**
 * Whether two settings paths address the same profile.
 * @param left - one path.
 * @param right - the other.
 * @returns true when they are the same segments in the same order.
 */
function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

/**
 * Ask for a provider id, refusing one Harness would refuse or one already taken.
 * @param ctx - context carrying the slot registry.
 * @param taken - route keys already in the directory, across every namespace.
 * @returns the id, or undefined when the reader backed out.
 */
async function promptRouteId(ctx: Context, taken: ReadonlySet<string>): Promise<string | undefined> {
  let detail: string | undefined
  for (;;) {
    const raw = await promptText(ctx, {
      title: 'Provider ID',
      view: 'Add custom provider',
      message: 'Lowercase letters, digits, and hyphens; becomes the route key.',
      ...detail === undefined ? {} : { detail },
      kind: 'text',
    })
    if (raw === undefined) return undefined
    const id = raw.trim()
    const problem = newRouteIdProblem(id, taken)
    if (problem !== undefined) {
      detail = problem
      continue
    }
    return id
  }
}

/**
 * A brand-new route's editable state, kept apart from what will be written.
 * `apiKey` already holds the NORMALIZED value the moment one is typed —
 * nothing downstream reads the raw typed text again.
 */
interface CreateDraft {
  displayName: string | undefined
  baseURL: string
  api: string
  apiKey: string | undefined
  headers: HeaderDraftEntry[]
  models: ModelDraftEntry[]
}

/**
 * Ask for a base URL, refusing to leave the field blank.
 * @param ctx - context carrying the slot registry.
 * @param initial - the field's current value, prefilled.
 * @returns the trimmed URL, or undefined when the reader backed out.
 */
async function promptBaseURL(ctx: Context, initial: string): Promise<string | undefined> {
  const typed = await promptText(ctx, {
    title: 'Endpoint',
    view: 'Add custom provider',
    message: 'The base URL this route calls.',
    kind: 'text',
    initial,
  })
  if (typed === undefined || typed.trim() === '') return undefined
  return typed.trim()
}

/**
 * Ask for an API key, normalizing it the same way {@link setApiKey} in
 * `actions.ts` does before anything else ever sees it.
 * @param ctx - context carrying the slot registry.
 * @returns the normalized key, undefined for "no key", or `'cancel'` when the
 *   reader backed out (distinct from undefined, which is a deliberate answer).
 */
async function promptApiKey(ctx: Context): Promise<string | undefined | 'cancel'> {
  let detail: string | undefined
  for (;;) {
    const typed = await promptText(ctx, {
      title: 'API key',
      view: 'Add custom provider',
      message: 'Optional. Leave blank if this endpoint needs none.',
      ...detail === undefined ? {} : { detail },
      kind: 'secret',
    })
    if (typed === undefined) return 'cancel'
    if (typed === '') return undefined
    const checked = normalizeApiKey(typed)
    if (checked.ok) return checked.value
    detail = checked.reason === 'empty' ? 'no key was typed' : 'that key contains characters no HTTP header can carry'
  }
}

/**
 * Declare a brand-new route at an address a presentation module confirmed it
 * can service.
 *
 * Whether an API key is ever asked for depends on whether the schema still
 * names a `credential-ref` field for this route — read once, right after the
 * fresh descriptor comes back, and before any prompt runs. Its absence is a
 * legitimate state (an unauthenticated local server has to stay possible), so
 * the wizard omits the key step and its review row entirely rather than
 * asking a question it has nowhere to put the answer to. That is the
 * difference between "no key was offered" and "a typed key was quietly
 * dropped after a successful-looking write," and only the first is allowed to
 * happen.
 * @param ctx - context carrying the slot registry.
 * @param seams - the Harness seams.
 * @param target - where the new route's profile would be written.
 * @returns what Harness answered, or undefined when the reader backed out
 *   before the final confirmation, having written nothing.
 */
export async function runCreateRoute(
  ctx: Context,
  seams: ConnectSeams,
  target: ConnectNewRouteTarget,
): Promise<ConnectActionOutcome | undefined> {
  const { settings, llm, credentials } = seams
  if (settings === undefined) return failed('this profile mounts no settings provider')
  // Global identity: a route id is `GenerateOptions.provider` across every
  // mounted adapter, not just entries this one namespace's directory lists.
  // A live route with no configurable-provider entry — a composition-declared
  // one, say — still owns its id, and a collision with it must be refused
  // here rather than surfacing as an adapter-registration failure later.
  const taken = new Set([
    ...llm.listProviders().map(provider => provider.id),
    ...llm.listConfigurableProviders().map(entry => entry.provider),
  ])
  const id = await promptRouteId(ctx, taken)
  if (id === undefined) return undefined
  const routePath = [...target.parentPath, id]
  // Read fresh, right as the wizard opens: the revision that guards the
  // eventual write is the one a concurrent editor would have to race against
  // from HERE, not the older reading the `+ Add custom provider` row was
  // shown from. It is not re-read again before the write — that would defeat
  // the conflict check the wizard's own draft is supposed to protect.
  const descriptor = settings.describe({ redactSecrets: true }).find(entry => entry.ns === target.settingsNs)
  if (descriptor === undefined) return failed(`${target.settingsNs} is no longer available`)
  const protocolOptions = protocolChoices(descriptor.schema, routePath)
  // Fail closed: a schema this module can no longer read a protocol choice
  // from is capability drift, not an invitation to write a guessed `api: ''`
  // Harness would refuse several steps later with a less useful error.
  if (protocolOptions.length === 0) {
    return failed(`${target.settingsNs} no longer publishes a protocol this editor understands`)
  }
  // A route with nowhere to store a key is still a legitimate route — an
  // unauthenticated local server has to stay possible — but a key typed with
  // nowhere to put it would be silently discarded after the write instead of
  // ever reaching a reference. Refusing to ASK is what rules that out: the
  // reader is never given a field whose answer this wizard cannot keep.
  const credentialField = credentialRefFields(profileNode(descriptor.schema, routePath))[0]
  const keyAvailable = credentialField !== undefined

  const headersOffered = headersCurated(descriptor.schema, routePath)
  const modelSchema = routeModelSchema(descriptor.schema, routePath)
  const draft: CreateDraft = {
    displayName: undefined,
    baseURL: '',
    api: '',
    apiKey: undefined,
    headers: [],
    models: [],
  }
  const baseURL = await promptBaseURL(ctx, draft.baseURL)
  if (baseURL === undefined) return undefined
  draft.baseURL = baseURL
  const firstProtocol = await promptSelect(ctx, {
    title: 'Protocol',
    view: 'Add custom provider',
    choices: protocolOptions.map(option => ({ value: option, label: option })),
  })
  if (firstProtocol === undefined) return undefined
  draft.api = firstProtocol
  if (keyAvailable) {
    const firstApiKey = await promptApiKey(ctx)
    if (firstApiKey === 'cancel') return undefined
    draft.apiKey = firstApiKey
  }
  const firstModels = await editModels(
    ctx,
    seams,
    target.settingsNs,
    keyIdentity(draft.apiKey),
    draft.baseURL,
    draft.api,
    draft.models,
    'models',
    modelSchema,
    new Set(),
  )
  draft.models = firstModels.entries

  let notice: string | undefined
  for (;;) {
    const keyProvided = draft.apiKey !== undefined
    const choice = await promptSelect(ctx, {
      title: `Add custom provider · ${id}`,
      view: 'Add custom provider',
      detail: notice === undefined ? `Provider ID  ${id}` : `${notice}\nProvider ID  ${id}`,
      choices: [
        { value: 'display-name', label: 'Display name', description: draft.displayName ?? '(none)' },
        { value: 'base-url', label: 'Base URL', description: draft.baseURL },
        { value: 'protocol', label: 'Protocol', description: draft.api },
        ...keyAvailable ? [{ value: 'api-key', label: 'API key', description: keyProvided ? 'configured' : 'not set' }] : [],
        ...headersOffered
          ? [{ value: 'headers', label: 'Request headers', description: headersSummary(draft.headers) }]
          : [],
        { value: 'models', label: 'Models', description: `${String(includedEntries(draft.models).length)} selected` },
        { value: 'create', label: 'Create provider' },
        { value: 'cancel', label: 'Cancel' },
      ],
    })
    notice = undefined
    if (choice === undefined || choice === 'cancel') return undefined
    if (choice === 'display-name') {
      const typed = await promptText(ctx, {
        title: 'Display name',
        view: 'Add custom provider',
        message: 'Optional; shown in /connect and /model. Leave blank to show the route id instead.',
        kind: 'text',
        initial: draft.displayName ?? '',
      })
      if (typed !== undefined) draft.displayName = typed.trim() === '' ? undefined : typed.trim()
      continue
    }
    if (choice === 'base-url') {
      const typed = await promptBaseURL(ctx, draft.baseURL)
      if (typed !== undefined) draft.baseURL = typed
      continue
    }
    if (choice === 'protocol') {
      const picked = await promptSelect(ctx, {
        title: 'Protocol',
        view: 'Add custom provider',
        choices: protocolOptions.map(option => ({ value: option, label: option })),
      })
      if (picked !== undefined) draft.api = picked
      continue
    }
    if (choice === 'api-key') {
      const typed = await promptApiKey(ctx)
      if (typed !== 'cancel') draft.apiKey = typed
      continue
    }
    if (choice === 'headers') {
      draft.headers = await editHeaders(ctx, 'Add custom provider', draft.headers)
      continue
    }
    if (choice === 'models') {
      // A route that does not exist yet has no stored profile for the adapter
      // to resolve headers from, and the discovery request carries no field
      // for them, so a fetch here reaches the endpoint without them. Said
      // plainly rather than left to look like the endpoint refused: the same
      // fetch works from `Edit route` once the route is written.
      const result = await editModels(
        ctx,
        seams,
        target.settingsNs,
        keyIdentity(draft.apiKey),
        draft.baseURL,
        draft.api,
        draft.models,
        'models',
        modelSchema,
        new Set(),
        draft.headers.length === 0
          ? undefined
          : 'Fetching cannot send this route’s request headers until the route exists.',
      )
      draft.models = result.entries
      continue
    }
    // 'create': validated here, in the loop, so a reader who has not chosen a
    // model yet is told why and kept in the draft rather than having the
    // whole wizard close under them.
    if (includedEntries(draft.models).length === 0) {
      notice = 'Select at least one model before creating this provider.'
      continue
    }
    break
  }

  const included = includedEntries(draft.models)
  const keyProvided = draft.apiKey !== undefined
  const credentialRef = keyProvided && credentialField !== undefined ? derivedCredentialRef(id) : undefined
  if (keyProvided && credentialField !== undefined && credentialRef === undefined) {
    return failed(`no credential reference can be derived from "${id}"`)
  }

  const op = createRouteOp(routePath, {
    displayName: draft.displayName,
    baseURL: draft.baseURL,
    api: draft.api,
    // Empty when the schema offered no header editor, so a namespace that does
    // not describe the field is never written one.
    headers: headersOffered ? toRawHeaders(draft.headers) : {},
    models: included,
    credentialField: keyProvided ? credentialField : undefined,
    credentialRef,
  })
  try {
    await settings.mutate(target.settingsNs, [op], descriptor.revision)
  } catch (error) {
    return failed(`${target.settingsNs} refused the profile: ${messageOf(error)}`)
  }
  const apiKey = draft.apiKey
  if (apiKey === undefined || credentialRef === undefined) return { kind: 'done', message: `${id}: route created` }
  if (credentials === undefined) {
    return { kind: 'done', message: `${id}: route created, but this profile mounts no credential provider to store the key` }
  }
  try {
    await credentials.set(credentialRef, apiKey)
  } catch (error) {
    return { kind: 'done', message: `${id}: route created; the key could not be stored behind ${credentialRef}: ${messageOf(error)}` }
  }
  return { kind: 'done', message: `${id}: route created, key stored behind ${credentialRef}` }
}

/**
 * The discovery identity for a draft that does not exist yet: a one-shot key
 * when one is typed, sent once and never stored by this frontend, or nothing
 * at all when the endpoint needs none.
 * @param apiKey - the draft's current normalized key, when it has one.
 * @returns the identity fragment for {@link editModels}'s request.
 */
function keyIdentity(apiKey: string | undefined): Pick<LlmModelDiscoveryRequestRead, 'apiKey'> {
  return apiKey === undefined ? {} : { apiKey }
}

/**
 * Ask for a header name, re-asking until it is usable or the reader backs out.
 * @param ctx - context carrying the slot registry.
 * @param view - the flow's own view name, so the chrome keeps saying where this is.
 * @param taken - names already in the draft, for the case-insensitive collision check.
 * @returns the trimmed name, or undefined when the reader backed out.
 */
async function promptHeaderName(
  ctx: Context,
  view: string,
  taken: readonly string[],
): Promise<string | undefined> {
  let detail: string | undefined
  for (;;) {
    const typed = await promptText(ctx, {
      title: 'Header name',
      view,
      message: 'Sent with every request this route makes, for example X-Tenant-Id.',
      ...detail === undefined ? {} : { detail },
      kind: 'text',
    })
    if (typed === undefined) return undefined
    const problem = headerNameProblem(typed, taken)
    if (problem !== undefined) {
      detail = problem
      continue
    }
    return typed.trim()
  }
}

/**
 * Ask for a header value, re-asking until it is usable or the reader backs out.
 *
 * An empty answer is a legal header value, not a cancellation, so it is
 * returned as `''` and only `undefined` means the reader left.
 * @param ctx - context carrying the slot registry.
 * @param view - the flow's own view name.
 * @param name - the header being given a value, shown as the title.
 * @param initial - the value to prefill, empty when adding.
 * @returns the value, or undefined when the reader backed out.
 */
async function promptHeaderValue(
  ctx: Context,
  view: string,
  name: string,
  initial: string,
): Promise<string | undefined> {
  let detail: string | undefined
  for (;;) {
    const typed = await promptText(ctx, {
      title: name,
      view,
      message: `The value sent as ${name}.`,
      ...detail === undefined ? {} : { detail },
      kind: 'text',
      initial,
    })
    if (typed === undefined) return undefined
    const problem = headerValueProblem(typed)
    if (problem !== undefined) {
      detail = problem
      continue
    }
    return typed
  }
}

/**
 * The request-headers sub-menu: add, change a value, or remove, until done.
 *
 * There is no rename action. A name and a value are one header, so renaming is
 * removing one and adding another, and offering it as a third verb would only
 * hide that a route briefly has neither spelling — the draft is in memory, so
 * doing it in two steps costs nothing and reads as what it is.
 *
 * Values ARE shown here, unlike on the summary row this opens from — and even
 * here only for the row under the cursor, because a `description` is what a
 * select renders for the highlighted choice alone. That is a deliberate
 * narrowing rather than a claim about the content: a value can be an
 * `Authorization` bearer or a signed gateway token, and this frontend has no
 * way to tell one from a tenant tag. It reaches here unredacted only because
 * `headers` carries no `credential-ref` role and `redactSecrets` therefore does
 * not strip it — which places the field outside Harness's redaction contract,
 * and says nothing about whether what it holds is sensitive.
 *
 * So the rule is about intent, not classification. A reader who opened this
 * submenu and moved onto a header's row asked to see that header; an editor
 * that hid the value it was about to write could not be used to repair a route
 * that does not work. Everywhere a reader did NOT ask — the route menu they
 * pass through on the way to everything else — shows names alone.
 * @param ctx - context carrying the slot registry.
 * @param view - the flow's own view name.
 * @param entries - the draft as the reader opened it.
 * @returns the draft after every add, edit, and removal.
 */
async function editHeaders(
  ctx: Context,
  view: string,
  entries: readonly HeaderDraftEntry[],
): Promise<HeaderDraftEntry[]> {
  /** Marks a choice value as one header's row, carrying its index. */
  const ROW_PREFIX = 'header:'
  let current = [...entries]
  for (;;) {
    const choice = await promptSelect(ctx, {
      title: 'Request headers',
      view,
      detail: 'Sent with every request this route makes. Harness attribution wins a reserved name.',
      choices: [
        { value: '__add', label: '+ Add header' },
        // Keyed by position, not by name. `__add` and `__done` are legal HTTP
        // field names, so a row carrying its own name as the choice value would
        // let a header called `__done` close the menu instead of opening. The
        // index is also unambiguous for a `settings.yaml` hand-edited to carry
        // two spellings of one name, where a lookup by name finds only the first.
        ...current.map((entry, index) => ({
          value: `${ROW_PREFIX}${String(index)}`,
          label: entry.name,
          description: entry.value === '' ? '(empty)' : entry.value,
        })),
        { value: '__done', label: 'Done' },
      ],
    })
    if (choice === undefined || choice === '__done') return current
    if (choice === '__add') {
      const name = await promptHeaderName(ctx, view, current.map(entry => entry.name))
      if (name === undefined) continue
      const value = await promptHeaderValue(ctx, view, name, '')
      if (value === undefined) continue
      current = upsertHeader(current, name, value)
      continue
    }
    const targetIndex = Number(choice.slice(ROW_PREFIX.length))
    const target = current[targetIndex]
    if (!choice.startsWith(ROW_PREFIX) || target === undefined) continue
    const next = await promptSelect(ctx, {
      title: target.name,
      view,
      choices: [
        { value: 'edit', label: 'Edit value' },
        { value: 'remove', label: 'Remove header' },
        { value: 'back', label: 'Back' },
      ],
    })
    if (next === 'remove') {
      // By index, not by name: two rows can share a case-folded name (a
      // hand-edited `settings.yaml` carrying both `X-Test` and `x-test`), and
      // `removeHeader` would drop every row that folds to it instead of only
      // the one the reader selected.
      current = current.filter((_entry, index) => index !== targetIndex)
      continue
    }
    if (next === 'edit') {
      const value = await promptHeaderValue(ctx, view, target.name, target.value)
      // By index too, for the same reason: `upsertHeader` would update the
      // first row matching this name, which is a different row when the draft
      // holds two case spellings of it.
      if (value !== undefined) {
        current = current.map((entry, index) => index === targetIndex ? { name: entry.name, value } : entry)
      }
    }
  }
}

/** What leaving the models submenu produced. */
interface ModelsEditResult {
  /** The model list as it stands when the reader chose Done. */
  readonly entries: ModelDraftEntry[]
  /**
   * Whether the entries would actually WRITE something different from the
   * list the submenu was opened with — never merely whether the submenu was
   * entered. A fetch that found candidates nobody adopted, or a toggle
   * immediately undone, both compare equal to the starting list and report
   * `false`: opening this submenu must be side-effect free, so its caller can
   * tell "inherited, still inherited" apart from "inherited, now customized"
   * without special-casing any one path through it.
   */
  readonly changed: boolean
}

/**
 * The models sub-menu: toggle, add, or fetch, looping until the reader is done.
 *
 * The list means different things in the two modes, and says so. An explicit
 * route lists its `models` entries, where inclusion is membership in the
 * written array. An inherited route lists stored overrides as included rows and
 * the installed catalog's ids as unincluded ones, where editing a field writes
 * that one `modelOverrides.<id>` and leaving the rest alone. A stored override
 * that came from the composition base rather than the user layer is shown but
 * locked: removing it could not be expressed as a user-layer op, so pretending
 * to would be a save that silently did nothing.
 * @param ctx - context carrying the slot registry.
 * @param seams - the Harness seams.
 * @param settingsNs - the namespace whose registered discovery serves this draft.
 * @param identity - `{ provider }` for an existing route, so the owning adapter
 *   can resolve its own stored headers and credential; `{ apiKey }` for a route
 *   that does not exist yet, sent once and never stored by this frontend.
 * @param baseURL - the draft's current endpoint.
 * @param api - the draft's current protocol, when one is chosen.
 * @param entries - the draft's current model list.
 * @param storage - which field an edited entry writes.
 * @param schema - the schema-derived entry fields and vocabularies.
 * @param ownedOverrideIds - the ids the user layer already overrides.
 * @param discoveryNote - a standing caveat about what this fetch can carry,
 *   shown until a fetch replaces it. `LlmModelDiscoveryRequest` names only a
 *   provider, endpoint, protocol, and one-shot key, so a draft's request
 *   headers reach the endpoint only once the route exists for the adapter to
 *   resolve them from — the caller words that for its own flow.
 * @returns the model list after every toggle, add, and adopted fetch, and
 *   whether it would write anything different from `entries`.
 */
async function editModels(
  ctx: Context,
  seams: ConnectSeams,
  settingsNs: string,
  identity: Pick<LlmModelDiscoveryRequestRead, 'provider' | 'apiKey'>,
  baseURL: string,
  api: string,
  entries: readonly ModelDraftEntry[],
  storage: ModelStorage,
  schema: RouteModelSchema,
  ownedOverrideIds: ReadonlySet<string>,
  discoveryNote?: string,
): Promise<ModelsEditResult> {
  let current = [...entries]
  if (storage === 'override' && identity.provider !== undefined) {
    // The installed catalog is the only set of ids an override may name, and no
    // generic seam publishes it as such. `listModels` is the registry's own
    // read of an ACTIVE route's models, which for a catalog route is that
    // catalog; ids only, never their values, so opening this menu cannot pin a
    // catalog name or capacity into an override nobody asked for. A route that
    // cannot be listed keeps whatever is already stored.
    try {
      const catalog = await seams.llm.listModels(identity.provider)
      current = addCandidates(current, catalog.map(model => ({ id: model.id })), 'override')
    } catch {
      // Not listable right now; manual ids and an endpoint fetch remain.
    }
  }
  let notice: string | undefined
  for (;;) {
    // A fetch result is transient and clears on the next pass; the discovery
    // note is a standing condition of this whole submenu, so it is what the
    // detail line falls back to rather than something shown once and lost.
    const detail = notice ?? discoveryNote
    const choice = await promptSelect(ctx, {
      title: 'Models',
      view: 'Models',
      ...detail === undefined ? {} : { detail },
      choices: [
        {
          value: '__fetch',
          label: 'Fetch available models',
          description: 'Advisory: asks the endpoint what it advertises, then lets you choose which to adopt',
        },
        { value: '__add', label: '+ Add model manually' },
        ...current.map(entry => ({
          value: entry.id,
          label: `${entry.included ? '✓' : '○'} ${entry.id}`,
          description: modelSummary(entry),
        })),
        { value: '__done', label: 'Done' },
      ],
    })
    notice = undefined
    if (choice === undefined || choice === '__done') {
      return {
        entries: current,
        changed: storage === 'override' ? !sameOverrideSet(current, entries) : !sameModelSet(current, entries),
      }
    }
    if (choice === '__fetch') {
      try {
        const request: LlmDiscoveredModelRequest = { ...identity, baseURL, ...api === '' ? {} : { api } }
        const candidates = await seams.llm.discoverModels(settingsNs, request)
        current = addCandidates(current, candidates, storage)
        notice = `found ${String(candidates.length)} model${candidates.length === 1 ? '' : 's'}; unchecked ones are new`
      } catch (error) {
        notice = `could not fetch models: ${messageOf(error)}`
      }
      continue
    }
    if (choice === '__add') {
      const added = await promptNewModel(ctx, current, storage)
      if (added.ok) current = added.entries
      else if (added.reason !== undefined) notice = added.reason
      continue
    }
    const target = current.find(entry => entry.id === choice)
    if (target === undefined) continue
    const locked = storage === 'override' && target.included && !ownedOverrideIds.has(target.id)
    const next = await promptSelect(ctx, {
      title: target.id,
      view: 'Models',
      ...locked
        ? { detail: 'This override comes from the composition base, not your settings; edit settings.yaml to change it.' }
        : {},
      choices: [
        ...locked ? [] : [{
          value: 'toggle',
          label: toggleLabel(target, storage),
        }],
        ...locked ? [] : [{ value: 'edit', label: 'Edit fields' }],
        { value: 'back', label: 'Back' },
      ],
    })
    if (next === 'toggle') current = toggleIncluded(current, target.id)
    else if (next === 'edit') current = await replaceEntry(current, await editModelFields(ctx, target, schema))
  }
}

/** The row-menu verb for one entry, which depends on the storage and its state. */
function toggleLabel(entry: ModelDraftEntry, storage: ModelStorage): string {
  if (storage === 'override') return entry.included ? 'Remove override' : 'Override this model'
  return entry.included ? 'Remove from list' : 'Include in list'
}

/**
 * Replace one entry in the draft, by id.
 * @param entries - the draft.
 * @param updated - the entry's new shape.
 * @returns the draft with that entry replaced.
 */
function replaceEntry(entries: readonly ModelDraftEntry[], updated: ModelDraftEntry): ModelDraftEntry[] {
  return entries.map(entry => entry.id === updated.id ? updated : entry)
}

/** What `ctx.llm.discoverModels` takes; named locally so `editModels` reads narrowly. */
type LlmDiscoveredModelRequest = LlmModelDiscoveryRequestRead

/**
 * The description under one model row in the menu.
 * @param entry - the draft entry.
 * @returns the facts worth showing, joined for one line.
 */
function modelSummary(entry: ModelDraftEntry): string {
  const facts: string[] = []
  if (entry.name !== undefined) facts.push(entry.name)
  if (entry.contextWindow !== undefined) facts.push(`${String(entry.contextWindow)} ctx`)
  if (entry.maxTokens !== undefined) facts.push(`${String(entry.maxTokens)} max out`)
  if (entry.input !== undefined) facts.push(entry.input.length === 0 ? 'no input' : entry.input.join('/'))
  if (entry.reasoningEfforts === false) facts.push('no reasoning')
  else if (entry.reasoningEfforts !== undefined) {
    facts.push(`reasoning ${Object.keys(entry.reasoningEfforts).join(',')}`)
  }
  return facts.join(' · ')
}

/**
 * A one-line reading of a draft's input modalities.
 * @param value - the declared list, or undefined for inherited.
 * @param vocab - the schema's vocabulary, for a stable word.
 * @returns the summary text.
 */
function inputSummary(value: readonly string[] | undefined, vocab: readonly string[]): string {
  if (value === undefined) return 'inherited'
  if (value.length === 0) return 'none declared'
  return vocab.filter(entry => value.includes(entry)).join(', ')
}

/**
 * A one-line reading of a draft's reasoning capability.
 * @param value - the declared value, or undefined for inherited.
 * @returns the summary text.
 */
function reasoningSummary(value: ReasoningEffortsValue | undefined): string {
  if (value === undefined) return 'inherited'
  if (value === false) return 'disabled'
  const levels = Object.entries(value).map(([level, wire]) => wire === null ? level : `${level}=${wire}`)
  return levels.length === 0 ? '(nothing declared)' : levels.join(', ')
}

/**
 * Ask for one capacity field, re-asking on an invalid answer.
 * @param ctx - context carrying the slot registry.
 * @param view - the flow's own view name.
 * @param title - the field's name.
 * @param initial - the field's current value, prefilled.
 * @returns the parsed count, or undefined both when left blank and when cancelled.
 */
async function promptOptionalCapacity(
  ctx: Context,
  view: string,
  title: string,
  initial: number | undefined,
): Promise<number | undefined | 'cancel'> {
  let detail: string | undefined
  for (;;) {
    const raw = await promptText(ctx, {
      title,
      view,
      message: `${title}. Leave blank to omit.`,
      ...detail === undefined ? {} : { detail },
      kind: 'text',
      initial: initial === undefined ? '' : String(initial),
    })
    if (raw === undefined) return 'cancel'
    const parsed = parseCapacity(raw)
    if (parsed.ok) return parsed.value
    detail = parsed.reason
  }
}

/**
 * Walk the add-model form and append the result.
 *
 * Only the id is required; the curated capabilities are left for the fields
 * menu, so adding an id never freezes values the reader did not choose.
 * @param ctx - context carrying the slot registry.
 * @param entries - the draft before this add.
 * @param storage - which field a later write addresses, matching the draft.
 * @returns the updated draft, or the refusal reason when one applies.
 */
async function promptNewModel(
  ctx: Context,
  entries: readonly ModelDraftEntry[],
  storage: ModelStorage,
): Promise<{ ok: true; entries: ModelDraftEntry[] } | { ok: false; reason: string | undefined }> {
  const id = await promptText(ctx, { title: 'Model id', view: 'Add model', message: 'The id this route should offer.', kind: 'text' })
  if (id === undefined || id.trim() === '') return { ok: false, reason: undefined }
  const result = addManual(entries, {
    id: id.trim(),
    name: undefined,
    contextWindow: undefined,
    maxTokens: undefined,
    input: undefined,
    reasoningEfforts: undefined,
  }, storage)
  return result.ok ? { ok: true, entries: result.entries } : { ok: false, reason: result.reason }
}

/**
 * The staged fields form for one model entry.
 *
 * Name, capacities, and the schema-derived capabilities live one level in, and
 * nothing here touches settings. The entry is marked included only when a field
 * actually changed, so opening this menu on a catalog model and backing out
 * writes no empty override.
 * @param ctx - context carrying the slot registry.
 * @param target - the entry being edited.
 * @param schema - the schema-derived entry fields and vocabularies.
 * @returns the entry after the reader leaves; unchanged when nothing changed.
 */
async function editModelFields(
  ctx: Context,
  target: ModelDraftEntry,
  schema: RouteModelSchema,
): Promise<ModelDraftEntry> {
  const entry = schema.entry
  if (entry === undefined) return target
  let current = { ...target }
  let dirty = false
  for (;;) {
    const advanced = entry.input.length > 0 || entry.reasoningLevels.length > 0
    const choice = await promptSelect(ctx, {
      title: target.id,
      view: 'Edit model',
      choices: [
        ...entry.name
          ? [{ value: 'name', label: 'Display name', description: current.name ?? '(inherit)' }]
          : [],
        ...entry.contextWindow !== undefined
          ? [{ value: 'context', label: 'Context window', description: describeCapacity(current.contextWindow) }]
          : [],
        ...entry.maxTokens !== undefined
          ? [{ value: 'max', label: 'Max output tokens', description: describeCapacity(current.maxTokens) }]
          : [],
        ...advanced
          ? [{
            value: 'advanced',
            label: 'Advanced',
            description: `input ${inputSummary(current.input, entry.input)} · reasoning ${reasoningSummary(current.reasoningEfforts)}`,
          }]
          : [],
        { value: 'back', label: 'Back' },
      ],
    })
    if (choice === undefined || choice === 'back') {
      return dirty ? { ...current, included: true } : target
    }
    if (choice === 'name') {
      const typed = await promptText(ctx, {
        title: 'Display name',
        view: 'Edit model',
        message: 'Optional; leave blank to inherit the catalog name.',
        kind: 'text',
        initial: current.name ?? '',
      })
      if (typed !== undefined) {
        current = { ...current, name: typed.trim() === '' ? undefined : typed.trim() }
        dirty = true
      }
      continue
    }
    if (choice === 'context') {
      const value = await promptOptionalCapacity(ctx, 'Edit model', 'Context window', current.contextWindow)
      if (value !== 'cancel') {
        current = { ...current, contextWindow: value }
        dirty = true
      }
      continue
    }
    if (choice === 'max') {
      const value = await promptOptionalCapacity(ctx, 'Edit model', 'Max output tokens', current.maxTokens)
      if (value !== 'cancel') {
        current = { ...current, maxTokens: value }
        dirty = true
      }
      continue
    }
    if (choice === 'advanced') {
      const updated = await editAdvanced(ctx, current, entry)
      if (updated !== undefined) {
        current = updated
        dirty = true
      }
    }
  }
}

/**
 * The advanced capability menu: the schema-derived modalities and reasoning.
 * @param ctx - context carrying the slot registry.
 * @param current - the entry as it stands.
 * @param entry - the schema-derived field availability and vocabularies.
 * @returns the updated entry, or undefined when the reader backed out unchanged.
 */
async function editAdvanced(
  ctx: Context,
  current: ModelDraftEntry,
  entry: ModelEntrySchema,
): Promise<ModelDraftEntry | undefined> {
  let working = { ...current }
  let dirty = false
  for (;;) {
    const choice = await promptSelect(ctx, {
      title: 'Advanced',
      view: 'Edit model',
      choices: [
        ...entry.input.length > 0
          ? [{ value: INPUT_FIELD, label: 'Input modalities', description: inputSummary(working.input, entry.input) }]
          : [],
        ...entry.reasoningLevels.length > 0 || entry.reasoningCanDisable
          ? [{ value: REASONING_EFFORTS_FIELD, label: 'Reasoning capability', description: reasoningSummary(working.reasoningEfforts) }]
          : [],
        { value: 'back', label: 'Back' },
      ],
    })
    if (choice === undefined || choice === 'back') return dirty ? working : undefined
    if (choice === INPUT_FIELD) {
      const value = await editInputModalities(ctx, working.input, entry.input)
      if (value !== 'cancel') {
        working = { ...working, input: value }
        dirty = true
      }
      continue
    }
    if (choice === REASONING_EFFORTS_FIELD) {
      const value = await editReasoningEfforts(ctx, working.reasoningEfforts, entry)
      if (value !== 'cancel') {
        working = { ...working, reasoningEfforts: value.value }
        dirty = true
      }
    }
  }
}

/**
 * Toggle the schema's modalities on and off.
 *
 * An empty answer is a declaration of nothing, which `llm-pi-ai` reads exactly
 * like the absent field — so it is returned as `undefined` and the key is
 * dropped rather than stored as `[]`, keeping the profile saying what it means.
 * @param ctx - context carrying the slot registry.
 * @param selected - the entry's current declared list.
 * @param vocab - the schema-derived modality vocabulary.
 * @returns the chosen list (undefined for inherit), or `'cancel'`.
 */
async function editInputModalities(
  ctx: Context,
  selected: readonly string[] | undefined,
  vocab: readonly string[],
): Promise<readonly string[] | undefined | 'cancel'> {
  let current = selected === undefined ? [] : [...selected]
  for (;;) {
    const choice = await promptSelect(ctx, {
      title: 'Input modalities',
      view: 'Edit model',
      detail: 'Unselected means inherit the installed catalog, then the route default.',
      choices: [
        ...vocab.map(modality => ({
          value: `m:${modality}`,
          label: `${current.includes(modality) ? '✓' : '○'} ${modality}`,
        })),
        { value: '__clear', label: 'Inherit (declare none)' },
        { value: '__done', label: 'Done' },
      ],
    })
    if (choice === undefined) return 'cancel'
    if (choice === '__done') return current.length === 0 ? undefined : current
    if (choice === '__clear') {
      current = []
      continue
    }
    const modality = choice.startsWith('m:') ? choice.slice(2) : undefined
    if (modality === undefined || !vocab.includes(modality)) continue
    // Vocabulary order, so a save writes the levels in the schema's own order
    // rather than the order a reader happened to toggle them.
    current = current.includes(modality)
      ? current.filter(entry => entry !== modality)
      : vocab.filter(entry => entry === modality || current.includes(entry))
  }
}

/**
 * The declared reasoning capability: inherit, disabled, or a level mapping.
 * @param ctx - context carrying the slot registry.
 * @param current - the entry's declared value.
 * @param entry - the schema-derived field availability and vocabularies.
 * @returns the chosen value, or `'cancel'` when the reader backed out.
 */
async function editReasoningEfforts(
  ctx: Context,
  current: ReasoningEffortsValue | undefined,
  entry: ModelEntrySchema,
): Promise<{ readonly value: ReasoningEffortsValue | undefined } | 'cancel'> {
  for (;;) {
    const choice = await promptSelect(ctx, {
      title: 'Reasoning capability',
      view: 'Edit model',
      choices: [
        { value: 'inherit', label: 'Inherit from installed catalog', description: current === undefined ? '(current)' : '' },
        ...entry.reasoningCanDisable
          ? [{ value: 'disabled', label: 'Disabled — this model does not reason', description: current === false ? '(current)' : '' }]
          : [],
        {
          value: 'mapping',
          label: 'Custom mapping…',
          description: current === false || current === undefined ? '' : reasoningSummary(current),
        },
        { value: 'back', label: 'Back' },
      ],
    })
    if (choice === undefined || choice === 'back') return 'cancel'
    if (choice === 'inherit') return { value: undefined }
    if (choice === 'disabled') return { value: false }
    const mapped = await editReasoningMapping(ctx, current === false || current === undefined ? undefined : current, entry.reasoningLevels)
    if (mapped !== 'cancel') return { value: mapped }
  }
}

/**
 * The per-level mapping editor.
 *
 * Nothing here judges the mapping's semantics — a level left undeclared, an
 * empty wire value, or a mapping that offers nothing beyond `off` are all built
 * as typed and handed to Harness, whose refusal is what the reader sees. A
 * local validator would be a second copy of a rule `llm-pi-ai` already owns.
 * @param ctx - context carrying the slot registry.
 * @param current - the entry's current mapping, when it has one.
 * @param levels - the schema-derived level vocabulary.
 * @returns the mapping, or `'cancel'`.
 */
async function editReasoningMapping(
  ctx: Context,
  current: Record<string, string | null> | undefined,
  levels: readonly string[],
): Promise<Record<string, string | null> | 'cancel'> {
  let mapping: Record<string, string | null> = current === undefined ? {} : { ...current }
  for (;;) {
    const choice = await promptSelect(ctx, {
      title: 'Reasoning mapping',
      view: 'Edit model',
      detail: 'Each level maps to the wire value dispatch should send; "off" alone may send nothing.',
      choices: [
        ...levels.map(level => ({
          value: `l:${level}`,
          label: `${mapping[level] === undefined ? '○' : '✓'} ${level}`,
          description: mapping[level] === undefined ? 'not offered' : mapping[level] === null ? 'supported, send nothing' : mapping[level] ?? '',
        })),
        { value: '__done', label: 'Done' },
        { value: '__back', label: 'Back' },
      ],
    })
    if (choice === undefined || choice === '__back') return 'cancel'
    if (choice === '__done') return mapping
    const level = choice.startsWith('l:') ? choice.slice(2) : undefined
    if (level === undefined || !levels.includes(level)) continue
    const action = await promptSelect(ctx, {
      title: level,
      view: 'Edit model',
      choices: [
        { value: 'none', label: 'Not offered' },
        ...level === 'off' ? [{ value: 'nothing', label: 'Supported, send nothing' }] : [],
        { value: 'wire', label: 'Send a wire value…' },
        { value: 'back', label: 'Back' },
      ],
    })
    if (action === 'none') {
      const { [level]: _removed, ...kept } = mapping
      mapping = kept
      continue
    }
    if (action === 'nothing') {
      mapping = { ...mapping, [level]: null }
      continue
    }
    if (action === 'wire') {
      const typed = await promptText(ctx, {
        title: `${level} wire value`,
        view: 'Edit model',
        message: 'The value dispatch sends for this level.',
        kind: 'text',
        initial: typeof mapping[level] === 'string' ? mapping[level] : '',
      })
      if (typed !== undefined) mapping = { ...mapping, [level]: typed }
    }
  }
}

/**
 * A capacity's menu description.
 * @param value - the declared number, or undefined for inherited.
 * @returns the summary text.
 */
function describeCapacity(value: number | undefined): string {
  return value === undefined ? '(inherit)' : String(value)
}
