/**
 * Leading `/name` adjudication, through the real attachment.
 *
 * The same assembled seam `replay-gate.spec.ts` uses — a real cordis
 * `Context`, the real `TuiSlots` registry, a fake window whose draw composes
 * it, and a fake agent recording every dispatch — plus the REAL
 * `@deepseek-ai/dsh-skill` registry behind a provider this spec drives. What
 * is asserted is the order the submit path resolves a command-shaped line in,
 * and that a skill line reaches the Agent exactly as it was typed.
 *
 * A fresh session is attached rather than a resumed one, so no replay gate
 * stands between a keystroke and the decision under test.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context as RealContext } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { stripAnsi, type Key } from '@dshline/renderer'
import { attachSession } from '../src/attachment.ts'
import { TuiSlots } from '../src/slots.ts'
import { pricingFrom } from '../src/usage.ts'
import type { AttachOutcome } from '../src/sessions/reopen.ts'
import type { Window } from '../src/window.ts'

/**
 * One provider candidate with the fields the registry validates.
 * @param name - the skill name.
 * @param over - anything this case varies.
 * @returns a complete candidate.
 */
function candidate(name: string, over: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    name,
    description: `${name} description`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'project-dsh',
    provider: 'spec',
    rank: 100,
    locator: name,
    ...over,
  }
}

/** The assembled attachment, and everything a case needs to drive it. */
interface Fixture {
  readonly press: (key: Key) => void
  readonly submit: (line: string) => Promise<void>
  readonly agent: { followup: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn> }
  readonly commands: { execute: ReturnType<typeof vi.fn> }
  readonly commits: string[][]
  readonly transcript: () => string
  /** The live region as the terminal would show it right now. */
  readonly frame: () => string
  /** The overlay currently owning the keyboard, if any. */
  readonly overlay: () => unknown
  readonly control: () => SkillProviderControl | undefined
  readonly setSkills: (next: () => readonly SkillCandidate[] | never) => void
  readonly stop: () => Promise<void>
}

/** Let queued promises flush without waiting on time. */
async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
}

/**
 * Poll until a condition holds.
 *
 * Condition-polled rather than a fixed number of ticks: the inspector arrives
 * through a dynamic import whose completion is the module loader's schedule,
 * not this suite's — the same reason `plugins-index.spec.ts` waits this way.
 * @param condition - what must become true.
 * @param what - named in the failure, so a timeout says which wait expired.
 * @param attempts - 5ms polls to spend; the default is generous for anything
 *   scheduled, and a case waiting on a real deadline raises it past that.
 */
async function waitUntil(condition: () => boolean, what: string, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) return
    await new Promise<void>(resolve => { setTimeout(resolve, 5) })
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * Assemble one attachment over a real skill registry.
 * @param options - the initial catalog, and which command names are registered.
 * @returns the fixture.
 */
async function fixture(options: {
  readonly skills?: () => readonly SkillCandidate[]
  readonly harnessCommands?: readonly string[]
} = {}): Promise<Fixture> {
  const ctx = new RealContext()
  await ctx.plugin(TuiSlots)
  await ctx.plugin(SkillRegistry)
  let answer = options.skills ?? ((): readonly SkillCandidate[] => [])
  let control: SkillProviderControl | undefined
  await ctx.plugin({
    inject: ['skills'],
    apply: (skillCtx: RealContext) => {
      skillCtx.effect(() => skillCtx.skills.registerProvider(lent => {
        control = lent
        const provider: SkillProvider = {
          name: 'spec',
          list: async () => answer(),
          get: async () => undefined,
        }
        return provider
      }), 'spec provider')
    },
  })
  ctx.provide('tools', { get: () => undefined })
  const registered = (options.harnessCommands ?? []).map(name => ({ name, description: name }))
  const commands = {
    // `undefined` is the registry saying it resolved nothing, which is what
    // hands the line on to the skill catalog.
    execute: vi.fn(async (_agent: unknown, line: string) => {
      const name = /^\/(?<name>[a-z0-9_-]+)/u.exec(line)?.groups?.name
      return registered.some(command => command.name === name) ? { ok: true } : undefined
    }),
    list: () => registered,
  }
  ctx.provide('commands', commands as never)
  ctx.provide('userQuestions', {} as never)

  const commits: string[][] = []
  let frame: string[] = []
  let dispatch: ((key: Key) => void) | undefined
  const compose = (): void => { frame = ctx.tuiSlots.compose(80, 24).lines }
  const window = {
    ctx,
    terminal: { columns: () => 80, rows: () => 24 },
    exit: undefined,
    startup: { cwd: '/ws', task: undefined, resume: undefined },
    pricing: pricingFrom(undefined),
    peakHours: [],
    version: 'test',
    selection: { current: undefined },
    modelInfo: { contextWindow: undefined, reasoning: undefined },
    prefs: { usageMode: 'cost', timing: false, cardDetail: 'compact', reasoningVisible: true },
    colorDepth: 0,
    palette: () => ({}),
    setPalette: () => {},
    themeSettings: {},
    pendingTask: undefined,
    draw: compose,
    paintNow: compose,
    commit: (lines: readonly string[]) => { commits.push([...lines]) },
    clear: () => {},
    refreshModelInfo: () => {},
    setDispatch: (handler: (key: Key) => void) => { dispatch = handler },
    setExit: () => {},
  } as unknown as Window

  const agent = {
    session: { id: 's-1', header: { cwd: '/ws' }, events: [] },
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
  const outcome = {
    target: { kind: 'new' },
    attached: { handle: { agent, dispose: async () => {} }, reopened: false },
  } as unknown as AttachOutcome
  void attachSession(window, outcome)
  await flush()

  const press = (key: Key): void => { dispatch?.(key) }
  return {
    press,
    submit: async line => {
      for (const character of line) press({ kind: 'text', text: character })
      press({ kind: 'key', name: 'enter' })
      await flush()
    },
    agent,
    commands,
    commits,
    transcript: () => commits.flat().map(stripAnsi).join('\n'),
    frame: () => frame.map(stripAnsi).join('\n'),
    overlay: () => ctx.tuiSlots.activeOverlay,
    control: () => control,
    setSkills: next => { answer = next as () => readonly SkillCandidate[] },
    // Deliberately only a flush. The attachment is a loop that never settles,
    // and tearing its context down underneath the work a case just started
    // (a dynamically imported overlay, a refresh the catalog kicked off) makes
    // the fixture, not the code, the thing that fails. Clean disposal of the
    // catalog itself is `skills-catalog.spec.ts`'s subject; each case here
    // owns its own Context and nothing outlives the file.
    stop: async () => { await flush() },
  }
}

/** The text of the one message the agent received. */
function sent(agent: Fixture['agent']): string {
  const message = agent.followup.mock.calls[0]?.[0] as
    { content?: readonly { type: string; text?: string }[]; source?: { kind?: string } } | undefined
  return message?.content?.map(block => block.text ?? '').join('') ?? ''
}

describe('a leading slash that names a skill', () => {
  it('reaches the Agent as an ordinary user message, unchanged', async () => {
    const rig = await fixture({ skills: () => [candidate('review-pr')] })
    await rig.submit('/review-pr inspect PR #126, especially lifecycle cleanup')
    expect(rig.agent.followup).toHaveBeenCalledTimes(1)
    // Verbatim: the trailing instructions survive, and the source stays direct
    // human input — `dsh-tool-skill` is what turns this into an injection.
    expect(sent(rig.agent)).toBe('/review-pr inspect PR #126, especially lifecycle cleanup')
    const message = rig.agent.followup.mock.calls[0]?.[0] as { source: { kind: string } }
    expect(message.source.kind).toBe('user')
    expect(rig.transcript()).not.toContain('unknown command')
    await rig.stop()
  })

  it('reaches the Agent with no argument at all', async () => {
    const rig = await fixture({ skills: () => [candidate('review-pr')] })
    await rig.submit('/review-pr')
    expect(sent(rig.agent)).toBe('/review-pr')
    await rig.stop()
  })

  it('is offered in the live slash menu beside the commands', async () => {
    const rig = await fixture({
      skills: () => [candidate('review-pr', { description: 'Review a pull request' })],
      harnessCommands: ['plan'],
    })
    rig.press({ kind: 'text', text: '/' })
    rig.press({ kind: 'text', text: 'r' })
    await flush()
    expect(rig.frame()).toContain('/review-pr')
    expect(rig.frame()).toContain('skill · Review a pull request')
    await rig.stop()
  })

  it('picks up a skill discovered while the menu is already open', async () => {
    const rig = await fixture({ skills: () => [] })
    rig.press({ kind: 'text', text: '/' })
    rig.press({ kind: 'text', text: 'r' })
    await flush()
    expect(rig.frame()).not.toContain('/refactor-guide')
    rig.setSkills(() => [candidate('refactor-guide')])
    rig.control()?.invalidate()
    await flush()
    expect(rig.frame()).toContain('/refactor-guide')
    await rig.stop()
  })
})

describe('who wins a shared name', () => {
  it('runs the local command, never the skill', async () => {
    // `/skills` is this frontend's own command AND, here, a skill name.
    const rig = await fixture({ skills: () => [candidate('skills')] })
    await rig.submit('/skills')
    await waitUntil(() => rig.overlay() !== undefined, 'the skills inspector to open')
    expect(rig.agent.followup).not.toHaveBeenCalled()
    // The local command opened its own inspector rather than sending anything
    // or reaching the registry.
    expect(rig.commands.execute).not.toHaveBeenCalled()
    expect(rig.overlay()).toBeDefined()
    await rig.stop()
  })

  it('runs the registered Harness command, never the skill', async () => {
    const rig = await fixture({
      skills: () => [candidate('review')],
      harnessCommands: ['review'],
    })
    await rig.submit('/review the diff')
    expect(rig.commands.execute).toHaveBeenCalledTimes(1)
    expect(rig.agent.followup).not.toHaveBeenCalled()
    await rig.stop()
  })
})

describe('what never spends a turn', () => {
  it('says a model-only skill is not a person’s to invoke', async () => {
    const rig = await fixture({
      skills: () => [candidate('architecture', {
        invocation: { modelInvocable: true, userInvocable: false },
      })],
    })
    await rig.submit('/architecture')
    expect(rig.agent.followup).not.toHaveBeenCalled()
    expect(rig.transcript()).toContain('not one a person can invoke directly')
    await rig.stop()
  })

  it('says the same for a skill neither surface may invoke', async () => {
    const rig = await fixture({
      skills: () => [candidate('sealed', {
        invocation: { modelInvocable: false, userInvocable: false },
      })],
    })
    await rig.submit('/sealed')
    expect(rig.agent.followup).not.toHaveBeenCalled()
    expect(rig.transcript()).toContain('not one a person can invoke directly')
    await rig.stop()
  })

  it('keeps the unknown-command protection for a typo', async () => {
    const rig = await fixture({ skills: () => [candidate('review-pr')] })
    await rig.submit('/hlep')
    expect(rig.agent.followup).not.toHaveBeenCalled()
    expect(rig.transcript()).toContain('unknown command: /hlep')
    await rig.stop()
  })

  it('refetches before calling a just-added skill a typo', async () => {
    const rig = await fixture({ skills: () => [] })
    rig.setSkills(() => [candidate('just-added')])
    rig.control()?.invalidate()
    await rig.submit('/just-added now')
    expect(rig.transcript()).not.toContain('unknown command')
    expect(sent(rig.agent)).toBe('/just-added now')
    await rig.stop()
  })

  it('gives up on a provider that never answers, in seconds rather than minutes', async () => {
    const rig = await fixture({ skills: () => [] })
    // Never settles on its own: only the submit path's own deadline ends this
    // wait, and the Composer is already empty while it runs — which is what
    // that deadline is sized by.
    rig.setSkills((() => new Promise<never>(() => {})) as never)
    rig.control()?.invalidate()
    const started = Date.now()
    await rig.submit('/maybe-a-skill')
    await waitUntil(
      () => rig.transcript().includes('could not verify /maybe-a-skill'),
      'the unverifiable notice',
      1_600,
    )
    const waited = Date.now() - started
    expect(rig.agent.followup).not.toHaveBeenCalled()
    expect(rig.transcript()).not.toContain('unknown command')
    // Load-bearing in both directions: a deadline that stopped applying would
    // hang here, and one restored to a command-sized budget would blow the
    // ceiling.
    expect(waited).toBeGreaterThanOrEqual(1_000)
    expect(waited).toBeLessThan(6_000)
    await rig.stop()
  }, 15_000)

  it('neither denies nor sends a name it could not verify', async () => {
    const rig = await fixture({ skills: () => [] })
    rig.setSkills(() => { throw new Error('provider is down') })
    rig.control()?.invalidate()
    await rig.submit('/maybe-a-skill')
    expect(rig.agent.followup).not.toHaveBeenCalled()
    // Named by STATE, not by cause: this case reached it through a rejected
    // provider, and the deadline case above reaches it through a wait that
    // never ended.
    expect(rig.transcript()).toContain('could not verify /maybe-a-skill against the current skill catalog')
    expect(rig.transcript()).not.toContain('unknown command')
    await rig.stop()
  })
})

describe('what dshline does not claim', () => {
  it('leaves a mid-sentence reference entirely to Harness', async () => {
    const rig = await fixture({ skills: () => [candidate('review-pr')] })
    await rig.submit('please /review-pr inspect this')
    // Not a command line at all, so no adjudication happened: the literal goes
    // to the Agent and Harness's own gesture boundary reads it.
    expect(sent(rig.agent)).toBe('please /review-pr inspect this')
    await rig.stop()
  })

  it('leaves a name the command grammar never claimed to Harness', async () => {
    // A digit-leading name is a valid SKILL name and not a command name, so the
    // command parser declines the line and it is sent untouched — exactly the
    // native behavior, with no dshline grammar invented to normalize the two.
    const rig = await fixture({ skills: () => [candidate('7zip-helper')] })
    await rig.submit('/7zip-helper unpack this')
    expect(sent(rig.agent)).toBe('/7zip-helper unpack this')
    expect(rig.transcript()).not.toContain('unknown command')
    await rig.stop()
  })

  it('leaves prose that merely contains a slash alone', async () => {
    const rig = await fixture({ skills: () => [] })
    await rig.submit('/etc/hosts is missing')
    expect(sent(rig.agent)).toBe('/etc/hosts is missing')
    await rig.stop()
  })
})
