/**
 * Capability probe: Harness skills, against the real seams.
 *
 * The compatibility evidence `tools/capability-probes.mjs` names for the
 * `skills` seam. dshline neither discovers nor loads a skill: it OBSERVES the
 * effective catalog through `ctx.skills.snapshot(...)` and sends a literal
 * `/name …` user message that `dsh-tool-skill` turns into an injection. So
 * this probe mounts the real `SkillRegistry` and the real `dsh-tool-skill`
 * consumer and asserts exactly the properties that consumption rests on:
 *
 * - the registry is scope-aware, and `scope` selects an agent's own layers;
 * - `snapshot()` reports `complete`, distinguishing an empty agent from
 *   unfinished discovery;
 * - every summary carries both invocation controls;
 * - `skills/change` is emitted as an unfiltered invalidation;
 * - the exact message shape dshline's submit path builds is what the
 *   pre-step boundary recognizes as a user-explicit invocation.
 *
 * A filesystem provider is deliberately not mounted: where skill FILES live is
 * not part of the contract dshline consumes, and `ctx.skills.register()` plus
 * an ordinary provider exercise the same registry paths.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
// `dsh-tools` requires it; the `skill` tool cannot register without it.
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'

/** The workspace every lookup below is made for. */
const CWD = '/work/project'

/**
 * One provider candidate carrying every field the registry validates.
 * @param name - the skill name.
 * @param over - anything a case varies.
 * @returns the candidate.
 */
function candidate(name: string, over: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    name,
    description: `${name} description`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'project-dsh',
    provider: 'probe',
    rank: 100,
    locator: name,
    ...over,
  }
}

/** A provider plugin whose discovery one case drives. */
function providerPlugin(
  name: string,
  list: () => ReturnType<SkillProvider['list']> | ReturnType<SkillProvider['list']> extends never ? never : Awaited<ReturnType<SkillProvider['list']>>,
  captured?: (control: SkillProviderControl) => void,
): { inject: string[]; apply: (ctx: Context) => void } {
  return {
    inject: ['skills'],
    apply: ctx => {
      ctx.effect(() => ctx.skills.registerProvider(control => {
        captured?.(control)
        return {
          name,
          list: async () => await list(),
          get: async candidateIn => ({ ...candidateIn, content: `body of ${candidateIn.name}` }),
        }
      }), `probe provider ${name}`)
    },
  }
}

/**
 * An Agent-shaped viewing scope with the one field lookups read.
 * @param cwd - the session workspace.
 * @returns an agent usable as both scope key and pre-step subject.
 */
function agentFor(cwd: string): Agent {
  const id = SessionId(`probe-${cwd}`)
  // A FRESH ROOT: no seed at all, so no inherited prefix and no
  // `session/end-seed` marker. `isSeeded` is lineage, not "was history
  // supplied" — this session has neither.
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  return {
    ctx: new Context(),
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('the step boundary must not use agent.inject()') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: async () => {},
  } as unknown as Agent
}

describe('capability: skills · registry', () => {
  it('selects layers by the viewing scope, so an agent sees its own composition', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(providerPlugin('host', () => [candidate('host-skill', { provider: 'host' })]))
    const agent = {}
    const scope = createScope(ctx, agent)
    await scope.ctx.plugin(providerPlugin('preset', () => [candidate('preset-skill', { provider: 'preset' })]))
    try {
      const scoped = await ctx.skills.snapshot({ cwd: CWD, scope: agent })
      const global = await ctx.skills.snapshot({ cwd: CWD })
      expect(scoped.skills.map(skill => skill.name)).toEqual(['host-skill', 'preset-skill'])
      // The property dshline depends on: dropping `scope` hides everything an
      // agent preset's own standing composition contributes.
      expect(global.skills.map(skill => skill.name)).toEqual(['host-skill'])
    } finally {
      await scope.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('reports discovery completeness, and never caches an incomplete answer', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let complete = false
    let asked = 0
    await ctx.plugin(providerPlugin('probe', () => {
      asked += 1
      return complete
        ? [candidate('review-pr')]
        : { candidates: [candidate('review-pr')], complete: false }
    }))
    try {
      const first = await ctx.skills.snapshot({ cwd: CWD })
      // Usable candidates AND an explicit "this is not authoritative": the
      // exact distinction the last-good rule rests on.
      expect(first).toMatchObject({ complete: false })
      expect(first.skills.map(skill => skill.name)).toEqual(['review-pr'])
      await ctx.skills.snapshot({ cwd: CWD })
      expect(asked, 'an incomplete observation must not be cached').toBe(2)
      complete = true
      await expect(ctx.skills.snapshot({ cwd: CWD })).resolves.toMatchObject({ complete: true })
      // A complete observation IS cached, which is why a consumer refetches on
      // the registry's own invalidation rather than on a timer.
      await ctx.skills.snapshot({ cwd: CWD })
      expect(asked).toBe(3)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a rejected provider as an incomplete observation rather than an empty agent', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(providerPlugin('probe', () => { throw new Error('provider is down') }))
    try {
      const observed = await ctx.skills.snapshot({ cwd: CWD })
      expect(observed).toEqual({ skills: [], complete: false })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries both invocation controls on every summary', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(providerPlugin('probe', () => [
      candidate('both'),
      candidate('user-only', { invocation: { modelInvocable: false, userInvocable: true } }),
      candidate('model-only', { invocation: { modelInvocable: true, userInvocable: false } }),
      candidate('neither', { invocation: { modelInvocable: false, userInvocable: false } }),
    ]))
    try {
      const observed = await ctx.skills.snapshot({ cwd: CWD })
      expect(observed.skills.map(skill => [skill.name, skill.invocation])).toEqual([
        ['both', { modelInvocable: true, userInvocable: true }],
        ['model-only', { modelInvocable: true, userInvocable: false }],
        ['neither', { modelInvocable: false, userInvocable: false }],
        ['user-only', { modelInvocable: false, userInvocable: true }],
      ])
      // The source bucket is prompt-visible metadata dshline normalizes for
      // presentation; it must keep arriving on the summary.
      expect(observed.skills[0]?.source).toBe('project-dsh')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('emits skills/change as an unfiltered invalidation with no diff', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let control: SkillProviderControl | undefined
    await ctx.plugin(providerPlugin('probe', () => [candidate('one')], lent => { control = lent }))
    const seen: unknown[][] = []
    const off = ctx.on('skills/change', (...payload: unknown[]) => { seen.push(payload) })
    try {
      await ctx.skills.snapshot({ cwd: CWD })
      control?.invalidate()
      expect(seen).toEqual([[]])
    } finally {
      off()
      await ctx.fiber.dispose()
    }
  })
})

describe('capability: skills · the human /name gesture', () => {
  /**
   * Mount the registry, the model-facing consumer, and two runtime skills.
   * @returns the context and an agent for the workspace.
   */
  async function consumer(): Promise<{ ctx: Context; agent: Agent }> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(toolSkill)
    ctx.skills.register({
      name: 'review-pr',
      description: 'Review a pull request',
      content: 'Check for regressions and missing tests.',
      source: 'project-dsh',
    })
    ctx.skills.register({
      name: 'architecture',
      description: 'Architecture decision guidance',
      content: 'Model-only guidance.',
      source: 'project-dsh',
      invocation: { modelInvocable: true, userInvocable: false },
    })
    return { ctx, agent: agentFor(CWD) }
  }

  /**
   * Offer one claimed batch to the pre-step boundary, exactly as an Agent does.
   * @param ctx - the mounted context.
   * @param agent - the agent whose scope and cwd select the catalog.
   * @param messages - the claimed user messages.
   * @returns the boundary's decision.
   */
  async function proposeStep(
    ctx: Context,
    agent: Agent,
    messages: UserMessage[],
  ): Promise<PreStepDecision> {
    return await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter' as const, messages }),
    )
  }

  /** The exact message dshline's submit path builds for a typed line. */
  function typed(text: string): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  it('turns the literal dshline sends into a skill-invocation injection', async () => {
    const { ctx, agent } = await consumer()
    try {
      const decision = await proposeStep(ctx, agent, [
        typed('/review-pr inspect PR #126, especially lifecycle cleanup'),
      ])
      if (decision.kind !== 'enter') throw new Error('expected enter')
      const injected = decision.messages.find(message =>
        (message.source as { kind?: string }).kind === 'skill-invocation')
      expect(injected?.source).toMatchObject({
        kind: 'skill-invocation', name: 'review-pr', form: 'instructions',
      })
      const block = injected?.content[0]
      if (block?.type !== 'text') throw new Error('expected a text injection')
      expect(block.text).toContain('<skill_content name="review-pr">')
      expect(block.text).toContain('Check for regressions and missing tests.')
      // The human's own words ride their own direct message, untouched — which
      // is what keeps the transcript showing what the reader typed.
      const original = decision.messages[0]
      expect((original?.source as { kind?: string }).kind).toBe('user')
      expect(original?.content[0]).toMatchObject({
        text: '/review-pr inspect PR #126, especially lifecycle cleanup',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves a name no person may invoke as ordinary prose', async () => {
    const { ctx, agent } = await consumer()
    try {
      const decision = await proposeStep(ctx, agent, [typed('/architecture please')])
      if (decision.kind !== 'enter') throw new Error('expected enter')
      expect(decision.messages.some(message =>
        (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('owns the mid-sentence gesture dshline deliberately never claims', async () => {
    const { ctx, agent } = await consumer()
    try {
      const decision = await proposeStep(ctx, agent, [typed('please use /review-pr on this')])
      if (decision.kind !== 'enter') throw new Error('expected enter')
      expect(decision.messages.some(message =>
        (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
