/**
 * Reusable assertions for dshline's bounded-surface UX contracts.
 *
 * These are TEST vocabulary, not production abstraction: they assert what a
 * bounded surface already promises, so a regression names the rule it broke
 * instead of rediscovering it inside one surface's spec. The domain meaning
 * stays with each surface — what its rows say, which key acts on which row —
 * while the two properties every bounded surface shares are checked here:
 * physical geometry, and a help row that is a whole instruction.
 * @module dshline/tests/surface-contracts
 */

import { expect } from 'vitest'
import { displayWidth, stripAnsi, wrapToWidth } from '@dshline/renderer'

/** The one method {@link expectPhysicallyBounded} needs from a surface. */
export interface Renderable {
  /**
   * @param columns - terminal width.
   * @param rows - terminal height.
   * @returns the logical rows this surface would draw.
   */
  render(columns: number, rows?: number): readonly string[]
}

/**
 * Render one surface at one geometry and assert it stays inside the budget.
 *
 * `Screen` re-wraps a logical row wider than the terminal AFTER the surface has
 * budgeted its rows, so a row that overruns its width becomes a physical row
 * the live region never counted — and a live region taller than the screen
 * leaves rows in scrollback that can never be erased. Both halves are asserted
 * here because either one alone is not the invariant: a surface can be narrow
 * and still wrap, or wide and still be one row too tall.
 * @param surface - the overlay or view under test.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @param label - what to name in a failure, usually the surface.
 * @returns the rows that were drawn.
 */
export function expectPhysicallyBounded(
  surface: Renderable,
  columns: number,
  rows: number,
  label: string,
): readonly string[] {
  const lines = surface.render(columns, rows)
  const at = `${label} at ${String(columns)}x${String(rows)}`
  for (const [index, line] of lines.entries()) {
    expect(
      displayWidth(line),
      `${at}: logical row ${String(index)} overruns the terminal — ${JSON.stringify(stripAnsi(line))}`,
    ).toBeLessThanOrEqual(columns)
  }
  const physical = lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
  expect(
    physical.length,
    `${at}: drew ${String(physical.length)} physical rows`,
  ).toBeLessThanOrEqual(rows)
  return lines
}

/**
 * Assert a rendered help row is a WHOLE instruction the surface may show.
 *
 * A surface is free to drop help under width pressure, but never to cut one: a
 * footer reading `esc cl` names neither the state nor the way out, and it is
 * the bug this project hit when a hand-rolled fallback truncated `esc close`
 * to the terminal's width instead of laddering to a shorter whole phrase.
 * `allowed` is the surface's own whole-row vocabulary for the state under
 * test, so the domain wording stays with the surface.
 * @param rendered - one rendered help row, styled or plain.
 * @param allowed - every whole instruction this surface may draw in that state.
 * @param label - what to name in a failure.
 */
export function expectWholeHelp(rendered: string, allowed: readonly string[], label: string): void {
  const shown = stripAnsi(rendered).trim()
  expect(allowed, `${label}: ${JSON.stringify(shown)} is not a whole instruction`).toContain(shown)
}
