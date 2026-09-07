import { describe, expect, it } from 'vitest'
import { Composer, createKeyDecoder, decodeKeys } from '../src/index.ts'

describe('decodeKeys()', () => {
  it('splits one chunk into ordered keys', () => {
    expect(decodeKeys('hi')).toEqual([{ kind: 'text', text: 'hi' }])
    expect(decodeKeys('a\r')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'key', name: 'enter' },
    ])
  })

  it('decodes arrow keys from both CSI and SS3 forms', () => {
    expect(decodeKeys('\u001b[A')).toEqual([{ kind: 'key', name: 'up' }])
    expect(decodeKeys('\u001bOB')).toEqual([{ kind: 'key', name: 'down' }])
  })

  it('decodes parameterized sequences', () => {
    expect(decodeKeys('\u001b[3~')).toEqual([{ kind: 'key', name: 'delete' }])
  })

  it('drops an unrecognized sequence instead of typing it into the buffer', () => {
    // A sequence with no meaning here would otherwise appear as "[<35;40;12M".
    expect(decodeKeys('\u001b[<35;40;12M')).toEqual([])
    expect(decodeKeys('\u001b[999~')).toEqual([])
  })

  it('reads shift-enter as a newline, in either enhanced encoding', () => {
    // A terminal in its default mode sends a bare carriage return for shift-enter,
    // which is indistinguishable from enter. These are the two encodings that say
    // otherwise: the kitty keyboard protocol's `CSI code ; modifiers u`, and
    // xterm's `modifyOtherKeys` `CSI 27 ; modifiers ; code ~`. Which one arrives
    // depends on the terminal, so both are read.
    expect(decodeKeys('\u001b[13;2u')).toEqual([{ kind: 'key', name: 'newline' }])
    expect(decodeKeys('\u001b[27;2;13~')).toEqual([{ kind: 'key', name: 'newline' }])
  })

  it('reads an unmodified enhanced enter as enter, not as a newline', () => {
    expect(decodeKeys('\u001b[13u')).toEqual([{ kind: 'key', name: 'enter' }])
    expect(decodeKeys('\u001b[13;1u')).toEqual([{ kind: 'key', name: 'enter' }])
  })

  it('reads alt-enter as a newline too, in either enhanced encoding', () => {
    // On a terminal that implements this protocol, alt-enter arrives as
    // `CSI 13 ; 3 u` rather than the legacy `ESC CR` — so recognising only shift
    // would make the documented fallback gesture SUBMIT, sending an unfinished
    // prompt on exactly the terminals where the new mode works.
    expect(decodeKeys('\u001b[13;3u')).toEqual([{ kind: 'key', name: 'newline' }])
    expect(decodeKeys('\u001b[27;3;13~')).toEqual([{ kind: 'key', name: 'newline' }])
  })

  it('reads ctrl-enter as its own key, in either enhanced encoding', () => {
    // A deliberate reversal: ctrl-enter used to be reported as plain `enter`,
    // because nothing here had a second meaning for it. The composer now has one
    // — it submits with the opposite delivery — so the key has to exist. Both
    // encodings, because which one a terminal sends is not the user's problem.
    expect(decodeKeys('\u001b[13;5u')).toEqual([{ kind: 'key', name: 'ctrl-enter' }])
    expect(decodeKeys('\u001b[27;5;13~')).toEqual([{ kind: 'key', name: 'ctrl-enter' }])
  })

  it('leaves a legacy ctrl-enter indistinguishable from enter, rather than guessing', () => {
    // The whole degradation, in one assertion. A terminal not in an enhanced mode
    // sends bare CR for this chord, exactly as it does for enter, and there is no
    // query that would tell them apart — so the byte decodes to `enter` and the
    // reader gets their own preference. Inventing `ctrl-enter` from a bare CR
    // would give every plain enter the OPPOSITE delivery on those terminals.
    expect(decodeKeys('\r')).toEqual([{ kind: 'key', name: 'enter' }])
    expect(decodeKeys('\n')).toEqual([{ kind: 'key', name: 'enter' }])
  })

  it('reads a newline when shift or alt is held with another modifier', () => {
    // Modifier 6 is ctrl+shift and 7 is ctrl+alt; the shift and alt bits decide.
    expect(decodeKeys('\u001b[13;6u')).toEqual([{ kind: 'key', name: 'newline' }])
    expect(decodeKeys('\u001b[13;7u')).toEqual([{ kind: 'key', name: 'newline' }])
  })

  it('drops an enhanced report for a key it gives no meaning to', () => {
    // A letter reported through the protocol is not text: inserting it would type
    // the character twice on terminals that also send the legacy encoding.
    expect(decodeKeys('\u001b[97;2u')).toEqual([])
  })

  it('reads the ctrl gestures in the enhanced encoding, which is the only one it gets', () => {
    // Asking for this mode STOPS the legacy control bytes arriving: a terminal that
    // implements it sends `CSI 99 ; 5 u` and never `0x03` again. Reading only the
    // byte therefore did not degrade the ctrl gestures, it deleted them — quitting
    // and cancelling decoded to nothing at all on every terminal that obeyed.
    expect(decodeKeys('\u001b[99;5u')).toEqual([{ kind: 'key', name: 'ctrl-c' }])
    expect(decodeKeys('\u001b[100;5u')).toEqual([{ kind: 'key', name: 'ctrl-d' }])
    expect(decodeKeys('\u001b[108;5u')).toEqual([{ kind: 'key', name: 'ctrl-l' }])
    expect(decodeKeys('\u001b[111;5u')).toEqual([{ kind: 'key', name: 'ctrl-o' }])
    expect(decodeKeys('\u001b[27;5;99~')).toEqual([{ kind: 'key', name: 'ctrl-c' }])
  })

  it('reads every ctrl gesture the legacy table names, in both encodings', () => {
    // The two tables are one table: whatever a control byte means, the letter
    // 0x60 above it with the ctrl bit means the same thing. Asserted as a pair so a
    // gesture added to one encoding and not the other fails here rather than in a
    // bug report from whoever happens to use the wrong terminal.
    const gestures = {
      a: 'ctrl-a', c: 'ctrl-c', d: 'ctrl-d', e: 'ctrl-e', f: 'ctrl-f',
      k: 'ctrl-k', l: 'ctrl-l', o: 'ctrl-o', r: 'ctrl-r', u: 'ctrl-u', w: 'ctrl-w',
      y: 'ctrl-y', z: 'ctrl-z',
    } as const
    for (const [letter, name] of Object.entries(gestures)) {
      const code = letter.codePointAt(0) ?? 0
      const legacy = String.fromCodePoint(code - 0x60)
      expect(decodeKeys(legacy)).toEqual([{ kind: 'key', name }])
      expect(decodeKeys(`\u001b[${String(code)};5u`)).toEqual([{ kind: 'key', name }])
    }
  })

  it('keeps a ctrl gesture when shift is held with it', () => {
    // Modifier 6 is ctrl+shift. `ctrl-shift-c` is the same gesture as `ctrl-c` — a
    // terminal reports the base key, and the capital is not a different intent.
    expect(decodeKeys('\u001b[99;6u')).toEqual([{ kind: 'key', name: 'ctrl-c' }])
  })

  it('reads an enhanced backspace, which only ever arrives modified', () => {
    // The mode leaves UNMODIFIED backspace on its legacy 0x7f, so a report of code
    // 127 is ctrl- or alt-backspace; deleting a character beats doing nothing.
    expect(decodeKeys('\u001b[127u')).toEqual([{ kind: 'key', name: 'backspace' }])
    expect(decodeKeys('\u001b[127;5u')).toEqual([{ kind: 'key', name: 'backspace' }])
  })

  it('still reads tab and escape when ctrl is held, and does not rebind ctrl-m', () => {
    // Ctrl does not turn these into a ctrl gesture: the ctrl table is keyed by the
    // LETTER code points, and enter is code 13 whatever is held with it. `ctrl-i`
    // and `ctrl-m` are the letters, and they mean what their control bytes mean.
    // Code 109 is the one that matters here — `ctrl-enter` is a special case on
    // code 13, so a real ctrl-m press must still be plain `enter`. Adding enter
    // to the legacy table under a ctrl name would have taken this away.
    expect(decodeKeys('\u001b[9;5u')).toEqual([{ kind: 'key', name: 'tab' }])
    expect(decodeKeys('\u001b[27;5u')).toEqual([{ kind: 'key', name: 'escape' }])
    expect(decodeKeys('\u001b[105;5u')).toEqual([{ kind: 'key', name: 'tab' }])
    expect(decodeKeys('\u001b[109;5u')).toEqual([{ kind: 'key', name: 'enter' }])
  })

  it('holds a lone trailing ESC until the terminal goes quiet', () => {
    // ESC is the first byte of every sequence here, the paste delimiters included,
    // so deciding it early is how a read boundary landing after that byte turns a
    // pasted paragraph back into one Enter per line.
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b')).toEqual([])
    expect(decoder.flush()).toEqual([{ kind: 'key', name: 'escape' }])
  })

  it('reassembles a paste delimiter split immediately after its ESC', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b')).toEqual([])
    expect(decoder.push('[200~first\nsecond\u001b[201~')).toEqual([
      { kind: 'paste', text: 'first\nsecond' },
    ])
  })

  it('resolves a held ESC as escape when the next chunk is not a sequence', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b')).toEqual([])
    expect(decoder.push('x')).toEqual([{ kind: 'key', name: 'escape' }, { kind: 'text', text: 'x' }])
  })

  it('flushes nothing when nothing is held', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('ab')).toEqual([{ kind: 'text', text: 'ab' }])
    expect(decoder.flush()).toEqual([])
  })

  it('never ends an active paste on an idle flush', () => {
    // A paste arriving in chunks with a gap is indistinguishable from one that
    // stopped, and cutting a real one short turns the rest of the document into
    // Enter keys that submit fragments — the failure bracketed paste prevents.
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b[200~first line\n')).toEqual([])
    expect(decoder.flush()).toEqual([])
    expect(decoder.flush()).toEqual([])
    expect(decoder.push('second line\u001b[201~')).toEqual([
      { kind: 'paste', text: 'first line\nsecond line' },
    ])
  })

  it('holds an unfinished sequence across a flush rather than typing it', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b[')).toEqual([])
    expect(decoder.flush()).toEqual([])
    expect(decoder.push('A')).toEqual([{ kind: 'key', name: 'up' }])
  })

  it('decodes a lone ESC through the stateless helper, which holds nothing back', () => {
    // decodeKeys is documented for callers holding the whole input, so a held tail
    // has to be decided before it returns.
    expect(decodeKeys('\u001b')).toEqual([{ kind: 'key', name: 'escape' }])
  })

  it('holds an incomplete sequence instead of guessing at it', () => {
    // Terminals emit a sequence in one burst, so a truncated one means the read
    // split it; reporting escape here would drop the real key.
    expect(decodeKeys('\u001b[')).toEqual([])
  })

  it('decodes a sequence split across two reads', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b[')).toEqual([])
    expect(decoder.push('D')).toEqual([{ kind: 'key', name: 'left' }])
  })

  it('decodes alt-enter as a deliberate newline', () => {
    expect(decodeKeys('\u001b\r')).toEqual([{ kind: 'key', name: 'newline' }])
  })

  it('decodes control bytes', () => {
    expect(decodeKeys('\u0003')).toEqual([{ kind: 'key', name: 'ctrl-c' }])
    expect(decodeKeys('\u007f')).toEqual([{ kind: 'key', name: 'backspace' }])
  })

  it('keeps an astral character whole', () => {
    const keys = decodeKeys('🙂')
    expect(keys).toEqual([{ kind: 'text', text: '🙂' }])
  })

  it('handles a burst carrying text, a key, and more text', () => {
    expect(decodeKeys('ab\u001b[Dcd')).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'key', name: 'left' },
      { kind: 'text', text: 'cd' },
    ])
  })
})

describe('bracketed paste', () => {
  it('reports pasted content as one literal key, newlines included', () => {
    const pasted = 'first\nsecond\nthird'
    expect(decodeKeys(`\u001b[200~${pasted}\u001b[201~`)).toEqual([{ kind: 'paste', text: pasted }])
  })

  it('reassembles a paste split across reads', () => {
    const decoder = createKeyDecoder()
    expect(decoder.push('\u001b[200~one\n')).toEqual([])
    expect(decoder.push('two\n')).toEqual([])
    expect(decoder.push('three\u001b[201~')).toEqual([{ kind: 'paste', text: 'one\ntwo\nthree' }])
  })

  it('does not split a paste on a partial terminator', () => {
    const decoder = createKeyDecoder()
    // The chunk ends mid-terminator, which must not be treated as content.
    expect(decoder.push('\u001b[200~body\u001b[20')).toEqual([])
    expect(decoder.push('1~')).toEqual([{ kind: 'paste', text: 'body' }])
  })

  it('keeps typing before and after a paste separate from it', () => {
    expect(decodeKeys('a\u001b[200~pasted\u001b[201~b')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'paste', text: 'pasted' },
      { kind: 'text', text: 'b' },
    ])
  })

  it('treats a control byte inside a paste as content, not a key', () => {
    // A pasted document may contain anything; only the terminator ends it.
    expect(decodeKeys('\u001b[200~a\u0003b\u001b[201~')).toEqual([
      { kind: 'paste', text: 'a\u0003b' },
    ])
  })
})

describe('Composer', () => {
  it('inserts text at the cursor and reports the change', () => {
    const composer = new Composer()
    expect(composer.handle({ kind: 'text', text: 'hello' })).toEqual({ kind: 'changed' })
    expect(composer.value).toBe('hello')
    expect(composer.cursorColumn).toBe(5)
  })

  it('submits and clears on enter', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'run tests' })
    expect(composer.handle({ kind: 'key', name: 'enter' })).toEqual({ kind: 'submit', text: 'run tests', gesture: 'enter' })
    expect(composer.isEmpty).toBe(true)
  })

  it('reports which gesture submitted, so a frontend can act on the difference', () => {
    // The composer decides nothing with this. It reports the gesture and the
    // frontend maps it onto a delivery, which is what keeps the renderer from
    // learning what an agent is.
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'run tests' })
    expect(composer.handle({ kind: 'key', name: 'ctrl-enter' })).toEqual({
      kind: 'submit',
      text: 'run tests',
      gesture: 'accelerated',
    })
    expect(composer.isEmpty).toBe(true)
  })

  it('treats both submitting keys identically in every other respect', () => {
    // One case handles both, because the difference is never the composer's: an
    // empty buffer is ignored either way (the caller may read it as interrupt),
    // whitespace is cleared rather than sent, and the buffer is cleared before
    // the caller sees the text.
    for (const name of ['enter', 'ctrl-enter'] as const) {
      const composer = new Composer()
      expect(composer.handle({ kind: 'key', name })).toEqual({ kind: 'ignored', key: { kind: 'key', name } })
      composer.handle({ kind: 'text', text: '   ' })
      expect(composer.handle({ kind: 'key', name })).toEqual({ kind: 'changed' })
      expect(composer.isEmpty).toBe(true)
    }
  })

  it('starts a clean edit history after an accelerated submission too', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'sent prompt' })
    composer.handle({ kind: 'key', name: 'ctrl-enter' })
    composer.handle({ kind: 'text', text: 'new draft' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('')
  })

  it('clears whitespace-only input without submitting an empty turn', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: '  \n  ' })

    expect(composer.handle({ kind: 'key', name: 'enter' })).toEqual({ kind: 'changed' })
    expect(composer.isEmpty).toBe(true)
  })

  it('reports an empty enter as ignored, leaving the gesture to the caller', () => {
    const composer = new Composer()
    expect(composer.handle({ kind: 'key', name: 'enter' })).toEqual({
      kind: 'ignored',
      key: { kind: 'key', name: 'enter' },
    })
  })

  it('moves and edits by code point, not code unit', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'a🙂b' })
    composer.handle({ kind: 'key', name: 'left' })
    // One left arrow must skip the whole emoji, not half of it.
    composer.handle({ kind: 'key', name: 'backspace' })
    expect(composer.value).toBe('ab')
  })

  it('measures the cursor in display columns for CJK', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '标准' })
    expect(composer.cursorColumn).toBe(4)
    composer.handle({ kind: 'key', name: 'left' })
    expect(composer.cursorColumn).toBe(2)
  })

  it('deletes the previous word on ctrl-w, including trailing spaces', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'run the tests  ' })
    composer.handle({ kind: 'key', name: 'ctrl-w' })
    expect(composer.value).toBe('run the ')
  })

  it('clears to the line start on ctrl-u and to the end on ctrl-k', () => {
    const composer = new Composer()
    composer.set('abcdef')
    composer.handle({ kind: 'key', name: 'home' })
    composer.handle({ kind: 'key', name: 'right' })
    composer.handle({ kind: 'key', name: 'ctrl-u' })
    expect(composer.value).toBe('bcdef')
    composer.handle({ kind: 'key', name: 'right' })
    composer.handle({ kind: 'key', name: 'ctrl-k' })
    expect(composer.value).toBe('b')
  })

  it('clears the whole draft from its usual end with ctrl-u, and can undo it', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'typed only' })
    expect(composer.handle({ kind: 'key', name: 'ctrl-u' })).toEqual({ kind: 'changed' })
    expect(composer.value).toBe('')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('typed only')
  })

  it('clears the whole draft from any cursor with ctrl-a then ctrl-k', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'typed only' })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'key', name: 'ctrl-a' })
    composer.handle({ kind: 'key', name: 'ctrl-k' })
    expect(composer.value).toBe('')
  })

  it('clamps cursor movement at both ends', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'ab' })
    composer.handle({ kind: 'key', name: 'right' })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'key', name: 'left' })
    expect(composer.cursorColumn).toBe(0)
    expect(composer.handle({ kind: 'key', name: 'backspace' })).toEqual({ kind: 'changed' })
    expect(composer.value).toBe('ab')
  })

  it('inserts a paste literally and sends it as one message', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'line one\nline two\nline three' })
    expect(composer.lines).toHaveLength(3)
    // The whole block is one submit; a newline inside it never sent anything.
    expect(composer.handle({ kind: 'key', name: 'enter' })).toEqual({
      kind: 'submit',
      text: 'line one\nline two\nline three',
      gesture: 'enter',
    })
  })

  it('neutralizes an escape sequence pasted from a log', () => {
    const composer = new Composer()
    // A person pasting a coloured log would otherwise write those bytes straight
    // to the terminal, where they can repaint or clear the interface.
    composer.handle({ kind: 'paste', text: '\u001b[31mred\u001b[0m' })
    expect(composer.value).toBe('^[[31mred^[[0m')
  })

  it('normalizes CRLF and lone CR so a paste splits into logical lines', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'one\r\ntwo\rthree' })
    // A surviving carriage return would return the cursor to column zero, and a
    // buffer split on newlines alone would keep it inside the line.
    expect(composer.value).not.toContain('\r')
    expect(composer.lines).toEqual(['one', 'two', 'three'])
  })

  it('expands a pasted tab, whose rendered width the arithmetic cannot know', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'a\tb' })
    expect(composer.value).toBe('a    b')
    expect(composer.cursorColumn).toBe(6)
  })

  it('leaves typed text alone, since control bytes arrive as named keys', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'plain 标准' })
    expect(composer.value).toBe('plain 标准')
  })

  it('inserts a deliberate newline without sending', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'first' })
    expect(composer.handle({ kind: 'key', name: 'newline' })).toEqual({ kind: 'changed' })
    composer.handle({ kind: 'text', text: 'second' })
    expect(composer.lines).toEqual(['first', 'second'])
  })

  it('reports the cursor per logical line', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'ab\n标准' })
    expect(composer.cursorLine).toBe(1)
    expect(composer.cursorColumn).toBe(4)
    composer.handle({ kind: 'key', name: 'home' })
    expect(composer.cursorColumn).toBe(0)
  })

  it('passes application gestures through as ignored', () => {
    const composer = new Composer()
    for (const name of ['ctrl-c', 'ctrl-d', 'escape', 'tab', 'up'] as const) {
      expect(composer.handle({ kind: 'key', name })).toEqual({ kind: 'ignored', key: { kind: 'key', name } })
    }
  })
})

describe('undo and redo', () => {
  it('undoes typed text and restores the cursor of the moment it was typed', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'hello' })
    expect(composer.handle({ kind: 'key', name: 'ctrl-z' })).toEqual({ kind: 'changed' })
    expect(composer.value).toBe('')
    expect(composer.position).toBe(0)
  })

  it('undoes one whole typing run however the decoder delivered it', () => {
    // Five single-character keys and one five-character key must leave the same
    // single undo step, because a terminal read boundary is not an edit action.
    for (const delivered of [['h', 'e', 'l', 'l', 'o'], ['hello']]) {
      const composer = new Composer()
      for (const char of delivered) composer.handle({ kind: 'text', text: char })
      composer.handle({ kind: 'key', name: 'ctrl-z' })
      expect(composer.value).toBe('')
      composer.handle({ kind: 'key', name: 'ctrl-y' })
      expect(composer.value).toBe('hello')
      expect(composer.position).toBe(5)
    }
  })

  it('starts a fresh undo step after cursor movement', () => {
    // The movement itself leaves no undo trace, and the character typed after it
    // is undone alone, back to the cursor position the movement left.
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'abcdef' })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'text', text: 'X' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('abcdef')
    expect(composer.position).toBe(4)
  })

  it('leaves movement itself with no undo entry', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'abc' })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'key', name: 'home' })
    composer.handle({ kind: 'key', name: 'end' })
    composer.handle({ kind: 'key', name: 'ctrl-a' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    // The only edit was typing; every move is invisible to the undo stack.
    expect(composer.value).toBe('')
  })

  it('undoes a paste as one edit', () => {
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: 'line one\nline two' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('')
  })

  it('undoes a deliberate newline as its own edit', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'first' })
    composer.handle({ kind: 'key', name: 'newline' })
    composer.handle({ kind: 'text', text: 'second' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('first\n')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('first')
  })

  it('undoes backspace to the exact previous state', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'abc' })
    composer.handle({ kind: 'key', name: 'backspace' })
    expect(composer.value).toBe('ab')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('abc')
    expect(composer.position).toBe(3)
  })

  it('undoes delete to the exact previous state', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'abc' })
    composer.handle({ kind: 'key', name: 'home' })
    composer.handle({ kind: 'key', name: 'delete' })
    expect(composer.value).toBe('bc')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('abc')
    expect(composer.position).toBe(0)
  })

  it('joins a held backspace into one undo step', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'abcdef' })
    for (let press = 0; press < 3; press += 1) composer.handle({ kind: 'key', name: 'backspace' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('abcdef')
  })

  it('undoes ctrl-w, ctrl-u and ctrl-k', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'run the tests' })
    composer.handle({ kind: 'key', name: 'ctrl-w' })
    expect(composer.value).toBe('run the ')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('run the tests')

    const toStart = new Composer()
    toStart.handle({ kind: 'text', text: 'abcdef' })
    toStart.handle({ kind: 'key', name: 'home' })
    toStart.handle({ kind: 'key', name: 'right' })
    toStart.handle({ kind: 'key', name: 'ctrl-u' })
    expect(toStart.value).toBe('bcdef')
    toStart.handle({ kind: 'key', name: 'ctrl-z' })
    expect(toStart.value).toBe('abcdef')
    expect(toStart.position).toBe(1)

    const toEnd = new Composer()
    toEnd.handle({ kind: 'text', text: 'abcdef' })
    toEnd.handle({ kind: 'key', name: 'home' })
    toEnd.handle({ kind: 'key', name: 'right' })
    toEnd.handle({ kind: 'key', name: 'right' })
    toEnd.handle({ kind: 'key', name: 'ctrl-k' })
    expect(toEnd.value).toBe('ab')
    toEnd.handle({ kind: 'key', name: 'ctrl-z' })
    expect(toEnd.value).toBe('abcdef')
    expect(toEnd.position).toBe(2)
  })

  it('undoes a completion replacement as one edit', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '/model dee' })
    composer.replaceBeforeCursor([...'dee'].length, 'deepseek-v4 ')
    expect(composer.value).toBe('/model deepseek-v4 ')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('/model dee')
    expect(composer.position).toBe(10)
  })

  it('redoes the exact value and cursor', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'hello' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    composer.handle({ kind: 'key', name: 'ctrl-y' })
    expect(composer.value).toBe('hello')
    expect(composer.position).toBe(5)
  })

  it('clears redo when a new edit follows an undo', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'A' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    composer.handle({ kind: 'text', text: 'B' })
    composer.handle({ kind: 'key', name: 'ctrl-y' })
    // A is gone for good: the new edit branched history.
    expect(composer.value).toBe('B')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('')
  })

  it('treats set() as a baseline that undo cannot cross', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'half-written draft' })
    composer.set('historical prompt')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('historical prompt')
    composer.handle({ kind: 'text', text: ' edit' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('historical prompt')
  })

  it('starts a clean edit history after submission', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'sent prompt' })
    expect(composer.handle({ kind: 'key', name: 'enter' })).toEqual({ kind: 'submit', text: 'sent prompt', gesture: 'enter' })
    composer.handle({ kind: 'text', text: 'new draft' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('')
    // The sent prompt is history's, never reachable through the draft's undo.
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('')
  })

  it('is a harmless no-op at the oldest and newest states', () => {
    const composer = new Composer()
    expect(composer.handle({ kind: 'key', name: 'ctrl-z' })).toEqual({ kind: 'changed' })
    expect(composer.value).toBe('')
    composer.handle({ kind: 'text', text: 'x' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    composer.handle({ kind: 'key', name: 'ctrl-y' })
    composer.handle({ kind: 'key', name: 'ctrl-y' })
    expect(composer.value).toBe('x')
  })

  it('treats an application gesture as a typing boundary', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'a' })
    expect(composer.handle({ kind: 'key', name: 'ctrl-c' })).toEqual({ kind: 'ignored', key: { kind: 'key', name: 'ctrl-c' } })
    composer.handle({ kind: 'text', text: 'b' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('a')
  })

  it('keeps at most fifty undo steps', () => {
    const composer = new Composer()
    for (let step = 0; step < 60; step += 1) {
      composer.handle({ kind: 'text', text: 'x' })
      composer.handle({ kind: 'key', name: 'left' })
      composer.handle({ kind: 'key', name: 'right' })
    }
    for (let undo = 0; undo < 50; undo += 1) composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect([...composer.value]).toHaveLength(10)
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect([...composer.value]).toHaveLength(10)
  })

  it('bounds retained characters for very large drafts', () => {
    // Two snapshots of a 60k-character draft together exceed the 100k code-point
    // budget, so the older one is dropped and only the newest edit stays
    // undoable — repeated edits of an enormous prompt cannot retain it all.
    const BIG = 'x'.repeat(60_000)
    const composer = new Composer()
    composer.handle({ kind: 'text', text: BIG })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'text', text: 'y' })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'text', text: 'z' })
    expect([...composer.value]).toHaveLength(60_002)
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect([...composer.value]).toHaveLength(60_001)
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    // Only the edit just undone was still reachable; the start of the draft's
    // history was dropped for the character budget.
    expect([...composer.value]).toHaveLength(60_001)
  })

  it('applies the character budget across both stacks together', () => {
    // Undo does not free the older snapshots, it moves them into the redo
    // stack — so a cap applied to one stack at a time lets the pair hold nearly
    // twice the budget once part of a large draft has been undone. Here the
    // undo stack holds 100_000 code points exactly; undoing one step pushes a
    // 60_001-code-point state into redo, which puts the PAIR over the budget,
    // and the oldest snapshot must go even though neither stack is over on its
    // own.
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'x'.repeat(40_000) })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'text', text: 'y'.repeat(20_000) })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'text', text: 'z' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect([...composer.value]).toHaveLength(60_000)
    // The older historical states were surrendered for the pair's budget: there
    // is nothing left to undo, and only the state just undone is redoable.
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect([...composer.value]).toHaveLength(60_000)
    composer.handle({ kind: 'key', name: 'ctrl-y' })
    expect([...composer.value]).toHaveLength(60_001)
  })

  it('keeps a branch edit undoable even when the redo stack is saturated', () => {
    // A new edit discards the undone states; with the count budget full, the
    // branch snapshot must be recorded after that discard, or the bounds could
    // trim the very step the reader is creating.
    const composer = new Composer()
    for (let step = 0; step < 60; step += 1) {
      composer.handle({ kind: 'text', text: 'x' })
      composer.handle({ kind: 'key', name: 'left' })
      composer.handle({ kind: 'key', name: 'right' })
    }
    for (let undo = 0; undo < 50; undo += 1) composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect([...composer.value]).toHaveLength(10)
    composer.handle({ kind: 'text', text: 'B' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('x'.repeat(10))
  })

  it('keeps the most recent edit undoable even when the draft alone exceeds the budget', () => {
    // One snapshot may exceed the character budget on its own — the edit a
    // reader just made is always undoable — but no second one may: the next
    // push drops it, which is what keeps the retention bounded.
    const HUGE = 'x'.repeat(150_000)
    const composer = new Composer()
    composer.handle({ kind: 'text', text: HUGE })
    composer.handle({ kind: 'key', name: 'home' })
    composer.handle({ kind: 'text', text: 'y' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe(HUGE)
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe(HUGE)
  })

  it('treats a no-op redo as a typing boundary', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'a' })
    composer.handle({ kind: 'key', name: 'ctrl-y' })
    composer.handle({ kind: 'text', text: 'b' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('a')
  })

  it('undoes and redoes CJK, astral, and mixed text by code point', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '标准🙂a🙂标准' })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('')
    composer.handle({ kind: 'key', name: 'ctrl-y' })
    expect(composer.value).toBe('标准🙂a🙂标准')
    expect(composer.position).toBe([...'标准🙂a🙂标准'].length)
  })

  it('restores an undo step that began beside an astral character, never splitting one', () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: 'a🙂b' })
    composer.handle({ kind: 'key', name: 'left' })
    composer.handle({ kind: 'key', name: 'backspace' })
    expect(composer.value).toBe('ab')
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('a🙂b')
    expect(composer.position).toBe(2)
  })

  it('undoes a multiline draft of mixed scripts exactly', () => {
    const draft = '第一行\nsecond🙂line\n第三行'
    const composer = new Composer()
    composer.handle({ kind: 'paste', text: draft })
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('')
    composer.handle({ kind: 'key', name: 'ctrl-y' })
    expect(composer.value).toBe(draft)
  })

  it('keeps the cursor within the code-point count across an edit/undo/redo sequence', () => {
    // A deterministic mixed sequence, the way a person actually edits: type,
    // move, delete, paste, complete, undo, redo. After every step the cursor
    // invariant holds, which is what makes the mutation ranges safe.
    const composer = new Composer()
    const steps = [
      { kind: 'text', text: '标准🙂' },
      { kind: 'key', name: 'left' },
      { kind: 'text', text: 'abc' },
      { kind: 'key', name: 'home' },
      { kind: 'key', name: 'backspace' },
      { kind: 'paste', text: '多行\n第二行' },
      { kind: 'key', name: 'ctrl-u' },
      { kind: 'key', name: 'ctrl-z' },
      { kind: 'key', name: 'ctrl-y' },
      { kind: 'key', name: 'ctrl-z' },
      { kind: 'key', name: 'ctrl-z' },
    ] as const
    for (const key of steps) {
      composer.handle(key)
      const length = [...composer.value].length
      expect(composer.position).toBeGreaterThanOrEqual(0)
      expect(composer.position).toBeLessThanOrEqual(length)
    }
  })
})
