/** Opt-in real-product proof that generic Work observes a Codex delegation. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createScope, scopeTarget, type Scope } from '@deepseek-ai/dsh-scope'
import SubagentRuntime, { type SubagentActivation, SubagentRunId } from '@deepseek-ai/dsh-subagent'
import * as Codex from '@deepseek-ai/dsh-subagent-codex'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'
import { stripAnsi } from '@dshline/renderer'
import { createHarnessWork } from '../src/work/index.ts'
import { createWorkOverlay } from '../src/work/overlay.ts'
import type { WorkSnapshot } from '../src/work/model.ts'

/** Directory selection for the temporary workspace; no parent model is driven. */
class AcceptanceWorkingDirectory extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  async ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const cwd = agent.session.header.cwd
    if (cwd === undefined) throw new Error('acceptance parent must own a workspace')
    return cwd
  }
}

/** Fully typed, non-driving parent over the real host-owned Session lifecycle. */
function acceptanceParent(ctx: Context, id: SessionId, cwd: string): Agent {
  const session = ctx.sessions.create(id, { meta: { cwd } })
  const inbox = createInboxStub()
  return {
    id: session.id, session, ctx, options: {}, status: 'idle', inbox,
    send: (message, target) => { inbox.append(target, message) },
    followup: message => { inbox.append('next-turn', message) },
    steer: message => { inbox.append('next-step', message) },
    inject: message => { inbox.append('next-step', message) },
    cancel: (_cause, options) => { if (!options?.keepInbox) inbox.clear() },
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
  }
}

/** Environment gate that keeps credentials and a live Codex run out of normal CI. */
const REAL_CODEX_ENV = 'DSHLINE_CODEX_E2E'

/** Text the real provider must return, proving the native authenticated delegation completed. */
const CODEX_SENTINEL = 'DSHLINE_CODEX_WORK_OK'

/** Leave an authenticated remote delegation enough time while still bounding cleanup on failure. */
const CODEX_RUN_TIMEOUT_MS = 90_000

/** The enclosing test leaves time after a run timeout for process-tree disposal. */
const CODEX_TEST_TIMEOUT_MS = 120_000

/** Run only when a developer explicitly requests a locally authenticated product check. */
const runRealCodex = process.env[REAL_CODEX_ENV] === '1'

/** Race an external operation against an actionable local timeout. */
async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`)) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Wait for every process owned through the real subprocess seam to exit. */
async function expectQuiescent(handles: readonly SubprocessHandle[]): Promise<void> {
  for (const handle of handles) {
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome).toHaveProperty('exitCode')
    expect(outcome).toHaveProperty('signal')
  }
}

describe.skipIf(!runRealCodex)('real Codex through generic Harness Work', () => {
  it('observes the generic lifecycle, renders the active row, then settles and releases its process tree', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshline-codex-work-'))
    const ctx = new Context()
    const controller = new AbortController()
    const handles: SubprocessHandle[] = []
    let parentScope: Scope | undefined
    let otherScope: Scope | undefined
    let run: SubagentActivation | undefined
    let work: ReturnType<typeof createHarnessWork> | undefined
    let activeAtStart: WorkSnapshot | undefined
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AcceptanceWorkingDirectory)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(Codex, { permissionMode: 'never' })
      const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
      ctx.subprocess.spawn = spec => {
        const handle = spawn(spec)
        handles.push(handle)
        return handle
      }

      // A real Agent owns a scope minted with itself as the dispatch key. Use
      // that same mechanism instead of an unscoped stand-in for `agent.ctx`.
      const parent = acceptanceParent(ctx, SessionId('dshline-codex-parent'), workspace)
      parentScope = createScope(ctx, parent)
      Object.assign(parent, { ctx: parentScope.ctx })
      await ctx.agents.register(parent)
      expect(ctx.agents.get(parent.id)).toBe(parent)
      const other = acceptanceParent(ctx, SessionId('dshline-other-parent'), workspace)
      otherScope = createScope(ctx, other)
      Object.assign(other, { ctx: otherScope.ctx })
      await ctx.agents.register(other)
      expect(ctx.agents.get(other.id)).toBe(other)
      const starts: Array<{ readonly runId: string; readonly provider: string }> = []
      const ends: Array<{ readonly runId: string; readonly provider: string }> = []
      parent.ctx.on('subagent/start', info => { starts.push({ runId: String(info.runId), provider: info.provider }) })
      parent.ctx.on('subagent/end', info => { ends.push({ runId: String(info.runId), provider: info.provider }) })
      work = createHarnessWork(ctx, parent, () => {
        const snapshot = work!.snapshot()
        if (snapshot.subagents.some(item => item.provider === 'codex')) activeAtStart ??= snapshot
      })

      // The service routes lifecycle by the exact delegator. This generic edge
      // must not reach the Work projection owned by the other parent scope.
      ctx.emit(scopeTarget(ctx.subagents, other), 'subagent/start', {
        runId: SubagentRunId('other-run'), provider: 'other-provider', id: SessionId('other-child'), local: false,
      })
      expect(starts).toEqual([])
      expect(work.snapshot().subagents).toEqual([])

      const starting = ctx.subagents.startActivation({
        provider: 'codex',
        label: 'dshline Work acceptance',
        request: { parent, prompt: [{ type: 'text', text: `Reply with exactly ${CODEX_SENTINEL}. Do not run commands.` }] },
        signal: controller.signal,
        delivery: 'caller',
      })
      // A timeout must not leave a late rejection unobserved after the test has
      // aborted the request and disposed the process-owning service.
      void starting.catch(() => {})
      run = await within(starting, CODEX_RUN_TIMEOUT_MS, 'Codex startup')

      expect(handles.length).toBeGreaterThan(0)
      expect(starts).toHaveLength(1)
      expect(starts[0]).toMatchObject({ provider: 'codex' })
      // `invalidate()` runs synchronously in HarnessWork's start-edge handler,
      // so this is the active generic state even if the remote turn settles
      // before the asynchronous provider start call returns to this test.
      expect(activeAtStart?.subagents).toEqual([expect.objectContaining({
        id: String(run.childId), source: 'subagent', provider: 'codex', state: 'running', interruptible: false,
      })])
      const overlay = createWorkOverlay({
        snapshot: () => activeAtStart!,
        interruptSubagent: item => work!.interruptSubagent(item),
        stopJob: item => work!.stopJob(item),
        close: () => {},
        invalidate: () => {},
      })
      expect(stripAnsi(overlay.render(80, 12).join('\n'))).toContain('codex')

      const result = await within(run.result, CODEX_RUN_TIMEOUT_MS, 'Codex delegation')
      expect(result.stopReason).toBe('completed')
      expect(result.output.some(block => block.type === 'text' && block.text.includes(CODEX_SENTINEL))).toBe(true)
      expect(ends).toEqual([expect.objectContaining({ runId: starts[0]!.runId, provider: 'codex' })])
      expect(work.snapshot().subagents).toEqual([])
    } finally {
      controller.abort(new Error('dshline Codex acceptance cleanup'))
      if (run !== undefined) await run.dispose()
      work?.dispose()
      await expectQuiescent(handles)
      await otherScope?.dispose()
      await parentScope?.dispose()
      await ctx.fiber.dispose()
      await rm(workspace, { recursive: true, force: true, maxRetries: 3 })
    }
  }, CODEX_TEST_TIMEOUT_MS)
})
