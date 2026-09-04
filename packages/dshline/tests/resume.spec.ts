import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { stripAnsi } from '@dshline/renderer'
import { isTranscriptEvent, resumeBanner } from '../src/resume.ts'

/**
 * A log event with just the fields the replay rule reads.
 * @param type - the event type.
 * @param surfaceOp - how it entered the surface, for the types that have one.
 * @returns the event.
 */
function event(type: string, surfaceOp?: string): SessionEvent {
  return { type, data: {}, ...surfaceOp === undefined ? {} : { surfaceOp } } as unknown as SessionEvent
}

describe('what a resumed transcript replays', () => {
  it('replays what was appended to the surface', () => {
    for (const type of ['user/message', 'assistant/message', 'tool/result']) {
      expect(isTranscriptEvent(event(type, 'append')), type).toBe(true)
    }
  })

  it('skips a replacement copy, which is model-only', () => {
    // A compaction replaces a range so the model's history stays coherent. Replaying
    // the replacement would show the user a summary in place of the exchange it
    // summarised — conversation they already read, erased on reopening.
    for (const type of ['user/message', 'assistant/message', 'tool/result']) {
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

  it('replays an attempt that committed no message, which draws nothing', () => {
    // Harness settles a failed, retried, or cancelled model call as
    // `assistant/attempt`. It is not surface-eligible, so it replays like any
    // other non-surface event and the projection has nothing to draw for it —
    // no special case here, and none needed.
    expect(isTranscriptEvent(event('assistant/attempt'))).toBe(true)
  })

  it('replays an event type it has never seen', () => {
    // The log is merge-extensible: a plugin may append anything. An unknown type
    // has no replacement semantics, and the projection ignores what it cannot draw.
    expect(isTranscriptEvent(event('some-plugin/event'))).toBe(true)
  })

  it('replays a surface-eligible event carrying no surfaceOp', () => {
    // `isSurfaceEvent` requires the op to be present, so an event without one falls
    // through to the general case and replays. Degenerate — the three surface types
    // always carry one — and the safe direction: replaying something that was not
    // on the surface shows the user a line too many, where skipping it would hide
    // conversation they had.
    expect(isTranscriptEvent(event('user/message'))).toBe(true)
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
