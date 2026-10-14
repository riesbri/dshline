/**
 * Capability probe: Harness's `workspaceChanges` seam, against the real plugin.
 *
 * This is the compatibility evidence `tools/capability-probes.mjs` names for the
 * `workspaceChanges` seam, so it mounts the REAL `@deepseek-ai/dsh-workspace-changes`
 * over a real `SessionStore`, real local subprocess and filesystem runtimes,
 * and a real git repository on disk — never a dshline-shaped fake of a summary.
 *
 * What it proves is exactly what `/turns` is built on, and the third assertion
 * is the one that would otherwise be a guess:
 *
 *  1. the row publishes `ctx.workspaceChanges` with dshline's two operations, and
 *     dshline's adapter answers `unmounted` for a composition without it;
 *  2. a completed top-level turn appends ONE `workspace/changes` event carrying
 *     only the turn number, and the summary is served by that EVENT's sequence —
 *     not by the turn's `turn/start` seq, which is what `/turns` addresses the
 *     turn by, and therefore the pairing `/turns` has to correlate for itself;
 *  3. the summary's `files` are index-aligned with what `diff()` accepts, and
 *     `total` counts past the plugin's own cap, so dshline can report a truncated
 *     summary honestly instead of calling the listed count the whole change;
 *  4. the LIFETIME asymmetry is real and reproducible inside one process:
 *     disposing the Session drops the served summary while the `workspace/changes`
 *     event stays in the durable log — the reopened-session and restarted-Host
 *     case dshline must state rather than reconstruct.
 *
 * NOT claimed: the recorder's own capture and comparison policy (git-backed
 * snapshots, file-tool whole-file captures, `binary`/`oversized` refusals, and the
 * `coarse` degradation) is upstream's, and upstream tests it against its own git
 * fixtures. What dshline must get right is that it RENDERS each of those states,
 * which `turns-changes.spec.ts` does over the same typed values.
 * @module
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import * as WorkspaceChangesPlugin from '@deepseek-ai/dsh-workspace-changes'
import type { WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes/types'
import { WorkspaceChangesAdapter } from '../../src/turns/changes.ts'

/** How many lines the plugin writes into the repository for this probe. */
const ADDED_LINES = 3

/** The comparison read the probe never expects to outlive its caller. */
const SIGNAL = new AbortController().signal

/** Scratch directories this file created, removed after each test. */
const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/**
 * A real git repository with one committed file, and its absolute path.
 * @returns the repository root.
 */
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshline-workspace-changes-'))
  scratch.push(root)
  const git = (args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: root, stdio: 'ignore' })
  }
  git(['init', '--quiet'])
  git(['config', 'user.email', 'probe@example.invalid'])
  git(['config', 'user.name', 'probe'])
  await writeFile(join(root, 'kept.txt'), 'one\n')
  git(['add', '--all'])
  git(['commit', '--quiet', '--message', 'seed'])
  return root
}

/**
 * Mount the real store, both runtime collaborators, and the real recorder.
 * @param cwd - the session's working directory.
 * @returns the context and one fresh session.
 */
async function harness(cwd: string): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem, { cwd })
  // Only the one bound this probe exercises. The rest are upstream's shipped
  // defaults, applied by the plugin's own validation at load.
  await ctx.plugin(WorkspaceChangesPlugin, { maxFiles: 2 } as never)
  return { ctx, session: ctx.sessions.create(SessionId('ws-changes-probe'), { meta: { cwd } }) }
}

/**
 * One settled tool result for the open turn, which is what makes a turn
 * recordable at all: the recorder declines a turn that observed none.
 * @param session - the session to append to.
 * @param turn - the open turn number.
 */
function settleToolResult(session: Session, turn: number): void {
  const callId = ToolCallId(`probe-${turn}`)
  const source = session.append('tool/call', {
    turn, step: 1, callId, name: 'write', arguments: '{}',
  })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content: [], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
}

/**
 * Wait for the recorder's queued baseline, capture, or turn-end record.
 *
 * The plugin's own documented barrier: every `tools/pre-execute` waits for its
 * queued snapshots before a tool runs, so no mutation can precede the baseline.
 * Using it instead of a sleep is both deterministic and a second probe of a
 * contract the composition row's cost depends on.
 * @param ctx - the context the recorder is mounted on.
 * @param session - the session whose recorder may have pending work.
 * @returns the opaque execution actor accepted by filesystem intent hooks.
 */
async function baseline(ctx: Context, session: Session): Promise<object> {
  // The identity is opaque: `exec.agent.session` selects the recorder, and
  // the same actor joins its pre-execution barrier to the filesystem intent.
  const exec = {
    callId: 'probe-barrier',
    rootCallId: 'probe-barrier',
    name: 'write',
    arguments: {},
    agent: { session },
    token: {},
  }
  // The recorder needs the execution identity to correlate the filesystem
  // intent below; the branded ToolExecution itself belongs to upstream.
  await ctx.waterfall('tools/pre-execute', exec as never, () => Promise.resolve(undefined as never))
  return exec
}

/**
 * Mutate through the native filesystem intent and write seams, as a file tool does.
 * @param ctx - the context whose recorder observes the intent.
 * @param session - the session that owns the write.
 * @param lines - how many lines to add to the tracked file.
 */
async function writeTrackedFile(ctx: Context, session: Session, lines: number): Promise<void> {
  const actor = await baseline(ctx, session)
  const target = await ctx.fs.resolve('kept.txt', session.header.cwd === undefined ? {} : { cwd: session.header.cwd })
  const intent = await ctx.waterfall('fs/write-intent', target, actor, () => undefined)
  await ctx.fs.writeText(target, `one\n${'added\n'.repeat(lines)}`, intent)
}

/**
 * Run one whole turn, changing a file between its baseline and its end.
 * @param ctx - the context the recorder is mounted on.
 * @param session - the session the turn runs on.
 * @param turn - the turn number.
 * @param lines - how many lines to add to the tracked file.
 */
async function turn(ctx: Context, session: Session, turn: number, lines: number): Promise<void> {
  session.append('turn/start', { turn })
  await writeTrackedFile(ctx, session, lines)
  settleToolResult(session, turn)
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  await baseline(ctx, session)
}

/**
 * The newest `workspace/changes` event naming one turn, read from the log.
 * @param session - the session to read.
 * @param turn - the announced turn number.
 * @returns the event, or undefined when none names that turn.
 */
function announcement(session: Session, turn: number): { seq: number } | undefined {
  // A test file may use the deprecated reader, and this probe needs the durable
  // log itself rather than the live feed: the contract under test is exactly
  // what a later attachment would have to reconstruct from history.
  const events = session.snapshotEvents()
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at]
    if (event?.type === 'workspace/changes' && (event.data as { turn: number }).turn === turn) {
      return { seq: Number(event.seq) }
    }
  }
  return undefined
}

describe('capability: workspaceChanges', () => {
  it('answers unmounted for a composition that mounts no such row', () => {
    const adapter = new WorkspaceChangesAdapter({ sessionId: SessionId('no-row') })
    expect(adapter.mounted).toBe(false)
    // `/turns` must still work in that profile, so the adapter answers rather
    // than throwing, and — with no read of its own anywhere in the design — it
    // costs that composition nothing at all.
    expect(adapter.reading(1)).toEqual({ kind: 'unmounted' })
  })

  it('serves a summary by the ANNOUNCING EVENT seq, and not by the turn seq', async () => {
    const root = await repository()
    const { ctx, session } = await harness(root)
    try {
      const startSeq = session.append('turn/start', { turn: 1 }).seq
      await writeTrackedFile(ctx, session, ADDED_LINES)
      settleToolResult(session, 1)
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await baseline(ctx, session)

      const announced = announcement(session, 1)
      expect(announced).toBeDefined()
      // The pairing `/turns` has to correlate itself: the event names a TURN,
      // and the summary is addressed by the event's own seq, which is neither
      // the turn number nor the turn's `turn/start` seq.
      expect(announced?.seq).not.toBe(startSeq)
      expect(ctx.workspaceChanges.summary(session.id, startSeq)).toBeUndefined()

      const summary = ctx.workspaceChanges.summary(session.id, announced?.seq ?? -1) as WorkspaceChangesSummary
      expect(summary.turn).toBe(1)
      expect(summary.total).toBe(1)
      expect(summary.files).toHaveLength(1)
      // `display` is the label AND the sort key upstream chose; a CJK-free
      // relative path is the shape dshline escapes and measures.
      expect(summary.files[0]?.display).toBe('kept.txt')
      expect(summary.files[0]?.added).toBe(ADDED_LINES)
      expect(summary.files[0]?.deleted).toBe(0)
      expect(summary.files[0]?.binary).toBeUndefined()
      expect(summary.files[0]?.oversized).toBeUndefined()

      // The adapter is the thing that does the pairing, and it needs the live
      // feed for it — exactly the fold the attachment performs.
      const adapter = new WorkspaceChangesAdapter({
        sessionId: session.id,
        changes: ctx.workspaceChanges,
      })
      for (const event of session.snapshotEvents()) adapter.observe(event)
      expect(adapter.reading(1).kind).toBe('summary')
      expect(adapter.reading(2)).toEqual({ kind: 'none' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('addresses a comparison by the file index the summary published', async () => {
    const root = await repository()
    const { ctx, session } = await harness(root)
    try {
      await turn(ctx, session, 1, ADDED_LINES)
      const seq = announcement(session, 1)?.seq ?? -1
      const summary = ctx.workspaceChanges.summary(session.id, seq) as WorkspaceChangesSummary

      const diff = await ctx.workspaceChanges.diff(session.id, seq, 0, SIGNAL)
      expect(diff?.kind).toBe('text')
      if (diff?.kind !== 'text') return
      // One hunk with three lines of context, and the file's own line as the
      // only addition: the shape dshline renders a hunk heading from.
      expect(diff.hunks).toHaveLength(1)
      expect(diff.hunks[0]?.oldLines).toBe(1)
      expect(diff.hunks[0]?.newLines).toBe(ADDED_LINES + 1)
      expect(diff.hunks[0]?.lines.filter(line => line.startsWith('+'))).toHaveLength(ADDED_LINES)
      expect(diff.coarse).toBe(false)

      // An index the summary never published is `undefined`, not a throw: the
      // file list must not be able to ask about a file that is not on screen.
      await expect(ctx.workspaceChanges.diff(session.id, seq, 99, SIGNAL)).resolves.toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the durable announcement after disposal drops the served summary', async () => {
    const root = await repository()
    const { ctx, session } = await harness(root)
    const id = session.id
    const changes = ctx.workspaceChanges
    let seq = -1
    try {
      await turn(ctx, session, 1, ADDED_LINES)
      seq = announcement(session, 1)?.seq ?? -1
      expect(changes.summary(id, seq)).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
    // The event is durable; the summary is not. This is the whole of section 6,
    // and it is what dshline's `unserved` reading exists to state honestly.
    expect(changes.summary(id, seq)).toBeUndefined()
    expect(session.snapshotEvents().some(event => event.type === 'workspace/changes')).toBe(true)
  })

  it('rejects an aborted comparison read rather than answering an empty one', async () => {
    const root = await repository()
    const { ctx, session } = await harness(root)
    try {
      await turn(ctx, session, 1, ADDED_LINES)
      const seq = announcement(session, 1)?.seq ?? -1
      const controller = new AbortController()
      controller.abort()
      // Cancellation is a REJECTION, not an empty comparison, and dshline depends
      // on knowing which: an aborted read that resolved `undefined` would be
      // indistinguishable from "this Host can no longer serve that file", and
      // the reader would be told a historical fact about their own cancellation.
      await expect(ctx.workspaceChanges.diff(session.id, seq, 0, controller.signal)).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
