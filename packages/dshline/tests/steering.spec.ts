/**
 * The status line reads the attached Agent's live Inbox instead of replaying
 * its splice events or counting what this frontend submitted.
 *
 * The Inbox is Harness's own contract, and in the adopted generation its
 * concrete storage belongs to the driver: there is no constructible Inbox for a
 * frontend to stand up, and `hasPending`/`claim` are gone from the public
 * surface. So these tests drive upstream's own published `createInboxStub()` —
 * the structural double the Harness testkit exists to supply — over exactly the
 * operations a UI may perform, and assert what the status row says about them.
 *
 * The durable half of the same contract, over a REAL production Agent and the
 * real driver Inbox, is `capability/inbox.probe.spec.ts`: splice targets,
 * claims, cancellation, and cross-Agent isolation. Splitting them keeps this
 * file about presentation and that one about Harness semantics, rather than
 * having one file pretend to prove both from a hand-built object.
 */

import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Inbox } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { stripAnsi } from '@dshline/renderer'
import { describe, expect, it } from 'vitest'
import { pendingUserInput } from '../src/steering.ts'
import { createStatusView } from '../src/views.ts'

/** Wide enough that the pending segment never yields to layout pressure. */
const STATUS_COLUMNS = 120

/** Create one user-submitted prompt. */
const prompt = (text: string) => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/** Create context injected by a plugin, which queued steering must ignore. */
const injection = (text: string) => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: 'steering-test' },
})

/**
 * Drain one boundary list the way the driver's claim does — a pure deletion —
 * through the only public operation a consumer of the Inbox contract has.
 * @param inbox - the live inbox to drain.
 * @param target - the boundary list to empty.
 * @param count - how many messages the boundary takes.
 * @returns the removed messages, in list order.
 */
function drain(inbox: Inbox, target: 'next-turn' | 'next-step', count: number) {
  return inbox.splice(target, 0, count, [])
}

/**
 * Compose one status view repeatedly, as redraws do in the attached window.
 * @param inbox - authoritative projection read by every composition.
 * @returns a function that renders the current visible status row.
 */
function statusFrames(inbox: Inbox): () => string {
  const view = createStatusView(() => ({
    busy: false,
    tick: 0,
    elapsedMs: undefined,
    activityWord: 'waiting',
    activity: undefined,
    model: undefined,
    effort: undefined,
    usage: undefined,
    tokens: undefined,
    contextWindow: undefined,
    detail: 'compact',
    work: undefined,
    // Re-read on every composition, never captured: the whole point of the
    // segment is that it follows the authoritative inbox rather than a counter
    // this frontend keeps.
    pending: pendingUserInput(inbox),
    todo: undefined,
    plan: false,
    replay: undefined,
    goal: undefined,
  }))
  return () => stripAnsi(view.render(STATUS_COLUMNS)[0] ?? '')
}

describe('pending user input from the live Inbox', () => {
  it('shows already-pending user prompts in the first attached status frame', () => {
    // Input can already be parked when a window attaches — Harness reconstructs
    // the Inbox from the session's durable splices before the Agent is
    // published — so the first frame must state it rather than starting at zero
    // and catching up on the next mutation.
    const inbox = createInboxStub()
    inbox.append('next-step', prompt('steer this turn'))
    inbox.append('next-turn', prompt('run after this turn'))
    inbox.append('next-step', injection('provider context'))

    // One prompt on each list, so neither word alone is true and the segment
    // says `pending` rather than picking a side or spending two segments.
    expect(statusFrames(inbox)()).toContain('2 pending')
  })

  it('names which list the input is parked on, and says pending only for a mixture', () => {
    const inbox = createInboxStub()
    const frame = statusFrames(inbox)

    // next-step alone: the running turn will take it at its next step.
    inbox.append('next-step', prompt('while you are in there'))
    expect(frame()).toContain('1 steering')
    expect(frame()).not.toContain('queued')

    // Both lists: the count is the total, and the word is neither of theirs.
    inbox.append('next-turn', prompt('afterwards, run the tests'))
    expect(frame()).toContain('2 pending')
    expect(frame()).not.toContain('steering')

    // next-turn alone: a follow-up turn of its own, which is what `queued` means.
    expect(drain(inbox, 'next-step', 1)).toHaveLength(1)
    expect(frame()).toContain('1 queued')
    expect(frame()).not.toContain('pending')
  })

  it('ignores plugin context on either list, whichever word is in force', () => {
    const inbox = createInboxStub()
    const frame = statusFrames(inbox)

    // Context the agent assembled is not a keystroke waiting to be answered for,
    // so it never reaches this segment — on either list, and it cannot turn a
    // one-sided count into a mixture.
    inbox.append('next-step', injection('assembled context'))
    inbox.append('next-turn', injection('deferred context'))
    expect(frame()).not.toContain('pending')
    expect(frame()).not.toContain('queued')
    expect(frame()).not.toContain('steering')

    inbox.append('next-turn', prompt('the only real prompt'))
    expect(frame()).toContain('1 queued')
  })

  it('tracks insert, drain, and cancellation on every redraw from the live Inbox', () => {
    const inbox = createInboxStub()
    const frame = statusFrames(inbox)
    const synthetic = injection('assembled context')
    const queued = prompt('please adjust the answer')

    expect(frame()).not.toContain('steering')
    inbox.append('next-step', synthetic)
    expect(frame()).not.toContain('steering')
    inbox.append('next-step', queued)
    expect(frame()).toContain('1 steering')

    // A step boundary takes the whole next-step batch, injection included.
    expect(drain(inbox, 'next-step', 2)).toEqual([synthetic, queued])
    expect(frame()).not.toContain('steering')

    // A cancelled prompt is a removal, not a claim, and the count follows it the
    // same way — the segment holds no memory of what was submitted.
    const canceled = prompt('never mind')
    inbox.append('next-turn', canceled)
    expect(frame()).toContain('1 queued')
    expect(inbox.remove(canceled.id)).toBe(true)
    expect(frame()).not.toContain('queued')
  })

  it('keeps a parked prompt exact when a mixed drain takes only an injection', () => {
    const inbox = createInboxStub()
    const frame = statusFrames(inbox)
    const parked = prompt('take this next turn')
    const synthetic = injection('step-only context')

    inbox.append('next-turn', parked)
    inbox.append('next-step', synthetic)
    expect(frame()).toContain('1 queued')

    // Draining next-step must not disturb the next-turn list: the two are
    // separate boundaries, and a prompt parked for its own turn stays parked.
    expect(drain(inbox, 'next-step', 1)).toEqual([synthetic])
    expect(frame()).toContain('1 queued')
    expect(drain(inbox, 'next-turn', 1)).toEqual([parked])
    expect(frame()).not.toContain('queued')
  })
})
