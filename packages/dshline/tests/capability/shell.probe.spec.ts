/** Public shell service and real attached-session sandbox policy, without a process provider. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import ShellExecutor from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { stripAnsi } from '@dshline/renderer'
import { runShellCommand } from '../../src/shell-command.ts'
import { ShellOutput } from '../../src/shell-output.ts'

/** Provider-neutral implementation of the published abstract service definition. */
class ProbeShell extends ShellExecutor {
  readonly requests: ShellExecRequest[] = []
  readonly specs: ShellExecSpec[] = []
  override get sandboxMode(): 'read-only' { return 'read-only' }
  resolve(request: ShellExecRequest): ShellExecSpec {
    this.requests.push(request)
    return {
      command: request.command,
      workdir: request.workdir ?? '/deployment',
      timeoutMs: request.timeoutMs ?? 1000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      onExpiry: request.onExpiry ?? 'kill',
      signal: request.signal,
      sandboxPolicy: request.sandboxPolicy,
    }
  }
  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    this.specs.push(spec)
    const result: ShellRunResult = {
      exitCode: 0, signal: null, aborted: false, timedOut: false, timeoutMs: spec.timeoutMs,
      stdout: { text: 'local only\n', truncated: false }, stderr: { text: '', truncated: false },
    }
    const reader = (text: string) => ({ readFrom: (offset: number) => ({
      text: text.slice(offset), nextOffset: Buffer.byteLength(text), lossy: false,
    }) })
    return {
      status: 'completed', exitCode: 0, signal: null, done: Promise.resolve(),
      result: async () => result, kill: () => false,
      observed: { stdout: reader('local only\n'), stderr: reader('') },
      readOutput: () => { throw new Error('the frontend must not consume the tool cursor') },
    }
  }
}

describe('shell / sandboxPolicy capability', () => {
  it('carries current session override/root through real policy and the public resolve/execute contract without logging shell events', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: '/deployment' })
      await ctx.plugin(ProbeShell)
      const attached = ctx.sessions.create(SessionId('shell-policy-attached'), { meta: { cwd: '/attached' } })
      const other = ctx.sessions.create(SessionId('shell-policy-other'), { meta: { cwd: '/other' } })
      setSandboxMode(attached, 'workspace-write')
      const before = attached.snapshotEvents()
      const rows: string[] = []
      const shell = ctx.shell as ProbeShell
      const execute = async (): Promise<void> => {
        const status = await runShellCommand({
          command: 'printf "local only\\n" ', shell, sandboxPolicy: ctx.sandboxPolicy,
          session: attached, workdir: '/attached', signal: new AbortController().signal,
          output: new ShellOutput(lines => rows.push(...lines)), changed: () => {},
        })
        expect(stripAnsi(status.join('\n'))).toContain('exit 0')
      }
      await execute()
      expect(shell.specs[0]?.sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: '/attached', sessionId: attached.id })
      expect(ctx.sandboxPolicy.resolve({ session: other })).toEqual({ mode: 'read-only', workspaceRoot: '/other', sessionId: other.id })
      expect(shell.requests[0]).toMatchObject({ command: 'printf "local only\\n" ', workdir: '/attached', onExpiry: 'none' })
      expect(shell.requests[0]).not.toHaveProperty('env')
      expect(shell.requests[0]).not.toHaveProperty('dshEnv')
      expect(rows).toEqual(['local only'])
      expect(attached.snapshotEvents()).toEqual(before)
      setSandboxMode(attached, 'danger-full-access')
      await execute()
      expect(shell.specs[1]?.sandboxPolicy?.mode).toBe('danger-full-access')
      expect(ctx.sandboxPolicy.resolve().mode).toBe('read-only')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
