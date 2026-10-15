import { mkdtemp, writeFile, appendFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertExact, checkParity, fixtures, inputOf, runBackend, validateCorpus } from './renderer-parity.mjs'
import { corpusInputs } from './renderer-parity-corpus.mjs'
import { capture, readBoundedJson } from './renderer-capture.mjs'
import { CaptureInputSchema } from './renderer-schema.mjs'
import headless from '@xterm/headless'

describe('renderer Phase 2 parity harness', () => {
  it('replays every checked-in reference with exact source/build identity', async () => {
    const result = await checkParity()
    expect(result.referenceCases).toBeGreaterThan(80)
    expect(result.nativeCases).toBe(0)
    expect(result.nativeParity).toContain('PENDING')
  })
  it('covers all normalized operation tags without relaxing admission', () => {
    const inputs = corpusInputs()
    expect(new Set(inputs.map(value => value.cases[0].input.op)).size).toBe(20)
    for (const input of inputs) expect(CaptureInputSchema.safeParse(input).success).toBe(true)
  })
  it('detects same-ID canonical request drift until re-recorded, including palette and provenance', () => {
    const original = corpusInputs().find(value => value.cases[0].id === 'sgr-order')
    const fixture = capture(original)
    validateCorpus([fixture], [original])
    const mutations = [
      value => { value.cases[0].input.text += 'changed' },
      value => { value.cases[0].input.params = [39] },
      value => { value.provenance.description += 'changed' },
      value => { value.palette = { id: 'changed', depth: 0, roles: {} } },
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(original)
      mutate(changed)
      expect(() => validateCorpus([fixture], [changed])).toThrow('canonical request; re-record')
      validateCorpus([capture(changed)], [changed])
    }
  })
  it('rejects duplicate, missing and unintended stale fixtures without touching repository files', () => {
    const original = corpusInputs()[0]
    const fixture = capture(original)
    expect(() => validateCorpus([fixture, fixture], [original])).toThrow('Duplicate recorded')
    expect(() => validateCorpus([fixture], [original, original])).toThrow('Duplicate canonical')
    expect(() => validateCorpus([], [original])).toThrow('Missing required')
    expect(() => validateCorpus([fixture], [])).toThrow('Unintended stale')
  })
  it('bounds actual file bytes even after growth invalidates previously safe metadata', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'renderer-bounded-read-'))
    const path = join(scratch, 'input.json')
    try {
      await writeFile(path, '{}      ')
      expect((await stat(path)).size).toBe(8)
      expect(await readBoundedJson(path, 8)).toEqual({})
      await appendFile(path, ' ')
      await expect(readBoundedJson(path, 8)).rejects.toThrow('RESOURCE_LIMIT')
      await writeFile(path, '{}')
      expect(await readBoundedJson(path, 8)).toEqual({})
    } finally { await rm(scratch, { recursive: true, force: true }) }
  })
  it('fails required-native mode when no backend exists', async () => {
    await expect(checkParity(undefined, true)).rejects.toThrow('Rust backend required')
  })
  it('deliberate ANSI reset and lone-surrogate replacement mutations are detected', () => {
    expect(() => assertExact('\u001b[39m', '\u001b[0m', 'reset mutation')).toThrow('reset mutation')
    expect(() => assertExact('\ufffd', '\ud800', 'surrogate mutation')).toThrow('surrogate mutation')
    const request = corpusInputs().find(value => value.cases[0].id === 'sgr-order')
    const golden = capture(request).cases[0].output
    expect(() => assertExact(golden.replace('\u001b[0m', '\u001b[39m'), golden, 'captured SGR reset mutation')).toThrow('captured SGR reset mutation')
    expect(() => assertExact({ writes: ['a', 'b'] }, { writes: ['ab'] }, 'chunk mutation')).toThrow('chunk mutation')
  })
  it('exercises JSON argv backend protocol and catches deliberate output mutation', async () => {
    const fixture = (await fixtures())[0]
    const input = inputOf(fixture)
    const command = [process.execPath, '--input-type=module', '-e', `import { captureResult } from './tools/renderer-capture.mjs'; let s=''; for await (const c of process.stdin) s+=c; process.stdout.write(JSON.stringify(captureResult(JSON.parse(s))))`]
    expect(runBackend(command, input)).toEqual(fixture.cases.map(({ id, output }) => ({ id, output })))
    const mutant = [process.execPath, '--input-type=module', '-e', `let s=''; for await(const c of process.stdin)s+=c;const x=JSON.parse(s);process.stdout.write(JSON.stringify({ok:true,value:{cases:x.cases.map(c=>({...c,output:'MUTATED'}))}}))`]
    expect(() => assertExact(runBackend(mutant, input), fixture.cases.map(({ id, output }) => ({ id, output })), 'backend mutation')).toThrow('backend mutation')
  })
  it('replays Screen host calls in xterm and examines cells, attributes, cursor and BCE', async () => {
    const input = corpusInputs().find(value => value.cases[0].id === 'screen-resize-bce')
    const steps = capture(input).cases[0].output
    const term = new headless.Terminal({ cols: 18, rows: 8, allowProposedApi: true })
    const feed = async writes => { for (const text of writes) await new Promise(resolve => term.write(text, resolve)) }
    try {
      // Host rendition is deliberately nondefault: Screen must not reset before erase.
      await feed(['\u001b[41m'])
      await feed(steps[0].writes)
      const cell = term.buffer.active.getLine(0).getCell(0)
      expect(cell.getChars()).toBe('A')
      expect(cell.getFgColor()).toBe(3)
      expect(cell.getBgColor()).toBe(1)
      expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([1, 0])
      expect(term.buffer.active.getLine(0).getCell(10).getBgColor()).toBe(1)
      expect(steps[1].writes).toEqual([])
      await feed(steps[2].writes)
      term.resize(10, 8)
      for (const step of steps.slice(3)) await feed(step.writes)
      expect(term.buffer.active.getLine(0).translateToString(true)).toBe('done')
      expect(steps.at(-1).height).toBe(0)
      expect(term.buffer.active.cursorX).toBe(0)
    } finally { term.dispose() }
  })
})
