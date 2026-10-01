import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { displayWidth, escapeControls, setPalette, Screen } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { DEFAULT_PALETTE } from '../src/theme.ts'
import { ShellOutput } from '../src/shell-output.ts'
import { RetainedCollector } from './shell-output.fixture.ts'

let restorePalette: () => void
beforeEach(() => { restorePalette = setPalette(DEFAULT_PALETTE, 0) })
afterEach(() => { restorePalette() })

function setup(maxBytes = 64_000) {
  const rows: string[] = []
  const batches: number[] = []
  const readers = { stdout: new RetainedCollector(maxBytes), stderr: new RetainedCollector(maxBytes) }
  const output = new ShellOutput(batch => { rows.push(...batch); batches.push(batch.length) })
  return { rows, batches, readers, output }
}

function play(bytes: Buffer, chunks: number[]): string[] {
  const { rows, readers, output } = setup()
  let cursor = 0
  for (const size of chunks) {
    readers.stdout.push(bytes.subarray(cursor, cursor + size))
    cursor += size
    output.poll(readers)
    output.poll(readers)
  }
  readers.stdout.push(bytes.subarray(cursor))
  output.poll(readers, true)
  output.flush()
  output.flush()
  return rows
}

function reference(bytes: Buffer): string[] {
  const text = bytes.toString('utf8')
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map(escapeControls)
}

describe('shell observed stream projection', () => {
  it('independently repairs every split of adjacent two/three/four-byte characters', () => {
    for (const text of ['é界😀é界😀\nlast', 'a�界��😀�', '�', '���', '\n\n']) {
      const bytes = Buffer.from(text)
      for (let split = 0; split <= bytes.length; split += 1) {
        expect(play(bytes, [split]), `${text} split ${String(split)}`).toEqual(reference(bytes))
      }
      expect(play(bytes, Array.from({ length: bytes.length }, () => 1))).toEqual(reference(bytes))
    }
  })

  it('flushes invalid bytes, incomplete EOF and literal replacement runs exactly once', () => {
    for (const bytes of [Buffer.from([0xff, 0xfe, 0x61, 0xe7]), Buffer.from([0xf0, 0x9f, 0x98]), Buffer.from('x���')]) {
      expect(play(bytes, Array.from({ length: bytes.length }, () => 1))).toEqual(reference(bytes))
    }
    const { rows, readers, output } = setup()
    readers.stdout.push(Buffer.from('prefix���'))
    output.poll(readers)
    expect(output.live(100)).toEqual(['prefix'])
    expect(rows).toEqual([])
    output.poll(readers, true)
    output.flush()
    expect(rows).toEqual(['prefix���'])
  })

  it('uses separate offsets, framing and identifiable stderr tails', () => {
    const { rows, readers, output } = setup()
    readers.stdout.push(Buffer.from('one\n界').subarray(0, 6))
    readers.stderr.push(Buffer.from('bad\npartial'))
    output.poll(readers)
    expect(rows).toEqual(['one', '[stderr] bad'])
    expect(output.live(20)).toEqual(['[stderr] partial'])
    readers.stdout.push(Buffer.from('界').subarray(2))
    output.poll(readers, true)
    output.flush()
    expect(rows).toEqual(['one', '[stderr] bad', '界', '[stderr] partial'])
  })

  it('flushes pre-gap tails, skips uncertain snapshots and warns once across streams', () => {
    const { rows, readers, output } = setup(4)
    readers.stdout.push(Buffer.from('old'))
    output.poll(readers)
    readers.stdout.push(Buffer.from('lost\n'))
    output.poll(readers)
    readers.stderr.push(Buffer.from('another gap\n'))
    output.poll(readers)
    readers.stdout.push(Buffer.from('new\n'))
    output.poll(readers)
    output.poll(readers, true)
    output.flush()
    expect(rows).toEqual(['old', '[shell output skipped: retained capture window overflowed]', 'new'])
  })

  it.each(['stdout', 'stderr'] as const)('keeps the other stream’s unfinished line intact when %s loses bytes', lost => {
    const { rows, readers, output } = setup()
    const intact = lost === 'stdout' ? 'stderr' : 'stdout'
    readers[lost] = new RetainedCollector(6)
    const offsets = { stdout: [] as number[], stderr: [] as number[] }
    for (const name of ['stdout', 'stderr'] as const) {
      const read = readers[name].readFrom.bind(readers[name])
      readers[name].readFrom = offset => { offsets[name].push(offset); return read(offset) }
    }
    const row = (name: 'stdout' | 'stderr', text: string) => name === 'stderr' ? `[stderr] ${text}` : text
    const character = Buffer.from('界')
    readers[lost].push(Buffer.concat([Buffer.from('old'), character.subarray(0, 1)]))
    readers[intact].push(Buffer.from('compil'))
    output.poll(readers)
    expect(rows).toEqual([])

    readers[lost].push(Buffer.from('missing\n'))
    output.poll(readers)
    expect(rows).toEqual([row(lost, 'old'), '[shell output skipped: retained capture window overflowed]'])
    expect(output.live(100)).toEqual([row(intact, 'compil')])
    output.poll(readers)
    output.poll(readers)
    expect(output.live(100)).toEqual([row(intact, 'compil')])

    // These bytes are a continuation of the lost character, not a new character.
    readers[lost].push(character.subarray(1))
    output.poll(readers)
    readers[lost].push(Buffer.from('z\n'))
    output.poll(readers)
    readers[intact].push(Buffer.from('ation failed\n'))
    output.poll(readers)
    output.poll(readers, true)
    output.poll(readers, true)
    output.flush()
    output.flush()
    expect(rows).toEqual([
      row(lost, 'old'), '[shell output skipped: retained capture window overflowed]',
      row(lost, 'z'), row(intact, 'compilation failed'),
    ])
    expect(output.live(100)).toEqual([])
    expect(offsets[lost]).toEqual([0, 0, 12, 12, 12, 12, 16, 16, 16])
    expect(offsets[intact]).toEqual([0, 6, 6, 6, 6, 6, 6, 19, 19])
  })

  it.each(['stdout', 'stderr'] as const)('preserves the other stream’s held UTF-8 prefix and literal replacements across %s loss', lost => {
    const { rows, readers, output } = setup()
    const intact = lost === 'stdout' ? 'stderr' : 'stdout'
    readers[lost] = new RetainedCollector(4)
    const character = Buffer.from('界')
    readers[intact].push(Buffer.concat([Buffer.from('safe'), character.subarray(0, 1)]))
    output.poll(readers)
    readers[lost].push(Buffer.from('missing\n'))
    output.poll(readers)
    output.poll(readers)
    expect(rows).toEqual(['[shell output skipped: retained capture window overflowed]'])
    expect(output.live(100)).toEqual([intact === 'stderr' ? '[stderr] safe' : 'safe'])

    readers[intact].push(Buffer.concat([character.subarray(1), Buffer.from('��')]))
    output.poll(readers)
    output.poll(readers)
    expect(output.live(100)).toEqual([intact === 'stderr' ? '[stderr] safe界' : 'safe界'])
    output.poll(readers, true)
    output.flush()
    output.poll(readers, true)
    output.flush()
    expect(rows).toEqual([
      '[shell output skipped: retained capture window overflowed]',
      intact === 'stderr' ? '[stderr] safe界��' : 'safe界��',
    ])
  })

  it('terminates each stream’s own tails on simultaneous and repeated gaps despite sharing one warning', () => {
    const { rows, readers, output } = setup(8)
    readers.stdout.push(Buffer.from('out'))
    readers.stderr.push(Buffer.from('err'))
    output.poll(readers)
    readers.stdout.push(Buffer.from('missing stdout\n'))
    readers.stderr.push(Buffer.from('missing stderr\n'))
    output.poll(readers)
    // The marker reports the first observed gap, not a global chronological boundary.
    expect(rows).toEqual(['out', '[shell output skipped: retained capture window overflowed]', '[stderr] err'])
    readers.stdout.push(Buffer.from('a'))
    readers.stderr.push(Buffer.from('b'))
    output.poll(readers)
    readers.stdout.push(Buffer.from('missing again\n'))
    output.poll(readers)
    expect(output.live(100)).toEqual(['[stderr] b'])
    readers.stderr.push(Buffer.from('missing again\n'))
    output.poll(readers)
    readers.stdout.push(Buffer.from('ok\n'))
    readers.stderr.push(Buffer.from('bad\n'))
    output.poll(readers, true)
    output.flush()
    output.flush()
    expect(rows).toEqual([
      'out', '[shell output skipped: retained capture window overflowed]', '[stderr] err',
      'a', '[stderr] b', 'ok', '[stderr] bad',
    ])
  })

  it('drains completed rows and the affected tail before warning without flushing the other pending tail', () => {
    const { rows, batches, readers, output } = setup()
    readers.stderr = new RetainedCollector(4)
    readers.stderr.push(Buffer.from('err'))
    output.poll(readers)
    readers.stdout.push(Buffer.from(`${'line\n'.repeat(31)}tail`))
    readers.stderr.push(Buffer.from('missing\n'))
    output.poll(readers)
    expect(rows).toEqual([
      ...Array.from({ length: 31 }, () => 'line'), '[stderr] err',
      '[shell output skipped: retained capture window overflowed]',
    ])
    expect(batches).toEqual([32, 1])
    expect(output.live(100)).toEqual(['tail'])
    readers.stdout.push(Buffer.from(' end\n'))
    output.poll(readers, true)
    output.flush()
    expect(rows.at(-1)).toBe('tail end')
    expect(batches).toEqual([32, 1, 1])
  })

  it('preserves resynchronization across empty reads and drops mid-character fragments', () => {
    const { rows, readers, output } = setup(3)
    readers.stdout.push(Buffer.from('xx界').subarray(0, 4))
    output.poll(readers)
    output.poll(readers)
    output.poll(readers)
    readers.stdout.push(Buffer.from('界').subarray(2))
    output.poll(readers)
    readers.stdout.push(Buffer.from('z\n'))
    output.poll(readers)
    output.poll(readers, true)
    output.flush()
    expect(rows).toEqual(['[shell output skipped: retained capture window overflowed]', 'z'])
  })

  it('does not duplicate an already-emitted stable prefix after loss invalidates a held decoder read', () => {
    const { rows, readers, output } = setup(6)
    readers.stdout.push(Buffer.concat([Buffer.from('old'), Buffer.from('界').subarray(0, 1)]))
    output.poll(readers)
    expect(output.live(20)).toEqual(['old'])
    const read = readers.stdout.readFrom.bind(readers.stdout)
    readers.stdout.readFrom = offset => ({ ...read(offset), spillPath: '/private/spill/not-for-display' })
    readers.stdout.push(Buffer.from('missing\n'))
    output.poll(readers)
    readers.stdout.push(Buffer.from('fresh\n'))
    output.poll(readers, true)
    output.flush()
    expect(rows).toEqual(['old', '[shell output skipped: retained capture window overflowed]', 'fresh'])
    expect(rows.join('')).not.toContain('/private')
  })

  it('segments huge logical lines without surrogate cuts and commits in bounded batches', () => {
    const { rows, batches, readers, output } = setup(2_000_000)
    const text = `${'x'.repeat(4095)}😀${'界😀'.repeat(100_000)}\n${'short\n'.repeat(10_000)}`
    readers.stdout.push(Buffer.from(text))
    output.poll(readers, true)
    output.flush()
    expect(rows.slice(0, -10_000).join('')).toBe(text.slice(0, text.indexOf('\n')))
    expect(rows.slice(-10_000)).toEqual(Array.from({ length: 10_000 }, () => 'short'))
    expect(Math.max(...batches)).toBeLessThanOrEqual(32)
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(4096)
      expect(/[\ud800-\udbff]$/u.test(row)).toBe(false)
      expect(/^[\udc00-\udfff]/u.test(row)).toBe(false)
    }
    expect(output.live(10)).toEqual([])
  })

  it('bounds live output to two display-width-safe rows at every width', () => {
    const { readers, output } = setup()
    readers.stdout.push(Buffer.from('界'.repeat(100)))
    readers.stderr.push(Buffer.from('bad\t\x1b[2J\r'.repeat(100)))
    output.poll(readers)
    for (const columns of [0, 1, 2, 8, 12, 40]) {
      const rows = output.live(columns)
      expect(rows.length).toBeLessThanOrEqual(2)
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(columns)
    }
    expect(output.live(40)[1]).toContain('[stderr]')
  })

  it('matches definitive UTF-8 decoding across 3000 deterministic randomized sequences', () => {
    let seed = 0x639ed
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    for (let sequence = 0; sequence < 3000; sequence += 1) {
      const bytes = Buffer.from(Array.from({ length: next() % 80 }, () => next() >>> 24))
      const chunks = Array.from({ length: 20 }, () => 1 + next() % 7)
      expect(play(bytes, chunks), `sequence ${String(sequence)}`).toEqual(reference(bytes))
    }
  })

  it('displays hostile controls as text in real xterm without damaging chrome or leaking color', async () => {
    const disposePalette = setPalette(DEFAULT_PALETTE, 4)
    const emulator = createEmulator(32, 12)
    try {
      const screen = new Screen(emulator.target)
      const readers = { stdout: new RetainedCollector(), stderr: new RetainedCollector() }
      const output = new ShellOutput(rows => { screen.commit(rows) })
      screen.setLive(['> composer', 'idle'])
      readers.stdout.push(Buffer.from('safe\x1b[2J\x1b]52;c;evil\x07\r\tend\n'))
      readers.stderr.push(Buffer.from('problem '.repeat(8)))
      output.poll(readers)
      screen.setLive([...output.live(32), '> composer', 'idle'])
      output.poll(readers, true)
      output.flush()
      screen.setLive(['> composer', 'idle'])
      const shown = (await emulator.scrollback()).filter(row => row !== '')
      expect(shown.slice(-2)).toEqual(['> composer', 'idle'])
      expect(shown.join('')).toContain('safe^[[2J^[]52;c;evil^G^M')
      expect(shown.join('')).toContain('[stderr] problem')
      expect(shown.filter(row => row.includes('safe'))).toHaveLength(1)
      const errorRow = shown.findIndex(row => row.startsWith('[stderr]'))
      expect(errorRow).toBeGreaterThanOrEqual(0)
      expect((await emulator.cell(0, errorRow))?.fg).toBe(1)
      expect((await emulator.cell(0, shown.length - 3))?.fg).toBe(1)
      expect((await emulator.cell(0, shown.length - 2))?.fg).toBeUndefined()
      expect(await emulator.cursor()).toEqual({ column: 4, row: shown.length - 1 })
    } finally {
      emulator.dispose()
      disposePalette()
    }
  })
})
