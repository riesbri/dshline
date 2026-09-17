/**
 * `/model`'s subagent authorization editor, opened with `ctrl-k`.
 *
 * The Host setting `subagent-model-selection` is the only durable
 * authorization authority, and the generic `ctx.settings` document is the only
 * way this module reads or writes it. Nothing here reads
 * `ctx.subagentModelSelection`, records a Session event, or routes a child:
 * Harness samples the setting for the next composed top-level Session and its
 * delegation executor enforces the recorded policy.
 *
 * The editor is a staged draft against the revision it opened on. `esc` writes
 * nothing; only Save performs the one mutation, which sets both fields
 * together under that revision so a concurrent change is refused rather than
 * merged.
 * @module dshline/subagent-model-selection
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { paint } from '@dshline/renderer'
import { modelRouteKey, readModelCatalog } from '../model-catalog.ts'
import {
  SUBAGENT_MODEL_SELECTION_NAMESPACE,
  authorizedRoutes,
  draftFrom,
  joinEntries,
  saveRefusal,
  selectionValueFrom,
  withEnabled,
  withToggled,
} from './model.ts'
import type {
  SubagentModelDraft,
  SubagentModelEntry,
  SubagentModelReading,
  SubagentModelRoute,
} from './model.ts'
import { createSubagentModelSelectionOverlay } from './overlay.ts'

/** The acknowledgement a landed save commits, once. */
const SAVED_MESSAGE = 'subagent model authorization updated · applies to new sessions; current session unchanged'

/** What opening the editor needs from the window it opens over. */
export interface SubagentModelSelectionSpec {
  /** Context carrying the generic settings document and the llm registry. */
  readonly ctx: Context
  /** Write the acknowledgement into the terminal's scrollback. */
  readonly commit: (lines: readonly string[]) => void
}

/**
 * Why a write was refused, worded for the reader.
 *
 * A revision conflict is not a generic failure: the draft is still valid, and
 * the reader has to decide whether to re-apply it. The `SETTINGS_CONFLICT`
 * code is read structurally rather than by importing the error class, so this
 * frontend keeps its type-only relationship with the settings package.
 * @param error - whatever `settings.mutate` rejected with.
 * @returns a sentence to show in the editor.
 */
function refusalMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT') {
    return 'this setting changed elsewhere; your draft is kept — save again to write it, or esc to discard'
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Show the subagent authorization editor and stay until the reader closes it.
 *
 * Pushed on top of the `/model` picker, so closing it returns to the picker.
 * @param spec - the context and where the acknowledgement goes.
 * @returns when the editor is closed.
 */
export async function openSubagentModelSelection(spec: SubagentModelSelectionSpec): Promise<void> {
  const { ctx, commit } = spec
  const settings = ctx.get('settings')
  let loading = true
  let failure: string | undefined
  let entries: readonly SubagentModelEntry[] = []
  let failedProviders: readonly string[] = []
  let catalogError: string | undefined
  let draft: SubagentModelDraft = { enabled: false, selected: new Map() }
  let refusal: string | undefined
  let saving = false
  // The routes the setting held when the editor opened, kept for stable write
  // order. Refresh never updates this, nor the opening revision.
  let saved: readonly SubagentModelRoute[] = []
  let revision: number | undefined
  let busy = false
  let closed = false
  let dismiss = (): void => {}
  let resolveOpen = (): void => {}

  const invalidate = (): void => { ctx.tuiSlots.invalidate() }
  /**
   * Complete the editor exactly once, from either way it can end.
   *
   * A normal close asks this to remove its own registration; an external
   * `TuiSlots` teardown has ALREADY removed it before calling the overlay's
   * `dispose`, so that path must not call the disposer again. Both paths
   * resolve the promise `openSubagentModelSelection` awaits, which is the
   * lifecycle contract: once the editor is gone — by escape, by a landed Save,
   * or by teardown — the caller finishes too.
   * @param dismissSelf - whether this completion should also remove the
   *   overlay; false from external disposal, which has already done so.
   */
  const finish = (dismissSelf: boolean): void => {
    if (closed) return
    closed = true
    if (dismissSelf) dismiss()
    resolveOpen()
  }
  const settle = (): void => { finish(true) }
  const readingOf = (): SubagentModelReading => {
    if (loading) return { kind: 'loading' }
    if (failure !== undefined) return { kind: 'unavailable', message: failure }
    return { kind: 'ready', entries, failedProviders, catalogError, draft, refusal, saving }
  }
  /**
   * The routes the merged rows must keep even if the live catalog drops them.
   *
   * This is saved authorization plus anything checked in the draft, so a
   * refresh can never delete a staged choice — the catalog is advisory, and a
   * route it stops advertising stays visible and removable.
   * @returns the routes to keep in the merged list.
   */
  const keepRoutes = (): SubagentModelRoute[] => {
    const keep = saved.map(route => ({ provider: route.provider, model: route.model }))
    const present = new Set(keep.map(route => modelRouteKey(route.provider, route.model)))
    for (const route of draft.selected.values()) {
      const key = modelRouteKey(route.provider, route.model)
      if (present.has(key)) continue
      present.add(key)
      keep.push({ provider: route.provider, model: route.model })
    }
    return keep
  }
  const readCatalog = async (): Promise<void> => {
    try {
      const catalog = await readModelCatalog(ctx)
      entries = joinEntries(catalog.routes, keepRoutes())
      failedProviders = catalog.failedProviders
      catalogError = undefined
    } catch (error: unknown) {
      // `listProviders()` itself failed, so no live route could be read.
      // Saved authorization must still be manageable, so the merged list is
      // built from the retained routes alone; the `unavailable` kind is NOT
      // used here because it carries no entries at all.
      entries = joinEntries([], keepRoutes())
      failedProviders = []
      catalogError = error instanceof Error ? error.message : String(error)
    }
  }
  /**
   * Re-read the setting and the catalog from scratch. This is the open and the
   * retry after an unavailable read; it is the only path that moves `revision`.
   */
  const loadAll = async (): Promise<void> => {
    if (busy || saving) return
    busy = true
    loading = true
    failure = undefined
    refusal = undefined
    invalidate()
    try {
      const descriptors = settings?.describe({ redactSecrets: true }) ?? []
      const descriptor = descriptors.find(candidate => candidate.ns === SUBAGENT_MODEL_SELECTION_NAMESPACE)
      const value = descriptor === undefined ? undefined : selectionValueFrom(descriptor.value)
      if (settings === undefined) {
        failure = 'this profile mounts no settings provider, so subagent model authorization cannot be read or changed'
      } else if (descriptor === undefined) {
        failure = `the ${SUBAGENT_MODEL_SELECTION_NAMESPACE} setting is not registered in this profile`
      } else if (value === undefined) {
        failure = `the ${SUBAGENT_MODEL_SELECTION_NAMESPACE} setting could not be read`
      } else {
        revision = descriptor.revision
        saved = value.allowedModels.map(route => ({ provider: route.provider, model: route.model }))
        draft = draftFrom(value)
        await readCatalog()
      }
    } finally {
      busy = false
      loading = false
      invalidate()
    }
  }
  /** Re-read only the live catalog; the draft and the opening revision stay. */
  const refreshCatalog = async (): Promise<void> => {
    if (busy || saving) return
    busy = true
    try {
      await readCatalog()
    } finally {
      busy = false
      invalidate()
    }
  }
  /**
   * Refresh the revision a later Save fences against, after a conflict.
   *
   * The draft and its baseline route order are deliberately untouched: the
   * reader was told the document moved, and a second explicit Save is their
   * decision. This is not a silent retry — nothing is written here.
   */
  const refreshRevision = (): void => {
    const descriptors = settings?.describe({ redactSecrets: true }) ?? []
    const descriptor = descriptors.find(candidate => candidate.ns === SUBAGENT_MODEL_SELECTION_NAMESPACE)
    if (descriptor !== undefined && selectionValueFrom(descriptor.value) !== undefined) {
      revision = descriptor.revision
    }
  }
  const save = (): void => {
    if (saving) return
    if (busy) {
      // A catalog refresh is in flight. Saying so beats a key that silently
      // does nothing while the footer still advertises it.
      refusal = 'the live catalog is still being read; save again in a moment'
      invalidate()
      return
    }
    const blocked = saveRefusal(draft)
    if (blocked !== undefined) {
      refusal = blocked
      invalidate()
      return
    }
    if (settings === undefined || revision === undefined) {
      refusal = 'subagent model authorization cannot be written in this profile'
      invalidate()
      return
    }
    // Both fields in ONE revision-fenced mutation. Written separately, the
    // first could persist an enabled setting with no routes, which Harness
    // rejects — and the second could apply over a document that moved.
    const ops: SettingsPathOp[] = [
      { op: 'set', path: ['enabled'], value: draft.enabled },
      {
        op: 'set',
        path: ['allowedModels'],
        value: authorizedRoutes(saved, draft.selected, entries)
          .map(route => ({ provider: route.provider, model: route.model })),
      },
    ]
    saving = true
    refusal = undefined
    invalidate()
    void settings.mutate(SUBAGENT_MODEL_SELECTION_NAMESPACE, ops, revision)
      .then(() => {
        // A window or session teardown can dispose the overlay while the write
        // is in flight; the acknowledgement then has no surface to land on.
        if (closed) return
        commit([paint(`· ${SAVED_MESSAGE}`, 'muted')])
        settle()
      })
      .catch((error: unknown) => {
        // A teardown can dispose the surface while the write is in flight;
        // there is no reader left to report a refusal to.
        if (closed) return
        saving = false
        // The draft stays open with the reader's edit intact: a conflict is
        // theirs to resolve, and a Harness refusal is the authority speaking.
        // A conflict also refreshes the revision so a second explicit Save is
        // fenced against the document as it now stands.
        if (typeof error === 'object' && error !== null
          && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT') refreshRevision()
        refusal = refusalMessage(error)
        invalidate()
      })
  }

  await new Promise<void>(resolve => {
    resolveOpen = resolve
    const overlay = createSubagentModelSelectionOverlay({
      reading: readingOf,
      toggle: entry => {
        if (saving) return
        draft = withToggled(draft, entry.route)
        refusal = undefined
        invalidate()
      },
      flipEnabled: () => {
        if (saving) return
        draft = withEnabled(draft, !draft.enabled)
        refusal = undefined
        invalidate()
      },
      save,
      refresh: () => {
        if (failure !== undefined || revision === undefined) void loadAll()
        else void refreshCatalog()
      },
      close: settle,
      invalidate,
    })
    // Registration is already gone when `TuiSlots` calls this, so it completes
    // without dismissing again — but it still resolves the caller's promise.
    overlay.dispose = () => { finish(false) }
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
    void loadAll()
  })
}
