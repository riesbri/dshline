/**
 * The printable-ASCII fast path, observed structurally.
 *
 * Answering 0x20..0x7e as one column is behavior-preserving: the previous
 * implementation already returned 1 for every one of them — ASCII appears in
 * neither width table — it just paid two failing binary searches first. So no
 * value assertion can tell whether the fast path exists, and a boundary sweep
 * passes either way. This spec pins the WORK instead: the two tables are
 * replaced with counting proxies around their real ranges, and a printable
 * ASCII code point must consult neither while a code point that genuinely needs
 * a table still does.
 *
 * The tables are the only seam — `inRanges` is module-private — and mocking the
 * module here is file-scoped, so the table-integrity specs in `width.spec.ts`
 * keep importing the real arrays.
 */

import { describe, expect, it, vi } from 'vitest'

/** Index reads recorded against each table, reset between assertions. */
const reads = vi.hoisted(() => ({ zero: 0, wide: 0 }))

vi.mock('../src/width-tables.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/width-tables.ts')>('../src/width-tables.ts')
  const counting = (
    ranges: readonly (readonly [number, number])[],
    count: () => void,
  ): readonly (readonly [number, number])[] =>
    new Proxy(ranges, {
      get(target, property, receiver) {
        // `inRanges` reads `ranges[mid]` per probe and `ranges.length` once; only
        // the numeric probes are the work this pins.
        if (typeof property === 'string' && /^\d+$/u.test(property)) count()
        return Reflect.get(target, property, receiver)
      },
    })
  return {
    WIDE_RANGES: counting(actual.WIDE_RANGES, () => { reads.wide += 1 }),
    ZERO_WIDTH_RANGES: counting(actual.ZERO_WIDTH_RANGES, () => { reads.zero += 1 }),
  }
})

import { codePointWidth } from '../src/width.ts'

describe('the printable-ASCII fast path', () => {
  it('answers 0x20..0x7e without consulting either table', () => {
    reads.zero = 0
    reads.wide = 0
    for (let code = 0x20; code <= 0x7e; code += 1) {
      expect(codePointWidth(code), `U+${code.toString(16)}`).toBe(1)
    }
    expect(reads.zero, 'zero-width table index reads').toBe(0)
    expect(reads.wide, 'wide table index reads').toBe(0)
  })

  it('still consults the tables past ASCII, so the observation is not vacuous', () => {
    // If the proxies ever stopped being installed — the tables inlined, the
    // import path moved — the first test would pass for the wrong reason. A CJK
    // ideograph must read both tables: the zero table misses, the wide table
    // matches.
    reads.zero = 0
    reads.wide = 0
    expect(codePointWidth(0x4e2d)).toBe(2)
    expect(reads.zero, 'zero-width table index reads').toBeGreaterThan(0)
    expect(reads.wide, 'wide table index reads').toBeGreaterThan(0)
  })
})
