/**
 * The live region checked against a real terminal, not just against itself.
 *
 * The renderer positions the cursor and erases regions, so what is on screen
 * cannot be reconstructed from the text. The oracle in `tests/terminal-oracle.ts`
 * feeds every write to `@xterm/headless` and compares dshline's claimed
 * `Screen` state with the terminal's actual rows, cursor, and scrollback after
 * every operation — including that a CHANGED frame actually wrote and erased,
 * so a stale-frame assertion cannot pass because the redraw was skipped.
 * @module dshline/tests/live-region-oracle
 */

import { describe, expect, it } from 'vitest'
import { TerminalOracleViolation, createOracle, orderedContent } from '../../../tests/terminal-oracle.ts'
import type { Oracle, OracleOptions } from '../../../tests/terminal-oracle.ts'
import { createSubagentCatalogOverlay } from '../src/subagents/overlay.ts'

/** Run a body against a fresh oracle and always release the terminal. */
async function withOracle(
  columns: number,
  rows: number,
  run: (oracle: Oracle) => Promise<void>,
  options: OracleOptions = {},
): Promise<void> {
  const oracle = createOracle(columns, rows, options)
  try {
    await run(oracle)
  } finally {
    oracle.dispose()
  }
}

describe('the live region against a terminal oracle', () => {
  it('grows, shrinks, and commits without leaving or duplicating a row', async () => {
    await withOracle(40, 12, async oracle => {
      await oracle.live(['\u256d\u2500 frame \u2500\u256e', 'body', '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u256f'])
      await oracle.live(['\u256d\u2500 one \u2500\u256e', 'short', '\u2570\u2500\u2500\u2500\u2500\u2500\u256f'])
      // The marker is present in the model, so the border-count invariant is not
      // comparing zero against zero and silently doing nothing.
      expect((await oracle.snapshot()).live.join('\n')).toContain('\u256d')
      // Committing replaces the region beneath the new rows; the two committed
      // rows must survive exactly once and never be rewritten by what follows.
      await oracle.commit(['committed one', 'committed two'])
      // A physical shrink, not just shorter text: three rows down to one.
      await oracle.live(['\u256d\u2500 last \u2500\u256e', 'x', '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u256f'])
      await oracle.live(['\u256d\u2500 final \u2500\u256e'])

      const snapshot = await oracle.snapshot()
      expect(snapshot.scrollback.filter(row => row.includes('committed'))).toHaveLength(2)
      expect(snapshot.scrollback.filter(row => row.includes('\u256d\u2500'))).toHaveLength(1)
      // The dropped rows left no tail behind.
      expect(snapshot.scrollback.some(row => row.includes('body'))).toBe(false)
    })
  })

  it('places the cursor where the model says, including a requested placement', async () => {
    // Exercises the `cursor !== undefined` branch: the oracle predicts the
    // clamped placement from the model and compares the terminal's real cursor.
    await withOracle(20, 10, async oracle => {
      await oracle.live(['one', 'two', 'three'], { row: 0, column: 1 })
      await oracle.live(['alpha', 'beta'], { row: 1, column: 3 })
    })
  })

  it('redraws after a width change the terminal does not reflow', async () => {
    await withOracle(20, 10, async oracle => {
      await oracle.live(['hello world'])
      // Widening leaves the rows already written alone in xterm, so the erase is
      // exact and the frame after it must leave no trace of the first.
      await oracle.resize(40, 10)
      await oracle.live(['a different frame'])
      const snapshot = await oracle.snapshot()
      expect(snapshot.scrollback.join('\n')).not.toContain('hello world')
    })
  })

  it('writes when a raw resize invalidates a byte-identical frame', async () => {
    // `restale:false` leaves the skip cache "current", so only the width being
    // part of the frame identity forces the write. The oracle now throws if that
    // changed-width redraw wrote nothing, which is what would silently leave the
    // terminal's reflow uncorrected.
    await withOracle(20, 10, async oracle => {
      await oracle.live(['same text'])
      await oracle.resize(40, 10, { restale: false })
      await oracle.live(['same text'])
    })
  })

  it('leaves committed scrollback in place when the region closes', async () => {
    await withOracle(30, 8, async oracle => {
      await oracle.commit(['kept row'])
      await oracle.live(['live row'])
      await oracle.close()
      const snapshot = await oracle.snapshot()
      expect(snapshot.scrollback).toContain('kept row')
      // close() is checked against the committed model, so a live row it failed
      // to erase is a violation rather than an untested leftover.
      expect(snapshot.scrollback).not.toContain('live row')
    })
  })

  it('detects a frame whose physical wrap the model did not account for', async () => {
    // The #202 class, proven detectable: the terminal widens U+00B1 while
    // dshline measures it narrow, so the model believes ten characters are one
    // row and the terminal draws two. A surface that lets such a character reach
    // structural chrome must not.
    await withOracle(10, 6, async oracle => {
      await expect(oracle.live(['\u00b1'.repeat(10)])).rejects.toThrow(TerminalOracleViolation)
    }, { wideCodePoints: [0x00b1] })
  })

  it('reports the known narrowing-resize reflow limitation by name', async () => {
    // A narrowing resize makes the TERMINAL reflow already-drawn live rows into
    // more physical rows before dshline receives the resize event, and the
    // reflowed remainder enters history. `Screen` deliberately keeps the drawn
    // geometry rather than climbing a reflowed count it cannot anchor, because
    // an over-climb would erase committed rows. This is the one invariant the
    // native-scrollback model cannot meet, and the oracle names it rather than
    // hiding it. A multi-row frame is required: a single exactly-full row is
    // truncated by this terminal rather than reflowed.
    await withOracle(20, 10, async oracle => {
      await oracle.live(['\u256d\u2500 frame \u2500\u256e', 'body here', '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u256f'])
      await oracle.resize(8, 10)
      await expect(oracle.live(['next'])).rejects.toThrow(/committed content changed|stale frame row/)
    })
  })

  it('runs against a newly added subagent surface on a widening terminal', async () => {    // The oracle is general: it drives any `TuiSlotView`'s rendered rows through
    // the real `Screen`. Reusing it on the `/subagents` catalog — whose footer
    // once carried the ambiguous arrows — keeps that surface inside the same
    // differential check as the composer.
    let resident = true
    const overlay = createSubagentCatalogOverlay({
      reading: () => ({
        kind: 'ready',
        rows: [
          {
            kind: 'child', id: 'a', mode: 'continuable',
            residency: resident ? 'resident' : 'stored', hasChildren: false, label: 'alpha',
          },
          { kind: 'child', id: 'b', mode: 'one-shot', residency: 'stored', hasChildren: false, label: 'beta' },
        ],
      }),
      inspect: () => {},
      refresh: () => {},
      close: () => {},
      invalidate: () => {},
    })
    await withOracle(60, 12, async oracle => {
      // The mutation changes text but not height, so the redraw is real.
      await oracle.live(overlay.render(60, 12))
      resident = false
      await oracle.live(overlay.render(60, 12))
      resident = true
      await oracle.live(overlay.render(60, 12))
    }, { wideCodePoints: [0x2191, 0x2193] })
  })

  it('compares committed content in order, so a reorder is not a match', () => {
    // Sorting characters would make these equal; a reordered commit has to be
    // caught. Whitespace and row grouping stay tolerated, which is what a
    // terminal reflow actually changes.
    expect(orderedContent(['ab', 'cd'])).toBe('abcd')
    expect(orderedContent(['ab', 'cd'])).not.toBe(orderedContent(['cd', 'ab']))
    expect(orderedContent(['ab cd'])).toBe(orderedContent(['ab', 'cd']))
  })

  it('rejects committed content the terminal reordered', async () => {
    await withOracle(20, 6, async oracle => {
      await oracle.commit(['AB'])
      // Rewrite the committed row in place behind the model's back. Only the
      // order changes, so a sorted comparison would see no difference at all.
      oracle.emulator.target.write('\u001b[A\r\u001b[2KBA')
      await expect(oracle.live(['x'])).rejects.toThrow(TerminalOracleViolation)
    })
  })
})
