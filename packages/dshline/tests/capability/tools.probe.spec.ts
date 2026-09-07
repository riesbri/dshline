/**
 * Capability probe: `ctx.tools`, against the real registry.
 *
 * `cards.spec.ts` proves dshline's card rendering with hand-typed definitions,
 * and nothing anywhere instantiates the real `@deepseek-ai/dsh-tools` runtime
 * that `attachment.ts`'s `ctx.tools.get(name, agent)` publishes. This probe
 * follows the seam from a real `ToolDefinition` built by the package's own
 * `defineTool`, through the real `ToolRuntime` lookup, to dshline's `ToolCards`.
 * The call/result inputs are hand-built because execution, Session events, and
 * attachment wiring are outside this probe; a change to the presentation views
 * (`presentCall`/`presentResult`) or lookup contract still fails by capability
 * name.
 *
 * The card assertions are deliberately narrow: dshline's rendering details are
 * `cards.spec.ts`'s business. What is under probe here is registry lookup to
 * ToolCards rendering over the appropriate real contract.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolResultView, ToolCallView } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { stripAnsi } from '@dshline/renderer'
import { ToolCards } from '../../src/cards.ts'
import type { ResultInput } from '../../src/cards.ts'

/** Terminal width the cards draw at; wide enough to keep rows unwrapped. */
const COLUMNS = 80

/** A real definition whose render intents the probe's cards exercise. */
const PROBE_TOOL = defineTool({
  name: 'probe-tool',
  description: 'Compatibility probe for the tool presentation registry.',
  parameters: { path: { type: 'string', required: true, description: 'what to inspect' } },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: () => [{ type: 'text', text: 'probe' }],
  },
  execute: async () => ({ ok: true }),
  // The presenters are the half ToolCards consumes; the generic card would
  // render a definition without them, so they must survive the real registry.
  presentCall: (args: { path?: string }): ToolCallView => ({
    card: 'generic', title: `inspect ${String(args.path)}`, kind: 'read',
  }),
  presentResult: (): ToolResultView => ({
    card: 'generic', title: 'inspected', content: [{ type: 'text', text: 'probe result' }],
  }),
})

describe('capability: tools', () => {
  it('publishes a registered definition through the scoped get the cards call', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    try {
      const dispose = ctx.tools.register(PROBE_TOOL)
      const agent = {}
      // This global registration exercises the lookup contract that an agent
      // scope receives; shadowing/restriction policy is outside this probe.
      expect(ctx.tools.get('probe-tool', agent)?.name).toBe('probe-tool')
      expect(ctx.tools.get('missing', agent)).toBeUndefined()
      dispose()
      expect(ctx.tools.get('probe-tool', agent)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('renders a real definition’s presentation views through dshline’s ToolCards', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    try {
      ctx.tools.register(PROBE_TOOL)
      const agent = {}
      // createScope supplies a real scope key for the registry lookup; this is
      // not a live Agent or an execution path.
      await ctx.plugin(Object.assign((inner: Context) => {
        createScope(inner, agent)
      }, { inject: ['tools'] }))
      const cards = new ToolCards(name => ctx.tools.get(name, agent), '/ws')
      // The event shape the attachment threads in: the harness result content
      // plus the callId that matches it to its pending card.
      const rows = [
        ...cards.call({ callId: 'c1', name: 'probe-tool', arguments: '{"path":"/ws/x"}' }, COLUMNS),
        ...cards.result(
          { callId: 'c1', content: [{ type: 'text', text: 'raw' }], isError: false } satisfies ResultInput,
          COLUMNS,
        ),
      ]
      const drawn = rows.map(stripAnsi)
      // The pending card shows the tool's OWN presentCall title, not the
      // generic fallback of the raw tool name.
      expect(drawn.join('\n')).toContain('inspect /ws/x')
      // The completed card renders the presentResult replacement content —
      // the presenter ran, through the real registry's lookup.
      expect(drawn.join('\n')).toContain('probe result')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
