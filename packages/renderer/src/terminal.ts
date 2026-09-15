/**
 * Raw-mode terminal ownership.
 *
 * Raw mode is process-global state: it must be restored on every exit path,
 * including a crash, or the user's shell is left without echo. Every acquisition
 * therefore returns one disposer that is safe to call twice, and the owner
 * registers no signal handlers of its own — `ctrl-c` arrives as a decoded key so
 * the application decides what cancelling means.
 * @module @dshline/renderer/terminal
 */

import type { Key } from './keys.ts'
import { createKeyDecoder } from './keys.ts'
import type { ScreenTarget } from './screen.ts'

/** The process streams a terminal owner drives. */
export interface TerminalStreams {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
}

/** A live raw-mode terminal. */
export interface Terminal extends ScreenTarget {
  /** Current terminal height in rows. */
  rows(): number
  /** Observe decoded keystrokes; returns the removal disposer. */
  onKey(listener: (key: Key) => void): () => void
  /** Observe terminal resizes; returns the removal disposer. */
  onResize(listener: () => void): () => void
  /** Restore the terminal to the state it was acquired in. Idempotent. */
  close(): void
}

/** Default columns when the stream reports none, matching the classic width. */
const FALLBACK_COLUMNS = 80

/** Default rows when the stream reports none, matching the classic height. */
const FALLBACK_ROWS = 24

/**
 * Bracketed paste. With it enabled the terminal wraps pasted content in
 * delimiters, which is the only reliable way to tell a pasted newline from a
 * pressed one — without it, a pasted paragraph arrives as a burst of Enter keys
 * and sends one message per line.
 */
const PASTE_ON = '\u001b[?2004h'
const PASTE_OFF = '\u001b[?2004l'

/**
 * Ask the terminal to report modified keys distinguishably.
 *
 * Without this, shift-enter is a bare carriage return — the same bytes as enter —
 * so a frontend cannot offer it as "newline" however much it would like to. The
 * kitty keyboard protocol's lowest flag, `disambiguate escape codes`, is what
 * changes that: unmodified keys keep their legacy encodings, and a MODIFIED enter
 * arrives as `CSI 13 ; 2 u` instead.
 *
 * The lowest flag on purpose. Higher ones report key releases and every key as an
 * escape sequence, which would rewrite how all input is decoded for one gesture.
 *
 * A terminal that does not implement this ignores the sequence, which is why it is
 * pushed unconditionally: the cost of asking is nothing, and the fallback is the
 * behaviour that existed before — shift-enter submits, and alt-enter is still there.
 *
 * What asking DOES cost is that a terminal which obeys stops sending the legacy
 * encodings for esc, alt, and ctrl combinations: `ctrl-c` arrives as `CSI 99 ; 5 u`
 * and never as `0x03` again. The decoder therefore has to read those reports, and
 * anything added to it that is reachable by ctrl needs a mapping in both encodings
 * — a key known only by its control byte is DEAD on every terminal that implements
 * this, which is not a fallback but a regression.
 */
const ENHANCED_KEYS_ON = '\u001b[>1u'

/** Pop what was pushed, so the terminal is handed back as it was found. */
const ENHANCED_KEYS_OFF = '\u001b[<u'

/**
 * Ask a Windows console to report every key as an input record.
 *
 * The kitty protocol above is the right request everywhere else and is sent
 * everywhere, but Windows Terminal below version 1.25 does not implement it, and
 * has never implemented xterm's `modifyOtherKeys`. What those consoles do have is
 * win32-input-mode, and without asking for it a modified enter does not reach the
 * process at all: the console translates it to the same bare carriage return as
 * enter, so shift-enter submits — the bug this mode fixes. A console that does not
 * implement it ignores the sequence, which leaves exactly the old behaviour.
 *
 * Only Windows is asked, unlike the kitty request. This mode belongs to the Windows
 * console host rather than to terminals in general, and a non-Windows terminal that
 * does not know the number is better left alone than trusted to ignore it.
 */
const WIN32_KEYS_ON = '\u001b[?9001h'

/** Leave the console reporting the encodings it started with. */
const WIN32_KEYS_OFF = '\u001b[?9001l'

/**
 * Whether this process is the native Windows console path the mode belongs to.
 *
 * Read per acquisition rather than once at import, so the choice is a property of
 * the run and not of whichever platform happened to load this module.
 * @returns whether the Windows console mode should be requested.
 */
function isWindowsConsole(): boolean {
  return process.platform === 'win32'
}

/**
 * The input modes this renderer asks for, and the sequences that give them back.
 *
 * Exported because `tools/keyprobe.mjs` has to ask for exactly what the frontend
 * asks for. A probe that requests a different set reports encodings the interface
 * never sees, which is worse than no probe at all: it answers the question with the
 * wrong terminal mode. The tool imports this module's built file directly and the
 * package root deliberately does not re-export it: it is a seam for that diagnostic,
 * not something the renderer promises to callers.
 * @returns the bytes that turn the modes on, and the bytes that turn them off.
 */
export function terminalModes(): { on: string; off: string } {
  const windowsConsole = isWindowsConsole()
  return {
    on: `${PASTE_ON}${ENHANCED_KEYS_ON}${windowsConsole ? WIN32_KEYS_ON : ''}`,
    // Undone in the reverse order they were asked for, and the console mode first:
    // every one of these changes how the next program reads its input.
    off: `${windowsConsole ? WIN32_KEYS_OFF : ''}${ENHANCED_KEYS_OFF}${PASTE_OFF}`,
  }
}

/**
 * Idle time after which the decoder's held tail is decided.
 *
 * A lone ESC is the first byte of every sequence the decoder recognises, so it can
 * only be read as the Escape key once the terminal has stopped writing. This is
 * the delay that costs: long enough that a delimiter split across two reads is
 * still reassembled, short enough that a cancel feels immediate.
 */
const IDLE_FLUSH_MS = 30

/**
 * Whether both streams are terminals. A frontend must check this BEFORE
 * acquiring: raw mode on a pipe throws, and a UI with no terminal to draw on
 * would otherwise idle forever instead of failing.
 * @param streams - the process streams to test.
 * @returns whether interactive use is possible.
 */
export function isInteractive(streams: TerminalStreams): boolean {
  return streams.input.isTTY === true && streams.output.isTTY === true
}

/**
 * Acquire raw mode and start decoding input.
 * @param streams - the process streams to own.
 * @returns the live terminal; `close()` restores the previous mode.
 * @throws when either stream is not a terminal.
 */
export function acquireTerminal(streams: TerminalStreams): Terminal {
  if (!isInteractive(streams)) {
    throw new Error('@dshline/renderer: acquireTerminal requires a terminal on both stdin and stdout')
  }
  const { input, output } = streams
  const keyListeners = new Set<(key: Key) => void>()
  const resizeListeners = new Set<() => void>()
  const wasRaw = input.isRaw === true
  const decoder = createKeyDecoder()

  let idle: NodeJS.Timeout | undefined
  const dispatch = (keys: readonly Key[]): void => {
    for (const key of keys) {
      // Copy first: a listener may dispose itself while the batch is dispatching.
      for (const listener of [...keyListeners]) listener(key)
    }
  }
  const stopIdle = (): void => {
    if (idle === undefined) return
    clearTimeout(idle)
    idle = undefined
  }
  const onData = (chunk: string): void => {
    stopIdle()
    dispatch(decoder.push(chunk))
    // Anything the decoder is still holding is ambiguous only while more bytes
    // might arrive. Unref'd so a pending decision never keeps the process alive.
    idle = setTimeout(() => {
      idle = undefined
      dispatch(decoder.flush())
    }, IDLE_FLUSH_MS).unref()
  }
  const onResize = (): void => {
    for (const listener of [...resizeListeners]) listener()
  }

  input.setRawMode(true)
  input.setEncoding('utf8')
  output.write(terminalModes().on)
  input.resume()
  input.on('data', onData)
  output.on('resize', onResize)

  let closed = false
  return {
    write: chunk => { output.write(chunk) },
    columns: () => output.columns ?? FALLBACK_COLUMNS,
    rows: () => output.rows ?? FALLBACK_ROWS,
    onKey: listener => {
      keyListeners.add(listener)
      return () => { keyListeners.delete(listener) }
    },
    onResize: listener => {
      resizeListeners.add(listener)
      return () => { resizeListeners.delete(listener) }
    },
    close: () => {
      if (closed) return
      closed = true
      stopIdle()
      output.write(terminalModes().off)
      input.off('data', onData)
      output.off('resize', onResize)
      input.setRawMode(wasRaw)
      // Release the handle so the process can exit; the stream is shared with
      // whatever ran before, so it is paused rather than destroyed.
      input.pause()
      keyListeners.clear()
      resizeListeners.clear()
    },
  }
}
