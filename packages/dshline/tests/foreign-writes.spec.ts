/**
 * What a writer dshline does not own does to the live region.
 *
 * `Screen` redraws by climbing the geometry it remembers, so a write it did not
 * issue is not a cosmetic problem: it moves the origin every later erase is
 * measured from, and the frame's first rows — the separator and the root
 * chrome — are then never erased again. They scroll up as ordinary output and
 * stay in native scrollback, once per commit that follows.
 *
 * Three separate claims are tested here. The first is about the terminal: a raw
 * write into the region really does make root chrome durable, so the
 * containment is guarding a real failure rather than a theory. The second is
 * what the containment actually KNOWS — whether a raw descriptor-2 write can
 * land on the terminal being drawn on — which is a device-identity question and
 * not the weaker `isTTY` on both streams it used to be answered with. The third
 * is the containment's own policy: what it holds, what it refuses to touch, and
 * that it puts the descriptor back exactly once.
 *
 * What Node does with a substituted descriptor is deliberately NOT asserted
 * here. That is a runtime behaviour rather than a dshline decision, and a
 * stubbed stream would only prove what the stub does; real child processes pin
 * it in `stderr-descriptor.spec.ts`.
 * @module dshline/tests/foreign-writes
 */

import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Screen } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { rootFrame } from '../src/chrome.ts'
import { holdStderrOffTerminal, rawStderrReach } from '../src/stderr.ts'

/** A second character device, so two DIFFERENT terminals can be stood in for. */
const OTHER_DEVICE = '/dev/zero'

/**
 * A stream stand-in with a real descriptor, which is what the reach test stats.
 * @param fd - the descriptor this stream reports.
 * @param isTTY - what it claims to be.
 * @returns the stand-in.
 */
function stream(fd: number, isTTY: boolean): NodeJS.WriteStream {
  return { fd, isTTY } as unknown as NodeJS.WriteStream
}

/** Wide enough for the framed chrome, narrow enough to read in a failure. */
const COLUMNS = 40

/** Tall enough for a short transcript plus the chrome below it. */
const ROWS = 12

/** The window's live region: separator, framed composer, status row. */
function chrome(): string[] {
  return ['', ...rootFrame({ columns: COLUMNS, context: 'repo', body: ['> '] }), '  ready']
}

/** Rows of root chrome the terminal is holding, scrolled-off ones included. */
async function heldChrome(emulator: ReturnType<typeof createEmulator>): Promise<string[]> {
  return (await emulator.scrollback()).map(row => row.trimEnd()).filter(row => row.includes('dshline'))
}

describe('a raw write into the live region', () => {
  it('makes root chrome durable, which is the failure being contained', async () => {
    const emulator = createEmulator(COLUMNS, ROWS)
    const screen = new Screen(emulator.target)
    screen.commit(['● parent reply'])
    // The cursor sits inside the composer's input row, where the window leaves it.
    screen.setLive(chrome(), { row: 2, column: 4 })

    // Exactly what `writeFileSync(process.stderr.fd, bytes)` does to the
    // terminal dshline is drawing on: bytes at the cursor, and a newline that
    // scrolls the screen out from under the geometry Screen remembers.
    emulator.target.write('codex app-server: starting\ncodex app-server: ready\n')

    for (let index = 0; index < 3; index += 1) {
      screen.commit([`⏺ tool call ${String(index)}`])
      screen.setLive(chrome(), { row: 2, column: 4 })
    }

    // Not an assertion about the fix — an assertion about the hazard. If this
    // ever reports one row, a foreign write stopped being able to displace the
    // region and the containment below is no longer load-bearing.
    expect((await heldChrome(emulator)).length).toBeGreaterThan(1)
    emulator.dispose()
  })

  it('never happens through dshline\'s own writes, however they interleave', async () => {
    const emulator = createEmulator(COLUMNS, ROWS)
    const screen = new Screen(emulator.target)
    // A whole turn's worth of the two writes the window makes: a synchronous
    // commit per session event, a coalesced repaint after it. The live chrome
    // is temporary at every step, so the terminal may hold it exactly once.
    for (let index = 0; index < 40; index += 1) {
      screen.commit([`● line ${String(index)}`, `  continuation ${String(index)}`])
      screen.setLive(chrome(), { row: 2, column: 4 })
      screen.setLive(chrome(), { row: 2, column: 4 })
    }
    expect(await heldChrome(emulator)).toHaveLength(1)
    emulator.dispose()
  })
})

describe('what is known about a raw stderr write reaching the drawn terminal', () => {
  it.skipIf(process.platform === 'win32')('proves one terminal from two descriptors on it', () => {
    // Two descriptors on ONE character device report one non-zero `rdev`,
    // which is an identity rather than the inference `isTTY` on both supports.
    const first = openSync(devNull, 'w')
    const second = openSync(devNull, 'w')
    try {
      expect(rawStderrReach(stream(first, true), stream(second, true))).toBe('reaches')
    } finally {
      closeSync(first)
      closeSync(second)
    }
  })

  it.skipIf(process.platform === 'win32')('proves two terminals apart, and leaves them alone', () => {
    // The case the old `isTTY && isTTY` condition claimed to have ruled out and
    // had not: both are terminals, and a raw write to one cannot reach the
    // other, so nothing should be moved.
    const drawn = openSync(devNull, 'w')
    const other = openSync(OTHER_DEVICE, 'w')
    try {
      expect(rawStderrReach(stream(drawn, true), stream(other, true))).toBe('cannot-reach')
      const stderr = stream(other, true)
      holdStderrOffTerminal(stderr, stream(drawn, true))()
      expect(stderr.fd).toBe(other)
    } finally {
      closeSync(drawn)
      closeSync(other)
    }
  })

  it('settles it without a stat when either end is not a terminal', () => {
    // `2>log` is a workflow, not a hazard — and holding a file-backed stderr
    // would capture its ordinary stream writes, which is the stronger reason.
    expect(rawStderrReach(stream(1, true), stream(2, false))).toBe('cannot-reach')
    // Nothing is being drawn on a terminal, so there is no frame to protect.
    expect(rawStderrReach(stream(1, false), stream(2, true))).toBe('cannot-reach')
  })

  it('answers unknown rather than guessing when the platform cannot say', () => {
    // A Windows console handle is a character device with an `rdev` of zero,
    // and a regular file stands in for that here: claiming to be a terminal,
    // carrying no device identity to compare. The honest answer is that neither
    // fact was established.
    const directory = mkdtempSync(join(tmpdir(), 'dshline-reach-'))
    const path = join(directory, 'not-a-device')
    const fd = openSync(path, 'w+')
    try {
      expect(rawStderrReach(stream(fd, true), stream(fd, true))).toBe('unknown')
    } finally {
      closeSync(fd)
    }
  })

  it('answers unknown when a stream reports no descriptor to stat', () => {
    const nofd = { isTTY: true } as unknown as NodeJS.WriteStream
    expect(rawStderrReach(nofd, nofd)).toBe('unknown')
  })
})

describe('holding stderr off the terminal', () => {
  it('sends a raw descriptor write to the hole rather than the terminal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dshline-stderr-'))
    const path = join(directory, 'stderr')
    const captured = openSync(path, 'w+')
    // A regular file claiming to be a terminal is the `unknown` branch: the
    // platform cannot prove the two descriptors are different terminals, and
    // the conservative answer is to protect the frame.
    const stderr = stream(captured, true)
    const release = holdStderrOffTerminal(stderr, stream(captured, true))
    try {
      expect(stderr.fd).not.toBe(captured)
      writeFileSync(stderr.fd, Buffer.from('a delegated child diagnostic\n'))
      expect(readFileSync(path, 'utf8')).toBe('')
    } finally {
      release()
      closeSync(captured)
    }
    // Released with terminal ownership: the next owner of the descriptor must
    // find it where it was left.
    expect(stderr.fd).toBe(captured)
  })

  it('is released exactly once, however many times ownership is disposed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dshline-stderr-'))
    const fd = openSync(join(directory, 'stderr'), 'w+')
    try {
      const stderr = stream(fd, true)
      const release = holdStderrOffTerminal(stderr, stream(fd, true))
      release()
      release()
      expect(stderr.fd).toBe(fd)
    } finally {
      closeSync(fd)
    }
  })

  it('leaves a stderr that is not the terminal exactly as it was', () => {
    const stderr = stream(2, false)
    const release = holdStderrOffTerminal(stderr, stream(1, true))
    expect(stderr.fd).toBe(2)
    release()
    expect(stderr.fd).toBe(2)
  })

  it('leaves stderr alone when nothing is drawing on a terminal at all', () => {
    const stderr = stream(2, true)
    holdStderrOffTerminal(stderr, stream(1, false))()
    expect(stderr.fd).toBe(2)
  })

  it('refuses a descriptor property it cannot put back the way it found it', () => {
    // An accessor is not a value property, and redefining it would change what
    // the property MEANS to whoever defined it.
    const stderr = { isTTY: true, get fd() { return 2 } } as unknown as NodeJS.WriteStream
    holdStderrOffTerminal(stderr, { isTTY: true, fd: 1 } as unknown as NodeJS.WriteStream)()
    expect(stderr.fd).toBe(2)
  })

  it('leaves the stream writing path alone, so dshline can still report a failure', () => {
    // Only that the shim does not touch `write`. Where a real stream's bytes
    // actually land under substitution is a Node behaviour, pinned by real
    // child processes in stderr-descriptor.spec.ts.
    const written: string[] = []
    const directory = mkdtempSync(join(tmpdir(), 'dshline-stderr-'))
    const fd = openSync(join(directory, 'stderr'), 'w+')
    try {
      const stderr = {
        isTTY: true,
        fd,
        write: (chunk: string) => { written.push(chunk); return true },
      } as unknown as NodeJS.WriteStream
      const release = holdStderrOffTerminal(stderr, stream(fd, true))
      stderr.write('dshline: boot failed\r\n')
      release()
    } finally {
      closeSync(fd)
    }
    expect(written).toEqual(['dshline: boot failed\r\n'])
  })
})
