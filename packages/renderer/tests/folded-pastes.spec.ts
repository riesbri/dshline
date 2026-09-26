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
 * Assert the one invariant every fold mutation must preserve.
 *
 * Each range is checked on its own AND against the one before it, because those
 * are different failures. A scrambled collection can hold ranges that are each
 * individually perfect — `start >= 0`, `end > start`, `end <= length` — and still
 * be wrong, and that is the failure that costs the most: the projection walks
 * folds in array order, so a span listed after one that begins later is skipped
 * as if it were empty, and the label ends up describing the wrong text. Asserting
 * per-range validity alone would have passed while the composer showed one block
 * expanded and another block's label sitting over it.
 * @param composer - the buffer whose sidecar is checked.
 * @param label - what is being checked, for the failure message.
 */
function expectFoldsValid(composer: Composer, label = 'folds'): void {
  const folds = foldsOf(composer)
  const length = [...composer.value].length
  for (const [index, fold] of folds.entries()) {
    expect(fold.start, `${label}: ${String(index)} start`).toBeGreaterThanOrEqual(0)
    expect(fold.end, `${label}: ${String(index)} end > start`).toBeGreaterThan(fold.start)
    expect(fold.end, `${label}: ${String(index)} end within buffer`).toBeLessThanOrEqual(length)
    if (index === 0) continue
    expect(fold.start, `${label}: ${String(index)} starts at or after the previous end`).toBeGreaterThanOrEqual(
      folds[index - 1]?.end ?? 0,
    )
  }
}

/**
 * A numbered multi-line block, tagged so a composition of several is readable.
 * @param count - how many logical lines the block holds.
 * @param tag - a marker that survives into the authoritative buffer.
 * @returns the pasted text.
 */
function block(count: number, tag: string): string {
  return Array.from({ length: count }, (_, index) => `${tag} line ${String(index + 1)}`).join('\n')
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

describe('folds stay ordered by position, not by arrival', () => {
  // The projection consumes folds in ARRAY order and trusts that order, so a
  // collection that is out of position order does not merely look wrong: the
  // later-listed span is skipped as if it were empty, and the label that survives
  // ends up describing text the reader cannot see while the text it describes is
  // drawn in full. That is a false statement on screen, not a cosmetic one.

  it('places a new fold before an existing one when pasted in front of it', () => {
    const composer = new Composer()
    composer.handle(paste(block(9, 'A')))
    expectFoldsValid(composer, 'after A')
    composer.handle(key('home'))
    // Home is a boundary, so `#1` is still folded and the cursor is in front of it.
    expectFoldsValid(composer, 'after home')
    composer.handle(paste(block(11, 'B')))

    // POSITION order: B was inserted at raw 0 and A was shifted forward behind it.
    expectFoldsValid(composer, 'after B')
    expect(foldsOf(composer).map(fold => fold.start)).toEqual([0, 100])
    // ARRIVAL order is deliberately different: the collection is positional, so
    // it holds `[2, 1]` here. Sorting by id instead would satisfy the numbering
    // and break the drawing.
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([2, 1])
    // And the screen shows them in the order they sit in the buffer.
    expect(composer.display().text).toBe('[Pasted text #2 +11 lines][Pasted text #1 +9 lines]')
  })

  it('submits the complete B-then-A buffer for a paste placed before a fold', () => {
    const composer = new Composer()
    const a = block(9, 'A')
    const b = block(11, 'B')
    composer.handle(paste(a))
    composer.handle(key('home'))
    composer.handle(paste(b))
    // The authoritative buffer is the new block FIRST, because that is where the
    // cursor put it — and the label order above says exactly the same thing.
    expect(composer.value).toBe(`${b}${a}`)
    expect(composer.handle(key('enter'))).toEqual({ kind: 'submit', text: `${b}${a}`, gesture: 'enter' })
  })

  it('places a new fold in front of two existing ones', () => {
    const composer = new Composer()
    composer.handle(paste(block(9, 'A')))
    type(composer, ' between ')
    composer.handle(paste(block(10, 'C')))
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([1, 2])
    expectFoldsValid(composer, 'A | C')

    // Home, then a paste, is the simple way to put a new block ahead of an
    // existing one: it reaches the start without entering either span. It is not
    // the ONLY route — a vertical move onto a wrapped row can land on visible
    // text between two spans, and the test below pastes into such a separator.
    // What a horizontal step cannot do is pass THROUGH a fold's interior, so the
    // cases here and there exercise the insertion in both directions.
    composer.handle(key('home'))
    composer.handle(paste(block(11, 'B')))

    expectFoldsValid(composer, 'B | A | C')
    // Arrival was A, C, B. Position is B, A, C — so the collection holds
    // `[3, 1, 2]`, and two separate insertions had to land ahead of an existing
    // fold rather than one.
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([3, 1, 2])
    expect(composer.display().text).toBe(
      '[Pasted text #3 +11 lines][Pasted text #1 +9 lines] between [Pasted text #2 +10 lines]',
    )
  })

  it('places a new fold at a non-zero position ahead of an existing one', () => {
    const composer = new Composer()
    composer.handle(paste(block(9, 'A')))
    composer.handle(key('home'))
    // Visible text typed at the front, so the new fold does not start at raw 0 and
    // the placement is decided by a real comparison rather than by an empty prefix.
    type(composer, 'lead ')
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([1])
    composer.handle(paste(block(11, 'B')))

    expectFoldsValid(composer, 'lead B A')
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([2, 1])
    expect(foldsOf(composer).map(fold => fold.start)).toEqual([5, 105])
    expect(composer.display().text).toBe('lead [Pasted text #2 +11 lines][Pasted text #1 +9 lines]')
  })

  it('submits the whole buffer with two folds placed ahead of the first', () => {
    const composer = new Composer()
    const a = block(9, 'A')
    const c = block(10, 'C')
    const b = block(11, 'B')
    composer.handle(paste(a))
    type(composer, ' between ')
    composer.handle(paste(c))
    composer.handle(key('home'))
    composer.handle(paste(b))
    expect(composer.value).toBe(`${b}${a} between ${c}`)
    expect(composer.handle(key('enter'))).toEqual({ kind: 'submit', text: `${b}${a} between ${c}`, gesture: 'enter' })
  })

  it('brings the old fold back alone on undo, and both in position order on redo', () => {
    const composer = new Composer()
    const a = block(9, 'A')
    const b = block(11, 'B')
    composer.handle(paste(a))
    composer.handle(key('home'))
    composer.handle(paste(b))
    expect(composer.display().text).toBe('[Pasted text #2 +11 lines][Pasted text #1 +9 lines]')

    composer.handle(key('ctrl-z'))
    expect(composer.value).toBe(a)
    expectFoldsValid(composer, 'after undo')
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([1])
    expect(composer.display().text).toBe('[Pasted text #1 +9 lines]')

    composer.handle(key('ctrl-y'))
    expect(composer.value).toBe(`${b}${a}`)
    expectFoldsValid(composer, 'after redo')
    expect(composer.display().text).toBe('[Pasted text #2 +11 lines][Pasted text #1 +9 lines]')
  })

  it('keeps positional ids valid through edits before and after them', () => {
    const composer = new Composer()
    composer.handle(paste(block(9, 'A')))
    composer.handle(key('home'))
    composer.handle(paste(block(11, 'B')))
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([2, 1])

    // Before both: both shift by the edit's length, and the order is unchanged.
    composer.handle(key('home'))
    type(composer, 'lead ')
    expectFoldsValid(composer, 'after a leading edit')
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([2, 1])
    expect(foldsOf(composer).map(fold => fold.start)).toEqual([5, 105])
    expect(composer.display().text).toBe('lead [Pasted text #2 +11 lines][Pasted text #1 +9 lines]')

    // After both: neither moves, and the drawing is unchanged around them.
    composer.handle(key('end'))
    type(composer, ' tail')
    expectFoldsValid(composer, 'after a trailing edit')
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([2, 1])
    expect(foldsOf(composer).map(fold => fold.start)).toEqual([5, 105])
    expect(composer.display().text).toBe('lead [Pasted text #2 +11 lines][Pasted text #1 +9 lines] tail')

    // Deleting the text in front shifts both back together, still in order. The
    // cursor is walked to the end of that text with Home and a few right steps,
    // which never enter a fold because the visible text it crosses is in front of
    // the first one.
    const plain = new Composer()
    plain.handle(paste(block(9, 'A')))
    plain.handle(key('home'))
    plain.handle(paste(block(11, 'B')))
    plain.handle(key('home'))
    type(plain, 'lead ')
    for (let press = 0; press < 'lead '.length; press += 1) plain.handle(key('backspace'))
    expectFoldsValid(plain, 'after deleting the leading text')
    expect(foldsOf(plain).map(fold => fold.id)).toEqual([2, 1])
    expect(foldsOf(plain).map(fold => fold.start)).toEqual([0, 100])
  })

  it('horizontal movement cannot cross a folded span without revealing it', () => {
    // Narrower than "there is no position between two folds", and stated this way
    // because it is the rule that is actually enforced. A horizontal step walks
    // one code point at a time, so reaching content BEYOND a folded span means
    // stepping through its interior, and the interior is not drawn. Rather than
    // land the cursor there, the step reveals the span first and then moves into
    // what is now ordinary visible text.
    //
    // What this does NOT claim: that a separator between two folded spans is
    // unreachable. It is ordinary visible text, and the test below reaches it with
    // a vertical move. Only the horizontal route through a fold's interior is
    // closed.
    const composer = new Composer()
    composer.handle(paste(block(9, 'A')))
    type(composer, ' between ')
    composer.handle(paste(block(10, 'C')))
    expect(foldsOf(composer)).toHaveLength(2)
    expectFoldsValid(composer, 'A | C')

    composer.handle(key('home'))
    // The very first right step would land inside `#1`, so it unfolds it — and
    // `#1` is then ordinary text the reader can walk through, separator included.
    composer.handle(key('right'))
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([2])
    expectFoldsValid(composer, 'after revealing the first span')
    expect(composer.display().text.startsWith('A line 1\n')).toBe(true)
    expect(composer.display().text).toContain(' between ')
    expect(composer.display().text.endsWith('[Pasted text #2 +10 lines]')).toBe(true)
  })

  it('vertical movement reaches the separator between two folded spans', () => {
    // The counterpart to the test above, and the reason that one must not claim
    // more than it does. A wrapped label is several visual rows tall, so the rows
    // BETWEEN two folded spans hold the separator, and `positionAt` maps a cell on
    // one of those rows to a raw offset in ordinary text. Vertical movement is
    // therefore a way to put the cursor between two spans that are both still
    // folded — no reveal, and no invisible position.
    const a = block(9, 'A')
    const separator = ' between '
    const c = block(10, 'C')
    const composer = new Composer()
    composer.handle(paste(a))
    type(composer, separator)
    composer.handle(paste(c))
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([1, 2])

    // Thirty columns wraps both labels, so the row above the cursor holds the
    // middle of the separator.
    expect(composer.moveUp(30, GUTTER)).toBe(true)
    expect(composer.position).toBe(85)
    expect(composer.position).toBeGreaterThan(a.length)
    expect(composer.position).toBeLessThan(a.length + separator.length)
    // Both spans are still folded: nothing was revealed to get here.
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([1, 2])
    expectFoldsValid(composer, 'cursor in the separator')
  })

  it('places a paste into a separator the cursor reached vertically', () => {
    const a = block(9, 'A')
    const separator = ' between '
    const c = block(10, 'C')
    const b = block(11, 'B')
    const composer = new Composer()
    composer.handle(paste(a))
    type(composer, separator)
    composer.handle(paste(c))
    expect(composer.moveUp(30, GUTTER)).toBe(true)
    expect(composer.position).toBe(85)

    composer.handle(paste(b))

    // Arrival was A, C, B. Position is A, B, C — the same interleaving the Home
    // route produces, reached a different way, so `insertFoldOrdered` has to get
    // both right.
    expectFoldsValid(composer, 'B inserted into the separator')
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([1, 3, 2])
    expect(foldsOf(composer).map(fold => fold.start)).toEqual([0, 85, 85 + b.length + 4])
    // The separator is split where the cursor actually was, not at a boundary.
    expect(composer.value).toBe(`${a}${separator.slice(0, 5)}${b}${separator.slice(5)}${c}`)
    expect(composer.handle(key('enter'))).toEqual({
      kind: 'submit',
      text: `${a}${separator.slice(0, 5)}${b}${separator.slice(5)}${c}`,
      gesture: 'enter',
    })
  })

  it('restores a position-ordered collection from an undo snapshot', () => {
    const composer = new Composer()
    composer.handle(paste(block(9, 'A')))
    type(composer, ' between ')
    composer.handle(paste(block(10, 'C')))
    composer.handle(key('home'))
    composer.handle(paste(block(11, 'B')))
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([3, 1, 2])

    // `ctrl-z` walks back through states whose collections were captured in
    // whatever order those states were built in, so restoring one must hand back
    // the snapshot as it was taken — not a re-sorted or otherwise rewritten copy.
    composer.handle(key('ctrl-z'))
    expect(composer.value).toBe(`${block(9, 'A')} between ${block(10, 'C')}`)
    expectFoldsValid(composer, 'after undoing B')
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([1, 2])
    expect(composer.display().text).toBe('[Pasted text #1 +9 lines] between [Pasted text #2 +10 lines]')

    composer.handle(key('ctrl-y'))
    expectFoldsValid(composer, 'after redoing B')
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([3, 1, 2])
    expect(composer.display().text).toBe(
      '[Pasted text #3 +11 lines][Pasted text #1 +9 lines] between [Pasted text #2 +10 lines]',
    )
  })

  it('does not reach back into a snapshot when a later paste reorders folds', () => {
    const composer = new Composer()
    composer.handle(paste(block(9, 'A')))
    composer.handle(key('home'))
    composer.handle(paste(block(11, 'B')))
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([2, 1])

    // The snapshot `ctrl-z` restores was captured while only `#1` existed. Placing
    // `#2` in front must have produced a NEW collection rather than reordering the
    // one the snapshot still holds, or this undo would return two folds where the
    // state it restores had one.
    composer.handle(key('ctrl-z'))
    expect(composer.value).toBe(block(9, 'A'))
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([1])
    expectFoldsValid(composer, 'after undoing B')
    composer.handle(key('ctrl-z'))
    expect(composer.value).toBe('')
    expect(foldsOf(composer)).toEqual([])
    composer.handle(key('ctrl-y'))
    expect(composer.value).toBe(block(9, 'A'))
    expect(foldsOf(composer).map(fold => fold.id)).toEqual([1])
  })
})

describe('lineBeforeCursor finds the line by walking backward', () => {
  /**
   * The scan this replaced, kept here as the oracle.
   *
   * The backward walk and the forward scan must agree for every input, and the
   * only way to be sure of that without reasoning about each case is to run both.
   * The reference is written the way the original was — index zero upward — so a
   * difference is a real regression rather than a restatement of the same code.
   * @param chars - the buffer, one entry per code point.
   * @param at - the cursor offset.
   * @returns the text before the cursor on its own logical line.
   */
  function forwardReference(chars: readonly string[], at: number): string {
    let start = 0
    for (let index = 0; index < at; index += 1) {
      if (chars[index] === '\n') start = index + 1
    }
    return chars.slice(start, at).join('')
  }

  /** Every cursor position in `composer`, paired with both scans' answers. @param composer - the buffer to walk. */
  function everyCursorLine(composer: Composer): [string, string][] {
    const seen: [string, string][] = []
    const chars = [...composer.value]
    for (let at = 0; at <= chars.length; at += 1) {
      while (composer.position > at) composer.handle(key('left'))
      while (composer.position < at) composer.handle(key('right'))
      seen.push([composer.lineBeforeCursor, forwardReference(chars, at)])
    }
    return seen
  }

  it('agrees with the forward scan at every cursor position of a plain draft', () => {
    const composer = new Composer()
    composer.set('alpha\nbeta\ngamma\ndelta')
    for (const [before, reference] of everyCursorLine(composer)) {
      expect(before, `cursor over a plain draft`).toBe(reference)
    }
  })

  it('agrees with the forward scan at every cursor position of a folded draft', () => {
    // The case that motivated the change: completion reads this on every refresh,
    // and the forward scan made each of those a walk over the whole hidden paste.
    const composer = new Composer()
    composer.handle(paste(lines(40)))
    type(composer, '\n/mod')
    for (const [before, reference] of everyCursorLine(composer)) {
      expect(before, `cursor over a folded draft`).toBe(reference)
    }
  })

  it('agrees across astral and wide characters, and across a cursor inside a line', () => {
    const composer = new Composer()
    composer.set('标准🙂 first\nsecond line 标准🙂\nthird')
    for (const [before, reference] of everyCursorLine(composer)) {
      expect(before, `cursor over wide content`).toBe(reference)
    }
  })

  it('agrees over a draft with trailing, leading, and doubled newlines', () => {
    for (const text of ['', '\n', '\n\n', 'a\n', '\na', 'a\n\nb', '\n\n\n', 'a\nb\nc\n']) {
      const composer = new Composer()
      composer.set(text)
      for (const [before, reference] of everyCursorLine(composer)) {
        expect(before, `cursor over ${JSON.stringify(text)}`).toBe(reference)
      }
    }
  })

  it('returns the first line when the cursor is in it', () => {
    const composer = new Composer()
    composer.set('alpha\nbeta')
    composer.handle(key('home'))
    type(composer, 'al')
    expect(composer.lineBeforeCursor).toBe('al')
  })

  it('returns a later line when the cursor is in it', () => {
    const composer = new Composer()
    composer.set('alpha\nbeta\ngamma')
    // Back to the start of the last line, then type into it. Reaching that line
    // crosses a newline, which is a boundary and so never unfolds anything.
    for (let press = 0; press < 'gamma'.length; press += 1) composer.handle(key('left'))
    type(composer, 'be')
    expect(composer.lineBeforeCursor).toBe('be')
  })

  it('returns a partial line when the cursor is in the middle of it', () => {
    const composer = new Composer()
    composer.set('alpha\nbeta gamma\ndelta')
    composer.handle(key('home'))
    // Position 13 is inside `beta gamma` and short of its end.
    for (let press = 0; press < 13; press += 1) composer.handle(key('right'))
    expect(composer.lineBeforeCursor).toBe('beta ga')
  })

  it('reads the raw line of a folded paste, never the label', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    expect(composer.lineBeforeCursor).toBe('line 11')
    expect(composer.lineBeforeCursor).not.toContain('[Pasted text')
  })

  it('completes against a slash command typed after a folded paste', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    type(composer, '\n/mod')
    expect(composer.lineBeforeCursor).toBe('/mod')
    // The token is what completion will see, and it is the real one.
    expect(composer.lineBeforeCursor).not.toContain('[Pasted text')
  })

  it('completes against a mention typed after a folded paste', () => {
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    type(composer, '\n@foo')
    expect(composer.lineBeforeCursor).toBe('@foo')
    expect(composer.lineBeforeCursor).not.toContain('[Pasted text')
  })

  it('keeps a folded paste out of the line even when the cursor is inside it', () => {
    // The cursor cannot rest inside a folded span — moving there unfolds it — so
    // this is the state a reader lands in after revealing, and the line it reads is
    // the revealed text.
    const composer = new Composer()
    composer.handle(paste(lines(11)))
    composer.handle(key('left'))
    expect(foldsOf(composer)).toEqual([])
    expect(composer.lineBeforeCursor).toBe('line 1')
  })
})
