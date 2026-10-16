import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { generateLookup } from './generate-renderer-lookup.mjs'
describe('derived Rust Unicode lookup', () => {
  it('matches the committed complete policy without a build or network', () => {
    const generated = generateLookup()
    expect(generated.source).toBe(readFileSync(new URL('../crates/dshline-renderer/src/lookup.rs', import.meta.url), 'utf8'))
    expect(generated.pages).toBeLessThanOrEqual(256)
    expect(generated.bytes).toBeLessThan(65536)
  })
  it('rejects unsorted and out-of-domain policy mutations instead of truncating them', () => {
    const source = readFileSync(new URL('../packages/renderer/src/width-tables.ts', import.meta.url), 'utf8')
    expect(() => generateLookup(source.replace('[0x1100, 0x115f]', '[0x110000, 0x110001]'))).toThrow('Invalid policy table')
    expect(() => generateLookup(source.replace('[0x231a, 0x231b]', '[0x1100, 0x115f]'))).toThrow('Invalid policy table')
  })
})
