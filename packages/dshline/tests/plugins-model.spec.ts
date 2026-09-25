/** Session facts, roster joins, search, and the toggle/switch authority boundary. */

import { describe, expect, it } from 'vitest'
import type { CompositionRow } from '../src/plugins/composition.ts'
import type { AgentPresetRow } from '../src/plugins/harness.ts'
import {
  compositionRowFacts,
  filterCompositionRows,
  filterPresetRows,
  matchesCompositionRow,
  matchesPresetRow,
  presetChoiceDetail,
  presetChoiceLabel,
  presetRows,
  presetSwitchEligibility,
  rowMark,
  selectablePresetRows,
  toggleEligibility,
} from '../src/plugins/model.ts'
import type { PluginsSessionFacts } from '../src/plugins/harness.ts'

/**
 * One composition row, with sensible defaults.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function row(overrides: Partial<CompositionRow> = {}): CompositionRow {
  return {
    locator: { steps: [{ index: 0, name: '@deepseek-ai/dsh-subagent-codex', id: 'tool-subagent-codex' }] },
    path: ['tool-subagent-codex'],
    id: 'tool-subagent-codex',
    name: '@deepseek-ai/dsh-subagent-codex',
    depth: 0,
    group: false,
    disabled: { kind: 'enabled' },
    effective: 'enabled',
    ...overrides,
  }
}

describe('presetRows', () => {
  // No `trust` and no `path`: the adopted roster publishes neither, because a
  // declaration is an ordinary row in a composition and a profile may carry an
  // override of a shipped one. A fixture that re-added them would type-error,
  // which is the point of modelling the real shape here.
  const ROSTER: AgentPresetRow[] = [
    { id: 'standard', name: 'Standard mode', description: 'Full coding agent' },
    { id: 'code', name: 'PTC mode' },
    { id: 'standard-custom', name: 'Standard (custom)' },
    { id: 'broken-one', broken: 'composition is not a list of entries' },
  ]

  it('preserves roster order without re-ranking', () => {
    const rows = presetRows(ROSTER, 'code', 'standard')
    expect(rows.map(r => r.id)).toEqual(['standard', 'code', 'standard-custom', 'broken-one'])
  })

  it('marks exactly the session-resolved preset as current', () => {
    const rows = presetRows(ROSTER, 'standard-custom', 'standard')
    expect(rows.find(r => r.isCurrent)?.id).toBe('standard-custom')
    expect(rows.filter(r => r.isCurrent)).toHaveLength(1)
  })

  it('marks exactly the default id as default, independent of current', () => {
    const rows = presetRows(ROSTER, 'code', 'standard')
    expect(rows.find(r => r.isDefault)?.id).toBe('standard')
    expect(rows.find(r => r.id === 'code')?.isDefault).toBe(false)
  })

  it('falls back to id for name and carries broken through untouched', () => {
    const rows = presetRows(ROSTER, undefined, 'standard')
    const broken = rows.find(r => r.id === 'broken-one')
    expect(broken?.name).toBe('broken-one')
    expect(broken?.broken).toBe('composition is not a list of entries')
  })

  it('reports no current row when the session preset resolves to nothing in the roster', () => {
    const rows = presetRows(ROSTER, 'deleted-preset', 'standard')
    expect(rows.some(r => r.isCurrent)).toBe(false)
  })
})

describe('search: composition rows', () => {
  const ROWS = [
    row({ path: ['tool-bash'], id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' }),
    row({ path: ['tool-fs'], id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }),
    row({
      path: ['delegation', 'tool-subagent-codex'],
      id: 'tool-subagent-codex',
      name: '@deepseek-ai/dsh-subagent-codex',
      depth: 1,
    }),
    row({
      path: ['tool-workflow'],
      id: 'tool-workflow',
      name: '@deepseek-ai/dsh-tool-workflow',
    }),
  ]

  it('matches by row id, case-insensitively', () => {
    const codex = ROWS[2]
    if (codex === undefined) throw new Error('expected a codex row')
    expect(matchesCompositionRow(codex, 'CODEX')).toBe(true)
    expect(filterCompositionRows(ROWS, 'codex').map(r => r.id)).toEqual(['tool-subagent-codex'])
  })

  it('matches by package/module name', () => {
    expect(filterCompositionRows(ROWS, 'subagent').map(r => r.id)).toEqual(['tool-subagent-codex'])
  })

  it('matches "workflow" and "bash" as the spec examples require', () => {
    expect(filterCompositionRows(ROWS, 'workflow').map(r => r.id)).toEqual(['tool-workflow'])
    expect(filterCompositionRows(ROWS, 'bash').map(r => r.id)).toEqual(['tool-bash'])
  })

  it('returns every row, in order, for an empty query', () => {
    expect(filterCompositionRows(ROWS, '')).toEqual(ROWS)
  })

  it('returns nothing for a query matching no row', () => {
    expect(filterCompositionRows(ROWS, 'nonexistent')).toEqual([])
  })

  it('still matches an id-less row by name alone', () => {
    const idless = row({
      locator: { steps: [{ index: 5, name: '@deepseek-ai/dsh-tool-workflow', id: undefined }] },
      path: ['@deepseek-ai/dsh-tool-workflow'],
      id: undefined,
      name: '@deepseek-ai/dsh-tool-workflow',
    })
    expect(matchesCompositionRow(idless, 'workflow')).toBe(true)
    expect(filterCompositionRows([...ROWS, idless], 'workflow').map(r => r.name)).toContain(
      '@deepseek-ai/dsh-tool-workflow',
    )
  })
})

describe('search: preset rows', () => {
  const ROWS = presetRows(
    [
      { id: 'standard', name: 'Standard mode' },
      { id: 'cordis', name: 'Creator mode' },
    ],
    undefined,
    'standard',
  )

  it('matches by id or display name', () => {
    expect(filterPresetRows(ROWS, 'creator').map(r => r.id)).toEqual(['cordis'])
    expect(filterPresetRows(ROWS, 'cordis').map(r => r.id)).toEqual(['cordis'])
  })
})

describe('rowMark / compositionRowFacts', () => {
  it('marks an enabled row filled, a disabled row hollow, a conditional row half', () => {
    expect(rowMark(row({ disabled: { kind: 'enabled' } }))).toBe('●')
    expect(rowMark(row({ disabled: { kind: 'disabled' } }))).toBe('○')
    expect(rowMark(row({ disabled: { kind: 'conditional', expression: 'x' } }))).toBe('◐')
  })

  it('shows own state honestly even when a parent group disables it, and names the discrepancy', () => {
    const inherited = row({ disabled: { kind: 'enabled' }, effective: 'disabled' })
    expect(rowMark(inherited)).toBe('●')
    expect(compositionRowFacts(inherited)).toContain('off via parent group')
  })

  it('surfaces the raw condition expression as a fact', () => {
    const conditional = row({ disabled: { kind: 'conditional', expression: "process.platform === 'win32'" } })
    expect(compositionRowFacts(conditional)).toContain("condition: process.platform === 'win32'")
  })

  it('includes the config summary when present', () => {
    expect(compositionRowFacts(row({ configSummary: 'provider=codex' }))).toContain('provider=codex')
  })
})

describe('toggleEligibility: the configuration editor boundary', () => {
  // The only question left is whether this profile mounts the editor at all.
  // There is no ownership check any more: a shipped declaration is edited by
  // writing a profile-layer override through `ctx.configEditor`, so there is no
  // row in this roster this frontend must refuse to edit on account of where it
  // came from.
  it('offers a plain toggle for a leaf row where this profile can persist an edit', () => {
    const result = toggleEligibility(row({ disabled: { kind: 'enabled' } }), true)
    expect(result).toEqual({ kind: 'toggle', enable: false })
  })

  it('computes enable correctly from the current disabled state', () => {
    const result = toggleEligibility(row({ disabled: { kind: 'disabled' } }), true)
    expect(result).toEqual({ kind: 'toggle', enable: true })
  })

  it('offers the same toggle for a row whose own field is enabled but whose group is off', () => {
    // The row's own field is what space flips, and the mark beside the row
    // reports that same field; `effective` is drawn beside it as a fact. Reading
    // the effective state here would offer a write the row's own mark contradicts.
    const inherited = row({ disabled: { kind: 'enabled' }, effective: 'disabled' })
    expect(toggleEligibility(inherited, true)).toEqual({ kind: 'toggle', enable: false })
  })

  it('refuses a conditional row, naming the expression rather than evaluating it', () => {
    const result = toggleEligibility(
      row({ disabled: { kind: 'conditional', expression: "process.platform === 'win32'" } }),
      true,
    )
    expect(result).toEqual({ kind: 'conditional', expression: "process.platform === 'win32'" })
  })

  it('answers conditional even where no edit could land anyway, because that check runs first', () => {
    // A `!!js` row is not togglable whatever else is true of it, so the ordering
    // is what keeps a reader from being sent through a keypress that was always
    // going to be refused — and refused for the more specific reason.
    const result = toggleEligibility(
      row({ disabled: { kind: 'conditional', expression: 'process.env.DELEGATION === "off"' } }),
      false,
    )
    expect(result.kind).toBe('conditional')
  })

  it('reports unavailable when this profile mounts no configuration editor', () => {
    const result = toggleEligibility(row(), false)
    expect(result).toEqual({ kind: 'unavailable', reason: 'this profile mounts no configuration editor' })
  })

  it('reports unavailable for a group row, which has no single on/off state', () => {
    expect(toggleEligibility(row({ group: true }), true)).toEqual({
      kind: 'unavailable',
      reason: 'a group row has no single on/off state to toggle',
    })
    // A group is refused even when it is itself conditional: the group answer is
    // about the row, the conditional answer is about its field, and the first
    // is the more fundamental of the two.
    expect(toggleEligibility(row({ group: true, disabled: { kind: 'conditional', expression: 'x' } }), true).kind)
      .toBe('unavailable')
  })
})

describe('selectablePresetRows: what the picker may offer', () => {
  const ROWS = presetRows(
    [
      { id: 'standard', name: 'Standard mode' },
      { id: 'code', name: 'PTC mode' },
      { id: 'broken-one', broken: 'composition is not a list of entries' },
    ],
    'standard',
    'code',
  )

  it('drops the broken declaration and keeps the rest in roster order', () => {
    expect(selectablePresetRows(ROWS).map(row => row.id)).toEqual(['standard', 'code'])
  })

  it('keeps a broken declaration out of what can be chosen while leaving it in the roster', () => {
    // Two different answers on purpose: the browser still shows the broken one
    // when it is the preset being browsed, because a declaration that cannot
    // mount is the one a reader most needs to see in order to fix it.
    expect(ROWS.map(row => row.id)).toContain('broken-one')
  })
})

describe('presetChoiceLabel / presetChoiceDetail: the picker lines', () => {
  it('names the preset, its id, and only the current/default tags', () => {
    const [current] = presetRows([{ id: 'standard', name: 'Standard mode' }], 'standard', 'standard')
    if (current === undefined) throw new Error('expected a row')
    expect(presetChoiceLabel(current)).toBe('Standard mode  standard · current · default')
  })

  it('carries no built-in-vs-custom tag, because the roster reports no such distinction', () => {
    // The previous generation classified a preset as shipped or profile
    // authored and tagged the line with it. A shipped declaration here is
    // exactly a row that happens to be the default, and the whole line is one
    // exact string — which is what keeps a tag from creeping back in beside the
    // two real ones.
    const [shipped] = presetRows([{ id: 'standard', name: 'Standard mode' }], undefined, 'standard')
    if (shipped === undefined) throw new Error('expected a row')
    expect(presetChoiceLabel(shipped)).toBe('Standard mode  standard · default')
  })

  it('leaves out both tags for a preset that is neither current nor default', () => {
    const row = presetRows([{ id: 'code', name: 'PTC mode' }], 'standard', 'standard')[0]
    if (row === undefined) throw new Error('expected a row')
    expect(presetChoiceLabel(row)).toBe('PTC mode  code')
  })

  it('is the description, and undefined when the declaration published none', () => {
    const [described, undescribed] = presetRows(
      [
        { id: 'standard', description: 'Full coding agent' },
        { id: 'code' },
      ],
      undefined,
      'standard',
    )
    if (described === undefined || undescribed === undefined) throw new Error('expected two rows')
    expect(presetChoiceDetail(described)).toBe('Full coding agent')
    expect(presetChoiceDetail(undescribed)).toBeUndefined()
  })
})

describe('presetSwitchEligibility: what the picker may OFFER', () => {
  it('offers a switch while the turnBoundary projection reports no turn', () => {
    const session: PluginsSessionFacts = { presetId: 'standard', started: false }
    expect(presetSwitchEligibility(session)).toEqual({ kind: 'recompose' })
  })

  it('redirects a started session to the default for the next one instead', () => {
    const session: PluginsSessionFacts = { presetId: 'standard', started: true }
    const result = presetSwitchEligibility(session)
    expect(result.kind).toBe('locked')
    if (result.kind !== 'locked') return
    expect(result.message).toContain('default for the next session')
  })
})
