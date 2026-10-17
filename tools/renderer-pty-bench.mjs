/** PTY + production StreamBuffer/Screen + emulator-drained whole-turn timing. */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { deepStrictEqual, ok } from 'node:assert'
import headless from '@xterm/headless'
import { rendererIdentity } from './renderer-identity.mjs'
import { rendererNativeInputsDigest } from './renderer-native-inputs.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const options = {}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--smoke') options.smoke = true
  else if (process.argv[i] === '--output' && process.argv[i + 1]) options.output = process.argv[++i]
  else throw Error('usage: renderer-pty-bench.mjs [--smoke] [--output metrics.json]')
}
if (!['linux', 'darwin'].includes(process.platform)) throw Error('script(1) PTY benchmark requires Linux or macOS')
const identity = rendererIdentity(), inputDigest = await rendererNativeInputsDigest()
const platform = `${process.platform}-${process.arch}`
const binary = new URL(`../packages/renderer/native/${platform}.node`, import.meta.url)
const binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex')
const proof = JSON.parse(readFileSync(new URL(`../packages/renderer/native/${platform}.provenance.json`, import.meta.url)))
deepStrictEqual(proof.inputDigest, inputDigest, 'stale addon')
deepStrictEqual(proof.binarySha256, binarySha256, 'wrong addon bytes')
ok(process.versions.unicode === '17.0', 'A Unicode-compatible runtime is required to time admitted native work')
const shellWord = word => "'" + word.replaceAll("'", "'\\''") + "'"
const sessions = []
async function open(backend) {
  // Reuse the repository consumer-smoke script(1) approach; no node-pty or
  // custom terminal implementation/dependency is needed.
  const argv = ['bash', '-c', 'stty cols 80 rows 24 && exec "$@"', 'bash', process.execPath, fileURLToPath(new URL('./renderer-pty-worker.mjs', import.meta.url)), backend]
  const inner = argv.map(shellWord).join(' ')
  const command = process.platform === 'linux' ? `exec script -qec ${shellWord(inner)} /dev/null` : `exec script -q /dev/null ${inner} < <(cat)`
  const child = spawn('bash', ['-c', command], { cwd: root, env: { ...process.env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const terminal = new headless.Terminal({ cols: 80, rows: 24, scrollback: 50000, allowProposedApi: true })
  const decoder = new StringDecoder('utf8'), prefix = '\x1b]777;DSHBENCH:'
  let buffer = '', queue = Promise.resolve(), pending, active, stderr = '', ready, rejectReady
  const readyPromise = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject })
  function fail(error) { rejectReady(error); pending?.reject(error) }
  child.stderr.on('data', bytes => { stderr += bytes })
  child.on('error', fail)
  const exited = new Promise(resolve => child.on('exit', code => { if (code !== 0 || pending) fail(Error(`PTY exit ${code}: ${stderr}`)); resolve(code) }))
  const write = text => {
    if (!text) return
    if (active) {
      active.bytes += Buffer.byteLength(text)
      active.hash.update(text)
      active.chunks.push(text)
      active.firstByteMs ??= performance.now() - active.start
    }
    queue = queue.then(() => new Promise(resolve => terminal.write(text, resolve)))
  }
  function packet(value) {
    const receivedMs = performance.now()
    queue = queue.then(async () => {
      if (value.type === 'ready') { ready(value); return }
      if (value.type !== 'done' || !active || value.id !== active.id) throw Error('Out-of-order PTY completion')
      const visibleMs = performance.now() - active.start
      const state = terminal.buffer.active
      const snapshot = { cursor: [state.cursorX, state.cursorY], lines: Array.from({ length: state.length }, (_, i) => state.getLine(i).translateToString(true)) }
      const snapshotSha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
      const result = { ...value, firstByteMs: active.firstByteMs, ptyDrainedMs: receivedMs - active.start, visibleMs, outputBytes: active.bytes, outputSha256: active.hash.digest('hex'), snapshotSha256, cursor: snapshot.cursor, throughputUnitsPerSecond: value.inputUnits / (visibleMs / 1000) }
      Object.defineProperty(result, 'transcript', { value: active.chunks.join('') })
      const resolve = pending.resolve
      active = undefined; pending = undefined
      resolve(result)
    }).catch(fail)
  }
  child.stdout.on('data', bytes => {
    buffer += decoder.write(bytes)
    while (buffer) {
      const start = buffer.indexOf(prefix)
      if (start < 0) {
        // Keep only a possible partial marker, not an arbitrary last chunk.
        let keep = Math.min(prefix.length - 1, buffer.length)
        while (keep && !prefix.startsWith(buffer.slice(-keep))) keep--
        write(buffer.slice(0, buffer.length - keep)); buffer = buffer.slice(buffer.length - keep); break
      }
      write(buffer.slice(0, start)); buffer = buffer.slice(start)
      const end = buffer.indexOf('\x07', prefix.length)
      if (end < 0) break
      packet(JSON.parse(Buffer.from(buffer.slice(prefix.length, end), 'base64').toString('utf8')))
      buffer = buffer.slice(end + 1)
    }
  })
  const watchdog = setTimeout(() => { fail(Error('PTY session timed out')); child.kill('SIGTERM') }, 120000)
  sessions.push({ child, terminal, watchdog, exited })
  const readyInfo = await readyPromise
  ok(readyInfo.tty && readyInfo.unicode === readyInfo.compiledUnicode, 'worker must use a compatible real PTY')
  deepStrictEqual(readyInfo.outputProcessing, 'disabled')
  return {
    ready: readyInfo,
    turn(kind, id) {
      ok(!pending, 'Only one whole turn may run at a time')
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
        active = { id, start: performance.now(), hash: createHash('sha256'), bytes: 0, chunks: [] }
        child.stdin.write(JSON.stringify({ command: 'turn', kind, id, lines: options.smoke ? 2 : 32 }) + '\n')
      })
    },
  }
}
try {
  const variants = { typescript: await open('typescript'), admittedRust: await open('auto') }
  const rows = []
  const passes = options.smoke ? 1 : 5
  for (let pass = -1; pass < passes; pass++) for (const kind of ['ascii', 'cjk']) {
    const sample = { kind, pass, timings: {} }, names = pass % 2 === 0 ? ['admittedRust', 'typescript'] : ['typescript', 'admittedRust']
    for (const name of names) sample.timings[name] = await variants[name].turn(kind, `${pass}/${kind}`)
    const { typescript: ts, admittedRust: native } = sample.timings
    for (const key of ['inputUnits', 'inputBytes', 'inputSha256', 'deltas', 'renderedBytes', 'renderedSha256', 'outputBytes', 'outputSha256', 'snapshotSha256', 'cursor']) {
      try {
        if (key === 'outputBytes' || key === 'outputSha256') for (const value of [ts, native]) deepStrictEqual(value[key], value[key === 'outputBytes' ? 'renderedBytes' : 'renderedSha256'], 'PTY must preserve producing-write identity')
        deepStrictEqual(native[key], ts[key], `${kind}/${key}`)
      }
      catch (error) {
        const expected = Buffer.from(ts.transcript), actual = Buffer.from(native.transcript)
        let first = 0
        while (first < Math.min(expected.length, actual.length) && expected[first] === actual[first]) first++
        const context = { key, firstByteDifference: first, typescript: ts, admittedRust: native, expectedContextHex: expected.subarray(Math.max(0, first - 80), first + 160).toString('hex'), actualContextHex: actual.subarray(Math.max(0, first - 80), first + 160).toString('hex') }
        const prefix = options.output ?? 'renderer-pty.json'
        writeFileSync(prefix + '.failure.json', JSON.stringify(context, null, 2) + '\n')
        writeFileSync(prefix + '.typescript.ansi', expected)
        writeFileSync(prefix + '.admittedRust.ansi', actual)
        console.error(JSON.stringify(context))
        throw error
      }
    }
    deepStrictEqual(ts.calls, {}, 'TS must never call native')
    ok(Object.values(native.calls).some(count => count > 0), 'admitted Rust turn must reach native')
    ok(!native.calls.execute, 'whole-turn experiment must not use native composite/markdown ownership')
    if (pass >= 0) rows.push(sample)
    console.error(`PTY ${kind}: ${pass < 0 ? 'warmup' : `pass ${pass + 1}/${passes}`}`)
  }
  deepStrictEqual(rendererIdentity(), identity)
  deepStrictEqual(await rendererNativeInputsDigest(), inputDigest)
  deepStrictEqual(createHash('sha256').update(readFileSync(binary)).digest('hex'), binarySha256)
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const summary = ['ascii', 'cjk'].map(kind => ({ kind, ...Object.fromEntries(['typescript', 'admittedRust'].map(name => {
    const samples = rows.filter(row => row.kind === kind).map(row => row.timings[name])
    return [name, Object.fromEntries(['visibleMs', 'ptyDrainedMs', 'firstByteMs', 'renderMs', 'throughputUnitsPerSecond'].map(key => [key, median(samples.map(s => s[key]))]))]
  })) }))
  const result = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), node: process.version, unicode: process.versions.unicode, platform, identity, proof, toolSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).update(readFileSync(new URL('./renderer-pty-worker.mjs', import.meta.url))).digest('hex'), procedure: 'Two persistent real 80x24 PTY sessions; production dshline StreamBuffer + renderer Screen/frame; 128-unit deltas, assembled-message reconciliation and scrollback; one warmup then five alternating paired whole turns. Completion includes PTY transport and xterm emulator drain. No provider/network/model delay; not model response time or physical display paint. Rust is opt-in auto admitted leaves only, not forced composites. Raw bytes, full emulator scrollback/cursor, input and call counts checked each pair.', ready: Object.fromEntries(Object.entries(variants).map(([name, variant]) => [name, variant.ready])), summary, rows }
  const output = JSON.stringify(result, null, 2) + '\n'
  if (options.output) writeFileSync(options.output, output)
  else process.stdout.write(output)
} finally {
  for (const session of sessions) { clearTimeout(session.watchdog); session.child.stdin.end('{"command":"quit"}\n') }
  for (const session of sessions) { deepStrictEqual(await session.exited, 0, 'PTY session must exit cleanly'); session.terminal.dispose() }
}
