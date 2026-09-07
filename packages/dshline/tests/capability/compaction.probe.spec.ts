/**
 * Capability probe: Harness compaction events, against the real event contract.
 *
 * dshline neither implements compaction nor calls `ctx.compaction`: it projects
 * durable `compaction/*` events, while the `/compact` command owns dispatch
 * through `ctx.commands`. This probe uses a real `Session` and the package's
 * event declarations, appends replacement-shaped records, and asserts the
 * dshline presentation fold. The local event builder is evidence for the
 * consumed event shape, not a concrete compaction backend or command run.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-compaction'
import { stripAnsi } from '@dshline/renderer'
import { compactionNote } from '../../src/context/compaction.ts'

/** Append the exact event trio a manual or automatic compaction commits. */
function compact(session: Session, options: { manual: boolean }): {
  readonly startSeq: SessionSeq
  readonly summarySeq: SessionSeq
  readonly endSeq: SessionSeq
} {
  const compactionId = CompactionId('probe-1')
  const owner = options.manual ? { sourceCommandId: CommandId('cmd-1') } : {}
  const first = session.append('user/message', {
    id: 'm-1', role: 'user', content: [{ type: 'text', text: 'a'.repeat(200) }], source: { kind: 'user' },
  } as never, { surfaceOp: 'append' })
  const second = session.append('user/message', {
    id: 'm-2', role: 'user', content: [{ type: 'text', text: 'b'.repeat(200) }], source: { kind: 'user' },
  } as never, { surfaceOp: 'append' })
  const start = session.append('compaction/start', { compactionId, turn: null, ...owner })
  const summary = session.append('compaction/summary', {
    compactionId,
    ...owner,
    summary: [{ type: 'text', text: 'the story so far' }],
    shadowedRange: { start: first.seq, end: second.seq },
    shadowedSeqs: [first.seq, second.seq],
    shadowedTokenCount: 95_000,
    provider: 'probe',
    model: 'probe-model',
  })
  session.append('user/message', {
    id: 'm-3', role: 'user', content: [{ type: 'text', text: 'the story so far' }],
    source: { kind: 'plugin', plugin: 'compact', compactionId },
  } as never, {
    surfaceOp: { op: 'replace', start: first.seq, end: second.seq },
    sourceEventSeqs: [first.seq, second.seq],
  })
  const end = session.append('compaction/end', { compactionId, turn: null, ...owner })
  return { startSeq: start.seq, summarySeq: summary.seq, endSeq: end.seq }
}

/** Mount the real session store used by the event fold. */
async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return { ctx, session: ctx.sessions.create() }
}

describe('capability: compaction', () => {
  it('presents a manual compaction from its summary event, not from command prose', async () => {
    const { session } = await harness()
    const seqs = compact(session, { manual: true })
    const summary = session.eventAt(seqs.summarySeq)
    expect(summary).toBeDefined()

    const note = compactionNote(summary as never, 80)
    const text = note.lines.map(stripAnsi).join('\n')
    expect(text).toContain('compacted 2 entries')
    // `~`, always: `shadowedTokenCount` is the meter's heuristic price of the
    // shadowed content, never a provider count.
    expect(text).toContain('~95k replaced')
    expect(text).not.toContain('automatically')
    // The seq the row presents, which is what lets a `command/done` citing the
    // same `sourceEventSeq` stay silent instead of repeating it.
    expect(note.presentedSeq).toBe(seqs.summarySeq)
  })

  it('names an automatic compaction as one, and says nothing about start or end', async () => {
    const { session } = await harness()
    const seqs = compact(session, { manual: false })
    const automatic = compactionNote(session.eventAt(seqs.summarySeq) as never, 80)
    expect(automatic.lines.map(stripAnsi).join('\n')).toContain('context compacted automatically')

    // The bracketing events carry no user-visible consequence of their own.
    expect(compactionNote(session.eventAt(seqs.startSeq) as never, 80).lines).toEqual([])
    expect(compactionNote(session.eventAt(seqs.endSeq) as never, 80).lines).toEqual([])
  })

  it('reports a failed AUTOMATIC compaction, which no command result would', async () => {
    const { session } = await harness()
    const failed = session.append('compaction/end', {
      compactionId: CompactionId('probe-2'),
      turn: null,
      error: 'summary was not smaller',
    })
    expect(compactionNote(failed, 80).lines.map(stripAnsi).join('\n'))
      .toContain('automatic context compaction did not complete')

    // The same failure under a command stays with the command, which reports
    // the backend's own classified reason.
    const manual = session.append('compaction/end', {
      compactionId: CompactionId('probe-3'),
      sourceCommandId: CommandId('cmd-9'),
      turn: null,
      error: 'summary was not smaller',
    })
    expect(compactionNote(manual, 80).lines).toEqual([])
  })

  it('says nothing for a tool-result prune, which changes no visible exchange', async () => {
    const { session } = await harness()
    const pruned = session.append('compaction/prune', {
      shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [0],
      shadowedTokenCount: 4_000,
    })
    expect(compactionNote(pruned, 80).lines).toEqual([])
  })
})
