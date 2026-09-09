import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { stripAnsi } from '@dshline/renderer'
import { isTranscriptEvent, resumeBanner } from '../src/resume.ts'
import { projectEvent } from '../src/transcript.ts'

/**
 * A log event with just the fields the replay rule reads.
 * @param type - the event type.
 * @param surfaceOp - how it entered the surface, for the types that have one.
 * @returns the event.
 */
function event(type: string, surfaceOp?: string): SessionEvent {
  return { type, data: {}, ...surfaceOp === undefined ? {} : { surfaceOp } } as unknown as SessionEvent
}

/** Every surface-eligible event type of the adopted Session format. */
const SURFACE_TYPES = ['system/message', 'user/message', 'assistant/message', 'tool/result']

describe('what a resumed transcript replays', () => {
  it('replays what was appended to the surface', () => {
    for (const type of SURFACE_TYPES) {
      expect(isTranscriptEvent(event(type, 'append')), type).toBe(true)
    }
  })

  it('skips a replacement copy, which is model-only', () => {
    // A compaction replaces a range so the model's history stays coherent, and a
    // system-prompt normalization replaces a system node for the same reason.
    // Replaying either would show the user a model-facing rewrite in place of
    // what they actually saw.
    for (const type of SURFACE_TYPES) {
      expect(isTranscriptEvent(event(type, 'replace')), type).toBe(false)
    }
  })

  it('replays a tool call, which is not a surface event at all', () => {
    // The reason the rule is stated as "a surface-eligible event replays only when
    // it was an append" rather than "replay append events": narrowing to surface
    // events would drop tool calls, and a result card needs its call's arguments.
    expect(isTranscriptEvent(event('tool/call'))).toBe(true)
  })

  it('replays a turn ending, so an interrupted turn still says so', () => {
    expect(isTranscriptEvent(event('turn/end'))).toBe(true)
  })

  it('replays an assistant message exactly once, with no chunk exclusion behind it', () => {
    // The rule needs no Assistant special case at all. A reply is one durable
    // settlement on the surface, so the append/replace rule above is the whole
    // answer — there is no streamed second copy in the log to suppress.
    expect(isTranscriptEvent(event('assistant/message', 'append'))).toBe(true)
  })

  it('replays a log-only assistant attempt, which the projection draws as nothing', () => {
    // `assistant/attempt` is one model attempt that committed no reply. It is
    // not surface-eligible, so it replays like every other log-only event; that
    // it contributes no transcript line is the projection's statement, not a
    // filter here. Keeping it out of this predicate is what keeps the predicate
    // about the surface.
    expect(isTranscriptEvent(event('assistant/attempt'))).toBe(true)
  })

  it('replays an event type it has never seen', () => {
    // The log is merge-extensible: a plugin may append anything. An unknown type
    // has no replacement semantics, and the projection ignores what it cannot draw.
    expect(isTranscriptEvent(event('some-plugin/event'))).toBe(true)
  })

  it('replays a surface-eligible event carrying no surfaceOp', () => {
    // `isSurfaceEvent` requires the op to be present, so an event without one falls
    // through to the general case and replays. Degenerate — the surface types
    // always carry one — and the safe direction: replaying something that was not
    // on the surface shows the user a line too many, where skipping it would hide
    // conversation they had.
    expect(isTranscriptEvent(event('user/message'))).toBe(true)
  })

  it('lets an appended system prompt through the gate, and draws nothing for it', () => {
    // Session format V3 made the rendered system prompt a surface node, so it
    // passes this predicate like any other append — and must still leave no mark
    // on the transcript. Both halves are asserted together because that is the
    // product rule: dshline does not print the deployment's standing
    // instructions into a conversation nobody typed them into.
    expect(isTranscriptEvent(event('system/message', 'append'))).toBe(true)
    expect(projectEvent({
      type: 'system/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'sys-1',
          role: 'system',
          content: [{ type: 'text', text: 'You are a terminal agent.' }],
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
        },
      },
    } as unknown as SessionEvent, 80)).toEqual([])
  })
})

describe('a resumed V3 transcript, over a real Session log', () => {
  it('replays the conversation and never the rendered system prompt', async () => {
    // The whole replay rule against the real thing: a Session the adopted format
    // validates, carrying the surface node 0 the loop appends before the first
    // prompt, the normalizing replacement that follows a prompt edit, and the
    // human turn between them. Harness owns the format and any migration into
    // it; dshline only decides what a person sees, and a standing instruction
    // block is not part of the conversation they had.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const target: Session = ctx.sessions.create()

    const head = target.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('You are a terminal agent.', '@deepseek-ai/dsh-system-prompt'),
    }, { surfaceOp: 'append' })
    target.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'what changed here' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // The prompt is re-rendered and the route cannot take an in-history change,
    // so Harness rewrites the head node in place.
    target.append('system/message', {
      turn: 2,
      step: 1,
      message: createSystemMessage('You are a terminal agent. Be brief.', '@deepseek-ai/dsh-system-prompt'),
    }, {
      surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq },
      sourceEventSeqs: [head.seq],
    })

    const events = target.snapshotEvents()
    // Three surface events, and only the two appends reach the projection.
    expect(events.filter(isTranscriptEvent)).toHaveLength(2)
    const lines = events
      .filter(isTranscriptEvent)
      .flatMap(candidate => projectEvent(candidate, 80))
      .map(stripAnsi)
      .join('\n')
    expect(lines).toContain('what changed here')
    expect(lines).not.toContain('You are a terminal agent')
    expect(lines).not.toContain('Be brief')

    await ctx.fiber.dispose()
  })
})

describe('the resume banner', () => {
  it('says how much was replayed', () => {
    expect(resumeBanner(30).map(stripAnsi)).toEqual(['', '· resumed — 30 earlier events'])
  })

  it('says so when there was nothing to replay', () => {
    // Otherwise reopening an empty session looks like the resume silently failed.
    expect(resumeBanner(0).map(stripAnsi)).toEqual(['', '· resumed an empty session'])
  })
})
