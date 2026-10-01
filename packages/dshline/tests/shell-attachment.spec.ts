/** Human shell gestures through the real composer, routing and attachment scope. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { isAttachmentError } from '@deepseek-ai/dsh-attachment'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { ShellExecutor, ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { SkillCatalog } from '../src/skills/catalog.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import { createWindowExitRequest } from '../src/window.ts'
import type { Window } from '../src/window.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import { RetainedCollector } from './shell-output.fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function flush(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
  else await new Promise<void>(resolve => { setImmediate(resolve) })
}

function textOf(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : `<${block.type}>`).join('')
}

/** A direct execution that can settle before its fictitious managed range. */
function process(spec: ShellExecSpec, autoSettle: boolean) {
  const done = Promise.withResolvers<void>()
  const result = Promise.withResolvers<ShellRunResult>()
  const rangeDone = Promise.withResolvers<void>()
  const observed = { stdout: new RetainedCollector(), stderr: new RetainedCollector() }
  const rangeAborts = vi.fn()
  let ended = false
  const handle: ShellExecution = {
    status: 'running', exitCode: null, signal: null, done: done.promise, observed,
    result: vi.fn(() => result.promise),
    readOutput: vi.fn(() => { throw new Error('consuming output is forbidden') }),
    kill: vi.fn(() => { finish({ aborted: true, exitCode: null, signal: 'SIGTERM' }); return true }),
  }
  function finish(facts: Partial<ShellRunResult> = {}) {
    if (ended) return
    ended = true
    const value: ShellRunResult = {
      exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
      stdout: { text: 'final stdout must not be replayed', truncated: false },
      stderr: { text: 'final stderr must not be replayed', truncated: false }, ...facts,
    }
    handle.status = value.signal === null ? 'completed' : 'killed'
    handle.exitCode = value.exitCode
    handle.signal = value.signal
    result.resolve(value)
    done.resolve()
  }
  const abort = () => {
    rangeAborts()
    if (autoSettle && !ended) finish({ aborted: true, exitCode: null, signal: 'SIGTERM' })
  }
  spec.signal?.addEventListener('abort', abort)
  if (spec.signal?.aborted) abort()
  return {
    handle, observed, spec, finish, rangeAborts, rangeDone,
    dispose: () => { spec.signal?.removeEventListener('abort', abort); rangeDone.resolve(); finish() },
  }
}

/** Fresh real session/registries, fake terminal/Agent and capability providers. */
async function fixture(options: {
  shell?: boolean
  sandboxMode?: 'read-only' | 'workspace-write'
  policy?: boolean
  cwd?: string | null
  resumed?: boolean
  status?: 'idle' | 'running'
  busyEnter?: 'queue' | 'steer'
  autoSettle?: boolean
  prepare?: boolean
  startupTask?: string
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TuiSlots)
  await ctx.plugin(SkillRegistry)
  const cwd = options.cwd === null ? undefined : options.cwd ?? '/attached'
  const session = ctx.sessions.create(undefined, { meta: cwd === undefined ? {} : { cwd } })
  ctx.effect(() => ctx.skills.registerProvider(() => ({
    name: 'shell-spec',
    list: async () => [{
      name: 'review', description: 'Review source', invocation: { modelInvocable: true, userInvocable: true },
      source: 'project-dsh', provider: 'shell-spec', rank: 100, locator: 'review',
    }],
    get: async () => undefined,
  })), 'shell attachment skill fixture')
  ctx.provide('tools', { get: () => undefined })
  const commands = {
    list: () => [{ name: 'registered', description: 'A normal registered command' }],
    execute: vi.fn(async (_agent: unknown, line: string) => line.startsWith('/registered')
      ? { commandId: 'registered', result: { kind: 'success' as const } }
      : undefined),
  }
  ctx.provide('commands', commands as never)
  ctx.provide('userQuestions', {} as never)
  const event = vi.fn()
  ctx.on('session/event', event)

  const requests: ReturnType<typeof process>[] = []
  const prepare = Promise.withResolvers<void>()
  const prepareAborts = vi.fn()
  const shell: Pick<ShellExecutor, 'sandboxMode' | 'resolve' | 'execute'> = {
    sandboxMode: options.sandboxMode,
    resolve: vi.fn((request: ShellExecRequest) => ({
      ...request, command: request.command, workdir: request.workdir ?? '/executor-default',
      onExpiry: request.onExpiry ?? 'kill', timeoutMs: 30_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 12_000, sandboxPolicy: request.sandboxPolicy,
    })),
    execute: vi.fn(async spec => {
      if (options.prepare) {
        spec.signal?.addEventListener('abort', prepareAborts, { once: true })
        try { await prepare.promise; spec.signal?.throwIfAborted() }
        finally { spec.signal?.removeEventListener('abort', prepareAborts) }
      }
      const run = process(spec, options.autoSettle !== false)
      requests.push(run)
      return run.handle
    }),
  }
  if (options.shell !== false) ctx.provide('shell', shell as never)
  let mode: 'read-only' | 'workspace-write' = 'read-only'
  const policy = {
    resolve: vi.fn(() => ({ mode, workspaceRoot: cwd ?? '/startup' })),
  }
  if (options.policy) ctx.provide('sandboxPolicy', policy as never)

  const reads = vi.fn(async () => Uint8Array.of(1, 2, 3))
  const windows = vi.fn(async (_target: unknown, range: { offset: number; length: number }) =>
    new TextEncoder().encode('log content').slice(range.offset, range.offset + range.length))
  const saveImages = vi.fn(async (inputs: readonly { name?: string; mediaType: string }[]) => inputs.map(input => ({
    attachmentId: 'image-reference', name: input.name, mediaType: input.mediaType, bytes: 3, width: 2, height: 1,
  })))
  const saveFileStream = vi.fn(async (input: { name?: string; data: AsyncIterable<Uint8Array> }) => {
    let bytes = 0
    for await (const chunk of input.data) bytes += chunk.byteLength
    return { attachmentId: 'file-reference', name: input.name, bytes }
  })
  ctx.provide('fs', {
    resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
    readBytes: reads, readByteRange: windows, listDir: async () => [],
    stat: async () => ({ version: 'v1', type: 'file', size: 11 }),
  } as never)
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 20, maxImagesPerMessage: 3, maxMessageImageBytes: 50,
      maxImagePixels: 100, maxImageDimension: 10, mediaTypes: ['image/png'],
    },
    saveImages, saveFileStream, isAttachmentError,
  } as never)

  const inbox = createInboxStub()
  const agent = {
    session, status: options.status ?? 'idle', inbox,
    followup: vi.fn((message: UserMessage) => { inbox.append('next-turn', message) }),
    steer: vi.fn((message: UserMessage) => { inbox.append('next-step', message) }),
    cancel: vi.fn(() => { inbox.clear() }),
  }
  const commits: string[][] = []
  const exit = vi.fn()
  let exitHandler: (() => void) | undefined
  let dispatch: ((key: Key) => void) | undefined
  let latest: string[] = []
  const compose = (): void => { latest = ctx.tuiSlots.compose(80, 24).lines }
  const draws = vi.fn(compose)
  const requestExit = createWindowExitRequest(exit, () => exitHandler)
  const window = {
    ctx, terminal: { columns: () => 80, rows: () => 24 }, exit, requestExit,
    startup: { cwd: '/startup', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined), peakHours: [], version: 'test',
    selection: { current: undefined }, modelInfo: { contextWindow: undefined, reasoning: undefined },
    modelCompletionValues: () => Promise.resolve([]),
    prefs: { usageMode: 'cost', timing: false, cardDetail: 'compact', reasoningVisible: true, busyEnter: options.busyEnter ?? 'queue' },
    colorDepth: 0, palette: () => ({}), setPalette: () => {}, themeSettings: {},
    busyEnterSettings: { current: () => 'queue', watch: () => () => {}, save: async () => undefined },
    pendingTask: options.startupTask, draw: draws, paintNow: draws,
    commit: (rows: readonly string[]) => { commits.push([...rows]) }, clear: vi.fn(), refreshModelInfo: () => {},
    setDispatch: (handler?: (key: Key) => void) => { dispatch = handler },
    setExit: (handler?: () => void) => { exitHandler = handler },
  } as unknown as Window
  const disposeAgent = vi.fn(async () => {})
  const outcome = {
    target: options.resumed ? { kind: 'resume', id: session.id } : { kind: 'new', cwd: cwd ?? '/startup' },
    attached: { handle: { agent, dispose: disposeAgent }, reopened: options.resumed ?? false },
  } as unknown as AttachOutcome
  const attachment = attachSession(window, outcome)
  const press = (name: string) => { dispatch?.({ kind: 'key', name } as Key) }
  const submit = async (line: string, key: 'enter' | 'ctrl-enter' = 'enter') => {
    expect(dispatch).toBeDefined()
    dispatch?.({ kind: 'text', text: line })
    press(key)
    await flush()
  }
  await flush()
  const verify = vi.spyOn(SkillCatalog.prototype, 'verify')
  cleanups.push(async () => {
    requestExit()
    prepare.resolve()
    for (const run of requests) run.dispose()
    await flush()
    await ctx.fiber.dispose()
    if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0)
  })
  return {
    ctx, session, agent, inbox, commands, requests, prepare, prepareAborts, shell, policy, verify,
    setMode: (next: typeof mode) => { mode = next },
    reads, windows, saveImages, saveFileStream, event, commits, draws, window, exit, requestExit,
    press, submit, attachment, disposeAgent,
    output: () => commits.flat().map(stripAnsi).join('\n'),
    frame: () => latest.map(stripAnsi).join('\n'),
  }
}

describe('assembled human shell routing', () => {
  it('intercepts the first meaningful bang before command/skill/inbox routes and records only local history', async () => {
    const f = await fixture({ status: 'running' })
    const before = f.session.snapshotEvents()
    await f.submit('  !  printf \'/review **literal**\'  ')
    expect(f.agent.followup).not.toHaveBeenCalled()
    expect(f.agent.steer).not.toHaveBeenCalled()
    expect(f.requests[0]?.spec.command).toBe('  printf \'/review **literal**\'  ')
    expect(f.commands.execute).not.toHaveBeenCalled()
    expect(f.verify).not.toHaveBeenCalled()
    expect(f.event).not.toHaveBeenCalled()
    expect(f.session.snapshotEvents()).toEqual(before)
    expect(f.output()).toContain('› !  printf')
    f.requests[0]?.finish()
    await flush()
    f.press('up')
    expect(f.frame()).toContain('  !  printf')
    f.press('enter')
    await flush()
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]?.spec.command).toBe(f.requests[0]?.spec.command)
    expect(f.inbox.nextTurn).toEqual([])
    expect(f.inbox.nextStep).toEqual([])
  })

  it('recognizes bare and whitespace-only bang locally, and treats a nonleading bang as ordinary text', async () => {
    const f = await fixture()
    await f.submit('!')
    await f.submit('   !   ')
    expect(f.output().match(/use !<command>/gu)).toHaveLength(2)
    expect(f.shell.execute).not.toHaveBeenCalled()
    expect(f.agent.followup).not.toHaveBeenCalled()
    await f.submit('ask about !printf')
    expect(f.inbox.nextTurn.map(textOf)).toEqual(['ask about !printf'])
  })

  it.each([false, true])('uses attached cwd rather than startup cwd (resumed=%s)', async resumed => {
    const f = await fixture({ resumed, cwd: '/retained-session' })
    await f.submit('!pwd')
    expect(f.requests[0]?.spec.workdir).toBe('/retained-session')
    expect(f.requests[0]?.spec.onExpiry).toBe('none')
    expect(f.requests[0]?.spec.stdoutMaxBytes).toBe(64_000)
    expect(f.requests[0]?.spec).not.toHaveProperty('env')
    expect(f.requests[0]?.spec).not.toHaveProperty('dshEnv')
  })

  it('uses startup cwd only when Session header cwd is absent', async () => {
    const f = await fixture({ cwd: null })
    await f.submit('!pwd')
    expect(f.requests[0]?.spec.workdir).toBe('/startup')
  })

  it('resolves mounted sandbox policy with this Session on each run, not at startup', async () => {
    const f = await fixture({ policy: true, sandboxMode: 'read-only' })
    expect(f.policy.resolve).not.toHaveBeenCalled()
    await f.submit('!one')
    expect(f.policy.resolve).toHaveBeenCalledExactlyOnceWith({ session: f.session })
    expect(f.requests[0]?.spec.sandboxPolicy?.mode).toBe('read-only')
    f.requests[0]?.finish()
    await flush()
    f.setMode('workspace-write')
    await f.submit('!two')
    expect(f.policy.resolve).toHaveBeenCalledTimes(2)
    expect(f.requests[1]?.spec.sandboxPolicy?.mode).toBe('workspace-write')
  })

  it('fails locally for missing shell and fails closed for missing sandbox policy without inbox delivery', async () => {
    for (const options of [{ shell: false }, { sandboxMode: 'read-only' as const }]) {
      const f = await fixture(options)
      await f.submit('!must-not-run')
      expect(f.shell.execute).not.toHaveBeenCalled()
      expect(f.agent.followup).not.toHaveBeenCalled()
      expect(f.agent.steer).not.toHaveBeenCalled()
      expect(f.verify).not.toHaveBeenCalled()
      expect(f.output()).toContain('unavailable')
      expect(f.frame()).not.toContain('shell running')
    }
  })

  it('rejects a second foreground shell while ordinary queued/steering prompts still use current delivery', async () => {
    const f = await fixture({ status: 'running', busyEnter: 'queue' })
    await f.submit('!first')
    await f.submit('!second')
    expect(f.requests).toHaveLength(1)
    expect(f.output()).toContain('a shell command is still running')
    await f.submit('queued prompt')
    await f.submit('accelerated steer', 'ctrl-enter')
    f.window.prefs.busyEnter = 'steer'
    await f.submit('preference steer')
    expect(f.inbox.nextTurn.map(textOf)).toEqual(['queued prompt'])
    expect(f.inbox.nextStep.map(textOf)).toEqual(['accelerated steer', 'preference steer'])
    expect(f.requests).toHaveLength(1)
  })

  it('leaves local, registered, skill and unknown-slash paths intact while a shell is active', async () => {
    const f = await fixture()
    await f.submit('!background-looking-but-foreground')
    await f.submit('/enter steer')
    expect(f.window.prefs.busyEnter).toBe('steer')
    expect(f.commands.execute).not.toHaveBeenCalled()
    await f.submit('/registered argument')
    expect(f.commands.execute).toHaveBeenCalledExactlyOnceWith(f.agent, '/registered argument', [], expect.any(AbortSignal))
    expect(f.agent.followup).not.toHaveBeenCalled()
    await f.submit('/review inspect this')
    expect(f.inbox.nextTurn.map(textOf)).toEqual(['/review inspect this'])
    expect(f.verify).toHaveBeenCalledWith('review', expect.any(AbortSignal))
    await f.submit('/not-a-command x')
    expect(f.output()).toContain('unknown command: /not-a-command')
    expect(f.inbox.nextTurn).toHaveLength(1)
    expect(f.requests).toHaveLength(1)
  })

  it('keeps staged image/file drafts untouched by shell and admits them on the next ordinary prompt', async () => {
    const f = await fixture()
    await f.submit('/image picture.png')
    await f.submit('/attach server.log')
    expect(f.frame()).toContain('1 image')
    expect(f.frame()).toContain('1 file')
    await f.submit('!printf no-admission')
    expect(f.reads).not.toHaveBeenCalled()
    expect(f.windows).not.toHaveBeenCalled()
    expect(f.saveImages).not.toHaveBeenCalled()
    expect(f.saveFileStream).not.toHaveBeenCalled()
    expect(f.frame()).toContain('1 image')
    expect(f.frame()).toContain('1 file')
    await f.submit('inspect both')
    expect(f.inbox.nextTurn.map(textOf)).toEqual(['inspect both<image><file>'])
    expect(f.saveImages).toHaveBeenCalledOnce()
    expect(f.saveFileStream).toHaveBeenCalledOnce()
    const blocks = f.inbox.nextTurn[0]?.content
    expect(blocks).toEqual([
      { type: 'text', text: 'inspect both' },
      { type: 'image', attachment: expect.objectContaining({ attachmentId: 'image-reference', name: 'picture.png' }) },
      { type: 'file', attachment: expect.objectContaining({ attachmentId: 'file-reference', name: 'server.log' }) },
    ])
    expect(f.frame()).not.toContain('1 image')
    expect(f.frame()).not.toContain('1 file')
  })
})

describe('assembled shell cancellation and settlement', () => {
  it.each(['idle', 'running'] as const)('prioritizes repeated Ctrl-C over overlays and model/quit until shell settles (%s)', async status => {
    const f = await fixture({ status, autoSettle: false })
    await f.submit('!long')
    const overlayKey = vi.fn()
    const remove = f.ctx.tuiSlots.pushOverlay({ render: () => ['overlay'], handleKey: overlayKey })
    f.press('ctrl-c')
    f.press('ctrl-c')
    expect(f.requests[0]?.spec.signal?.aborted).toBe(true)
    expect(f.requests[0]?.rangeAborts).toHaveBeenCalledOnce()
    expect(overlayKey).not.toHaveBeenCalled()
    expect(f.agent.cancel).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
    f.requests[0]?.finish({ aborted: true, exitCode: null, signal: 'SIGTERM' })
    await flush()
    expect(f.output()).toContain('[shell interrupted]')
    f.press('ctrl-c')
    expect(overlayKey).toHaveBeenCalledOnce()
    remove()
    f.press('ctrl-c')
    if (status === 'running') expect(f.agent.cancel).toHaveBeenCalledOnce()
    else expect(f.exit).toHaveBeenCalledOnce()
  })

  it('keeps preparation cancellation local until it settles, then releases foreground ownership', async () => {
    const f = await fixture({ prepare: true, status: 'running' })
    await f.submit('!preparing')
    f.press('ctrl-c')
    f.press('ctrl-c')
    expect(f.prepareAborts).toHaveBeenCalledOnce()
    expect(f.agent.cancel).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
    await f.submit('!second')
    expect(f.shell.execute).toHaveBeenCalledOnce()
    expect(f.output()).toContain('a shell command is still running')
    f.prepare.resolve()
    await flush()
    expect(f.output()).toContain('[shell interrupted]')
    expect(f.frame()).not.toContain('shell cancellation requested')
    await f.submit('!after-cancel')
    expect(f.shell.execute).toHaveBeenCalledTimes(2)
    expect(f.requests).toHaveLength(1)
  })

  it('requests retained-range termination in finally after successful direct settlement without claiming range quiescence', async () => {
    const f = await fixture()
    await f.submit('!leader')
    const run = f.requests[0]!
    let rangeSettled = false
    void run.rangeDone.promise.then(() => { rangeSettled = true })
    run.finish()
    await flush()
    expect(f.output()).toContain('[shell exit 0]')
    expect(run.rangeAborts).toHaveBeenCalledOnce()
    expect(run.spec.signal?.aborted).toBe(true)
    expect(rangeSettled).toBe(false)
    expect(f.frame()).not.toContain('shell running')
    await f.submit('!next')
    expect(f.requests).toHaveLength(2)
  })

  it('switches only after helper done, suppresses old output, and does not join an unsettled managed range', async () => {
    const f = await fixture({ autoSettle: false })
    await f.submit('!long')
    const run = f.requests[0]!
    let switched = false
    void f.attachment.then(() => { switched = true })
    await f.submit('/new')
    expect(run.spec.signal?.aborted).toBe(true)
    expect(run.rangeAborts).toHaveBeenCalledOnce()
    expect(switched).toBe(false)
    expect(f.disposeAgent).not.toHaveBeenCalled()
    const commits = f.commits.length
    run.observed.stdout.push(Buffer.from('stale output\n'))
    run.finish({ aborted: true })
    expect(await f.attachment).toEqual({ kind: 'new', cwd: '/attached' })
    expect(f.disposeAgent).toHaveBeenCalledOnce()
    expect(f.commits).toHaveLength(commits)
    expect(f.output()).not.toContain('stale output')
    let rangeSettled = false
    void run.rangeDone.promise.then(() => { rangeSettled = true })
    await flush()
    expect(rangeSettled).toBe(false)
  })

  it('aborts preparation on /new and waits for that helper rather than opening a new attachment early', async () => {
    const f = await fixture({ prepare: true })
    await f.submit('!preparing')
    expect(f.shell.execute).toHaveBeenCalledOnce()
    expect(f.requests).toHaveLength(0)
    let switched = false
    void f.attachment.then(() => { switched = true })
    await f.submit('/new')
    expect(f.prepareAborts).toHaveBeenCalledOnce()
    expect(switched).toBe(false)
    expect(f.disposeAgent).not.toHaveBeenCalled()
    f.prepare.resolve()
    expect(await f.attachment).toEqual({ kind: 'new', cwd: '/attached' })
    expect(f.requests).toHaveLength(0)
    expect(f.output()).not.toContain('[shell interrupted]')
    expect(f.disposeAgent).toHaveBeenCalledOnce()
  })

  it('can cancel a startup shell before the attachment loop reaches its switched wait', async () => {
    const f = await fixture({ prepare: true, startupTask: '!startup shell' })
    expect(f.shell.execute).toHaveBeenCalledOnce()
    expect(f.requests).toHaveLength(0)
    await f.submit('/new')
    expect(f.prepareAborts).toHaveBeenCalledOnce()
    expect(f.disposeAgent).not.toHaveBeenCalled()
    f.prepare.resolve()
    expect(await f.attachment).toEqual({ kind: 'new', cwd: '/attached' })
    expect(f.disposeAgent).toHaveBeenCalledOnce()
    expect(f.requests).toHaveLength(0)
    expect(f.output()).not.toContain('[shell interrupted]')
  })

  it('window exit aborts execution immediately and suppresses stale commits and redraw after teardown', async () => {
    const f = await fixture({ autoSettle: false, status: 'running' })
    await f.submit('!long')
    const run = f.requests[0]!
    f.requestExit()
    expect(run.spec.signal?.aborted).toBe(true)
    expect(f.agent.cancel).toHaveBeenCalledOnce()
    expect(f.exit).toHaveBeenCalledOnce()
    const commits = f.commits.length
    const draws = f.draws.mock.calls.length
    run.observed.stdout.push(Buffer.from('late stdout\n'))
    run.observed.stderr.push(Buffer.from('late stderr\n'))
    run.finish({ aborted: true })
    await flush()
    expect(f.commits).toHaveLength(commits)
    expect(f.draws).toHaveBeenCalledTimes(draws)
    expect(f.output()).not.toContain('late stdout')
    expect(f.output()).not.toContain('late stderr')
  })

  it('streams split independent UTF-8 safely before done and clears its poll timer at settlement', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    const baseline = vi.getTimerCount()
    await f.submit('!printf \'hostile\'')
    const run = f.requests[0]!
    const out = Buffer.from('界😀\x1b[2J\r\tend\n')
    const err = Buffer.from('é😀\x1b]52;c;evil\x07\n')
    for (let index = 0; index < Math.max(out.length, err.length); index += 1) {
      if (index < out.length) run.observed.stdout.push(out.subarray(index, index + 1))
      if (index < err.length) run.observed.stderr.push(err.subarray(index, index + 1))
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(f.output()).toContain('界😀^[[2J^M')
    expect(f.output()).toContain('[stderr] é😀^[]52;c;evil^G')
    expect(f.output()).not.toContain('�')
    run.observed.stdout.push(Buffer.from('unfinished stdout'))
    run.observed.stderr.push(Buffer.from('unfinished stderr'))
    await vi.advanceTimersByTimeAsync(50)
    expect(f.frame()).toContain('unfinished stdout')
    expect(f.frame()).toContain('[stderr] unfinished stderr')
    expect(f.frame()).toContain('shell running')
    expect(run.handle.result).toHaveBeenCalledOnce()
    expect(run.handle.readOutput).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(baseline + 1)
    run.finish()
    await flush()
    expect(vi.getTimerCount()).toBe(baseline)
    expect(f.frame()).not.toContain('shell running')
    expect(f.output().match(/界😀/gu)).toHaveLength(1)
    expect(f.output().match(/unfinished stdout/gu)).toHaveLength(1)
    expect(f.output().match(/\[stderr\] unfinished stderr/gu)).toHaveLength(1)
    expect(f.frame()).not.toContain('unfinished stdout')
    expect(f.frame()).not.toContain('unfinished stderr')
    expect(f.output()).not.toContain('must not be replayed')
  })
})
