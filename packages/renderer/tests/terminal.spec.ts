import { describe, expect, it } from 'vitest'
import type { TerminalStreams } from '../src/index.ts'
import { acquireTerminal, isInteractive } from '../src/index.ts'

/** Streams that claim to be, or not to be, a terminal. */
function streams(input: boolean, output: boolean): TerminalStreams {
  return {
    input: { isTTY: input } as unknown as NodeJS.ReadStream,
    output: { isTTY: output } as unknown as NodeJS.WriteStream,
  }
}

describe('isInteractive()', () => {
  it('requires a terminal on both streams', () => {
    expect(isInteractive(streams(true, true))).toBe(true)
    expect(isInteractive(streams(true, false))).toBe(false)
    expect(isInteractive(streams(false, true))).toBe(false)
    expect(isInteractive(streams(false, false))).toBe(false)
  })

  it('treats an absent isTTY as not a terminal', () => {
    // A pipe leaves the property undefined rather than false.
    expect(isInteractive({
      input: {} as unknown as NodeJS.ReadStream,
      output: {} as unknown as NodeJS.WriteStream,
    })).toBe(false)
  })
})

describe('acquireTerminal()', () => {
  it('refuses streams that are not a terminal', () => {
    // The frontend checks isInteractive() first and exits non-zero; this throw is
    // the backstop for a caller that does not, because raw mode on a pipe would
    // otherwise fail somewhere less obvious.
    expect(() => acquireTerminal(streams(false, true))).toThrow(/requires a terminal/u)
  })

  /** A fake stdin that records mode changes and starts in `initiallyRaw`. */
  function fakeStreams(initiallyRaw: boolean) {
    const log: string[] = []
    let raw = initiallyRaw
    const listeners = new Map<string, unknown>()
    const input = {
      isTTY: true,
      get isRaw() { return raw },
      setRawMode(value: boolean) {
        raw = value
        log.push(`raw:${String(value)}`)
      },
      setEncoding() { log.push('encoding') },
      resume() { log.push('resume') },
      pause() { log.push('pause') },
      on(event: string, listener: unknown) { listeners.set(event, listener) },
      off(event: string) { listeners.delete(event) },
    } as unknown as NodeJS.ReadStream
    const written: string[] = []
    const output = {
      isTTY: true,
      columns: 80,
      write(chunk: string) { written.push(chunk); return true },
      on() {}, off() {},
    } as unknown as NodeJS.WriteStream
    return { input, output, log, listeners, written, isRaw: () => raw }
  }

  it('restores raw mode to TRUE when it was already raw before acquisition', () => {
    // The case that matters and that a `setRawMode(false)` teardown gets wrong:
    // this frontend may not be the first thing to have put the stream in raw mode,
    // and clearing it would break whatever did.
    const fake = fakeStreams(true)
    const terminal = acquireTerminal({ input: fake.input, output: fake.output })
    expect(fake.isRaw()).toBe(true)
    terminal.close()
    expect(fake.isRaw()).toBe(true)
    expect(fake.log.filter(entry => entry === 'raw:false')).toEqual([])
  })

  it('enables bracketed paste and disables it again on close', () => {
    // Without it a pasted newline is indistinguishable from a pressed one; leaving
    // it enabled after exit changes how the user's shell behaves.
    const fake = fakeStreams(false)
    const terminal = acquireTerminal({ input: fake.input, output: fake.output })
    expect(fake.written.join('')).toContain('\u001b[?2004h')
    terminal.close()
    expect(fake.written.join('')).toContain('\u001b[?2004l')
  })

  it('asks for distinguishable modified keys, and hands the terminal back as found', () => {
    // Without this shift-enter is a bare carriage return, so it cannot be offered
    // as anything but enter. Leaving the mode pushed would change how the user's
    // next program reads its own input.
    const fake = fakeStreams(false)
    const terminal = acquireTerminal({ input: fake.input, output: fake.output })
    expect(fake.written.join('')).toContain('\u001b[>1u')
    terminal.close()
    expect(fake.written.join('')).toContain('\u001b[<u')
  })

  /** Run `body` with `process.platform` reporting `platform`. */
  function withPlatform(platform: NodeJS.Platform, body: () => void): void {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    try {
      body()
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original)
    }
  }

  it('asks a Windows console for input records, and takes the request back on close', () => {
    // The kitty request above is ignored by the Windows Terminal that ships today,
    // and a console that is not asked for its own input records sends shift-enter as
    // a bare carriage return. Leaving the mode on would change how the next program
    // reads the keyboard.
    withPlatform('win32', () => {
      const fake = fakeStreams(false)
      const terminal = acquireTerminal({ input: fake.input, output: fake.output })
      expect(fake.written.join('')).toContain('\u001b[?9001h')
      terminal.close()
      expect(fake.written.join('')).toContain('\u001b[?9001l')
    })
  })

  it('does not ask for the Windows console mode anywhere else', () => {
    // It belongs to the Windows console host, so a terminal on another platform is
    // left alone rather than trusted to ignore a number it has never heard of.
    withPlatform('linux', () => {
      const fake = fakeStreams(false)
      const terminal = acquireTerminal({ input: fake.input, output: fake.output })
      terminal.close()
      expect(fake.written.join('')).not.toContain('9001')
    })
  })

  it('gives the modes back in the reverse order they were asked for', () => {
    // Restoring out of order would turn a mode back on after disabling it — the
    // console first, then the kitty flags, then paste.
    withPlatform('win32', () => {
      const fake = fakeStreams(false)
      const terminal = acquireTerminal({ input: fake.input, output: fake.output })
      terminal.close()
      const written = fake.written.join('')
      const console = written.indexOf('\u001b[?9001l')
      const kitty = written.indexOf('\u001b[<u')
      const paste = written.indexOf('\u001b[?2004l')
      expect(console).toBeGreaterThan(-1)
      expect(console).toBeLessThan(kitty)
      expect(kitty).toBeLessThan(paste)
    })
  })

  it('restores the previous raw mode and releases the stream on close', () => {
    const log: string[] = []
    let raw = false
    const listeners = new Map<string, unknown>()
    const input = {
      isTTY: true,
      get isRaw() { return raw },
      setRawMode(value: boolean) {
        raw = value
        log.push(`raw:${String(value)}`)
      },
      setEncoding() { log.push('encoding') },
      resume() { log.push('resume') },
      pause() { log.push('pause') },
      on(event: string, listener: unknown) { listeners.set(event, listener) },
      off(event: string) { listeners.delete(event) },
    } as unknown as NodeJS.ReadStream
    const output = {
      isTTY: true,
      columns: 80,
      write() { return true },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream

    const terminal = acquireTerminal({ input, output })
    expect(log).toContain('raw:true')
    expect(listeners.has('data')).toBe(true)

    terminal.close()
    // Restoring the mode it found, not a hardcoded false: the stream may have
    // been raw before this frontend touched it.
    expect(log.at(-2)).toBe('raw:false')
    expect(log.at(-1)).toBe('pause')
    expect(listeners.has('data')).toBe(false)

    // Closing twice must not re-run teardown.
    const beforeSecondClose = log.length
    terminal.close()
    expect(log).toHaveLength(beforeSecondClose)
  })

  it('reports the terminal height', () => {
    const fake = fakeStreams(false)
    Object.assign(fake.output, { rows: 37 })
    const terminal = acquireTerminal({ input: fake.input, output: fake.output })
    expect(terminal.rows()).toBe(37)
    terminal.close()
  })

  it('falls back to a classic terminal size when dimensions are absent', () => {
    const terminal = acquireTerminal({
      input: {
        isTTY: true,
        setRawMode() {}, setEncoding() {}, resume() {}, pause() {}, on() {}, off() {},
      } as unknown as NodeJS.ReadStream,
      output: {
        isTTY: true, columns: undefined, rows: undefined, write() { return true }, on() {}, off() {},
      } as unknown as NodeJS.WriteStream,
    })
    expect(terminal.columns()).toBe(80)
    expect(terminal.rows()).toBe(24)
    terminal.close()
  })
})
