import { describe, expect, it } from 'vitest'
import { soakCases } from './renderer-soak-corpus.mjs'

// Anchor acceptance independently: deleting a generator boundary must fail here.
const REQUIRED_LENGTHS = [0, 1, 2, 23, 24, 63, 64, 65, 95, 96, 191, 192, 511, 512, 513, 2047, 2048]
const REQUIRED_BUDGETS = [-256, -1, 0, 1, 8, 40, 120, 256]

describe('direct-addon soak coverage', () => {
  it('covers every native boundary size at every budget, including negative and zero widths', () => {
    const cases = [...soakCases(0)]
    expect(cases).toHaveLength(136)
    for (const budget of REQUIRED_BUDGETS) {
      expect(cases.filter(item => item.budget === budget).map(item => item.text.length)).toEqual(REQUIRED_LENGTHS)
    }
    expect(cases.some(item => item.text.includes('\0'))).toBe(true)
    expect(cases.some(item => item.text.includes('\ud800'))).toBe(true)
    expect(cases.some(item => item.text.includes('\udfff'))).toBe(true)
    expect(cases.some(item => item.text.includes('\u001b'))).toBe(true)
  })
  it('does not collapse random budgets or lengths through correlated PRNG draws', () => {
    const cases = [...soakCases(800)].filter(item => item.kind === 'random')
    for (const budget of REQUIRED_BUDGETS) expect(cases.filter(item => item.budget === budget)).toHaveLength(100)
    expect(new Set(cases.map(item => item.text.length)).size).toBeGreaterThan(80)
    expect([...soakCases(8)]).toEqual([...soakCases(8)])
  })
})
