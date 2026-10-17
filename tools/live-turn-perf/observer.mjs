/** Opt-in, private-profile observation only. No production imports or writes. */
import { writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const root = process.env.DSH_LIVE_ROOT
if (!root || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('live benchmark requires a real PTY and DSH_LIVE_ROOT')
const now = () => Number(process.hrtime.bigint()) / 1e6
const send = record => writeSync(3, JSON.stringify(record) + '\n')
const state = process.__dshLiveState ??= { chunks: [], screens: [], compositions: [], frames: [], events: [], writes: [], totalBytes: 0 }
const hash = process.__dshLiveHash ??= createHash('sha256')
const isActive = () => state.active === true
if (!process.__dshLiveInstalled) {
process.__dshLiveInstalled = true
for (const stream of [process.stdout, process.stderr]) {
  const original = stream.write
  stream.write = function (data, ...args) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, typeof args[0] === 'string' ? args[0] : 'utf8')
    hash.update(bytes)
    state.totalBytes += bytes.length
    if (isActive()) state.writes.push([now(), bytes.length, state.totalBytes])
    return Reflect.apply(original, this, [data, ...args])
  }
}
const raw = process.stdin.setRawMode
process.stdin.setRawMode = function (mode) {
  const result = Reflect.apply(raw, this, [mode])
  if (mode) execFileSync('stty', ['-opost'], { stdio: [0, 'ignore', 'ignore'] })
  return result
}
}
export const name = 'live-turn-observer'
export const inject = ['llm', 'agents']
export async function apply(ctx) {
const load = url => ctx.loader.internal.import(url.href, ctx.baseUrl, {})
const { Screen } = await load(pathToFileURL(`${root}/packages/renderer/lib/screen.js`))
const { TuiSlots } = await load(pathToFileURL(`${root}/packages/dshline/lib/slots.js`))
const { RedrawScheduler } = await load(pathToFileURL(`${root}/packages/dshline/lib/redraw.js`))
for (const method of ['setLive', 'commit']) {
  const original = Screen.prototype[method]
  Screen.prototype[method] = function (...args) {
    const start = now()
    const before = state.totalBytes
    try { return Reflect.apply(original, this, args) }
    finally { if (isActive()) state.screens.push([method, start, now() - start, before, state.totalBytes]) }
  }
}
const compose = TuiSlots.prototype.compose
TuiSlots.prototype.compose = function (...args) {
  const start = now()
  try { return Reflect.apply(compose, this, args) }
  finally { if (isActive()) state.compositions.push([start, now() - start]) }
}
const request = RedrawScheduler.prototype.request
RedrawScheduler.prototype.request = function (...args) {
  if (!this.__liveObserved) {
    this.__liveObserved = true
    const paint = this.paint
    this.paint = function (...paintArgs) {
      const start = now()
      try { return Reflect.apply(paint, this, paintArgs) }
      finally { if (isActive()) state.frames.push([start, now() - start]) }
    }
  }
  return Reflect.apply(request, this, args)
}
  const prepare = ctx.llm.prepareCall
  ctx.llm.prepareCall = async function (...args) {
    const prepared = await Reflect.apply(prepare, this, args)
    return Object.freeze({ ...prepared, stream(options) {
      const upstream = prepared.stream(options)
      const iterator = upstream[Symbol.asyncIterator]()
      state.providerCalls ??= []
      const call = { start: now(), waits: [], provider: options.provider, model: options.model }
      state.providerCalls.push(call)
      return {
        [Symbol.asyncIterator]() { return this },
        async next(...nextArgs) {
          const start = now()
          try {
            const item = await iterator.next(...nextArgs)
            const end = now()
            call.waits.push([start, end, item.done === true, item.value?.type ?? null])
            if (item.done) call.end = end
            return item
          } catch (error) { call.error = String(error); throw error }
        },
        return(...returnArgs) { return iterator.return?.(...returnArgs) ?? Promise.resolve({ done: true }) },
        throw(...throwArgs) { return iterator.throw(...throwArgs) },
      }
    } })
  }
  let finishing = false
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/start') {
      state.active = true
      state.turnStart = now()
      state.cpuStart = process.cpuUsage()
      send({ kind: 'turn-start', t: state.turnStart })
    }
    if (!isActive()) return
    state.events.push([now(), event.type])
    if (event.type === 'request/header') state.header = event.data.header.config
    if (event.type === 'tool/call') state.toolCalls = (state.toolCalls ?? 0) + 1
    if (event.type === 'turn/end') state.turnEnd = now()
    if (event.type === 'assistant/message') {
      state.assistant = { message: event.data.message, usage: event.data.usage }
    }
  })
  ctx.on('agent/assistant-stream', ({ frame }) => {
    if (!isActive()) return
    const t = now()
    if (frame.type === 'start') state.streamStart = t
    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      state.chunks.push([t, chunk.type, chunk.text?.length ?? 0])
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') state.firstContent ??= t
    }
    if (frame.type === 'end') state.streamEnd = t
  })
  ctx.on('agent/status', ({ status }) => {
    if (!isActive() || status === 'running' || !state.turnEnd || finishing) return
    finishing = true
    // Two check phases let the real scheduler consume all settlement invalidations.
    setImmediate(() => setImmediate(() => {
      process.stdout.write('', () => {
        state.flush = now()
        state.cpu = process.cpuUsage(state.cpuStart)
        state.active = false
        send({ kind: 'result', ...state, outputHash: hash.copy().digest('hex') })
      })
    }))
  })
  send({ kind: 'observer-ready', t: now(), tty: { input: process.stdin.isTTY, output: process.stdout.isTTY, columns: process.stdout.columns, rows: process.stdout.rows } })
}
