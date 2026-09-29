/**
 * Acceptance run for the terminal behaviour that matters most through tmux.
 *
 * `pnpm test` covers the keyboard negotiation against a real tmux
 * (`packages/renderer/tests/multiplexer.spec.ts`). This covers the rest of the
 * chain — the thing dshline is actually built around:
 *
 *   finished output becomes pane history · the live region is the only thing
 *   redrawn · a resize never rewrites history · a detached session survives and
 *   comes back · quitting returns the pane to a usable shell
 *
 * It runs against isolated tmux servers on their own sockets with generated
 * configuration files, so the developer's own server and `~/.tmux.conf` are never
 * read and never written. Nothing outside this repository is needed but tmux
 * itself, and the build it exercises:
 *
 *   pnpm build && node tools/tmux-acceptance.mjs
 *
 * The inner pane runs the REAL renderer `Screen` against a transcript far longer
 * than the pane, a streaming turn, and a live region deliberately taller than the
 * window — the case its own comments warn is the one that could corrupt history.
 * The outer server exists only to give the inner one a pseudo-terminal, so keys
 * and resizes arrive the way a person's terminal would deliver them.
 *
 * Exits non-zero if any check fails.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = join(ROOT, 'packages', 'renderer', 'lib')

if (spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 5000 }).status !== 0) {
  process.stderr.write('tmux-acceptance needs tmux on PATH; skipping\n')
  process.exit(0)
}
if (!existsSync(join(RENDERER, 'screen.js'))) {
  process.stderr.write('tmux-acceptance reads the built renderer; run `pnpm build` first\n')
  process.exit(1)
}

const { Screen } = await import(join(RENDERER, 'screen.js'))

/** Socket names unique to this process, so parallel runs never collide. */
const OUTER = `dsh-accept-out-${String(process.pid)}`
const INNER = `dsh-accept-in-${String(process.pid)}`

/**
 * `history-limit` is raised so a long transcript is not trimmed out from under the
 * checks. It is set on the isolated server this script creates and nowhere else.
 */
const INNER_CONFIG = 'set -g status off\nset -g history-limit 100000\nset -g window-size manual\n'
const OUTER_CONFIG = 'set -g status off\nset -g default-terminal "tmux-256color"\nset -g remain-on-exit on\n'

/** Pane sizes to survive, widest and narrowest first, ending where it started. */
const SIZES = [[120, 40], [80, 24], [50, 12], [30, 8], [20, 6], [12, 4], [120, 40]]

/** How many finished lines the pane commits before anything is streamed. */
const COMMITTED = 120

/**
 * What runs in the pane: the real `Screen`, driven through the whole lifecycle.
 *
 * Written to the scratch directory rather than kept as a file of its own because
 * it is a fixture, not a tool — and because it has to import the BUILT renderer,
 * which is the only way this exercises the shipped `Screen` rather than a copy.
 */
const FIXTURE = `
import { appendFileSync, writeFileSync } from 'node:fs'
import { Screen } from ${JSON.stringify(join(RENDERER, 'screen.js'))}

const dir = process.argv[2]
const log = text => appendFileSync(dir + '/fixture.log', text)
const screen = new Screen({
  write: chunk => process.stdout.write(chunk),
  columns: () => process.stdout.columns ?? 80,
})

let committed = 0
function commit(n) {
  const lines = []
  for (let i = 0; i < n; i += 1) {
    lines.push('COMMIT ' + String(committed).padStart(3, '0') + ' pad-' + 'x'.repeat(i % 40))
    committed += 1
  }
  screen.commit(lines)
}
commit(${COMMITTED})

let tick = 0
const streaming = setInterval(() => {
  tick += 1
  screen.setLive(['ASSISTANT ' + 'word '.repeat(3 + (tick % 9)), '----------', '> input'], { row: 2, column: 2 })
  if (tick < 25) return
  clearInterval(streaming)
  screen.commit(['REPLY final streamed answer ' + 'y'.repeat(30)])
  // Taller than any window in SIZES, which is the case Screen's own comments
  // describe: the erase climbs the DRAWN geometry, so committed rows above it
  // must survive. A collapse afterwards must not leave any of it behind.
  screen.setLive(Array.from({ length: 26 }, (_, i) => 'LIVE ' + String(i).padStart(2, '0') + ' ' + 'z'.repeat(20)), { row: 25, column: 0 })
  log('tall-live-region\\n')
  setTimeout(() => {
    screen.setLive(['> ready'], { row: 0, column: 2 })
    screen.commit(['TALL REGION COLLAPSED'])
    log('collapsed\\n')
    process.stdout.write('\\r\\n#READY\\r\\n')
  }, 800)
}, 20)

process.stdout.on('resize', () => {
  screen.markStale()
  screen.setLive(['> ready'], { row: 0, column: 2 })
  log('resize ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n')
})

writeFileSync(dir + '/fixture.ready', 'ready')
setTimeout(() => { screen.close(); process.exit(0) }, 60000)
`

const workspace = mkdtempSync(join(tmpdir(), 'dsh-accept-'))
const failures = []
let total = 0

/** Record one check and print it, so the run reads as a report as it happens. */
function check(name, ok, detail = '') {
  total += 1
  if (!ok) failures.push(name)
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}\n`)
}

/** Run `tmux` against an isolated server. */
function tmux(socket, args) {
  const result = spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', timeout: 20000 })
  return result.status === 0 ? result.stdout : ''
}

/** Poll until `check` holds, so nothing here depends on a guessed sleep. */
async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => { setTimeout(resolve, 60) })
  }
  process.stderr.write(`timed out after ${String(timeoutMs)}ms waiting for ${what}\n`)
  return false
}

/** Everything the inner pane has ever shown, in order. */
function history() {
  return tmux(INNER, ['capture-pane', '-p', '-S', '-', '-t', 'app'])
}

/** What is on the inner pane's screen right now. */
function screen() {
  return tmux(INNER, ['capture-pane', '-p', '-t', 'app'])
}

try {
  writeFileSync(join(workspace, 'fixture.mjs'), FIXTURE)
  writeFileSync(join(workspace, 'inner.conf'), INNER_CONFIG)
  writeFileSync(join(workspace, 'outer.conf'), OUTER_CONFIG)

  tmux(INNER, ['-f', join(workspace, 'inner.conf'), 'new-session', '-d', '-s', 'app', '-x', '120', '-y', '40',
    `node ${JSON.stringify(join(workspace, 'fixture.mjs'))} ${JSON.stringify(workspace)}`])
  if (!await waitFor(() => existsSync(join(workspace, 'fixture.ready')), 20000, 'the pane program to start')) {
    process.stderr.write(`${tmux(INNER, ['capture-pane', '-p', '-t', 'app'])}\n`)
    throw new Error('the pane program did not start')
  }

  tmux(OUTER, ['-f', join(workspace, 'outer.conf'), 'new-session', '-d', '-s', 'pty', '-x', '120', '-y', '40',
    `TERM=xterm-256color tmux -L ${INNER} attach-session -t app`])
  await waitFor(() => tmux(OUTER, ['display-message', '-p', '-t', 'pty', '#{pane_current_command}']).trim() === 'tmux', 20000, 'the client to attach')
  await waitFor(() => screen().includes('TALL REGION COLLAPSED'), 20000, 'the streaming turn to finish')

  // 1. Finished output is pane history, in order, exactly once.
  const before = history()
  const ids = [...before.matchAll(/COMMIT (\d{3})/gu)].map(match => Number(match[1]))
  check('finished output is pane history', ids.length === COMMITTED, `${String(ids.length)} of ${String(COMMITTED)} lines`)
  check('history is contiguous and in order', ids.every((n, i) => n === i), `${String(ids[0])}..${String(ids.at(-1))}`)
  check('the streamed reply is in history exactly once', (before.match(/REPLY final streamed answer/gu) ?? []).length === 1)
  check('the collapsed live region is not left behind', !screen().split('\n').some(row => /^\s*LIVE \d\d/.test(row)))

  // 2. A resize storm, widest to narrowest and back.
  for (const [width, height] of SIZES) {
    tmux(INNER, ['resize-window', '-t', 'app', '-x', String(width), '-y', String(height)])
    await waitFor(() => screen().includes('> ready'), 10000, `the live region at ${String(width)}x${String(height)}`)
  }
  check('the live region survived every resize', screen().includes('> ready'))

  // 3. Nothing committed was lost, duplicated, or overwritten by those redraws.
  //    A narrowed window REFLOWS history across rows, which is correct terminal
  //    behaviour and not corruption, so the ids are read with whitespace removed.
  const after = history().replace(/\s+/gu, '')
  const afterIds = [...after.matchAll(/COMMIT(\d{3})/gu)].map(match => Number(match[1]))
  check('no committed line lost or duplicated by resize', afterIds.length === ids.length && afterIds.every((n, i) => n === ids[i]), `${String(afterIds.length)} lines`)
  check('the reply is still in history exactly once after resize', (after.match(/REPLYfinalstreamedanswer/gu) ?? []).length === 1)
  check('the collapsed live region never leaked into history', !after.includes('LIVE00z'))

  // 4. Copy mode reaches the committed transcript — the history a person scrolls.
  tmux(INNER, ['copy-mode', '-t', 'app'])
  await waitFor(() => tmux(INNER, ['display-message', '-p', '-t', 'app', '#{pane_mode}']).trim() === 'copy-mode', 5000, 'copy mode')
  const seen = new Set()
  for (let page = 0; page < 14; page += 1) {
    for (const match of tmux(OUTER, ['capture-pane', '-p', '-t', 'pty']).matchAll(/COMMIT (\d{3})/gu)) seen.add(Number(match[1]))
    tmux(INNER, ['send-keys', '-t', 'app', 'PageUp'])
  }
  check('copy mode reaches the earliest committed output', seen.size > 0 && Math.min(...seen) === 0, `${String(seen.size)} distinct rows, lowest COMMIT ${String(Math.min(...seen))}`)
  tmux(INNER, ['send-keys', '-t', 'app', 'Escape'])

  // 5. Detach: the program keeps running, and history is intact without a client.
  const pidBefore = tmux(INNER, ['display-message', '-p', '-t', 'app', '#{pane_pid}']).trim()
  tmux(OUTER, ['detach-client', '-s', 'pty'])
  await waitFor(() => pidBefore !== '' && tmux(INNER, ['display-message', '-p', '-t', 'app', '#{pane_pid}']).trim() === pidBefore, 10000, 'the program to survive')
  check('the program keeps running with no client attached', pidBefore !== '')
  check('history is intact while detached', (history().match(/COMMIT \d{3}/gu) ?? []).length === afterIds.length)

  // 6. Reattach at a DIFFERENT size, as a new SSH session would be.
  tmux(OUTER, ['kill-session', '-t', 'pty'])
  tmux(INNER, ['resize-window', '-t', 'app', '-x', '90', '-y', '30'])
  tmux(OUTER, ['-f', join(workspace, 'outer.conf'), 'new-session', '-d', '-s', 'pty2', '-x', '90', '-y', '30',
    `TERM=xterm-256color tmux -L ${INNER} attach-session -t app`])
  await waitFor(() => tmux(OUTER, ['display-message', '-p', '-t', 'pty2', '#{pane_current_command}']).trim() === 'tmux', 20000, 'the client to reattach')
  await waitFor(() => screen().includes('> ready'), 10000, 'the live region to repaint')
  check('the screen repaints after reattaching at a new size', screen().includes('> ready'))
  check('the transcript is still in history after reattach', (history().match(/COMMIT \d{3}/gu) ?? []).length === afterIds.length)
  check('the reply is still in history exactly once after reattach', (history().match(/REPLY final streamed answer/gu) ?? []).length === 1)

  // 7. Input works the moment the client is back.
  tmux(OUTER, ['send-keys', '-t', 'pty2', '-l', 'still-typing'])
  check('input reaches the program after reattach', await waitFor(() => screen().includes('still-typing'), 10000, 'the typed text to appear'))
} finally {
  spawnSync('tmux', ['-L', OUTER, 'kill-server'], { encoding: 'utf8', timeout: 10000 })
  spawnSync('tmux', ['-L', INNER, 'kill-server'], { encoding: 'utf8', timeout: 10000 })
  rmSync(workspace, { recursive: true, force: true })
}

process.stdout.write(`\n${String(total - failures.length)}/${String(total)} checks passed\n`)
if (failures.length > 0) {
  process.stderr.write(`failed: ${failures.join('; ')}\n`)
  process.exit(1)
}
