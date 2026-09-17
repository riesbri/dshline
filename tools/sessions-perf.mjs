#!/usr/bin/env node
/**
 * Fixture-service benchmark of the REAL compiled Sessions catalog and overlays.
 * Run: pnpm build && node tools/sessions-perf.mjs --output /tmp/dshline-sessions-perf-baseline.json
 * No production hooks, replacement algorithm, terminal, Harness backend, or dependencies.
 * Each size/repetition/mode has a fresh --expose-gc process; modes never share JIT state.
 */
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import { SessionCatalog, CATALOG_LIMIT, CONTENT_SEARCH_LIMIT } from '../packages/dshline/lib/sessions/catalog.js'
import { createSessionsOverlay } from '../packages/dshline/lib/sessions/overlay.js'
import { NO_FILTERS } from '../packages/dshline/lib/sessions/filters.js'

// Fixed geometry/clock and ten nonempty matching prefixes avoid measuring an empty-list shortcut.
const COLUMNS = 90
const ROWS = 24
const NOW = 1_800_000_000_000
const DAY = 86_400_000
const WORKSPACE = '/home/fixture/workspace-0'
const LOCAL_TEXT = 'benchmark '
const SIZES = [100, 1_000, 10_000]
const REPETITIONS = 5
const METHODS = ['listSessions', 'filterSessions', 'readTitleSnapshots', 'listEvents', 'searchSessions', 'searchEvents', 'readEvent', 'traceSession']
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SELF = fileURLToPath(import.meta.url)

function deferred() {
  let resolve
  const promise = new Promise(accept => { resolve = accept })
  return { promise, resolve }
}

// Fixture services settle only through microtasks. The bound detects broken fixtures instead
// of hiding failures behind sleeps; no event-loop/network/disk latency is being simulated.
async function settle() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

function fixture(size, mode) {
  const instrument = mode === 'counts'
  const counters = Object.fromEntries([...METHODS, 'titleIds', 'projections', 'invalidates', 'renders'].map(name => [name, 0]))
  const requests = []
  const call = (name, request) => {
    if (!instrument) return
    counters[name] += 1
    if (request !== undefined) requests.push({ method: name, request })
  }
  const records = Array.from({ length: size }, (_, index) => {
    const header = {
      version: SESSION_FORMAT_VERSION,
      id: `fixture-${String(index).padStart(6, '0')}`,
      createdAt: NOW - index * (40 * DAY / size),
      isSeeded: false,
      cwd: `/home/fixture/workspace-${index % 4}`,
      ...(index % 3 === 0 ? { origin: 'subagent', parentSession: 'fixture-parent' } : {}),
    }
    const record = { header, live: index % 10 === 0, persisted: true }
    if (instrument) {
      // Only toEntry reads record.live in the exercised production paths. Never spread
      // these records in fixture code: that would turn fixture construction into projections.
      const live = record.live
      Object.defineProperty(record, 'live', { enumerable: true, get() { counters.projections += 1; return live } })
    }
    return record
  })
  const byId = new Map(records.map(record => [record.header.id, record]))
  const titles = ids => ids.map(id => ({
    sessionId: id,
    status: 'fulfilled',
    value: {
      session: byId.get(id).header,
      title: { title: `benchmark session ${id} · repair renderer 日本語`, messageSeqs: [0], source: { kind: 'fallback' }, eventSeq: 1, updatedAt: NOW },
    },
  }))
  const eventHit = (id, seq) => ({ sessionId: id, seq, type: 'user/message', time: NOW - 1_000 + seq, surface: 'current', snippet: `benchmark evidence ${seq}` })
  const event = seq => ({ seq, type: 'user/message', time: NOW - 1_000 + seq, data: { content: [{ type: 'text', text: `benchmark evidence ${seq}` }] } })
  let titleGate
  const query = {
    async listSessions() { call('listSessions'); return records },
    async filterSessions(clauses) {
      call('filterSessions', clauses)
      return records.filter(record => clauses.every(clause => {
        if (clause.kind === 'cwd') return clause.values.includes(record.header.cwd)
        if (clause.kind === 'created-at') return (clause.from === undefined || record.header.createdAt >= clause.from) && (clause.to === undefined || record.header.createdAt <= clause.to)
        throw new Error(`Unexpected fixture clause ${clause.kind}`)
      }))
    },
    async readTitleSnapshots(ids) {
      call('readTitleSnapshots', { ids: [...ids] })
      if (instrument) counters.titleIds += ids.length
      if (titleGate !== undefined) await titleGate.promise
      return titles(ids)
    },
    async listEvents(id) { call('listEvents', { sessionId: id }); return Array.from({ length: 32 }, (_, seq) => ({ seq, type: 'user/message', time: NOW - 1_000 + seq })) },
    async searchSessions(request) {
      call('searchSessions', request)
      return { items: records.slice(0, request.limit).map(record => {
        const hit = { header: record.header, persisted: record.persisted, bestMatch: eventHit(record.header.id, 12) }
        Object.defineProperty(hit, 'live', instrument
          ? { enumerable: true, get() { counters.projections += 1; return false } }
          : { enumerable: true, value: false })
        return hit
      }) }
    },
    async searchEvents(request) {
      call('searchEvents', request)
      return { session: byId.get(request.sessionId).header, items: Array.from({ length: 20 }, (_, index) => eventHit(request.sessionId, index + 8)) }
    },
    async readEvent(request) {
      call('readEvent', request)
      const events = Array.from({ length: request.before + request.after + 1 }, (_, index) => event(request.seq - request.before + index))
      return { session: byId.get(request.sessionId).header, inheritedEventCount: 0, target: events[request.before], events, startSeq: events[0].seq, endSeq: events.at(-1).seq }
    },
    async traceSession(id) { call('traceSession', { sessionId: id }); throw new Error('Lineage is outside this benchmark') },
  }
  return {
    counters, requests, query,
    deferTitles() { titleGate = deferred() },
    releaseTitles() { const gate = titleGate; titleGate = undefined; gate.resolve() },
    invalidate() { if (instrument) counters.invalidates += 1 },
  }
}

function mount(f) {
  const catalog = new SessionCatalog({ query: f.query, invalidate: f.invalidate, workspace: { kind: 'cwd', cwd: WORKSPACE }, now: () => NOW })
  const children = []
  const methods = ['listing', 'content', 'filters', 'applyFilters', 'loadMoreContent', 'restartContentSearch', 'lineage', 'requestLineage', 'events', 'searchEvents', 'loadMoreEvents', 'requestEventContext', 'eventContext', 'detail', 'requestDetail', 'search']
  const overlay = createSessionsOverlay({
    ...Object.fromEntries(methods.map(name => [name, catalog[name].bind(catalog)])),
    currentSessionId: undefined, workspace: WORKSPACE, home: '/home/fixture', now: () => NOW,
    resume: () => { throw new Error('Benchmark must not resume a session') },
    push(child) { children.push(child); child.mounted?.() },
    close() { catalog.dispose() }, invalidate: f.invalidate,
  })
  return { catalog, overlay, children }
}

function key(overlay, name) { overlay.handleKey({ kind: 'key', name }) }
function text(overlay, value) { overlay.handleKey({ kind: 'text', text: value }) }
function draw(f, overlay, mode) {
  const rows = overlay.render(COLUMNS, ROWS)
  assert.ok(rows.length > 0 && rows.length <= ROWS, 'real overlay returned a bounded frame')
  if (mode === 'counts') f.counters.renders += 1
  // Consume output without retaining frames or writing to a terminal.
  return rows.reduce((length, row) => length + row.length, 0)
}
function ready(catalog) {
  assert.equal(catalog.listing().kind, 'ready')
  return catalog.listing()
}
function gcHeap() { global.gc(); global.gc(); return process.memoryUsage().heapUsed }

async function child(size, mode) {
  assert.equal(typeof global.gc, 'function', 'children require --expose-gc')
  const f = fixture(size, mode)
  if (mode === 'heap') {
    // Fixtures (including lookup map) already exist at the reference point. No getter,
    // request history, timing samples, or title snapshots pollute this separate run.
    const preOpen = gcHeap()
    const mounted = mount(f)
    f.deferTitles()
    mounted.catalog.refresh()
    await settle()
    assert.equal(mounted.catalog.listing().kind, 'loading')
    const pending = gcHeap()
    f.releaseTitles()
    await settle()
    const entries = ready(mounted.catalog).entries.length
    const retained = gcHeap()
    mounted.overlay.dispose?.()
    mounted.catalog.dispose()
    return { size, mode, heap: { preOpenBytes: preOpen, deferredTitleCheckpointBytes: pending, retainedAfterSettleBytes: retained, deferredTitleDeltaBytes: pending - preOpen, retainedDeltaBytes: retained - preOpen }, entries }
  }
  let mounted = mount(f)
  const stages = {}
  let consumedCharacters = 0
  const render = (overlay = mounted.overlay) => { consumedCharacters += draw(f, overlay, mode) }
  async function stage(name, action) {
    const before = { ...f.counters }
    const cpu = process.cpuUsage()
    const start = performance.now()
    await action()
    const wallMs = performance.now() - start
    const used = process.cpuUsage(cpu)
    stages[name] = mode === 'counts'
      ? Object.fromEntries(Object.keys(before).map(name => [name, f.counters[name] - before[name]]))
      : { wallMs, cpuUserMs: used.user / 1_000, cpuSystemMs: used.system / 1_000, cpuTotalMs: (used.user + used.system) / 1_000 }
  }
  await stage('firstCatalogOpen', async () => { mounted.catalog.refresh(); await settle(); ready(mounted.catalog) })
  assert.equal(ready(mounted.catalog).entries.length, Math.min(size, CATALOG_LIMIT))
  assert.equal(ready(mounted.catalog).truncated, Math.max(0, size - CATALOG_LIMIT))
  await stage('firstRender', () => render())
  await stage('titleObservationRefresh', async () => { mounted.catalog.refreshTitles(); await settle(); render() })
  await stage('cursor100WithRender', () => { for (let i = 0; i < 100; i += 1) { key(mounted.overlay, 'down'); render() } })
  await stage('localFilter10CharsWithRender', () => { for (const char of LOCAL_TEXT) { text(mounted.overlay, char); render() } })
  key(mounted.overlay, 'ctrl-u'); render()
  for (const [name, filters] of [
    ['workspaceFilterWithRender', { ...NO_FILTERS, workspace: 'current' }],
    ['ageFilterWithRender', { ...NO_FILTERS, age: '7d' }],
    ['workspaceAndAgeFilterWithRender', { ...NO_FILTERS, workspace: 'current', age: '7d' }],
    ['originOnlyFilterWithRender', { ...NO_FILTERS, origin: 'delegated' }],
  ]) {
    await stage(name, async () => { mounted.catalog.applyFilters(filters); await settle(); ready(mounted.catalog); render() })
  }
  await stage('detailDisclosureWithRender', async () => { key(mounted.overlay, 'right'); await settle(); render() })
  await stage('detailRepeated10WithRender', async () => { for (let i = 0; i < 10; i += 1) { key(mounted.overlay, 'left'); render(); key(mounted.overlay, 'right'); await settle(); render() } })
  await stage('closeAndNewCatalogReopenWithRender', async () => {
    key(mounted.overlay, 'ctrl-c'); mounted.overlay.dispose?.()
    mounted = mount(f); mounted.catalog.refresh(); await settle(); ready(mounted.catalog); render()
  })
  text(mounted.overlay, 'benchmark'); render()
  await stage('contentFirstPageWithRender', async () => { key(mounted.overlay, 'tab'); await settle(); assert.equal(mounted.catalog.content().kind, 'ready'); render() })
  // Go through the real detail action and child overlays, not replacement renderers.
  key(mounted.overlay, 'right'); await settle(); render()
  key(mounted.overlay, 'enter')
  const eventsOverlay = mounted.children.at(-1)
  assert.ok(eventsOverlay)
  text(eventsOverlay, 'benchmark')
  await stage('eventSearchWithRender', async () => { key(eventsOverlay, 'tab'); await settle(); assert.equal(mounted.catalog.events().kind, 'ready'); render(eventsOverlay) })
  await stage('eventCursor20WithRender', () => { for (let i = 0; i < 20; i += 1) { key(eventsOverlay, 'down'); render(eventsOverlay) } })
  await stage('readEventDisclosureWithRender', async () => {
    key(eventsOverlay, 'enter'); await settle()
    const context = mounted.children.at(-1)
    assert.notEqual(context, eventsOverlay)
    const hit = mounted.catalog.events().hits[0]
    assert.equal(mounted.catalog.eventContext(hit.sessionId, hit.seq).kind, 'ready')
    render(context)
  })
  if (mode === 'counts') {
    for (const name of ['firstRender', 'cursor100WithRender', 'localFilter10CharsWithRender', 'detailRepeated10WithRender', 'eventCursor20WithRender']) {
      for (const method of METHODS) assert.equal(stages[name][method], 0, `${name} must not call ${method}`)
    }
    assert.equal(stages.detailDisclosureWithRender.listEvents, 1)
    assert.equal(stages.readEventDisclosureWithRender.readEvent, 1)
    assert.equal(stages.contentFirstPageWithRender.searchSessions, 1)
    assert.equal(stages.contentFirstPageWithRender.titleIds, CONTENT_SEARCH_LIMIT)
  }
  for (const overlay of mounted.children) overlay.dispose?.()
  mounted.overlay.dispose?.(); mounted.catalog.dispose()
  return { size, mode, stages, consumedCharacters, ...(mode === 'counts' ? { totals: f.counters, requests: f.requests } : {}) }
}

function range(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1) }
}
function summarize(runs) {
  return SIZES.map(size => {
    const group = runs.filter(run => run.size === size)
    const timing = group.filter(run => run.mode === 'timing')
    const counts = group.filter(run => run.mode === 'counts')
    const heap = group.filter(run => run.mode === 'heap')
    assert.ok(counts.every(run => JSON.stringify(run.stages) === JSON.stringify(counts[0].stages)), 'call counts vary across isolated repetitions')
    return { size, counts: counts[0].stages,
      timing: Object.fromEntries(Object.keys(timing[0].stages).map(stage => [stage, Object.fromEntries(Object.keys(timing[0].stages[stage]).map(metric => [metric, range(timing.map(run => run.stages[stage][metric]))]))])),
      heap: Object.fromEntries(Object.keys(heap[0].heap).map(metric => [metric, range(heap.map(run => run.heap[metric]))])),
    }
  })
}

if (process.argv[2] === '--child') {
  process.stdout.write(`${JSON.stringify(await child(Number(process.argv[3]), process.argv[4]))}\n`)
} else {
  const outputIndex = process.argv.indexOf('--output')
  const output = outputIndex < 0 ? '/tmp/dshline-sessions-perf-baseline.json' : process.argv[outputIndex + 1]
  assert.ok(output && !resolve(output).startsWith(ROOT), 'save raw results outside the tracked tree')
  const files = ['packages/dshline/lib/sessions/catalog.js', 'packages/dshline/lib/sessions/overlay.js', 'packages/dshline/lib/sessions/panels.js', 'packages/dshline/lib/sessions/model.js', 'packages/dshline/lib/sessions/filters.js']
  const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex')]))
  const before = hashes()
  const runs = []
  for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
    for (const size of SIZES) {
      for (const mode of ['counts', 'timing', 'heap']) {
        const result = spawnSync(process.execPath, ['--expose-gc', SELF, '--child', String(size), mode], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TZ: 'UTC', NO_COLOR: '1', FORCE_COLOR: '0' } })
        assert.equal(result.status, 0, `child ${size}/${mode} failed: ${result.error ?? ''}\n${result.stderr}\n${result.stdout}`)
        runs.push({ repetition, ...JSON.parse(result.stdout) })
      }
    }
    process.stderr.write(`completed isolated repetition ${repetition}/${REPETITIONS}\n`)
  }
  assert.deepEqual(hashes(), before, 'compiled runtime changed during collection')
  const report = {
    benchmark: 'REAL compiled Sessions frontend + synthetic fixture services (NOT real Harness costs)',
    generatedAt: new Date().toISOString(), command: `pnpm build && node tools/sessions-perf.mjs --output ${output}`,
    metadata: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), compiledSha256: before },
    parameters: { sizes: SIZES, repetitions: REPETITIONS, catalogLimit: CATALOG_LIMIT, pageLimit: CONTENT_SEARCH_LIMIT, columns: COLUMNS, rows: ROWS, now: NOW, timezone: 'UTC', localText: LOCAL_TEXT },
    limitations: [
      'Fixture service costs only: no Harness persistence scans, title folding, index, I/O, model, terminal Screen diff, or real session attachment.',
      'First catalog open includes initial title observation; titleObservationRefresh is a separate explicit refreshTitles plus render, not an additive decomposition of open.',
      'Each timing child is cold after module import; later stages share that child JIT/GC history. Module/process startup and fixture allocation are excluded. No warmup and no CI timing thresholds.',
      'Counts/getters/request history are isolated from ordinary-property timing and heap children. All stage durations include the microtask settle helper where asynchronous work is required.',
      'Fixture filterSessions scans the synthetic authoritative corpus; content service returns its fixed first 50 hits and event search 20 hits, not a real search implementation.',
      'Heap is V8 heapUsed after two explicit GCs, relative to pre-open after fixture allocation. Deferred-title checkpoint captures known overlapping listing allocations, NOT a continuously sampled absolute peak or allocation total; transient peaks before/after this checkpoint can be missed.',
      'Retained heap is after first listing settles, before rendering or disposal. Imports/fixture lookup map remain alive in both reference and measurement. GC and JIT noise can produce small or negative deltas.',
      'Default 200-entry cap applies. Local filtering is over retained entries, not all source records; origin/filter services are exercised through actual catalog APIs; content/event disclosure uses real overlay keys.',
    ],
    summary: summarize(runs), runs,
  }
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`Saved ${runs.length} isolated samples to ${output}\n`)
  for (const result of report.summary) process.stdout.write(`${result.size}: open ${result.timing.firstCatalogOpen.wallMs.median.toFixed(3)} ms; projections ${result.counts.firstCatalogOpen.projections}; pending heap delta ${result.heap.deferredTitleDeltaBytes.median} B; retained delta ${result.heap.retainedDeltaBytes.median} B\n`)
}
