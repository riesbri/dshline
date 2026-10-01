/**
 * The composer frame while the DRAFT is a human shell command and nothing has
 * been submitted yet.
 *
 * This is the half of the shell affordance that appears before the runtime does.
 * `!pnpm test` can settle faster than a reader can look at it, so a frame that
 * only ever changed while a command was RUNNING was reporting a state most shell
 * commands were never in when it was seen. What must be true here is therefore
 * narrow and checkable:
 *
 * 1. The frame changes on the keystroke that makes the draft a shell gesture —
 *    not on submission, not on a timer, not after another key.
 * 2. It changes on exactly the drafts {@link parseShellCommand} would route as
 *    shell, and on no others. Two implementations of "what is a shell gesture"
 *    is the one shape this feature could ship with a real bug in, so the two are
 *    asserted equal over a matrix rather than merely similar in the examples.
 * 3. Nothing else about the composer moves. Same rows, same columns, same
 *    cursor, same text once the escapes are stripped — because a colour that
 *    added a column would make `Screen` wrap a row the live-region budget never
 *    counted, and a repainted draft would stop being ordinary editable input.
 *
 * The view is wired the way `attachment.ts` wires it — `isShellDraft(composer)`
 * read per paint, `shellRun !== undefined` read per paint — rather than being
 * handed a boolean the test chose, so what these tests exercise is the seam that
 * ships. `shell-attachment.spec.ts` then drives the same thing through real
 * keystrokes into a real attachment.
 */

import { describe, expect, it } from 'vitest'
import { Composer, displayWidth, paint, Screen, setPalette, stripAnsi, type Key } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { CHROME_MIN_COLUMNS } from '../src/chrome.ts'
import { isShellDraft, parseShellCommand } from '../src/shell-command.ts'
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
 * Every paint state at which the rendered rows drew a frame border.
 * @param lines - rendered rows, escapes intact.
 * @returns the distinct states found at border glyphs across them.
 */
function borderStates(lines: readonly string[]): string[] {
  return [...new Set(lines.flatMap(line => {
    const { chars, states } = characters(line)
    return states.filter((_, index) => BORDER.test(chars[index] ?? ''))
  }))]
}

/** The hint an unfilled composer gets; nothing here varies it. */
const IDLE_HINT = (): { busy: boolean; busyEnter: 'queue' } => ({ busy: false, busyEnter: 'queue' })

/**
 * A composer view wired the way the attachment wires it.
 *
 * `shellActive` stands in for `shellRun !== undefined` and is mutable so one view
 * can be watched through a whole lifecycle; `shellInput` is derived from the
 * buffer on every paint, exactly as the shipped callback derives it.
 * @param composer - the buffer being edited.
 * @param shellActive - the runner's ownership flag.
 * @returns the view.
 */
function draftView(composer: Composer, shellActive: { active: boolean } = { active: false }) {
  return createComposerView(composer, '/work/repo', () => 1, IDLE_HINT,
    (): ComposerShellState => ({ shellActive: shellActive.active, shellInput: isShellDraft(composer) }))
}

/**
 * A composer view told fixed presentation facts, for the questions that are about
 * the frame alone rather than about how the fact is derived.
 * @param composer - the buffer being edited.
 * @param facts - what the runner reports.
 * @returns the view.
 */
function toldView(composer: Composer, facts: ComposerShellState) {
  return createComposerView(composer, '/work/repo', () => 1, IDLE_HINT, () => facts)
}

/**
 * The role a draft's frame is wearing, through the production wiring.
 * @param composer - the buffer being edited.
 * @param shellActive - the runner's ownership flag.
 * @param columns - terminal width.
 * @returns the single border role found, or an empty string when unframed.
 */
function roleOf(composer: Composer, shellActive: { active: boolean } = { active: false }, columns = WIDE): string {
  return borderStates(draftView(composer, shellActive).render(columns, ROWS))[0] ?? ''
}

/**
 * Type `text` one keystroke at a time, as a terminal delivers it.
 * @param composer - the buffer to type into.
 * @param text - the characters to send.
 * @returns the same composer, for chaining.
 */
function type(composer: Composer, text: string): Composer {
  for (const char of text) composer.handle({ kind: 'text', text: char } as Key)
  return composer
}

/** A composer holding `text`, as if the reader had pasted all of it. */
function typed(text: string): Composer {
  const composer = new Composer()
  composer.handle({ kind: 'paste', text })
  return composer
}

/**
 * A composer that counts the whole-buffer reads the frame asks of it.
 *
 * The layout is already kept off `value` by its own revision memo; the shell
 * state must not undo that. Counting is stronger than timing and cannot flake,
 * and it is the property a redraw actually has: a spinner tick arriving between
 * two keystrokes must not join a draft that may hold a folded paste.
 */
class AuditedComposer extends Composer {
  /** Times the buffer was joined into a string. */
  joins = 0

  /** Times the buffer was split into logical lines. */
  splits = 0

  override get value(): string {
    this.joins += 1
    return super.value
  }

  override get lines(): string[] {
    this.splits += 1
    return super.lines
  }
}

describe('the composer frame while the draft is a shell gesture', () => {
  it('wears shell-input from the keystroke that makes it one, before anything is submitted', () => {
    const composer = new Composer()
    expect(roleOf(composer)).toBe(sgrOf('chrome'))
    composer.handle({ kind: 'text', text: '!' } as Key)
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
    type(composer, 'git status')
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
    // Amber, not the failure colour. A command being written is not an outcome.
    expect(sgrOf('shell-input')).not.toBe(sgrOf('error'))
  })

  it('waits for the bang itself while the reader types leading whitespace', () => {
    const composer = new Composer()
    for (const space of [' ', ' ', '\t', ' ']) {
      composer.handle({ kind: 'text', text: space } as Key)
      expect(roleOf(composer), JSON.stringify(space)).toBe(sgrOf('chrome'))
    }
    composer.handle({ kind: 'text', text: '!' } as Key)
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
  })

  it('leaves an ordinary prompt ordinary, however it is punctuated', () => {
    for (const text of ['hello !', 'hello !world', '/foo!', 'git status', 'x!git status', 'a!b']) {
      expect(roleOf(typed(text)), JSON.stringify(text)).toBe(sgrOf('chrome'))
    }
    expect(roleOf(new Composer())).toBe(sgrOf('chrome'))
  })

  it('takes a bare bang, which routes to a local hint rather than to a process', () => {
    // Submitting this never starts an operation, but it IS the shell gesture and
    // not a model prompt, so the frame says so while it is being composed.
    expect(roleOf(typed('!'))).toBe(sgrOf('shell-input'))
    expect(roleOf(typed('   !'))).toBe(sgrOf('shell-input'))
    expect(roleOf(typed('   !   '))).toBe(sgrOf('shell-input'))
  })

  it('follows a paste exactly as it follows typing', () => {
    for (const text of ['!git status', '   !git status', '\t!pwd', '!', '!\nsecond\nline', '\n  !ls -la', '!!word']) {
      expect(roleOf(typed(text)), JSON.stringify(text)).toBe(sgrOf('shell-input'))
    }
    for (const text of ['hello !', '/foo!', 'git status', 'x!git status']) {
      expect(roleOf(typed(text)), JSON.stringify(text)).toBe(sgrOf('chrome'))
    }
  })

  it('agrees with submission routing for every draft', () => {
    // THE test this feature could fail without anyone noticing: two answers to
    // "is this a shell gesture?", one drawn on the frame and one used to route the
    // submission. If either is changed without the other, this fails by name.
    const drafts = [
      '!git status', '   !git status', '\t!pwd', '!', '!  ', '  !  ',
      '!!word', '!\nsecond', '\n\n  !ls', 'hello !world', '/foo!', 'git status',
      '', ' ', '\t', ' ! ', '界!', 'x!git status', ' !git status', '!git status ',
      ' !nbsp', '﻿!bom',
    ]
    for (const draft of drafts) {
      const composer = typed(draft)
      expect(isShellDraft(composer), `draft ${JSON.stringify(draft)}`)
        .toBe(parseShellCommand(draft) !== undefined)
      // Asked again after the frame has already read it: the answer is cached per
      // revision, and a cache must not outlive the revision it was computed for.
      expect(isShellDraft(composer), `draft ${JSON.stringify(draft)} again`).toBe(parseShellCommand(draft) !== undefined)
      expect(roleOf(composer), `frame for ${JSON.stringify(draft)}`)
        .toBe(parseShellCommand(draft) !== undefined ? sgrOf('shell-input') : sgrOf('chrome'))
      composer.handle({ kind: 'text', text: 'x' } as Key)
      const extended = `${draft}x`
      expect(isShellDraft(composer), `after typing into ${JSON.stringify(draft)}`)
        .toBe(parseShellCommand(extended) !== undefined)
    }
  })

  it('returns to ordinary chrome the instant the bang is deleted, and back on undo', () => {
    const composer = typed('!git status')
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))

    composer.handle({ kind: 'key', name: 'home' } as Key)
    composer.handle({ kind: 'key', name: 'delete' } as Key)
    expect(composer.value).toBe('git status')
    expect(roleOf(composer)).toBe(sgrOf('chrome'))

    composer.handle({ kind: 'key', name: 'ctrl-z' } as Key)
    expect(composer.value).toBe('!git status')
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
  })

  it('follows undo of the typing itself, and redo back into it', () => {
    const composer = new Composer()
    type(composer, 'hello')
    expect(roleOf(composer)).toBe(sgrOf('chrome'))
    composer.handle({ kind: 'key', name: 'ctrl-u' } as Key)
    expect(roleOf(composer)).toBe(sgrOf('chrome'))
    type(composer, '!git status')
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
    composer.handle({ kind: 'key', name: 'ctrl-z' } as Key)
    expect(roleOf(composer)).toBe(sgrOf('chrome'))
    composer.handle({ kind: 'key', name: 'ctrl-y' } as Key)
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
  })

  it('follows a recalled line, whichever route recalled it', () => {
    // `↑` history and ctrl-r search both arrive through `set`, which is a
    // baseline rather than an edit: there is no keystroke to observe, only the
    // next redraw, so the frame has to answer from the buffer alone.
    const composer = new Composer()
    composer.set('!git status')
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
    composer.set('explain this function')
    expect(roleOf(composer)).toBe(sgrOf('chrome'))
    composer.set('  !pnpm test')
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
    composer.set('')
    expect(roleOf(composer)).toBe(sgrOf('chrome'))
  })

  it('does not change when the cursor moves inside the draft', () => {
    const composer = typed('!git status')
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
    for (const name of ['left', 'left', 'up', 'down', 'end', 'home', 'ctrl-a'] as const) {
      composer.handle({ kind: 'key', name } as Key)
      expect(roleOf(composer), name).toBe(sgrOf('shell-input'))
    }
  })

  it('follows an edit to the leading whitespace exactly as the parser does', () => {
    const composer = new Composer()
    type(composer, '  !pwd')
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
    composer.handle({ kind: 'key', name: 'home' } as Key)
    for (let index = 0; index < 2; index += 1) composer.handle({ kind: 'key', name: 'delete' } as Key)
    expect(composer.value).toBe('!pwd')
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
    composer.handle({ kind: 'key', name: 'delete' } as Key)
    expect(composer.value).toBe('pwd')
    expect(roleOf(composer)).toBe(sgrOf('chrome'))
    composer.handle({ kind: 'key', name: 'ctrl-z' } as Key)
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
  })

  it('changes to ordinary chrome the moment a pasted bang stops being the first character', () => {
    // The edit that has to be seen to be believed: `!git status` is shell input,
    // `x!git status` is a sentence about a bang, and back again.
    const composer = new Composer()
    type(composer, '!git status')
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
    composer.handle({ kind: 'key', name: 'home' } as Key)
    composer.handle({ kind: 'key', name: 'left' } as Key)
    type(composer, 'x')
    expect(composer.value).toBe('x!git status')
    expect(roleOf(composer)).toBe(sgrOf('chrome'))
    composer.handle({ kind: 'key', name: 'backspace' } as Key)
    expect(roleOf(composer)).toBe(sgrOf('shell-input'))
  })
})

describe('what shell-input leaves alone', () => {
  it('keeps the draft, the gutter mark and both frame labels untouched', () => {
    const composer = typed('!git status')
    const lines = draftView(composer).render(WIDE, ROWS)
    const body = lines.find(line => stripAnsi(line).includes('git status')) ?? ''
    const top = lines.find(line => stripAnsi(line).includes('dshline')) ?? ''

    // Editable input stays the terminal's default foreground, and so does the
    // gutter in front of it. The frame carries the mode; repainting the draft
    // would mean this is no longer an ordinary prompt composer with a colour on
    // it, and the caret would still be sitting in the middle of ordinary text.
    const { chars, states } = characters(body)
    expect(chars.join('')).toContain('› !git status')
    const typedStates = chars.flatMap((char, index) => (/[a-z!]/u.test(char) ? [states[index] ?? ''] : []))
    expect(typedStates.length).toBeGreaterThan(0)
    expect(typedStates.every(state => state === '')).toBe(true)

    // The workspace name and the product name keep their own roles.
    const topRow = characters(top)
    const topText = topRow.chars.join('')
    const banner = topText.indexOf('dshline')
    const workspace = topText.indexOf('repo')
    expect(banner).toBeGreaterThanOrEqual(0)
    expect(workspace).toBeGreaterThanOrEqual(0)
    expect(topRow.states.slice(banner, banner + 'dshline'.length)).toStrictEqual(Array.from({ length: 'dshline'.length }, () => sgrOf('banner')))
    expect(topRow.states.slice(workspace, workspace + 'repo'.length)).toStrictEqual(Array.from({ length: 'repo'.length }, () => sgrOf('composer-title')))
  })

  it('is identical to the same draft in ordinary chrome once the escapes are stripped', () => {
    for (const text of ['!git status', '', `!${'x'.repeat(200)}`, '!one\ntwo\nthree', '!界😀 wide']) {
      const composer = typed(text)
      const plain = toldView(composer, { shellActive: false, shellInput: false }).render(WIDE, ROWS)
      const shell = toldView(composer, { shellActive: false, shellInput: true }).render(WIDE, ROWS)
      expect(shell.map(stripAnsi), text).toStrictEqual(plain.map(stripAnsi))
    }
  })

  it('changes no geometry: same rows, same width, same cursor', () => {
    // The identical guarantee shell-active already makes, over the same matrix.
    // A colour is only free if it is free in the case that would have hurt.
    for (const text of ['!git status', 'ordinary prompt', `!${'x'.repeat(400)}`, '!a\nb\nc\nd\ne\nf\ng\nh', `!${'界😀'.repeat(50)}`]) {
      for (const columns of [WIDE, 60, 40, 30]) {
        const composer = typed(text)
        const plain = toldView(composer, { shellActive: false, shellInput: false })
        const shell = toldView(composer, { shellActive: false, shellInput: true })
        const label = `${String(columns)}x${text.slice(0, 12)}`
        const plainRows = plain.render(columns, ROWS)
        const shellRows = shell.render(columns, ROWS)
        expect(shellRows, label).toHaveLength(plainRows.length)
        expect(shell.cursor?.(columns, ROWS), label).toStrictEqual(plain.cursor?.(columns, ROWS))
        for (const [index, row] of shellRows.entries()) {
          expect(displayWidth(row), `${label} row ${String(index)}`).toBe(displayWidth(plainRows[index] ?? ''))
        }
      }
    }
  })

  it('takes the empty composer hint branch too, at every width that frames it', () => {
    // A different branch entirely: no draft, so the body is the hint. shell-input
    // cannot be reached with an empty buffer — an empty draft is not a shell
    // gesture — but the border role is chosen in one place for both branches, and
    // this proves that place exists.
    for (const columns of [WIDE, 40, CHROME_MIN_COLUMNS]) {
      const composer = new Composer()
      const plain = toldView(composer, { shellActive: false, shellInput: false }).render(columns, ROWS)
      const shell = toldView(composer, { shellActive: false, shellInput: true }).render(columns, ROWS)
      expect(shell.map(stripAnsi), String(columns)).toStrictEqual(plain.map(stripAnsi))
      expect(borderStates(shell), String(columns)).toStrictEqual([sgrOf('shell-input')])
    }
  })

  it('sheds the frame below the chrome floor, exactly as every other state does', () => {
    // No colour to spend and no room to spend it in. The typed `!` is still on
    // screen as ordinary text, which is the indicator this mode never removes.
    const composer = typed('!git status')
    const narrow = toldView(composer, { shellActive: false, shellInput: true }).render(CHROME_MIN_COLUMNS - 1, ROWS)
    expect(stripAnsi(narrow.join('\n'))).not.toMatch(/[╭╰│]/u)
    expect(narrow).toStrictEqual(toldView(composer, { shellActive: false, shellInput: false }).render(CHROME_MIN_COLUMNS - 1, ROWS))
    // The bang is still on screen as ordinary text, wrapped as it always wraps.
    expect(stripAnsi(narrow.join(''))).toContain('!git status')
  })

  it('survives a resize from framed to narrow and back, unchanged either way', () => {
    const composer = typed('!resize me')
    const drawn = draftView(composer)
    const framed = drawn.render(WIDE, ROWS)
    expect(borderStates(framed)).toStrictEqual([sgrOf('shell-input')])
    drawn.render(CHROME_MIN_COLUMNS - 1, ROWS)
    drawn.render(WIDE, ROWS)
    expect(drawn.render(WIDE, ROWS)).toStrictEqual(framed)
  })

  it('emits nothing extra on a terminal that cannot show colour at all', () => {
    // At depth 0 the draft itself visibly contains the `!`, so the textual cue
    // survives without inventing a marker the framed composer does not otherwise
    // have.
    const restore = setPalette(DEFAULT_PALETTE, 0)
    try {
      const composer = typed('!no colour here')
      expect(draftView(composer).render(WIDE, ROWS))
        .toStrictEqual(toldView(composer, { shellActive: false, shellInput: false }).render(WIDE, ROWS))
    } finally {
      restore()
    }
  })
})

describe('how the two shell states choose', () => {
  /**
   * A palette that tells the two roles apart, installed for the duration.
   *
   * They share amber today, which is a palette decision and not a runtime one:
   * asserting precedence against a palette that hides the difference would only
   * prove that two identical colours are identical. Giving `shell-input` a colour
   * of its own is exactly the freedom the separate roles exist to preserve, and it
   * is what lets these assertions fail at all.
   */
  function distinguishing(): () => void {
    return setPalette({
      ...DEFAULT_PALETTE,
      id: 'test-split-shell-roles',
      roles: { ...DEFAULT_PALETTE.roles, 'shell-input': { ansi: [36] } },
    }, 4)
  }

  it('lets an operation that exists win over a draft that looks like one', () => {
    const restore = distinguishing()
    try {
      const composer = typed('!next')
      const facts: ComposerShellState = { shellActive: true, shellInput: true }
      const shown = (): string[] => borderStates(toldView(composer, facts).render(WIDE, ROWS))
      expect(shown()).toStrictEqual([sgrOf('shell-active')])
      // Ownership, not typing: while the first command runs, the second draft is
      // still a second draft, and submitting it is refused by the same rule.
      facts.shellActive = false
      expect(shown()).toStrictEqual([sgrOf('shell-input')])
      facts.shellInput = false
      expect(shown()).toStrictEqual([sgrOf('chrome')])
    } finally {
      restore()
    }
  })

  it('falls back to shell-input when the operation settles and a bang draft remains', () => {
    const restore = distinguishing()
    try {
      const composer = typed('!next')
      const run = { active: true }
      expect(borderStates(draftView(composer, run).render(WIDE, ROWS))).toStrictEqual([sgrOf('shell-active')])
      run.active = false
      expect(borderStates(draftView(composer, run).render(WIDE, ROWS))).toStrictEqual([sgrOf('shell-input')])
    } finally {
      restore()
    }
  })

  it('returns to ordinary chrome when the operation settles over an ordinary draft', () => {
    const restore = distinguishing()
    try {
      const composer = typed('explain this function')
      const run = { active: true }
      expect(borderStates(draftView(composer, run).render(WIDE, ROWS))).toStrictEqual([sgrOf('shell-active')])
      run.active = false
      expect(borderStates(draftView(composer, run).render(WIDE, ROWS))).toStrictEqual([sgrOf('chrome')])
    } finally {
      restore()
    }
  })

  it('never joins the buffer to decide, however many times it redraws', () => {
    // The property a spinner tick could break: the layout already avoids joining
    // the draft, and a frame that classified shell input by joining it would put
    // back the cost `revision` exists to avoid — worst exactly where the draft is
    // largest, which is where a folded paste hides a whole document behind a token.
    const composer = new AuditedComposer()
    const source = ['!printf', ...Array.from({ length: 3000 }, (_, index) => `line ${String(index)}`)].join('\n')
    composer.handle({ kind: 'paste', text: source })
    const drawn = draftView(composer)

    composer.joins = 0
    composer.splits = 0
    for (let tick = 0; tick < 25; tick += 1) {
      drawn.render(WIDE, ROWS)
      drawn.cursor?.(WIDE, ROWS)
    }
    expect(borderStates(drawn.render(WIDE, ROWS))).toStrictEqual([sgrOf('shell-input')])
    expect(composer.joins).toBe(0)
    expect(composer.splits).toBe(0)

    // One edit moves the revision once, and the redraws that follow still never
    // touch the buffer: the answer is cached against the revision, not against
    // the frame.
    composer.handle({ kind: 'text', text: 'x' } as Key)
    composer.joins = 0
    composer.splits = 0
    for (let tick = 0; tick < 25; tick += 1) drawn.render(WIDE, ROWS)
    expect(composer.joins).toBe(0)
    expect(composer.splits).toBe(0)
    expect(borderStates(drawn.render(WIDE, ROWS))).toStrictEqual([sgrOf('shell-input')])
  })
})

describe('in a real terminal', () => {
  it('colours the border cell while a shell draft is composed and restores it on backspace', async () => {
    // The claim a person actually checks: the frame is amber before enter is
    // ever pressed, and ordinary again the moment the bang is gone. Read from
    // terminal CELLS rather than from the bytes, because the bytes are what this
    // spec wrote and the cell is what the reader sees.
    const restore = setPalette(DEFAULT_PALETTE, 4)
    const emulator = createEmulator(WIDE, ROWS)
    try {
      const screen = new Screen(emulator.target)
      const composer = new Composer()
      const drawn = draftView(composer)
      const show = async (): Promise<{ row: number; cursor: { x: number; y: number } }> => {
        screen.setLive(drawn.render(WIDE, ROWS), drawn.cursor?.(WIDE, ROWS))
        await emulator.flush()
        const rows = (await emulator.screen()).map(row => row.trimEnd())
        return { row: rows.findIndex(row => row.startsWith('╭')), cursor: await emulator.cursor() }
      }

      // A committed control row, so the expected colours come from the terminal's
      // own rendering of the palette rather than from this spec's belief about it.
      screen.commit([`${paint('A', 'shell-input')}${paint('B', 'chrome')}${paint('C', 'error')}`])
      const control = (await emulator.scrollback()).findIndex(row => row.startsWith('ABC'))
      expect(control).toBeGreaterThanOrEqual(0)
      const shell = (await emulator.cell(0, control))?.fg
      const chrome = (await emulator.cell(1, control))?.fg
      const error = (await emulator.cell(2, control))?.fg
      expect(shell).toBeDefined()
      expect(shell).not.toBe(chrome)
      expect(shell).not.toBe(error)

      const before = await show()
      expect(before.row).toBeGreaterThanOrEqual(0)
      expect((await emulator.cell(0, before.row))?.fg).toBe(chrome)

      composer.handle({ kind: 'text', text: '!' } as Key)
      const typing = await show()
      expect((await emulator.cell(0, typing.row))?.fg).toBe(shell)
      // The typed bang itself is ordinary text: it is the cue, and it is editable.
      const rows = (await emulator.screen()).map(row => row.trimEnd())
      const body = rows.findIndex(row => row.includes('!'))
      expect(body).toBeGreaterThan(typing.row)
      expect((await emulator.cell(rows[body]?.indexOf('!') ?? 0, body))?.fg).not.toBe(shell)

      composer.handle({ kind: 'key', name: 'backspace' } as Key)
      const undone = await show()
      expect((await emulator.cell(0, undone.row))?.fg).toBe(chrome)
      // Deleting the bang moves the caret with it and nothing else: the frame
      // returning to chrome is not a layout change.
      expect(undone.cursor).toStrictEqual(before.cursor)
    } finally {
      emulator.dispose()
      restore()
    }
  })
})