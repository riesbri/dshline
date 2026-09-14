import { describe, expect, it, vi } from 'vitest'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { ImageDrafts, imageMediaType, imagePath, readImageDrafts } from '../src/image-drafts.ts'

describe('image draft paths', () => {
  it('keeps the command remainder as one path and accepts the completion sigil', () => {
    expect(imagePath(' @screens/界 面.png ')).toBe('screens/界 面.png')
    expect(imagePath(' "screens/a b.png" ')).toBe('screens/a b.png')
    expect(imagePath(" 'screens/a b.png' ")).toBe('screens/a b.png')
  })

  it('does not interpret backslashes or unmatched quotes as shell syntax', () => {
    expect(imagePath(String.raw`C:\shots\a.png`)).toBe(String.raw`C:\shots\a.png`)
    expect(imagePath('"unfinished.png')).toBe('"unfinished.png')
  })

  it('recognizes only Harness image media types, case-insensitively', () => {
    expect(imageMediaType('a.PNG')).toBe('image/png')
    expect(imageMediaType('a.jpeg')).toBe('image/jpeg')
    expect(imageMediaType('a.svg')).toBeUndefined()
    expect(imageMediaType('a.ts')).toBeUndefined()
  })
})

describe('session image drafts', () => {
  it('stages paths without reading them and rejects exact duplicates', () => {
    const drafts = new ImageDrafts()
    expect(drafts.stage('@画 面.webp')).toMatchObject({ ok: true, draft: { name: '画 面.webp' } })
    expect(drafts.stage('@画 面.webp')).toEqual({ ok: false, reason: 'duplicate' })
    expect(drafts.stage('notes.txt')).toEqual({ ok: false, reason: 'unsupported-type' })
    expect(drafts.size).toBe(1)
    drafts.clear()
    expect(drafts.items).toEqual([])
  })

  it('applies authoritative count and media-type limits before staging', () => {
    const drafts = new ImageDrafts()
    const policy = { maxImages: 1, mediaTypes: ['image/png'] as const }
    expect(drafts.stage('one.webp', policy)).toEqual({ ok: false, reason: 'deployment-type' })
    expect(drafts.stage('one.png', policy).ok).toBe(true)
    expect(drafts.stage('two.png', policy)).toEqual({ ok: false, reason: 'too-many' })
  })

  it('removes only a valid one-based position', () => {
    const drafts = new ImageDrafts()
    drafts.stage('one.png')
    drafts.stage('two.png')
    expect(drafts.remove(0)).toBeUndefined()
    expect(drafts.remove(2)?.name).toBe('two.png')
    expect(drafts.items.map(item => item.name)).toEqual(['one.png'])
  })

  it('consumes exactly the admitted batch and leaves later drafts alone', () => {
    const drafts = new ImageDrafts()
    drafts.stage('admitted.png')
    const admitted = drafts.items
    // A draft staged after the admission — the race the consume method exists
    // for — is not part of what the command received.
    drafts.stage('staged-later.png')
    drafts.consume(admitted)
    expect(drafts.items.map(item => item.name)).toEqual(['staged-later.png'])
  })

  it('is idempotent when the same admitted batch is consumed twice', () => {
    const drafts = new ImageDrafts()
    drafts.stage('one.png')
    const admitted = drafts.items
    drafts.consume(admitted)
    drafts.consume(admitted)
    expect(drafts.items).toEqual([])
  })
})

describe('image draft reads', () => {
  it('bounds filesystem reads, preserves order, and exposes only basenames to the attachment boundary', async () => {
    const drafts = new ImageDrafts()
    drafts.stage('/secret/folder/一.png')
    drafts.stage('two.jpg')
    const resolve = vi.fn(async (path: string) => ({ targetKey: path, displayPath: path }))
    const readBytes = vi.fn(async (target: { targetKey: string }) => Uint8Array.of(target.targetKey.length))
    const fs = { resolve, readBytes } as unknown as FileSystem
    const inputs = await readImageDrafts(drafts.items, fs, '/workspace', 123, 200)

    expect(resolve.mock.calls).toEqual([
      ['/secret/folder/一.png', { cwd: '/workspace' }],
      ['two.jpg', { cwd: '/workspace' }],
    ])
    expect(readBytes.mock.calls.map(call => [call[0].targetKey, call[2]])).toEqual([
      ['/secret/folder/一.png', 123],
      ['two.jpg', 123],
    ])
    expect(inputs.map(input => input.name)).toEqual(['一.png', 'two.jpg'])
  })

  it('propagates a bounded read failure', async () => {
    const drafts = new ImageDrafts()
    drafts.stage('gone.png')
    const refused = new Error('file disappeared')
    const fs = {
      resolve: async () => ({ targetKey: 'gone', displayPath: 'gone.png' }),
      readBytes: async () => { throw refused },
    } as unknown as FileSystem
    await expect(readImageDrafts(drafts.items, fs, '.', 1)).rejects.toBe(refused)
  })

  it('stops reading before an aggregate batch can exceed Harness\'s published limit', async () => {
    const drafts = new ImageDrafts()
    drafts.stage('one.png')
    drafts.stage('two.png')
    const readBytes = vi.fn(async () => Uint8Array.of(1, 2, 3))
    const fs = {
      resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
      readBytes,
    } as unknown as FileSystem

    await expect(readImageDrafts(drafts.items, fs, '.', 10, 5)).rejects.toMatchObject({ code: 'IMAGE_BATCH_TOO_LARGE' })
    expect(readBytes).toHaveBeenCalledTimes(2)
  })
})
