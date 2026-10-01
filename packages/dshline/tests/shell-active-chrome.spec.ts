/**
 * The composer frame while a direct human shell operation owns the foreground.
 *
 * This is live-region chrome, so the two properties under test are deliberately
 * different ones. The FIRST is that the frame says who holds the input surface,
 * asserted through semantic roles and real cell attributes rather than ANSI
 * snapshots, so re-authoring a colour does not rewrite every expectation here.
 * The SECOND is that saying so changed NOTHING else: same rows, same columns,
 * same cursor, same text once the escapes are stripped. A colour that moved a
 * column would make `Screen` wrap a row the layout never counted, and one that
 * moved a row would push the live region past the terminal — which is why
 * "colour only" is asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest'
import { Composer, displayWidth, paint, Screen, setPalette, stripAnsi } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { CHROME_MIN_COLUMNS, rootFrame } from '../src/chrome.ts'
import { DEFAULT_PALETTE } from '../src/theme.ts'
import { createComposerView, type ComposerShellState } from '../src/views.ts'

const ROWS = 24
/** Wide enough for the framed composer at every width this spec uses. */
const WIDE = 80

/** The rounded-frame glyphs `frame()` draws; `context` labels sit between them. */
const BORDER = /[╭╰│─╮╯]/u

/**
 * The SGR parameters a role emits, as they appear in a rendered row.
 *
 * Read back from the palette rather than written out here, so these assertions
 * name a ROLE's appearance without this spec having to agree with the palette
 * about what amber is.
 * @param role - the semantic role to sample.
 * @returns its SGR parameter text, which is empty when the role emits nothing.
 */
function sgrOf(role: 'shell-input' | 'shell-active' | 'chrome' | 'error' | 'composer-title' | 'banner'): string {
  return /^\u001b\[([0-9;]*)m/u.exec(paint('x', role))?.[1] ?? ''
}

/**
 * Every visible character of a rendered row with the SGR state in force there.
 *
 * `frame()` paints a border in RUNS around its labels, so a border glyph's colour
 * is not a substring of the row but the state it was painted under. Reading that
 * state is what keeps these assertions semantic.
 * @param row - one rendered row, escapes intact.
 * @returns the stripped characters and the state each one was painted with.
 */
function characters(row: string): { chars: string[]; states: string[] } {
  const chars: string[] = []
  const states: string[] = []
  let state = ''
  for (const match of row.matchAll(/\u001b\[([0-9;]*)m|([\s\S])/gu)) {
    if (match[1] !== undefined) {
      state = match[1] === '' || match[1] === '0' ? '' : match[1]
      continue
    }
    chars.push(match[2] ?? '')
    states.push(state)
  }
  return { chars, states }
}

/**
 * The paint states of the characters making up one label inside a row.
 * @param row - one rendered row, escapes intact.
 * @param label - the label to find, which must appear exactly as written.
 * @returns one state per character of the label, or nothing when it is absent.
 */
function statesUnder(row: string, label: string): string[] {
  const { chars, states } = characters(row)
  const at = chars.join('').indexOf(label)
  return at < 0 ? [] : states.slice(at, at + [...label].length)
}

/**
 * Every paint state at which a row drew a frame border.
 * @param lines - rendered rows, escapes intact.
 * @returns the states found at border glyphs across them.
 */
function borderStates(lines: readonly string[]): string[] {
  return lines.flatMap(line => characters(line).states.filter((_, index) => BORDER.test(characters(line).chars[index] ?? '')))
}

/**
 * A composer holding `text`, with the cursor where typing it would leave it.
 * @param text - text to insert into the composer.
 * @returns the populated composer.
 */
function typed(text: string): Composer {
  const composer = new Composer()
  composer.handle({ kind: 'paste', text })
  return composer
}

/**
 * Render a composer in one of the shell states.
 *
 * `shellInput` is fixed off here: this spec is about the state that corresponds to
 * an operation EXISTING, and the pre-submit state has its own spec, wired the way
 * the attachment wires it rather than told a boolean.
 * @param composer - the buffer to draw.
 * @param state - what the runner reports about the reader's shell.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @returns the raw rows and the cursor the view reports for them.
 */
function drawn(composer: Composer, state: ComposerShellState, columns = WIDE, rows = ROWS): {
  lines: string[]
  cursor: { row: number; column: number } | undefined
} {
  const view = createComposerView(composer, '/work/repo', () => 1, () => ({ busy: false, busyEnter: 'queue' }), () => state)
  return { lines: view.render(columns, rows), cursor: view.cursor?.(columns, rows) }
}

/** The facts for an operation that exists, over whatever draft the reader holds. */
const ACTIVE: ComposerShellState = { shellActive: true, shellInput: false }
/** The facts for no operation and no shell draft: ordinary chrome. */
const IDLE: ComposerShellState = { shellActive: false, shellInput: false }

describe('the composer frame while a human shell operation is active', () => {
  it('wears the shell-active role on its borders, and chrome when none is active', () => {
    const active = sgrOf('shell-active')
    const chrome = sgrOf('chrome')
    // Two roles that share a colour today stay separate; if they ever stopped
    // sharing it, this assertion would still name which one the frame means.
    expect(active).not.toBe(sgrOf('error'))

    const on = borderStates(drawn(typed('ordinary prompt'), ACTIVE).lines)
    const off = borderStates(drawn(typed('ordinary prompt'), IDLE).lines)
    expect(on.length).toBeGreaterThan(0)
    expect([...new Set(on)]).toStrictEqual([active])
    expect([...new Set(off)]).toStrictEqual([chrome])
  })

  it('leaves the draft and both frame labels untouched', () => {
    const lines = drawn(typed('ordinary prompt'), ACTIVE).lines
    const body = lines.find(line => stripAnsi(line).includes('ordinary prompt')) ?? ''
    const top = lines.find(line => stripAnsi(line).includes('dshline')) ?? ''

    // The draft is an ordinary prompt that will be SENT to the model. Painting it
    // would assert it is shell source, which is the one thing it is not, so it
    // keeps the terminal's default foreground outright.
    const draftStates = characters(body).states.filter((_, index) => /[a-z]/u.test(characters(body).chars[index] ?? ''))
    expect(draftStates.length).toBeGreaterThan(0)
    expect(draftStates.every(state => state === '')).toBe(true)

    // The workspace basename and the product name keep their own roles, so the
    // frame reports ownership without repainting its labels.
    expect(statesUnder(top, 'dshline')).toStrictEqual(Array.from({ length: 'dshline'.length }, () => sgrOf('banner')))
    expect(statesUnder(top, 'repo')).toStrictEqual(Array.from({ length: 'repo'.length }, () => sgrOf('composer-title')))
  })

  it('is identical to the idle composer once the escapes are stripped', () => {
    // The strongest statement of "colour only": a reader with NO colour, a log,
    // and a screenshot all see the same composer in both states.
    for (const text of ['ordinary prompt', '', 'x'.repeat(200), 'one\ntwo\nthree', '界😀 wide']) {
      const composer = typed(text)
      const idle = drawn(composer, IDLE).lines
      const active = drawn(composer, ACTIVE).lines
      expect(active.map(stripAnsi), text).toStrictEqual(idle.map(stripAnsi))
    }
  })

  it('changes no geometry: same rows, same width, same cursor', () => {
    // Live-region chrome. Long drafts, wrapped drafts, tall pasted drafts and
    // every framed width are in this matrix, because a colour is only free if it
    // is free in the case that would have hurt.
    for (const text of ['ordinary prompt', 'x'.repeat(400), 'a\nb\nc\nd\ne\nf\ng\nh', '界😀'.repeat(50)]) {
      for (const columns of [WIDE, 60, 40, 30]) {
        const composer = typed(text)
        const idle = drawn(composer, IDLE, columns)
        const active = drawn(composer, ACTIVE, columns)
        const label = `${String(columns)}x${text.slice(0, 12)}`
        expect(active.lines, label).toHaveLength(idle.lines.length)
        expect(active.cursor, label).toStrictEqual(idle.cursor)
        for (const [index, row] of active.lines.entries()) {
          expect(displayWidth(row), `${label} row ${String(index)}`).toBe(displayWidth(idle.lines[index] ?? ''))
        }
      }
    }
  })

  it('takes the empty composer hint branch too, at every width that frames it', () => {
    // A different branch entirely: no draft, so the body is the hint rather than
    // a buffer. It must not be a place where the state goes missing.
    for (const columns of [WIDE, 40, CHROME_MIN_COLUMNS]) {
      const idle = drawn(new Composer(), IDLE, columns)
      const active = drawn(new Composer(), ACTIVE, columns)
      expect([...new Set(borderStates(active.lines))], String(columns)).toStrictEqual([sgrOf('shell-active')])
      expect(active.lines.map(stripAnsi)).toStrictEqual(idle.lines.map(stripAnsi))
      expect(active.cursor).toStrictEqual(idle.cursor)
    }
  })

  it('survives a resize from framed to narrow and back while active', () => {
    const composer = typed('resize me')
    const framed = drawn(composer, ACTIVE, WIDE)
    const narrow = drawn(composer, ACTIVE, CHROME_MIN_COLUMNS - 1)
    // Below the shared chrome floor the composer sheds its frame entirely, and it
    // must shed it the way it always does: no border, no added rows, no marker
    // invented to stand in for the colour it can no longer use.
    expect(stripAnsi(narrow.lines.join('\n'))).not.toMatch(/[╭╰│]/u)
    expect(narrow.lines).toStrictEqual(drawn(composer, IDLE, CHROME_MIN_COLUMNS - 1).lines)
    expect(drawn(composer, ACTIVE, WIDE)).toStrictEqual(framed)
  })

  it('emits nothing extra on a terminal that cannot show colour at all', () => {
    // Depth 0 is what a caller with no usable colour detection receives. The
    // indicator there is the text the live row already prints, so the composer
    // must not compensate with a marker of its own.
    const restore = setPalette(DEFAULT_PALETTE, 0)
    try {
      const composer = typed('no colour here')
      expect(drawn(composer, ACTIVE).lines).toStrictEqual(drawn(composer, IDLE).lines)
    } finally {
      restore()
    }
  })
})

describe('rootFrame border roles', () => {
  it('defaults to chrome for every caller that does not ask for something else', () => {
    const plain = rootFrame({ columns: 40, context: 'ctx', body: ['body'] })
    expect([...new Set(borderStates(plain))]).toStrictEqual([sgrOf('chrome')])
  })

  it('changes only the border glyphs when a role is chosen', () => {
    const options = { columns: 40, context: 'ctx', body: ['body'] }
    const plain = rootFrame(options)
    const active = rootFrame({ ...options, borderRole: 'shell-active' })
    expect(active.map(stripAnsi)).toStrictEqual(plain.map(stripAnsi))
    expect(active.map(displayWidth)).toStrictEqual(plain.map(displayWidth))
    expect(active).toHaveLength(plain.length)
  })
})

describe('in a real terminal', () => {
  it('colours the border cell amber, leaves the draft cell alone, and returns to chrome', async () => {
    const restore = setPalette(DEFAULT_PALETTE, 4)
    const emulator = createEmulator(WIDE, ROWS)
    try {
      const screen = new Screen(emulator.target)
      const composer = typed('an ordinary prompt')
      // A stand-in for `shellRun !== undefined`, held by the test so one view can
      // be watched through a whole lifecycle without a second attachment.
      const run = { active: true }
      const view = createComposerView(composer, '/work/repo', () => 1, () => ({ busy: false, busyEnter: 'queue' }), () => ({ shellActive: run.active, shellInput: false }))

      screen.setLive(view.render(WIDE, ROWS), view.cursor?.(WIDE, ROWS))
      // A committed control row, so the expected palette indices come from the
      // terminal's own rendering of the palette rather than from this spec's
      // belief about which index yellow is.
      screen.commit([`${paint('A', 'shell-active')}${paint('B', 'chrome')}${paint('C', 'error')}`])
      screen.setLive(view.render(WIDE, ROWS), view.cursor?.(WIDE, ROWS))
      await emulator.flush()

      const scrollback = await emulator.scrollback()
      const controlRow = scrollback.findIndex(row => row.startsWith('ABC'))
      expect(controlRow).toBeGreaterThanOrEqual(0)
      const shellIndex = (await emulator.cell(0, controlRow))?.fg
      const chromeIndex = (await emulator.cell(1, controlRow))?.fg
      const errorIndex = (await emulator.cell(2, controlRow))?.fg
      expect(shellIndex).toBeDefined()
      // Amber, and emphatically not the failure colour: a command that is still
      // running painted like `✗ shell exit 1` would be a claim a reader cannot
      // check and this project would rather not make.
      expect(shellIndex).not.toBe(errorIndex)
      expect(shellIndex).not.toBe(chromeIndex)

      const rows = (await emulator.screen()).map(row => row.trimEnd())
      const topRow = rows.findIndex(row => row.startsWith('╭'))
      const bodyRow = rows.findIndex(row => row.includes('an ordinary prompt'))
      expect(topRow).toBeGreaterThanOrEqual(0)
      expect(bodyRow).toBeGreaterThan(topRow)
      expect((await emulator.cell(0, topRow))?.fg).toBe(shellIndex)
      // The draft keeps the terminal's default foreground.
      expect((await emulator.cell(rows[bodyRow]?.indexOf('ordinary') ?? 0, bodyRow))?.fg).not.toBe(shellIndex)
      const activeCursor = await emulator.cursor()

      // Settling the shell puts the frame straight back to ordinary chrome, and
      // moves nothing while doing it.
      run.active = false
      screen.setLive(view.render(WIDE, ROWS), view.cursor?.(WIDE, ROWS))
      await emulator.flush()
      expect((await emulator.cell(0, topRow))?.fg).toBe(chromeIndex)
      expect(await emulator.cursor()).toStrictEqual(activeCursor)
    } finally {
      emulator.dispose()
      restore()
    }
  })
})
