/**
 * Image drafts through the real session attachment.
 *
 * This fixture keeps the terminal and Agent as small doubles while exercising
 * the production composer, local-command registry, optional Harness services,
 * durable admission, and final inbox delivery together.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context as RealContext } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/** Build one fresh attached session with optional image capabilities. */
async function fixture(options: {
  readonly images?: boolean
  readonly readFailure?: () => Error | undefined
  readonly read?: (signal: AbortSignal | undefined) => Promise<Uint8Array>
  readonly save?: (inputs: readonly { mediaType: string; name?: string }[]) => Promise<readonly ImageAttachmentRef[]>
  readonly commands?: readonly { readonly name: string; readonly description: string }[]
  readonly execute?: (signal: AbortSignal) => Promise<unknown>
  readonly commandResult?: { readonly commandId: string; readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } }
  readonly inputModalities?: readonly ('text' | 'image')[]
  readonly agentStatus?: 'idle' | 'running'
  readonly busyEnter?: 'queue' | 'steer'
} = {}): Promise<{
  dispatch: () => ((key: Key) => void) | undefined
  agent: { followup: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn> }
  reads: ReturnType<typeof vi.fn>
  saves: ReturnType<typeof vi.fn>
  commands: { execute: ReturnType<typeof vi.fn> }
  commits: string[][]
  draws: ReturnType<typeof vi.fn>
  frame: () => string
  attachment: Promise<unknown>
  window: Window
}> {
  const ctx = new RealContext()
  await ctx.plugin(TuiSlots)
  ctx.provide('tools', { get: () => undefined })
  const commands = {
    execute: vi.fn(async (_agent: unknown, _line: string, _images: unknown, signal: AbortSignal) => options.execute === undefined
      ? options.commandResult
      : options.execute(signal)),
    list: () => [...(options.commands ?? [])],
  }
  ctx.provide('commands', commands as never)
  ctx.provide('userQuestions', {} as never)

  const reads = vi.fn(async (_target: unknown, signal: AbortSignal | undefined) => {
    if (options.read !== undefined) return options.read(signal)
    const failure = options.readFailure?.()
    if (failure !== undefined) throw failure
    return Uint8Array.of(1, 2, 3)
  })
  const saves = vi.fn(async (inputs: readonly { mediaType: string; name?: string }[]) => options.save === undefined
    ? inputs.map((input, index) => ({
        attachmentId: `opaque-${String(index)}`,
        mediaType: input.mediaType,
        bytes: 3,
        width: 2,
        height: 1,
        name: input.name,
      }) as ImageAttachmentRef)
    : options.save(inputs))
  if (options.images !== false) {
    ctx.provide('fs', {
      resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
      readBytes: reads,
      listDir: async () => [],
    } as never)
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 20,
        maxImagesPerMessage: 3,
        maxMessageImageBytes: 50,
        maxImagePixels: 100,
        maxImageDimension: 10,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      saveImages: saves,
    } as never)
  }

  const commits: string[][] = []
  let dispatch: ((key: Key) => void) | undefined
  let latest: string[] = []
  const compose = (): void => { latest = ctx.tuiSlots.compose(80, 24).lines }
  const draws = vi.fn(compose)
  const window = {
    ctx,
    terminal: { columns: () => 80, rows: () => 24 },
    exit: undefined,
    startup: { cwd: '/workspace', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: undefined },
    modelInfo: { contextWindow: undefined, reasoning: undefined, inputModalities: options.inputModalities },
    prefs: {
      usageMode: 'cost', timing: false, cardDetail: 'compact',
      reasoningVisible: true, busyEnter: options.busyEnter ?? 'queue',
    },
    colorDepth: 0,
    palette: () => ({}),
    setPalette: () => {},
    themeSettings: {},
    busyEnterSettings: { current: () => 'queue', watch: () => () => {}, save: async () => undefined },
    pendingTask: undefined,
    draw: draws,
    paintNow: draws,
    commit: (lines: readonly string[]) => { commits.push([...lines]) },
    clear: () => {},
    refreshModelInfo: () => {},
    setDispatch: (handler?: (key: Key) => void) => { dispatch = handler },
  } as unknown as Window
  const agent = {
    session: { id: 's-image', header: { cwd: '/workspace' }, events: [] },
    status: options.agentStatus ?? 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
  const outcome = {
    target: { kind: 'new', cwd: '/workspace' },
    attached: { handle: { agent, dispose: async () => {} }, reopened: false },
  } as unknown as AttachOutcome
  const attachment = attachSession(window, outcome)
  return {
    dispatch: () => dispatch,
    agent,
    reads,
    saves,
    commands,
    commits,
    draws,
    frame: () => stripAnsi(latest.join('\n')),
    attachment,
    window,
  }
}

/** Type and submit one complete line. */
function submit(dispatch: ((key: Key) => void) | undefined, line: string): void {
  expect(dispatch).toBeDefined()
  for (const char of [...line]) dispatch?.({ kind: 'text', text: char })
  dispatch?.({ kind: 'key', name: 'enter' })
}

/** Drain command/admission promises scheduled by the input handler. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve) })
}

describe('image attachment submission', () => {
  it('stages without I/O, then admits before delivering durable ImageBlocks', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/image pictures/界 面.png')
    await flush()
    expect(f.reads).not.toHaveBeenCalled()
    expect(f.saves).not.toHaveBeenCalled()
    expect(f.frame()).toContain('1 image')

    submit(f.dispatch(), 'What is shown?')
    await flush()

    expect(f.reads).toHaveBeenCalledWith(
      expect.objectContaining({ targetKey: 'pictures/界 面.png' }),
      expect.any(AbortSignal),
      20,
    )
    expect(f.saves).toHaveBeenCalledOnce()
    expect(f.agent.followup).toHaveBeenCalledOnce()
    const message = f.agent.followup.mock.calls[0]?.[0] as { content: Array<Record<string, unknown>> }
    expect(message.content).toEqual([
      { type: 'text', text: 'What is shown?' },
      { type: 'image', attachment: expect.objectContaining({ attachmentId: 'opaque-0', name: '界 面.png' }) },
    ])
    expect(f.frame()).not.toContain('1 image')
  })

  it('restores the prompt and keeps the draft when reading fails, then retries safely', async () => {
    let failure: Error | undefined = new Error('image disappeared')
    const f = await fixture({ readFailure: () => failure })
    submit(f.dispatch(), '/image gone.png')
    await flush()
    submit(f.dispatch(), 'Please inspect it')
    await flush()

    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.saves).not.toHaveBeenCalled()
    expect(f.frame()).toContain('Please inspect it')
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('image file could not be read')

    failure = undefined
    f.dispatch()?.({ kind: 'key', name: 'enter' })
    await flush()
    expect(f.agent.followup).toHaveBeenCalledOnce()
    expect(f.saves).toHaveBeenCalledOnce()
  })

  it('reports typed filesystem failures without echoing an absolute path', async () => {
    const failure = Object.assign(new Error('cannot read "/private/secret.png": permission denied'), {
      code: 'FS_PERMISSION_DENIED',
    })
    const f = await fixture({ readFailure: () => failure })
    submit(f.dispatch(), '/image /private/secret.png')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()
    const output = f.commits.flat().map(stripAnsi).join('\n')
    expect(output).toContain('image file cannot be read by this profile')
    expect(output).not.toContain('/private/secret.png')
    expect(f.frame()).toContain('inspect')
  })

  it('fails closed for an unexpected filesystem error containing an absolute path', async () => {
    const f = await fixture({ readFailure: () => new Error('cannot read /private/secret.png') })
    submit(f.dispatch(), '/image /private/secret.png')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()
    const output = f.commits.flat().map(stripAnsi).join('\n')
    expect(output).toContain('image file could not be read')
    expect(output).not.toContain('/private/secret.png')
  })

  it('does not silently discard staged images into a registered command', async () => {
    const f = await fixture({ commands: [{ name: 'echo', description: 'echo' }] })
    submit(f.dispatch(), '/image one.png')
    await flush()
    submit(f.dispatch(), '/echo hello')
    await flush()
    expect(f.commands.execute).not.toHaveBeenCalled()
    expect(f.saves).not.toHaveBeenCalled()
    expect(f.frame()).toContain('1 image')
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('does not accept image attachments')
  })

  it('forwards transient bytes only to a command that explicitly accepts images', async () => {
    const f = await fixture({
      commands: [{ name: 'vision', description: 'inspect', input: { hint: 'ask', attachments: true } } as never],
      commandResult: { commandId: 'c-1', result: { kind: 'success' } },
    })
    submit(f.dispatch(), '/image one.png')
    await flush()
    submit(f.dispatch(), '/vision inspect this')
    await flush()
    expect(f.commands.execute).toHaveBeenCalledWith(
      expect.anything(),
      '/vision inspect this',
      // `type: 'image'` is the registry's submission discriminant; its other
      // arm is a staged file receipt, which dshline never produces.
      [{ type: 'image', mediaType: 'image/png', data: 'AQID', name: 'one.png' }],
      expect.any(AbortSignal),
    )
    // The command registry, not dshline, owns durable admission on this path.
    expect(f.saves).not.toHaveBeenCalled()
    expect(f.frame()).not.toContain('1 image')
  })

  it('retains drafts when an accepting command reports an error', async () => {
    const f = await fixture({
      commands: [{ name: 'vision', description: 'inspect', input: { hint: 'ask', attachments: true } } as never],
      commandResult: { commandId: 'c-1', result: { kind: 'error', text: 'not now' } },
    })
    submit(f.dispatch(), '/image one.png')
    await flush()
    submit(f.dispatch(), '/vision inspect this')
    await flush()
    expect(f.commands.execute).toHaveBeenCalledOnce()
    expect(f.frame()).toContain('/vision inspect this')
    f.dispatch()?.({ kind: 'key', name: 'ctrl-u' })
    submit(f.dispatch(), '/image')
    await flush()
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('1 staged image')
  })

  it('keeps one admission in flight and lets ctrl-c cancel it without quitting', async () => {
    const read = (signal: AbortSignal | undefined): Promise<Uint8Array> => new Promise((resolve, reject) => {
      void resolve
      signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    })
    const f = await fixture({ read })
    submit(f.dispatch(), '/image slow.png')
    await flush()
    submit(f.dispatch(), 'first prompt')
    await flush()
    expect(f.reads).toHaveBeenCalledOnce()

    submit(f.dispatch(), 'second prompt')
    await flush()
    expect(f.reads).toHaveBeenCalledOnce()
    expect(f.frame()).toContain('second prompt')
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('still being attached')

    f.dispatch()?.({ kind: 'key', name: 'ctrl-c' })
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.saves).not.toHaveBeenCalled()
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('image attachment cancelled')
  })

  it('freezes the draft batch and refuses draft mutations while a read is pending', async () => {
    let finishRead: ((data: Uint8Array) => void) | undefined
    const f = await fixture({ read: () => new Promise(resolve => { finishRead = resolve }) })
    submit(f.dispatch(), '/image first.png')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()

    submit(f.dispatch(), '/image later.png')
    submit(f.dispatch(), '/image --clear')
    await flush()
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('staged images cannot change yet')

    finishRead?.(Uint8Array.of(1, 2, 3))
    await flush()
    expect(f.saves.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ name: 'first.png' })])
    expect(f.agent.followup).toHaveBeenCalledOnce()
    submit(f.dispatch(), '/image')
    await flush()
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('no images staged')
  })

  it('keeps the queue-or-steer decision made before a delayed image read', async () => {
    let finishRead: ((data: Uint8Array) => void) | undefined
    const f = await fixture({
      agentStatus: 'running',
      busyEnter: 'queue',
      read: () => new Promise(resolve => { finishRead = resolve }),
    })
    submit(f.dispatch(), '/image one.png')
    await flush()
    submit(f.dispatch(), 'queue this')
    await flush()
    const preferences = f.window.prefs as { busyEnter: 'queue' | 'steer' }
    preferences.busyEnter = 'steer'
    finishRead?.(Uint8Array.of(1, 2, 3))
    await flush()
    expect(f.agent.followup).toHaveBeenCalledOnce()
    expect(f.agent.steer).not.toHaveBeenCalled()
  })

  it('does not deliver durable refs when ctrl-c arrives during an uncancellable save', async () => {
    let finishSave: ((refs: readonly ImageAttachmentRef[]) => void) | undefined
    const save = (): Promise<readonly ImageAttachmentRef[]> => new Promise(resolve => { finishSave = resolve })
    const f = await fixture({ save })
    submit(f.dispatch(), '/image slow.png')
    await flush()
    submit(f.dispatch(), 'inspect this')
    await flush()
    expect(f.saves).toHaveBeenCalledOnce()

    submit(f.dispatch(), '/image later.png')
    await flush()
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('staged images cannot change yet')

    f.dispatch()?.({ kind: 'key', name: 'ctrl-c' })
    finishSave?.([{
      attachmentId: 'opaque-late', mediaType: 'image/png', bytes: 3, width: 2, height: 1, name: 'slow.png',
    } as ImageAttachmentRef])
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.frame()).toContain('inspect this')
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('image attachment cancelled')
  })

  it('does not let a late durable save cross a session transition', async () => {
    let finishSave: ((refs: readonly ImageAttachmentRef[]) => void) | undefined
    const f = await fixture({
      save: () => new Promise(resolve => { finishSave = resolve }),
    })
    submit(f.dispatch(), '/image slow.png')
    await flush()
    submit(f.dispatch(), 'old session prompt')
    await flush()
    submit(f.dispatch(), '/new')
    await flush()
    await f.attachment
    const commitsBefore = f.commits.length
    const frameBefore = f.frame()

    finishSave?.([{
      attachmentId: 'opaque-stale', mediaType: 'image/png', bytes: 3, width: 2, height: 1, name: 'slow.png',
    } as ImageAttachmentRef])
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.commits).toHaveLength(commitsBefore)
    expect(f.frame()).toBe(frameBefore)
  })

  it('keeps ctrl-c ownership through an accepting command lifecycle', async () => {
    const execute = (signal: AbortSignal): Promise<unknown> => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    })
    const f = await fixture({
      commands: [{ name: 'vision', description: 'inspect', input: { attachments: true } } as never],
      execute,
    })
    submit(f.dispatch(), '/image one.png')
    await flush()
    submit(f.dispatch(), '/vision inspect')
    await flush()
    expect(f.commands.execute).toHaveBeenCalledOnce()

    f.dispatch()?.({ kind: 'key', name: 'ctrl-c' })
    await flush()
    expect(f.frame()).toContain('/vision inspect')
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('Image attachment cancelled')
  })

  it('does not let a late image-command settlement redraw or alter the old session', async () => {
    let finish: ((value: unknown) => void) | undefined
    const f = await fixture({
      commands: [{ name: 'vision', description: 'inspect', input: { attachments: true } } as never],
      execute: () => new Promise(resolve => { finish = resolve }),
    })
    submit(f.dispatch(), '/image one.png')
    await flush()
    submit(f.dispatch(), '/vision inspect')
    await flush()
    submit(f.dispatch(), '/new')
    await flush()
    await f.attachment
    const commitsBefore = f.commits.length
    const drawsBefore = f.draws.mock.calls.length

    finish?.({ commandId: 'late', result: { kind: 'success' } })
    await flush()
    expect(f.commits).toHaveLength(commitsBefore)
    expect(f.draws).toHaveBeenCalledTimes(drawsBefore)
  })

  it('fails truthfully when the optional services are absent', async () => {
    const f = await fixture({ images: false })
    submit(f.dispatch(), '/image one.png')
    await flush()
    expect(f.frame()).not.toContain('1 image')
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('attachment and filesystem services')
  })

  it('refuses an explicitly text-only model before reading or saving', async () => {
    const f = await fixture({ inputModalities: ['text'] })
    submit(f.dispatch(), '/image one.png')
    await flush()
    submit(f.dispatch(), 'look')
    await flush()
    expect(f.reads).not.toHaveBeenCalled()
    expect(f.saves).not.toHaveBeenCalled()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.frame()).toContain('look')
    expect(f.commits.flat().map(stripAnsi).join('\n')).toContain('does not support image input')
  })

  it('allows unknown model modalities and delegates the answer to Harness', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/image one.png')
    await flush()
    submit(f.dispatch(), 'look')
    await flush()
    expect(f.saves).toHaveBeenCalledOnce()
    expect(f.agent.followup).toHaveBeenCalledOnce()
  })
})
