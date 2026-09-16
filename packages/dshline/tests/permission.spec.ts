/** Harness permission catalog/selection presentation and bare-command decoration tests. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import type { Config, PermissionCatalog, PermissionSelection } from '@deepseek-ai/dsh-permission-presets'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createScope } from '@deepseek-ai/dsh-scope'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { permissionPicker } from '../src/permission.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/**
 * What the mocked Setup conductor does next: apply one route and acknowledge it,
 * or do nothing at all (a refusal or dismissal).
 *
 * Setup's real flow is covered by `setup-flow.spec.ts`; here it only has to
 * prove the attachment's `onModelChanged` boundary turns an applied change into
 * a notice without Setup knowing anything about attention.
 */
const SETUP = vi.hoisted(() => ({ next: undefined as { provider: string; model: string } | undefined }))
vi.mock('../src/setup/index.ts', () => ({
  runSetup: async (spec: { selection: { current: unknown }; onModelChanged: () => void }) => {
    if (SETUP.next === undefined) return
    spec.selection.current = SETUP.next
    spec.onModelChanged()
  },
}))

/** A deployment-defined catalog, deliberately unlike dsh-base's preset table. */
const CATALOG: PermissionCatalog = {
  options: [
    { value: 'review', name: 'Review only', description: 'Inspect changes before they are applied.' },
    { value: 'normal', name: 'Normal work', description: 'Work in this project.' },
    { value: 'unrestricted', name: 'Unrestricted', description: 'Use the deployment-wide policy.' },
  ],
}

/** The conventional risk-bearing options, which have picker-only confirmations. */
const RISKY: PermissionCatalog = {
  options: [
    { value: 'workspace-write', name: 'Workspace Write', description: 'Work in this project.' },
    { value: 'danger-full-access', name: 'Full access', description: 'Run without approvals.' },
    { value: 'auto', name: 'Auto review', description: 'Review every call instead of sandboxing.' },
  ],
}

/** Let submission promises and queued redraws settle without waiting wall-clock time. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

/** One decoded key, sent through the attachment's real key route. */
function press(dispatch: (() => ((key: Key) => void) | undefined), key: Key): void {
  const handler = dispatch()
  expect(handler, 'the attached window must own input').toBeDefined()
  handler?.(key)
}

/** Type a line as individual terminal text events. */
function type(dispatch: () => ((key: Key) => void) | undefined, text: string): void {
  for (const character of [...text]) press(dispatch, { kind: 'text', text: character })
}

/** Mount the smallest assembled attachment capable of rendering and dispatching permissions. */
async function fixture(options: {
  /** The live process catalog `ctx.permissionPresets.catalog()` answers with. */
  readonly catalog?: PermissionCatalog
  /** The durable current selection the `permissions` projection carries. */
  readonly selection?: PermissionSelection
  readonly commandListed?: boolean
  /** Routes an adapter registers, for model discovery. */
  readonly providers?: readonly string[]
  /** Models each route advertises, keyed by route. */
  readonly models?: Record<string, readonly { id: string; name: string }[]>
  /** What the selected route advertises for reasoning, as the window caches it. */
  readonly reasoning?: LlmModelReasoningInfo
  /** The selection the window opens with. */
  readonly selected?: ModelSelectionRef['current']
  /** Mount a default-model service whose save rejects, for applied-but-unsaved. */
  readonly saveFailure?: boolean
} = {}): Promise<{
  readonly dispatch: () => ((key: Key) => void) | undefined
  readonly ctx: Context
  readonly commands: { readonly execute: ReturnType<typeof vi.fn> }
  /** Every live catalog read the decoration performed, in order. */
  readonly catalogReads: ReturnType<typeof vi.fn>
  readonly commits: string[][]
  readonly frames: string[][]
  /** Whether the window re-resolved model metadata. */
  readonly refreshModelInfo: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(TuiSlots)
  // The two authorities are mounted independently, exactly as Harness splits
  // them: a profile may compose either, both, or neither.
  const selection = options.selection
  if (selection !== undefined) {
    ctx.provide('sessionProjections', {
      snapshot: () => ({ asOfSeq: 0, values: { permissions: selection } }),
      onChanged: () => () => {},
    } as never)
  }
  const catalogReads = vi.fn(() => options.catalog)
  if (options.catalog !== undefined) {
    ctx.provide('permissionPresets', { catalog: catalogReads } as never)
  }
  const commands = {
    execute: vi.fn(async () => ({ kind: 'success' })),
    list: () => options.commandListed === false ? [] : [{
      name: 'permission', description: 'Switch the permission preset', input: { hint: '<preset>' },
    }],
  }
  ctx.provide('commands', commands as never)
  ctx.provide('tools', { get: () => undefined })
  ctx.provide('userQuestions', {} as never)
  ctx.provide('llm', {
    listProviders: () => (options.providers ?? []).map(id => ({ id, name: id })),
    listModels: async (provider: string) => options.models?.[provider] ?? [],
    resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model }),
  } as never)
  if (options.saveFailure === true) {
    ctx.provide('agentDefaultModel', {
      saveSelection: async () => { throw new Error('settings are read-only') },
    } as never)
  }

  const commits: string[][] = []
  const frames: string[][] = []
  const draw = (): void => { frames.push([...ctx.tuiSlots.compose(80, 24).lines]) }
  ctx.on('tui/render', draw)
  let dispatch: ((key: Key) => void) | undefined
  const refreshModelInfo = vi.fn()
  const window = {
    ctx,
    terminal: { columns: () => 80, rows: () => 24 },
    exit: undefined,
    startup: { cwd: '/ws', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: options.selected },
    modelInfo: { contextWindow: undefined, reasoning: options.reasoning },
    prefs: { usageMode: 'cost', timing: false, cardDetail: 'compact', reasoningVisible: true },
    colorDepth: 0,
    palette: () => ({}),
    setPalette: () => {},
    themeSettings: {},
    pendingTask: undefined,
    draw,
    paintNow: draw,
    commit: lines => { commits.push([...lines]) },
    clear: () => {},
    refreshModelInfo,
    setDispatch: (handler: ((key: Key) => void) | undefined) => { dispatch = handler },
    setExit: () => {},
  } as unknown as Window
  const session = {
    id: 'permission-test',
    header: { cwd: '/ws' },
    events: [],
    append(type: string, data: unknown): void {
      ctx.emit('session/event', session as never, { type, data } as never)
    },
  }
  const agent = {
    session,
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
  const outcome = {
    target: { kind: 'new', cwd: '/ws' },
    attached: { handle: { agent, dispose: async () => {} }, reopened: false },
  } as unknown as AttachOutcome
  void attachSession(window, outcome)
  return { dispatch: () => dispatch, ctx, commands, commits, frames, refreshModelInfo, catalogReads }
}

/** Most recently painted terminal frame, as a reader sees it. */
function frame(frames: readonly string[][]): string {
  return stripAnsi((frames.at(-1) ?? []).join('\n'))
}

/** Mount the actual permission service, command runtime, and projection registry. */
async function permissionHarness(config: Config): Promise<{ ctx: Context; session: Session }> {
  const ctx = await permissionContext(config)
  return { ctx, session: ctx.sessions.create(SessionId('permission-probe')) }
}

/**
 * Mount the real adopted-Harness services without creating a Session yet, so a
 * case can create more than one or restore an existing log.
 * @param config - the deployment preset table, or undefined to omit the whole
 *   optional permission capability and prove the footer's absence path.
 * @returns the mounted context.
 */
async function permissionContext(config?: Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('permission probe does not run bash') },
    run() { throw new Error('permission probe does not run bash') },
    start() { throw new Error('permission probe does not run bash') },
  } as never)
  await ctx.plugin(ApprovalService)
  // The capability is optional, exactly as in a profile: omitting it must leave
  // the projection key absent rather than a `unknown` placeholder.
  if (config !== undefined) await ctx.plugin(PermissionPresetService, config)
  return ctx
}

/** Mint an agent scope in the addressing shape the real command runtime expects. */
async function permissionAgent(ctx: Context, session: Session): Promise<Agent> {
  const agent = { id: session.id, session, inject: vi.fn() } as unknown as Agent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
  return agent
}

/** A real scoped Agent carrying the live fields the attachment reads each frame. */
async function attachedAgent(ctx: Context, session: Session): Promise<Agent> {
  const agent = await permissionAgent(ctx, session)
  Object.assign(agent as object, {
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  })
  return agent
}

/**
 * A window over a real context that captures every live-region frame it is
 * asked to compose, and can be handed one attachment after another exactly as
 * the session loop does.
 * @param ctx - the real context whose TuiSlots registry composes the frame.
 * @returns the captured frames and the attachment controls.
 */
function permissionWindow(ctx: Context): {
  readonly frames: string[][]
  readonly attach: (session: Session, agent: Agent, resumed?: boolean) => void
  readonly status: () => string
  readonly submit: (line: string) => void
  readonly settle: () => Promise<void>
} {
  const frames: string[][] = []
  let dispatch: ((key: Key) => void) | undefined
  const capture = (): void => { frames.push([...ctx.tuiSlots.compose(80, 24).lines]) }
  ctx.on('tui/render', capture)
  const window = {
    ctx,
    terminal: { columns: () => 80, rows: () => 24 },
    exit: undefined,
    startup: { cwd: '/ws', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: undefined },
    modelInfo: { contextWindow: undefined, reasoning: undefined },
    prefs: { usageMode: 'cost', timing: false, cardDetail: 'compact', reasoningVisible: true, busyEnter: 'queue' },
    colorDepth: 0,
    palette: () => ({}),
    setPalette: () => {},
    themeSettings: {},
    pendingTask: undefined,
    draw: capture,
    paintNow: capture,
    commit: () => {},
    clear: () => {},
    refreshModelInfo: () => {},
    setDispatch: (handler: ((key: Key) => void) | undefined) => { dispatch = handler },
    setExit: () => {},
  } as unknown as Window
  return {
    frames,
    attach: (session, agent, resumed = false) => {
      const outcome = {
        target: resumed ? { kind: 'resume', id: session.id } : { kind: 'new', cwd: '/ws' },
        attached: { handle: { agent, dispose: async () => {} }, reopened: resumed },
      } as unknown as AttachOutcome
      // Not awaited: the attachment intentionally parks on the next-target
      // promise, and every registration this case reads is made synchronously
      // before it does.
      void attachSession(window, outcome)
    },
    status: () => {
      const lines = frames.at(-1) ?? []
      return stripAnsi(lines[lines.length - 1] ?? '')
    },
    submit: line => {
      for (const character of [...line]) dispatch?.({ kind: 'text', text: character })
      dispatch?.({ kind: 'key', name: 'enter' })
    },
    settle: () => new Promise<void>(resolve => { setImmediate(resolve) }),
  }
}

/**
 * Mount the real permission stack plus TuiSlots and attach one fresh Session.
 * @param config - the deployment preset table, or undefined for the
 *   no-capability case.
 * @returns the context, the attached Session, and the window.
 */
async function attachedPermissionSession(config?: Config): Promise<{
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly window: ReturnType<typeof permissionWindow>
}> {
  const ctx = await permissionContext(config)
  await ctx.plugin(TuiSlots)
  ctx.provide('tools', { get: () => undefined })
  ctx.provide('userQuestions', {} as never)
  ctx.provide('llm', {} as never)
  const session = ctx.sessions.create(SessionId('permission-attachment'))
  const agent = await attachedAgent(ctx, session)
  const window = permissionWindow(ctx)
  window.attach(session, agent)
  return { ctx, session, agent, window }
}

/** The deployment table every real-Harness case below is configured with. */
const PRESETS: Config = {
  presets: {
    review: { sandbox: 'read-only', approval: 'ask', name: 'Review only', description: 'Inspect safely.' },
    normal: { sandbox: 'workspace-write', approval: 'ask', name: 'Normal work', description: 'Work normally.' },
  },
  defaultPreset: 'normal',
}

/** The configured table as Harness publishes it through the live catalog. */
const PRESET_OPTIONS = [
  { value: 'review', name: 'Review only', description: 'Inspect safely.' },
  { value: 'normal', name: 'Normal work', description: 'Work normally.' },
]

describe('real Harness permission capability', () => {
  it('splits the live selectable catalog from the durable current selection', async () => {
    // The acceptance case for the whole migration. Two authorities, two scopes:
    // the catalog is process-level and answers what may be chosen; the session
    // projection is durable and answers only what is chosen. Neither can
    // answer the other's question, and dshline stores neither.
    const { ctx, session } = await permissionHarness(PRESETS)
    expect(ctx.permissionPresets.catalog()).toEqual({ options: PRESET_OPTIONS })
    // The projection carries the selection and nothing else — in particular no
    // `options` key, which is what the previous generation folded in here.
    expect(ctx.sessionProjections.snapshot(session).values.permissions).toEqual({ currentValue: 'normal' })
  })

  it('changes the selection through the /permission command lifecycle', async () => {
    const { ctx, session } = await permissionHarness(PRESETS)
    const agent = await permissionAgent(ctx, session)
    const execution = await ctx.commands.execute(agent, '/permission review', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'preset review' })
    // A whole-log assertion, so a whole-log snapshot is the honest read.
    const logged = session.snapshotEvents()
    expect(logged.filter(event => event.type === 'command/run')).toHaveLength(1)
    expect(logged.filter(event => event.type === 'command/done')).toHaveLength(1)
    // The durable log-only intent event the attention notice reads, exactly as
    // Harness publishes it — the notice is derived from this, never from the
    // command's `preset review` prose. The last one is the switch; the session's
    // constructor seed pinned `normal` before any command ran.
    const presets = logged.filter(event => event.type === 'permission/preset')
    expect(presets.at(-1)?.data).toEqual({ preset: 'review' })
    expect(ctx.sessionProjections.snapshot(session).values.permissions?.currentValue).toBe('review')
    // The mutation moved the selection and left the catalog alone: selecting is
    // not contributing.
    expect(ctx.permissionPresets.catalog()).toEqual({ options: PRESET_OPTIONS })
  })

  it('joins the two real authorities for presentation without owning either', async () => {
    const { ctx, session } = await permissionHarness(PRESETS)
    // Exactly the two reads the bare-command decoration performs, against real
    // Harness values rather than fixtures.
    expect(permissionPicker(
      ctx.permissionPresets.catalog(),
      ctx.sessionProjections.snapshot(session).values.permissions,
    )).toEqual({
      detail: 'current: Normal work',
      currentValue: 'normal',
      choices: [
        { value: 'review', label: 'Review only', description: 'Inspect safely.' },
        { value: 'normal', label: 'Normal work', description: 'Work normally.' },
      ],
    })
  })

  it('reports a real custom selection without making it selectable', async () => {
    // `custom` is derived, not contributed: Harness reserves the name, refuses
    // it as a table entry, and never lists it in the catalog. Moving one knob
    // off every configured bundle is what actually produces it.
    const { ctx, session } = await permissionHarness(PRESETS)
    setApprovalPolicy(session, 'never')
    expect(ctx.sessionProjections.snapshot(session).values.permissions).toEqual({ currentValue: 'custom' })
    expect(ctx.permissionPresets.catalog().options.map(option => option.value)).not.toContain('custom')
    const picker = permissionPicker(
      ctx.permissionPresets.catalog(),
      ctx.sessionProjections.snapshot(session).values.permissions,
    )
    // Reported as current, highlighted as nothing, offered as nothing.
    expect(picker?.detail).toBe('current: custom')
    expect(picker?.currentValue).toBeUndefined()
    expect(picker?.choices.map(choice => choice.value)).toEqual(['review', 'normal'])
  })

  it('keeps a live catalog contribution out of durable session state', async () => {
    // The catalog changes while the session's own history does not. A frontend
    // that had copied the catalog into session-scoped state would be wrong in
    // both directions.
    //
    // "No durable state moved" is read from two supported live surfaces rather
    // than from a synchronous history snapshot: `session/event` is what Harness
    // publishes for every append, so no call means no append, and the
    // projection cut's `asOfSeq` cannot advance without one.
    const { ctx, session } = await permissionHarness(PRESETS)
    const appended = vi.fn()
    ctx.on('session/event', appended)
    const cutBefore = ctx.sessionProjections.snapshot(session).asOfSeq
    const changed = vi.fn()
    ctx.on('permission-presets/catalog-changed', changed)

    const dispose = ctx.permissionPresets.registerAuto(() => {})
    expect(changed).toHaveBeenCalledTimes(1)
    expect(ctx.permissionPresets.catalog().options.map(option => option.value)).toEqual(['review', 'normal', 'auto'])
    expect(appended).not.toHaveBeenCalled()
    expect(ctx.sessionProjections.snapshot(session).asOfSeq).toBe(cutBefore)
    expect(ctx.sessionProjections.snapshot(session).values.permissions).toEqual({ currentValue: 'normal' })

    await dispose()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(ctx.permissionPresets.catalog().options.map(option => option.value)).toEqual(['review', 'normal'])
    expect(appended).not.toHaveBeenCalled()
    expect(ctx.sessionProjections.snapshot(session).asOfSeq).toBe(cutBefore)

    // Positive control, so the two silent assertions above are a real claim
    // rather than a listener that was never wired: a genuine selection change
    // on the same session does reach both surfaces.
    ctx.permissionPresets.set(session, 'review')
    expect(appended.mock.calls.map(([, event]) => (event as { type: string }).type))
      .toContain('permission/preset')
    expect(ctx.sessionProjections.snapshot(session).asOfSeq).toBeGreaterThan(cutBefore)
  })

  it('leaves a withdrawn option for Harness to refuse rather than applying it', async () => {
    // A picker held open across `permission-presets/catalog-changed` can only
    // submit a command line, and the live catalog is what validates it. This is
    // why dshline needs no second catalog state machine to stay truthful.
    //
    // The assertion is the contract, not the copy: Harness refuses, and nothing
    // durable moves. An upstream rewording of its own error prose must not
    // break a dshline architecture probe, so the text is only checked for the
    // id it refused.
    const { ctx, session } = await permissionHarness(PRESETS)
    const agent = await permissionAgent(ctx, session)
    const dispose = ctx.permissionPresets.registerAuto(() => {})
    const stale = permissionPicker(
      ctx.permissionPresets.catalog(),
      ctx.sessionProjections.snapshot(session).values.permissions,
    )
    expect(stale?.choices.map(choice => choice.value)).toContain('auto')
    await dispose()

    const appended = vi.fn()
    ctx.on('session/event', appended)
    const cutBefore = ctx.sessionProjections.snapshot(session).asOfSeq
    const execution = await ctx.commands.execute(agent, '/permission auto', [], new AbortController().signal)

    expect(execution?.result?.kind).toBe('error')
    expect(execution?.result?.text).toContain('auto')
    // The withdrawn id was never applied, and dshline mutated nothing locally.
    expect(ctx.sessionProjections.snapshot(session).values.permissions).toEqual({ currentValue: 'normal' })
    expect(ctx.permissionPresets.current(session)).toBe('normal')
    // The command's own lifecycle is all that reached the log — the refusal was
    // recorded, no permission knob moved. Naming the whole list rather than one
    // absence keeps this from passing on an unwired listener.
    expect(appended.mock.calls.map(([, event]) => (event as { type: string }).type))
      .toEqual(['command/run', 'command/done'])
    expect(ctx.sessionProjections.snapshot(session).asOfSeq).toBeGreaterThan(cutBefore)
  })
})

describe('the status line’s current permission', () => {
  /**
   * The status row split into whole segments, as the shedding ladder joins
   * them. A permission id must be one segment, never part of the transient
   * `permission → …` attention notice beside it.
   * @param window - the attached window.
   * @returns the segments a person reads on the newest status row.
   */
  function segments(window: { status: () => string }): string[] {
    return window.status().split(' · ')
  }

  it('shows a freshly attached real Session’s initial Harness currentValue', async () => {
    // The attachment reads the adapter's own shared projection snapshot, so the
    // Session Harness just pinned reports its effective permission with no
    // dshline-owned state constructed anywhere.
    const { session, window } = await attachedPermissionSession(PRESETS)
    expect(segments(window)).toContain('normal')
    expect(session.snapshotEvents().some(event => event.type === 'permission/preset')).toBe(true)
  })

  it('updates live when the real /permission command changes Harness state', async () => {
    const { ctx, session, agent, window } = await attachedPermissionSession(PRESETS)
    expect(segments(window)).toContain('normal')

    const execution = await ctx.commands.execute(agent, '/permission review', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'preset review' })
    await window.settle()

    // The authoritative projection and the footer moved together; no restart,
    // reattachment, or local listener was needed.
    expect(ctx.sessionProjections.snapshot(session).values.permissions?.currentValue).toBe('review')
    expect(segments(window)).toContain('review')
    expect(segments(window)).not.toContain('normal')
  })

  it('updates when an independent approval change derives custom, not only a preset event', async () => {
    // The regression the picker-era code would have failed: the footer listens
    // to the `permissions` projection, which folds all three knobs. Moving
    // approval alone produces the derived `custom` and must repaint.
    const { session, window } = await attachedPermissionSession(PRESETS)
    expect(segments(window)).toContain('normal')
    const presetEventsBefore = session.snapshotEvents().filter(event => event.type === 'permission/preset').length

    setApprovalPolicy(session, 'never')
    await window.settle()

    expect(segments(window)).toContain('custom')
    // The move really was approval-only: it appended no new preset event.
    const types = session.snapshotEvents().map(event => event.type)
    expect(types).toContain('approval/policy')
    expect(types.filter(type => type === 'permission/preset')).toHaveLength(presetEventsBefore)
  })

  it('repaints a withdrawn live auto contribution with no Session event', async () => {
    // `auto` is a contribution rather than a table preset, and whether it is
    // live is a derivation INPUT, not Session history. Withdrawing it changes
    // what the next `permissions` snapshot derives from the same durable knobs,
    // but it publishes no projection frame and appends no Session event — so the
    // footer can only move when the catalog change is itself an invalidation
    // signal. `danger-full-access` is the bundle Auto writes, which makes the
    // post-withdrawal value deterministic without inventing a post-Auto preset.
    const auto: Config = {
      presets: {
        review: { sandbox: 'read-only', approval: 'ask' },
        normal: { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      },
      defaultPreset: 'normal',
    }
    const { ctx, session, window } = await attachedPermissionSession(auto)
    const disposeAuto = ctx.permissionPresets.registerAuto(() => {})
    ctx.permissionPresets.set(session, 'auto')
    await window.settle()
    expect(segments(window)).toContain('auto')
    expect(ctx.sessionProjections.snapshot(session).values.permissions?.currentValue).toBe('auto')

    // The durable log the permission was derived from does not move.
    const seqBefore = session.seq
    const eventsBefore = session.snapshotEvents().length

    await disposeAuto()
    await window.settle()

    // No Session event and no sequence advance was responsible for the change.
    expect(session.seq).toBe(seqBefore)
    expect(session.snapshotEvents()).toHaveLength(eventsBefore)
    // The next snapshot re-derives the same knobs against current availability,
    // and the footer repaints to exactly that value.
    expect(ctx.sessionProjections.snapshot(session).values.permissions?.currentValue).toBe('danger-full-access')
    expect(segments(window)).toContain('danger-full-access')
    expect(segments(window)).not.toContain('auto')
  })

  it('shows danger-full-access exactly and reinterprets nothing', async () => {
    // A deployment may name a preset after a sandbox mode. The footer must show
    // the opaque currentValue verbatim, not a catalog label or a risk glyph.
    const full: Config = {
      presets: { 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } },
      defaultPreset: 'danger-full-access',
    }
    const { window } = await attachedPermissionSession(full)
    expect(segments(window)).toContain('danger-full-access')
  })

  it('renders normally and omits permission when the capability is not composed', async () => {
    // No permissionPresets service means no `permissions` projection key at
    // all. That is capability absence, not a state to name `unknown`.
    const { window } = await attachedPermissionSession(undefined)
    expect(window.status()).toContain('ready')
    expect(window.status()).not.toContain('permission')
    expect(window.status()).not.toContain('unknown')
  })

  it('shows the newly attached Session’s permission and never the previous one', async () => {
    // Two real Sessions with different effective permissions in one context,
    // then the attachment changes exactly as the session loop changes it.
    const ctx = await permissionContext(PRESETS)
    await ctx.plugin(TuiSlots)
    ctx.provide('tools', { get: () => undefined })
    ctx.provide('userQuestions', {} as never)
    ctx.provide('llm', {} as never)
    const first = ctx.sessions.create(SessionId('permission-first'))
    const second = ctx.sessions.create(SessionId('permission-second'))
    ctx.permissionPresets.set(second, 'review')
    const window = permissionWindow(ctx)

    window.attach(first, await attachedAgent(ctx, first))
    expect(segments(window)).toContain('normal')
    expect(segments(window)).not.toContain('review')

    // `/new` retires the first attachment, as the loop's own switch does.
    window.submit('/new')
    await window.settle()
    window.attach(second, await attachedAgent(ctx, second), true)
    await window.settle()

    expect(segments(window)).toContain('review')
    expect(segments(window)).not.toContain('normal')
  })
})

describe('permissionPicker()', () => {
  it('preserves the live catalog’s opaque values, order, labels, and descriptions', () => {
    expect(permissionPicker(CATALOG, { currentValue: 'normal' })).toEqual({
      detail: 'current: Normal work',
      currentValue: 'normal',
      choices: [
        { value: 'review', label: 'Review only', description: 'Inspect changes before they are applied.' },
        { value: 'normal', label: 'Normal work', description: 'Work in this project.' },
        { value: 'unrestricted', label: 'Unrestricted', description: 'Use the deployment-wide policy.' },
      ],
    })
  })

  it('reports an unresolvable current value honestly and highlights nothing', () => {
    const picker = permissionPicker(CATALOG, { currentValue: 'custom' })
    expect(picker?.detail).toBe('current: custom')
    expect(picker?.currentValue).toBeUndefined()
    // No synthesised row was added so the picker could find its current value.
    expect(picker?.choices).toHaveLength(CATALOG.options.length)
  })

  it('does not infer choices when the catalog capability is absent', () => {
    expect(permissionPicker(undefined, { currentValue: 'normal' })).toBeUndefined()
  })

  it('does not invent a current state when the session selection is absent', () => {
    expect(permissionPicker(CATALOG, undefined)).toBeUndefined()
  })
})

describe('/thinking presentation command', () => {
  it('opens the selector and changes only the window presentation preference', async () => {
    const mounted = await fixture()
    type(mounted.dispatch, '/thinking')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).toContain('Thinking')
    expect(frame(mounted.frames)).toContain('Reasoning visibility')
    expect(frame(mounted.frames)).toContain('Shown')
    expect(frame(mounted.frames)).toContain('❯ Shown')
    expect(frame(mounted.frames)).toContain('Hidden')
    expect(frame(mounted.frames)).not.toContain('Hide reasoning; model behavior is unchanged')
    press(mounted.dispatch, { kind: 'key', name: 'down' })
    expect(frame(mounted.frames)).toContain('❯ Hidden')
    expect(frame(mounted.frames)).toContain('Hide reasoning; model behavior is unchanged')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(mounted.commands.execute).not.toHaveBeenCalled()
    expect(mounted.commits.flat().map(stripAnsi)).toContain('· thinking: hidden')
  })

  it('accepts /thinking off without changing model selection', async () => {
    const mounted = await fixture()
    type(mounted.dispatch, '/thinking off')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(mounted.commands.execute).not.toHaveBeenCalled()
    expect(mounted.commits.flat().map(stripAnsi)).toContain('· thinking: hidden')
  })

  it('accepts /thinking on as the inverse presentation choice', async () => {
    const mounted = await fixture()
    type(mounted.dispatch, '/thinking on')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(mounted.commands.execute).not.toHaveBeenCalled()
    expect(mounted.commits.flat().map(stripAnsi)).toContain('· thinking: shown')
  })

  it('rejects invalid thinking arguments cleanly', async () => {
    const mounted = await fixture()
    type(mounted.dispatch, '/thinking toggle')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(mounted.commits.flat().map(stripAnsi).join('\n')).toContain('/thinking takes on or off')
    expect(mounted.commands.execute).not.toHaveBeenCalled()
  })

  it('dismisses the thinking picker without transcript noise', async () => {
    const mounted = await fixture()
    type(mounted.dispatch, '/thinking')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    press(mounted.dispatch, { kind: 'key', name: 'escape' })
    await flush()
    expect(mounted.commands.execute).not.toHaveBeenCalled()
    expect(mounted.commits.flat().map(stripAnsi)).not.toContain('· thinking:')
  })
})

/** What a selected route advertises, for the /reasoning presentation tests. */
const REASONING = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ],
  defaultEffort: 'high',
} as unknown as LlmModelReasoningInfo

describe('/model and /reasoning presentation', () => {
  const MODELS = { openai: [{ id: 'gpt-x', name: 'GPT X' }] }

  it('marks a rejected model name as an error, never an acknowledgement', async () => {
    const mounted = await fixture({ providers: ['openai'], models: MODELS })
    type(mounted.dispatch, '/model does-not-exist')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    const rows = mounted.commits.flat().map(stripAnsi)
    expect(rows).toContain('✗ no model named does-not-exist; type /model to choose from 1')
    expect(rows.some(row => row.startsWith('· '))).toBe(false)
    // Nothing changed, so nothing re-resolves the route's metadata.
    expect(mounted.refreshModelInfo).not.toHaveBeenCalled()
  })

  it('marks an applied model change as a muted acknowledgement', async () => {
    const mounted = await fixture({ providers: ['openai'], models: MODELS })
    type(mounted.dispatch, '/model gpt-x')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    const rows = mounted.commits.flat().map(stripAnsi)
    expect(rows).toContain('· model set to openai / gpt-x')
    expect(rows.some(row => row.startsWith('✗'))).toBe(false)
    expect(mounted.refreshModelInfo).toHaveBeenCalledOnce()
  })

  it('marks a rejected reasoning level as an error, never an acknowledgement', async () => {
    const mounted = await fixture({
      selected: { provider: 'openai', model: 'gpt-x' },
      reasoning: REASONING,
    })
    type(mounted.dispatch, '/reasoning turbo')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    const rows = mounted.commits.flat().map(stripAnsi)
    expect(rows).toContain('✗ no reasoning level named turbo; try one of: off, high, max, default')
    expect(rows.some(row => row.startsWith('· '))).toBe(false)
  })

  it('marks an applied reasoning level as a muted acknowledgement', async () => {
    const mounted = await fixture({
      selected: { provider: 'openai', model: 'gpt-x' },
      reasoning: REASONING,
    })
    type(mounted.dispatch, '/reasoning high')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    const rows = mounted.commits.flat().map(stripAnsi)
    expect(rows).toContain('· reasoning effort set to high')
    expect(rows.some(row => row.startsWith('✗'))).toBe(false)
  })
})

describe('attention on applied selection changes', () => {
  const MODELS = { openai: [{ id: 'gpt-x', name: 'GPT X' }] }

  it('flashes a route notice when /model actually changes the model', async () => {
    const mounted = await fixture({ providers: ['openai'], models: MODELS })
    type(mounted.dispatch, '/model gpt-x')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).toContain('model → openai/gpt-x')
    // The durable acknowledgement is committed as well; the notice is emphasis.
    expect(mounted.commits.flat().map(stripAnsi)).toContain('· model set to openai / gpt-x')
  })

  it('stays quiet when /model selects the route already in force', async () => {
    const mounted = await fixture({
      providers: ['openai'],
      models: MODELS,
      selected: { provider: 'openai', model: 'gpt-x' },
    })
    type(mounted.dispatch, '/model gpt-x')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).not.toContain('model →')
  })

  it('stays quiet when /model fails', async () => {
    const mounted = await fixture({ providers: ['openai'], models: MODELS })
    type(mounted.dispatch, '/model does-not-exist')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).not.toContain('model →')
  })

  it('still flashes when the live route change could not be saved', async () => {
    // The ref is written before persistence, so the next turn really does use
    // the new model; a storage failure is a note, not an undo.
    const mounted = await fixture({ providers: ['openai'], models: MODELS, saveFailure: true })
    type(mounted.dispatch, '/model gpt-x')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).toContain('model → openai/gpt-x')
    expect(mounted.commits.flat().map(stripAnsi).join('\n')).toContain('could not save it as the default')
  })

  it('flashes when /reasoning changes the stored effort', async () => {
    const mounted = await fixture({
      selected: { provider: 'openai', model: 'gpt-x' },
      reasoning: REASONING,
    })
    type(mounted.dispatch, '/reasoning max')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).toContain('reasoning → max')
  })

  it('stays quiet when the same explicit effort is selected again', async () => {
    const mounted = await fixture({
      selected: { provider: 'openai', model: 'gpt-x', reasoningEffort: 'max' },
      reasoning: REASONING,
    })
    type(mounted.dispatch, '/reasoning max')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).not.toContain('reasoning →')
  })

  it('names the provider default when the explicit effort is cleared', async () => {
    const mounted = await fixture({
      selected: { provider: 'openai', model: 'gpt-x', reasoningEffort: 'max' },
      reasoning: REASONING,
    })
    type(mounted.dispatch, '/reasoning default')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).toContain('reasoning → provider default')
  })

  it('stays quiet when the reasoning instruction is refused', async () => {
    const mounted = await fixture({
      selected: { provider: 'openai', model: 'gpt-x' },
      reasoning: REASONING,
    })
    type(mounted.dispatch, '/reasoning turbo')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).not.toContain('reasoning →')
  })

  it('still flashes when the live effort change could not be saved', async () => {
    const mounted = await fixture({
      selected: { provider: 'openai', model: 'gpt-x' },
      reasoning: REASONING,
      saveFailure: true,
    })
    type(mounted.dispatch, '/reasoning max')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).toContain('reasoning → max')
  })
})

describe('attention after Setup applies a model', () => {
  it('shows the route notice when Setup actually changes the model', async () => {
    // The conductor only acknowledges the change through `onModelChanged`; the
    // attachment's comparison against the last route seen decides whether that
    // was a transition. Setup itself never formats a notice.
    const mounted = await fixture({ selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    SETUP.next = { provider: 'openai', model: 'gpt-x' }
    type(mounted.dispatch, '/setup')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).toContain('model → openai/gpt-x')
  })

  it('stays quiet when Setup ends without changing anything', async () => {
    const mounted = await fixture({ selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    SETUP.next = undefined
    type(mounted.dispatch, '/setup')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).not.toContain('model →')
  })

  it('stays quiet when Setup ends on the route already in force', async () => {
    const mounted = await fixture({ selected: { provider: 'openai', model: 'gpt-x' } })
    SETUP.next = { provider: 'openai', model: 'gpt-x' }
    type(mounted.dispatch, '/setup')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(frame(mounted.frames)).not.toContain('model →')
  })
})

describe('bare /permission decoration', () => {
  it('opens the shared selector by joining the live catalog with the session selection', async () => {
    const mounted = await fixture({ catalog: CATALOG, selection: { currentValue: 'normal' } })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    const shown = frame(mounted.frames)
    expect(shown).toContain('Permissions')
    expect(shown).toContain('current: Normal work')
    expect(shown).toContain('Review only')
    expect(shown).toContain('❯ Normal work')
    expect(shown).toContain('Work in this project.')
    expect(mounted.commands.execute).not.toHaveBeenCalled()
    // The catalog is read at the interaction boundary, not held: the read
    // happens when the gesture opens the picker, and only then.
    expect(mounted.catalogReads).toHaveBeenCalledTimes(1)
  })

  it('reads the live catalog again on every open rather than caching the first answer', async () => {
    const mounted = await fixture({ catalog: CATALOG, selection: { currentValue: 'normal' } })
    for (const _ of [0, 1]) {
      type(mounted.dispatch, '/permission')
      press(mounted.dispatch, { kind: 'key', name: 'enter' })
      await flush()
      press(mounted.dispatch, { kind: 'key', name: 'escape' })
      await flush()
    }
    expect(mounted.catalogReads).toHaveBeenCalledTimes(2)
  })

  it('shows an unresolvable current value without offering it as a target', async () => {
    const mounted = await fixture({ catalog: CATALOG, selection: { currentValue: 'custom' } })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    const shown = frame(mounted.frames)
    expect(shown).toContain('current: custom')
    expect(shown).not.toMatch(/❯\s+Custom/u)
  })

  it('requires an explicit confirmation before picker-selected Full Access', async () => {
    const mounted = await fixture({ catalog: RISKY, selection: { currentValue: 'workspace-write' } })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    press(mounted.dispatch, { kind: 'key', name: 'down' })
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(frame(mounted.frames)).toContain('Enable Full access?')
    expect(mounted.commands.execute).not.toHaveBeenCalled()
    press(mounted.dispatch, { kind: 'key', name: 'down' })
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(mounted.commands.execute.mock.calls[0]?.[1]).toBe('/permission danger-full-access')
  })

  it('requires an explicit confirmation before picker-selected Auto review', async () => {
    // Harness Web treats the live `auto` option as confirmation-bearing for the
    // same reason it does Full Access; the terminal picker is the same human
    // control, so it asks the same question in the same words.
    const mounted = await fixture({ catalog: RISKY, selection: { currentValue: 'workspace-write' } })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    press(mounted.dispatch, { kind: 'key', name: 'down' })
    press(mounted.dispatch, { kind: 'key', name: 'down' })
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(frame(mounted.frames)).toContain('Enable Auto review (experimental)?')
    expect(mounted.commands.execute).not.toHaveBeenCalled()
    press(mounted.dispatch, { kind: 'key', name: 'down' })
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    expect(mounted.commands.execute.mock.calls[0]?.[1]).toBe('/permission auto')
  })

  it('cancels picker-selected Auto review without executing', async () => {
    const mounted = await fixture({ catalog: RISKY, selection: { currentValue: 'workspace-write' } })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    press(mounted.dispatch, { kind: 'key', name: 'down' })
    press(mounted.dispatch, { kind: 'key', name: 'down' })
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    press(mounted.dispatch, { kind: 'key', name: 'escape' })
    await flush()

    expect(mounted.commands.execute).not.toHaveBeenCalled()
    expect(mounted.ctx.tuiSlots.activeOverlay).toBeUndefined()
  })

  it('does not ask or execute when Full Access is already current', async () => {
    const mounted = await fixture({ catalog: RISKY, selection: { currentValue: 'danger-full-access' } })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(mounted.commands.execute).not.toHaveBeenCalled()
    expect(mounted.ctx.tuiSlots.activeOverlay).toBeUndefined()
    expect(frame(mounted.frames)).not.toContain('Enable Full access?')
    type(mounted.dispatch, 'draft')
    press(mounted.dispatch, { kind: 'key', name: 'up' })
    expect(frame(mounted.frames)).toContain('› /permission')
  })

  it('cancels picker-selected Full Access without executing while preserving the human history entry', async () => {
    const mounted = await fixture({ catalog: RISKY, selection: { currentValue: 'workspace-write' } })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    press(mounted.dispatch, { kind: 'key', name: 'down' })
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    press(mounted.dispatch, { kind: 'key', name: 'escape' })
    await flush()

    expect(mounted.commands.execute).not.toHaveBeenCalled()
    expect(mounted.ctx.tuiSlots.activeOverlay).toBeUndefined()
    type(mounted.dispatch, 'draft')
    press(mounted.dispatch, { kind: 'key', name: 'up' })
    expect(frame(mounted.frames)).toContain('› /permission')
    expect(frame(mounted.frames)).not.toContain('› /permission danger-full-access')
  })

  it('runs exactly the selected Harness command through the normal executor and its lifecycle', async () => {
    const mounted = await fixture({ catalog: CATALOG, selection: { currentValue: 'normal' } })
    mounted.commands.execute.mockImplementationOnce(async (agent, line) => {
      const session = (agent as { session: { append: (type: string, data: unknown) => void } }).session
      session.append('command/run', {
        commandId: 'permission-switch', name: 'permission', args: ' unrestricted', source: { kind: 'user' },
      })
      session.append('command/done', { commandId: 'permission-switch', kind: 'success', text: 'preset unrestricted' })
      return { kind: 'success' }
    })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    press(mounted.dispatch, { kind: 'key', name: 'down' })
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(mounted.commands.execute).toHaveBeenCalledTimes(1)
    expect(mounted.commands.execute.mock.calls[0]?.[1]).toBe('/permission unrestricted')
    const transcript = mounted.commits.flat().map(stripAnsi)
    expect(transcript.filter(line => line === '› /permission unrestricted')).toEqual(['› /permission unrestricted'])
    expect(transcript.filter(line => line === '· preset unrestricted')).toEqual(['· preset unrestricted'])
    expect(transcript).not.toContain('› /permission')
    type(mounted.dispatch, 'draft')
    press(mounted.dispatch, { kind: 'key', name: 'up' })
    expect(frame(mounted.frames)).toContain('› /permission')
    expect(frame(mounted.frames)).not.toContain('› /permission unrestricted')
  })

  it('cancels without executing a command while preserving the human history entry', async () => {
    const mounted = await fixture({ catalog: CATALOG, selection: { currentValue: 'normal' } })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()
    press(mounted.dispatch, { kind: 'key', name: 'escape' })
    await flush()

    expect(mounted.ctx.tuiSlots.activeOverlay).toBeUndefined()
    type(mounted.dispatch, 'draft')
    press(mounted.dispatch, { kind: 'key', name: 'up' })
    expect(frame(mounted.frames)).toContain('› /permission')
    expect(mounted.commands.execute).not.toHaveBeenCalled()
    expect(frame(mounted.frames)).not.toContain('› /permission normal')
  })

  it('leaves a typed Full Access command to Harness unchanged', async () => {
    const mounted = await fixture({ catalog: RISKY, selection: { currentValue: 'workspace-write' } })
    type(mounted.dispatch, '/permission danger-full-access')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(mounted.commands.execute).toHaveBeenCalledTimes(1)
    expect(mounted.commands.execute.mock.calls[0]?.[1]).toBe('/permission danger-full-access')
    expect(frame(mounted.frames)).not.toContain('Permissions')
    expect(frame(mounted.frames)).not.toContain('Enable Full access?')
  })

  it('falls through unchanged when neither optional authority is composed', async () => {
    const mounted = await fixture()
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(mounted.commands.execute).toHaveBeenCalledTimes(1)
    expect(mounted.commands.execute.mock.calls[0]?.[1]).toBe('/permission')
    expect(frame(mounted.frames)).not.toContain('Permissions')
  })

  it('falls through unchanged when the optional catalog capability is absent', async () => {
    // A selection alone names no selectable rows, and dshline will not derive
    // them from anything else it can see.
    const mounted = await fixture({ selection: { currentValue: 'normal' } })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(mounted.commands.execute).toHaveBeenCalledTimes(1)
    expect(mounted.commands.execute.mock.calls[0]?.[1]).toBe('/permission')
    expect(frame(mounted.frames)).not.toContain('Permissions')
  })

  it('falls through unchanged when the session selection is absent', async () => {
    // A catalog alone cannot say what is current, and a picker that showed one
    // anyway would be inventing the fact it exists to report.
    const mounted = await fixture({ catalog: CATALOG })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(mounted.commands.execute).toHaveBeenCalledTimes(1)
    expect(mounted.commands.execute.mock.calls[0]?.[1]).toBe('/permission')
    expect(frame(mounted.frames)).not.toContain('Permissions')
  })

  it('does not decorate for an agent without the registered command', async () => {
    const mounted = await fixture({ catalog: CATALOG, selection: { currentValue: 'normal' }, commandListed: false })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(mounted.commands.execute).toHaveBeenCalledTimes(1)
    expect(mounted.commands.execute.mock.calls[0]?.[1]).toBe('/permission')
    expect(frame(mounted.frames)).not.toContain('Permissions')
  })
})
