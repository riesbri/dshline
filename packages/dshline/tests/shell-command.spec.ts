import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPalette } from '@dshline/renderer'
import { DEFAULT_PALETTE } from '../src/theme.ts'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ShellExecutor, ShellExecRequest, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { ShellOutput } from '../src/shell-output.ts'
import { parseShellCommand, runShellCommand } from '../src/shell-command.ts'
import { RetainedCollector } from './shell-output.fixture.ts'

const ctx = new Context()
let session: Session
beforeAll(async () => { await ctx.plugin(SessionStore); session = ctx.sessions.create() })
afterAll(async () => { await ctx.fiber.dispose() })
let restorePalette: () => void
beforeEach(() => { restorePalette = setPalette(DEFAULT_PALETTE, 0) })
afterEach(() => { vi.useRealTimers(); restorePalette() })

function execution() {
  const done = Promise.withResolvers<void>()
  const projection = Promise.withResolvers<ShellRunResult>()
  const observed = { stdout: new RetainedCollector(), stderr: new RetainedCollector() }
  const handle: ShellExecution = {
    status: 'running', exitCode: null, signal: null, done: done.promise, observed,
    readOutput: vi.fn(() => { throw new Error('must not consume output') }),
    result: vi.fn(() => projection.promise),
    kill: vi.fn(() => { finish({ signal: 'SIGTERM' }); return true }),
  }
  function finish(overrides: Partial<ShellRunResult> = {}, error?: unknown) {
    const value: ShellRunResult = {
      exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 30_000,
      stdout: { text: 'not replayed collected stdout', truncated: false },
      stderr: { text: 'not replayed collected stderr', truncated: false },
      ...overrides,
    }
    handle.exitCode = value.exitCode
    handle.signal = value.signal
    handle.status = value.signal === null ? 'completed' : 'killed'
    if (error === undefined) projection.resolve(value)
    else projection.reject(error)
    done.resolve()
  }
  return { handle, observed, finish }
}

function scenario() {
  const fake = execution()
  const rows: string[] = []
  const output = new ShellOutput(batch => { rows.push(...batch) })
  const controller = new AbortController()
  const shell: Pick<ShellExecutor, 'sandboxMode' | 'resolve' | 'execute'> = {
    sandboxMode: undefined,
    resolve: vi.fn((request: ShellExecRequest) => ({
      command: request.command, workdir: request.workdir ?? '/default', timeoutMs: 30_000,
      onExpiry: request.onExpiry ?? 'kill', stdoutMaxBytes: request.stdoutMaxBytes ?? 12_000,
      sandboxPolicy: request.sandboxPolicy, signal: request.signal,
    })),
    execute: vi.fn(async () => fake.handle),
  }
  const options: Parameters<typeof runShellCommand>[0] = {
    command: '  printf source  ', shell, sandboxPolicy: undefined, session,
    workdir: '/session cwd', signal: controller.signal, output, changed: vi.fn(),
  }
  return { ...fake, rows, controller, shell, options }
}

describe('human shell source parsing', () => {
  it('uses trimStart only to detect and strips only the meaningful bang', () => {
    expect(parseShellCommand(' \t!  printf a  \n ')).toBe('  printf a  \n ')
    expect(parseShellCommand('!')).toBe('')
    expect(parseShellCommand('   !   ')).toBe('   ')
    expect(parseShellCommand('!!word')).toBe('!word')
    for (const text of ['hello !shell', '/!shell', ' \nplain', '']) expect(parseShellCommand(text)).toBeUndefined()
  })
})

describe('foreground shell runner', () => {
  it('fails locally without shell or sandbox policy authority and never spawns', async () => {
    const s = scenario()
    expect(await runShellCommand({ ...s.options, shell: undefined })).toEqual(['✗ shell capability is unavailable'])
    s.options.shell = { ...s.shell, sandboxMode: 'read-only' }
    expect(await runShellCommand(s.options)).toEqual(['✗ shell sandbox policy is unavailable; command not run'])
    expect(s.shell.resolve).not.toHaveBeenCalled()
    expect(s.shell.execute).not.toHaveBeenCalled()
  })

  it('resolves the attached Session policy per run and preserves executor environment defaults', async () => {
    const s = scenario()
    const policy = { mode: 'workspace-write' as const, workspaceRoot: '/session cwd' }
    const resolve = vi.fn(() => policy)
    s.options.sandboxPolicy = { resolve }
    s.finish()
    expect(await runShellCommand(s.options)).toEqual(['[shell exit 0]'])
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ session })
    expect(s.shell.resolve).toHaveBeenCalledExactlyOnceWith({
      command: '  printf source  ', workdir: '/session cwd', signal: s.controller.signal,
      onExpiry: 'none', stdoutMaxBytes: 64_000, sandboxPolicy: policy,
    })
    expect(s.shell.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sandboxPolicy: policy }))
    const request = vi.mocked(s.shell.resolve).mock.calls[0]?.[0]
    expect(request).not.toHaveProperty('env')
    expect(request).not.toHaveProperty('dshEnv')
    expect(s.handle.result).toHaveBeenCalledTimes(1)
    expect(s.handle.readOutput).not.toHaveBeenCalled()
    expect(s.rows).toEqual([])
  })

  it('streams completed lines and live tails before done, then clears polling on settlement', async () => {
    vi.useFakeTimers()
    const s = scenario()
    const run = runShellCommand(s.options)
    await vi.advanceTimersByTimeAsync(0)
    expect(s.handle.result).toHaveBeenCalledTimes(1)
    s.observed.stdout.push(Buffer.from('first\npartial'))
    await vi.advanceTimersByTimeAsync(50)
    expect(s.rows).toEqual(['first'])
    expect(s.options.output.live(20)).toEqual(['partial'])
    expect(s.options.changed).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    s.finish()
    expect(await run).toEqual(['[shell exit 0]'])
    expect(s.rows).toEqual(['first', 'partial'])
    expect(s.options.output.live(20)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    const calls = vi.mocked(s.options.changed).mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(s.options.changed).toHaveBeenCalledTimes(calls)
    expect(s.controller.signal.aborted).toBe(false)
  })

  it('contains preparation failure, policy failure and pre-publication cancellation', async () => {
    const s = scenario()
    s.options.sandboxPolicy = { resolve: () => { throw new Error('policy\x1b[2J\r\tfailed') } }
    expect((await runShellCommand(s.options))[0]).toContain('Error: policy^[[2J^M')
    expect(s.shell.execute).not.toHaveBeenCalled()
    s.options.sandboxPolicy = undefined
    vi.mocked(s.shell.execute).mockRejectedValueOnce(new Error('prepare failed'))
    expect(await runShellCommand(s.options)).toEqual(['✗ shell: Error: prepare failed'])
    s.controller.abort()
    expect(await runShellCommand(s.options)).toEqual(['[shell interrupted]'])
    expect(s.shell.execute).toHaveBeenCalledTimes(1)
  })

  it('bounds rejected diagnostics without splitting surrogate pairs and contains unprintable rejections', async () => {
    const s = scenario()
    vi.mocked(s.shell.execute).mockRejectedValueOnce(`${'x'.repeat(4095)}😀unbounded suffix`)
    expect(await runShellCommand(s.options)).toEqual([`✗ shell: ${'x'.repeat(4095)}`])
    vi.mocked(s.shell.execute).mockRejectedValueOnce({ toString: () => { throw new Error('no string') } })
    expect(await runShellCommand(s.options)).toEqual(['✗ shell: unprintable failure'])
  })

  it('cancels during preparation using the supplied signal, with no poll timer or handle', async () => {
    vi.useFakeTimers()
    const s = scenario()
    vi.mocked(s.shell.execute).mockImplementation(spec => new Promise((_resolve, reject) => {
      spec.signal?.addEventListener('abort', () => { reject(spec.signal?.reason) }, { once: true })
    }))
    const run = runShellCommand(s.options)
    s.controller.abort()
    expect(await run).toEqual(['[shell interrupted]'])
    expect(vi.getTimerCount()).toBe(0)
    expect(s.options.changed).not.toHaveBeenCalled()
  })

  it('contains result infrastructure rejection and still flushes observed failure output', async () => {
    vi.useFakeTimers()
    const s = scenario()
    const run = runShellCommand(s.options)
    await vi.advanceTimersByTimeAsync(0)
    s.observed.stderr.push(Buffer.from('spawn rejected'))
    s.finish({}, new Error('spawn\x1b[2J failed'))
    expect(await run).toEqual(['✗ shell: Error: spawn^[[2J failed'])
    expect(s.rows).toEqual(['[stderr] spawn rejected'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports sandbox runner failure from public handle facts even when result rejects', async () => {
    const s = scenario()
    const run = runShellCommand(s.options)
    await Promise.resolve()
    s.handle.sandbox = { mode: 'read-only', denied: false, runnerFailed: true }
    s.finish({}, new Error('sandbox unavailable'))
    expect(await run).toEqual(['✗ shell sandbox runner failed', '✗ shell: Error: sandbox unavailable'])
  })

  it.each([
    [{ exitCode: 7 }, '✗ shell exit 7'],
    [{ exitCode: null }, '✗ shell exit unknown'],
    [{ exitCode: null, signal: 'SIGKILL' }, '[shell terminated by SIGKILL]'],
    [{ aborted: true }, '[shell interrupted]'],
    [{ timedOut: true }, '[shell timed out]'],
    [{ sandbox: { mode: 'read-only', denied: true } }, '✗ shell sandbox denied the operation'],
    [{ sandbox: { mode: 'read-only', denied: false, runnerFailed: true } }, '✗ shell sandbox runner failed'],
  ] as const)('reports exit, cancellation and confinement facts: %s', async (facts, expected) => {
    const s = scenario()
    s.finish(facts)
    expect(await runShellCommand(s.options)).toEqual([expected])
  })

  it('does not mislabel killed-without-signal or requested abort as successful exit zero', async () => {
    const killed = scenario()
    killed.finish()
    killed.handle.status = 'killed'
    expect(await runShellCommand(killed.options)).toEqual(['[shell killed]'])
    const aborted = scenario()
    const run = runShellCommand(aborted.options)
    await Promise.resolve()
    aborted.controller.abort()
    aborted.finish()
    expect(await run).toEqual(['[shell interrupted]'])
  })

  it.each(['read', 'emit', 'changed', 'result'] as const)('kills and joins active handle on %s failure without orphaning or timers', async source => {
    vi.useFakeTimers()
    const s = scenario()
    if (source === 'read') s.handle.observed.stdout.readFrom = () => { throw new Error('reader failed') }
    if (source === 'emit') {
      s.options.output = new ShellOutput(() => { throw new Error('commit failed') })
      s.observed.stdout.push(Buffer.from('completed\n'))
    }
    if (source === 'changed') s.options.changed = () => { throw new Error('changed failed') }
    if (source === 'result') s.handle.result = () => { throw new Error('projection failed') }
    const rows = await runShellCommand(s.options)
    expect(rows.join('')).toContain('failed')
    expect(s.handle.kill).toHaveBeenCalledTimes(1)
    expect(s.handle.status).not.toBe('running')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('kills after a later poll callback fails and contains a rejected projection during cleanup', async () => {
    vi.useFakeTimers()
    const s = scenario()
    vi.mocked(s.options.changed).mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('later redraw failed') })
    s.handle.kill = vi.fn(() => { s.finish({}, new Error('kill failure projection')); return true })
    const run = runShellCommand(s.options)
    await vi.advanceTimersByTimeAsync(50)
    expect(await run).toEqual(['✗ shell: Error: later redraw failed'])
    expect(s.handle.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
