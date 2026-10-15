/** Independent verified TS oracle + exact, lossless JSON comparison. No runtime dispatch. */
import { readdir, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { capture, readBoundedJson, normalizeCaptureInput } from './renderer-capture.mjs'
import { corpusInputs } from './renderer-parity-corpus.mjs'
const directory = new URL('../tests/fixtures/renderer-parity/', import.meta.url)
export function assertExact(actual, expected, label) {
  // Deep equality compares JS UTF-16 units, ordered strings/arrays and JSON values;
  // object key order is immaterial. Never encode rendered strings through UTF-8.
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Exact renderer mismatch: ${label}`)
}
export function inputOf(fixture) {
  const { version, provenance, palette, cases } = fixture
  return { version, provenance, palette, cases: cases.map(({ id, input }) => ({ id, input })) }
}
/** Command is a differential HOST ADAPTER, not the Rust crate ABI.
 * It keeps Screen/markdown sequence orchestration in TS, injecting native pure
 * transforms below those hosts. ScreenSequence must never become Rust state.
 */
export function runBackend(command, input) {
  if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string')) throw new Error('Backend command must be a nonempty JSON argv array')
  const result = spawnSync(command[0], command.slice(1), { input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576, shell: false })
  if (result.error || result.status !== 0) throw new Error('Renderer backend command failed')
  const envelope = JSON.parse(result.stdout)
  if (envelope?.ok !== true || !Array.isArray(envelope.value?.cases)) throw new Error('Invalid backend envelope')
  return envelope.value.cases.map(({ id, output }) => ({ id, output }))
}
export async function fixtures() {
  return Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).sort().map(async name => {
    const path = new URL(name, directory)
    return readBoundedJson(path)
  }))
}
/** Validate canonical requests before replay; fixture IDs alone are not authority. */
export function validateCorpus(recorded, canonicalInputs = corpusInputs()) {
  const expected = new Map()
  for (const source of canonicalInputs) {
    const normalized = normalizeCaptureInput(source)
    if (normalized.cases.length !== 1) throw new Error('Canonical corpus requires one case per fixture')
    const id = normalized.cases[0].id
    if (expected.has(id)) throw new Error('Duplicate canonical fixture: ' + id)
    expected.set(id, normalized)
  }
  const seen = new Set()
  for (const fixture of recorded) {
    const normalized = normalizeCaptureInput(inputOf(fixture))
    if (normalized.cases.length !== 1) throw new Error('Recorded corpus requires one case per fixture')
    const id = normalized.cases[0].id
    if (seen.has(id)) throw new Error('Duplicate recorded fixture: ' + id)
    seen.add(id)
    if (!expected.has(id)) throw new Error('Unintended stale corpus fixture: ' + id)
    assertExact(normalized, expected.get(id), id + ' canonical request; re-record changed inputs')
  }
  for (const id of expected.keys()) if (!seen.has(id)) throw new Error('Missing required corpus fixture: ' + id)
}
export async function checkParity(command, requireRust = false) {
  if (!command && requireRust) throw new Error('Rust backend required but unavailable; parity PENDING')
  let referenceCases = 0, nativeCases = 0, hostAdapterCases = 0
  const recorded = await fixtures()
  validateCorpus(recorded)
  for (const fixture of recorded) {
    const input = inputOf(fixture)
    const fresh = capture(input)
    assertExact(fresh.reference.identity, fixture.reference.identity, 'source/build/compiler identity')
    assertExact(fresh, fixture, fixture.cases[0].id + ' reference golden')
    referenceCases += fresh.cases.length
    if (command) {
      assertExact(runBackend(command, input), fresh.cases.map(({ id, output }) => ({ id, output })), fixture.cases[0].id + ' native')
      hostAdapterCases += fresh.cases.filter(item => ['screenSequence', 'markdownSequence'].includes(item.input.op)).length
      nativeCases += fresh.cases.filter(item => !['screenSequence', 'markdownSequence'].includes(item.input.op)).length
    }
  }
  return { referenceCases, nativeCases, hostAdapterCases, nativeParity: command ? 'passed' : 'PENDING: Rust backend absent (reference-only validation)' }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args[0] === '--record' && args.length === 1) {
    await mkdir(directory, { recursive: true })
    for (const input of corpusInputs()) await writeFile(new URL(`${input.cases[0].id.replace(/[^\w-]/gu, '_')}.json`, directory), JSON.stringify(capture(input), null, 2) + '\n')
  } else {
    const commandIndex = args.indexOf('--backend')
    const command = commandIndex < 0 ? undefined : JSON.parse(args[commandIndex + 1])
    if (args.some((arg, index) => !['--reference-only', '--require-rust', '--backend'].includes(arg) && !(commandIndex >= 0 && index === commandIndex + 1))) throw new Error('Usage: --record | --reference-only | --require-rust --backend JSON_ARGV')
    if (!command && !args.includes('--reference-only') && !args.includes('--require-rust')) throw new Error('Select --reference-only explicitly; native parity is pending')
    process.stdout.write(JSON.stringify(await checkParity(command, args.includes('--require-rust'))) + '\n')
  }
}
