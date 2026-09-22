/**
 * The one session-rename question, and the two surfaces that ask it.
 *
 * The `/sessions` browser and the `/session` hub must not grow two wordings for
 * the same interaction. Only the human-facing layer is shared here; authority
 * over the mutation stays with each caller, which is why the helper is proven
 * never to reach for `ctx.sessionTitle`.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Key } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import type { TuiOverlay } from '../src/slots.ts'
import { promptSessionTitle, sessionTitlePrompt } from '../src/prompt.ts'

/**
 * Let every pending microtask run, so a settled prompt's continuation has
 * pushed its overlay before the test reads the newest one.
 * @returns when the queue has drained.
 */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

/**
 * A context whose registry hands each pushed overlay to the test, plus a
 * mutation surface the helper must never touch.
 * @returns the context, key drivers, the rendered text, and the mutation spies.
 */
function harness(): {
  ctx: Context
  type: (text: string) => Promise<void>
  press: (...keys: Key[]) => Promise<void>
  shown: (columns?: number, rows?: number) => string
  readonly rename: ReturnType<typeof vi.fn>
  /** How many times anything asked the context for the mutation service. */
  readonly serviceReads: { count: number }
} {
  const stack: TuiOverlay[] = []
  const rename = vi.fn((_session: unknown, title: string) => ({ title }))
  const serviceReads = { count: 0 }
  const ctx = {
    get: (name: string) => {
      if (name !== 'sessionTitle') return undefined
      serviceReads.count += 1
      return { rename }
    },
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay) => {
        stack.push(overlay)
        return (): void => {
          const index = stack.indexOf(overlay)
          if (index >= 0) stack.splice(index, 1)
        }
      },
      invalidate: (): void => {},
    },
  } as unknown as Context
  return {
    ctx,
    type: async text => { stack.at(-1)?.handleKey({ kind: 'text', text }); await settle() },
    press: async (...keys) => {
      for (const key of keys) stack.at(-1)?.handleKey(key)
      await settle()
    },
    shown: (columns = 90, rows = 24) => stripAnsi((stack.at(-1)?.render(columns, rows) ?? []).join('\n')),
    rename,
    serviceReads,
  }
}

describe('the shared rename wording', () => {
  it('edits an existing title, quoting it in the question', () => {
    expect(sessionTitlePrompt('Fix the wrap bug')).toEqual({
      title: 'Rename session',
      message: 'Rename “Fix the wrap bug”',
      initial: 'Fix the wrap bug',
    })
  })

  it('falls back to the empty-state question with no prefill', () => {
    expect(sessionTitlePrompt(undefined)).toEqual({
      title: 'Rename session',
      message: 'Rename this session',
      initial: '',
    })
  })

  it('treats an empty row title as no title, matching the folded browser row', () => {
    // `/sessions` collapses a missing focused title to the empty string before
    // asking; the helper must read both the same way or the two surfaces split.
    expect(sessionTitlePrompt('').message).toBe('Rename this session')
    expect(sessionTitlePrompt('').initial).toBe('')
  })

  it('escapes control characters in the title it quotes', () => {
    // A stored title is model-authored text. Painting it unescaped would let it
    // drive the terminal; the prefill keeps the raw value, which Harness owns.
    const copy = sessionTitlePrompt('before\u001b[2Jafter')
    expect(copy.message).toContain('^[[2J')
    expect(copy.message).not.toContain('\u001b')
    expect(copy.initial).toBe('before\u001b[2Jafter')
  })
})

describe('promptSessionTitle', () => {
  it('prefills the current title and returns the edited draft', async () => {
    const f = harness()
    const answer = promptSessionTitle(f.ctx, { currentTitle: 'Old name', view: 'Sessions · rename' })
    await settle()
    expect(f.shown()).toContain('Rename “Old name”')
    expect(f.shown()).toContain('Old name')
    expect(f.shown()).toContain('Sessions · rename')
    await f.press({ kind: 'key', name: 'ctrl-u' })
    await f.type('New name')
    await f.press({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toBe('New name')
  })

  it('shows the empty-state question when there is no current title', async () => {
    const f = harness()
    const answer = promptSessionTitle(f.ctx, { currentTitle: undefined, view: 'Session' })
    await settle()
    expect(f.shown()).toContain('Rename this session')
    expect(f.shown()).not.toContain('“')
    await f.press({ kind: 'key', name: 'enter' })
    await expect(answer).resolves.toBe('')
  })

  it('propagates cancellation as undefined rather than an empty draft', async () => {
    // A cancelled rename is not an empty replacement title: the caller must be
    // able to tell "I changed my mind" from "I cleared the field".
    const f = harness()
    const answer = promptSessionTitle(f.ctx, { currentTitle: 'Old name', view: 'Session' })
    await settle()
    await f.press({ kind: 'key', name: 'escape' })
    await expect(answer).resolves.toBeUndefined()
  })

  it('withdraws without an answer when the supplied signal aborts', async () => {
    const f = harness()
    const abort = new AbortController()
    const answer = promptSessionTitle(f.ctx, { currentTitle: 'Old name', view: 'Session', signal: abort.signal })
    await settle()
    abort.abort()
    await expect(answer).resolves.toBeUndefined()
  })

  it('lets both rename surfaces consume the same draft', async () => {
    // The hub passes `Session` and the browser `Sessions · rename`; the draft
    // they get back is the same helper's, not a surface-specific one.
    for (const view of ['Sessions · rename', 'Session']) {
      const f = harness()
      const answer = promptSessionTitle(f.ctx, { currentTitle: 'Old name', view })
      await settle()
      await f.press({ kind: 'key', name: 'enter' })
      await expect(answer, view).resolves.toBe('Old name')
    }
  })

  it('never reaches for mutation authority', async () => {
    // The helper only puts the question on screen. Reading `ctx.sessionTitle`
    // here at all is what would let it rename a session it does not own — and
    // the mutation belongs to `renameTitle` (browser) and `service.rename` (hub).
    const f = harness()
    const answered = promptSessionTitle(f.ctx, { currentTitle: 'Old name', view: 'Session' })
    await settle()
    await f.press({ kind: 'key', name: 'enter' })
    await expect(answered).resolves.toBe('Old name')

    const cancelled = promptSessionTitle(f.ctx, { currentTitle: 'Old name', view: 'Sessions · rename' })
    await settle()
    await f.press({ kind: 'key', name: 'escape' })
    await expect(cancelled).resolves.toBeUndefined()

    expect(f.rename).not.toHaveBeenCalled()
    expect(f.serviceReads.count).toBe(0)
  })
})
