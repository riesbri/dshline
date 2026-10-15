import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rendererIdentity } from './renderer-identity.mjs'
import { describe, expect, it } from 'vitest'
import { CaptureInputSchema, MarkdownTransitionInputSchema, MarkdownTransitionOutputSchema, PresentationSchema } from './renderer-schema.mjs'
import { capture, captureResult, syntheticInput } from './renderer-capture.mjs'
import { extractApi } from './renderer-spec.mjs'

describe('renderer Phase 1 boundary', () => {
  it('rejects behavioral source/build drift using isolated compiler emission', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const scratch = mkdtempSync(join(tmpdir(), 'renderer-identity-test-'))
    try {
      cpSync(join(root, 'packages/renderer'), join(scratch, 'packages/renderer'), { recursive: true })
      cpSync(join(root, 'tsconfig.base.json'), join(scratch, 'tsconfig.base.json'))
      symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
      const baseline = rendererIdentity(scratch)
      const source = join(scratch, 'packages/renderer/src/width.ts')
      const original = readFileSync(source, 'utf8')
      writeFileSync(source, original.replace('return 1', 'return 2'))
      expect(() => rendererIdentity(scratch)).toThrow('stale or modified')
      writeFileSync(source, original)
      const build = join(scratch, 'packages/renderer/lib/width.js')
      writeFileSync(build, readFileSync(build, 'utf8').replace('return 1', 'return 2'))
      expect(() => rendererIdentity(scratch)).toThrow('stale or modified')
      expect(baseline.source).toMatch(/^[a-f0-9]{64}$/u)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  })
  it('executes a valid rebuild from a unique graph after the old renderer was preloaded', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const scratch = mkdtempSync(join(tmpdir(), 'renderer-cache-test-'))
    try {
      cpSync(join(root, 'packages/renderer'), join(scratch, 'packages/renderer'), { recursive: true })
      cpSync(join(root, 'tools'), join(scratch, 'tools'), { recursive: true })
      cpSync(join(root, 'tsconfig.base.json'), join(scratch, 'tsconfig.base.json'))
      symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
      const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { readFileSync, writeFileSync } from 'node:fs'
        import { execFileSync } from 'node:child_process'
        const old = await import('./packages/renderer/lib/index.js')
        if (old.codePointWidth(65) !== 1) throw new Error('unexpected baseline')
        const path = './packages/renderer/src/width.ts'
        const source = readFileSync(path, 'utf8')
        const changed = source.replace('code < 0x7f) return 1', 'code < 0x7f) return 2')
        if (changed === source) throw new Error('behavioral mutation did not apply')
        writeFileSync(path, changed)
        execFileSync('./node_modules/.bin/tsc', ['-p', './packages/renderer/tsconfig.json'])
        const { capture, syntheticInput } = await import('./tools/renderer-capture.mjs')
        const result = capture({ ...syntheticInput, cases: [{ id: 'new-code', input: { op: 'codePointWidth', code: 65 } }] })
        process.stdout.write(JSON.stringify(result.cases[0].output))
      `], { cwd: scratch, encoding: 'utf8' })
      expect(JSON.parse(result)).toBe(2)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  }, 30_000)
  it('admits the full Unicode code-point domain including preserved surrogate units', () => {
    const cases = [0, 0x4e00, 0x1f600, 0xd800, 0xdfff, 0x10ffff].map(code => ({ id: String(code), input: { op: 'codePointWidth', code } }))
    expect(capture({ ...syntheticInput, cases }).cases.map(item => item.output)).toEqual([0, 2, 2, 1, 1, 1])
    for (const code of [-1, 0x110000, 1.5, Infinity, NaN]) expect(PresentationSchema.safeParse({ op: 'codePointWidth', code }).success).toBe(false)
    expect(PresentationSchema.safeParse({ op: 'sgr', text: '', params: [10000] }).success).toBe(false)
  })
  it('refuses allocation attacks before reference execution with bounded error envelopes', () => {
    for (const input of [
      { op: 'fitToWidth', text: 'x', columns: Number.MAX_SAFE_INTEGER },
      { op: 'frame', content: Array(65).fill('x'), options: { width: 20 } },
      { op: 'wrapToWidth', text: 'x'.repeat(2049), columns: 20 },
      { op: 'screenSequence', columns: 256, calls: Array(64).fill({ method: 'setLive', lines: Array(64).fill('x'.repeat(100)) }) },
    ]) {
      const result = captureResult({ ...syntheticInput, cases: [{ id: 'attack', input }] })
      expect(result).toEqual({ ok: false, error: { code: 'RESOURCE_LIMIT', fallbackEligible: false } })
    }
    const valid = { id: 'padding', input: { op: 'fitToWidth', text: 'x', columns: 100 } }
    expect(PresentationSchema.safeParse(valid.input).success).toBe(true)
    expect(MarkdownTransitionInputSchema.safeParse({ state: { fence: null }, palette: { id: 'x', depth: 4, roles: {} }, text: 'x'.repeat(2049), mode: 'line', startsLine: true }).success).toBe(false)
    expect(MarkdownTransitionOutputSchema.safeParse({ state: { fence: null }, rows: Array(64).fill('x'.repeat(100)) }).success).toBe(false)
    expect(CaptureInputSchema.safeParse({ ...syntheticInput, cases: Array.from({ length: 64 }, (_, index) => ({ ...valid, id: String(index) })) }).success).toBe(false)
  })
  it('records the exact built public API and schema without drift', async () => {
    expect(await extractApi()).toEqual(JSON.parse(await readFile(new URL('../docs/renderer-spec.json', import.meta.url), 'utf8')))
  })
  it('rejects domain objects, callbacks, malformed operations and ambiguous provenance', () => {
    for (const input of [
      { op: 'displayWidth', text: 'x', sessionId: 'private' },
      { op: 'frame', content: [], options: { width: 20, border: () => '' } },
      { op: 'wrapToWidth', text: 'x', columns: NaN },
      { op: 'screenSequence', columns: 20, calls: [{ method: 'launchAgent' }] },
    ]) expect(PresentationSchema.safeParse(input).success).toBe(false)
    expect(CaptureInputSchema.safeParse({ ...syntheticInput, provenance: { kind: 'observed', description: 'no consent' } }).success).toBe(false)
    expect(CaptureInputSchema.safeParse({ ...syntheticInput, cases: [syntheticInput.cases[0], syntheticInput.cases[0]] }).success).toBe(false)
  })
  it('captures resolved palettes without ambient state and validates explicit fence state', () => {
    const palette = { id: 'none', depth: 0, roles: {} }
    const output = capture({ ...syntheticInput, palette, cases: [{ id: 'heading', input: { op: 'renderMarkdown', text: '# hello' } }] })
    expect(output.palette).toEqual(palette)
    expect(output.cases[0].output).toEqual(['hello'])
    const transition = { state: { fence: '````' }, palette, text: '```', mode: 'partial', startsLine: false }
    expect(MarkdownTransitionInputSchema.safeParse(transition).success).toBe(true)
    expect(MarkdownTransitionInputSchema.safeParse({ ...transition, state: { fence: '`~`' } }).success).toBe(false)
    expect(capture(syntheticInput).palette.depth).toBe(4)
  })
  it('captures actual outputs deterministically, preserving surrogate code units and ANSI', () => {
    const first = capture(syntheticInput)
    expect(capture(JSON.parse(JSON.stringify(syntheticInput)))).toEqual(first)
    expect(first.cases[0].output.join('')).toContain('\ud800')
    expect(first.cases[1].output).toBe('\u001b[31m中文a\u001b[0m')
    const screen = first.cases[3].output
    expect(screen[1].writes).toEqual([])
    expect(screen[2].writes.join('')).toContain('finished\r\n')
    expect(screen.at(-1).height).toBe(0)
  })
})
