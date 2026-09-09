/**
 * Tests for the context readings: what the cheap projections say, and what the
 * expensive per-node survey resolves them into.
 *
 * The real Harness meter is exercised in `capability/token-meter.probe.spec.ts`;
 * this file is the edge-case sheet — absent capabilities, absent figures, tie
 * ordering, a tool result whose call is NOT its neighbour, wide characters —
 * which needs constructed logs rather than a live agent.
 */

import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import {
  contextPressureTokens,
  contextPreview,
  contextReading,
  ContextSurveyor,
  resolveEntries,
} from '../src/context/model.ts'

/** One projection cut carrying whichever units a case needs. */
function cut(values: ProjectionSnapshot['values']): ProjectionSnapshot {
  return { asOfSeq: 0, values }
}

/** A session double: the members the model actually reads. */
function sessionOf(
  events: readonly (SessionEvent | undefined)[],
  replaceGeneration = 0,
  route?: { provider: string; model: string },
): Session {
  return {
    seq: events.length,
    eventAt: (seq: number) => events[seq],
    surface: { nodes: events.map((_, index) => index), replaceGeneration },
    // The folded request envelope, which is what the meter prices with and
    // therefore part of the surveyor's cache identity.
    requestHeader: () => route === undefined ? undefined : { config: route },
  } as unknown as Session
}

/** A measurement double, with node prices in surface order. */
function measurement(nodes: readonly { seq: number; tokens: number }[]): TokenMeasurement {
  return {
    logRevision: nodes.length,
    baseline: { kind: 'none', tokens: 0 },
    surfaceDeltaTokens: 0,
    totalTokens: 0,
    surfaceTokens: nodes.reduce((sum, node) => sum + node.tokens, 0),
    nodes,
  } as unknown as TokenMeasurement
}

/** A user-role surface event. */
function userMessage(text: string, source: unknown = { kind: 'user' }): SessionEvent {
  return {
    type: 'user/message',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    data: { id: 'm', role: 'user', content: [{ type: 'text', text }], source },
  } as unknown as SessionEvent
}

/** A tool call, which is not itself a surface node. */
function toolCall(callId: string, name: string, args = '{}'): SessionEvent {
  return {
    type: 'tool/call',
    seq: 0,
    time: 1,
    data: { turn: 1, step: 1, callId, name, arguments: args },
  } as unknown as SessionEvent
}

/** A tool result carrying its call id. */
function toolResult(callId: string, text: string): SessionEvent {
  return {
    type: 'tool/result',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    data: {
      turn: 3,
      step: 2,
      message: {
        id: 'r', role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
        source: { kind: 'tool', callId },
      },
    },
  } as unknown as SessionEvent
}

/** Mark one surface event as having replaced an earlier range. */
function replacement(event: SessionEvent): SessionEvent {
  return {
    ...(event as unknown as Record<string, unknown>),
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
  } as unknown as SessionEvent
}

/** A rendered system prompt, which is a surface node of its own since V3. */
function systemMessage(text: string): SessionEvent {
  return {
    type: 'system/message',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        id: 's', role: 'system', content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
      },
    },
  } as unknown as SessionEvent
}

/** An assistant reply. */
function assistantMessage(text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    data: {
      turn: 7, step: 4,
      message: { id: 'a', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
    },
  } as unknown as SessionEvent
}

describe('the cheap context reading', () => {
  it('reports no projections at all when the profile mounts no registry', () => {
    const reading = contextReading(undefined)
    expect(reading).toEqual({
      projections: false, metered: false, occupancy: undefined, composition: undefined,
    })
    expect(contextPressureTokens(reading)).toBeUndefined()
  })

  it('separates an absent registry from an unregistered token meter', () => {
    const reading = contextReading(cut({}))
    expect(reading.projections).toBe(true)
    expect(reading.metered).toBe(false)
    expect(contextPressureTokens(reading)).toBeUndefined()
  })

  it('reports no occupancy until a provider has reported a prompt size', () => {
    // Registered, with a capacity, and still no numerator: the case that must
    // never become a fabricated zero or a 0% bar.
    const reading = contextReading(cut({ contextPressure: { contextWindow: 1_000_000 } }))
    expect(reading.metered).toBe(true)
    expect(reading.occupancy).toBeUndefined()
  })

  it('reports the projection’s own figure, with no second precision claim', () => {
    // `projectedTokens` and nothing else. An earlier revision also carried the
    // provider's bare sample so it could claim exactness whenever the two
    // matched — but several surface changes can net to a zero heuristic delta,
    // so the equality never proved that, and the claim is gone rather than
    // propped up with shadow state.
    const settled = contextReading(cut({
      contextPressure: { pressureTokens: 1000, projectedTokens: 1000, contextWindow: 4000 },
    }))
    expect(settled.occupancy).toEqual({ tokens: 1000, capacity: 4000 })

    const moved = contextReading(cut({
      contextPressure: { pressureTokens: 1000, projectedTokens: 1420, contextWindow: 4000 },
    }))
    expect(moved.occupancy).toEqual({ tokens: 1420, capacity: 4000 })
    expect(contextPressureTokens(moved)).toBe(1420)
  })

  it('keeps an unknown capacity unknown', () => {
    const reading = contextReading(cut({
      contextPressure: { pressureTokens: 900, projectedTokens: 900 },
    }))
    expect(reading.occupancy?.capacity).toBeUndefined()
  })

  it('totals composition from its own three figures, never from the occupancy figure', () => {
    const reading = contextReading(cut({
      contextPressure: { pressureTokens: 5000, projectedTokens: 5000, contextWindow: 100_000 },
      contextBreakdown: { systemTokens: 12, toolsTokens: 48, messageTokens: 116 },
    }))
    // Deliberately not 5000: the composition is the meter's fixed estimator and
    // the occupancy is provider-anchored, and upstream states they disagree.
    expect(reading.composition).toEqual({ system: 12, tools: 48, messages: 116, total: 176 })
  })

  it('reports a fresh session’s all-zero composition as present and empty', () => {
    const reading = contextReading(cut({
      contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
    }))
    expect(reading.metered).toBe(true)
    expect(reading.composition?.total).toBe(0)
  })
})

describe('resolving the largest context entries', () => {
  it('orders by price, breaks ties by log order, and bounds the result', () => {
    const session = sessionOf([
      userMessage('one'), userMessage('two'), userMessage('three'), userMessage('four'),
    ])
    const entries = resolveEntries(
      session,
      measurement([{ seq: 0, tokens: 50 }, { seq: 1, tokens: 90 }, { seq: 2, tokens: 50 }, { seq: 3, tokens: 10 }]),
      3,
    )
    expect(entries.map(entry => entry.seq)).toEqual([1, 0, 2])
    // Equal sizes keep one stable order across paints rather than swapping
    // under the cursor.
    expect(entries[1]?.tokens).toBe(entries[2]?.tokens)
    // Position is where the node sits in the model's history, not its rank.
    expect(entries[0]?.position).toBe(2)
  })

  it('divides shares by the measured surface total, and survives a zero total', () => {
    const session = sessionOf([userMessage('a'), userMessage('b')])
    const entries = resolveEntries(session, measurement([{ seq: 0, tokens: 75 }, { seq: 1, tokens: 25 }]), 8)
    expect(entries[0]?.share).toBeCloseTo(0.75)
    expect(entries[1]?.share).toBeCloseTo(0.25)

    const empty = resolveEntries(session, measurement([{ seq: 0, tokens: 0 }]), 8)
    expect(empty[0]?.share).toBe(0)
  })

  it('pairs a tool result with its own call by id, never with its neighbour', () => {
    // A parallel batch: two calls dispatched together, results returning in the
    // other order. The event BEFORE each result is the wrong call, which is
    // exactly why the pairing is by id.
    const session = sessionOf([
      toolCall('call-a', 'run_shell_command'),
      toolCall('call-b', 'read_file'),
      toolResult('call-b', 'file contents'),
      toolResult('call-a', 'test output'),
    ])
    const entries = resolveEntries(
      session,
      measurement([{ seq: 2, tokens: 10 }, { seq: 3, tokens: 20 }]),
      8,
    )
    expect(entries[0]).toMatchObject({ seq: 3, kind: 'tool-result', tool: 'run_shell_command', turn: 3, step: 2 })
    expect(entries[1]).toMatchObject({ seq: 2, kind: 'tool-result', tool: 'read_file' })
  })

  it('names a system prompt as itself rather than as an unrecognized entry', () => {
    // Session format V3 put the rendered prompt on the surface, so `/context`
    // resolves it like any other node. Falling through to `other` would answer
    // "what is occupying the context" with `context entry` for what is regularly
    // the largest node in a fresh session.
    const session = sessionOf([systemMessage('You are a terminal agent.'), userMessage('hello')])
    const entries = resolveEntries(
      session,
      measurement([{ seq: 0, tokens: 900 }, { seq: 1, tokens: 5 }]),
      8,
    )
    expect(entries[0]).toMatchObject({ seq: 0, kind: 'system', turn: 1, step: 1, replaced: false })
    // Its content is previewable through Harness's own per-node projection, the
    // same way every other node's is.
    expect(contextPreview(session, SessionSeq(0)))
      .toEqual({ text: 'You are a terminal agent.', truncated: false, available: true })
  })

  it('reports a normalized system prompt as a replacement, without renaming it', () => {
    // Harness rewrites the head system node in place when a route cannot take an
    // in-history change. That is a generic surface replacement, and `/context`
    // says exactly that much: the node is still the system prompt.
    const session = sessionOf([replacement(systemMessage('Revised instructions.'))])
    const entries = resolveEntries(session, measurement([{ seq: 0, tokens: 120 }]), 8)
    expect(entries[0]).toMatchObject({ kind: 'system', replaced: true })
  })

  it('leaves a tool name absent rather than guessing when no call carries the id', () => {
    const session = sessionOf([toolResult('call-missing', 'orphan')])
    const entries = resolveEntries(session, measurement([{ seq: 0, tokens: 5 }]), 8)
    expect(entries[0]?.kind).toBe('tool-result')
    expect(entries[0]?.tool).toBeUndefined()
  })

  it('names each kind of surface node off an authoritative fact', () => {
    const events = [
      userMessage('typed by a human'),
      userMessage('nested AGENTS.md', { kind: 'plugin', plugin: 'agent-instructions', form: 'instructions' }),
      // The compaction checkpoint source every backend is required to write.
      replacement(userMessage('the story so far', {
        kind: 'plugin', plugin: 'compact', compactionId: 'c-1',
      })),
      assistantMessage('a reply'),
      replacement(toolResult('call-x', 'output')),
      { type: 'plugin/whatever', seq: 5, time: 1, data: {} } as unknown as SessionEvent,
    ]
    const entries = resolveEntries(
      sessionOf(events, 1),
      measurement([0, 1, 2, 3, 4, 5].map(seq => ({ seq, tokens: 10 - seq }))),
      8,
    )
    const bySeq = new Map(entries.map(entry => [entry.seq, entry]))
    expect(bySeq.get(0)?.kind).toBe('user')
    expect(bySeq.get(1)).toMatchObject({ kind: 'context', form: 'instructions' })
    expect(bySeq.get(2)).toMatchObject({ kind: 'summary', replaced: true })
    expect(bySeq.get(3)).toMatchObject({ kind: 'assistant', turn: 7, step: 4 })
    // A replaced tool result is reported as REPLACED and nothing more: the log
    // does not, by itself, prove a replacement was a reduction.
    expect(bySeq.get(4)).toMatchObject({ kind: 'tool-result', replaced: true })
    // A merge-extensible event type this frontend has never seen is reported as
    // an entry rather than dropped or guessed at.
    expect(bySeq.get(5)?.kind).toBe('other')
  })

  it('claims a compaction summary only from compaction’s own provenance', () => {
    // Harness lets ANY producer replace a surface range. A replacement is
    // therefore not evidence of a compaction, and must not be labelled as one.
    const foreign = replacement(userMessage('rewritten by something else', {
      kind: 'plugin', plugin: 'some-other-plugin', form: 'snapshot',
    }))
    // Even a message from a plugin literally named `compact` is not a
    // checkpoint without the transaction identity a checkpoint carries.
    const unmarked = replacement(userMessage('no transaction', { kind: 'plugin', plugin: 'compact' }))
    const human = replacement(userMessage('a replaced human turn', { kind: 'user' }))
    const entries = resolveEntries(
      sessionOf([foreign, unmarked, human], 3),
      measurement([{ seq: 0, tokens: 30 }, { seq: 1, tokens: 20 }, { seq: 2, tokens: 10 }]),
      8,
    )
    const bySeq = new Map(entries.map(entry => [entry.seq, entry]))
    expect(bySeq.get(0)).toMatchObject({ kind: 'context', form: 'snapshot', replaced: true })
    expect(bySeq.get(1)).toMatchObject({ kind: 'context', replaced: true })
    expect(bySeq.get(2)).toMatchObject({ kind: 'user', replaced: true })
    expect(entries.some(entry => entry.kind === 'summary')).toBe(false)
  })

  it('keeps a priced node whose event is not in the loaded window', () => {
    const session = sessionOf([undefined, userMessage('present')])
    const entries = resolveEntries(session, measurement([{ seq: 0, tokens: 40 }, { seq: 1, tokens: 4 }]), 8)
    expect(entries[0]).toMatchObject({ seq: 0, kind: 'other', tokens: 40 })
  })
})

describe('one entry’s bounded preview', () => {
  it('reads the content the model carries, through the shared derivation', () => {
    const session = sessionOf([userMessage('what the model sees')])
    expect(contextPreview(session, SessionSeq(0))).toEqual({
      text: 'what the model sees', truncated: false, available: true,
    })
  })

  it('answers “why is this large” for a node whose weight is not prose', () => {
    const session = sessionOf([toolResult('call-a', 'PASS one\nPASS two')])
    expect(contextPreview(session, SessionSeq(0)).text).toBe('PASS one\nPASS two')

    const call = sessionOf([{
      type: 'assistant/message',
      seq: 0, time: 1, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: 'a', role: 'assistant', source: { kind: 'model' },
          content: [
            { type: 'tool-call', name: 'write_file', arguments: '{"path":"a.ts"}' },
            { type: 'image', ref: 'x' },
          ],
        },
      },
    } as unknown as SessionEvent])
    const preview = contextPreview(call, SessionSeq(0)).text
    expect(preview).toContain('write_file {"path":"a.ts"}')
    // A block type this frontend has no text for is NAMED, so a large image
    // node does not preview as a blank box.
    expect(preview).toContain('[image]')
  })

  it('bounds a huge entry and says it was cut', () => {
    const session = sessionOf([userMessage('x'.repeat(20_000))])
    const preview = contextPreview(session, SessionSeq(0))
    expect(preview.truncated).toBe(true)
    expect(preview.text.length).toBeLessThan(20_000)
  })

  it('preserves wide characters and returns control bytes unescaped for the caller', () => {
    // The model returns raw text on purpose: escaping belongs with painting, so
    // that colour is never applied before text is made safe.
    const session = sessionOf([userMessage('上下文[31m红')])
    expect(contextPreview(session, SessionSeq(0)).text).toBe('上下文[31m红')
  })

  it('reports an entry with no derivable message as carrying no content', () => {
    const empty = sessionOf([{
      type: 'assistant/message',
      seq: 0, time: 1, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [], source: { kind: 'model' } } },
    } as unknown as SessionEvent])
    expect(contextPreview(empty, SessionSeq(0)).available).toBe(false)
    expect(contextPreview(sessionOf([]), 4).available).toBe(false)
  })
})

describe('the context surveyor', () => {
  it('reports honestly when no meter is mounted', () => {
    const surveyor = new ContextSurveyor({ meter: () => undefined, session: sessionOf([]), limit: 8 })
    expect(surveyor.read()).toEqual({ available: false, surfaceTokens: 0, nodes: 0, entries: [] })
  })

  it('reports honestly when the meter refuses, instead of taking the live region down', () => {
    const surveyor = new ContextSurveyor({
      meter: () => ({ measure: () => { throw new Error('malformed log') } }),
      session: sessionOf([userMessage('a')]),
      limit: 8,
    })
    expect(surveyor.read().available).toBe(false)
  })

  it('remeasures when the surface is replaced, not only when it grows', () => {
    // A compaction leaves the node COUNT lower and bumps Harness's own
    // replacement generation; keying on length alone would serve a stale survey.
    let generation = 0
    let measured = 0
    const events = [userMessage('a'), userMessage('b')]
    const session = {
      seq: events.length,
      eventAt: (seq: number) => events[seq],
      surface: { nodes: [0], get replaceGeneration() { return generation } },
    } as unknown as Session
    const surveyor = new ContextSurveyor({
      meter: () => ({
        measure: () => {
          measured += 1
          return measurement([{ seq: 0, tokens: 1 }])
        },
      }),
      session,
      limit: 8,
    })
    surveyor.read()
    surveyor.read()
    expect(measured).toBe(1)
    generation = 1
    surveyor.read()
    expect(measured).toBe(2)
  })

  it('remeasures when the system prompt changes, through Harness’s own surface revision', () => {
    // Session format V3 makes a system-prompt change a surface change: a route
    // that reads a later `system` message APPENDS a node, and one that cannot
    // REPLACES the head. Both already move the two facts this cache keys on, so
    // no counter of dshline's own is needed to notice a prompt edit.
    let nodes = [0, 1]
    let generation = 0
    let measured = 0
    const events = [systemMessage('first'), userMessage('a'), systemMessage('second')]
    const session = {
      seq: events.length,
      eventAt: (seq: number) => events[seq],
      surface: {
        get nodes() { return nodes },
        get replaceGeneration() { return generation },
      },
    } as unknown as Session
    const surveyor = new ContextSurveyor({
      meter: () => ({
        measure: () => {
          measured += 1
          return measurement([{ seq: 0, tokens: 1 }])
        },
      }),
      session,
      limit: 8,
    })
    surveyor.read()
    surveyor.read()
    expect(measured).toBe(1)
    // An in-history prompt change: one more node on the surface.
    nodes = [0, 1, 2]
    surveyor.read()
    expect(measured).toBe(2)
    // A normalized prompt: the head node is replaced in place, so the count is
    // unchanged and only Harness's replacement generation says anything moved.
    generation = 1
    surveyor.read()
    expect(measured).toBe(3)
  })

  it('retries an absent meter instead of caching its absence forever', () => {
    // The meter is a host-plane plugin a profile can mount AFTER an inspector
    // first read, and an idle session's surface never moves. Caching the
    // absence against a revision would leave `/context` reporting "unavailable"
    // for the rest of the session.
    let meter: { measure: () => TokenMeasurement } | undefined
    const surveyor = new ContextSurveyor({
      meter: () => meter,
      session: sessionOf([userMessage('a')]),
      limit: 8,
    })
    expect(surveyor.read().available).toBe(false)
    meter = { measure: () => measurement([{ seq: 0, tokens: 12 }]) }
    // Same surface, same route: the survey must still pick the meter up.
    const found = surveyor.read()
    expect(found.available).toBe(true)
    expect(found.entries[0]?.tokens).toBe(12)
  })

  it('retries a refusing meter that later succeeds', () => {
    // `measure()` documents a throw for a malformed log, which a later append
    // can repair. That is a failure to retry, not a fact to remember.
    let refuse = true
    let measured = 0
    const surveyor = new ContextSurveyor({
      meter: () => ({
        measure: () => {
          measured += 1
          if (refuse) throw new Error('malformed log')
          return measurement([{ seq: 0, tokens: 5 }])
        },
      }),
      session: sessionOf([userMessage('a')]),
      limit: 8,
    })
    expect(surveyor.read().available).toBe(false)
    expect(surveyor.read().available).toBe(false)
    expect(measured).toBe(2)
    refuse = false
    expect(surveyor.read().available).toBe(true)
  })

  it('reprices the same surface once when the routed model changes', () => {
    // The header's provider and model select the routed adapter's image
    // pricing, so an unchanged surface can price differently under a new route.
    let route = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    let measured = 0
    const events = [userMessage('a')]
    const session = {
      seq: events.length,
      eventAt: (seq: number) => events[seq],
      surface: { nodes: [0], replaceGeneration: 0 },
      requestHeader: () => ({ config: route }),
    } as unknown as Session
    const surveyor = new ContextSurveyor({
      meter: () => ({
        measure: () => {
          measured += 1
          return measurement([{ seq: 0, tokens: 7 }])
        },
      }),
      session,
      limit: 8,
    })
    surveyor.read()
    surveyor.read()
    expect(measured).toBe(1)

    route = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
    surveyor.read()
    expect(measured).toBe(2)
    // Once, not once per read: the new route is now the cached identity.
    surveyor.read()
    surveyor.read()
    expect(measured).toBe(2)
  })

  it('survives a request envelope it cannot read', () => {
    // The accessor folds header events, so a malformed one throws there exactly
    // as it would inside `measure()`. That must not take the read down.
    const session = {
      seq: 1,
      eventAt: (seq: number) => [userMessage('a')][seq],
      surface: { nodes: [0], replaceGeneration: 0 },
      requestHeader: () => { throw new Error('malformed header') },
    } as unknown as Session
    const surveyor = new ContextSurveyor({
      meter: () => ({ measure: () => measurement([{ seq: 0, tokens: 3 }]) }),
      session,
      limit: 8,
    })
    expect(surveyor.read().available).toBe(true)
  })

  it('drops its cache when asked, without a timer', () => {
    let measured = 0
    const surveyor = new ContextSurveyor({
      meter: () => ({ measure: () => { measured += 1; return measurement([]) } }),
      session: sessionOf([]),
      limit: 8,
    })
    surveyor.read()
    surveyor.invalidate()
    surveyor.read()
    expect(measured).toBe(2)
  })
})
