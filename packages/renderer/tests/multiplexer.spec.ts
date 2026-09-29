/**
 * The keyboard contract when a terminal multiplexer sits between the terminal
 * and this renderer.
 *
 * Everything here runs against a real tmux server created for the test, on a
 * socket and a generated configuration file of its own — the developer's own
 * server and `~/.tmux.conf` are never read, and never written.
 *
 * The client is another tmux, used only as a pseudo-terminal to write into. That
 * is not a shortcut around the thing being tested: `tmux send-keys -H` was
 * measured writing bytes into a pane VERBATIM, bypassing the key negotiation
 * entirely, so it would report the fixed encoding even with the request removed
 * and the test would be a false green. Driving the real client is what makes the
 * assertions mean anything, and an outer tmux supplies one hermetically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Key } from '../src/keys.ts'
import { decodeKeys } from '../src/keys.ts'
import { terminalModes } from '../src/terminal.ts'

/** Why this suite is or is not running, so a skip says something useful. */
type Support = { supported: true } | { supported: false, reason: string }

/**
 * Ask this tmux whether it lets a program REQUEST distinguishable modified keys.
 *
 * Measured, never assumed, and deliberately not a version check. The capability
 * arrived in tmux 3.5 ("Revamp extended keys support ... support mode 2 as well
 * as mode 1"); before that a program could not ask for it at all, and tmux
 * reported no state to ask about — `pane_key_mode` simply does not exist, so the
 * format expands to an empty string. Ubuntu 24.04, which CI runs on, ships tmux
 * 3.4. A version comparison would have to be maintained against every release and
 * would still be a guess about a build; asking the running program is the only
 * answer that cannot be wrong.
 *
 * The whole question is one throwaway server and one `printf`, so the cost of
 * being honest about it is a few hundred milliseconds on a machine that has tmux
 * and nothing at all on one that does not.
 * @returns whether the negotiation this file tests exists here, and if not why.
 */
function measureSupport(): Support {
  if (process.platform === 'win32') return { supported: false, reason: 'not a POSIX platform' }
  const version = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 10000 })
  if (version.status !== 0) return { supported: false, reason: 'tmux is not installed' }
  const name = `dsh-mux-probe-${String(process.pid)}`
  const ask = (args: string[]): string => spawnSync('tmux', ['-L', name, ...args], { encoding: 'utf8', timeout: 10000 }).stdout ?? ''
  // The gate a user would set, written into a configuration file of its own
  // rather than assumed: tmux 3.7 ships `extended-keys` off, and with it off no
  // request is honoured on ANY version, which would make this probe report the
  // wrong reason for the wrong thing.
  const config = join(mkdtempSync(join(tmpdir(), 'dsh-mux-cfg-')), 'tmux.conf')
  writeFileSync(config, 'set -g extended-keys on\n')
  try {
    // `extended-keys on` is the gate a user would set; the program then asks for
    // level 1 the way the frontend does, and tmux reports the mode it settled on.
    // Written from Node rather than `printf`, and hex rather than escapes, so no
    // layer between here and the pane can reinterpret the sequence: the whole
    // point of the probe is that the bytes are exactly the ones the frontend
    // sends. The single quotes keep the shell out of it entirely.
    const request = `node -e 'process.stdout.write(Buffer.from("${Buffer.from('\u001b[>4;1m', 'latin1').toString('hex')}", "hex")); setTimeout(() => {}, 5000)'`
    const started = spawnSync('tmux', ['-L', name, '-f', config, 'new-session', '-d', '-s', 'probe', '-x', '80', '-y', '24',
      request], { timeout: 10000 })
    if (started.status !== 0) return { supported: false, reason: 'could not start an isolated tmux server' }
    // Polled rather than asked once: the pane program has to start and tmux has to
    // read what it wrote, and asking before either has happened reports a tmux
    // that works as one that does not. A supporting tmux reaches `Ext 1` in
    // milliseconds; a window of a few seconds is generous, and nothing here is
    // waiting on anything slower than a process launch.
    let mode = ''
    for (let attempt = 0; attempt < 20; attempt += 1) {
      mode = ask(['display-message', '-p', '-t', 'probe', '#{pane_key_mode}']).trim()
      if (mode !== '' && mode !== 'VT10x') break
      spawnSync('sleep', ['0.1'], { timeout: 5000 })
    }
    return mode === 'Ext 1'
      ? { supported: true }
      : { supported: false, reason: `${version.stdout.trim()} does not let a program request extended keys (that arrived in 3.5; pane_key_mode reported ${JSON.stringify(mode)})` }
  } finally {
    spawnSync('tmux', ['-L', name, 'kill-server'], { timeout: 10000 })
    rmSync(dirname(config), { recursive: true, force: true })
  }
}

const support = measureSupport()
const describeMultiplexer = support.supported ? describe : describe.skip
if (!support.supported) {
  // Said out loud, because a silently skipped suite is indistinguishable from one
  // that quietly stopped running.
  process.stderr.write(`multiplexer.spec: skipped — ${support.reason}\n`)
}

/**
 * What the multiplexer is configured to do.
 *
 * `extended-keys` is the server option that decides whether a program inside a
 * pane may request distinguishable modified keys at all; tmux 3.7c ships it `off`,
 * which is the default every user starts from. The generated configuration sets
 * it explicitly rather than relying on that, because a test that breaks when a
 * future release changes a default is a test about the default, not the contract.
 * `remain-on-exit` keeps a finished pane — and so its server — around long enough
 * to read what it printed, instead of leaving a failure with nothing to inspect.
 */
const TMUX_CONFIG = 'set -g extended-keys on\nset -g status off\nset -g remain-on-exit on\n'

/** The outer configuration: its only job is to host a pane and own a pty. */
const OUTER_CONFIG = 'set -g status off\nset -g default-terminal "tmux-256color"\nset -g remain-on-exit on\n'

/**
 * Chunks a pane program reads before it releases its modes and exits.
 *
 * A program that exits on the first key has already handed its modes back by the
 * time the assertions run, which is correct behaviour and the wrong thing to
 * measure. The budget is therefore set per test: large where the mode must still
 * be held, and one where the program's EXIT is the thing under test.
 */
const RECORDER_MAX_KEYS = 8

/**
 * A recorder that runs inside the pane, modelling the frontend's whole lifecycle.
 *
 * It writes the requested modes, appends every chunk of input as hex, and once it
 * has read {@link RECORDER_MAX_KEYS} chunks it writes the release modes and exits
 * — the same acquire, use, restore order the frontend follows. That last part is
 * what lets two of these share one pane, which is how a leaked mode is caught.
 *
 * It deliberately does NOT decode. What these assertions are about is what the
 * multiplexer put on the wire; decoding happens in the test process with the real
 * decoder, which closes the loop without the fixture having to import one.
 */
const RECORDER = `
import { appendFileSync, writeFileSync } from 'node:fs'
const [, , out, onHex, offHex, maxKeys] = process.argv
const bytes = value => (value === '' ? '' : Buffer.from(value, 'hex').toString('latin1'))
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdout.write(bytes(onHex))
writeFileSync(out + '.ready', 'ready')
let seen = 0
process.stdin.on('data', chunk => {
  appendFileSync(out, Buffer.from(chunk, 'utf8').toString('hex') + '\\n')
  seen += 1
  if (seen >= Number(maxKeys)) {
    process.stdout.write(bytes(offHex))
    writeFileSync(out + '.released', 'released')
    setTimeout(() => process.exit(0), 150)
  }
})
setTimeout(() => process.exit(0), 30000)
`

/** One recorded run: the bytes that reached the pane, and tmux's own answer. */
interface Run {
  /** Hex of each chunk, in the order it was read. */
  chunks: string[]
  /** tmux's `pane_key_mode`: how the multiplexer understood the request. */
  keyMode: string
}

let workspace = ''
let runCounter = 0

/** Run `tmux` against an isolated server, never the default one. */
function tmux(socket: string, args: string[]): string {
  const result = spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', timeout: 20000 })
  return result.status === 0 ? result.stdout : ''
}

/** Kill an isolated server, tolerating one that is already gone. */
function kill(socket: string): void {
  spawnSync('tmux', ['-L', socket, 'kill-server'], { encoding: 'utf8', timeout: 10000 })
}

/** Poll `check` until it holds, rather than sleeping a guessed interval. */
async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => { setTimeout(resolve, 50) })
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`)
}

/** The chunks recorded so far by one pane program. */
function recorded(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
}

/** A shell word: a JSON string literal is one, and it survives any path. */
function quoted(text: string): string {
  return JSON.stringify(text)
}

/** The command for a pane program that asks for `modes` and releases them on exit. */
function recorderCommand(recordPath: string, modes: { on: string; off: string }, maxKeys: number): string {
  const hex = (value: string): string => Buffer.from(value, 'latin1').toString('hex')
  return `node ${quoted(join(workspace, 'recorder.mjs'))} ${quoted(recordPath)} ${hex(modes.on)} ${hex(modes.off)} ${String(maxKeys)}`
}

/**
 * One isolated pair of servers, a pane program in the inner one, and a client
 * attached to it from a pane of the outer one.
 */
class Harness {
  private readonly tag = `${String(runCounter += 1)}`
  private readonly inner = `dsh-mux-in-${String(process.pid)}-${this.tag}`
  private readonly outer = `dsh-mux-out-${String(process.pid)}-${this.tag}`

  /**
   * @param command - what to run in the inner pane; it must write
   *   `<recordPath>.ready` once it has taken the terminal.
   * @param recordPath - where that command appends the hex of what it reads.
   */
  constructor(private readonly command: string, private readonly recordPath: string) {}

  /** Start both servers and wait until the client is genuinely attached. */
  async start(): Promise<void> {
    const innerConf = join(workspace, `inner-${this.tag}.conf`)
    const outerConf = join(workspace, `outer-${this.tag}.conf`)
    writeFileSync(innerConf, TMUX_CONFIG)
    writeFileSync(outerConf, OUTER_CONFIG)
    tmux(this.inner, ['-f', innerConf, 'new-session', '-d', '-s', 'app', '-x', '80', '-y', '24', this.command])
    await waitFor(() => existsSync(`${this.recordPath}.ready`), 20000, 'the pane program to take the terminal')
    tmux(this.outer, ['-f', outerConf, 'new-session', '-d', '-s', 'pty', '-x', '120', '-y', '40',
      `TERM=xterm-256color tmux -L ${this.inner} attach-session -t app`])
    // The client is attached once the outer pane's process IS the client. Waiting
    // on the pane merely existing is what made this flaky: its pty is there before
    // anything reads it, so keys sent in that window go nowhere.
    await waitFor(
      () => tmux(this.outer, ['display-message', '-p', '-t', 'pty', '#{pane_current_command}']).trim() === 'tmux',
      20000,
      'the client to attach',
    )
  }

  /**
   * Write one key's bytes to the client, as an outer terminal would.
   *
   * @param key - the bytes an outer terminal would send.
   * @param path - the pane program's record to wait on, which is not always the
   *   one this harness was constructed with: a second program can take over the
   *   same pane mid-run, and waiting on the first one's file would return at once.
   * @param expectedChunks - how many chunks that program must have read.
   */
  async press(key: string, path: string, expectedChunks: number): Promise<void> {
    const bytes = [...Buffer.from(key, 'latin1')].map(byte => byte.toString(16).padStart(2, '0'))
    tmux(this.outer, ['send-keys', '-t', 'pty', '-H', ...bytes])
    await waitFor(() => recorded(path).length >= expectedChunks, 10000, 'the key to reach the pane')
  }

  /** The chunks the pane program read, and how the multiplexer understood the request. */
  result(): Run {
    return {
      chunks: recorded(this.recordPath),
      keyMode: tmux(this.inner, ['display-message', '-p', '-t', 'app', '#{pane_key_mode}']).trim(),
    }
  }

  /** Stop both servers. Always called, including after a failing assertion. */
  stop(): void {
    kill(this.outer)
    kill(this.inner)
  }
}

/** Decode recorded chunks exactly as the frontend would, in order. */
function keysOf(run: Run): Key[] {
  return run.chunks.flatMap(chunk => decodeKeys(Buffer.from(chunk, 'hex').toString('latin1')))
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dshline-tmux-'))
  writeFileSync(join(workspace, 'recorder.mjs'), RECORDER)
})

afterAll(() => {
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

describeMultiplexer('through a terminal multiplexer', () => {
  it('is told the request was accepted, and modified enter arrives distinguishably', async () => {
    // The regression this file exists for. tmux is a terminal emulator: it answers
    // a key request itself rather than forwarding it, and it does not understand
    // the kitty push — measured on tmux 3.7c, `pane_key_mode` stayed at its
    // default `VT10x` and a modified enter still arrived as a bare carriage
    // return, which this frontend reads as "submit". The frontend's own modes go
    // in verbatim, so this asserts the real bytes and not a copy of them.
    const path = join(workspace, 'accepted.txt')
    const harness = new Harness(recorderCommand(path, terminalModes(), RECORDER_MAX_KEYS), path)
    try {
      await harness.start()
      await harness.press('\u001b[13;2u', path, 1)
      const run = harness.result()
      expect(run.keyMode).toBe('Ext 1')
      expect(keysOf(run)).toEqual([{ kind: 'key', name: 'newline' }])
    } finally {
      harness.stop()
    }
  }, 60000)

  it('proves the old request on its own was not enough', async () => {
    // The negative proof, kept as a test so the fix cannot quietly stop being
    // load-bearing. If a future tmux starts honouring the kitty push this fails,
    // and the right response is to look again rather than to relax the assertion.
    const path = join(workspace, 'old.txt')
    const kittyOnly = { on: '\u001b[?2004h\u001b[>1u', off: '\u001b[<u\u001b[?2004l' }
    const harness = new Harness(recorderCommand(path, kittyOnly, RECORDER_MAX_KEYS), path)
    try {
      await harness.start()
      await harness.press('\u001b[13;2u', path, 1)
      const run = harness.result()
      expect(run.keyMode).toBe('VT10x')
      // It arrives as the one byte a modified enter shares with a plain one, which
      // is exactly how shift-enter came to mean "send".
      expect(keysOf(run)).toEqual([{ kind: 'key', name: 'enter' }])
    } finally {
      harness.stop()
    }
  }, 60000)

  it('leaves every key that already worked alone', async () => {
    // The promise that makes the extra request safe: level 1 changes only what has
    // no legacy encoding, so the shortcuts a multiplexer already delivered must
    // still arrive byte for byte. The expected hex strings are what tmux 3.7c was
    // measured producing, which is what makes this an assertion rather than a
    // restatement of whatever the decoder happens to accept. The pane program
    // takes no modes at all, so these bytes are the multiplexer's own.
    const path = join(workspace, 'unchanged.txt')
    const burst = ['\r', '\u001b[A', '\u001b[H', '\u001b[F', '\u001b[3~', '\t']
    const harness = new Harness(recorderCommand(path, { on: '', off: '' }, burst.length), path)
    try {
      await harness.start()
      for (const [index, key] of burst.entries()) await harness.press(key, path, index + 1)
      const run = harness.result()
      expect(run.keyMode).toBe('VT10x')
      // Everything except the very first byte is asserted exactly, because those
      // are escape sequences and this harness cannot alter them.
      expect(run.chunks.slice(1)).toEqual(['1b5b41', '1b5b317e', '1b5b347e', '1b5b337e', '09'])
      // Enter is deliberately NOT asserted byte for byte. The outer tmux runs its
      // pane in COOKED mode, so the line discipline between the two servers may
      // map the carriage return this test wrote into a line feed before the inner
      // one sees it — which is a property of this fixture, not of tmux or of this
      // frontend, and it varied between runs. What matters is that both bytes are
      // the same key, which is exactly the claim being made: nothing that used to
      // work has moved. (In a real session dshline's own pty is in raw mode, so
      // the byte is the carriage return.)
      expect(['0d', '0a']).toContain(run.chunks[0])
      expect(keysOf(run)).toEqual([
        { kind: 'key', name: 'enter' },
        { kind: 'key', name: 'up' },
        { kind: 'key', name: 'home' },
        { kind: 'key', name: 'end' },
        { kind: 'key', name: 'delete' },
        { kind: 'key', name: 'tab' },
      ])
    } finally {
      harness.stop()
    }
  }, 60000)

  it('leaves a program that asks for nothing with the keys it always had', async () => {
    // A multiplexer keeps per-pane keyboard state, so a mode this frontend pushed
    // and did not take back would survive it and change how the NEXT program
    // reads the keyboard. Two programs run one after another in the SAME pane:
    // the first asks for extended keys and releases them on exit, the second asks
    // for nothing at all.
    const first = join(workspace, 'leak-first.txt')
    const second = join(workspace, 'leak-second.txt')
    const modes = terminalModes()
    const shell = `sh -c ${quoted(`${recorderCommand(first, modes, 1)}; ${recorderCommand(second, { on: '', off: '' }, 1)}`)}`
    const harness = new Harness(shell, first)
    try {
      await harness.start()
      await harness.press('\u001b[13;2u', first, 1)
      expect(keysOf(harness.result())).toEqual([{ kind: 'key', name: 'newline' }])
      // The first program has released its modes and exited; the second has taken
      // over the same terminal with nothing requested of it.
      await waitFor(() => existsSync(`${second}.ready`), 20000, 'the next program to take the terminal')
      await waitFor(() => existsSync(`${first}.released`), 10000, 'the first program to release its modes')
      await harness.press('\u001b[13;2u', second, 1)
      // Read the SECOND program's file: the first one is the record of the mode
      // working, and it is this one that says whether the mode was handed back.
      expect(keysOf({ chunks: recorded(second), keyMode: harness.result().keyMode }))
        .toEqual([{ kind: 'key', name: 'enter' }])
      expect(harness.result().keyMode).toBe('VT10x')
    } finally {
      harness.stop()
    }
  }, 90000)
})
