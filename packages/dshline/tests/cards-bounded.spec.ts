import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalResultView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { box, BOX_CHROME_COLUMNS, escapeControls, paint, truncateToWidth } from '@dshline/renderer'
import { ToolCards } from '../src/cards.ts'
import type { CardDetail, ResultInput } from '../src/cards.ts'

vi.mock('@dshline/renderer', async importOriginal => {
  const original = await importOriginal<typeof import('@dshline/renderer')>()
  return { ...original, escapeControls: vi.fn(original.escapeControls) }
})

// The oracle must not contribute to the instrumentation of production escaping.
const { escapeControls: legacyEscape } = await vi.importActual<typeof import('@dshline/renderer')>('@dshline/renderer')

/** Mirror the public detail budgets, not the implementation's selection helpers. */
const BUDGET = { compact: 6, full: 200, hidden: 0, inspect: 5000 } as const
type Detail = CardDetail | 'inspect'
type Kind = 'raw' | 'terminal'

function marker(detail: Detail, core: string): string {
  return detail === 'inspect' ? core : `${core} · ctrl+o view`
}

// Deliberately retain the old whole-text escape/split order: this is an independent
// compatibility oracle, not a second copy of the bounded line-selection algorithm.
function legacyBody(text: string, columns: number, detail: Detail, isError = false, budget: number = BUDGET[detail]): string[] {
  const trimmed = text.trim()
  if (trimmed === '' || detail === 'hidden') return []
  const all = legacyEscape(trimmed).split('\n')
  const shown = all.slice(0, budget)
  const rows = shown.map((row, index) => `${index === 0 ? `  ${paint('⎿', 'chrome')} ` : '    '}${truncateToWidth(paint(row, isError ? 'error' : 'subdued'), columns - 4)}`)
  if (all.length > shown.length) rows.push(`    ${paint(marker(detail, `… ${String(all.length - shown.length)} more lines`), 'muted')}`)
  return rows
}

function legacyTerminal(view: TerminalResultView, columns: number, detail: Detail): string[] {
  const status = view.signal !== undefined
    ? paint(`killed by ${legacyEscape(view.signal)}`, 'error')
    : view.exitCode === undefined || view.exitCode === 0
      ? undefined
      : paint(`exit ${String(view.exitCode)}`, 'error')
  const output = view.output ?? ''
  if (detail === 'hidden') return status === undefined ? [] : [`  ${status}`]
  if (output.trim() === '') return [`  ${status ?? paint('no output', 'muted')}`]
  const all = legacyEscape(output.replace(/\n$/u, '')).split('\n')
  const shown = all.slice(-BUDGET[detail])
  const width = Math.max(BOX_CHROME_COLUMNS + 8, Math.min(columns - 2, 100))
  const rows = shown.map(row => truncateToWidth(paint(row, 'subdued'), width - BOX_CHROME_COLUMNS))
  if (all.length > shown.length) rows.unshift(paint(marker(detail, `… ${String(all.length - shown.length)} earlier lines`), 'muted'))
  return box(rows, {
    width,
    ...status === undefined ? {} : { title: status },
    border: text => paint(text, 'chrome'),
  }).map(row => `  ${row}`)
}

function fixture(kind: Kind, text: string, detail: Detail, extra: Partial<TerminalResultView> = {}, isError = false) {
  const view: TerminalResultView = { card: 'terminal', output: text, ...extra }
  const cards = new ToolCards(() => ({
    ...kind === 'terminal' ? { presentResult: () => view } : {},
  } as unknown as ToolDefinition), '/w')
  cards.detail = detail === 'inspect' ? 'compact' : detail
  const input: ResultInput = { callId: 'c1', content: [{ type: 'text', text }], isError }
  cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, 80)
  return {
    cards,
    render: (columns: number) => detail === 'inspect'
      ? cards.renderInspect({ kind: 'result', name: 'demo', args: {}, input }, columns).rows
      : cards.result(input, columns),
    expected: (columns: number) => kind === 'raw'
      ? legacyBody(text, columns, detail, isError)
      : legacyTerminal(view, columns, detail),
  }
}

beforeEach(() => {
  vi.mocked(escapeControls).mockClear()
})

describe('bounded cards preserve legacy styled output', () => {
  const samples = [
    ['empty', ''],
    ['whitespace only', ' \t\r\n\n '],
    ['trim versus one final LF', '\n  first\t \n\nlast  \n\n'],
    ['one final LF at the compact boundary', 'a\nb\nc\nd\ne\nf\n'],
    ['two final LFs at the compact boundary', 'a\nb\nc\nd\ne\nf\n\n'],
    ['blank retained rows', 'a\n\n\n\nb\n\n\n\nc'],
    ['single leading LF', '\nvalue'],
    ['leading LF at tail scan boundary', '\na\nb\nc\nd\ne'],
    ['multiple leading LFs at tail scan boundary', '\n\na\nb\nc\nd\ne'],
    ['tail composed of empty rows', 'a\n\n\n\n\n\n\n\n'],
    ['controls and wide code points', '\u0000\t中文😀\u001b[31m\r\u007f\u0085\n\t𐐀界\b\nend\r\n'],
    ['wide retained lines', Array.from({ length: 9 }, (_, i) => `${i}: 中文😀\t\u001b[2J${'wide '.repeat(40)}`).join('\n')],
  ] as const

  for (const kind of ['raw', 'terminal'] as const) {
    for (const detail of ['compact', 'full', 'hidden', 'inspect'] as const) {
      it.each(samples)(`${kind} ${detail}: %s`, (_name, text) => {
        for (const columns of [10, 23, 90, 160]) {
          const test = fixture(kind, text, detail)
          expect(test.render(columns)).toEqual(test.expected(columns))
        }
      })

      it(`${kind} ${detail}: budget boundaries retain the correct end and exact count`, () => {
        for (const length of [Math.max(1, BUDGET[detail] - 1), BUDGET[detail], BUDGET[detail] + 1]) {
          const text = Array.from({ length }, (_, i) => `${i}\t界😀\u001b`).join('\n') + '\n'
          const test = fixture(kind, text, detail)
          expect(test.render(37)).toEqual(test.expected(37))
        }
      })
    }
  }

  it.each(['compact', 'full', 'hidden', 'inspect'] as const)('preserves error colors and escaped terminal status at %s', detail => {
    for (const text of ['', '  \n', '\nfail\u001b\t界😀\n\n' + 'row\n'.repeat(8)]) {
      const raw = fixture('raw', text, detail, {}, true)
      expect(raw.render(25)).toEqual(raw.expected(25))
      for (const status of [{ exitCode: 0 }, { exitCode: 7 }, { exitCode: 7, signal: 'SIG\u001b\tTERM' }]) {
        const terminal = fixture('terminal', text, detail, status)
        expect(terminal.render(25)).toEqual(terminal.expected(25))
      }
    }
  })

  it('retains inspectability and re-renders the same semantic input at the larger budget', () => {
    for (const kind of ['raw', 'terminal'] as const) {
      const text = 'line\t界😀\u001b\n'.repeat(BUDGET.inspect + 3)
      const test = fixture(kind, text, 'full')
      expect(test.render(40)).toEqual(test.expected(40))
      const retained = test.cards.takeInspectable()
      expect(retained).toBeDefined()
      if (retained === undefined) throw new Error('missing inspectable result')
      expect(test.cards.renderInspect(retained, 40)).toEqual({
        rows: kind === 'raw' ? legacyBody(text, 40, 'inspect') : legacyTerminal({ card: 'terminal', output: text }, 40, 'inspect'),
        truncated: true,
      })
    }
  })
})

describe('bounded card escaping scales with retained raw lines', () => {
  it.each([4, 6])('generic call locations leave only the remaining body budget (%i locations)', count => {
    const lines = ['first\t界😀', '', 'third\u001b', 'fourth', 'fifth', 'sixth', 'last']
    const text = lines.join('\n')
    const locations = Array.from({ length: count }, (_, i) => ({ path: `file${i}` }))
    const makeCards = (withContent: boolean) => new ToolCards(() => ({
      presentCall: () => ({
        card: 'generic', title: 'title', locations,
        ...withContent ? { content: [{ type: 'text', text }] } : {},
      }),
    } as unknown as ToolDefinition), '/w')
    const call = { callId: 'c1', name: 'demo', arguments: '{}' }
    const baseline = makeCards(false).call(call, 40)
    const cards = makeCards(true)
    vi.mocked(escapeControls).mockClear()
    expect(cards.call(call, 40)).toEqual([
      ...baseline,
      ...legacyBody(text, 40, 'compact', false, BUDGET.compact - count),
    ])
    expect(vi.mocked(escapeControls).mock.calls.map(([input]) => input)).toEqual([
      'title', ...locations.map(location => location.path), ...lines.slice(0, BUDGET.compact - count),
    ])
    expect(cards.takeInspectable()).toBeDefined()
  })

  for (const kind of ['raw', 'terminal'] as const) {
    for (const detail of ['compact', 'full', 'hidden', 'inspect'] as const) {
      it(`${kind} ${detail}: discarded rows add no escape work or whole-output split`, () => {
        const retained = Array.from({ length: BUDGET[detail] }, (_, i) => `keep${i}\t界😀\u001b`)
        const expectedCharacters = retained.reduce((sum, line) => sum + line.length, 0)
        for (const discardedCount of [10, 10_000]) {
          const discarded = Array.from({ length: discardedCount }, () => `discard\u001b${'x'.repeat(100)}`)
          const text = (kind === 'raw' ? [...retained, ...discarded] : [...discarded, ...retained]).join('\n')
          const test = fixture(kind, text, detail)
          vi.mocked(escapeControls).mockClear()
          const originalSplit = String.prototype.split
          const wholeSplits: number[] = []
          // Watching only this exact input avoids coupling to renderer-internal
          // splitting of already bounded, painted rows.
          const split = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, separator: string | RegExp, limit?: number) {
            if (String(this) === text) wholeSplits.push(this.length)
            return originalSplit.call(this, separator, limit)
          })
          try {
            test.render(40)
          } finally {
            split.mockRestore()
          }
          const escaped = vi.mocked(escapeControls).mock.calls.map(([input]) => input)
          expect(escaped.reduce((sum, input) => sum + input.length, 0)).toBe(expectedCharacters)
          expect(escaped).toEqual(retained)
          expect(wholeSplits).toEqual([])
        }
      })
    }
  }
})
