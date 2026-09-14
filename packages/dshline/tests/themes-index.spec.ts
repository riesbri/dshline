/**
 * `/theme`: what it applies, what it refuses, and what it says afterwards.
 *
 * The report is the interesting half. A theme switch cannot repaint the
 * transcript above it — committed rows are never rewritten — so the command has
 * to say that, and has to stop saying it when nothing changed.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ColorDepth, Key, Palette } from '@dshline/renderer'
import { stripAnsi } from '@dshline/renderer'
import { DEFAULT_PALETTE } from '../src/theme.ts'
import { findTheme } from '../src/themes/builtin.ts'
import { runThemes, themeReport, themeValues } from '../src/themes/index.ts'
import type { TuiOverlay } from '../src/slots.ts'

/** One decoded keypress. */
const press = (name: string): Key => ({ kind: 'key', name } as unknown as Key)

/**
 * A context offering only the slot registry the picker touches.
 * @returns the context and a reader for whatever overlay was pushed.
 */
function slotContext(): { ctx: Context; overlay: () => TuiOverlay | undefined } {
  let pushed: TuiOverlay | undefined
  const ctx = {
    tuiSlots: {
      pushOverlay: (overlay: TuiOverlay) => {
        pushed = overlay
        return (): void => { pushed = undefined }
      },
      invalidate: (): void => {},
    },
    get: () => undefined,
  } as unknown as Context
  return { ctx, overlay: () => pushed }
}

/**
 * A window's theme seams, recording what was applied and committed.
 * @param depth - what the fake terminal can show.
 * @param initial - the palette already in force when the picker opens.
 * @returns the spec, plus readers for the applied palette and committed rows.
 */
function windowSeams(depth: ColorDepth = 24, initial: Palette = DEFAULT_PALETTE): {
  ctx: Context
  overlay: () => TuiOverlay | undefined
  spec: Parameters<typeof runThemes>[0]
  applied: Palette[]
  committed: string[]
} {
  const { ctx, overlay } = slotContext()
  const applied: Palette[] = []
  const committed: string[] = []
  let current: Palette = initial
  return {
    ctx,
    overlay,
    applied,
    committed,
    spec: {
      ctx,
      current: () => current,
      depth,
      apply: next => {
        applied.push(next)
        current = next
      },
      commit: lines => { committed.push(...lines) },
    },
  }
}

describe('themeValues()', () => {
  it('offers every shipped theme with its description', () => {
    const values = themeValues()
    expect(values.map(v => v.value)).toContain('default')
    expect(values.map(v => v.value)).toContain('paper')
    for (const value of values) expect(value.note?.length ?? 0).toBeGreaterThan(0)
  })
})

describe('runThemes() with a name', () => {
  it('applies a named theme without opening a picker', async () => {
    const w = windowSeams()
    await runThemes(w.spec, 'ember')
    expect(w.applied.map(p => p.id)).toStrictEqual(['ember'])
    expect(w.overlay()).toBeUndefined()
  })

  it('accepts the name however it was typed', async () => {
    const w = windowSeams()
    await runThemes(w.spec, '  EMBER  ')
    expect(w.applied.map(p => p.id)).toStrictEqual(['ember'])
  })

  it('reports what was on offer for a name no theme has, and applies nothing', async () => {
    const w = windowSeams()
    await runThemes(w.spec, 'dracula')
    expect(w.applied).toStrictEqual([])
    const said = stripAnsi(w.committed.join('\n'))
    expect(said).toContain('no theme named dracula')
    expect(said).toContain('ember')
  })

  it('does not reopen the picker just because a name was wrong', async () => {
    // A reader who typed a name asked not to be shown a list; answering a typo
    // with an overlay takes the terminal away from them instead of telling them.
    const w = windowSeams()
    await runThemes(w.spec, 'nope')
    expect(w.overlay()).toBeUndefined()
  })
})

describe('runThemes() with no argument', () => {
  it('opens the shared picker and applies what was confirmed', async () => {
    const w = windowSeams()
    const running = runThemes(w.spec, '')
    const overlay = w.overlay()
    expect(overlay).toBeDefined()
    // `default` is the first row; step once to reach the second and confirm.
    overlay?.handleKey(press('down'))
    overlay?.handleKey(press('enter'))
    await running
    expect(w.applied).toHaveLength(1)
    expect(w.applied[0]?.id).not.toBe('default')
  })

  it('opens on the theme already in use, not the first row', async () => {
    // `ember` is not row 0, and a picker that opened on row 0 would confirm
    // `default` instead — the misleading interaction this guards against.
    const ember = findTheme('ember')
    if (ember === undefined) throw new Error('ember theme missing')
    const w = windowSeams(24, ember)
    const asked: string[] = []
    const spec = { ...w.spec, remember: async (id: string) => { asked.push(id); return undefined } }
    const running = runThemes(spec, '')
    const overlay = w.overlay()
    expect(overlay).toBeDefined()
    expect(stripAnsi(overlay?.render(80, 24).join('\n') ?? '')).toContain('❯ Ember')
    overlay?.handleKey(press('enter'))
    await running
    // Confirming the current theme retries the write and says it was already in
    // use; it must not switch to `default`.
    expect(asked).toStrictEqual(['ember'])
    expect(w.applied).toStrictEqual([])
    expect(w.spec.current().id).toBe('ember')
    expect(stripAnsi(w.committed.join('\n'))).toContain('already in use')
  })

  it('changes and reports nothing when the picker is dismissed', async () => {
    const w = windowSeams()
    const running = runThemes(w.spec, '')
    w.overlay()?.handleKey(press('escape'))
    await running
    expect(w.applied).toStrictEqual([])
    expect(w.committed).toStrictEqual([])
  })
})

describe('storing the choice', () => {
  it('stores even when the palette did not move, so a failed write can be retried', async () => {
    // The bug this exists for: persistence used to be attempted only when the
    // palette CHANGED. A switch whose write failed left the terminal already
    // showing the theme and the document still naming the old one, and the
    // obvious way to retry — pick the same theme again — was the one gesture
    // that did nothing at all.
    const w = windowSeams()
    const asked: string[] = []
    const spec = { ...w.spec, remember: async (id: string) => { asked.push(id); return undefined } }
    await runThemes(spec, 'default')
    expect(asked).toStrictEqual(['default'])
  })

  it('reports what storing had to say, switch or not', async () => {
    const w = windowSeams()
    const spec = { ...w.spec, remember: async () => 'not saved: nowhere to write' }
    await runThemes(spec, 'default')
    expect(stripAnsi(w.committed.join('\n'))).toContain('nowhere to write')
  })

  it('still switches when there is nothing to store into', async () => {
    const w = windowSeams()
    await runThemes(w.spec, 'ember')
    expect(w.applied.map(p => p.id)).toStrictEqual(['ember'])
  })
})

describe('what a switch reports', () => {
  it('warns that committed rows keep the colours they were printed with', async () => {
    // The terminal model, stated where a reader would otherwise conclude the
    // switch half-failed: everything above the live region is already in the
    // user's real scrollback and is never rewritten.
    const w = windowSeams()
    await runThemes(w.spec, 'tide')
    expect(stripAnsi(w.committed.join('\n'))).toContain('rows above keep the colours')
  })

  it('stays quiet about scrollback when the theme did not change', async () => {
    const w = windowSeams()
    await runThemes(w.spec, 'default')
    const said = stripAnsi(w.committed.join('\n'))
    expect(said).toContain('already in use')
    expect(said).not.toContain('rows above keep the colours')
  })

  it('costs exactly one row of scrollback, switch or not', async () => {
    // Committed output is permanent. An earlier version wrote a whole sample
    // transcript here — a fabricated reply, tool call, diff, and failure — which
    // a reader trying three palettes could never get back out of their history.
    const changed = windowSeams()
    await runThemes(changed.spec, 'ember')
    expect(changed.committed).toHaveLength(1)

    const unchanged = windowSeams()
    await runThemes(unchanged.spec, 'default')
    expect(unchanged.committed).toHaveLength(1)
  })

  it('draws the confirmation in the palette it just installed', async () => {
    // The line is the only thing drawn in the new palette at the moment it
    // lands, so it has to carry more than one role to show anything at all.
    const w = windowSeams()
    await runThemes(w.spec, 'ember')
    const line = w.committed[0] ?? ''
    expect(line).toContain('theme: ember')
    expect(line.match(/\u001b\[/gu)?.length ?? 0).toBeGreaterThan(2)
  })

  it('names the fallback when the theme is deeper than the terminal', async () => {
    // "No silent degradation" applies to palettes too: a reader who picks a
    // 24-bit theme on a sixteen-colour terminal is seeing its declared fallback
    // and should not have to wonder why it resembles the one they left.
    const w = windowSeams(4)
    await runThemes(w.spec, 'ember')
    const said = stripAnsi(w.committed.join('\n'))
    expect(said).toContain('authored for 24-bit colour')
    expect(said).toContain('16 colours')
  })

  it('says nothing about depth when the terminal can show the theme', async () => {
    const w = windowSeams(24)
    await runThemes(w.spec, 'ember')
    expect(stripAnsi(w.committed.join('\n'))).not.toContain('fallback')
  })

  it('reports a shallow theme without a fallback note on any terminal', async () => {
    const w = windowSeams(4)
    await runThemes(w.spec, 'high-contrast')
    expect(stripAnsi(w.committed.join('\n'))).not.toContain('fallback')
  })
})

describe('themeReport()', () => {
  it('is one line, so a switch costs one row of scrollback', () => {
    const report = themeReport(DEFAULT_PALETTE, 4, true)
    expect(report.split('\n')).toHaveLength(1)
  })
})
