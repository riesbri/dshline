import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalStreams } from '../src/index.ts'
import { acquireTerminal, isInteractive } from '../src/index.ts'
// Deliberately NOT from the package root: `terminalModes` is a seam for the
// keyprobe diagnostic rather than something the renderer promises its callers, so
// a test that reached for it through the public entry point would be asking for an
// export this project has decided not to have.
import { terminalModes } from '../src/terminal.ts'

/** Streams that claim to be, or not to be, a terminal. */
function streams(input: boolean, output: boolean): TerminalStreams {
  return {
    input: { isTTY: input } as unknown as NodeJS.ReadStream,
    output: { isTTY: output } as unknown as NodeJS.WriteStream,
  }
}

/** Real listener bookkeeping with failures injected after the chosen side effect. */
function failingStreams(initiallyRaw = false) {
  const failure = new Error('terminal operation failed')
  let failAt: string | undefined
  let raw = initiallyRaw
  let paused = true
  const written: string[] = []
  const attempted: string[] = []
  const check = (operation: string): void => {
    attempted.push(operation)
    if (operation === failAt) throw failure
  }
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    get isRaw() { return raw },
    setRawMode(value: boolean) { raw = value; check(`raw:${String(value)}`) },
    setEncoding() { check('encoding') },
    resume() { paused = false; check('resume') },
    pause() { paused = true; check('pause') },
  })
  const output = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 80, rows: 24,
    write(chunk: string) { written.push(chunk); check('write'); return true },
  })
  const inputOn = input.on.bind(input)
  input.on = ((event: string, listener: (...args: unknown[]) => void) => {
    inputOn(event, listener)
    check(`input:${event}`)
    return input
  }) as typeof input.on
  const outputOn = output.on.bind(output)
  output.on = ((event: string, listener: (...args: unknown[]) => void) => {
    outputOn(event, listener)
    check(`output:${event}`)
    return output
  }) as typeof output.on
  const inputOff = input.off.bind(input)
  input.off = ((event: string, listener: (...args: unknown[]) => void) => {
    inputOff(event, listener)
    check(`off:${event}`)
    return input
  }) as typeof input.off
  const outputOff = output.off.bind(output)
  output.off = ((event: string, listener: (...args: unknown[]) => void) => {
    outputOff(event, listener)
    check(`off:${event}`)
    return output
  }) as typeof output.off
  return {
    streams: { input, output } as unknown as TerminalStreams,
    input, output, written, attempted, failure,
    fail: (operation?: string) => { failAt = operation },
    isRaw: () => raw, isPaused: () => paused,
  }
}

describe('terminal exception safety', () => {
  it.each(['raw:true', 'encoding', 'write', 'resume', 'input:data', 'output:resize'])(
    'rolls back acquisition when %s fails after its side effect', operation => {
      const fake = failingStreams()
      const foreignData = (): void => {}
      const foreignResize = (): void => {}
      fake.input.on('data', foreignData)
      fake.output.on('resize', foreignResize)
      fake.fail(operation)
      expect(() => acquireTerminal(fake.streams)).toThrow()
      expect(fake.isRaw()).toBe(false)
      expect(fake.isPaused()).toBe(true)
      expect(fake.input.listeners('data')).toEqual([foreignData])
      expect(fake.output.listeners('resize')).toEqual([foreignResize])
      if (['write', 'resume', 'input:data', 'output:resize'].includes(operation)) {
        const off = terminalModes().off
        expect(fake.written.at(-1)).toBe(operation === 'write' ? off.replace('\u001b[<u', '') : off)
      }
    },
  )

  it.each(['none', 'paste-only'] as const)(
    'does not pop a previous keyboard stack entry when the failed enable write delivered %s', delivered => {
      const fake = failingStreams()
      const failure = new Error('enable write failed before the keyboard push')
      const accepted: string[] = []
      let first = true
      fake.streams.output.write = ((chunk: string) => {
        if (first) {
          first = false
          if (delivered === 'paste-only') accepted.push('\u001b[?2004h')
          throw failure
        }
        accepted.push(chunk)
        return true
      }) as typeof fake.streams.output.write
      expect(() => acquireTerminal(fake.streams)).toThrow(failure)
      expect(fake.isRaw()).toBe(false)
      expect(fake.input.listenerCount('data')).toBe(0)
      expect(fake.output.listenerCount('resize')).toBe(0)
      expect(accepted.join('')).not.toContain('\u001b[<u')
      expect(accepted.at(-1)).toBe(terminalModes().off.replace('\u001b[<u', ''))
    },
  )

  it.each([false, true])('restores initially raw=%s and releases listeners despite failed shutdown writes', initiallyRaw => {
    const fake = failingStreams(initiallyRaw)
    const terminal = acquireTerminal(fake.streams)
    const keys = vi.fn()
    const resizes = vi.fn()
    terminal.onKey(keys)
    terminal.onResize(resizes)
    fake.fail('write')
    expect(() => terminal.close()).toThrow(fake.failure)
    expect(fake.isRaw()).toBe(initiallyRaw)
    expect(fake.isPaused()).toBe(true)
    expect(fake.input.listenerCount('data')).toBe(0)
    expect(fake.output.listenerCount('resize')).toBe(0)
    fake.input.emit('data', 'x')
    fake.output.emit('resize')
    expect(keys).not.toHaveBeenCalled()
    expect(resizes).not.toHaveBeenCalled()
    const attempted = [...fake.attempted]
    fake.fail()
    expect(() => terminal.close()).not.toThrow()
    terminal.setTitle('too late')
    expect(fake.attempted).toEqual(attempted)
  })

  it.each(['off:data', 'off:resize', 'raw:false', 'pause'])(
    'runs independent cleanup and retries only pending restoration after %s fails', operation => {
      const fake = failingStreams()
      const terminal = acquireTerminal(fake.streams)
      fake.fail(operation)
      expect(() => terminal.close()).toThrow(fake.failure)
      expect(fake.isRaw()).toBe(false)
      expect(fake.isPaused()).toBe(true)
      expect(fake.input.listenerCount('data')).toBe(0)
      expect(fake.output.listenerCount('resize')).toBe(0)
      const writes = [...fake.written]
      const attempts = fake.attempted.length
      fake.fail()
      terminal.close()
      expect(fake.attempted.slice(attempts)).toEqual([operation])
      expect(fake.written).toEqual(writes)
      const restored = [...fake.attempted]
      terminal.close()
      expect(fake.attempted).toEqual(restored)
    },
  )

  it('cancels a pending decoder timer even when shutdown writes fail', () => {
    vi.useFakeTimers()
    const fake = failingStreams()
    const terminal = acquireTerminal(fake.streams)
    const keys = vi.fn()
    terminal.onKey(keys)
    try {
      fake.input.emit('data', '\u001b')
      expect(vi.getTimerCount()).toBe(1)
      fake.fail('write')
      expect(() => terminal.close()).toThrow(fake.failure)
      expect(vi.getTimerCount()).toBe(0)
      vi.runAllTimers()
      expect(keys).not.toHaveBeenCalled()
    } finally {
      fake.fail()
      terminal.close()
      vi.useRealTimers()
    }
  })

  it('does not rearm the decoder timer when a key handler closes the terminal', () => {
    vi.useFakeTimers()
    const fake = failingStreams()
    const terminal = acquireTerminal(fake.streams)
    terminal.onKey(() => { terminal.close() })
    try {
      fake.input.emit('data', 'x')
      expect(vi.getTimerCount()).toBe(0)
      expect(fake.isRaw()).toBe(false)
      expect(fake.input.listenerCount('data')).toBe(0)
    } finally {
      terminal.close()
      vi.useRealTimers()
    }
  })

  it('keeps the acquisition error first when rollback writes also fail', () => {
    const fake = failingStreams()
    const acquisition = new Error('enable write failed')
    const rollback = new Error('rollback write failed')
    let writes = 0
    fake.streams.output.write = (() => { throw ++writes === 1 ? acquisition : rollback }) as typeof fake.streams.output.write
    let caught: unknown
    try { acquireTerminal(fake.streams) } catch (error: unknown) { caught = error }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([acquisition, rollback])
    expect(fake.isRaw()).toBe(false)
    expect(fake.input.listenerCount('data')).toBe(0)
    expect(fake.output.listenerCount('resize')).toBe(0)
  })
})

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

  it.each(['ascii', 'two words', 'café', '中文 日本語 한국어', '🚀👩‍💻', ''])('writes exact OSC 2 BEL bytes for %j', title => {
    const fake = fakeStreams(false)
    const terminal = acquireTerminal(fake)
    terminal.setTitle(title)
    expect(fake.written.at(-1)).toBe(`\u001b]2;${title}\u0007`)
    terminal.close()
  })

  it('removes every C0/C1 control and DEL, including OSC and ST bytes', () => {
    const fake = fakeStreams(false)
    const terminal = acquireTerminal(fake)
    const controls = Array.from({ length: 160 }, (_, code) => code)
      .filter(code => code < 32 || code >= 127)
      .map(code => String.fromCodePoint(code)).join('')
    terminal.setTitle(`safe${controls}工作🚀`)
    expect(fake.written.at(-1)).toBe('\u001b]2;safe工作🚀\u0007')
    terminal.setTitle('a\u001b]52;c;evil\u0007b\u001b\\c\u009d2;evil\u009cd\n\r\te')
    expect(fake.written.at(-1)).toBe('\u001b]2;a]52;c;evilb\\c2;evilde\u0007')
    terminal.setTitle(controls)
    expect(fake.written.at(-1)).toBe('\u001b]2;\u0007')
    terminal.close()
  })

  it('bounds sanitized metadata to 120 whole code points, not UTF-16 units', () => {
    const fake = fakeStreams(false)
    const terminal = acquireTerminal(fake)
    terminal.setTitle('a'.repeat(119) + '\u001b🚀overflow')
    expect(fake.written.at(-1)).toBe(`\u001b]2;${'a'.repeat(119)}🚀\u0007`)
    terminal.setTitle('🚀'.repeat(121))
    expect(fake.written.at(-1)).toBe(`\u001b]2;${'🚀'.repeat(120)}\u0007`)
    terminal.close()
  })

  it('replaces lone surrogates without damaging valid emoji', () => {
    const fake = fakeStreams(false)
    const terminal = acquireTerminal(fake)
    terminal.setTitle('\ud800x\udc00🚀')
    expect(fake.written.at(-1)).toBe('\u001b]2;�x�🚀\u0007')
    terminal.close()
  })

  it('does not invent restoration, query titles, or write after ownership closes', () => {
    const fake = fakeStreams(false)
    const terminal = acquireTerminal(fake)
    const modes = terminalModes()
    terminal.setTitle('owned')
    terminal.close()
    terminal.close()
    terminal.setTitle('too late')
    expect(fake.written).toEqual([modes.on, '\u001b]2;owned\u0007', modes.off])
  })

  it('uses the same title protocol on Windows without changing mode cleanup', () => {
    withPlatform('win32', () => {
      const fake = fakeStreams(false)
      const terminal = acquireTerminal(fake)
      terminal.setTitle('dshline · 工作🚀')
      terminal.close()
      expect(fake.written).toEqual([
        terminalModes().on, '\u001b]2;dshline · 工作🚀\u0007', terminalModes().off,
      ])
    })
  })

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

  it('asks for the same thing a second way, and takes that back too', () => {
    // A terminal multiplexer is a terminal emulator: it answers `CSI > 1 u` itself
    // and does not forward it, which was measured on tmux 3.7c — the request left
    // its `pane_key_mode` at the default and shift-enter still arrived as a bare
    // carriage return, so a frontend behind it submitted an unfinished prompt.
    // `CSI > 4 ; 1 m` is the request tmux does honour, and it is sent everywhere
    // for the same reason the kitty one is: a terminal that does not implement it
    // ignores it, so asking costs nothing and a tmux-shaped path gains the gesture.
    const fake = fakeStreams(false)
    const terminal = acquireTerminal({ input: fake.input, output: fake.output })
    expect(fake.written.join('')).toContain('\u001b[>4;1m')
    terminal.close()
    // Level 0 is how the resource starts; anything else leaves a mode behind.
    expect(fake.written.join('')).toContain('\u001b[>4;0m')
  })

  it('emits the modes as exact byte strings, in a fixed order', () => {
    // Asserted literally rather than by containment: these are protocol bytes, and
    // the ORDER is part of the contract because the teardown reverses it.
    withPlatform('linux', () => {
      expect(terminalModes()).toEqual({
        on: '\u001b[?2004h\u001b[>1u\u001b[>4;1m',
        off: '\u001b[>4;0m\u001b[<u\u001b[?2004l',
      })
    })
  })

  it('emits the Windows console mode around the others, unchanged by the new request', () => {
    // The console host answers its own protocol, so its mode is asked for last and
    // taken back first. The two keyboard requests either side of it are the same
    // bytes a POSIX terminal is sent.
    withPlatform('win32', () => {
      expect(terminalModes()).toEqual({
        on: '\u001b[?2004h\u001b[>1u\u001b[>4;1m\u001b[?9001h',
        off: '\u001b[?9001l\u001b[>4;0m\u001b[<u\u001b[?2004l',
      })
    })
  })

  it('leaves no keyboard mode behind when the same terminal is closed twice', () => {
    // The one invariant that outranks the rest: no mode may survive this process.
    // A second close that re-emitted the release would be harmless, but a close
    // that skipped it would hand the next program a keyboard nobody asked for.
    const fake = fakeStreams(false)
    const terminal = acquireTerminal({ input: fake.input, output: fake.output })
    terminal.close()
    const afterFirst = fake.written.length
    terminal.close()
    expect(fake.written).toHaveLength(afterFirst)
    const written = fake.written.join('')
    expect(written.lastIndexOf('\u001b[>4;0m')).toBeGreaterThan(written.lastIndexOf('\u001b[>4;1m'))
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
