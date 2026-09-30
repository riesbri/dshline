/**
 * Print what your terminal sends for each key, and how this project reads it.
 *
 * Terminals disagree about how they report keys, and so do the things that sit
 * between a terminal and this program. A terminal multiplexer is a terminal
 * emulator: it answers key requests on its own terms, and which ones it honours
 * depends on how it is configured. This tool therefore reports the CHAIN, not
 * just the bytes — outer terminal, multiplexer, and what arrived — so a report
 * from someone running under SSH and tmux carries enough to diagnose it.
 *
 * Run this and press the key that misbehaves. Each line shows the raw bytes and
 * the key this project decodes them into. An empty `[]` means the key was not
 * recognised, which is a bug worth reporting. Press `q` to quit.
 *
 *   pnpm build && node tools/keyprobe.mjs
 *
 * Include the output in a bug report:
 *   https://github.com/riesbri/dshline/issues
 */

import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { createKeyDecoder } from '../packages/renderer/lib/keys.js'
import { isInteractive, terminalModes } from '../packages/renderer/lib/terminal.js'

const { stdin, stdout } = process

// Both streams must be the terminal, which is the same check the frontend makes
// before it takes over. Output matters as much as input here: the sequences below
// are what ASK the terminal for the extended mode, so if output is redirected to a
// file the terminal never enables it — and this tool would then report the legacy
// encodings as though they were all your terminal can send. That is worse than no
// tool at all, because the report would be wrong rather than missing.
if (!isInteractive({ input: stdin, output: stdout })) {
  process.stderr.write('keyprobe needs the terminal on both stdin and stdout; do not redirect its output\n')
  process.exit(1)
}

/**
 * The modes the frontend turns on, asked for through the same function it uses.
 *
 * Imported rather than copied: a probe that asks for a different set of modes
 * reports encodings the interface never receives, and would answer a bug report
 * about shift-enter with the wrong terminal mode.
 */
const MODES = terminalModes()

/**
 * Render one mode sequence readably, so a report can name what was requested.
 * @param sequence - the bytes written to ask for the modes.
 * @returns the sequence with control bytes spelled out.
 */
function describeModes(sequence) {
  return [...sequence].map(character => {
    const code = character.codePointAt(0) ?? 0
    return code === 0x1b ? 'ESC' : character
  }).join('')
}

/**
 * Idle time after which the decoder decides what it is holding, matching the
 * frontend's own delay. A lone ESC is the first byte of every sequence the decoder
 * recognises, so it can only be read as the Escape key once the terminal goes quiet.
 */
const IDLE_FLUSH_MS = 30

/**
 * Render raw bytes readably: control characters as hex, escape as `ESC`.
 * @param bytes - one chunk as received from the terminal.
 * @returns a space-separated, printable form.
 */
function readable(bytes) {
  return [...bytes].map(character => {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x1b) return 'ESC'
    if (code < 0x20 || code === 0x7f) return `0x${code.toString(16).padStart(2, '0')}`
    return character
  }).join(' ')
}

/**
 * Ask tmux what it is, when there is one to ask.
 *
 * Diagnostics only, and deliberately unable to break the probe: a missing tmux, a
 * socket that is gone, a server that hangs — every one of those answers `null` and
 * the report carries on. Nothing is spawned when `$TMUX` is absent, so a plain
 * terminal never pays for this and never appears to depend on tmux.
 *
 * Only a fixed list of options is read, and none of them is a path, a socket name
 * or a host: a pasted bug report should not carry the remote's SSH endpoints or
 * the names of the user's other sessions. `pane_key_mode` is the one that earns
 * its place — it is the multiplexer saying whether it accepted this program's
 * request for distinguishable modified keys, which is exactly the question a
 * shift-enter report turns on.
 * @returns the multiplexer facts, or null when tmux is absent or unanswerable.
 */
function askTmux() {
  if (process.env.TMUX === undefined) return null
  const ask = args => {
    try {
      const result = spawnSync('tmux', args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      if (result.error !== undefined || result.status !== 0) return null
      const value = result.stdout.trim()
      return value === '' ? null : value
    } catch {
      return null
    }
  }
  return {
    version: ask(['-V']),
    extendedKeys: ask(['show-options', '-gv', 'extended-keys']),
    extendedKeysFormat: ask(['show-options', '-gv', 'extended-keys-format']),
    paneKeyMode: ask(['display-message', '-p', '#{pane_key_mode}']),
    historyLimit: ask(['display-message', '-p', '#{history_limit}']),
  }
}

/**
 * Whether an environment variable is set, without printing what it says.
 *
 * `$SSH_CONNECTION` and `$SSH_TTY` hold a hostname, a port, and a client address.
 * None of that helps diagnose a keyboard encoding and all of it belongs in nobody's
 * bug report, so only the fact of their presence is reported.
 * @param name - the variable to look for.
 * @returns 'present' or 'absent'.
 */
function presence(name) {
  return process.env[name] === undefined ? 'absent' : 'present'
}

/** Write one `label: value` report line, right-padded so labels line up. */
function field(label, value) {
  stdout.write(`  ${`${label}:`.padEnd(20)} ${value}\r\n`)
}

const tmuxFacts = askTmux()

// The environment block is printed BEFORE the modes are requested, so a reader can
// see what was true at the moment the request went out rather than after.
stdout.write('\r\ndshline keyprobe — the chain between your keys and this program\r\n\r\n')
field('platform', `${process.platform} ${process.arch}`)
field('node', process.version)
field('TERM', process.env.TERM ?? '(unset)')
field('TERM_PROGRAM', process.env.TERM_PROGRAM ?? '(unset)')
field('COLORTERM', process.env.COLORTERM ?? '(unset)')
field('TMUX', process.env.TMUX === undefined ? 'absent' : 'present')
field('SSH_TTY', presence('SSH_TTY'))
field('SSH_CONNECTION', presence('SSH_CONNECTION'))
if (tmuxFacts === null) {
  field('tmux', process.env.TMUX === undefined ? 'not in use' : 'present but unanswerable')
} else {
  field('tmux', tmuxFacts.version ?? 'present but unanswerable')
  field('tmux extended-keys', tmuxFacts.extendedKeys ?? '(unknown)')
  field('tmux keys format', tmuxFacts.extendedKeysFormat ?? '(unknown)')
  field('tmux pane_key_mode', tmuxFacts.paneKeyMode ?? '(unknown)')
  field('tmux history-limit', tmuxFacts.historyLimit ?? '(unknown)')
}
stdout.write('\r\n')

// One decoder for the whole session, not one per chunk. A terminal can split a
// sequence across two reads, and a decoder created per chunk cannot join the halves
// — it would report a key your terminal sent correctly as unrecognised, or as stray
// text. The frontend keeps one decoder for exactly this reason, and a diagnostic
// that decodes differently from the real thing is a diagnostic that lies.
const decoder = createKeyDecoder()

let idle
let quitting = false

/**
 * Print one batch of decoded keys, and quit if `q` was among them.
 * @param bytes - the raw chunk these keys came from, for the left column.
 * @param keys - the keys the decoder resolved.
 */
function report(bytes, keys) {
  if (keys.length === 0 && bytes === '') return
  stdout.write(`bytes: ${readable(bytes).padEnd(30)} decoded: ${JSON.stringify(keys)}\r\n`)
  if (!keys.some(key => key.kind === 'text' && key.text === 'q')) return
  quitting = true
  if (idle !== undefined) clearTimeout(idle)
  stdout.write(MODES.off)
  stdin.setRawMode(false)
  process.exit(0)
}

stdin.setRawMode(true)
stdin.setEncoding('utf8')
stdout.write(MODES.on)
// Naming the request matters as much as the answer: shift-enter is only
// distinguishable on a terminal that acted on one of these sequences, and which
// ones were asked for differs by platform.
stdout.write(`\r\nrequested from the terminal: ${describeModes(MODES.on)}\r\n`)
stdout.write(`                 hex: ${Buffer.from(MODES.on, 'utf8').toString('hex')}\r\n`)
if (tmuxFacts !== null) {
  // Asked again now that the request above has gone out. `pane_key_mode` is the
  // multiplexer answering whether it accepted it, and it is the single most useful
  // line in this report: a multiplexer that ignored the request sends the legacy
  // bytes for a modified key no matter what the terminal can do, and no byte shown
  // further down will say so. `VT10x` means nothing was requested of it.
  const asked = askTmux()?.paneKeyMode
  stdout.write(`       tmux accepted it as: ${asked ?? '(unanswerable)'}\r\n`)
}
stdout.write('\r\n')
stdout.write('Press any key — try ctrl-c, ctrl-d, shift-enter, alt-enter, esc, the arrows.\r\n')
stdout.write('Press q to quit.\r\n\r\n')

stdin.on('data', chunk => {
  if (quitting) return
  if (idle !== undefined) clearTimeout(idle)
  report(chunk, decoder.push(chunk))
  // Whatever the decoder still holds is undecided only while more bytes might
  // arrive. Once the terminal goes quiet, a held ESC was the Escape key.
  idle = setTimeout(() => {
    idle = undefined
    report('', decoder.flush())
  }, IDLE_FLUSH_MS)
})
