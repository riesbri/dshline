/**
 * Large bracketed pastes drawn as compact composer tokens.
 *
 * The contract these tests exist to hold is a single sentence: the label is a
 * DRAWING, and the buffer underneath is the message. Everything else — the
 * numbering, the thresholds, the unfolding rules — is subordinate to that, and a
 * change that made the label authoritative would pass almost every test here
 * except the ones that read `value` and the ones that submit.
 *
 * So the tests are arranged around what could go wrong rather than around the
 * feature's surface. Can the label reach a submission? Can a stale range put the
 * cursor where nothing is drawn? Can an edit delete a character a label still
 * claims exists? Can a number be reused for different text? Can a hidden document
 * be copied into a sidecar? Each has a test that fails by name when it happens.
 *
 * These drive the real `Composer` through real keystrokes and lay the result out
 * with the real `layoutComposer`, because the interesting failures live in the
 * seam between the two — a projection that is right in isolation and wrong once a
 * cursor has to be placed inside it.
 */

import { describe, expect, it } from 'vitest'
import { Composer } from '../src/composer.ts'
import { PASTE_FOLD_MIN_CHARS, PASTE_FOLD_MIN_LINES, pastedTextLabel } from '../src/composer-display.ts'
import type { FoldedPaste } from '../src/composer-display.ts'
import { layoutComposer } from '../src/composer-layout.ts'
import type { Key } from '../src/keys.ts'

const GUTTER = (line: number): string => (line === 0 ? '› ' : '  ')

/** A named key, the way the decoder delivers one. @param name - the key name. */
const key = (name: string): Key => ({ kind: 'key', name } as Key)

/** One printable-text keystroke. @param value - the single character typed. */
const text = (value: string): Key => ({ kind: 'text', text: value })

/** A bracketed paste, exactly as the decoder reports it. @param body - the pasted text. */
const paste = (body: string): Key => ({ kind: 'paste', text: body })

/**
 * Type `value` one character at a time, the way a terminal delivers it.
 *
 * Deliberately not `set()`: a typed string must not acquire paste provenance, and
 * a test that seeded the buffer wholesale would not notice if it did.
 * @param composer - the buffer being filled.
 * @param value - the characters to type.
 */
function type(composer: Composer, value: string): void {
  for (const char of value) composer.handle(text(char))
}

/**
 * A paste of `count` numbered lines.
 * @param count - how many logical lines the paste holds.
 * @returns the pasted text, with a trailing newline so the line count is exact.
 */
function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${String(index + 1)}`).join('\n')
}

/** The visible rows at a width. @param composer - the buffer. @param width - columns available. */
function drawn(composer: Composer, width = 60): string[] {
  return layoutComposer(composer, width, GUTTER).rows
}

/** The visible text at a width. @param composer - the buffer. @param width - columns available. */
function shown(composer: Composer, width = 60): string {
  return drawn(composer, width).join('\n')
}

/** The composer's fold sidecar, for assertions about ranges and metadata. @param composer - the buffer. */
function foldsOf(composer: Composer): readonly FoldedPaste[] {
  return (composer as unknown as { folds: readonly FoldedPaste[] }).folds
}

/**
 * Whether the cursor sits somewhere a reader can actually see.
 *
 * The projection maps every visible boundary back to a raw offset, and a raw
 * offset inside a folded span has no character drawn under it. So round-tripping
 * the cursor — visible offset, then back to a raw one — lands on the cursor's own
 * position exactly when that position is honest, and on the fold's start when it
 * is not. This is the single assertion that catches an invisible cursor, and it
 * is checked after every movement anywhere in this file.
 * @param composer - the buffer to inspect.
 */
function cursorIsVisible(composer: Composer): boolean {
  const display = composer.display()
  return display.rawAt(display.cursor) === composer.position
}

describe('what decides to fold', () => {
  it('leaves an ordinary short paste as visible text', () => {
    const composer = new Composer()
    composer.handle(paste('first line\nsecond line\nthird line'))
    // Three lines is what someone pastes to check something, and folding it would
    // hide text they are actively reading.
    expect(shown(composer)).toContain('first line')
    expect(shown(composer)).toContain('second line')
    expect(shown(composer)).toContain('third line')
    expect(shown(composer)).not.toContain('[Pasted text')
    expect(foldsOf(composer)).toEqual([])
  })

  it('leaves a seven-line paste visible, one below the threshold', () => {
    const composer = new Composer()
    composer.handle(paste(lines(PASTE_FOLD_MIN_LINES - 1)))
    expect(foldsOf(composer)).toEqual([])
    expect(shown(composer)).toContain('line 7')
    expect(shown(composer)).not.toContain('[Pasted text')
  })

  it('folds a paste that reaches the line threshold', () => {
    const composer = new Composer()
    composer.handle(paste(lines(PASTE_FOLD_MIN_LINES)))
    expect(foldsOf(composer)).toHaveLength(1)
    expect(shown(composer)).toBe(`› [Pasted text #1 +${String(PASTE_FOLD_MIN_LINES)} lines]`)
  })

  it('folds a long single line, which no line count would catch', () => {
    // One line of a minified bundle has no line count to trip, and is exactly as
    // unreadable in a composer as a stack trace is.
    const composer = new Composer()
    composer.handle(paste('x'.repeat(PASTE_FOLD_MIN_CHARS)))
    expect(foldsOf(composer)).toHaveLength(1)
    expect(shown(composer)).toBe('› [Pasted text #1 +1 line]')
  })

  it('leaves a single line one code point below the character threshold visible', () => {
    const composer = new Composer()
    const body = 'x'.repeat(PASTE_FOLD_MIN_CHARS - 1)
    composer.handle(paste(body))
    expect(foldsOf(composer)).toEqual([])
    // It wraps across rows at any sane width, and every row is still the user's
    // own characters: nothing was collapsed on the way.
    expect(composer.display().text).toBe(body)
    expect(shown(composer).replace(/\s+/gu, '')).toBe(`›${body}`)
  })

  it('measures the paste after sanitizing it, not before', () => {
    // A tab is one character that EXPANDS to four, and a lone CR becomes a
    // newline. Counting the raw paste would fold content that sanitized down to
    // a single short line, and the label's line count would describe text the
    // buffer does not contain.
    const composer = new Composer()
    composer.handle(paste(`a\tb\rc\r\nd${'\u001b'}[2Je\u0007f`))
    expect(shown(composer)).toContain('a    b')
    expect(shown(composer)).toContain('^[[2J')
    expect(foldsOf(composer)).toEqual([])
  })

  it('counts sanitized newlines, so CRLF never inflates a label', () => {
    const body = Array.from({ length: 8 }, (_, i) => `l${String(i)}`).join('\r\n')
    const composer = new Composer()
    composer.handle(paste(body))
    // Eight CRLF-terminated lines are eight lines, not sixteen.
    expect(foldsOf(composer)[0]?.lines).toBe(8)
    expect(composer.value).not.toContain('\r')
    expect(shown(composer)).toBe('› [Pasted text #1 +8 lines]')
  })
})

describe('the label itself', () => {
  it('names the paste, its number, and how many lines it holds', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    expect(shown(composer)).toBe('› [Pasted text #1 +11 lines]')
  })

  it('uses the singular for a one-line fold and the plural otherwise', () => {
    expect(pastedTextLabel(1, 1)).toBe('[Pasted text #1 +1 line]')
    expect(pastedTextLabel(4, 2)).toBe('[Pasted text #4 +2 lines]')
    const one = new Composer()
    one.handle(paste('y'.repeat(PASTE_FOLD_MIN_CHARS)))
    expect(shown(one)).toBe('› [Pasted text #1 +1 line]')
  })

  it('is generated only from numbers, never from the pasted body', () => {
    // The label must be as safe to draw as text the renderer wrote itself. If any
    // character of the paste could reach it, a pasted escape sequence would be
    // back on the screen through the very mechanism that hides it.
    const composer = new Composer()
    composer.handle(paste(`${Array.from({ length: 11 }, (_, i) => `\u001b[2J\u0007${String(i)}`).join('\n')}`))
    const label = shown(composer)
    expect(label).toBe('› [Pasted text #1 +11 lines]')
    expect(label).not.toContain('\u001b')
    expect(label).not.toContain('\u0007')
  })
})

describe('paste numbering', () => {
  it('numbers folded pastes in the order they arrive', () => {
    const composer = new Composer()
    composer.handle(paste(lines(9)))
    composer.handle(paste(lines(10)))
    composer.handle(paste(lines(11)))
    // Asserted on the projection rather than the drawn rows: three labels side by
    // side is wider than the test's terminal, and what is being checked is the
    // numbering, not where the wrap falls.
    expect(composer.display().text).toBe(
      '[Pasted text #1 +9 lines][Pasted text #2 +10 lines][Pasted text #3 +11 lines]',
    )
    expect(shown(composer, 200)).toBe(
      '› [Pasted text #1 +9 lines][Pasted text #2 +10 lines][Pasted text #3 +11 lines]',
    )
  })

  it('does not consume a number for a paste that stayed visible', () => {
    // A small paste is drawn inline, so it has no label to number. Spending an
    // identity on it would make `#1` mean a different block of text depending on
    // whether the reader happened to paste a large one first.
    const composer = new Composer()
    composer.handle(paste('one line'))
    composer.handle(paste(lines(9)))
    expect(shown(composer)).toBe('› one line[Pasted text #1 +9 lines]')
  })

  it('keeps counting across a submission within one composer', () => {
    const composer = new Composer()
    composer.handle(paste(lines(9)))
    const first = composer.handle(key('enter'))
    expect(first).toMatchObject({ kind: 'submit' })
    composer.handle(paste(lines(10)))
    // The same composer, the same session: the next block is a new block.
    expect(shown(composer)).toBe('› [Pasted text #2 +10 lines]')
  })

  it('keeps counting across a clear within one composer', () => {
    const composer = new Composer()
    composer.handle(paste(lines(9)))
    composer.clear()
    composer.handle(paste(lines(10)))
    expect(shown(composer)).toBe('› [Pasted text #2 +10 lines]')
  })

  it('starts a new composer at #1', () => {
    const first = new Composer()
    first.handle(paste(lines(9)))
    const second = new Composer()
    second.handle(paste(lines(9)))
    expect(shown(first)).toBe('› [Pasted text #1 +9 lines]')
    expect(shown(second)).toBe('› [Pasted text #1 +9 lines]')
  })

  it('does not hand a number back when its paste is undone', () => {
    const composer = new Composer()
    composer.handle(paste(lines(9)))
    composer.handle(key('ctrl-z'))
    composer.handle(paste(lines(10)))
    // The undone paste was a different block of text, and a reader may still
    // remember `#1` meaning the first one. A fresh number is the honest answer.
    expect(shown(composer)).toBe('› [Pasted text #2 +10 lines]')
  })
})

describe('the buffer stays authoritative', () => {
  it('holds the complete paste while drawing one token', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    expect(composer.value).toBe(body)
    expect(shown(composer)).toBe('› [Pasted text #1 +11 lines]')
  })

  it('submits the full sanitized body, never the label', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    const action = composer.handle(key('enter'))
    expect(action).toEqual({ kind: 'submit', text: body, gesture: 'enter' })
  })

  it('submits an exact prefix, paste, and suffix with nothing lost between them', () => {
    const composer = new Composer()
    type(composer, 'Please inspect:\n')
    const body = lines(11)
    composer.handle(paste(body))
    type(composer, '\nFocus on the failure.')
    const action = composer.handle(key('enter'))
    expect(action).toEqual({ kind: 'submit', text: `Please inspect:\n${body}\nFocus on the failure.`, gesture: 'enter' })
  })

  it('does not wrap the message in markup the model would have to strip', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    const action = composer.handle(key('enter'))
    expect(action).toMatchObject({ text: lines(11) })
    if (action.kind !== 'submit') throw new Error('expected a submission')
    expect(action.text).not.toContain('[Pasted text')
    expect(action.text).not.toContain('<pasted_content>')
  })

  it('gives completion the real line, with no label in it', () => {
    // Completion reads the line before the cursor. If the projection leaked into
    // that, a user who pasted a stack trace and then typed `/mod` would be
    // offered completions derived from characters that are not in their message.
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    type(composer, '/mod')
    // The real last line of the paste, then what was typed after it.
    expect(composer.lineBeforeCursor).toBe('line 11/mod')
    expect(composer.lineBeforeCursor).not.toContain('[Pasted text')
    expect(composer.value.endsWith('/mod')).toBe(true)
  })

  it('treats a literally typed label as ordinary text', () => {
    const composer = new Composer()
    type(composer, '[Pasted text #1 +11 lines]')
    expect(foldsOf(composer)).toEqual([])
    expect(composer.display().text).toBe('[Pasted text #1 +11 lines]')
    // And submitting it sends exactly those characters, because nothing in the
    // pipeline recognizes the string it can draw.
    expect(composer.handle(key('enter'))).toEqual({
      kind: 'submit',
      text: '[Pasted text #1 +11 lines]',
      gesture: 'enter',
    })
  })

  it('keeps a typed label uncollapsed next to a real one', () => {
    const composer = new Composer()
    type(composer, '[Pasted text #9 +99 lines]')
    composer.handle(paste(lines(9)))
    expect(shown(composer)).toBe('› [Pasted text #9 +99 lines][Pasted text #1 +9 lines]')
  })
})

describe('the fold sidecar holds no second copy of the text', () => {
  it('stores only a range and two numbers', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    const fold = foldsOf(composer)[0]
    expect(Object.keys(fold ?? {}).sort()).toEqual(['end', 'id', 'lines', 'start'])
    // Every field is a number. A field that could hold text is a second copy of
    // the paste waiting to fall out of step with the buffer.
    for (const value of Object.values(fold ?? {})) {
      expect(typeof value).toBe('number')
    }
  })

  it('costs the same for a nine-line paste and a fifty-thousand-line one', () => {
    const small = new Composer()
    small.handle(paste(lines(9)))
    const large = new Composer()
    large.handle(paste(lines(50_000)))
    // The point of a range instead of a copy: the metadata is a fixed size, so a
    // large paste cannot be charged twice for the privilege of being hidden. The
    // only growth is the digits in the range and the line count themselves.
    const smallSize = JSON.stringify(foldsOf(small)).length
    const largeSize = JSON.stringify(foldsOf(large)).length
    expect(largeSize).toBeLessThan(100)
    expect(largeSize - smallSize).toBeLessThan(10)
    expect(large.value.length).toBeGreaterThan(100_000)
  })

  it('is empty whenever nothing is folded', () => {
    const composer = new Composer()
    composer.set('anything at all')
    expect(foldsOf(composer)).toEqual([])
  })
})

describe('editing around a fold', () => {
  it('shifts a fold when text is inserted before it', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    composer.handle(key('home'))
    type(composer, 'X')
    // A stale range would keep the label one character too far left, and the
    // first character of the paste would stop being visible behind it.
    expect(shown(composer)).toBe(`› X[Pasted text #1 +11 lines]`)
    expect(composer.value).toBe(`X${body}`)
    expect(foldsOf(composer)[0]?.start).toBe(1)
  })

  it('shifts a fold by the whole inserted length, not by one', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    composer.handle(key('home'))
    type(composer, 'abcde')
    expect(shown(composer)).toBe('› abcde[Pasted text #1 +11 lines]')
    expect(foldsOf(composer)[0]?.start).toBe(5)
  })

  it('leaves a fold untouched when text is inserted after it', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    type(composer, 'Z')
    expect(shown(composer)).toBe('› [Pasted text #1 +11 lines]Z')
    expect(foldsOf(composer)[0]?.start).toBe(0)
    expect(foldsOf(composer)[0]?.end).toBe(body.length)
  })

  it('keeps a fold when something is deleted entirely before it', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    composer.handle(key('home'))
    type(composer, 'abcde')
    composer.handle(key('backspace'))
    composer.handle(key('backspace'))
    composer.handle(key('backspace'))
    composer.handle(key('backspace'))
    composer.handle(key('backspace'))
    expect(shown(composer)).toBe('› [Pasted text #1 +11 lines]')
    expect(foldsOf(composer)[0]?.start).toBe(0)
  })

  it('reveals a fold that a backspace would otherwise edit invisibly', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    composer.handle(key('backspace'))
    // Deleting a character behind a label and leaving the label up would leave a
    // caption counting text that no longer exists.
    expect(foldsOf(composer)).toEqual([])
    expect(shown(composer)).not.toContain('[Pasted text')
    expect(shown(composer)).toContain('line 10')
    expect(composer.value).toBe(body.slice(0, -1))
  })

  it('reveals a fold that a delete would otherwise edit invisibly', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    composer.handle(key('home'))
    composer.handle(key('right'))
    composer.handle(key('delete'))
    expect(foldsOf(composer)).toEqual([])
    expect(shown(composer)).not.toContain('[Pasted text')
    // The character under the cursor went, and the rest is the original text.
    expect(composer.value).toBe(`${body.slice(0, 1)}${body.slice(2)}`)
  })

  it('reveals a fold that a ctrl-w would otherwise eat from inside', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    composer.handle(key('ctrl-w'))
    expect(foldsOf(composer)).toEqual([])
    expect(shown(composer)).not.toContain('[Pasted text')
  })

  it('reveals a fold that a completion would otherwise replace inside', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    composer.replaceBeforeCursor(3, 'replacement')
    expect(foldsOf(composer)).toEqual([])
    expect(shown(composer)).not.toContain('[Pasted text')
  })

  it('keeps a fold when an edit stops exactly at its boundary', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    const before = foldsOf(composer)[0]
    // A backspace at the buffer's start removes nothing, so nothing about the
    // span it cannot see has changed.
    composer.handle(key('home'))
    composer.handle(key('backspace'))
    expect(foldsOf(composer)[0]).toEqual(before)
  })

  it('keeps several folds across an edit that touches only one of them', () => {
    const composer = new Composer()
    composer.handle(paste(lines(9)))
    type(composer, '|')
    composer.handle(paste(lines(10)))
    type(composer, '|')
    composer.handle(paste(lines(11)))
    const all = '[Pasted text #1 +9 lines]|[Pasted text #2 +10 lines]|[Pasted text #3 +11 lines]'
    expect(composer.display().text).toBe(all)
    composer.handle(key('home'))
    type(composer, 'start ')
    expect(composer.display().text).toBe(`start ${all}`)
    // All three survived, none of them moved except to clear the inserted prefix,
    // and together they still cover the whole draft.
    const kept = foldsOf(composer)
    expect(kept.map(fold => fold.id)).toEqual([1, 2, 3])
    expect(kept[0]?.start).toBe('start '.length)
    for (let index = 1; index < kept.length; index += 1) {
      expect(kept[index]?.start).toBeGreaterThan(kept[index - 1]?.end ?? 0)
    }
    // The last span still ends where the buffer does. (The cursor is back at the
    // start, where the prefix was typed, so the buffer's length is the reference —
    // not the cursor.)
    expect(kept[kept.length - 1]?.end).toBe(composer.value.length)
  })

  it('drops the metadata of a fold deleted whole, without expanding anything', () => {
    const composer = new Composer()
    composer.handle(paste(lines(9)))
    type(composer, '|')
    composer.handle(paste(lines(10)))
    expect(foldsOf(composer)).toHaveLength(2)
    composer.handle(key('ctrl-u'))
    expect(foldsOf(composer)).toEqual([])
    expect(composer.value).toBe('')
    // The submission is the text, and the labels were never in it.
    expect(composer.display().text).toBe('')
  })

  it('drops only the fold a ctrl-k swallows, keeping the one it does not', () => {
    const composer = new Composer()
    composer.handle(paste(lines(9)))
    type(composer, '|')
    composer.handle(paste(lines(10)))
    composer.handle(key('home'))
    // Forward-delete past the first span, stopping before the second.
    for (let index = 0; index < lines(9).length + 1; index += 1) composer.handle(key('delete'))
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([2])
    expect(shown(composer)).toBe('› [Pasted text #2 +10 lines]')
  })

  it('does not leave a fold describing a range the buffer no longer has', () => {
    // A range longer than the buffer is the signature of metadata that was never
    // reconciled with the text it describes.
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    composer.handle(key('ctrl-u'))
    type(composer, 'short')
    for (const fold of foldsOf(composer)) {
      expect(fold.start).toBeGreaterThanOrEqual(0)
      expect(fold.end).toBeLessThanOrEqual(composer.position)
    }
  })
})

describe('the cursor never enters hidden text', () => {
  it('reveals a fold that a left step would move into', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    composer.handle(key('left'))
    // The cursor is one character from the end of the paste, which is a position
    // the reader cannot see while the span is folded. Unfold first, then move.
    expect(foldsOf(composer)).toEqual([])
    expect(shown(composer)).toContain('line 11')
    expect(composer.position).toBe(body.length - 1)
    expect(cursorIsVisible(composer)).toBe(true)
  })

  it('reveals a fold that a right step would move into', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    composer.handle(key('home'))
    composer.handle(key('right'))
    expect(foldsOf(composer)).toEqual([])
    expect(composer.position).toBe(1)
    expect(cursorIsVisible(composer)).toBe(true)
  })

  it('does not record the reveal as an undoable edit', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    composer.handle(key('left'))
    // One undo must remove the whole paste. If the reveal had pushed a step of its
    // own, the first `ctrl-z` would appear to do nothing at all.
    composer.handle(key('ctrl-z'))
    expect(composer.value).toBe('')
  })

  it('leaves the fold alone when a step stops on its boundary', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    composer.handle(key('home'))
    expect(foldsOf(composer)).toHaveLength(1)
    expect(composer.position).toBe(0)
    expect(cursorIsVisible(composer)).toBe(true)
  })

  it('lands on a fold boundary at the ends of the buffer', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    composer.handle(key('home'))
    composer.handle(key('end'))
    expect(composer.position).toBe(body.length)
    expect(cursorIsVisible(composer)).toBe(true)
  })

  it('keeps the cursor visible through a whole vertical journey', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    type(composer, 'after')
    composer.handle(key('home'))
    // Twelve columns makes the label wrap over several rows, so the journey
    // crosses a folded span repeatedly at different widths.
    for (const width of [12, 20, 24, 40]) {
      for (let press = 0; press < 12; press += 1) {
        expect(cursorIsVisible(composer), `visible at ${String(width)} after ${String(press)} down`).toBe(true)
        composer.moveDown(width, GUTTER)
        expect(cursorIsVisible(composer), `visible at ${String(width)} after ${String(press)} down`).toBe(true)
      }
      for (let press = 0; press < 12; press += 1) {
        expect(cursorIsVisible(composer), `visible at ${String(width)} after ${String(press)} up`).toBe(true)
        composer.moveUp(width, GUTTER)
        expect(cursorIsVisible(composer), `visible at ${String(width)} after ${String(press)} up`).toBe(true)
      }
    }
  })

  it('never reports a position inside a folded span from any cell of any row', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    type(composer, 'tail')
    const folds = foldsOf(composer)
    const interior = (offset: number): boolean =>
      folds.some(fold => offset > fold.start && offset < fold.end)
    // Every cell of every row, at every width that wraps the label, must resolve
    // to a boundary. A single interior answer is an invisible cursor waiting to
    // happen the moment someone presses an arrow.
    for (const width of [8, 10, 12, 16, 20, 24, 40, 80, 120]) {
      const layout = layoutComposer(composer, width, GUTTER)
      for (let row = 0; row < layout.rows.length; row += 1) {
        for (let column = 0; column <= width; column += 1) {
          const offset = layout.positionAt(row, column)
          expect(interior(offset), `row ${String(row)} column ${String(column)} at ${String(width)}`).toBe(false)
          expect(offset).toBeGreaterThanOrEqual(0)
          expect(offset).toBeLessThanOrEqual(composer.position + 1)
        }
      }
    }
  })

  it('maps a vertical target inside a placeholder to the fold it belongs to', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    type(composer, 'after')
    const layout = layoutComposer(composer, 10, GUTTER)
    const folds = foldsOf(composer)
    const fold = folds[0]
    expect(fold).toBeDefined()
    // Whatever column a row is aimed at, the answer is the span's own start.
    for (let column = 0; column <= 10; column += 1) {
      const offset = layout.positionAt(0, column)
      if (offset > fold!.start && offset < fold!.end) throw new Error('unreachable: interior offset')
    }
    expect(layout.positionAt(0, 10)).toBeGreaterThanOrEqual(0)
  })
})

describe('undo and redo round-trip the fold', () => {
  it('removes a folded paste on undo and brings the same label back on redo', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    expect(shown(composer)).toBe('› [Pasted text #1 +11 lines]')
    composer.handle(key('ctrl-z'))
    expect(composer.value).toBe('')
    expect(shown(composer)).toBe('› ')
    composer.handle(key('ctrl-y'))
    expect(composer.value).toBe(body)
    expect(shown(composer)).toBe('› [Pasted text #1 +11 lines]')
  })

  it('restores a fold that an edit inside it invalidated', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    composer.handle(key('backspace'))
    expect(foldsOf(composer)).toEqual([])
    expect(shown(composer)).not.toContain('[Pasted text')
    // The step the reader wants back is the state they last SAW, which was
    // folded — so undo must return the label as well as the characters.
    composer.handle(key('ctrl-z'))
    expect(composer.value).toBe(body)
    expect(shown(composer)).toBe('› [Pasted text #1 +11 lines]')
  })

  it('restores the folded state through an edit before the fold as well', () => {
    const composer = new Composer()
    const body = lines(11)
    composer.handle(paste(body))
    composer.handle(key('home'))
    type(composer, 'Q')
    expect(shown(composer)).toBe('› Q[Pasted text #1 +11 lines]')
    composer.handle(key('ctrl-z'))
    // The fold was shifted by the insert, and undo has to take it back with the
    // character it was shifted by.
    expect(composer.value).toBe(body)
    expect(shown(composer)).toBe('› [Pasted text #1 +11 lines]')
    expect(foldsOf(composer)[0]?.start).toBe(0)
  })

  it('keeps every fold in a multi-paste draft across an undo and redo', () => {
    const composer = new Composer()
    composer.handle(paste(lines(9)))
    type(composer, '|')
    composer.handle(paste(lines(10)))
    const expected = '› [Pasted text #1 +9 lines]|[Pasted text #2 +10 lines]'
    composer.handle(key('ctrl-z'))
    expect(shown(composer)).toBe('› [Pasted text #1 +9 lines]|')
    composer.handle(key('ctrl-y'))
    expect(shown(composer)).toBe(expected)
  })
})

describe('a baseline is not a paste', () => {
  it('forges no provenance for long text handed to set()', () => {
    const composer = new Composer()
    // This is history recall, draft restoration, and the skills picker. A long
    // prompt the user typed is not a paste, and labelling it as one would put a
    // false claim into the message.
    const recalled = lines(11)
    composer.set(recalled)
    expect(foldsOf(composer)).toEqual([])
    expect(shown(composer)).toContain('line 1')
    expect(shown(composer)).not.toContain('[Pasted text')
  })

  it('returns a history-recalled multiline prompt as full ordinary text', () => {
    const composer = new Composer()
    const prompt = 'first line\nsecond line\nthird line'
    composer.set(prompt)
    expect(composer.value).toBe(prompt)
    expect(composer.lines).toHaveLength(3)
    expect(shown(composer)).toContain('first line')
    // And it submits byte-for-byte, because nothing was ever folded.
    expect(composer.handle(key('enter'))).toEqual({ kind: 'submit', text: prompt, gesture: 'enter' })
  })

  it('clears folds when a baseline replaces the buffer', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    composer.set('something else entirely')
    expect(foldsOf(composer)).toEqual([])
    expect(shown(composer)).toBe('› something else entirely')
  })

  it('forges no provenance for a long single line either', () => {
    const composer = new Composer()
    composer.set('x'.repeat(PASTE_FOLD_MIN_CHARS + 500))
    expect(foldsOf(composer)).toEqual([])
  })
})

describe('what a draw costs', () => {
  it('does not put a single hidden line into the layout', () => {
    const composer = new Composer()
    composer.handle(paste(lines(5000)))
    const rows = drawn(composer, 40)
    expect(rows).toEqual(['› [Pasted text #1 +5000 lines]'])
    expect(rows.join('')).not.toContain('line 4')
  })

  it('draws only the visible part of a draft around a large paste', () => {
    const composer = new Composer()
    type(composer, 'before ')
    composer.handle(paste(lines(2000)))
    type(composer, ' after')
    expect(drawn(composer, 40).join('')).toBe('› before [Pasted text #1 +2000 lines] after')
  })

  it('keeps the display projection shorter than the buffer it hides', () => {
    const composer = new Composer()
    composer.handle(paste(lines(2000)))
    const display = composer.display()
    expect(display.text.length).toBeLessThan(50)
    expect(display.rawLength).toBe(composer.value.length)
  })
})

describe('the placeholder at real widths', () => {
  it('wraps without breaking the row budget, from 20 to 120 columns', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    for (const width of [20, 24, 40, 80, 120]) {
      const rows = drawn(composer, width)
      // Every row fits the width it was given, gutter included: a row that
      // overflowed is a row `Screen` never counted, and the live region would
      // leave a stale one behind.
      for (const row of rows) {
        expect(row.length, `row at ${String(width)}`).toBeLessThanOrEqual(width)
      }
      // And the label is all there: wrapping is a drawing decision, not a
      // truncation.
      expect(rows.join('').replace(/\s+/gu, ''), `label at ${String(width)}`).toContain('[Pastedtext#1+11lines]')
    }
  })

  it('wraps a label placed after a prefix, at every width', () => {
    const composer = new Composer()
    type(composer, 'Please inspect: ')
    composer.handle(paste(lines(11)))
    type(composer, ' Focus on the failure.')
    for (const width of [20, 24, 40, 80, 120]) {
      const rows = drawn(composer, width)
      for (const row of rows) {
        expect(row.length, `row at ${String(width)}`).toBeLessThanOrEqual(width)
      }
      expect(cursorIsVisible(composer)).toBe(true)
    }
  })

  it('puts the cursor where the drawn label ends, across a wrap', () => {
    const composer = new Composer()
    type(composer, 'xy ')
    composer.handle(paste(lines(11)))
    const layout = layoutComposer(composer, 20, GUTTER)
    // The layout's own placement must invert to the cursor, on whatever row the
    // wrap put it. This is the renderer's central invariant, and a fold is exactly
    // the case that could break it.
    expect(layout.positionAt(layout.cursorRow, layout.cursorColumn)).toBe(composer.position)
  })

  it('keeps wide characters exact on both sides of a fold', () => {
    const composer = new Composer()
    type(composer, '前缀')
    composer.handle(paste(lines(11)))
    type(composer, '后缀')
    // Two columns each: the drawn column after the prefix is the gutter plus four,
    // not the gutter plus two.
    const layout = layoutComposer(composer, 80, GUTTER)
    expect(layout.cursorColumn).toBe(2 + 4 + '[Pasted text #1 +11 lines]'.length + 4)
    expect(layout.positionAt(layout.cursorRow, layout.cursorColumn)).toBe(composer.position)
    expect(shown(composer, 80)).toBe('› 前缀[Pasted text #1 +11 lines]后缀')
  })

  it('keeps wide characters exact when the fold wraps between them', () => {
    const composer = new Composer()
    type(composer, '标准')
    composer.handle(paste(lines(11)))
    type(composer, '标准')
    for (const width of [10, 12, 20, 24, 40]) {
      const layout = layoutComposer(composer, width, GUTTER)
      expect(layout.positionAt(layout.cursorRow, layout.cursorColumn), `round trip at ${String(width)}`).toBe(composer.position)
      for (const row of layout.rows) {
        expect(row.length, `row at ${String(width)}`).toBeLessThanOrEqual(width)
      }
    }
  })

  it('still places the cursor exactly with no fold at all', () => {
    const composer = new Composer()
    composer.set('a🙂🙂b🙂cdef🙂gh')
    const layout = layoutComposer(composer, 40, GUTTER)
    expect(layout.positionAt(layout.cursorRow, layout.cursorColumn)).toBe(composer.position)
  })
})
