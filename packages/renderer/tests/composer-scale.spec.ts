/**
 * The composer's layout at the sizes that used to be pathological.
 *
 * The old implementation asked the composer for whole-buffer derived forms
 * (`lines`, `cursorLine`, `lineBeforeCursor`) from inside a per-line loop, so a
 * draft of L lines and N code points cost O(N·L). These tests pin the behaviour
 * that must survive the single-pass rewrite — Unicode, explicit newlines,
 * exact-width rows, preferred columns — and the STRUCTURAL property that made it
 * fast, which is checked by observation rather than a wall-clock threshold.
 */

import { describe, expect, it } from 'vitest'
import { Composer } from '../src/composer.ts'
import { layoutComposer } from '../src/composer-layout.ts'

const GUTTER = (line: number): string => (line === 0 ? '› ' : '  ')

/**
 * Put the cursor at `offset` by marching there from the right with real moves.
 * @param text - the draft.
 * @param offset - the code-point offset to reach.
 * @returns the composer, positioned.
 */
function cursorAt(text: string, offset: number): Composer {
  const composer = new Composer()
  composer.set(text)
  expect(composer.position).toBe([...text].length)
  while (composer.position > offset) composer.handle({ kind: 'key', name: 'left' })
  return composer
}

/**
 * A composer that records how its whole-buffer getters are used.
 *
 * The layout is allowed to read `value` once and `position` once to take its
 * snapshot. It is never allowed to reach for `lines`, `lineBeforeCursor`, or
 * `cursorLine`: those are the getters that join, split, or rescan the entire
 * buffer, and calling them from inside the traversal is exactly what made the
 * old layout quadratic. Asserting zero calls is stronger than timing, and it
 * cannot flake.
 */
class AuditedComposer extends Composer {
  /** Names of the whole-buffer derived getters read since {@link reset}. */
  readonly derivedReads: string[] = []
  /** Times the snapshot getters were read since {@link reset}. */
  valueReads = 0
  positionReads = 0

  /** Begin a fresh observation window. */
  reset(): void {
    this.derivedReads.length = 0
    this.valueReads = 0
    this.positionReads = 0
  }

  override get value(): string {
    this.valueReads += 1
    return super.value
  }

  override get position(): number {
    this.positionReads += 1
    return super.position
  }

  override get lines(): string[] {
    this.derivedReads.push('lines')
    return super.lines
  }

  override get cursorLine(): number {
    this.derivedReads.push('cursorLine')
    return super.cursorLine
  }

  override get lineBeforeCursor(): string {
    this.derivedReads.push('lineBeforeCursor')
    return super.lineBeforeCursor
  }
}

describe('layout at scale', () => {
  it('lays thousands of lines out and places the cursor at the end', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `row ${String(i)}`)
    const composer = new Composer()
    composer.set(lines.join('\n'))

    const layout = layoutComposer(composer, 80, GUTTER)
    // Every line is short enough to wrap onto exactly one visual row, and the
    // final row is short, so there is no insertion row: one row per line.
    expect(layout.rows).toHaveLength(5000)
    expect(layout.cursorRow).toBe(4999)
    expect(layout.positionAt(layout.cursorRow, layout.cursorColumn)).toBe(composer.position)
  })

  it('lays a very long single line out into one row per width', () => {
    const composer = new Composer()
    composer.set('a'.repeat(100_000))
    const layout = layoutComposer(composer, 80, GUTTER)
    // The first row reserves the `› ` gutter (78 text columns); every wrapped
    // continuation row then gets the whole 80. 78 + 1_249 x 80 = 99_998, so 1_250
    // rows remain: the 1_250th is the partial `aa` tail, and the end cursor sits
    // at its drawn column rather than on an insertion row (the row is not full).
    expect(layout.rows).toHaveLength(1251)
    expect(layout.cursorRow).toBe(layout.rows.length - 1)
    expect(layout.cursorColumn).toBe(2)
    expect(layout.positionAt(layout.cursorRow, layout.cursorColumn)).toBe(100_000)
  })

  it('takes its snapshot from the buffer once and never re-derives it per line', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `row ${String(i)}`)
    const composer = new AuditedComposer()
    composer.set(lines.join('\n'))
    composer.reset()

    layoutComposer(composer, 80, GUTTER)

    // The whole cost of the layout is one join and one position read. Any per-line
    // re-derivation shows up here as a growing count, so the assertion is the
    // regression guard the wall-clock benchmark cannot be in CI.
    expect(composer.valueReads).toBe(1)
    expect(composer.positionReads).toBe(1)
    expect(composer.derivedReads).toEqual([])
  })

  it('does not re-derive the buffer while moving the cursor', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `row ${String(i)}`)
    const composer = new AuditedComposer()
    composer.set(lines.join('\n'))
    composer.reset()

    composer.moveUp(80, GUTTER)
    composer.moveDown(80, GUTTER)

    // A vertical move is one layout, and one layout is one snapshot.
    expect(composer.valueReads).toBe(2)
    expect(composer.positionReads).toBe(2)
    expect(composer.derivedReads).toEqual([])
  })
})

describe('layout across line structure', () => {
  it('places a cursor at the start of a line after an explicit newline', () => {
    // A cursor resting on a newline's far side has no character of its own to
    // trigger placement. It used to stay unplaced and be mistaken for the buffer's
    // end, which drew the caret on the last line and made `↑` step into the wrong
    // one. This is reachable by one Left from just after a line's first character.
    const width = 80
    // Offsets 2 and 4 are the starts of the second and third lines; the third is
    // also the buffer's end, so it exercises the fallback too.
    for (const [at, row] of [[2, 1], [4, 2]] as const) {
      const composer = new Composer()
      composer.set('a\nb\nc')
      while (composer.position > at) composer.handle({ kind: 'key', name: 'left' })
      const layout = layoutComposer(composer, width, GUTTER)
      expect(layout.cursorRow, `offset ${String(at)}`).toBe(row)
      expect(layout.cursorColumn, `offset ${String(at)}`).toBe(2)
      expect(layout.positionAt(layout.cursorRow, layout.cursorColumn)).toBe(at)
    }
  })

  it('moves up and down across wrapped rows and explicit newlines', () => {
    const composer = new Composer()
    composer.set('first line\nsecond line\nthird line')
    const width = 80
    const end = composer.position
    expect(layoutComposer(composer, width, GUTTER).cursorRow).toBe(2)

    expect(composer.moveUp(width, GUTTER)).toBe(true)
    expect(layoutComposer(composer, width, GUTTER).cursorRow).toBe(1)
    expect(composer.moveDown(width, GUTTER)).toBe(true)
    expect(layoutComposer(composer, width, GUTTER).cursorRow).toBe(2)
    expect(composer.position).toBe(end)
  })

  it('keeps a wide character off the row boundary and places by its columns', () => {
    const composer = new Composer()
    composer.set('标准标准标准')
    // Four text columns after the gutter holds two wide characters per row.
    const layout = layoutComposer(composer, 6, GUTTER)
    expect(layout.rows).toEqual(['› 标准', '标准标', '准'])
    expect(layout.cursorRow).toBe(2)
    expect(layout.cursorColumn).toBe(2)
  })

  it('keeps an astral character whole across a wrap', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'a🙂🙂b🙂cdef🙂gh' })
    const width = 8
    const layout = layoutComposer(composer, width, GUTTER)
    expect(layout.positionAt(layout.cursorRow, layout.cursorColumn)).toBe(composer.position)
    expect(composer.moveUp(width, GUTTER)).toBe(true)
    expect(composer.value).toBe('a🙂🙂b🙂cdef🙂gh')
    expect(composer.moveDown(width, GUTTER)).toBe(true)
    expect(composer.position).toBe([...composer.value].length)
  })

  it('preserves the preferred display column through repeated movement', () => {
    // One long line wraps at 10 text columns. The cursor starts partway along the
    // first row; moving down and back up must re-apply the display column it left
    // with rather than adopting the target row's own end.
    const composer = new Composer()
    composer.set('abcdefghijklmnopqrstuvwxy')
    const width = 12
    while (composer.position > 5) composer.handle({ kind: 'key', name: 'left' })
    const first = layoutComposer(composer, width, GUTTER)
    expect(first.positionAt(first.cursorRow, first.cursorColumn)).toBe(composer.position)

    expect(composer.moveDown(width, GUTTER)).toBe(true)
    const down = layoutComposer(composer, width, GUTTER)
    expect(down.positionAt(down.cursorRow, down.cursorColumn)).toBe(composer.position)

    // The display column the down move left with is what the up move aims at, so
    // the cursor returns to the first row at that column — not to its own end.
    expect(composer.moveUp(width, GUTTER)).toBe(true)
    const back = layoutComposer(composer, width, GUTTER)
    expect(back.cursorRow).toBe(0)
    expect(back.cursorColumn).toBe(down.cursorColumn)
    expect(back.positionAt(back.cursorRow, back.cursorColumn)).toBe(composer.position)
  })

  it('reaches the top row and the bottom row for every width', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: '标 a🙂 第一 行 … second line that wraps' })
    for (const width of [10, 14, 22]) {
      while (composer.moveUp(width, GUTTER)) { /* climb */ }
      expect(layoutComposer(composer, width, GUTTER).cursorRow, `${String(width)} wide`).toBe(0)
      while (composer.moveDown(width, GUTTER)) { /* descend */ }
      const bottom = layoutComposer(composer, width, GUTTER)
      expect(bottom.cursorRow, `${String(width)} wide`).toBe(bottom.rows.length - 1)
    }
  })

  it('keeps an exact-width final row reachable after moving away from it', () => {
    for (const [text, width] of [['abcdefghij', 12], ['标准标准标', 6]] as const) {
      const composer = new Composer()
      composer.set(text)
      const end = composer.position
      expect(composer.moveUp(width, GUTTER), `${text} up`).toBe(true)
      expect(composer.moveDown(width, GUTTER), `${text} down`).toBe(true)
      expect(composer.position, `${text} position`).toBe(end)
    }
  })

  it('is an exact inverse on a first row, where the gutter is non-empty', () => {
    // The regression the reviewers found: `cursorColumn` counts the drawn gutter
    // but `positionAt` did not subtract it, so they disagreed by two columns on
    // every logical line's FIRST row and vertical movement drifted.
    const composer = new Composer()
    composer.set('abcdefghij\nsecond')
    const width = 80
    while (composer.position > 4) composer.handle({ kind: 'key', name: 'left' })
    const layout = layoutComposer(composer, width, GUTTER)
    expect(layout.cursorRow).toBe(0)
    expect(layout.positionAt(layout.cursorRow, layout.cursorColumn)).toBe(4)
    // And moving down by a row lands on the same drawn column, one row lower.
    expect(composer.moveDown(width, GUTTER)).toBe(true)
    const down = layoutComposer(composer, width, GUTTER)
    expect(down.cursorRow).toBe(1)
    expect(down.cursorColumn).toBe(layout.cursorColumn)
    expect(down.positionAt(down.cursorRow, down.cursorColumn)).toBe(composer.position)
  })

  it('re-lays the same buffer when the width changes', () => {
    const composer = new Composer()
    composer.set('abcdefghijklmnopqrstuvwxyz')
    const wide = layoutComposer(composer, 80, GUTTER)
    const narrow = layoutComposer(composer, 10, GUTTER)
    expect(wide.rows).toHaveLength(1)
    expect(narrow.rows.length).toBeGreaterThan(1)
    expect(narrow.positionAt(narrow.cursorRow, narrow.cursorColumn)).toBe(26)
  })
})

describe('the exact-width boundary before an explicit newline', () => {
  it('keeps the position before the newline distinct from the one after it', () => {
    // The first line's ten text columns exactly fill the width left by the
    // two-column gutter. A cursor just BEFORE the newline used to roll onto the
    // row that the next logical line then reused, so the advertised inverse
    // returned 11 for a cursor at 10 — vertical movement could cross the newline.
    const composer = cursorAt('abcdefghij\nx', 10)
    expect(composer.position).toBe(10)
    const layout = layoutComposer(composer, 12, GUTTER)
    expect(layout.positionAt(layout.cursorRow, layout.cursorColumn)).toBe(composer.position)
    // And the offset after the newline still maps to the row that holds it.
    expect(layout.positionAt(layout.cursorRow + 1, 0)).toBe(11)
  })

  it('round-trips vertical movement without crossing the newline', () => {
    const composer = cursorAt('abcdefghij\nx', 10)
    expect(composer.moveDown(12, GUTTER)).toBe(true)
    const down = layoutComposer(composer, 12, GUTTER)
    expect(down.positionAt(down.cursorRow, down.cursorColumn)).toBe(composer.position)
    expect(composer.moveUp(12, GUTTER)).toBe(true)
    expect(composer.position).toBe(10)
  })

  it('keeps the boundary invertible when the row fills exactly by display width', () => {
    // `› ` is two columns and each CJK glyph is two more, so the row holds exactly
    // two glyphs and the cursor before the newline is at display column 6.
    const composer = cursorAt('标准\nx', 2)
    const layout = layoutComposer(composer, 6, GUTTER)
    expect(layout.positionAt(layout.cursorRow, layout.cursorColumn)).toBe(2)
    expect(layout.positionAt(layout.cursorRow + 1, 0)).toBe(3)
  })

  it('stays invertible around consecutive and empty newlines', () => {
    for (const text of ['a\n\n\nb', 'ab\n\n', '\nx', 'a\nb\nc\n']) {
      const cps = [...text]
      for (let offset = 0; offset <= cps.length; offset += 1) {
        const composer = new Composer()
        composer.set(text)
        while (composer.position > offset) composer.handle({ kind: 'key', name: 'left' })
        const layout = layoutComposer(composer, 12, GUTTER)
        expect(
          layout.positionAt(layout.cursorRow, layout.cursorColumn),
          `${JSON.stringify(text)} at ${String(offset)}`,
        ).toBe(offset)
      }
    }
  })
})

describe('the layout advertises an inverse for every reachable cursor offset', () => {
  it('holds for every prefix and width over ASCII, CJK, astral, and newlines', () => {
    // The probe the task asks for, strengthened for the boundary the old one
    // missed: an exact-width row immediately before an explicit newline. Every
    // offset of every prefix must map back to itself through the advertised
    // (cursorRow, cursorColumn) pair, and the placement must own a real row.
    const texts = [
      '', 'x', '\n', 'abc\n', '\n\n',
      'abcdefghij\nx',            // exact-width row, then a newline
      'abcdefghijklmnopqrstuv',   // wraps with no newline
      'abcdefghij\nabcdefghij\n', // two exact-width lines, trailing newline
      '标准\nx',                   // exact width by display columns, then a newline
      '标准标准标准',
      '标准\n标准\n标准',
      'a🙂🙂b🙂cdef🙂gh',
      'ab\n\ncd\n',
      'a\nb\nc',
      Array.from({ length: 25 }, (_unused, i) => `line ${String(i)}`).join('\n'),
    ]
    let checked = 0
    for (const text of texts) {
      const cps = [...text]
      for (let offset = 0; offset <= cps.length; offset += 1) {
        for (const width of [4, 6, 8, 12, 20, 80]) {
          const composer = cursorAt(text, offset)
          const layout = layoutComposer(composer, width, GUTTER)
          const label = `${JSON.stringify(text)} at ${String(offset)} width ${String(width)}`
          expect(layout.cursorRow, label).toBeGreaterThanOrEqual(0)
          expect(layout.cursorRow, label).toBeLessThan(layout.rows.length)
          expect(
            layout.positionAt(layout.cursorRow, layout.cursorColumn),
            label,
          ).toBe(offset)
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })
})
