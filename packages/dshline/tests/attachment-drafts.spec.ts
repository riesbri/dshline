import { describe, expect, it, vi } from 'vitest'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { AttachmentDrafts, imageMediaType, readImageDrafts, stagedPath } from '../src/attachment-drafts.ts'

describe('staged attachment paths', () => {
  it('keeps the command remainder as one path and accepts the completion sigil', () => {
    expect(stagedPath(' @screens/界 面.png ')).toBe('screens/界 面.png')
    expect(stagedPath(' "screens/a b.png" ')).toBe('screens/a b.png')
    expect(stagedPath(" 'screens/a b.png' ")).toBe('screens/a b.png')
  })

  it('does not interpret backslashes or unmatched quotes as shell syntax', () => {
    expect(stagedPath(String.raw`C:\shots\a.png`)).toBe(String.raw`C:\shots\a.png`)
    expect(stagedPath('"unfinished.png')).toBe('"unfinished.png')
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
    const drafts = new AttachmentDrafts()
    expect(drafts.stageImage('@画 面.webp')).toMatchObject({ ok: true, draft: { name: '画 面.webp' } })
    expect(drafts.stageImage('@画 面.webp')).toEqual({ ok: false, reason: 'duplicate' })
    expect(drafts.stageImage('notes.txt')).toEqual({ ok: false, reason: 'unsupported-type' })
    expect(drafts.size).toBe(1)
    drafts.clear()
    expect(drafts.items).toEqual([])
  })

  it('applies authoritative count and media-type limits before staging', () => {
    const drafts = new AttachmentDrafts()
    const policy = { maxImages: 1, mediaTypes: ['image/png'] as const }
    expect(drafts.stageImage('one.webp', policy)).toEqual({ ok: false, reason: 'deployment-type' })
    expect(drafts.stageImage('one.png', policy).ok).toBe(true)
    expect(drafts.stageImage('two.png', policy)).toEqual({ ok: false, reason: 'too-many' })
  })

  it('removes only a valid one-based position', () => {
    const drafts = new AttachmentDrafts()
    drafts.stageImage('one.png')
    drafts.stageImage('two.png')
    expect(drafts.removeImage(0)).toBeUndefined()
    expect(drafts.removeImage(2)?.name).toBe('two.png')
    expect(drafts.items.map(item => item.name)).toEqual(['one.png'])
  })

  it('consumes exactly the admitted batch and leaves later drafts alone', () => {
    const drafts = new AttachmentDrafts()
    drafts.stageImage('admitted.png')
    const admitted = drafts.items
    // A draft staged after the admission — the race the consume method exists
    // for — is not part of what the command received.
    drafts.stageImage('staged-later.png')
    drafts.consume(admitted)
    expect(drafts.items.map(item => item.name)).toEqual(['staged-later.png'])
  })

  it('is idempotent when the same admitted batch is consumed twice', () => {
    const drafts = new AttachmentDrafts()
    drafts.stageImage('one.png')
    const admitted = drafts.items
    drafts.consume(admitted)
    drafts.consume(admitted)
    expect(drafts.items).toEqual([])
  })
})

describe('session file drafts', () => {
  it('stages any path without reading it or judging it', () => {
    // The four cases the adopted contract declines to pre-judge: a type this
    // frontend has no opinion about, a path that is not there, a directory, and
    // an absolute one. Staging is presentation-local metadata; admission is
    // where the filesystem gets to answer.
    const drafts = new AttachmentDrafts()
    expect(drafts.stageFile('report.pdf')).toMatchObject({ ok: true, draft: { name: 'report.pdf' } })
    expect(drafts.stageFile('trace.json')).toMatchObject({ ok: true, draft: { kind: 'file' } })
    expect(drafts.stageFile('/nowhere/at/all.bin')).toMatchObject({ ok: true })
    expect(drafts.stageFile('pictures')).toMatchObject({ ok: true })
    expect(drafts.size).toBe(4)
  })

  it('rejects an empty path and an exact duplicate, and nothing else', () => {
    const drafts = new AttachmentDrafts()
    expect(drafts.stageFile('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(drafts.stageFile('server.log').ok).toBe(true)
    expect(drafts.stageFile('server.log')).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('lets the same path be staged once as a file and once as an image', () => {
    // The extension does not decide the semantics, so `diagram.png` is a legal
    // generic file even though `/image` also accepts it. The two drafts are
    // separate, and each is listed, numbered, and removed by its own command.
    const drafts = new AttachmentDrafts()
    drafts.stageImage('diagram.png')
    drafts.stageFile('diagram.png')
    expect(drafts.size).toBe(2)
    expect(drafts.images.map(draft => draft.name)).toEqual(['diagram.png'])
    expect(drafts.files.map(draft => draft.name)).toEqual(['diagram.png'])
  })

  it('removes only a valid one-based position among files', () => {
    const drafts = new AttachmentDrafts()
    drafts.stageFile('one.log')
    drafts.stageFile('two.log')
    expect(drafts.removeFile(0)).toBeUndefined()
    expect(drafts.removeFile(3)).toBeUndefined()
    expect(drafts.removeFile(2)?.name).toBe('two.log')
    expect(drafts.files.map(draft => draft.name)).toEqual(['one.log'])
  })

  it('clears one kind without disturbing the other or the ledger order', () => {
    const drafts = new AttachmentDrafts()
    drafts.stageImage('a.png')
    drafts.stageFile('b.log')
    drafts.stageImage('c.png')
    drafts.stageFile('d.json')
    expect(drafts.clearImages()).toBe(2)
    expect(drafts.items.map(item => item.path)).toEqual(['b.log', 'd.json'])
    expect(drafts.clearFiles()).toBe(2)
    expect(drafts.items).toEqual([])
    expect(drafts.clearImages()).toBe(0)
  })

  it('consumes by kind and path, so one kind never swallows the other', () => {
    const drafts = new AttachmentDrafts()
    drafts.stageImage('same.png')
    drafts.stageFile('same.png')
    drafts.stageFile('other.log')
    // Consuming the image batch must leave the same path still staged as a FILE.
    drafts.consume(drafts.images)
    expect(drafts.items.map(item => `${item.kind}:${item.path}`)).toEqual(['file:same.png', 'file:other.log'])
  })
})

describe('one ordered ledger', () => {
  it('preserves the order both kinds were staged in, interleaved', () => {
    // The whole reason images and files share one list: grouping them would
    // produce `image a, image c, file b, file d` for this input, and that is
    // not the order the reader staged.
    const drafts = new AttachmentDrafts()
    drafts.stageImage('a.png')
    drafts.stageFile('b.log')
    drafts.stageImage('c.png')
    drafts.stageFile('d.json')
    expect(drafts.items.map(item => `${item.kind}:${item.name}`)).toEqual([
      'image:a.png',
      'file:b.log',
      'image:c.png',
      'file:d.json',
    ])
  })

  it('hands out a snapshot, so a later staging cannot change a retained batch', () => {
    const drafts = new AttachmentDrafts()
    drafts.stageFile('first.log')
    const retained = drafts.items
    drafts.stageFile('second.log')
    expect(retained.map(item => item.path)).toEqual(['first.log'])
    drafts.consume(retained)
    expect(drafts.files.map(item => item.path)).toEqual(['second.log'])
  })
})

describe('image draft reads', () => {
  it('bounds filesystem reads, preserves order, and exposes only basenames to the attachment boundary', async () => {
    const drafts = new AttachmentDrafts()
    drafts.stageImage('/secret/folder/一.png')
    drafts.stageImage('two.jpg')
    const resolve = vi.fn(async (path: string) => ({ targetKey: path, displayPath: path }))
    const readBytes = vi.fn(async (target: { targetKey: string }) => Uint8Array.of(target.targetKey.length))
    const fs = { resolve, readBytes } as unknown as FileSystem
    const inputs = await readImageDrafts(drafts.images, fs, '/workspace', 123, 200)

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
    const drafts = new AttachmentDrafts()
    drafts.stageImage('gone.png')
    const refused = new Error('file disappeared')
    const fs = {
      resolve: async () => ({ targetKey: 'gone', displayPath: 'gone.png' }),
      readBytes: async () => { throw refused },
    } as unknown as FileSystem
    await expect(readImageDrafts(drafts.images, fs, '.', 1)).rejects.toBe(refused)
  })

  it('stops reading before an aggregate batch can exceed Harness\'s published limit', async () => {
    const drafts = new AttachmentDrafts()
    drafts.stageImage('one.png')
    drafts.stageImage('two.png')
    const readBytes = vi.fn(async () => Uint8Array.of(1, 2, 3))
    const fs = {
      resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
      readBytes,
    } as unknown as FileSystem

    await expect(readImageDrafts(drafts.images, fs, '.', 10, 5)).rejects.toMatchObject({ code: 'IMAGE_BATCH_TOO_LARGE' })
    expect(readBytes).toHaveBeenCalledTimes(2)
  })
})
