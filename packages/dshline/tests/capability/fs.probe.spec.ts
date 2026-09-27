/**
 * Capability probe: `ctx.fs`, against the abstract contract and dshline use.
 *
 * dshline reads three shapes off the active filesystem, and the third is this
 * generation's windowed `readByteRange` rather than a whole-file read:
 * `resolve(path, { cwd, signal })` to turn a draft into a stable target,
 * `readBytes(target, signal, maxBytes)` for the bounded IMAGE read
 * `readImageDrafts` performs, and — for a generic file — `stat(target, signal)`
 * followed by repeated `readByteRange(target, { offset, length }, signal)`.
 * `attachment-drafts.spec.ts` proves dshline's own guard logic over hand-typed
 * objects; this probe drives those same functions through the real abstract
 * `FileSystem` base from `@deepseek-ai/dsh-fs`. The in-memory subclass supplies
 * resolution, bounding, metadata, and windowing itself, so the evidence is the
 * abstract contract plus dshline passing the expected cwd, signal, window, and
 * version — not a production filesystem implementation's policy.
 *
 * Everything else the abstract class declares is refused, which documents that
 * the drafting path consumes nothing more of the seam.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentLimits, SaveFileStreamAttachment } from '@deepseek-ai/dsh-attachment'
import FileSystem, { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditRequest, FsInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { describe, expect, it } from 'vitest'
import { readImageDrafts } from '../../src/attachment-drafts.ts'
import type { FileDraft, ImageDraft } from '../../src/attachment-drafts.ts'
import { admitFileDraft } from '../../src/file-admission.ts'

/** One stored file, bytes keyed by display path. */
const FILES: Map<string, Uint8Array> = new Map([
  ['/ws/pictures/probe.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])],
  ['/ws/logs/probe.log', new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xff])],
  ['/ws/empty.dat', new Uint8Array(0)],
])

/** The abstract store's image members are unused here; only `saveFileStream` is. */
const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1 << 20,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 2 << 20,
  maxImagePixels: 1 << 22,
  maxImageDimension: 8192,
  mediaTypes: ['image/png'],
}

/**
 * A real `AttachmentStore` subclass that keeps only the streamed file path.
 *
 * It exists to receive `saveFileStream` under the abstract contract, so the
 * probe compiles against the exact adopted method and dshline's call is checked
 * against the real parameter shape. What it does with the chunks — retention,
 * digests, backpressure — is the probe's own and is not attributed to any
 * production backend.
 */
class StreamingStore extends AttachmentStore {
  /** Every chunk dshline yielded, in order. */
  readonly chunks: Uint8Array[] = []
  /** The display name dshline handed the durable boundary. */
  storedName: string | undefined

  override get imageLimits(): ImageAttachmentLimits {
    return IMAGE_LIMITS
  }

  override async validateImage(): Promise<void> {
    throw new Error('capability probe: the generic file path validates no image')
  }

  override async saveImage(): Promise<never> {
    throw new Error('capability probe: the generic file path saves no image')
  }

  override async readImage(): Promise<never> {
    throw new Error('capability probe: the generic file path reads no image')
  }

  /**
   * Collect the stream exactly as a provider would: pull each chunk, keep the
   * bytes, and publish a content-addressed stand-in reference.
   * @param input - dshline's stream request.
   * @returns the durable reference shape `admitFileDraft` must return.
   */
  override async saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    this.storedName = input.name
    for await (const chunk of input.data) this.chunks.push(chunk)
    const bytes = this.chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    return { attachmentId: 'probe-file' as FileAttachmentRef['attachmentId'], name: input.name ?? 'unnamed', bytes }
  }
}

/** Minimal in-memory backend satisfying the real abstract contract. */
class MemoryFileSystem extends FileSystem {
  /** Windows requested, in call order. */
  readonly ranges: { readonly offset: number; readonly length: number }[] = []
  /** How many times the stored bytes have been swapped. */
  #generation = 0

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const absolute = path.startsWith('/') ? path : `${opts?.cwd ?? ''}/${path}`
    return { targetKey: FsTargetKey(absolute), displayPath: absolute }
  }

  override processPath(target: FsTarget): string {
    return target.displayPath
  }

  override fileUrl(target: FsTarget): string {
    return `file://${target.displayPath}`
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    signal?.throwIfAborted()
    const data = FILES.get(target.displayPath)
    if (data === undefined) throw new Error(`capability probe: nothing stored at ${target.displayPath}`)
    if (data.byteLength > maxBytes) throw new Error('capability probe: read exceeded its bound')
    return data
  }

  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted()
    this.ranges.push(range)
    const data = FILES.get(target.displayPath)
    if (data === undefined) throw new Error(`capability probe: nothing stored at ${target.displayPath}`)
    // The contract's own EOF behaviour, which is what terminates the stream: a
    // short window when the file ends inside it, empty past the end, never
    // more than the window asked for.
    return data.slice(range.offset, range.offset + range.length)
  }

  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const data = FILES.get(target.displayPath)
    if (data === undefined) return undefined
    return {
      // A version that moves when the stored bytes do, which is the entire
      // reason dshline compares it around a stream.
      version: FsVersion(`${target.displayPath}#${String(this.#generation)}`),
      type: 'file',
      size: data.byteLength,
    }
  }

  /**
   * Swap the stored bytes, so a probe can prove the freshness check refuses.
   * @param path - display path to replace.
   * @param bytes - the replacement content.
   */
  mutate(path: string, bytes: Uint8Array): void {
    FILES.set(path, bytes)
    this.#generation += 1
  }

  override contains(): never {
    throw new Error('capability probe: the drafting path consumes no containment check')
  }

  override async lstat(): Promise<never> {
    throw new Error('capability probe: the drafting path consumes no lstat')
  }

  override async readText(): Promise<never> {
    throw new Error('capability probe: the drafting path consumes no text read')
  }

  override async streamText(): Promise<AsyncIterable<never>> {
    throw new Error('capability probe: the drafting path consumes no text stream')
  }

  override async listDir(): Promise<FsDirEntry[]> {
    throw new Error('capability probe: the drafting path consumes no listing')
  }

  override async writeText(_target: FsTarget, _content: string, _expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    throw new Error('capability probe: the drafting path never writes')
  }

  override async editText(_target: FsTarget, _edit: FsEditRequest): Promise<never> {
    throw new Error('capability probe: the drafting path never edits')
  }
}

/** One staged generic file, relative to the session workspace. */
const FILE: FileDraft = { kind: 'file', path: 'logs/probe.log', name: 'probe.log' }

/** A fresh backend and store, so no test inherits another's generation counter. */
function harness(): { readonly fs: MemoryFileSystem; readonly store: StreamingStore; readonly ctx: Context } {
  const ctx = new Context()
  return { fs: new MemoryFileSystem(ctx), store: new StreamingStore(ctx), ctx }
}

describe('capability: fs', () => {
  it('passes cwd and a read bound through the real FileSystem contract', async () => {
    const drafts: readonly ImageDraft[] = [
      { kind: 'image', path: '/ws/pictures/probe.png', mediaType: 'image/png', name: 'probe.png' },
    ]
    const inputs = await readImageDrafts(drafts, new MemoryFileSystem(new Context()), '/ws', 1 << 20)
    expect(inputs).toEqual([
      { data: FILES.get('/ws/pictures/probe.png'), mediaType: 'image/png', name: 'probe.png' },
    ])
  })

  it('reads a relative draft against the session workspace', async () => {
    const drafts: readonly ImageDraft[] = [
      { kind: 'image', path: 'pictures/probe.png', mediaType: 'image/png', name: 'probe.png' },
    ]
    const inputs = await readImageDrafts(drafts, new MemoryFileSystem(new Context()), '/ws', 1 << 20)
    expect(inputs).toHaveLength(1)
  })

  it('streams a generic file through windowed reads, never a whole-file read', async () => {
    // The adopted contract's own windowing: two windows, the second short,
    // and no `readBytes` anywhere — which is what proves the read is bounded by
    // the window this frontend chose rather than by the file.
    const { fs, store } = harness()
    const ref = await admitFileDraft(FILE, fs, store, '/ws', new AbortController().signal, 4)

    expect(fs.ranges).toEqual([
      { offset: 0, length: 4 },
      { offset: 4, length: 3 },
    ])
    expect(store.chunks.map(chunk => [...chunk])).toEqual([[0, 1, 2, 3], [4, 5, 255]])
    expect(store.storedName).toBe('probe.log')
    expect(ref.bytes).toBe(7)
  })

  it('commits a zero-byte file without reading a window at all', async () => {
    // An empty file is a real attachment, not a missing one: the store is still
    // called, it simply has no bytes to consume.
    const { fs, store } = harness()
    const ref = await admitFileDraft(
      { kind: 'file', path: '/ws/empty.dat', name: 'empty.dat' },
      fs, store, '/ws', new AbortController().signal, 4,
    )
    expect(store.chunks).toEqual([])
    expect(ref.bytes).toBe(0)
  })

  it('refuses a file whose version moved while it was streaming', async () => {
    // `readByteRange` carries no version precondition, so the only available
    // evidence that the bytes stored are the bytes that were there is comparing
    // `FsInfo.version` around the stream.
    const { fs, store } = harness()
    const original = fs.readByteRange.bind(fs)
    fs.readByteRange = async (...args: Parameters<MemoryFileSystem['readByteRange']>) => {
      fs.mutate('/ws/logs/probe.log', Uint8Array.of(9, 9, 9, 9, 9, 9, 9))
      return await original(...args)
    }
    await expect(admitFileDraft(FILE, fs, store, '/ws', new AbortController().signal, 4))
      .rejects.toMatchObject({ code: 'FILE_CHANGED_DURING_ATTACHMENT' })
  })
})
