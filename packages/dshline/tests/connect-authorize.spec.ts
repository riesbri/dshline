/**
 * Running a Harness authorization flow in a terminal.
 *
 * Nothing here knows a provider's login. The flows below speak only the seam's
 * neutral vocabulary — a notice, and a `text`, `secret`, or `select` prompt —
 * which is the property being tested: a surface that renders one flow renders
 * all of them.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { stripAnsi } from '@dshline/renderer'
import type { Key } from '@dshline/renderer'
import type { TuiOverlay } from '../src/slots.ts'
import { noticeLines, runAuthorization } from '../src/connect/authorize.ts'
import type {
  AuthorizationInteractionWrite,
  AuthorizationPromptRead,
  ConnectAuthorization,
} from '../src/connect/harness.ts'

/** A context whose slot registry hands each pushed overlay to the test. */
interface Slots {
  readonly ctx: Context
  /** Answer the overlay currently mounted, by pressing keys into it. */
  readonly answer: (...keys: Key[]) => void
  /** Whether an overlay is mounted right now. */
  readonly mounted: () => boolean
  /** How many overlays were pushed in total, mounted or not. */
  readonly pushes: () => number
  /** The topmost overlay's rendered lines. */
  readonly lines: (columns: number, rows: number) => readonly string[]
  /** The topmost overlay's visible text. */
  readonly text: () => string
}

/**
 * A context offering only the slot registry, which is all this module uses.
 * @returns the context and the controls for whatever it mounts.
 */
function slots(): Slots {
  const stack: TuiOverlay[] = []
  let pushes = 0
  const ctx = {
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay) => {
        pushes += 1
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
    answer: (...keys) => {
      const top = stack.at(-1)
      for (const key of keys) top?.handleKey(key)
    },
    mounted: () => stack.length > 0,
    pushes: () => pushes,
    lines: (columns, rows) => stack.at(-1)?.render(columns, rows) ?? [],
    text: () => stripAnsi((stack.at(-1)?.render(80, 24) ?? []).join('\n')),
  }
}

/** One flow's script: what it does when begun. */
type Script = (interaction: AuthorizationInteractionWrite, signal: AbortSignal) => Promise<'authorized'>

/** A recording authorization seam driven by one script. */
interface Seam {
  readonly authorization: ConnectAuthorization
  readonly cancelled: string[]
  readonly began: { key: string; method: string | undefined }[]
}

/**
 * An authorization seam that runs `script` and settles the way the real one does.
 * @param script - what the flow does.
 * @returns the seam and what it recorded.
 */
function seam(script: Script): Seam {
  const cancelled: string[] = []
  const began: { key: string; method: string | undefined }[] = []
  const authorization: ConnectAuthorization = {
    list: () => [],
    cancel: key => { cancelled.push(key) },
    begin: async request => {
      began.push({ key: request.key, method: request.method })
      const signal = request.signal ?? new AbortController().signal
      try {
        await script(request.interaction, signal)
        return { status: 'authorized' }
      } catch (error) {
        // Exactly the seam's own rule: a withdrawn attempt is an outcome, not a
        // failure, whatever error the surface rejected the prompt with.
        if (signal.aborted) return { status: 'cancelled' }
        throw error
      }
    },
  }
  return { authorization, cancelled, began }
}

describe('a notice in the transcript', () => {
  it('gives the page and the code lines of their own', () => {
    const lines = noticeLines({
      message: 'Enter this code on the verification page.',
      url: 'https://auth.example/device',
      code: 'WXYZ-1234',
    }, 'ChatGPT').map(stripAnsi)
    expect(lines).toEqual([
      '· ChatGPT: Enter this code on the verification page.',
      '  https://auth.example/device',
      '  code WXYZ-1234',
    ])
  })

  it('carries a bare message alone', () => {
    expect(noticeLines({ message: 'Signing in…' }, 'X').map(stripAnsi)).toEqual(['· X: Signing in…'])
  })

  it('escapes text a provider supplied before styling it', () => {
    const lines = noticeLines({ message: 'go \u001b[2J', url: 'https://x\u0007' }, 'X').map(stripAnsi)
    expect(lines[0]).toContain('^[[2J')
    expect(lines[1]).toContain('^G')
  })

  it('escapes the label a flow chose, which is provider text too', () => {
    // The label comes from the plugin that registered the flow, so it is no more
    // trustworthy than the message beside it.
    expect(stripAnsi(noticeLines({ message: 'hi' }, 'Chat\u001b[2JGPT')[0] ?? ''))
      .toContain('Chat^[[2JGPT')
  })
})

describe('running one flow', () => {
  it('commits each notice and answers each prompt, whatever shape it takes', async () => {
    const committed: string[] = []
    const view = slots()
    const asked: AuthorizationPromptRead['kind'][] = []
    const { authorization } = seam(async interaction => {
      interaction.notify({ message: 'Continue in your browser', url: 'https://auth.example' })
      asked.push('text')
      const code = await interaction.prompt({ kind: 'text', message: 'Paste the code' })
      expect(code).toBe('abcd')
      asked.push('secret')
      const key = await interaction.prompt({ kind: 'secret', message: 'Paste the key' })
      expect(key).toBe('sk-1')
      asked.push('select')
      const account = await interaction.prompt({
        kind: 'select',
        message: 'Which account?',
        options: [{ id: 'work', label: 'Work' }, { id: 'home', label: 'Home' }],
      })
      expect(account).toBe('work')
      return 'authorized'
    })
    const running = runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      commit: lines => { committed.push(...lines.map(stripAnsi)) },
    })
    await settle()
    view.answer({ kind: 'text', text: 'abcd' }, { kind: 'key', name: 'enter' })
    await settle()
    view.answer({ kind: 'text', text: 'sk-1' }, { kind: 'key', name: 'enter' })
    await settle()
    view.answer({ kind: 'key', name: 'enter' })
    expect(await running).toEqual({ kind: 'done', message: 'ChatGPT: signed in' })
    expect(asked).toEqual(['text', 'secret', 'select'])
    expect(committed[0]).toContain('Continue in your browser')
    expect(committed[1]).toContain('https://auth.example')
    expect(view.mounted()).toBe(false)
  })

  it('passes the chosen method through to the seam', async () => {
    const view = slots()
    const { authorization, began } = seam(async () => 'authorized')
    await runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      method: 'api-key',
      commit: () => {},
    })
    expect(began).toEqual([{ key: 'llm-pi-ai/openai', method: 'api-key' }])
  })

  it('keeps an attempt-owned waiting overlay visible without a Harness prompt', async () => {
    const view = slots()
    let aborted = false
    const { authorization } = seam(async (_interaction, signal) => {
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        }, { once: true })
      })
      throw new Error('withdrawn')
    })
    const running = runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      commit: () => {},
    })
    await settle()
    expect(view.text()).toContain('Waiting for authorization…')
    expect(view.text()).toContain('The authorization flow is still in progress.')
    // The waiting surface owns Esc while no prompt does, so this withdraws the
    // actual attempt rather than exposing an inert Connect browser.
    view.answer({ kind: 'key', name: 'escape' })
    expect(await running).toEqual({ kind: 'failed', message: 'ChatGPT: sign-in cancelled' })
    expect(aborted).toBe(true)
    expect(view.mounted()).toBe(false)
  })

  it('bounds the waiting surface at its physical-height boundary', async () => {
    const view = slots()
    let finish: (() => void) | undefined
    const { authorization } = seam(async () => {
      await new Promise<void>(resolve => { finish = resolve })
      return 'authorized'
    })
    const running = runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      commit: () => {},
    })
    await settle()
    // The framed surface is seven physical rows: a leading blank, four body
    // rows, and the frame's two borders. Six must select the compact fallback.
    expect(view.lines(80, 6)).toHaveLength(1)
    expect(view.lines(80, 7)).toHaveLength(7)
    for (const columns of [1, 20, 80]) {
      for (const rows of [0, 1, 5, 6, 7, 8]) {
        expect(view.lines(columns, rows).length).toBeLessThanOrEqual(rows)
      }
    }
    finish?.()
    await running
  })

  it('returns to waiting after a prompt until the unfinished flow settles', async () => {
    const view = slots()
    let finish: (() => void) | undefined
    const { authorization } = seam(async interaction => {
      const answer = await interaction.prompt({ kind: 'text', message: 'Paste the code' })
      expect(answer).toBe('abcd')
      await new Promise<void>(resolve => { finish = resolve })
      return 'authorized'
    })
    const running = runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      commit: () => {},
    })
    await settle()
    expect(view.text()).toContain('Paste the code')
    view.answer({ kind: 'text', text: 'abcd' }, { kind: 'key', name: 'enter' })
    await settle()
    expect(view.text()).toContain('Waiting for authorization…')
    finish?.()
    expect(await running).toEqual({ kind: 'done', message: 'ChatGPT: signed in' })
    expect(view.mounted()).toBe(false)
  })

  it('withdraws the whole attempt when the reader dismisses a prompt', async () => {
    // Cancelling through the request's signal rather than the seam's decline
    // error, which this package cannot import: the seam treats both as the same
    // outcome, so the observable result has to be `cancelled`, not a failure.
    const view = slots()
    let aborted = false
    const { authorization } = seam(async (interaction, signal) => {
      signal.addEventListener('abort', () => { aborted = true })
      await interaction.prompt({ kind: 'text', message: 'Paste the code' })
      return 'authorized'
    })
    const running = runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      commit: () => {},
    })
    await settle()
    view.answer({ kind: 'key', name: 'escape' })
    expect(await running).toEqual({ kind: 'failed', message: 'ChatGPT: sign-in dismissed' })
    expect(aborted).toBe(true)
  })

  it('lets a flow withdraw one prompt without losing the attempt', async () => {
    // A flow racing a typed code against a browser callback retires the losing
    // question; treating that as a dismissal would cancel a live sign-in.
    const view = slots()
    const race = new AbortController()
    const { authorization } = seam(async interaction => {
      const losing = interaction.prompt({ kind: 'text', message: 'Paste the code', signal: race.signal })
      race.abort()
      await losing.catch(() => {})
      return 'authorized'
    })
    const running = runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      commit: () => {},
    })
    expect(await running).toEqual({ kind: 'done', message: 'ChatGPT: signed in' })
    expect(view.mounted()).toBe(false)
  })

  it('reports a flow that broke, separately from one that was refused', async () => {
    const view = slots()
    const { authorization } = seam(() => Promise.reject(new Error('token exchange refused')))
    expect(await runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      commit: () => {},
    })).toEqual({ kind: 'failed', message: 'ChatGPT: sign-in failed — token exchange refused' })
  })
})

describe('when the browser that started a sign-in closes', () => {
  it('withdraws a flow that is waiting with no prompt on screen', async () => {
    // The case this exists for: an OAuth flow sitting on a browser callback has
    // nothing mounted, so nothing else would ever take it down.
    const view = slots()
    const life = new AbortController()
    let aborted = false
    const { authorization } = seam(async (_interaction, signal) => {
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        }, { once: true })
      })
      return 'authorized'
    })
    const running = runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      signal: life.signal,
      commit: () => {},
    })
    await settle()
    life.abort()
    expect(await running).toEqual({ kind: 'failed', message: 'ChatGPT: sign-in withdrawn' })
    expect(aborted).toBe(true)
  })

  it('takes a mounted prompt down with it, even one the flow can also withdraw', async () => {
    // The prompt carries its OWN signal, which never fires. Honouring only that
    // one would leave the question on screen after the browser had gone.
    const view = slots()
    const life = new AbortController()
    const race = new AbortController()
    const { authorization } = seam(async interaction => {
      await interaction.prompt({ kind: 'text', message: 'Paste the code', signal: race.signal })
      return 'authorized'
    })
    const running = runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      signal: life.signal,
      commit: () => {},
    })
    await settle()
    expect(view.mounted()).toBe(true)
    life.abort()
    await settle()
    expect(view.mounted()).toBe(false)
    expect(await running).toEqual({ kind: 'failed', message: 'ChatGPT: sign-in withdrawn' })
  })

  it('puts no later prompt on screen, however late the flow asks', async () => {
    // A flow that has not observed its signal yet must not push an overlay over
    // whatever the reader moved on to.
    const view = slots()
    const life = new AbortController()
    let refused = false
    const { authorization } = seam(async interaction => {
      life.abort()
      await interaction.prompt({ kind: 'text', message: 'too late' }).catch(() => { refused = true })
      return 'authorized'
    })
    await runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      signal: life.signal,
      commit: () => {},
    })
    expect(refused).toBe(true)
    // The waiting surface was mounted before the flow withdrew, but the late
    // prompt itself was refused rather than pushed over the next browser view.
    expect(view.pushes()).toBe(1)
    expect(view.mounted()).toBe(false)
  })

  it('commits no later notice', async () => {
    const view = slots()
    const life = new AbortController()
    const committed: string[] = []
    const { authorization } = seam(async interaction => {
      interaction.notify({ message: 'before' })
      life.abort()
      interaction.notify({ message: 'after' })
      return 'authorized'
    })
    await runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      signal: life.signal,
      commit: lines => { committed.push(...lines.map(stripAnsi)) },
    })
    expect(committed.join('\n')).toContain('before')
    expect(committed.join('\n')).not.toContain('after')
  })

  it('never begins an attempt for a browser that has already closed', async () => {
    const view = slots()
    const life = new AbortController()
    life.abort()
    const { authorization, began } = seam(async () => 'authorized')
    expect(await runAuthorization({
      ctx: view.ctx,
      authorization,
      key: 'llm-pi-ai/openai',
      label: 'ChatGPT',
      signal: life.signal,
      commit: () => {},
    })).toEqual({ kind: 'failed', message: 'ChatGPT: sign-in withdrawn' })
    expect(began).toEqual([])
  })
})

/**
 * Let every pending microtask run, so a mounted overlay is on the stack.
 * @returns when the queue has drained.
 */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}
