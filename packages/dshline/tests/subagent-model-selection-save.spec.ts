/**
 * The subagent authorization editor's write path, and its seam with `/model`.
 *
 * Harness owns the validation and the session policy; what is pinned here is
 * that this frontend writes through the generic settings document only, in one
 * revision-fenced mutation, and that saving it can never reach the current
 * Agent's model selection or the default-model setting.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { stripAnsi } from '@dshline/renderer'
import { pickModel } from '../src/model.ts'
import { openSubagentModelSelection } from '../src/subagent-model-selection/index.ts'
import type { TuiOverlay } from '../src/slots.ts'

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
          ns: 'subagent-model-selection',
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
} {
  const stack: TuiOverlay[] = []
  return {
    slots: {
      pushOverlay(overlay) {
        stack.push(overlay)
        return () => {
          const index = stack.indexOf(overlay)
          if (index >= 0) stack.splice(index, 1)
        }
      },
      invalidate: () => {},
    },
    top: () => stack.at(-1),
    depth: () => stack.length,
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
 * @returns the mounted stack, the committed lines, and the running promise.
 */
async function openEditor(
  settings: FakeSettings,
  overrides: { llm?: unknown; settings?: unknown; withoutSettings?: boolean } = {},
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
  await vi.waitFor(() => { expect(view.text()).toContain('Selection') })
}

/** A named key. */
function key(name: string): { kind: 'key'; name: string } {
  return { kind: 'key', name }
}

describe('reading the Host setting', () => {
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
    view.stack.top()?.handleKey(key('escape'))
    await view.running
  })

  it('reports a value it cannot read rather than treating it as empty', async () => {
    const settings = fakeSettings({ enabled: false, allowedModels: [] })
    const view = await openEditor(settings, {
      settings: { describe: () => [{ ns: 'subagent-model-selection', value: { enabled: 'yes' }, revision: 1 }], mutate: async () => {} },
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
    expect(shown).toContain('Allowed     1 model')
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
    expect(settings.writes[0]?.ns).toBe('subagent-model-selection')
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
    expect(view.text()).toContain('Allowed     1 model')
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
    expect(view.text()).toContain('Allowed     1 model')
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
  function selectionOn(): ModelSelectionRef {
    return {
      current: { provider: 'deepseek-official', model: 'deepseek-chat' },
      assembled: undefined,
    } as unknown as ModelSelectionRef
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
    stack.top()?.handleKey(key('ctrl-k'))
    // Pushed synchronously, so a keystroke arriving before any await — a fast
    // enter — cannot settle the picker out from under the editor.
    expect(stack.depth()).toBe(2)
    // The editor is on top; the picker is still the row beneath it.
    expect(stripAnsi(stack.top()?.render(100, 30).join('\n') ?? '')).toContain('Subagent models')
    // Saving the authorization never touches the current selection.
    await vi.waitFor(() => {
      expect(stripAnsi(stack.top()?.render(100, 30).join('\n') ?? '')).toContain('Selection')
    })
    stack.top()?.handleKey({ kind: 'text', text: ' ' })
    stack.top()?.handleKey({ kind: 'text', text: 'e' })
    // Enabling with one route selected is valid, so this writes.
    stack.top()?.handleKey({ kind: 'text', text: 's' })
    await vi.waitFor(() => { expect(settings.writes.length).toBe(1) })
    expect(selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
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
    expect(opened).toEqual([])
    stack.top()?.handleKey(key('escape'))
    stack.top()?.handleKey(key('escape'))
    await running
  })
})
