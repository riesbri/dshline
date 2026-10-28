/**
 * The subagent authorization editor's write path, and its seam with `/model`.
 *
 * Harness owns the validation and the session policy; what is pinned here is
 * that this frontend writes through the generic settings document only, in one
 * revision-fenced mutation, and that saving it can never reach the current
 * Agent's model selection or the default-model setting.
 */
import { WindowModel } from '../src/window-model.ts'

import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Model } from '@deepseek-ai/dsh-agent'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { stripAnsi } from '@dshline/renderer'
import type { Key, KeyName } from '@dshline/renderer'
import { pickModel } from '../src/model.ts'
import { openSubagentModelSelection } from '../src/subagent-model-selection/index.ts'
import { SUBAGENT_MODEL_SELECTION_NAMESPACE } from '../src/subagent-model-selection/model.ts'
import type { TuiOverlay } from '../src/slots.ts'

/**
 * The settings namespace this editor reads and writes.
 *
 * A namespace in the adopted generation is the profile ENTRY ID of the plugin
 * whose own `static Config` declares the fields — the row
 * `packages/dshline/cordis.patch.yml` inserts for
 * `@deepseek-ai/dsh-tool-subagent/model-selection-settings` — and not a name
 * some plugin registered at runtime, which the previous generation used. The
 * retired name is gone, so writing to it now throws `No configurable plugin
 * entry`.
 *
 * Spelled as a literal rather than imported, on purpose: a fake that described
 * the document with the source constant would agree with a constant that had
 * drifted from the composed row, and the only test that can catch that drift is
 * one holding an id the source did not choose.
 */
const SELECTION_NAMESPACE = 'subagent-model-selection-settings'

/** Two routes, one of which the saved value does not authorize yet. */
const CATALOG: Record<string, readonly { id: string; name: string }[]> = {
  'deepseek-official': [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ],
  opencode: [{ id: 'kimi', name: 'Kimi' }],
}

/** One write the editor asked its settings document to perform. */
interface Write {
  readonly ns: string
  readonly ops: readonly SettingsPathOp[]
  readonly revision: number | undefined
}

/** A settings document the editor can read and write. */
interface FakeSettings {
  readonly settings: {
    describe(options?: { redactSecrets?: boolean }): readonly { ns: string; value: unknown; revision: number }[]
    mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
  }
  readonly writes: Write[]
  readonly describeOptions: ({ redactSecrets?: boolean } | undefined)[]
  readonly stored: () => { enabled: boolean; allowedModels: { provider: string; model: string }[] }
  /** Move the document under the editor, as a concurrent writer would. */
  setRevision(revision: number): void
  /** Make the next mutation reject, whatever its revision. */
  failNext(error: Error): void
  /** Hold the next mutation open, returning the release for it. */
  deferNext(): () => void
}

/**
 * A fake `ctx.settings` over one in-memory section.
 * @param initial - the stored value.
 * @param revision - the raw-section revision to report.
 * @returns the seam and the controls a test needs.
 */
function fakeSettings(
  initial: { enabled: boolean; allowedModels: readonly { provider: string; model: string }[] },
  revision = 7,
): FakeSettings {
  let value = {
    enabled: initial.enabled,
    allowedModels: initial.allowedModels.map(route => ({ provider: route.provider, model: route.model })),
  }
  let current = revision
  let failure: Error | undefined
  let gate: Promise<void> | undefined
  let release: (() => void) | undefined
  const writes: Write[] = []
  const describeOptions: ({ redactSecrets?: boolean } | undefined)[] = []
  return {
    settings: {
      describe(options) {
        describeOptions.push(options)
        return [{
          ns: SELECTION_NAMESPACE,
          value: { enabled: value.enabled, allowedModels: value.allowedModels.map(route => ({ ...route })) },
          revision: current,
        }]
      },
      async mutate(ns, ops, expectedRevision) {
        writes.push({ ns, ops, revision: expectedRevision })
        if (gate !== undefined) await gate
        if (failure !== undefined) {
          const error = failure
          failure = undefined
          throw error
        }
        if (expectedRevision !== current) {
          throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
        }
        for (const op of ops) {
          if (op.op !== 'set') continue
          if (op.path[0] === 'enabled') value = { ...value, enabled: op.value as boolean }
          if (op.path[0] === 'allowedModels') {
            value = { ...value, allowedModels: op.value as { provider: string; model: string }[] }
          }
        }
        current += 1
      },
    },
    writes,
    describeOptions,
    stored: () => value,
    setRevision: next => { current = next },
    failNext: error => { failure = error },
    deferNext: () => {
      gate = new Promise<void>(resolve => { release = resolve })
      return () => {
        gate = undefined
        release?.()
      }
    },
  }
}

/** A mounted overlay stack that behaves like `ctx.tuiSlots`. */
function slots(): {
  slots: { pushOverlay(overlay: TuiOverlay): () => void; invalidate(): void }
  top: () => TuiOverlay | undefined
  depth: () => number
  /** How many repaints the slot registry was asked for. */
  invalidations: () => number
  /**
   * Remove every overlay the way `TuiSlots` teardown does: drop the
   * registrations first, then dispose each one. This is the external-removal
   * path, distinct from an overlay dismissing itself.
   */
  teardown: () => void
} {
  const stack: TuiOverlay[] = []
  let invalidations = 0
  return {
    slots: {
      pushOverlay(overlay) {
        stack.push(overlay)
        return () => {
          const index = stack.indexOf(overlay)
          if (index >= 0) stack.splice(index, 1)
          // The real registry disposes an overlay after removing it.
          overlay.dispose?.()
        }
      },
      invalidate: () => { invalidations += 1 },
    },
    top: () => stack.at(-1),
    depth: () => stack.length,
    invalidations: () => invalidations,
    teardown: () => {
      for (const overlay of stack.splice(0)) overlay.dispose?.()
    },
  }
}

/** The llm registry over the fixture catalog. */
const llm = {
  listProviders: () => Object.keys(CATALOG).map(id => ({ id, name: id })),
  listModels: async (provider: string) => CATALOG[provider] ?? [],
}

/**
 * Open the editor over a fresh fake context.
 * @param settings - the settings document.
 * @param overrides - substitutions for the llm registry or the settings lookup.
 * @param controls - the initiating gesture's lifetime, when the editor is opened
 *   as a child of one; the direct `/plugins`-style callers pass none.
 * @returns the mounted stack, the committed lines, and the running promise.
 */
async function openEditor(
  settings: FakeSettings,
  overrides: { llm?: unknown; settings?: unknown; withoutSettings?: boolean } = {},
  controls: { mayAct?: () => boolean; signal?: AbortSignal } = {},
): Promise<{
  stack: ReturnType<typeof slots>
  committed: string[]
  running: Promise<void>
  text: () => string
}> {
  const stack = slots()
  const committed: string[] = []
  const services: Record<string, unknown> = {
    settings: overrides.withoutSettings === true ? undefined : overrides.settings ?? settings.settings,
  }
  const ctx = {
    llm: overrides.llm ?? llm,
    tuiSlots: stack.slots,
    get: (name: string) => services[name],
  } as unknown as Context
  const running = openSubagentModelSelection({
    ctx,
    commit: lines => { committed.push(...lines) },
    ...controls,
  })
  await vi.waitFor(() => { expect(stack.top()).toBeDefined() })
  return {
    stack,
    committed,
    running,
    text: () => stripAnsi(stack.top()?.render(100, 30).join('\n') ?? ''),
  }
}

/** Wait until the mounted surface is the ready editor. */
async function readyEditor(view: Awaited<ReturnType<typeof openEditor>>): Promise<void> {
  // `Allowed` exists only once the reading resolves; `Selection` also appears
  // in the heading paragraph, so it cannot prove the editor is ready.
  await vi.waitFor(() => { expect(view.text()).toContain('Allowed') })
}

/**
 * Await an editor's lifecycle promise under a bounded deadline.
 *
 * The contract is that `openSubagentModelSelection` finishes once the editor
 * is gone, however it went. Racing a deadline turns a violated contract into a
 * named failure instead of a suite-wide timeout.
 * @param running - the promise `openSubagentModelSelection` returned.
 * @param ms - the deadline in milliseconds.
 * @returns once the promise resolves.
 */
async function settlesWithin(running: Promise<void>, ms = 1_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('openSubagentModelSelection never settled')) }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * A named key.
 *
 * Typed as the renderer's own key vocabulary rather than a bare string, so a
 * gesture this editor does not handle fails to compile instead of reaching
 * `handleKey` as a key nothing can act on.
 * @param name - the key the reader pressed.
 * @returns the keystroke.
 */
function key(name: KeyName): Key {
  return { kind: 'key', name }
}

describe('reading the Host setting', () => {
  it('addresses the profile entry id the patch layer inserts, not a registered name', () => {
    // The whole migration in one assertion: the retired runtime-registered name
    // is no longer a configurable plugin entry, so writing to it throws rather
    // than saving, and the constant has to be the row id this bundle composes.
    expect(SUBAGENT_MODEL_SELECTION_NAMESPACE).toBe(SELECTION_NAMESPACE)
  })

  it('reads the namespace through describe with secrets redacted and never through the service singleton', async () => {
    const settings = fakeSettings({ enabled: true, allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-chat' }] })
    const requested: string[] = []
    const stack = slots()
    const ctx = {
      llm,
      tuiSlots: stack.slots,
      get: (name: string) => {
        requested.push(name)
        if (name === 'settings') return settings.settings
        if (name === 'subagentModelSelection') throw new Error('the singleton must not be the configuration authority')
        return undefined
      },
    } as unknown as Context
    const running = openSubagentModelSelection({ ctx, commit: () => {} })
    await vi.waitFor(() => { expect(stack.top()).toBeDefined() })
    await vi.waitFor(() => { expect(settings.describeOptions.length).toBeGreaterThan(0) })
    expect(settings.describeOptions[0]).toEqual({ redactSecrets: true })
    expect(requested).toContain('settings')
    expect(requested).not.toContain('subagentModelSelection')
    expect(settings.writes).toEqual([])
    stack.top()?.handleKey(key('escape'))
    await running
  })

  it('reports a profile with no settings provider instead of fabricating defaults', async () => {
    const settings = fakeSettings({ enabled: false, allowedModels: [] })
    const view = await openEditor(settings, { withoutSettings: true })
    expect(view.text()).toContain('mounts no settings provider')
    expect(settings.writes).toEqual([])
    view.stack.top()?.handleKey(key('escape'))
    await view.running
  })

  it('reports a profile where the namespace is not registered', async () => {
    const settings = fakeSettings({ enabled: false, allowedModels: [] })
    const view = await openEditor(settings, {
      settings: { describe: () => [], mutate: async () => {} },
    })
    expect(view.text()).toContain('is not registered')
    // The message names the namespace the reader would have to register or
    // patch, so a wrong id here is a sentence that cannot be acted on.
    expect(view.text()).toContain(SELECTION_NAMESPACE)
    view.stack.top()?.handleKey(key('escape'))
    await view.running
  })

  it('reports a value it cannot read rather than treating it as empty', async () => {
    const settings = fakeSettings({ enabled: false, allowedModels: [] })
    const view = await openEditor(settings, {
      settings: {
        describe: () => [{ ns: SELECTION_NAMESPACE, value: { enabled: 'yes' }, revision: 1 }],
        mutate: async () => {},
      },
    })
    expect(view.text()).toContain('could not be read')
    view.stack.top()?.handleKey(key('escape'))
    await view.running
  })

  it('reflects the descriptor: enabled, saved routes selected, new routes not', async () => {
    const settings = fakeSettings({
      enabled: true,
      allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-chat' }],
    })
    const view = await openEditor(settings)
    await readyEditor(view)
    const shown = view.text()
    expect(shown).toContain('Selection   on')
    expect(shown).toContain('Allowed     1 authorized model')
    expect(shown).toContain('[x] deepseek-official/deepseek-chat')
    // A route the catalog advertises but the setting never authorized is not
    // selected without a human checking it.
    expect(shown).toContain('[ ] deepseek-official/deepseek-reasoner')
    expect(shown).toContain('[ ] opencode/kimi')
    view.stack.top()?.handleKey(key('escape'))
    await view.running
  })
})

describe('saving the draft', () => {
  const SAVED = { enabled: true, allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-chat' }] }

  it('writes both fields in one mutation at the opening revision', async () => {
    const settings = fakeSettings(SAVED)
    const view = await openEditor(settings)
    await readyEditor(view)
    // Check the second route, then save.
    view.stack.top()?.handleKey(key('down'))
    view.stack.top()?.handleKey({ kind: 'text', text: ' ' })
    view.stack.top()?.handleKey({ kind: 'text', text: 's' })
    await vi.waitFor(() => { expect(settings.writes).toHaveLength(1) })
    expect(settings.writes[0]?.ns).toBe(SELECTION_NAMESPACE)
    expect(settings.writes[0]?.revision).toBe(7)
    expect(settings.writes[0]?.ops).toEqual([
      { op: 'set', path: ['enabled'], value: true },
      {
        op: 'set',
        path: ['allowedModels'],
        value: [
          { provider: 'deepseek-official', model: 'deepseek-chat' },
          { provider: 'deepseek-official', model: 'deepseek-reasoner' },
        ],
      },
    ])
    await vi.waitFor(() => { expect(view.stack.depth()).toBe(0) })
    expect(view.committed.join('\n')).toContain('applies to new sessions; current session unchanged')
    await view.running
  })

  it('retains a non-empty route list while disabling', async () => {
    const settings = fakeSettings(SAVED)
    const view = await openEditor(settings)
    await readyEditor(view)
    view.stack.top()?.handleKey({ kind: 'text', text: 'e' })
    view.stack.top()?.handleKey({ kind: 'text', text: 's' })
    await vi.waitFor(() => { expect(settings.writes).toHaveLength(1) })
    expect(settings.stored()).toEqual({ enabled: false, allowedModels: [SAVED.allowedModels[0]] })
    await view.running
  })

  it('refuses an enabled setting with nothing allowed, with zero writes', async () => {
    const settings = fakeSettings(SAVED)
    const view = await openEditor(settings)
    await readyEditor(view)
    // Uncheck the only route while selection stays on.
    view.stack.top()?.handleKey({ kind: 'text', text: ' ' })
    view.stack.top()?.handleKey({ kind: 'text', text: 's' })
    expect(settings.writes).toEqual([])
    expect(view.text()).toContain('at least one model')
    expect(view.stack.depth()).toBe(1)
    view.stack.top()?.handleKey(key('escape'))
    await view.running
  })

  it('makes escape and discard perform zero writes', async () => {
    const settings = fakeSettings(SAVED)
    const view = await openEditor(settings)
    await readyEditor(view)
    view.stack.top()?.handleKey({ kind: 'text', text: ' ' })
    view.stack.top()?.handleKey(key('escape'))
    expect(settings.writes).toEqual([])
    await view.running
  })

  it('keeps the draft and reports a revision conflict, then writes on an explicit second save', async () => {
    const settings = fakeSettings(SAVED)
    const view = await openEditor(settings)
    await readyEditor(view)
    settings.setRevision(9)
    view.stack.top()?.handleKey({ kind: 'text', text: 's' })
    await vi.waitFor(() => { expect(view.text()).toContain('changed elsewhere') })
    // The draft is intact and the editor is still open.
    expect(view.stack.depth()).toBe(1)
    expect(view.text()).toContain('Allowed     1 authorized model')
    // The second, explicit save fences against the refreshed revision.
    view.stack.top()?.handleKey({ kind: 'text', text: 's' })
    await vi.waitFor(() => { expect(settings.writes).toHaveLength(2) })
    expect(settings.writes[1]?.revision).toBe(9)
    await view.running
  })

  it('keeps the draft and reports a Harness refusal', async () => {
    const settings = fakeSettings(SAVED)
    const view = await openEditor(settings)
    await readyEditor(view)
    settings.failNext(new Error('enabled subagent model selection requires at least one allowed model'))
    view.stack.top()?.handleKey({ kind: 'text', text: 's' })
    await vi.waitFor(() => { expect(view.text()).toContain('requires at least one allowed model') })
    expect(view.stack.depth()).toBe(1)
    expect(view.text()).toContain('Allowed     1 authorized model')
    view.stack.top()?.handleKey(key('escape'))
    await view.running
  })

  it('preserves a staged toggle across a catalog refresh', async () => {
    const settings = fakeSettings(SAVED)
    const view = await openEditor(settings)
    await readyEditor(view)
    view.stack.top()?.handleKey(key('down'))
    view.stack.top()?.handleKey({ kind: 'text', text: ' ' })
    view.stack.top()?.handleKey(key('ctrl-r'))
    // Let the catalog reread land before saving, so the save is not refused
    // while the refresh is still in flight.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    view.stack.top()?.handleKey({ kind: 'text', text: 's' })
    await vi.waitFor(() => { expect(settings.writes).toHaveLength(1) })
    expect(settings.writes[0]?.ops[1]).toEqual({
      op: 'set',
      path: ['allowedModels'],
      value: [
        { provider: 'deepseek-official', model: 'deepseek-chat' },
        { provider: 'deepseek-official', model: 'deepseek-reasoner' },
      ],
    })
    await view.running
  })

  it('cannot be closed while a write is in flight', async () => {
    const settings = fakeSettings(SAVED)
    const view = await openEditor(settings)
    await readyEditor(view)
    const release = settings.deferNext()
    view.stack.top()?.handleKey({ kind: 'text', text: 's' })
    await vi.waitFor(() => { expect(view.text()).toContain('saving') })
    view.stack.top()?.handleKey(key('escape'))
    expect(view.stack.depth()).toBe(1)
    release()
    await vi.waitFor(() => { expect(view.stack.depth()).toBe(0) })
    await view.running
  })
})

describe('lifecycle', () => {
  it('settles when the registry tears the editor down externally, writing nothing', async () => {
    const settings = fakeSettings({
      enabled: true,
      allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-chat' }],
    })
    const view = await openEditor(settings)
    await readyEditor(view)
    // Exactly what `TuiSlots` teardown does: drop the registration, then
    // dispose the overlay. This never goes through the editor's Escape path.
    view.stack.teardown()
    await settlesWithin(view.running)
    expect(settings.writes).toEqual([])
    expect(view.committed).toEqual([])
    expect(view.stack.depth()).toBe(0)
  })

  it('settles and drops the acknowledgement when teardown lands during a save', async () => {
    const settings = fakeSettings({ enabled: true, allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-chat' }] })
    const view = await openEditor(settings)
    await readyEditor(view)
    const overlay = view.stack.top()
    expect(overlay).toBeDefined()
    // Count every disposal, so a second settle trying to dismiss a
    // registration that is already gone would be visible.
    let disposals = 0
    const dispose = overlay?.dispose
    if (overlay !== undefined) {
      overlay.dispose = () => { disposals += 1; dispose?.() }
    }
    const release = settings.deferNext()
    overlay?.handleKey({ kind: 'text', text: 's' })
    await vi.waitFor(() => { expect(view.text()).toContain('saving') })
    expect(settings.writes).toHaveLength(1)
    view.stack.teardown()
    await settlesWithin(view.running)
    release()
    // Let the landed mutation's continuation run.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(view.committed).toEqual([])
    expect(disposals).toBe(1)
    expect(view.stack.depth()).toBe(0)
  })
})

describe('catalog failures', () => {
  it('keeps healthy providers and saved authorization when one provider fails', async () => {
    const settings = fakeSettings({
      enabled: true,
      allowedModels: [
        { provider: 'deepseek-official', model: 'deepseek-chat' },
        { provider: 'private-gateway', model: 'gone' },
      ],
    })
    const view = await openEditor(settings, {
      llm: {
        listProviders: () => [
          { id: 'deepseek-official', name: 'DeepSeek' },
          { id: 'private-gateway', name: 'Private' },
        ],
        listModels: async (provider: string) => {
          if (provider === 'private-gateway') throw new Error('gateway down')
          return CATALOG[provider] ?? []
        },
      },
    })
    await readyEditor(view)
    const shown = view.text()
    expect(shown).toContain('could not list: private-gateway')
    expect(shown).toContain('[x] deepseek-official/deepseek-chat')
    expect(shown).toContain('[x] private-gateway/gone')
    expect(shown).toContain('unavailable')
    view.stack.top()?.handleKey(key('escape'))
    await view.running
  })

  it('keeps saved routes manageable when the registry itself cannot be listed', async () => {
    const settings = fakeSettings({ enabled: true, allowedModels: [{ provider: 'private-gateway', model: 'gone' }] })
    const view = await openEditor(settings, {
      llm: {
        listProviders: () => { throw new Error('no registry') },
        listModels: async () => [],
      },
    })
    await readyEditor(view)
    expect(view.text()).toContain('live catalog unavailable')
    expect(view.text()).toContain('[x] private-gateway/gone')
    view.stack.top()?.handleKey(key('escape'))
    await view.running
  })
})

describe('the /model seam', () => {
  /** A selection ref on a known route. */
  function selectionOn(): Model {
    return new WindowModel({ provider: 'deepseek-official', model: 'deepseek-chat' })
  }

  it('opens the editor on ctrl-k and leaves the picker mounted beneath it', async () => {
    const settings = fakeSettings({ enabled: false, allowedModels: [] })
    const stack = slots()
    const savedDefaults: unknown[] = []
    const ctx = {
      llm,
      tuiSlots: stack.slots,
      get: (name: string) => name === 'settings'
        ? settings.settings
        : name === 'agentDefaultModel'
          ? { saveSelection: async (next: unknown) => { savedDefaults.push(next) } }
          : undefined,
    } as unknown as Context
    const selection = selectionOn()
    const running = pickModel(ctx, selection, '', {
      onSubagentModels: () => { void openSubagentModelSelection({ ctx, commit: () => {} }) },
    })
    await vi.waitFor(() => { expect(stack.depth()).toBe(1) })
    // The picker advertises the gesture before the reader knows it exists.
    expect(stripAnsi(stack.top()?.render(100, 30).join('\n') ?? '')).toContain('ctrl-k subagents')
    stack.top()?.handleKey(key('ctrl-k'))
    // Pushed synchronously, so a keystroke arriving before any await — a fast
    // enter — cannot settle the picker out from under the editor.
    expect(stack.depth()).toBe(2)
    // The editor is on top; the picker is still the row beneath it.
    expect(stripAnsi(stack.top()?.render(100, 30).join('\n') ?? '')).toContain('Subagent models')
    // Saving the authorization never touches the current selection.
    await vi.waitFor(() => {
      expect(stripAnsi(stack.top()?.render(100, 30).join('\n') ?? '')).toContain('Allowed')
    })
    stack.top()?.handleKey({ kind: 'text', text: ' ' })
    stack.top()?.handleKey({ kind: 'text', text: 'e' })
    // Enabling with one route selected is valid, so this writes.
    stack.top()?.handleKey({ kind: 'text', text: 's' })
    await vi.waitFor(() => { expect(settings.writes.length).toBe(1) })
    expect(selection.current()).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(savedDefaults).toEqual([])
    // Closing the editor reveals the picker again; escape then closes /model.
    await vi.waitFor(() => { expect(stack.depth()).toBe(1) })
    expect(stripAnsi(stack.top()?.render(100, 30).join('\n') ?? '')).toContain('Select a model')
    stack.top()?.handleKey(key('escape'))
    await expect(running).resolves.toBeUndefined()
  })

  it('keeps a bare k as search input rather than opening the editor', async () => {
    const opened: number[] = []
    const stack = slots()
    const settings = fakeSettings({ enabled: false, allowedModels: [] })
    // Past the searchable threshold, so typed characters are query input.
    const many = {
      listProviders: () => [{ id: 'gateway', name: 'Gateway' }],
      listModels: async () => Array.from({ length: 20 }, (_, index) => ({ id: `model-${String(index)}`, name: '' })),
    }
    const ctx = {
      llm: many,
      tuiSlots: stack.slots,
      get: (name: string) => name === 'settings' ? settings.settings : undefined,
    } as unknown as Context
    const running = pickModel(ctx, selectionOn(), '', { onSubagentModels: () => { opened.push(1) } })
    await vi.waitFor(() => { expect(stack.depth()).toBe(1) })
    stack.top()?.handleKey({ kind: 'text', text: 'k' })
    await vi.waitFor(() => {
      expect(stripAnsi(stack.top()?.render(100, 30).join('\n') ?? '')).toContain('⌕ k')
    })
    // The advertised gesture is a key, not text: the footer still names it
    // while the typed `k` filters.
    expect(stripAnsi(stack.top()?.render(100, 30).join('\n') ?? '')).toContain('ctrl-k subagents')
    expect(opened).toEqual([])
    stack.top()?.handleKey(key('escape'))
    stack.top()?.handleKey(key('escape'))
    await running
  })
})

describe('a retired initiating gesture', () => {
  const SAVED = { enabled: true, allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-chat' }] }

  it('withdraws the overlay and detaches from the signal', async () => {
    const settings = fakeSettings(SAVED)
    const controller = new AbortController()
    const view = await openEditor(settings, {}, {
      mayAct: () => !controller.signal.aborted,
      signal: controller.signal,
    })
    await readyEditor(view)
    expect(view.stack.depth()).toBe(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    controller.abort()
    await view.running
    // The overlay is gone, and the signal that outlives every editor opened
    // against it retains nothing.
    expect(view.stack.depth()).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('admits no new save, even from a key still addressed to the overlay', async () => {
    const settings = fakeSettings(SAVED)
    const controller = new AbortController()
    const view = await openEditor(settings, {}, {
      mayAct: () => !controller.signal.aborted,
      signal: controller.signal,
    })
    await readyEditor(view)
    // Held across the retirement: a key decoded in the same batch as the
    // retirement can still be handed to the surface it was decoded for.
    const top = view.stack.top()
    controller.abort()
    top?.handleKey({ kind: 'text', text: 'e' })
    top?.handleKey({ kind: 'text', text: 's' })
    expect(settings.writes).toEqual([])
    await view.running
  })

  it('lets an already-submitted write land, without a late acknowledgement', async () => {
    const settings = fakeSettings(SAVED)
    const controller = new AbortController()
    const view = await openEditor(settings, {}, {
      mayAct: () => !controller.signal.aborted,
      signal: controller.signal,
    })
    await readyEditor(view)
    // Submit, then hold the write open so retirement lands while it is in
    // flight — the case the acknowledgement has to be suppressed for.
    const release = settings.deferNext()
    view.stack.top()?.handleKey({ kind: 'text', text: 'e' })
    view.stack.top()?.handleKey({ kind: 'text', text: 's' })
    await vi.waitFor(() => { expect(settings.writes).toHaveLength(1) })
    controller.abort()
    release()
    await view.running
    // The write the reader asked for while this epoch owned the screen is NOT
    // rolled back...
    expect(settings.stored().enabled).toBe(false)
    // ...and a retired epoch commits no acknowledgement into a transcript it no
    // longer owns.
    expect(view.committed.join('\n')).not.toContain('applies to new sessions')
    expect(view.stack.depth()).toBe(0)
  })
})

describe('a catalog read that lands after the editor is gone', () => {
  const SAVED = { enabled: true, allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-chat' }] }

  /**
   * The registry with its roster held open until the test releases it.
   * @returns the registry and the two ways to settle the read.
   */
  function heldCatalog() {
    let settleGate = () => {}
    let failGate = () => {}
    const gate = new Promise((resolve, reject) => { settleGate = resolve; failGate = reject })
    return {
      llm: {
        listProviders: () => Object.keys(CATALOG).map(id => ({ id, name: id })),
        listModels: async (provider) => { await gate; return CATALOG[provider] ?? [] },
      },
      release: () => { settleGate() },
      fail: error => { failGate(error) },
    }
  }

  it.each(['resolves', 'rejects'])('is dropped when it %s after Escape', async settlement => {
    // The confirmed reproduction: hold the roster, close the editor, then let
    // the read finish. The editor owns no screen, so its repaint would land on
    // a frame that belongs to whatever replaced it.
    const settings = fakeSettings(SAVED)
    const held = heldCatalog()
    const view = await openEditor(settings, { llm: held.llm })
    await vi.waitFor(() => { expect(view.stack.top()).toBeDefined() })
    view.stack.top()?.handleKey(key('escape'))
    await settlesWithin(view.running)
    const before = view.stack.invalidations()
    if (settlement === 'resolves') held.release()
    else held.fail(new Error('the catalog is unavailable'))
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(view.stack.depth()).toBe(0)
    expect(view.stack.invalidations()).toBe(before)
  })

  it('is dropped when it lands after the attachment retired', async () => {
    const settings = fakeSettings(SAVED)
    const held = heldCatalog()
    const controller = new AbortController()
    const view = await openEditor(settings, { llm: held.llm }, {
      mayAct: () => !controller.signal.aborted,
      signal: controller.signal,
    })
    await vi.waitFor(() => { expect(view.stack.top()).toBeDefined() })
    controller.abort()
    await settlesWithin(view.running)
    const before = view.stack.invalidations()
    held.release()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(view.stack.depth()).toBe(0)
    expect(view.stack.invalidations()).toBe(before)
  })
})
