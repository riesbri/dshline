/**
 * `Composer.leadingNonWhitespaceChar`: classifying a draft without reading it.
 *
 * The getter exists because its only plausible caller is one that must answer
 * "is this buffer shaped a particular way?" on every redraw, while the buffer
 * may hold a folded paste of a hundred thousand characters that frame is never
 * going to draw. Two properties follow from that, and they are tested apart
 * because they fail apart:
 *
 * 1. The ANSWER agrees with `value.trimStart()` for every buffer, including the
 *    exotic members of the whitespace set (NBSP, the byte-order mark, the East
 *    Asian space). A hand-written whitespace table would agree for `' '` and
 *    disagree for an ideographic space, and the caller that has to route the
 *    same line would then show one state and execute another.
 * 2. The COST is a bounded prefix scan. Asserted by observing that no
 *    whole-buffer getter is touched and that the answer is stable across
 *    repeats and correct after every mutation, rather than by a wall-clock
 *    threshold, which cannot fail reliably in CI.
 *
 * It lives in the renderer, which names no gesture: the decision about what a
 * leading character MEANS belongs to whoever holds the buffer.
 */

import { describe, expect, it } from 'vitest'
import { Composer } from '../src/composer.ts'
import type { Key } from '../src/keys.ts'

/**
 * Every code point `String.prototype.trim` strips: WhiteSpace and LineTerminator.
 *
 * Written as numbers rather than as characters on purpose, because most of them
 * are invisible in a source file and one of them is invisible in a terminal too.
 * That is exactly why this getter asks the platform instead of keeping a list.
 */
const WHITESPACE = [
  0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c,
  0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
].map(code => String.fromCodePoint(code))

/**
 * Code points that LOOK like whitespace — three of them render as nothing at all
 * — and are not. A getter that skipped these would answer "blank" for a buffer
 * whose own `trimStart()` does not, which is the drift this whole test exists to
 * make impossible.
 */
const NOT_WHITESPACE = [
  0x00, 0x1c, 0x85, 0x180e, 0x200b,
].map(code => String.fromCodePoint(code))

/**
 * A composer that records how its whole-buffer getters are used.
 *
 * The same instrument `composer-scale.spec.ts` uses for the layout: a subclass
 * cannot see inside the buffer, so what it can count is whether anything asked
 * for a JOIN, a split, or a rescan. That is the whole question this getter has
 * to answer without touching the document behind a fold.
 */
class AuditedComposer extends Composer {
  /** Times `value` was read. */
  valueReads = 0

  /** Times the display projection was read. */
  displayReads = 0

  override get value(): string {
    this.valueReads += 1
    return super.value
  }

  override display(): ReturnType<Composer['display']> {
    this.displayReads += 1
    return super.display()
  }
}

/** A composer holding `text`, reached the way a reader reaches it: by typing. */
function typed(text: string): Composer {
  const composer = new Composer()
  for (const char of text) composer.handle({ kind: 'text', text: char } as Key)
  return composer
}

describe('leadingNonWhitespaceChar', () => {
  it('is the first character trimStart leaves, for every buffer', () => {
    // The equivalence a consumer depends on, stated against the platform's own
    // definition rather than a transcription of it. `[...][0]` because the
    // buffer counts CODE POINTS: indexing a string with `[0]` would ask for half
    // of an astral character, which is the mistake this accessor exists not to
    // make twice.
    for (const text of [
      '', ' ', '  ', 'hello !world', '/foo!', 'git status', '!git status',
      '\t\n\v\f\r !pwd', '  !', '!', '界!', '😀', ' x', '! !', ' !',
    ]) {
      const composer = typed(text)
      expect(composer.leadingNonWhitespaceChar, JSON.stringify(text)).toBe([...text.trimStart()][0])
      // And the comparison a caller actually makes, which is the one that must
      // never contradict a caller's own `trimStart()` of the same line.
      expect(composer.leadingNonWhitespaceChar === '!', JSON.stringify(text))
        .toBe(text.trimStart().startsWith('!'))
    }
  })

  it('skips every character the platform calls whitespace, including the exotic ones', () => {
    // `String.prototype.trim` removes WhiteSpace and LineTerminator; each of
    // these is one of them, and a leading NBSP is as much a leading blank as a
    // space is. If any of these ever stopped being skipped, a caller's own
    // `trimStart()` would disagree with this getter about the very line it
    // routes.
    for (const space of WHITESPACE) {
      const composer = typed(`${space}${space}!rest`)
      expect(composer.leadingNonWhitespaceChar, JSON.stringify(space)).toBe('!')
      expect(composer.value.trimStart()[0], JSON.stringify(space)).toBe('!')
    }
  })

  it('stops at the characters that only look like whitespace', () => {
    for (const char of NOT_WHITESPACE) {
      expect(typed(`${char}rest`).leadingNonWhitespaceChar, JSON.stringify(char)).toBe(char)
      expect(typed(`${char}`).leadingNonWhitespaceChar, JSON.stringify(char)).toBe(char)
    }
    expect(typed('!rest').leadingNonWhitespaceChar).toBe('!')
    expect(typed('arest').leadingNonWhitespaceChar).toBe('a')
  })

  it('answers for an empty and a whitespace-only buffer', () => {
    expect(new Composer().leadingNonWhitespaceChar).toBeUndefined()
    expect(typed(' \t\n').leadingNonWhitespaceChar).toBeUndefined()
    expect(typed(WHITESPACE.join('')).leadingNonWhitespaceChar).toBeUndefined()
  })

  it('never touches the hidden text of a folded paste, and is stable across repeats', () => {
    // A large paste draws as one token; the characters behind it must stay
    // unreachable from a redraw. Two extra reads of the same revision are the
    // shape of a spinner tick arriving between keystrokes.
    const composer = new AuditedComposer()
    const pasted = Array.from({ length: 4000 }, (_, index) => `line ${String(index)}`).join('\n')
    composer.handle({ kind: 'paste', text: pasted })
    expect(composer.display().text).not.toContain('line 3999')

    composer.valueReads = 0
    composer.displayReads = 0
    expect(composer.leadingNonWhitespaceChar).toBe('l')
    expect(composer.leadingNonWhitespaceChar).toBe('l')
    expect(composer.leadingNonWhitespaceChar).toBe('l')
    expect(composer.valueReads).toBe(0)
    expect(composer.displayReads).toBe(0)
  })

  it('follows the buffer through every mutation, including undo and redo', () => {
    // A cached answer that outlived the revision it was computed for would be a
    // silent lie, and this is the only place that could happen. The steps are
    // real keystrokes rather than direct assignments, because it is the
    // keystrokes that move the revision the cache is keyed on.
    const composer = new Composer()
    expect(composer.leadingNonWhitespaceChar).toBeUndefined()
    composer.handle({ kind: 'text', text: 'hello' })
    expect(composer.leadingNonWhitespaceChar).toBe('h')
    composer.handle({ kind: 'key', name: 'ctrl-u' })
    expect(composer.leadingNonWhitespaceChar).toBeUndefined()
    composer.handle({ kind: 'text', text: '!git status' })
    expect(composer.leadingNonWhitespaceChar).toBe('!')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.leadingNonWhitespaceChar).toBeUndefined()
    composer.handle({ kind: 'key', name: 'ctrl-y' })
    expect(composer.leadingNonWhitespaceChar).toBe('!')
    composer.handle({ kind: 'key', name: 'backspace' })
    expect(composer.leadingNonWhitespaceChar).toBe('!')
    composer.handle({ kind: 'key', name: 'home' })
    expect(composer.leadingNonWhitespaceChar).toBe('!')
    composer.handle({ kind: 'key', name: 'delete' })
    expect(composer.leadingNonWhitespaceChar).toBe('g')
    composer.set('  !restored')
    expect(composer.leadingNonWhitespaceChar).toBe('!')
    composer.clear()
    expect(composer.leadingNonWhitespaceChar).toBeUndefined()
    composer.handle({ kind: 'paste', text: ' \t!pasted' })
    expect(composer.leadingNonWhitespaceChar).toBe('!')
  })

  it('answers the same for a draft nobody has edited, which is what a redraw sees', () => {
    // Cursor motion bumps the revision without touching the text, so the answer
    // must not depend on how many times the reader has moved.
    const composer = typed('!git status')
    for (let index = 0; index < 5; index += 1) composer.handle({ kind: 'key', name: 'left' })
    expect(composer.leadingNonWhitespaceChar).toBe('!')
    for (let index = 0; index < 5; index += 1) composer.handle({ kind: 'key', name: 'right' })
    expect(composer.leadingNonWhitespaceChar).toBe('!')
  })
})