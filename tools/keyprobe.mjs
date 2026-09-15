/**
 * Print what your terminal sends for each key, and how this project reads it.
 *
 * Terminals disagree about how they report keys. This project asks for an
 * extended keyboard mode on startup, and a terminal that supports it sends
 * different bytes than one that does not — which is why a shortcut can work in
 * one terminal and do nothing in another.
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
stdout.write(`Requested: ${describeModes(MODES.on)}\r\n`)
stdout.write(`     hex: ${Buffer.from(MODES.on, 'utf8').toString('hex')}\r\n\r\n`)
stdout.write('Press any key — try ctrl-c, ctrl-d, shift-enter, esc, the arrows.\r\n')
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
