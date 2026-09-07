/** Harness permission projection presentation and bare-command decoration tests. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import type { Config, PermissionSelect } from '@deepseek-ai/dsh-permission-presets'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createScope } from '@deepseek-ai/dsh-scope'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { permissionPicker } from '../src/permission.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/** A deployment-defined projection, deliberately unlike dsh-base's preset table. */
const OPTIONS: PermissionSelect = {
  options: [
    { value: 'review', name: 'Review only', description: 'Inspect changes before they are applied.' },
    { value: 'normal', name: 'Normal work', description: 'Work in this project.' },
    { value: 'unrestricted', name: 'Unrestricted', description: 'Use the deployment-wide policy.' },
  ],
  currentValue: 'normal',
}

/** The conventional Full Access option has a picker-only risk confirmation. */
const FULL_ACCESS: PermissionSelect = {
  options: [
    { value: 'workspace-write', name: 'Workspace Write', description: 'Work in this project.' },
    { value: 'danger-full-access', name: 'Full access', description: 'Run without approvals.' },
  ],
  currentValue: 'workspace-write',
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
  readonly projection?: PermissionSelect
  readonly commandListed?: boolean
} = {}): Promise<{
  readonly dispatch: () => ((key: Key) => void) | undefined
  readonly ctx: Context
  readonly commands: { readonly execute: ReturnType<typeof vi.fn> }
  readonly commits: string[][]
  readonly frames: string[][]
}> {
  const ctx = new Context()
  await ctx.plugin(TuiSlots)
  const projection = options.projection
  if (projection !== undefined) {
    ctx.provide('sessionProjections', {
      snapshot: () => ({ asOfSeq: 0, values: { permissions: projection } }),
      onChanged: () => () => {},
    } as never)
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

  const commits: string[][] = []
  const frames: string[][] = []
  const draw = (): void => { frames.push([...ctx.tuiSlots.compose(80, 24).lines]) }
  ctx.on('tui/render', draw)
  let dispatch: ((key: Key) => void) | undefined
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
    refreshModelInfo: () => {},
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
  return { dispatch: () => dispatch, ctx, commands, commits, frames }
}

/** Most recently painted terminal frame, as a reader sees it. */
function frame(frames: readonly string[][]): string {
  return stripAnsi((frames.at(-1) ?? []).join('\n'))
}

/** Mount the actual permission service, command runtime, and projection registry. */
async function permissionHarness(config: Config): Promise<{ ctx: Context; session: Session }> {
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
  await ctx.plugin(PermissionPresetService, config)
  return { ctx, session: ctx.sessions.create(SessionId('permission-probe')) }
}

/** Mint an agent scope in the addressing shape the real command runtime expects. */
async function permissionAgent(ctx: Context, session: Session): Promise<Agent> {
  const agent = { id: session.id, session, inject: vi.fn() } as unknown as Agent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
  return agent
}

describe('real Harness permission capability', () => {
  it('publishes the configured table and runs the selected command through the lifecycle', async () => {
    const { ctx, session } = await permissionHarness({
      presets: {
        review: { sandbox: 'read-only', approval: 'ask', name: 'Review only', description: 'Inspect safely.' },
        normal: { sandbox: 'workspace-write', approval: 'ask', name: 'Normal work', description: 'Work normally.' },
      },
      defaultPreset: 'normal',
    })
    expect(ctx.sessionProjections.snapshot(session).values.permissions).toEqual({
      options: [
        { value: 'review', name: 'Review only', description: 'Inspect safely.' },
        { value: 'normal', name: 'Normal work', description: 'Work normally.' },
      ],
      currentValue: 'normal',
    })
    const agent = await permissionAgent(ctx, session)
    const execution = await ctx.commands.execute(agent, '/permission review', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'preset review' })
    // A whole-log assertion, so a whole-log snapshot is the honest read.
    const logged = session.snapshotEvents()
    expect(logged.filter(event => event.type === 'command/run')).toHaveLength(1)
    expect(logged.filter(event => event.type === 'command/done')).toHaveLength(1)
    expect(ctx.sessionProjections.snapshot(session).values.permissions?.currentValue).toBe('review')
  })
})

describe('permissionPicker()', () => {
  it('preserves a deployment table’s opaque values, order, labels, and descriptions', () => {
    expect(permissionPicker(OPTIONS)).toEqual({
      detail: 'current: Normal work',
      currentValue: 'normal',
      choices: [
        { value: 'review', label: 'Review only', description: 'Inspect changes before they are applied.' },
        { value: 'normal', label: 'Normal work', description: 'Work in this project.' },
        { value: 'unrestricted', label: 'Unrestricted', description: 'Use the deployment-wide policy.' },
      ],
    })
  })

  it('reports custom honestly while excluding it from switch targets', () => {
    const custom: PermissionSelect = {
      options: [...OPTIONS.options, { value: 'custom', name: 'Custom' }],
      currentValue: 'custom',
    }
    expect(permissionPicker(custom)).toEqual({
      detail: 'current: Custom',
      currentValue: undefined,
      choices: OPTIONS.options.map(({ value, name, description }) => ({
        value, label: name, ...description === undefined ? {} : { description },
      })),
    })
  })

  it('does not invent a capability when the projection is absent', () => {
    expect(permissionPicker(undefined)).toBeUndefined()
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

describe('bare /permission decoration', () => {
  it('opens the shared selector from the authoritative dynamic projection', async () => {
    const mounted = await fixture({ projection: OPTIONS })
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
  })

  it('shows custom as current without offering it as a target', async () => {
    const custom: PermissionSelect = {
      options: [...OPTIONS.options, { value: 'custom', name: 'Custom' }],
      currentValue: 'custom',
    }
    const mounted = await fixture({ projection: custom })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    const shown = frame(mounted.frames)
    expect(shown).toContain('current: Custom')
    expect(shown).not.toMatch(/❯\s+Custom/u)
  })

  it('requires an explicit confirmation before picker-selected Full Access', async () => {
    const mounted = await fixture({ projection: FULL_ACCESS })
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

  it('does not ask or execute when Full Access is already current', async () => {
    const mounted = await fixture({ projection: { ...FULL_ACCESS, currentValue: 'danger-full-access' } })
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
    const mounted = await fixture({ projection: FULL_ACCESS })
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
    const mounted = await fixture({ projection: OPTIONS })
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
    const mounted = await fixture({ projection: OPTIONS })
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
    const mounted = await fixture({ projection: FULL_ACCESS })
    type(mounted.dispatch, '/permission danger-full-access')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(mounted.commands.execute).toHaveBeenCalledTimes(1)
    expect(mounted.commands.execute.mock.calls[0]?.[1]).toBe('/permission danger-full-access')
    expect(frame(mounted.frames)).not.toContain('Permissions')
    expect(frame(mounted.frames)).not.toContain('Enable Full access?')
  })

  it('falls through unchanged when the optional projection is absent', async () => {
    const mounted = await fixture()
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(mounted.commands.execute).toHaveBeenCalledTimes(1)
    expect(mounted.commands.execute.mock.calls[0]?.[1]).toBe('/permission')
    expect(frame(mounted.frames)).not.toContain('Permissions')
  })

  it('does not decorate a process-wide projection for an agent without the command', async () => {
    const mounted = await fixture({ projection: OPTIONS, commandListed: false })
    type(mounted.dispatch, '/permission')
    press(mounted.dispatch, { kind: 'key', name: 'enter' })
    await flush()

    expect(mounted.commands.execute).toHaveBeenCalledTimes(1)
    expect(mounted.commands.execute.mock.calls[0]?.[1]).toBe('/permission')
    expect(frame(mounted.frames)).not.toContain('Permissions')
  })
})
