/**
 * `mountAgentPreset`: composing an agent from its resolved Harness preset.
 *
 * A consumer-level test that `attachOptions`'s new setup step actually does
 * what dshline's own `cordis.patch.yml` now assumes: a fresh session gets
 * the roster's default, a resumed one gets whatever its own log recorded,
 * a session from before this frontend adopted presets resumes under
 * `standard` rather than today's arbitrary default, and a profile mounting
 * no preset roster is left a no-op.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { stripAnsi } from '@dshline/renderer'
import { createWindowExitRequest, mountAgentPreset, routeWindowKey } from '../src/window.ts'
import type { AgentPresetRow, AgentPresetsSeam } from '../src/plugins/harness.ts'

/** One fake roster preset. */
function preset(id: string, overrides: Partial<AgentPresetRow> = {}): AgentPresetRow {
  return { id, trust: 'system', path: `/presets/${id}/agent.cordis.yml`, ...overrides }
}

/**
 * A fake `agentPresets` seam recording every `mount` call.
 * @param defaultId - what `defaultId` reports.
 * @returns the seam, and the ids it was asked to mount, in order.
 */
function fakeAgentPresets(
  defaultId: string,
  overrides: Partial<AgentPresetsSeam> = {},
): { seam: AgentPresetsSeam; mounted: string[] } {
  const mounted: string[] = []
  const seam: AgentPresetsSeam = {
    get defaultId() { return defaultId },
    authorable: true,
    list: async () => [preset('standard'), preset('code'), preset('minimal'), preset('cordis')],
    resolve: async id => preset(id ?? defaultId),
    composedPreset: () => undefined,
    mount: async (_agentCtx, id) => {
      mounted.push(id ?? defaultId)
      return preset(id ?? defaultId)
    },
    recompose: async (_agentCtx, id) => preset(id),
    select: async (_agent, id) => id,
    read: async () => '',
    copy: async () => {},
    ...overrides,
  }
  return { seam, mounted }
}

/** A roster with no `standard` at all — a deployment shipping its own presets. */
function withoutStandard(defaultId: string): { seam: AgentPresetsSeam; mounted: string[] } {
  return fakeAgentPresets(defaultId, {
    list: async () => [preset('house-style'), preset('house-minimal')],
    resolve: async id => {
      if ((id ?? defaultId) === 'standard') throw new Error('agent-presets: preset "standard" not found (available: house-style)')
      return preset(id ?? defaultId)
    },
  })
}

/** A roster whose `standard` exists but cannot be mounted. */
function withBrokenStandard(defaultId: string): { seam: AgentPresetsSeam; mounted: string[] } {
  return fakeAgentPresets(defaultId, {
    resolve: async id => ((id ?? defaultId) === 'standard'
      ? preset('standard', { broken: 'the composition is not valid YAML' })
      : preset(id ?? defaultId)),
  })
}

/** What one session's Harness projections report to the resume path. */
interface Facts {
  /** What the `agentPreset` projection folded out of header and selections. */
  readonly presetId?: string
  /** What the `turnBoundary` projection reports about turns. */
  readonly started?: boolean
}

/**
 * The two arguments Harness hands `setup`: a fake unpublished agent's own scope
 * context, and the unpublished Agent itself over a real detached Session.
 *
 * Returned as a pair to be spread into {@link mountAgentPreset}, because the
 * adopted generation passes the Agent EXPLICITLY — there is no `Context.agent`
 * for a fixture to install, and a test that reached for one would be exercising
 * an association Harness removed. Both are always present: `setup` has no
 * supported call without an Agent, so no fixture here manufactures one.
 *
 * The session facts are the two Harness projections, not a hand-folded log:
 * `agentPreset` already folds the creation header with every later
 * `agent-preset/selected`, so a test states the folded answer directly and
 * `mountAgentPreset` is exercised against the same authority `/plugins` reads.
 * @param agentPresets - the seam `ctx.get('agentPresets')` answers with.
 * @param facts - what the projections report for this agent's session.
 * @returns the `setup` arguments, in order.
 */
function composing(
  agentPresets: AgentPresetsSeam | undefined,
  facts: Facts,
): [Context, { readonly session: Session }] {
  const session = Session.create(SessionId('window-spec'))
  const projections = {
    stateOf: (target: Session, key: 'agentPreset' | 'turnBoundary'): unknown => {
      if (target !== session) return undefined
      if (key === 'agentPreset') return facts.presetId ?? null
      return {
        openTurnStartSeq: null,
        lastStepStartSeq: null,
        lastStepBoundary: null,
        lastTurn: facts.started === true ? 1 : 0,
      }
    },
  }
  const agentCtx = {
    get: (name: string) => {
      if (name === 'agentPresets') return agentPresets
      if (name === 'sessionProjections') return projections
      return undefined
    },
  } as unknown as Context
  return [agentCtx, { session }]
}

describe('global window key routing', () => {
  it('delegates the first ctrl-d to the attachment, then ignores later global quits', () => {
    const appExit = vi.fn()
    const attachmentExit = vi.fn()
    let installedAttachmentExit: (() => void) | undefined = attachmentExit
    const requestExit = createWindowExitRequest(appExit, () => installedAttachmentExit)
    const dispatch = vi.fn()

    routeWindowKey({ kind: 'key', name: 'ctrl-d' }, requestExit, dispatch)
    installedAttachmentExit = undefined
    routeWindowKey({ kind: 'key', name: 'ctrl-d' }, requestExit, dispatch)

    expect(attachmentExit).toHaveBeenCalledOnce()
    expect(appExit).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('requests launcher exit only once when no attachment exists', () => {
    const appExit = vi.fn()
    const requestExit = createWindowExitRequest(appExit, () => undefined)

    routeWindowKey({ kind: 'key', name: 'ctrl-d' }, requestExit, undefined)
    routeWindowKey({ kind: 'key', name: 'ctrl-d' }, requestExit, undefined)

    expect(appExit).toHaveBeenCalledOnce()
    expect(appExit).toHaveBeenCalledWith(0)
  })

  it('dispatches ordinary keys normally before the first quit request', () => {
    const dispatch = vi.fn()
    const requestExit = createWindowExitRequest(vi.fn(), () => undefined)

    routeWindowKey({ kind: 'text', text: 'x' }, requestExit, dispatch)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith({ kind: 'text', text: 'x' })
  })
})

describe('mountAgentPreset', () => {
  it('mounts the roster default for a fresh session with nothing recorded yet', async () => {
    const { seam, mounted } = fakeAgentPresets('standard')
    await mountAgentPreset(...composing(seam, {}))
    expect(mounted).toEqual(['standard'])
  })

  it('resumes under the preset the projection reports, not today\'s default', async () => {
    const { seam, mounted } = fakeAgentPresets('code')
    // Created under `standard` back when that was the default; `code` is the
    // default NOW, but this session must stay on what it was created with.
    await mountAgentPreset(...composing(seam, { presetId: 'standard' }))
    expect(mounted).toEqual(['standard'])
  })

  it('resumes under a later logged selection, as the agentPreset projection folds it', async () => {
    const { seam, mounted } = fakeAgentPresets('standard')
    await mountAgentPreset(...composing(seam, { presetId: 'standard-custom' }))
    expect(mounted).toEqual(['standard-custom'])
  })

  it('migration: a produced old session with no recorded preset resumes under standard, not today\'s minimal default', async () => {
    const { seam, mounted } = fakeAgentPresets('minimal')
    // Predates preset stamping entirely: no header.agentPreset, no
    // agent-preset/selected event — but a real turn was produced, so this
    // is history, not a blank session that can safely take today's default.
    await mountAgentPreset(...composing(seam, { started: true }))
    expect(mounted).toEqual(['standard'])
  })

  it('migration: a produced old session resumes under standard even when today\'s default is a custom preset', async () => {
    const { seam, mounted } = fakeAgentPresets('standard-custom')
    await mountAgentPreset(...composing(seam, { started: true }))
    expect(mounted).toEqual(['standard'])
  })

  it('migration: a recorded preset always wins over the legacy fallback, old session or new', async () => {
    const { seam, mounted } = fakeAgentPresets('minimal')
    await mountAgentPreset(...composing(seam, { presetId: 'code', started: true }))
    expect(mounted).toEqual(['code'])
  })

  it('migration: a blank session with no recorded preset still gets today\'s default, not the legacy fallback', async () => {
    const { seam, mounted } = fakeAgentPresets('minimal')
    // No turn produced yet — this is an ordinary new/blank session (the
    // pre-create-stamping defensive path from the earlier test above, or a
    // session created by something that never stamped meta.agentPreset),
    // not a historical one, so today's default is the honest answer.
    await mountAgentPreset(...composing(seam, {}))
    expect(mounted).toEqual(['minimal'])
  })

  it('is a no-op when no agentPresets seam is mounted', async () => {
    const calls: string[] = []
    const ctx = {
      get: (name: string) => { calls.push(name); return undefined },
    } as unknown as Context
    const agent = { session: Session.create(SessionId('window-spec-no-seam')) }
    await expect(mountAgentPreset(ctx, agent)).resolves.toBeUndefined()
    expect(calls).toContain('agentPresets')
  })
})

describe('mountAgentPreset: a legacy session on a deployment without a usable "standard"', () => {
  it('falls back to the roster default and says the substitution happened', async () => {
    const { seam, mounted } = withoutStandard('house-style')
    const reported: string[] = []
    await mountAgentPreset(
      ...composing(seam, { started: true }),
      lines => { reported.push(...lines) },
    )
    // Hard-failing here would make every pre-preset transcript unopenable on
    // a deployment that ships its own roster — protecting a composition
    // record by withholding the transcript it belongs to.
    expect(mounted).toEqual(['house-style'])
    const said = stripAnsi(reported.join('\n'))
    expect(said).toContain('predates agent presets')
    expect(said).toContain('house-style')
    expect(said).toContain('may differ')
  })

  it('treats a broken "standard" the same as a missing one', async () => {
    // `resolve()` deliberately succeeds for a broken preset — the roster
    // still needs a row to show and delete — so presence is not usability,
    // and `mount` would reject it exactly as it rejects an unknown id.
    const { seam, mounted } = withBrokenStandard('code')
    const reported: string[] = []
    await mountAgentPreset(
      ...composing(seam, { started: true }),
      lines => { reported.push(...lines) },
    )
    expect(mounted).toEqual(['code'])
    expect(stripAnsi(reported.join('\n'))).toContain('no usable "standard" preset is installed')
  })

  it('says nothing, and still prefers standard, when the deployment does ship one', async () => {
    const { seam, mounted } = fakeAgentPresets('minimal')
    const reported: string[] = []
    await mountAgentPreset(
      ...composing(seam, { started: true }),
      lines => { reported.push(...lines) },
    )
    expect(mounted).toEqual(['standard'])
    expect(reported).toEqual([])
  })

  it('never reports for a session that recorded its own preset, even a missing one', async () => {
    // A recorded id is the session's own fact; if it no longer resolves, that
    // is `mount`'s refusal to explain, not a substitution to narrate.
    const { seam, mounted } = withoutStandard('house-style')
    const reported: string[] = []
    await mountAgentPreset(
      ...composing(seam, { presetId: 'standard', started: true }),
      lines => { reported.push(...lines) },
    )
    expect(mounted).toEqual(['standard'])
    expect(reported).toEqual([])
  })

  it('fails the resume without claiming it resumed, when the fallback will not mount either', async () => {
    // No usable `standard`, and the deployment's own default is broken too.
    // `mount` rejecting rolls the whole resume back per `setup`'s contract, so
    // a caveat emitted before it would sit in the transcript of a session that
    // never ran under the preset it names.
    const { seam, mounted } = fakeAgentPresets('house-style', {
      list: async () => [preset('house-style', { broken: 'the composition is not valid YAML' })],
      resolve: async id => {
        if ((id ?? 'house-style') === 'standard') throw new Error('agent-presets: preset "standard" not found (available: house-style)')
        return preset('house-style', { broken: 'the composition is not valid YAML' })
      },
      mount: async (_agentCtx, id) => {
        throw new Error(`agent-presets: preset "${String(id)}" failed to mount: the composition is not valid YAML`)
      },
    })
    const reported: string[] = []
    await expect(mountAgentPreset(
      ...composing(seam, { started: true }),
      lines => { reported.push(...lines) },
    )).rejects.toThrow('failed to mount')
    expect(mounted).toEqual([])
    expect(reported).toEqual([])
  })

  it('does not consult the legacy path at all for a blank session', async () => {
    const { seam, mounted } = withoutStandard('house-style')
    const reported: string[] = []
    await mountAgentPreset(
      ...composing(seam, {}),
      lines => { reported.push(...lines) },
    )
    expect(mounted).toEqual(['house-style'])
    expect(reported).toEqual([])
  })
})
