#!/usr/bin/env node
/** Disjoint CPU-sample attribution by nearest owning frame; includes startup/idle. */
import { readFileSync } from 'node:fs'
const profile = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const nodes = new Map(profile.nodes.map(node => [node.id, node]))
const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(id => [id, node.id])))
const buckets = {}, leaves = {}
const measurements = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : undefined
const spans = measurements?.results.flatMap(result => result.runs.map(run => [run.profileStartUs, run.profileEndUs]))
let timestamp = profile.startTime
function owner(id) {
  const node = nodes.get(id)
  const { functionName: name, url } = node.callFrame
  if (name === '(idle)') return 'idle'
  if (name === '(garbage collector)') return 'GC'
  if (url.includes('@xterm')) return 'emulator'
  if (url.endsWith('/width.js')) return 'width/wrap'
  if (url.endsWith('/screen.js') || url.endsWith('/baseline-screen.mjs')) return 'Screen'
  if (url.endsWith('/stream.js')) return 'StreamBuffer'
  if (/\/(slots|views|chrome)\.js$/.test(url)) return 'compose/views'
  if (url.endsWith('/renderer-perf.mjs') && name === 'write') return 'write/enqueue'
  if (url.includes('@deepseek-ai')) return 'fixture Harness/cordis'
  if (url.endsWith('/renderer-perf.mjs')) return 'replay driver'
  if (parents.has(id)) return owner(parents.get(id))
  return 'startup/runtime/other'
}
for (let index = 0; index < profile.samples.length; index += 1) {
  const id = profile.samples[index], us = profile.timeDeltas[index]
  timestamp += us
  if (spans && !spans.some(([start, end]) => timestamp >= start && timestamp <= end)) continue
  const bucket = owner(id)
  buckets[bucket] = (buckets[bucket] ?? 0) + us
  const frame = nodes.get(id).callFrame
  const key = `${frame.functionName} (${frame.url.split('/').slice(-2).join('/')})`
  leaves[key] = (leaves[key] ?? 0) + us
}
const total = Object.values(buckets).reduce((sum, value) => sum + value, 0)
console.log(JSON.stringify({ totalMs: total / 1000,
  buckets: Object.entries(buckets).sort((a, b) => b[1] - a[1]).map(([name, us]) => ({ name, ms: us / 1000, percent: us / total * 100 })),
  topSelf: Object.entries(leaves).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, us]) => ({ name, ms: us / 1000 })) }, null, 2))
