/**
 * Raw terminal input decoding.
 *
 * In raw mode the terminal delivers bytes, not events: a chunk may carry a whole
 * escape sequence, several keystrokes at once, a pasted paragraph, or half of any
 * of those. Decoding is therefore stateful — {@link createKeyDecoder} keeps the
 * undecidable tail of one chunk and resumes on the next, so a sequence split
 * across reads is not mistaken for the characters that compose it.
 * @module @dshline/renderer/keys
 */

/** Named keys the renderer distinguishes from printable input. */
export type KeyName =
  | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'delete' | 'backspace' | 'enter' | 'newline' | 'tab' | 'escape'
  | 'ctrl-a' | 'ctrl-c' | 'ctrl-d' | 'ctrl-e' | 'ctrl-f' | 'ctrl-k' | 'ctrl-l'
  | 'ctrl-o' | 'ctrl-r' | 'ctrl-u' | 'ctrl-w' | 'ctrl-y' | 'ctrl-z'
  | 'ctrl-enter'

/**
 * One decoded keystroke.
 *
 * `paste` is separate from `text` because its content is literal: a newline
 * inside a paste is part of the pasted document, while a newline typed at the
 * keyboard is `enter` and means send.
 */
export type Key =
  | { kind: 'key'; name: KeyName }
  | { kind: 'text'; text: string }
  | { kind: 'paste'; text: string }

/** Bracketed-paste delimiters, which the terminal emits around pasted content. */
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/** Escape sequences shared by xterm-family terminals, by their tail. */
const CSI_KEYS: Readonly<Record<string, KeyName>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  '1~': 'home',
  '3~': 'delete',
  '4~': 'end',
  '7~': 'home',
  '8~': 'end',
  // Alt-enter, which terminals send as ESC then CR. Shift-enter arrives through
  // the enhanced encodings below instead, because a terminal in its default mode
  // sends a bare CR for it — indistinguishable from enter itself.
  '\r': 'newline',
  '\n': 'newline',
}

/** Modifier bits a terminal reports, one less than the number it sends. */
const SHIFT = 0b1
const ALT = 0b10
const CTRL = 0b100

/**
 * Keys an enhanced encoding reports by their code point, and what they are here.
 *
 * The keys whose own code point says what they are, whatever modifiers came with
 * them; {@link CTRL_KEYS} covers the ones that are reported as a letter plus the
 * ctrl bit. Anything else decodes to nothing rather than to text: an unrecognised
 * sequence typed into the composer as `[13;2u` is worse than a keystroke that did
 * not register.
 *
 * Backspace is here because the enhanced mode leaves the UNMODIFIED key on its
 * legacy `0x7f`, so a report of code 127 only ever arrives modified — and deleting
 * a character is the useful answer to ctrl-backspace, where doing nothing is not.
 */
const ENHANCED_KEYS: Readonly<Record<number, KeyName>> = {
  13: 'enter',
  9: 'tab',
  27: 'escape',
  127: 'backspace',
}

/** Single control bytes, indexed by their code. */
const CONTROL_KEYS: Readonly<Record<number, KeyName>> = {
  0x01: 'ctrl-a',
  0x03: 'ctrl-c',
  0x04: 'ctrl-d',
  0x05: 'ctrl-e',
  0x06: 'ctrl-f',
  0x08: 'backspace',
  0x09: 'tab',
  0x0a: 'enter',
  0x0b: 'ctrl-k',
  0x0c: 'ctrl-l',
  0x0d: 'enter',
  0x0f: 'ctrl-o',
  0x12: 'ctrl-r',
  0x15: 'ctrl-u',
  0x17: 'ctrl-w',
  0x19: 'ctrl-y',
  0x1a: 'ctrl-z',
  0x7f: 'backspace',
}

/**
 * Enhanced reports of the ctrl gestures, by the code point they carry.
 *
 * A terminal in the enhanced mode does not send `ctrl-c` as `0x03` at all: it
 * reports the letter's own code point with the ctrl bit set, `CSI 99 ; 5 u`. So a
 * decoder that knows only {@link CONTROL_KEYS} drops every ctrl gesture on exactly
 * the terminals that implement the mode this renderer asks for — the keystroke
 * decodes to nothing, and cancelling or quitting looks like a hung UI.
 *
 * DERIVED from the legacy table rather than written out beside it, because the two
 * must not drift: a ctrl gesture is `0x60` below its letter, so a key added to
 * {@link CONTROL_KEYS} is recognised in both encodings without a second edit. Only
 * the letters are mapped; `0x7f` has no ctrl form and {@link ENHANCED_KEYS} carries
 * backspace by its own code point.
 */
const CTRL_KEYS: Readonly<Record<number, KeyName>> = Object.fromEntries(
  Object.entries(CONTROL_KEYS)
    .map(([byte, name]): readonly [number, KeyName] => [Number(byte) + 0x60, name])
    .filter(([code]) => code >= 0x61 && code <= 0x7a),
)

/**
 * Decode one enhanced key report.
 *
 * Two encodings say the same thing, and a terminal uses one or the other. The
 * kitty keyboard protocol sends `CSI code ; modifiers u`; xterm's `modifyOtherKeys`
 * sends `CSI 27 ; modifiers ; code ~`. Both are parsed because which one arrives
 * depends on the terminal, and neither is worth requiring of the user.
 *
 * The modifier field is one-based — no modifiers is `1` — so the bits are read
 * from `modifiers - 1`.
 * @param params - the parameter bytes between the introducer and the final byte.
 * @param final - the sequence's final byte, `u` or `~`.
 * @returns the key, or undefined when this is not an enhanced key report.
 */
function decodeEnhanced(params: string, final: string): Key | undefined {
  const fields = params.split(';')
  const numbers = fields.map(field => Number.parseInt(field, 10))
  const [first, second, third] = numbers
  let code: number | undefined
  let modifiers: number | undefined
  if (final === 'u' && first !== undefined && !Number.isNaN(first)) {
    code = first
    modifiers = second
  } else if (final === '~' && first === 27 && third !== undefined && !Number.isNaN(third)) {
    code = third
    modifiers = second
  }
  if (code === undefined) return undefined
  const bits = modifiers === undefined || Number.isNaN(modifiers) ? 0 : modifiers - 1
  // Read BEFORE the by-code-point table, because the two overlap: `ctrl-i` is code
  // 105 here while `tab` is code 9, and a ctrl gesture is what the ctrl bit means.
  // Shift alongside it is ignored on purpose — `ctrl-shift-c` is the same gesture.
  if ((bits & CTRL) !== 0) {
    const ctrl = CTRL_KEYS[code]
    if (ctrl !== undefined) return { kind: 'key', name: ctrl }
  }
  const name = ENHANCED_KEYS[code]
  if (name === undefined) return undefined
  // Shift or alt with enter means a newline rather than a submission. ALT belongs
  // here as much as shift does: on a terminal that implements this protocol,
  // alt-enter arrives as `CSI 13 ; 3 u` instead of the legacy `ESC CR`, so
  // recognising only shift would make the documented fallback gesture SUBMIT —
  // sending an unfinished prompt on exactly the terminals where the mode works.
  if (name === 'enter' && (bits & (SHIFT | ALT)) !== 0) return { kind: 'key', name: 'newline' }
  // Ctrl with enter is its own key, and it is the one gesture here that CANNOT
  // follow rule 6's derived table. A ctrl gesture's enhanced code is its letter's
  // code point, and enter's legacy byte `0x0d` derives to `0x6d` — the letter `m`.
  // Adding enter to CONTROL_KEYS under a ctrl name would therefore rebind ctrl-m,
  // which every terminal sends for enter itself. So this is a deliberate special
  // case on code 13, checked AFTER the newline test above so `ctrl-shift-enter`
  // stays a newline rather than becoming a third gesture nobody asked for.
  //
  // It exists in the enhanced encodings ONLY. A terminal in its default mode sends
  // a bare CR for this chord, byte-identical to enter, so there is no legacy form
  // to map and no way to detect the difference — which is why nothing advertises
  // this key and why every route that reads it must treat plain enter as the
  // answer a terminal is allowed to give.
  if (name === 'enter' && (bits & CTRL) !== 0) return { kind: 'key', name: 'ctrl-enter' }
  return { kind: 'key', name }
}

/** Terminating byte of a CSI sequence. */
function isCsiFinal(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x40 && code <= 0x7e
}

/** Whether `text` could still become `sequence` given more input. */
function isPrefixOf(text: string, sequence: string): boolean {
  return text.length < sequence.length && sequence.startsWith(text)
}

/** A decoder that survives sequences split across reads. */
export interface KeyDecoder {
  /**
   * Decode one raw chunk.
   * @param chunk - bytes as received from the terminal, decoded as UTF-8.
   * @returns the keystrokes now decidable, in order.
   */
  push(chunk: string): Key[]
  /**
   * Decide whatever is being held, because no more input is coming.
   *
   * The owner calls this after a short idle. A held tail is ambiguous only while
   * the terminal might still be mid-sequence; once it has gone quiet, a lone ESC
   * is the Escape key and a half-written sequence is not going to be finished.
   * @returns the keystrokes the held tail resolves to, in order.
   */
  flush(): Key[]
}

/**
 * Windows console modifier bits, as win32-input-mode reports them.
 *
 * These are the `dwControlKeyState` bits of the input record underneath, where left
 * and right are separate: a right alt pressed together with ctrl is how Windows
 * spells AltGr, which is why each pair is read as one modifier here.
 */
const WIN32_SHIFT = 0x0010
const WIN32_ALT = 0x0001 | 0x0002
const WIN32_CTRL = 0x0004 | 0x0008

/** Virtual-key code of Enter, the one key whose modifiers mean something to this decoder. */
const WIN32_RETURN = 0x0d

/**
 * Keys win32-input-mode reports with no character of their own, by virtual-key code,
 * and the xterm sequence that names them.
 *
 * Only the keys this interface reads are listed: the arrows, home, end and delete.
 * `page up`, `page down`, `insert` and the function keys are deliberately absent —
 * they decoded to nothing before this mode was asked for and still do, and inventing
 * meanings for keys the composer has none for would be a behaviour change hiding
 * inside a compatibility translation.
 */
const WIN32_FUNCTION_KEYS: Readonly<Record<number, string>> = {
  0x23: 'F',  // end
  0x24: 'H',  // home
  0x25: 'D',  // left
  0x26: 'A',  // up
  0x27: 'C',  // right
  0x28: 'B',  // down
  0x2e: '3~', // delete
}

/**
 * Where a win32-input-mode report begins and ends in `input`.
 *
 * What makes a report a report is its shape — `CSI vk ; scan ; char ; down ; control
 * ; repeat _` — and nothing else. An escape sequence that only looks like one, a
 * pasted `CSI 0 m`, is left alone; the decoder behind this is the only place that
 * knows what an escape sequence means.
 * @param input - the bytes read so far.
 * @param start - offset of the `ESC` that opens the sequence.
 * @returns its end and parameters, `'partial'` while it is still being written, or
 *   undefined when these bytes are not a report at all.
 */
function scanWin32Report(input: string, start: number): { end: number; params: string } | 'partial' | undefined {
  let cursor = start + 2
  let params = ''
  while (cursor < input.length) {
    const char = input.charAt(cursor)
    if (char === '_') return params === '' ? undefined : { end: cursor + 1, params }
    if ((char >= '0' && char <= '9') || char === ';') {
      params += char
      cursor += 1
      continue
    }
    return undefined
  }
  return 'partial'
}

/**
 * The character one report carries.
 *
 * Windows reports a character above the basic plane as two reports, one per UTF-16
 * code unit, so the halves are joined here. Text reaching the decoder below is
 * therefore always whole: a lone half inserted into the composer would be lost to a
 * replacement character and could never be repaired.
 * @param unit - the report's UTF-16 code unit.
 * @param surrogates - the high surrogate held from the previous report, if any.
 * @returns the text to insert, `''` when the report was only the first half.
 */
function win32Character(unit: number, surrogates: { high: number }): string {
  if (unit >= 0xd800 && unit <= 0xdbff) {
    surrogates.high = unit
    return ''
  }
  const held = surrogates.high
  surrogates.high = 0
  if (held !== 0 && unit >= 0xdc00 && unit <= 0xdfff) return String.fromCharCode(held, unit)
  // An unpaired half is passed on as it came, which is what the console's own
  // encoder does with one; dropping it would silently delete the character.
  return held === 0 ? String.fromCharCode(unit) : String.fromCharCode(held, unit)
}

/**
 * Translate one report into the input the decoder below already reads.
 *
 * This is a translation, not a second keyboard. A report becomes the bytes that
 * already mean this key here — a character, a control code, an xterm function-key
 * sequence, or the kitty form of a modified enter — so the tables above stay the
 * only place a key's meaning is written down, and a gesture is read the same way
 * whatever encoding carried it.
 * @param params - the `;`-separated fields between `CSI` and `_`.
 * @param surrogates - the high surrogate held from the previous report, if any.
 * @returns the input the report stands for, or `''` when it reports nothing to do.
 */
function win32ReportToInput(params: string, surrogates: { high: number }): string {
  const fields = params.split(';').map(field => Number.parseInt(field, 10))
  const vk = fields[0]
  const char = fields[2]
  const down = fields[3]
  const control = fields[4] ?? 0
  // A key UP is dropped. Every key arrives twice in this mode, and the decoder is
  // edge-triggered: reading the release too would type every character twice.
  if (down !== 1) return ''
  const shift = (control & WIN32_SHIFT) !== 0
  const alt = (control & WIN32_ALT) !== 0
  const ctrl = (control & WIN32_CTRL) !== 0
  if (vk === WIN32_RETURN) {
    const bits = (shift ? SHIFT : 0) | (alt ? ALT : 0) | (ctrl ? CTRL : 0)
    // Unmodified enter stays the bare carriage return every terminal sends for it;
    // a modified one takes the kitty encoding so that shift, alt and ctrl keep the
    // single meaning they already have on the terminals that report them.
    return bits === 0 ? '\r' : `\u001b[13;${String(bits + 1)}u`
  }
  if (char !== undefined && char !== 0) {
    const text = win32Character(char, surrogates)
    if (text === '') return ''
    // A ctrl gesture is already the control character here, which is exactly the
    // byte the legacy table names. AltGr is ctrl AND right alt in one report and is
    // a character, not a chord: prefixing it with ESC would break every layout that
    // uses it for one.
    return alt && !ctrl ? `\u001b${text}` : text
  }
  const tail = vk === undefined ? undefined : WIN32_FUNCTION_KEYS[vk]
  if (tail === undefined) return ''
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)
  if (modifier === 1) return `\u001b[${tail}`
  // The xterm shapes the legacy table above already reads: a letter-terminated
  // sequence carries its modifier after a leading 1, a `~` sequence after its code.
  return tail.endsWith('~')
    ? `\u001b[${tail.slice(0, -1)};${String(modifier)}~`
    : `\u001b[1;${String(modifier)}${tail}`
}

/** The translation of win32-input-mode reports in front of the decoder. */
interface Win32Reports {
  /**
   * Translate every complete report in a chunk, holding one still being written.
   * @param chunk - one raw read.
   * @returns the chunk with each complete report translated.
   */
  push(chunk: string): string
  /**
   * Release the held bytes, because no more input is coming.
   * @returns the held bytes, untranslated.
   */
  flush(): string
}

/**
 * Create the win32-input-mode translation.
 *
 * The work is done BEFORE the decoder rather than inside it for one reason: a
 * bracketed paste is a stream of literal text with real keys embedded in it. The
 * newline of a multi-line paste arrives as an enter report, so translating here
 * fills a paste with newlines, where translating inside the decoder's paste branch
 * would have to know about pastes at all.
 * @returns the translation, holding at most one unfinished report between reads.
 */
function createWin32Reports(): Win32Reports {
  /** A report the console is still writing. */
  let pending = ''
  /** The high surrogate of a character report whose other half has not arrived. */
  const surrogates = { high: 0 }

  return {
    flush() {
      const held = pending
      pending = ''
      return held
    },
    push(chunk) {
      const input = pending + chunk
      pending = ''
      let output = ''
      let cursor = 0
      for (;;) {
        const escape = input.indexOf('\u001b[', cursor)
        if (escape < 0) break
        output += input.slice(cursor, escape)
        const report = scanWin32Report(input, escape)
        if (report === 'partial') {
          // Held, not dropped: the console can hand a report over in two reads, and
          // half a report decoded as text would reach the composer as itself.
          pending = input.slice(escape)
          return output
        }
        if (report === undefined) {
          output += '\u001b['
          cursor = escape + 2
          continue
        }
        output += win32ReportToInput(report.params, surrogates)
        cursor = report.end
      }
      output += input.slice(cursor)
      // A trailing escape may still become a report, exactly as the decoder below
      // holds one while it waits for the rest of its own sequence.
      if (input.endsWith('\u001b')) {
        pending = '\u001b'
        output = output.slice(0, -1)
      }
      return output
    },
  }
}

/**
 * Create a decoder.
 *
 * A lone ESC at the end of a chunk is HELD, not reported. It is the first byte of
 * every sequence this decoder recognises, the paste delimiters included, so
 * deciding it early is how a read boundary landing after that byte turns a pasted
 * paragraph back into one Enter per line — the exact failure bracketed paste exists
 * to prevent. What resolves it is {@link KeyDecoder.flush}, which the owner calls
 * after a short idle: by then the terminal has stopped writing, so the byte was the
 * Escape key. That costs the Escape key a few milliseconds and costs a split
 * delimiter nothing.
 *
 * Windows console input reports are translated first, because a console asked for
 * win32-input-mode sends every key that way and none of it is legible to the parser
 * below.
 * @returns the decoder.
 */
export function createKeyDecoder(): KeyDecoder {
  const reports = createWin32Reports()
  const decoder = createLegacyDecoder()
  return {
    push(chunk) { return decoder.push(reports.push(chunk)) },
    flush() { return [...decoder.push(reports.flush()), ...decoder.flush()] },
  }
}

/**
 * Create the decoder for the encodings terminals speak directly.
 *
 * Split from {@link createKeyDecoder} so that the Windows translation can be a layer
 * in front of this rather than a second set of branches inside it.
 * @returns the decoder.
 */
function createLegacyDecoder(): KeyDecoder {
  /** Undecidable tail of the previous chunk. */
  let rest = ''
  /** Content accumulated since a paste began, or undefined when not pasting. */
  let pasted: string | undefined

  return {
    flush() {
      // An ACTIVE paste is never ended here. A paste arriving in chunks with a gap
      // between them — a slow link, or a terminal that streams a large one — is
      // indistinguishable from a paste that stopped, and cutting a real one short
      // turns the rest of the document into Enter keys that submit fragments. That
      // is the failure bracketed paste exists to prevent, so waiting for the
      // terminator is the only safe answer and an unterminated paste is simply held.
      if (pasted !== undefined) return []
      // Only the escape ambiguity resolves. A half-written sequence stays held: it
      // is not decidable, and typing it into the composer as `[200` is worse than
      // waiting for the rest.
      if (rest !== '\u001b') return []
      rest = ''
      return [{ kind: 'key', name: 'escape' }]
    },
    push(chunk) {
      const keys: Key[] = []
      let buffer = rest + chunk
      rest = ''
      let text = ''
      const flush = (): void => {
        if (text !== '') {
          keys.push({ kind: 'text', text })
          text = ''
        }
      }

      while (buffer !== '') {
        if (pasted !== undefined) {
          const end = buffer.indexOf(PASTE_END)
          if (end >= 0) {
            keys.push({ kind: 'paste', text: pasted + buffer.slice(0, end) })
            pasted = undefined
            buffer = buffer.slice(end + PASTE_END.length)
            continue
          }
          // Keep back only as much as could be a partial terminator, so a large
          // paste does not accumulate unboundedly waiting for its end.
          const keep = Math.min(buffer.length, PASTE_END.length - 1)
          pasted += buffer.slice(0, buffer.length - keep)
          rest = buffer.slice(buffer.length - keep)
          return keys
        }

        if (buffer.startsWith(PASTE_START)) {
          flush()
          pasted = ''
          buffer = buffer.slice(PASTE_START.length)
          continue
        }
        // A tail that could still become a paste delimiter waits for more input,
        // a lone ESC included: it is a prefix of both delimiters, and `flush`
        // resolves it once the terminal goes quiet.
        if (isPrefixOf(buffer, PASTE_START) || isPrefixOf(buffer, PASTE_END)) {
          flush()
          rest = buffer
          return keys
        }

        const char = buffer[0] ?? ''
        const code = char.codePointAt(0) ?? 0

        if (code === 0x1b) {
          flush()
          const next = buffer[1]
          if (next === undefined) {
            // Unreachable in practice: a lone ESC is held as a delimiter prefix
            // above. Kept so this branch cannot silently drop the key if that test
            // ever stops covering it.
            rest = buffer
            return keys
          }
          if (next === '[' || next === 'O') {
            let cursor = 2
            let params = ''
            while (cursor < buffer.length && !isCsiFinal(buffer[cursor] ?? '')) {
              params += buffer[cursor]
              cursor += 1
            }
            const final = buffer[cursor]
            if (final === undefined) {
              // Incomplete: hold it rather than dropping the key.
              rest = buffer
              return keys
            }
            const name = CSI_KEYS[`${params}${final}`] ?? CSI_KEYS[final]
            if (name !== undefined) {
              keys.push({ kind: 'key', name })
            } else {
              // Enhanced key reports carry their modifiers in the parameters, so
              // they are parsed rather than looked up. An unrecognized sequence is
              // still dropped rather than inserted as text: the alternative writes
              // `[<27;5;13~` into the composer.
              const enhanced = decodeEnhanced(params, final)
              if (enhanced !== undefined) keys.push(enhanced)
            }
            buffer = buffer.slice(cursor + 1)
            continue
          }
          // ESC followed by an ordinary byte is an alt-modified key; only the
          // deliberate-newline pair is recognized.
          const alt = CSI_KEYS[next]
          if (alt !== undefined) keys.push({ kind: 'key', name: alt })
          else keys.push({ kind: 'key', name: 'escape' })
          buffer = buffer.slice(alt === undefined ? 1 : 2)
          continue
        }

        const control = CONTROL_KEYS[code]
        if (control !== undefined) {
          flush()
          keys.push({ kind: 'key', name: control })
          buffer = buffer.slice(1)
          continue
        }
        if (code < 0x20) {
          buffer = buffer.slice(1)
          continue
        }
        // Advance by code point, not code unit, so an astral character survives.
        const point = String.fromCodePoint(code)
        text += point
        buffer = buffer.slice(point.length)
      }
      flush()
      return keys
    },
  }
}

/**
 * Decode one complete chunk, keeping no state.
 *
 * For callers holding whole input at once. A live terminal should use
 * {@link createKeyDecoder}, which resumes across reads.
 *
 * The flush is part of the contract: the chunk IS the whole input, so nothing more
 * is coming and a held tail has to be decided. Without it a lone ESC would come
 * back as no keys at all, because the stateful decoder holds it waiting for bytes
 * this caller has already said do not exist.
 * @param chunk - bytes as received from the terminal, decoded as UTF-8.
 * @returns the keystrokes the chunk carries, in order.
 */
export function decodeKeys(chunk: string): Key[] {
  const decoder = createKeyDecoder()
  return [...decoder.push(chunk), ...decoder.flush()]
}
