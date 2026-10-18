import { describe, expect, it } from 'vitest'
import { Screen } from '../src/screen.ts'
import { createEmulator } from '../../../tests/emulator.ts'

const CSI = '\u001b['

describe('Screen compact padding runs', () => {
  it('compacts both commit and live repaint bytes without changing the literal-frame cache', () => {
    const writes: string[] = []
    const screen = new Screen({ columns: () => 90, write: chunk => { writes.push(chunk) } })
    const border = `┌${'─'.repeat(88)}┐`
    screen.setLive([border, `│${' '.repeat(88)}│`], { row: 1, column: 2 })
    expect(writes[0]).toContain('─'.repeat(88))
    expect(writes[0]).toContain(` ${CSI}86b`)
    expect(Buffer.byteLength(writes[0] ?? '')).toBeLessThan(420)
    screen.setLive([border, `│${' '.repeat(88)}│`], { row: 1, column: 2 })
    expect(writes).toHaveLength(1)
    screen.commit([border, ' '.repeat(88)])
    expect(writes[1]?.match(/86b/gu)).toHaveLength(2)
  })

  it('preserves repeated cells, attributes, right-margin wrap, damage, commits and scrollback', async () => {
    for (const columns of [8, 13, 90]) {
      const actual = createEmulator(columns, 8)
      const literal = createEmulator(columns, 8)
      const screen = new Screen(actual.target)
      const reference = new Screen(literal.target)
      // Identical redundant SGR boundaries stop literal runs being encoded.
      const row = (glyph: string, color = '') => `${color}${glyph.repeat(columns)}${color ? `${CSI}0m` : ''}`
      const raw = (glyph: string, color = '') => Array.from({ length: columns }, () => `${color || `${CSI}0m`}${glyph}`).join('') + `${CSI}0m`
      try {
        for (let frame = 0; frame < 18; frame += 1) {
          const glyph = ['─', ' ', '═'][frame % 3] ?? ' '
          const color = frame % 2 ? `${CSI}31;44m` : ''
          if (frame % 3 === 0) {
            screen.commit([row(glyph, color)])
            reference.commit([raw(glyph, color)])
          }
          const cursor = frame % 2 ? { row: 0, column: 2 } : undefined
          screen.setLive([row(glyph, color), `end ${String(frame)}`], cursor)
          reference.setLive([raw(glyph, color), `end ${String(frame)}`], cursor)
          expect(await actual.scrollback()).toEqual(await literal.scrollback())
          expect(await actual.cursor()).toEqual(await literal.cursor())
          for (let y = 0; y < 8; y += 1) {
            for (let x = 0; x < columns; x += 1) {
              expect(await actual.cell(x, y)).toEqual(await literal.cell(x, y))
            }
          }
        }
        screen.close()
        reference.close()
        expect(await actual.scrollback()).toEqual(await literal.scrollback())
      } finally {
        actual.dispose()
        literal.dispose()
      }
    }
  })

  it('leaves short runs, clusters, OSC payloads and unknown or incomplete escapes literal', () => {
    const writes: string[] = []
    const screen = new Screen({ columns: () => 200, write: chunk => { writes.push(chunk) } })
    for (const row of ['     ', '─'.repeat(5), '界'.repeat(8), 'e\u0301'.repeat(8),
      `\u001b]8;;https://example.com/${'─'.repeat(10)}\u0007${' '.repeat(10)}\u001b]8;;\u0007`,
      `\u009d${' '.repeat(10)}\u009c`, `\u001bP${' '.repeat(10)}`, `\u001b[?${' '.repeat(10)}`]) {
      screen.setLive([row])
      expect(writes.at(-1)).toContain(row)
      expect(writes.at(-1)).not.toMatch(/\u001b\[\d+b/u)
    }
  })

  it('keeps combining marks attached to only the final repeated glyph', async () => {
    const emulator = createEmulator(20, 6)
    const screen = new Screen(emulator.target)
    screen.setLive([`${' '.repeat(8)}\u0301`])
    expect(await emulator.cell(6, 0)).toMatchObject({ chars: ' ' })
    expect(await emulator.cell(7, 0)).toMatchObject({ chars: ' ́' })
    emulator.dispose()
  })
})
