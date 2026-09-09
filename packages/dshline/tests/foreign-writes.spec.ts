/**
 * What a writer dshline does not own does to the live region.
 *
 * `Screen` redraws by climbing the geometry it remembers, so a write it did not
 * issue is not a cosmetic problem: it moves the origin every later erase is
 * measured from, and the frame's first rows — the separator and the root
 * chrome — are then never erased again. They scroll up as ordinary output and
 * stay in native scrollback, once per commit that follows.
 *
 * Two claims are tested here, and they are different claims. The first is about
 * the terminal: a raw write into the region really does make root chrome
 * durable, so the containment below is guarding a real failure rather than a
 * theory. The second is about the containment: while the window holds the
 * terminal, `process.stderr.fd` is not the terminal, so the one raw-descriptor
 * writer in the adopted Harness generation cannot reach a cell.
 * @module dshline/tests/foreign-writes
 */

import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Screen } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { rootFrame } from '../src/chrome.ts'
import { holdStderrOffTerminal } from '../src/stderr.ts'

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

describe('holding stderr off the terminal', () => {
  it('sends a raw descriptor write to the hole rather than the terminal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dshline-stderr-'))
    const path = join(directory, 'stderr')
    const captured = openSync(path, 'w+')
    // A stand-in for the process's own stderr: a real descriptor a raw write
    // can reach, claiming to be a terminal so the hold engages.
    const stderr = { isTTY: true, fd: captured } as unknown as NodeJS.WriteStream
    const stdout = { isTTY: true } as unknown as NodeJS.WriteStream
    const release = holdStderrOffTerminal(stderr, stdout)
    try {
      expect(stderr.fd).not.toBe(captured)
      writeFileSync(stderr.fd, Buffer.from('codex app-server: starting\n'))
      expect(readFileSync(path, 'utf8')).toBe('')
    } finally {
      release()
      closeSync(captured)
    }
    // Released with terminal ownership: the next process to own descriptor 2
    // must find it where it was left.
    expect(stderr.fd).toBe(captured)
  })

  it('is released exactly once, however many times ownership is disposed', () => {
    const stderr = { isTTY: true, fd: 2 } as unknown as NodeJS.WriteStream
    const stdout = { isTTY: true } as unknown as NodeJS.WriteStream
    const release = holdStderrOffTerminal(stderr, stdout)
    release()
    release()
    expect(stderr.fd).toBe(2)
  })

  it('leaves a stderr that is not the terminal exactly as it was', () => {
    // `2>log` is a workflow, not a hazard: a redirected stderr cannot displace
    // a live region, so nothing about it is moved.
    const stderr = { isTTY: false, fd: 2 } as unknown as NodeJS.WriteStream
    const stdout = { isTTY: true } as unknown as NodeJS.WriteStream
    const release = holdStderrOffTerminal(stderr, stdout)
    expect(stderr.fd).toBe(2)
    release()
    expect(stderr.fd).toBe(2)
  })

  it('leaves stderr alone when nothing is drawing on a terminal at all', () => {
    const stderr = { isTTY: true, fd: 2 } as unknown as NodeJS.WriteStream
    const stdout = { isTTY: false } as unknown as NodeJS.WriteStream
    holdStderrOffTerminal(stderr, stdout)()
    expect(stderr.fd).toBe(2)
  })

  it('leaves the stream writing path alone, so dshline can still report a failure', () => {
    const written: string[] = []
    const stderr = {
      isTTY: true,
      fd: 2,
      write: (chunk: string) => { written.push(chunk); return true },
    } as unknown as NodeJS.WriteStream
    const stdout = { isTTY: true } as unknown as NodeJS.WriteStream
    const release = holdStderrOffTerminal(stderr, stdout)
    stderr.write('dshline: boot failed\r\n')
    release()
    expect(written).toEqual(['dshline: boot failed\r\n'])
  })
})
