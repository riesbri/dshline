#!/usr/bin/env node
/** Production streaming/render path replay. Build first; see renderer-perf/README.md. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import headless from '@xterm/headless'
import { Context } from '@deepseek-ai/cordis'
import { Screen as ShippingScreen, Composer, setPalette } from '../packages/renderer/lib/index.js'
import { StreamBuffer } from '../packages/dshline/lib/stream.js'
import { TuiSlots } from '../packages/dshline/lib/slots.js'
import { RedrawScheduler } from '../packages/dshline/lib/redraw.js'
import { createComposerView, createStatusView } from '../packages/dshline/lib/views.js'
import { DEFAULT_PALETTE } from '../packages/dshline/lib/theme.js'

const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')))
if (options['baseline-ref']) {
  const source = execFileSync('git', ['show', `${options['baseline-ref']}:packages/renderer/src/screen.ts`], { encoding: 'utf8' })
  const compiled = stripTypeScriptTypes(source, { mode: 'transform' })
  mkdirSync('private/renderer-perf', { recursive: true })
  options.screen = 'private/renderer-perf/baseline-screen.mjs'
  writeFileSync(options.screen, compiled.replace('./width.ts', '../../packages/renderer/lib/width.js'))
}
const Screen = options.screen ? (await import(pathToFileURL(options.screen))).Screen : ShippingScreen
setPalette(DEFAULT_PALETTE, 4)
const repetitions = Number(options.repetitions ?? 7)
const cadence = Number(options.cadence ?? 0)
const columns = Number(options.columns ?? 90)
const lines = Number(options.lines ?? 320)
assert.ok(Number.isInteger(repetitions) && repetitions > 0)
assert.ok(Number.isFinite(cadence) && cadence >= 0)
assert.ok(Number.isInteger(columns) && columns > 0)
assert.ok(Number.isInteger(lines) && lines > 0)
const kinds = options.kind ? [options.kind] : ['latin', 'cjk', 'styled', 'long']
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? 0
const digest = text => createHash('sha256').update(text).digest('hex')

function fixture(kind) {
  const line = {
    latin: 'A streamed response keeps native scrollback and the composer responsive. ',
    cjk: '标准模式下终端渲染性能需要保持中文宽度与换行策略一致。',
    styled: 'Read **important text** and `inline code` before the next *styled* phrase. ',
    long: 'https://example.invalid/' + 'abcdefghij'.repeat(30),
  }[kind]
  assert.ok(line, `unknown workload: ${kind}`)
  return kind === 'long' ? line.repeat(Math.ceil(lines * 220 / 320)) : Array.from({ length: lines }, () => line.repeat(3)).join('\n')
}

async function turn(kind) {
  const text = fixture(kind)
  const chunks = text.match(/.{1,37}|\n/gs) ?? []
  const ctx = new Context()
  const slots = new TuiSlots(ctx)
  const stream = new StreamBuffer()
  const emulator = new headless.Terminal({ cols: columns, rows: 24, scrollback: 20000, allowProposedApi: true })
  let bytes = 0, writes = 0, frames = 0, pushMs = 0, composeMs = 0, screenMs = 0, writeMs = 0
  let pendingAt = undefined
  const latency = [], delivered = [], frameMs = []
  let lastDelivery = 0
  const screen = new Screen({
    columns: () => columns,
    write(chunk) {
      const start = performance.now()
      bytes += Buffer.byteLength(chunk)
      writes += 1
      const requestedAt = pendingAt
      emulator.write(chunk, () => {
        lastDelivery = performance.now()
        if (requestedAt !== undefined) delivered.push(lastDelivery - requestedAt)
      })
      writeMs += performance.now() - start
    },
  })
  slots.register('stream', { render: (width, rows) => stream.live(width, rows) })
  slots.register('composer', createComposerView(new Composer(), 'fixture', () => 1, () => ({ busy: true, busyEnter: 'queue' })))
  slots.register('status', createStatusView(() => ({ busy: true, activityWord: 'answering', tick: 0, detail: 'compact', plan: false })))
  const redraw = new RedrawScheduler(() => {
    const start = performance.now()
    const { lines, cursor } = slots.compose(columns, 24)
    const composed = performance.now()
    screen.setLive(lines, cursor)
    const end = performance.now()
    composeMs += composed - start
    screenMs += end - composed
    frameMs.push(end - start)
    frames += 1
    if (pendingAt !== undefined) latency.push(end - pendingAt)
  })
  ctx.on('tui/render', () => redraw.request())
  redraw.now()
  await new Promise(resolve => emulator.write('', resolve))
  const profileStartUs = Number(process.hrtime.bigint() / 1000n)
  const begin = performance.now()
  for (const chunk of chunks) {
    pendingAt = performance.now()
    const start = performance.now()
    screen.commit(stream.push('text', chunk, columns))
    pushMs += performance.now() - start
    slots.invalidate()
    // Multiple feeds in one event-loop turn must collapse in the REAL scheduler.
    slots.invalidate()
    if (cadence > 0) await delay(cadence)
    else await immediate()
  }
  screen.commit(stream.settle([{ type: 'text', text }], columns))
  slots.invalidate()
  await immediate()
  const enqueued = performance.now()
  await new Promise(resolve => emulator.write('', resolve))
  const end = performance.now()
  const profileEndUs = Number(process.hrtime.bigint() / 1000n)
  const buffer = emulator.buffer.active
  const rows = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true))
  const cells = Array.from({ length: buffer.length }, (_, y) => {
    const line = buffer.getLine(y)
    return Array.from({ length: columns }, (_, x) => {
      const cell = line.getCell(x)
      return [cell.getChars(), cell.getFgColor(), cell.getBgColor(), cell.isBold(), cell.isItalic(), cell.isUnderline()]
    })
  })
  const picture = digest(JSON.stringify({ rows, cells, x: buffer.cursorX, y: buffer.cursorY, base: buffer.baseY }))
  redraw.stop()
  emulator.dispose()
  await ctx.fiber.dispose()
  return { kind, profileStartUs, profileEndUs, inputBytes: Buffer.byteLength(text), chunks: chunks.length, bytes, writes, frames, picture,
    wallMs: end - begin, enqueueMs: enqueued - begin, drainMs: end - enqueued,
    pushMs, composeMs, screenMs, writeMs, frameP50Ms: percentile(frameMs, .5), frameP95Ms: percentile(frameMs, .95),
    requestP50Ms: percentile(latency, .5), requestP95Ms: percentile(latency, .95), requestP99Ms: percentile(latency, .99),
    deliveredP95Ms: percentile(delivered, .95), lastDeliveryMs: lastDelivery - begin }
}

const results = []
for (const kind of kinds) {
  await turn(kind) // warm up, excluded from measurements
  const runs = []
  for (let repeat = 0; repeat < repetitions; repeat += 1) runs.push(await turn(kind))
  assert.equal(new Set(runs.map(run => run.picture)).size, 1, 'non-deterministic terminal picture')
  const medians = Object.fromEntries(Object.keys(runs[0]).map(key => [key,
    typeof runs[0][key] === 'number' ? percentile(runs.map(run => run[key]), .5) : runs[0][key]]))
  results.push({ kind, medians, runs })
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  screen: options.screen ?? 'shipping-typescript', palette: 'frontend-default-4', columns, lines, cadenceMs: cadence, repetitions, results }, null, 2))
