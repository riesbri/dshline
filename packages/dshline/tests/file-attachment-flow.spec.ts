/**
 * Generic file drafts through the real session attachment.
 *
 * The same fixture shape as `image-attachment-flow.spec.ts`, extended to carry
 * a filesystem that serves windowed reads and an attachment store that records
 * `saveFileStream`. The terminal and Agent stay small doubles; the composer,
 * local-command registry, optional Harness services, durable admission, and
 * final inbox delivery are the production ones.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context as RealContext } from '@deepseek-ai/cordis'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/** A staged path's served bytes, or a refusal the backend would raise. */
type Served = Uint8Array | { readonly code: string; readonly message: string }

/** One stored file for the fake filesystem. */
interface Entry {
  data: Uint8Array
  type: 'file' | 'directory'
  version: string
}

/** The fake filesystem's contents, reset per fixture. */
function freshFiles(): Map<string, Entry> {
  return new Map([
    ['/workspace/logs/server.log', { data: text('line one\nline two\n'), type: 'file', version: 'v1' }],
    ['/workspace/trace.json', { data: text('{"ok":true}'), type: 'file', version: 'v1' }],
    ['/workspace/binary.dat', { data: Uint8Array.of(0, 255, 0, 27), type: 'file', version: 'v1' }],
    ['/workspace/empty.txt', { data: new Uint8Array(0), type: 'file', version: 'v1' }],
    ['/workspace/pictures/a.png', { data: Uint8Array.of(1, 2, 3), type: 'file', version: 'v1' }],
    ['/workspace/pictures/c.png', { data: Uint8Array.of(4, 5, 6), type: 'file', version: 'v1' }],
    ['/workspace/dir', { data: new Uint8Array(0), type: 'directory', version: 'v1' }],
  ])
}

/**
 * Encode a string the way a real file would be stored.
 * @param value - the text content.
 * @returns its UTF-8 bytes.
 */
function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** Build one fresh attached session with optional attachment capabilities. */
async function fixture(options: {
  readonly capabilities?: boolean
  readonly files?: Map<string, Entry>
  /** Serve this instead of the stored bytes, for a refusal case. */
  readonly serve?: (key: string) => Served | undefined
  /** Called before each window is served, for a mid-stream mutation. */
  readonly onRead?: (key: string) => void
  /** Hold the IMAGE whole-file read open, for an in-flight admission case. */
  readonly readBytes?: (key: string) => Promise<Uint8Array>
  /**
   * Hold the FILE window read open, for an in-flight admission case. The signal
   * is handed through so a test can model a slow backend that a reader's ctrl-c
   * actually interrupts, rather than one that simply never answers.
   */
  readonly onWindow?: (key: string, signal: AbortSignal | undefined) => Promise<void>
  readonly saveFileFailure?: Error | undefined
  /**
   * Make the store relabel whatever the source raised as its own storage
   * failure, which is what the real local provider does. Without this a read
   * fault would arrive with its own code and the discrimination below would be
   * tested against a double that never obscures anything.
   */
  readonly relabelSourceFailure?: boolean
  readonly saveFile?: () => Promise<{ attachmentId: string; name: string; bytes: number }>
  readonly commands?: readonly CommandDescriptor[]
  readonly execute?: (signal: AbortSignal) => Promise<unknown>
  readonly commandResult?: { readonly commandId: string; readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } }
  readonly agentStatus?: 'idle' | 'running'
  readonly busyEnter?: 'queue' | 'steer'
  readonly inputModalities?: readonly ('text' | 'image')[]
} = {}): Promise<{
  dispatch: () => ((key: Key) => void) | undefined
  agent: { followup: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn> }
  reads: ReturnType<typeof vi.fn>
  windows: ReturnType<typeof vi.fn>
  saves: ReturnType<typeof vi.fn>
  files: Map<string, Entry>
  commands: { execute: ReturnType<typeof vi.fn> }
  exit: ReturnType<typeof vi.fn>
  commits: string[][]
  frame: () => string
  output: () => string
  attachment: Promise<unknown>
  window: Window
}> {
  const ctx = new RealContext()
  await ctx.plugin(TuiSlots)
  ctx.provide('tools', { get: () => undefined })
  const commands = {
    execute: vi.fn(async (_agent: unknown, _line: string, _attachments: unknown, signal: AbortSignal) => options.execute === undefined
      ? options.commandResult
      : options.execute(signal)),
    list: () => [...(options.commands ?? [])],
  }
  ctx.provide('commands', commands as never)
  ctx.provide('userQuestions', {} as never)

  const files = options.files ?? freshFiles()
  // `readBytes(target, signal, maxBytes)` receives the resolved TARGET, not a
  // path string; the display path is what this double is keyed by.
  const reads = vi.fn(async (target: { displayPath: string }) =>
    await options.readBytes?.(target.displayPath) ?? files.get(target.displayPath)?.data ?? new Uint8Array(0))
  const windows = vi.fn()
  const saves = vi.fn(async (input: { name?: string; data: AsyncIterable<Uint8Array> }) => {
    if (options.saveFileFailure !== undefined) throw options.saveFileFailure
    const chunks: Uint8Array[] = []
    try {
      for await (const chunk of input.data) chunks.push(chunk)
    } catch (error: unknown) {
      if (options.relabelSourceFailure !== true) throw error
      throw Object.assign(new Error('Unable to persist attachment.'), { code: 'ATTACHMENT_WRITE_FAILED', cause: error })
    }
    const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    if (options.saveFile !== undefined) return options.saveFile() as unknown as FileAttachmentRef
    return {
      attachmentId: `sha256:${String(bytes)}`,
      name: input.name ?? 'unnamed',
      bytes,
    } as unknown as FileAttachmentRef
  })
  if (options.capabilities !== false) {
    ctx.provide('fs', {
      resolve: async (path: string) => {
        const key = path.startsWith('/') ? path : `/workspace/${path}`
        return { targetKey: key, displayPath: key }
      },
      stat: async (target: { displayPath: string }) => {
        const entry = files.get(target.displayPath)
        return entry === undefined
          ? undefined
          : { version: entry.version, type: entry.type, size: entry.data.byteLength }
      },
      readByteRange: async (
        target: { displayPath: string },
        range: { offset: number; length: number },
        signal?: AbortSignal,
      ) => {
        signal?.throwIfAborted()
        windows(range)
        const served = options.serve?.(target.displayPath)
        if (served !== undefined) {
          if (served instanceof Uint8Array) return served.slice(range.offset, range.offset + range.length)
          throw Object.assign(new Error(served.message), { code: served.code })
        }
        await options.onWindow?.(target.displayPath, signal)
        options.onRead?.(target.displayPath)
        const entry = files.get(target.displayPath)
        return entry === undefined ? new Uint8Array(0) : entry.data.slice(range.offset, range.offset + range.length)
      },
      readBytes: reads,
      listDir: async () => [],
    } as never)
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 1_000,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 4_000,
        maxImagePixels: 100,
        maxImageDimension: 10,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      saveImages: vi.fn(async (inputs: readonly { mediaType: string; name?: string }[]) => inputs.map((input, index) => ({
        attachmentId: `opaque-${String(index)}`,
        mediaType: input.mediaType,
        bytes: 3,
        width: 2,
        height: 1,
        name: input.name,
      } as ImageAttachmentRef))),
      saveFileStream: saves,
    } as never)
  }

  const commits: string[][] = []
  const exit = vi.fn()
  let exitHandler: (() => void) | undefined
  let dispatch: ((key: Key) => void) | undefined
  let latest: string[] = []
  const compose = (): void => { latest = ctx.tuiSlots.compose(80, 24).lines }
  const draws = vi.fn(compose)
  const window = {
    ctx,
    terminal: { columns: () => 80, rows: () => 24 },
    exit,
    startup: { cwd: '/workspace', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: undefined },
    modelInfo: { contextWindow: undefined, reasoning: undefined, inputModalities: options.inputModalities },
    modelCompletionValues: () => Promise.resolve([]),
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
    setExit: handler => { exitHandler = handler },
  } as unknown as Window
  const agent = {
    session: { id: 's-file', header: { cwd: '/workspace' }, events: [] },
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
    windows,
    saves,
    files,
    commands,
    exit,
    commits: commits,
    frame: () => stripAnsi(latest.join('\n')),
    output: () => commits.flat().map(stripAnsi).join('\n'),
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

/** Press enter on an empty composer, which is how an attachment-only send is made. */
function submitEmpty(dispatch: ((key: Key) => void) | undefined): void {
  expect(dispatch).toBeDefined()
  dispatch?.({ kind: 'key', name: 'enter' })
}

/**
 * The staged-count hint only draws over an EMPTY composer, so a test that wants
 * to read it after a failed send has to clear the restored prompt first.
 * @param f - the fixture whose composer to clear.
 */
function clearComposer(f: { dispatch: () => ((key: Key) => void) | undefined }): void {
  f.dispatch()?.({ kind: 'key', name: 'ctrl-u' })
}

/** Drain command/admission promises scheduled by the input handler. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve) })
}

/** The content blocks of the one message the Agent was handed. */
function sent(f: Awaited<ReturnType<typeof fixture>>): readonly { type: string; attachment?: { name?: string; bytes?: number } }[] {
  const message = f.agent.followup.mock.calls[0]?.[0] as { content: { type: string; attachment?: { name?: string } }[] }
  return message.content
}

describe('staging a generic file', () => {
  it('stages without reading anything, and lists what is staged', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    // Staging is metadata. No window, no whole-file read, no durable object.
    expect(f.windows).not.toHaveBeenCalled()
    expect(f.reads).not.toHaveBeenCalled()
    expect(f.saves).not.toHaveBeenCalled()
    expect(f.frame()).toContain('1 file')

    submit(f.dispatch(), '/attach')
    await flush()
    expect(f.output()).toContain('1 staged file')
    expect(f.output()).toContain('server.log')
  })

  it('accepts any extension, any absolute path, and a directory name', async () => {
    // No whitelist and no size policy: the adopted attachment contract states
    // that files carry no admission limits because storage is streamed.
    const f = await fixture()
    for (const line of ['/attach trace.json', '/attach binary.dat', '/attach dir', '/attach /workspace/empty.txt']) {
      submit(f.dispatch(), line)
      await flush()
    }
    submit(f.dispatch(), '/attach')
    await flush()
    expect(f.output()).toContain('4 staged files')
  })

  it('accepts the @ mention sigil, keeping @path a textual gesture that /attach upgrades', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/attach @logs/server.log')
    await flush()
    submit(f.dispatch(), '/attach')
    await flush()
    expect(f.output()).toContain('server.log')
    // The staged name is the basename, never the path the reader typed.
    expect(f.output()).not.toContain('logs/server.log')
  })

  it('rejects a duplicate of the same staged file and nothing else', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    expect(f.output()).toContain('that file is already staged')
    // The same path as an IMAGE is a different kind and stays legal.
    submit(f.dispatch(), '/image pictures/a.png')
    await flush()
    submit(f.dispatch(), '/attach pictures/a.png')
    await flush()
    expect(f.frame()).toContain('2 files')
    expect(f.frame()).toContain('1 image')
  })

  it('removes one by its listed number and clears them all', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/attach logs/server.log')
    submit(f.dispatch(), '/attach trace.json')
    await flush()

    submit(f.dispatch(), '/attach --remove 2')
    await flush()
    expect(f.output()).toContain('removed staged file trace.json')

    submit(f.dispatch(), '/attach --remove 5')
    await flush()
    expect(f.output()).toContain('no staged file has that number')

    submit(f.dispatch(), '/attach --clear')
    await flush()
    expect(f.output()).toContain('cleared 1 staged file')
    submit(f.dispatch(), '/attach')
    await flush()
    expect(f.output()).toContain('no files staged')
  })

  it('clears files without touching staged images, and vice versa', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/image pictures/a.png')
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    submit(f.dispatch(), '/attach --clear')
    await flush()
    expect(f.frame()).toContain('1 image')
    expect(f.frame()).not.toContain('1 file')
    submit(f.dispatch(), '/image --clear')
    await flush()
    expect(f.frame()).not.toContain('1 image')
  })

  it('escapes a staged name that carries terminal control characters', async () => {
    const f = await fixture()
    // The name is echoed by `/attach` and, after a send, by the transcript.
    // Escaping happens before any colour is added, and on the whole row.
    submit(f.dispatch(), '/attach ]0;pwnedevil.log')
    await flush()
    submit(f.dispatch(), '/attach')
    await flush()
    const listing = f.output()
    expect(listing).not.toContain(']0;pwned')
    expect(listing).toContain('evil.log')
  })

  it('reports unavailability without staging, on a profile with no capabilities', async () => {
    // Optional is optional: a profile with no filesystem and no attachment
    // store still starts, and `/attach` says so instead of becoming a boot
    // dependency.
    const f = await fixture({ capabilities: false })
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    expect(f.output()).toContain('attachment and filesystem services')
    expect(f.frame()).not.toContain('1 file')
    // `/image` behaves the same way it always did.
    submit(f.dispatch(), '/image pictures/a.png')
    await flush()
    expect(f.output()).toContain('attachment and filesystem services')
  })
})

describe('prompt content', () => {
  it('sends the reader\'s words and one FileBlock, in that order', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    submit(f.dispatch(), 'Can you inspect this log?')
    await flush()

    expect(f.saves).toHaveBeenCalledOnce()
    expect(f.agent.followup).toHaveBeenCalledOnce()
    expect(sent(f)).toEqual([
      { type: 'text', attachment: undefined, ...{ text: 'Can you inspect this log?' } as object },
      { type: 'file', attachment: expect.objectContaining({ name: 'server.log' }) },
    ])
    expect(f.frame()).not.toContain('1 file')
  })

  it('sends an attachment-only message with no fabricated text block', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/attach trace.json')
    await flush()
    submitEmpty(f.dispatch())
    await flush()

    expect(f.agent.followup).toHaveBeenCalledOnce()
    const content = f.agent.followup.mock.calls[0]?.[0] as { content: { type: string }[] }
    // An empty text block would put a turn of the reader's own words in the
    // durable log that they never typed, and in every replay of it.
    expect(content.content.map(block => block.type)).toEqual(['file'])
  })

  it('still swallows an empty submission when nothing is staged', async () => {
    const f = await fixture()
    submitEmpty(f.dispatch())
    await flush()
    submit(f.dispatch(), '   ')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.saves).not.toHaveBeenCalled()
  })

  it('routes an attachment-only send by the same queue-or-steer decision', async () => {
    const f = await fixture({ agentStatus: 'running' })
    submit(f.dispatch(), '/attach trace.json')
    await flush()
    f.dispatch()?.({ kind: 'key', name: 'ctrl-enter' })
    await flush()
    expect(f.agent.steer).toHaveBeenCalledOnce()
    expect(f.agent.followup).not.toHaveBeenCalled()
  })

  it('reads only through windowed reads, never a whole-file read', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/attach binary.dat')
    await flush()
    submit(f.dispatch(), 'look')
    await flush()
    expect(f.windows).toHaveBeenCalled()
    // `readBytes` is the IMAGE path. A generic file that used it would be
    // buffering the whole file, which is the thing this design exists to avoid.
    expect(f.reads).not.toHaveBeenCalled()
  })

  it('commits a zero-byte file as a real attachment', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/attach empty.txt')
    await flush()
    submit(f.dispatch(), 'what does this hold?')
    await flush()
    expect(f.agent.followup).toHaveBeenCalledOnce()
    expect(sent(f)[1]).toEqual({ type: 'file', attachment: expect.objectContaining({ bytes: 0 }) })
  })

  it('consumes a draft only after a successful Agent admission', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    expect(f.frame()).toContain('1 file')
    submit(f.dispatch(), 'inspect')
    await flush()
    expect(f.agent.followup).toHaveBeenCalledOnce()
    expect(f.frame()).not.toContain('1 file')
  })
})

describe('mixed image and file order', () => {
  it('preserves the order every kind was staged in', async () => {
    // The regression this feature exists to prevent: grouping the images ahead
    // of the files would produce image, image, file, file for this input.
    const f = await fixture()
    submit(f.dispatch(), '/image pictures/a.png')
    submit(f.dispatch(), '/attach trace.json')
    submit(f.dispatch(), '/image pictures/c.png')
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    expect(f.frame()).toContain('2 images · 2 files')

    submit(f.dispatch(), 'Compare these.')
    await flush()

    expect(sent(f).map(block => block.type)).toEqual(['text', 'image', 'file', 'image', 'file'])
    expect(sent(f).map(block => block.attachment?.name)).toEqual([
      undefined, 'a.png', 'trace.json', 'c.png', 'server.log',
    ])
  })

  it('preserves mixed order on an attachment-only submission', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/attach trace.json')
    submit(f.dispatch(), '/image pictures/a.png')
    await flush()
    submitEmpty(f.dispatch())
    await flush()
    expect(sent(f).map(block => block.type)).toEqual(['file', 'image'])
  })

  it('numbers each listing within its own kind, not across the ledger', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/image pictures/a.png')
    submit(f.dispatch(), '/attach trace.json')
    submit(f.dispatch(), '/image pictures/c.png')
    await flush()
    submit(f.dispatch(), '/image')
    await flush()
    // Only this command's own output: the earlier commits staged a.png, c.png,
    // and trace.json by name, and a whole-transcript search would find them all.
    const listing = f.commits.at(-1)?.map(stripAnsi).join('\n') ?? ''
    expect(listing).toContain('1. a.png')
    expect(listing).toContain('2. c.png')
    expect(listing).not.toContain('trace.json')
  })
})

describe('in-flight staging', () => {
  it('sends exactly the snapshot it took, and never a later draft', async () => {
    // Deterministic, not timed: the first window of the first file is held open
    // until the test releases it, so the attempt to add a third draft is
    // provably made while admission is in flight.
    const files = freshFiles()
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const f = await fixture({ files, onWindow: key => (key.endsWith('server.log') ? gate : Promise.resolve()) })
    submit(f.dispatch(), '/attach logs/server.log')
    submit(f.dispatch(), '/attach trace.json')
    await flush()
    submit(f.dispatch(), 'look at these')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()

    submit(f.dispatch(), '/attach binary.dat')
    await flush()
    // The admission owns an immutable snapshot, so a mutation now is refused
    // rather than silently landing outside the message this send is about to
    // deliver. This is the guarantee that makes "consume the batch" and "clear
    // the ledger" equivalent here — and the first of the two is what keeps them
    // equivalent if that ever stops being true.
    expect(f.output()).toContain('staged files cannot change yet')

    release?.()
    await flush()
    expect(f.agent.followup).toHaveBeenCalledOnce()
    expect(sent(f).slice(1).map(block => block.attachment?.name))
      .toEqual(['server.log', 'trace.json'])
    expect(f.frame()).not.toContain('1 file')

    // A draft staged after the delivery is the reader's own next message, and
    // the completed submission does not touch it.
    submit(f.dispatch(), '/attach binary.dat')
    await flush()
    expect(f.frame()).toContain('1 file')
  })

  it('keeps a file staged while an unrelated command is still in flight', async () => {
    // The ownership case the prompt path cannot reach, because it refuses
    // mutations: a command that started with a file staged and admitted no
    // attachment envelope owns no drafts, so its eventual success must not
    // consume what the reader staged while it ran.
    let finish: ((value: unknown) => void) | undefined
    const f = await fixture({
      commands: [{ name: 'goal', description: 'set a goal' }],
      execute: () => new Promise(resolve => { finish = resolve }),
    })
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    submit(f.dispatch(), '/goal ship it')
    await flush()
    expect(f.commands.execute).toHaveBeenCalledOnce()

    submit(f.dispatch(), '/attach trace.json')
    await flush()
    finish?.({ commandId: 'c-1', result: { kind: 'success' } })
    await flush()

    expect(f.frame()).toContain('2 files')
    submit(f.dispatch(), '/attach')
    await flush()
    const listing = f.commits.at(-1)?.map(stripAnsi).join('\n') ?? ''
    expect(listing).toContain('1. server.log')
    expect(listing).toContain('2. trace.json')
  })

  it('refuses a draft mutation while a submission is in flight, and both kinds alike', async () => {
    const files = freshFiles()
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const f = await fixture({
      files,
      onWindow: (key, signal) => (key.endsWith('server.log') ? gate : Promise.resolve()).finally(() => { void signal }),
    })
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()

    submit(f.dispatch(), '/attach later.log')
    submit(f.dispatch(), '/attach --clear')
    submit(f.dispatch(), '/image pictures/a.png')
    await flush()
    expect(f.output()).toContain('staged files cannot change yet')
    expect(f.output()).toContain('staged images cannot change yet')
    // Listing stays available, because it cannot change what the submission owns.
    submit(f.dispatch(), '/attach')
    await flush()
    expect(f.output()).toContain('1 staged file')

    release?.()
    await flush()
    expect(f.agent.followup).toHaveBeenCalledOnce()
  })

  it('lets ctrl-c cancel a file admission without quitting, and keeps the drafts', async () => {
    // A backend that is slow rather than dead: it only answers when cancelled.
    const f = await fixture({
      onWindow: (_key, signal) => new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      }),
    })
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    submit(f.dispatch(), 'first prompt')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()

    f.dispatch()?.({ kind: 'key', name: 'ctrl-c' })
    await flush()
    expect(f.exit).not.toHaveBeenCalled()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.output()).toContain('attachment cancelled')
    clearComposer(f)
    await flush()
    expect(f.frame()).toContain('1 file')
  })
})

describe('failure handling', () => {
  it('keeps the draft and the prompt when the path is gone, and retries cleanly', async () => {
    const files = freshFiles()
    let gone = false
    const f = await fixture({ files })
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    files.delete('/workspace/logs/server.log')
    gone = true
    expect(gone).toBe(true)

    submit(f.dispatch(), 'inspect this')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.output()).toContain('file no longer exists')
    // The text comes back so the reader can fix the path and resend.
    expect(f.frame()).toContain('inspect this')
    clearComposer(f)
    await flush()
    expect(f.frame()).toContain('1 file')

    files.set('/workspace/logs/server.log', { data: text('back\n'), type: 'file', version: 'v1' })
    f.dispatch()?.({ kind: 'key', name: 'enter' })
    await flush()
    expect(f.agent.followup).toHaveBeenCalledOnce()
  })

  it('refuses a directory with a path-safe sentence', async () => {
    const f = await fixture()
    submit(f.dispatch(), '/attach dir')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.output()).toContain('that path is not a regular file')
    clearComposer(f)
    await flush()
    expect(f.frame()).toContain('1 file')
  })

  it('never echoes a host path out of a filesystem failure', async () => {
    const f = await fixture({
      serve: () => ({ code: 'FS_PERMISSION_DENIED', message: 'cannot read "/private/secret/server.log"' }),
    })
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()
    const output = f.output()
    expect(output).toContain('file cannot be read by this profile')
    expect(output).not.toContain('/private/secret')
    expect(f.agent.followup).not.toHaveBeenCalled()
  })

  it('reports an unreadable file as a READ failure, not a storage one', async () => {
    // Found by driving the real profile: the local store labels whatever a
    // window read raises as its own storage failure, so the reader was told
    // "could not persist" about a file nobody had read. The source failure has
    // to win, and the store's relabelling has to be exercised to prove it.
    const f = await fixture({
      relabelSourceFailure: true,
      serve: () => ({ code: 'FS_PERMISSION_DENIED', message: 'permission denied' }),
    })
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.output()).toContain('file cannot be read by this profile')
    expect(f.output()).not.toContain('persist')
  })

  it('still reports a genuine store failure with the store\'s own words', async () => {
    const f = await fixture({
      saveFileFailure: Object.assign(new Error('Unable to persist attachment.'), { code: 'ATTACHMENT_WRITE_FAILED' }),
    })
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    // Harness authored this, and its error class documents the message as
    // carrying no bytes and no host paths, so it is shown as written — without
    // a second full stop behind it.
    expect(f.output()).toContain('✗ Unable to persist attachment; nothing was sent')
  })

  it('reports a sandbox denial as a profile limitation', async () => {
    const f = await fixture({ serve: () => ({ code: 'FS_SANDBOX_DENIED', message: 'denied' }) })
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()
    expect(f.output()).toContain('file cannot be read by this profile')
  })

  it('refuses to send when the file changed while it was being attached', async () => {
    // `readByteRange` carries no version precondition, so this is the only
    // evidence that the bytes stored are the bytes that were there.
    const files = freshFiles()
    const f = await fixture({ files, onRead: () => { files.set('/workspace/trace.json', { data: text('{"ok":false}'), type: 'file', version: 'v2' }) } })
    submit(f.dispatch(), '/attach trace.json')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.output()).toContain('the file changed while it was being attached')
    // The draft stays, so a retry is one keystroke away.
    clearComposer(f)
    await flush()
    expect(f.frame()).toContain('1 file')
  })

  it('says a provider cannot store files, and keeps the draft', async () => {
    const f = await fixture({
      saveFileFailure: Object.assign(
        new Error('The mounted attachment provider cannot stream verbatim files.'),
        { code: 'ATTACHMENT_FILES_UNSUPPORTED' },
      ),
    })
    submit(f.dispatch(), '/attach trace.json')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.output()).toContain('does not support generic files')
    clearComposer(f)
    await flush()
    expect(f.frame()).toContain('1 file')
  })

  it('keeps a Harness-authored storage diagnostic rather than flattening it', async () => {
    const f = await fixture({
      saveFileFailure: Object.assign(new Error('the stored object could not be written'), { code: 'ATTACHMENT_WRITE_FAILED' }),
    })
    submit(f.dispatch(), '/attach trace.json')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.output()).toContain('the stored object could not be written')
  })

  it('sends nothing at all when a later file fails after an earlier one committed', async () => {
    // All or nothing from the reader's side. The first file's object may exist
    // and be unreachable, which is the provider's retention to collect.
    const f = await fixture({ serve: key => key.endsWith('server.log') ? { code: 'FS_IO_ERROR', message: 'io' } : undefined })
    submit(f.dispatch(), '/attach trace.json')
    submit(f.dispatch(), '/attach logs/server.log')
    await flush()
    submit(f.dispatch(), 'inspect both')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.agent.steer).not.toHaveBeenCalled()
    // Both drafts survive for a corrected retry.
    clearComposer(f)
    await flush()
    expect(f.frame()).toContain('2 files')
  })

  it('sends nothing when an image in a mixed batch fails to store', async () => {
    const f = await fixture({ serve: () => ({ code: 'FS_IO_ERROR', message: 'io' }) })
    submit(f.dispatch(), '/image pictures/a.png')
    submit(f.dispatch(), '/attach trace.json')
    await flush()
    submit(f.dispatch(), 'inspect')
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    clearComposer(f)
    await flush()
    expect(f.frame()).toContain('1 image · 1 file')
  })

  it('does not deliver a late durable save across a session transition', async () => {
    let finish: ((value: { attachmentId: string; name: string; bytes: number }) => void) | undefined
    const f = await fixture({ saveFile: () => new Promise(resolve => { finish = resolve }) })
    submit(f.dispatch(), '/attach trace.json')
    await flush()
    submit(f.dispatch(), 'old session prompt')
    await flush()
    submit(f.dispatch(), '/new')
    await flush()
    await f.attachment
    const commitsBefore = f.commits.length
    const frameBefore = f.frame()

    finish?.({ attachmentId: 'sha256:late', name: 'trace.json', bytes: 11 })
    await flush()
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.commits).toHaveLength(commitsBefore)
    expect(f.frame()).toBe(frameBefore)
  })

  it('refuses a text-only model before reading, and says why', async () => {
    // Only images carry a modality question; a verbatim file is a durable
    // handle the request assembly projects to text on every route.
    const f = await fixture({ inputModalities: ['text'] })
    submit(f.dispatch(), '/attach trace.json')
    await flush()
    submit(f.dispatch(), 'look')
    await flush()
    expect(f.saves).toHaveBeenCalledOnce()
    expect(f.agent.followup).toHaveBeenCalledOnce()

    const g = await fixture({ inputModalities: ['text'] })
    submit(g.dispatch(), '/image pictures/a.png')
    await flush()
    submit(g.dispatch(), 'look')
    await flush()
    expect(g.reads).not.toHaveBeenCalled()
    expect(g.agent.followup).not.toHaveBeenCalled()
    expect(g.output()).toContain('does not support image input')
  })
})

describe('registered commands', () => {
  it('runs a command that takes no attachments and leaves the file staged', async () => {
    // A command that declares no attachment input has told us it takes none, so
    // the staged file was not going to be part of this invocation either way.
    const f = await fixture({
      commands: [{ name: 'echo', description: 'echo' }],
      commandResult: { commandId: 'c-1', result: { kind: 'success' } },
    })
    submit(f.dispatch(), '/attach trace.json')
    await flush()
    submit(f.dispatch(), '/echo hello')
    await flush()
    expect(f.commands.execute).toHaveBeenCalledWith(
      expect.anything(), '/echo hello', [], expect.any(AbortSignal),
    )
    expect(f.saves).not.toHaveBeenCalled()
    expect(f.frame()).toContain('1 file')
  })

  it('refuses an attachment-declaring command rather than silently omitting the file', async () => {
    // The adopted command contract admits a generic file only as a staged
    // upload receipt resolved by the Session upload owner, and no such owner is
    // mounted here. Fabricating a receipt id is not an option, so the
    // invocation is refused and everything survives.
    const f = await fixture({
      commands: [{ name: 'vision', description: 'inspect', input: { hint: 'ask', attachments: true } }],
      commandResult: { commandId: 'c-1', result: { kind: 'success' } },
    })
    submit(f.dispatch(), '/attach trace.json')
    await flush()
    submit(f.dispatch(), '/vision inspect this')
    await flush()
    expect(f.commands.execute).not.toHaveBeenCalled()
    expect(f.saves).not.toHaveBeenCalled()
    expect(f.output()).toContain('needs files uploaded before it can run')
    expect(f.frame()).toContain('1 file')
    // The line is still in input history, so ↑ brings it back.
    expect(f.output()).not.toContain('1 staged file')
  })

  it('keeps the existing staged-image command path working', async () => {
    const f = await fixture({
      commands: [{ name: 'vision', description: 'inspect', input: { hint: 'ask', attachments: true } }],
      commandResult: { commandId: 'c-1', result: { kind: 'success' } },
    })
    submit(f.dispatch(), '/image pictures/a.png')
    await flush()
    submit(f.dispatch(), '/vision inspect this')
    await flush()
    expect(f.commands.execute).toHaveBeenCalledWith(
      expect.anything(),
      '/vision inspect this',
      [{ type: 'image', mediaType: 'image/png', data: 'AQID', name: 'a.png' }],
      expect.any(AbortSignal),
    )
    // The command registry, not dshline, owns durable admission on that path.
    expect(f.saves).not.toHaveBeenCalled()
    expect(f.frame()).not.toContain('1 image')
  })

  it('still refuses a command that takes no attachments when an image is staged', async () => {
    const f = await fixture({ commands: [{ name: 'ask', description: 'ask', input: { hint: 'q' } }] })
    submit(f.dispatch(), '/image pictures/a.png')
    await flush()
    submit(f.dispatch(), '/ask what is this')
    await flush()
    expect(f.commands.execute).not.toHaveBeenCalled()
    expect(f.output()).toContain('does not accept image attachments')
  })
})
