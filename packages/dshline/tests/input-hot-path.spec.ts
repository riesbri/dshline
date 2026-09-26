/**
 * The session input loop must not join the whole draft to decide history ownership.
 *
 * A large paste is drawn as one compact token, so the ordinary DRAW path never
 * materializes the hidden text. The input loop sat directly underneath that and
 * did anyway: it read `composer.value` before every composer-routed keystroke and
 * again afterwards, to feed `InputHistory.resetIfEdited`. With a large folded paste
 * in the draft that is two full joins per keystroke — for a question that has no
 * answer to give unless a recalled history entry is being looked at.
 *
 * The behaviour that decision preserves is not about a getter count, so it is
 * asserted here with real objects: a cursor move over a recalled entry must keep
 * navigating, a text edit over one must end it, and a draft that was never in a
 * traversal has no traversal to end. The source shape is then guarded, because the
 * saving is the shape itself and no behavioural test can see a join that did not
 * change an answer.
 *
 * The scan is comment- and string-aware rather than a substring search, so the
 * comments explaining this rule cannot fail the guard while a real unguarded read
 * cannot hide behind one.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Composer } from '@dshline/renderer'
import type { Key } from '@dshline/renderer'
import { InputHistory } from '../src/history.ts'
import { routeInputKey } from '../src/input.ts'

const key = (name: string): Key => ({ kind: 'key', name } as Key)

/** A completion state that never claims a key, so routing falls through. */
const NO_COMPLETION = {
  active: false,
  handleKey: () => false,
  invalidate: () => {},
} as unknown as Parameters<typeof routeInputKey>[2]

/** Geometry wide enough that a vertical move has somewhere to go. */
const GEOMETRY = { width: 80, gutter: (): string => '  ' }

/**
 * Strip comments and string/template literals, keeping only code.
 * @param source - one source file's text.
 * @returns the same text with comments and literal contents removed.
 */
function codeOnly(source: string): string {
  let out = ''
  let index = 0
  while (index < source.length) {
    const two = source.slice(index, index + 2)
    if (two === '//') {
      const end = source.indexOf('\n', index)
      index = end < 0 ? source.length : end
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      out += ' '
      continue
    }
    const char = source[index] ?? ''
    if (char === '"' || char === "'" || char === '`') {
      index += 1
      // A template's `${…}` holds CODE, so it is copied back out rather than lost.
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2
          continue
        }
        if (source[index] === '$' && source[index + 1] === '{') {
          let depth = 1
          index += 2
          const start = index
          while (index < source.length && depth > 0) {
            if (source[index] === '{') depth += 1
            else if (source[index] === '}') depth -= 1
            if (depth > 0) index += 1
          }
          out += ` ${codeOnly(source.slice(start, index))} `
          index += 1
          continue
        }
        if (source[index] === char) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

describe('history ownership over a draft that was never in a traversal', () => {
  it('keeps navigating when the reader only moves the cursor', () => {
    const composer = new Composer()
    const history = new InputHistory()
    history.record('a recalled prompt')
    expect(routeInputKey(key('up'), composer, NO_COMPLETION, history, GEOMETRY)).toBe('history')
    expect(composer.value).toBe('a recalled prompt')
    expect(history.navigating).toBe(true)

    composer.handle(key('left'))
    // The rule the comparison exists to protect: Left must not abandon the
    // traversal, or the saved draft would be lost to a keystroke that changed
    // nothing.
    expect(history.resetIfEdited('a recalled prompt', composer.value)).toBe(false)
    expect(history.navigating).toBe(true)
  })

  it('ends navigation when the reader actually edits a recalled entry', () => {
    const composer = new Composer()
    const history = new InputHistory()
    history.record('a recalled prompt')
    routeInputKey(key('up'), composer, NO_COMPLETION, history, GEOMETRY)
    expect(history.navigating).toBe(true)

    composer.handle({ kind: 'text', text: '!' } as Key)
    expect(history.resetIfEdited('a recalled prompt', composer.value)).toBe(true)
    expect(history.navigating).toBe(false)
  })

  it('has nothing to reset for a draft that was never recalled', () => {
    const composer = new Composer()
    const history = new InputHistory()
    history.record('a recalled prompt')
    // A fresh draft, with a large folded paste in it.
    composer.handle({ kind: 'paste', text: Array.from({ length: 200 }, (_, i) => `line ${String(i)}`).join('\n') } as Key)
    expect(history.navigating).toBe(false)
    // The guard in the loop reads as "edited is false when we never looked", which
    // is the same answer the comparison would have given for a cursor move.
    expect(history.resetIfEdited(composer.value, composer.value)).toBe(false)
    expect(history.navigating).toBe(false)
  })

  it('leaves the next traversal correct after skipping the comparison', () => {
    const composer = new Composer()
    const history = new InputHistory()
    history.record('older prompt')
    composer.set('half-typed draft')
    routeInputKey(key('up'), composer, NO_COMPLETION, history, GEOMETRY)
    routeInputKey(key('down'), composer, NO_COMPLETION, history, GEOMETRY)
    expect(composer.value).toBe('half-typed draft')
    // Back at the draft, an edit must not leave a stale saved draft behind that a
    // later traversal could restore in place of the reader's real one. The
    // comparison is skipped here, so this is the property that makes skipping it
    // safe: every path that READS the saved draft also WRITES it first.
    composer.handle({ kind: 'text', text: 'X' } as Key)
    expect(history.navigating).toBe(false)
    routeInputKey(key('up'), composer, NO_COMPLETION, history, GEOMETRY)
    expect(composer.value).toBe('older prompt')
    routeInputKey(key('down'), composer, NO_COMPLETION, history, GEOMETRY)
    expect(composer.value).toBe('half-typed draftX')
  })
})

describe('the input loop reads the draft only while traversing history', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/attachment.ts', import.meta.url)), 'utf8')
  const code = codeOnly(source)

  it('never reads composer.value into a variable unconditionally', () => {
    // The regression is the SHAPE: `const valueBeforeAction = composer.value` is a
    // full join of the draft on every keystroke, folded or not. It has to be
    // guarded by the navigation test, or the saving is gone.
    expect(code).not.toMatch(/=\s*composer\s*\.\s*value\b/)
  })

  it('guards the saved draft with the navigation test', () => {
    // The test is read once into a named flag, and that flag is what gates the
    // join. Asserting the shape rather than the exact expression keeps this from
    // breaking on a rename while still failing if the guard is removed.
    expect(code).toMatch(/=\s*history\s*\.\s*navigating\b/)
    expect(code).toMatch(/\?\s*composer\s*\.\s*value\s*:\s*undefined/)
  })

  it('passes the saved draft to the comparison only when one was taken', () => {
    expect(code).toMatch(/resetIfEdited\s*\(/)
    // No non-null assertion on the way through: the absent case is `undefined`,
    // which is unambiguous, and the branch reads it.
    expect(code).not.toMatch(/\w+!/)
  })
})
