/**
 * Generic file admission: bounded windows, exact bytes, and truthful refusals.
 *
 * These tests talk to hand-built doubles rather than a real filesystem, so what
 * they prove is dshline's own half of the contract: that it resolves through
 * `ctx.fs` with the session workspace, validates through `stat`, reads only
 * through the windowed `readByteRange`, hands the store an async iterable, and
 * compares `FsInfo.version` around the stream. The abstract-contract evidence
 * lives in `capability/fs.probe.spec.ts`; what a real backend does with the
 * chunks is not this frontend's to assert.
 */

import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, FileAttachmentRef, SaveFileStreamAttachment } from '@deepseek-ai/dsh-attachment'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { admitFileDraft, FILE_CHUNK_BYTES, fileAttachmentFailure, attachmentAuthoredMessage } from '../src/file-admission.ts'
import type { FileDraft } from '../src/attachment-drafts.ts'

/** A regular file of a given size, with recognisable content. */
function bytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251)
}

/** One stored file the fake backend can serve, mutate, or refuse. */
interface Entry {
  data: Uint8Array
  type: FsInfo['type']
  version: string
}

/** The knobs a case needs; everything else keeps the happy path. */
interface Options {
  readonly entries?: ReadonlyMap<string, Entry>
  readonly readFailure?: (key: string) => Error | undefined
  readonly onRead?: (key: string) => void
  readonly saveFailure?: Error | undefined
}

/** A store double that captures exactly what the streaming bridge yielded. */
class CapturingStore {
  /** Chunks pulled from the iterable, in order. */
  readonly chunks: Uint8Array[] = []
  /** The window sizes the bridge requested, in order. */
  readonly lengths: number[] = []
  /** Names handed to the durable boundary, in order. */
  readonly names: (string | undefined)[] = []
  /** Signals handed to the durable boundary, in order. */
  readonly signals: (AbortSignal | undefined)[] = []
  #failure: Error | undefined

  constructor(options: Options) {
    this.#failure = options.saveFailure
  }

  /**
   * @param input - dshline's stream request.
   * @returns a content-addressed stand-in reference.
   */
  async saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    this.names.push(input.name)
    this.signals.push(input.signal)
    if (this.#failure !== undefined) throw this.#failure
    for await (const chunk of input.data) {
      this.chunks.push(chunk)
      this.lengths.push(chunk.byteLength)
    }
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    return { attachmentId: AttachmentId(`sha256:${String(total)}`), name: input.name ?? 'unnamed', bytes: total }
  }

  /** The store as the abstract seam dshline calls. */
  asStore(): AttachmentStore {
    return this as unknown as AttachmentStore
  }

  /** The exact bytes the bridge produced. */
  stored(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.byteLength
    }
    return out
  }
}

/** A filesystem double serving the given entries. */
function backend(entries: ReadonlyMap<string, Entry>, options: Options = {}): {
  readonly fs: FileSystem
  readonly windows: { key: string; offset: number; length: number }[]
} {
  const windows: { key: string; offset: number; length: number }[] = []
  const fs = {
    resolve: async (path: string, opts?: { cwd?: string; signal?: AbortSignal }) => {
      opts?.signal?.throwIfAborted()
      const key = path.startsWith('/') ? path : `${opts?.cwd ?? ''}/${path}`
      return { targetKey: key, displayPath: key }
    },
    stat: async (target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> => {
      signal?.throwIfAborted()
      const entry = entries.get(target.displayPath)
      if (entry === undefined) return undefined
      return { version: FsVersion(entry.version), type: entry.type, size: entry.data.byteLength }
    },
    readByteRange: async (target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      windows.push({ key: target.displayPath, offset: range.offset, length: range.length })
      const failure = options.readFailure?.(target.displayPath)
      if (failure !== undefined) throw failure
      options.onRead?.(target.displayPath)
      // A file that shrank to nothing mid-stream reads as an empty window, which
      // is the contract's own end-of-file answer. The version check around the
      // stream is what notices the change, not a throw from here.
      const entry = entries.get(target.displayPath)
      if (entry === undefined) return new Uint8Array(0)
      return entry.data.slice(range.offset, range.offset + range.length)
    },
    // The whole-file read exists ONLY so a test can prove the streaming path
    // never reaches for it. A call is a failure, not a silent success.
    readBytes: (): never => { throw new Error('generic files must never be read whole') },
  } as unknown as FileSystem
  return { fs, windows }
}

/** One staged file. */
const DRAFT: FileDraft = { kind: 'file', path: 'logs/server.log', name: 'server.log' }

/** Entries for the common cases. */
function entries(overrides: Readonly<Record<string, Entry>> = {}): Map<string, Entry> {
  return new Map<string, Entry>([
    ['/ws/logs/server.log', { data: bytes(10), type: 'file', version: 'v1' }],
    ['/ws/empty.txt', { data: new Uint8Array(0), type: 'file', version: 'v1' }],
    ['/ws/dir', { data: new Uint8Array(0), type: 'directory', version: 'v1' }],
    ...Object.entries(overrides),
  ])
}

describe('resolve, stat, and the regular-file check', () => {
  it('resolves a relative draft against the session workspace', async () => {
    const { fs } = backend(entries())
    const store = new CapturingStore({})
    await admitFileDraft(DRAFT, fs, store.asStore(), '/ws', new AbortController().signal, 4)
    expect(store.names).toEqual(['server.log'])
  })

  it('reports an unreadable window as a READ failure, not the store\'s storage one', async () => {
    // The store pulls the iterable, so whatever a window raised reaches it and
    // comes back wearing its own vocabulary: a provider that wraps a source
    // error says "unable to persist" about a file it never managed to read.
    // Only this side knows which of the two actually happened.
    const denied = Object.assign(new Error('EACCES: permission denied, open \'/private/secret.log\''), { code: 'FS_PERMISSION_DENIED' })
    const { fs } = backend(entries(), { readFailure: () => denied })
    const store = new CapturingStore({
      saveFailure: undefined,
    })
    // A store that labels every source failure as its own storage failure,
    // exactly the behaviour this has to survive.
    const wrapping = {
      saveFileStream: async (input: { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name?: string }) => {
        try {
          for await (const chunk of input.data) store.chunks.push(chunk)
        } catch (error) {
          throw Object.assign(new Error('Unable to persist attachment.'), { code: 'ATTACHMENT_WRITE_FAILED', cause: error })
        }
        return { attachmentId: AttachmentId('sha256:0'), name: input.name ?? 'x', bytes: 0 }
      },
    } as unknown as AttachmentStore
    const rejection = await admitFileDraft(DRAFT, fs, wrapping, '/ws', new AbortController().signal, 4)
      .then(() => undefined, (error: unknown) => error)
    expect(rejection).toBe(denied)
    expect(fileAttachmentFailure(rejection)).toBe('file cannot be read by this profile')
  })

  it('keeps a genuine storage failure reported by the store itself', async () => {
    const failed = Object.assign(new Error('Unable to persist attachment.'), { code: 'ATTACHMENT_WRITE_FAILED' })
    const { fs } = backend(entries())
    const store = new CapturingStore({ saveFailure: failed })
    const rejection = await admitFileDraft(DRAFT, fs, store.asStore(), '/ws', new AbortController().signal, 4)
      .then(() => undefined, (error: unknown) => error)
    expect(rejection).toBe(failed)
    expect(attachmentAuthoredMessage(rejection)).toBe('Unable to persist attachment.')
  })

  it('refuses a path the filesystem does not have, with a stable code', async () => {
    const { fs } = backend(entries())
    const store = new CapturingStore({})
    await expect(admitFileDraft(
      { kind: 'file', path: 'logs/missing.log', name: 'missing.log' },
      fs, store.asStore(), '/ws', new AbortController().signal, 4,
    )).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    // Nothing durable for a path that was never there.
    expect(store.chunks).toEqual([])
  })

  it('refuses a directory rather than letting a backend word the failure', async () => {
    const { fs } = backend(entries())
    const store = new CapturingStore({})
    await expect(admitFileDraft(
      { kind: 'file', path: 'dir', name: 'dir' },
      fs, store.asStore(), '/ws', new AbortController().signal, 4,
    )).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    expect(store.chunks).toEqual([])
  })

  it('propagates a permission failure without opening a window', async () => {
    const denied = Object.assign(new Error('cannot read "/private/secret.log"'), { code: 'FS_PERMISSION_DENIED' })
    const { fs, windows } = backend(entries(), { readFailure: () => denied })
    const store = new CapturingStore({})
    const rejection = await admitFileDraft(DRAFT, fs, store.asStore(), '/ws', new AbortController().signal, 4)
      .then(() => undefined, (error: unknown) => error)
    expect(rejection).toBe(denied)
    // The store is still asked to stream: the refusal arrives through the
    // iterable, which is the only way a store can learn the source failed.
    expect(windows).toEqual([{ key: '/ws/logs/server.log', offset: 0, length: 4 }])
  })
})

describe('bounded streaming', () => {
  it('reads only through windowed reads, never a whole-file read', async () => {
    const { fs, windows } = backend(entries())
    const store = new CapturingStore({})
    await admitFileDraft(DRAFT, fs, store.asStore(), '/ws', new AbortController().signal, 4)
    expect(windows).toEqual([
      { key: '/ws/logs/server.log', offset: 0, length: 4 },
      { key: '/ws/logs/server.log', offset: 4, length: 4 },
      { key: '/ws/logs/server.log', offset: 8, length: 2 },
    ])
  })

  it('yields several chunks for a large fixture and bounds every one', async () => {
    const large = entries({ '/ws/big.bin': { data: bytes(200_000), type: 'file', version: 'v1' } })
    const { fs } = backend(large)
    const store = new CapturingStore({})
    const ref = await admitFileDraft(
      { kind: 'file', path: 'big.bin', name: 'big.bin' },
      fs, store.asStore(), '/ws', new AbortController().signal, 4096,
    )
    expect(store.lengths).toHaveLength(49)
    expect(Math.max(...store.lengths)).toBe(4096)
    expect(store.stored()).toEqual(bytes(200_000))
    expect(ref.bytes).toBe(200_000)
  })

  it('uses a fixed window by default, and that window is a memory bound not a cap', async () => {
    const large = entries({ '/ws/huge.log': { data: bytes(FILE_CHUNK_BYTES * 3 + 5), type: 'file', version: 'v1' } })
    const { fs } = backend(large)
    const store = new CapturingStore({})
    // Four times the default window: refused by nothing, streamed by the same
    // fixed window rather than buffered in one piece.
    const ref = await admitFileDraft(
      { kind: 'file', path: 'huge.log', name: 'huge.log' },
      fs, store.asStore(), '/ws', new AbortController().signal,
    )
    expect(store.lengths).toEqual([FILE_CHUNK_BYTES, FILE_CHUNK_BYTES, FILE_CHUNK_BYTES, 5])
    expect(ref.bytes).toBe(FILE_CHUNK_BYTES * 3 + 5)
  })

  it('commits a zero-byte file without reading a single window', async () => {
    const { fs, windows } = backend(entries())
    const store = new CapturingStore({})
    const ref = await admitFileDraft(
      { kind: 'file', path: 'empty.txt', name: 'empty.txt' },
      fs, store.asStore(), '/ws', new AbortController().signal, 4,
    )
    // An empty file is a real attachment, not a missing one: the store is still
    // called, it simply has no bytes to consume.
    expect(windows).toEqual([])
    expect(store.chunks).toEqual([])
    expect(ref.bytes).toBe(0)
  })

  it('stops reading once the signal aborts', async () => {
    const controller = new AbortController()
    const { fs, windows } = backend(entries({ '/ws/long.log': { data: bytes(4096), type: 'file', version: 'v1' } }), {
      // Abort while the second window is being served, the way ctrl-c does.
      onRead: key => { if (key === '/ws/long.log' && windows.length === 2) controller.abort() },
    })
    const store = new CapturingStore({})
    await expect(admitFileDraft(
      { kind: 'file', path: 'long.log', name: 'long.log' },
      fs, store.asStore(), '/ws', controller.signal, 1024,
    )).rejects.toThrow()
    // Two windows in, not four: no further reads are started after the abort.
    expect(windows).toHaveLength(2)
  })

  it('hands the store the reader signal and the display name, never a path', async () => {
    const { fs } = backend(entries())
    const store = new CapturingStore({})
    const signal = new AbortController().signal
    await admitFileDraft(DRAFT, fs, store.asStore(), '/ws', signal, 4)
    expect(store.signals).toEqual([signal])
    // The basename only. The durable reference's own display name is the
    // stored object's leaf name, and it is the one thing the transcript may
    // later print.
    expect(store.names).toEqual(['server.log'])
  })
})

describe('exact bytes', () => {
  const cases: readonly { readonly label: string; readonly data: Uint8Array }[] = [
    { label: 'UTF-8 text', data: new TextEncoder().encode('héllo · 世界\nsecond line\r\n') },
    { label: 'binary bytes including NUL', data: Uint8Array.of(0x00, 0xff, 0x00, 0x1b, 0x5b, 0x30, 0x6d, 0x00) },
    { label: 'a zero-byte file', data: new Uint8Array(0) },
    { label: 'a multi-chunk file', data: bytes(9_001) },
  ]

  for (const { label, data } of cases) {
    it(`stores ${label} byte for byte, with no decoding or normalization`, async () => {
      // A small window on the multi-chunk case forces many boundaries, which is
      // where a decoder or a normalizer would show itself.
      const name = `case-${data.byteLength}.bin`
      const { fs } = backend(entries({ [`/ws/${name}`]: { data, type: 'file', version: 'v1' } }))
      const store = new CapturingStore({})
      const ref = await admitFileDraft(
        { kind: 'file', path: name, name },
        fs, store.asStore(), '/ws', new AbortController().signal, 1024,
      )
      expect([...store.stored()]).toEqual([...data])
      expect(ref.bytes).toBe(data.byteLength)
    })
  }
})

describe('freshness across the stream', () => {
  it('refuses to return a reference when the version moved mid-stream', async () => {
    const store = new CapturingStore({})
    const live = entries()
    const { fs } = backend(live, {
      onRead: () => { live.set('/ws/logs/server.log', { data: bytes(10), type: 'file', version: 'v2' }) },
    })
    await expect(admitFileDraft(DRAFT, fs, store.asStore(), '/ws', new AbortController().signal, 4))
      .rejects.toMatchObject({ code: 'FILE_CHANGED_DURING_ATTACHMENT' })
    // The store did its work — an object may now exist and be unreachable, which
    // is the provider's retention to collect, not something to roll back.
    expect(store.chunks.length).toBeGreaterThan(0)
  })

  it('refuses when the file vanished mid-stream', async () => {
    const store = new CapturingStore({})
    const live = entries()
    const { fs } = backend(live, { onRead: () => { live.delete('/ws/logs/server.log') } })
    await expect(admitFileDraft(DRAFT, fs, store.asStore(), '/ws', new AbortController().signal, 4))
      .rejects.toMatchObject({ code: 'FILE_CHANGED_DURING_ATTACHMENT' })
  })

  it('accepts an unchanged version', async () => {
    const { fs } = backend(entries())
    const store = new CapturingStore({})
    await expect(admitFileDraft(DRAFT, fs, store.asStore(), '/ws', new AbortController().signal, 4)).resolves
      .toMatchObject({ name: 'server.log', bytes: 10 })
  })
})

describe('cancellation and store failures', () => {
  it('refuses before touching the filesystem when already cancelled', async () => {
    const { fs, windows } = backend(entries())
    const store = new CapturingStore({})
    const controller = new AbortController()
    controller.abort()
    await expect(admitFileDraft(DRAFT, fs, store.asStore(), '/ws', controller.signal, 4)).rejects.toThrow()
    expect(windows).toEqual([])
  })

  it('propagates an attachment store failure and says so specifically', async () => {
    const unsupported = Object.assign(
      new Error('The mounted attachment provider cannot stream verbatim files.'),
      { code: 'ATTACHMENT_FILES_UNSUPPORTED' },
    )
    const { fs } = backend(entries())
    const store = new CapturingStore({ saveFailure: unsupported })
    const rejection = await admitFileDraft(DRAFT, fs, store.asStore(), '/ws', new AbortController().signal, 4)
      .then(() => undefined, (error: unknown) => error)
    expect(rejection).toBe(unsupported)
    expect(fileAttachmentFailure(rejection)).toBe('this profile\'s attachment provider does not support generic files')
  })
})

describe('failure presentation', () => {
  it('names each condition from a stable code, never from message text', () => {
    const cases: readonly [readonly string | undefined, string | undefined][] = [
      ['FS_NOT_FOUND', 'file no longer exists'],
      ['FS_NOT_REGULAR_FILE', 'that path is not a regular file'],
      ['FILE_CHANGED_DURING_ATTACHMENT', 'the file changed while it was being attached'],
      ['FS_PERMISSION_DENIED', 'file cannot be read by this profile'],
      ['FS_SANDBOX_DENIED', 'file cannot be read by this profile'],
      ['FS_IO_ERROR', 'file could not be read'],
      ['FS_ABORTED', 'file read was aborted'],
      ['ATTACHMENT_FILES_UNSUPPORTED', 'this profile\'s attachment provider does not support generic files'],
    ]
    for (const [code, sentence] of cases) {
      expect(fileAttachmentFailure(Object.assign(new Error('x'), { code })), code).toBe(sentence)
    }
    // No code and no sentence: the caller must not print the failure's message.
    expect(fileAttachmentFailure(new Error('cannot read /private/secret.log'))).toBeUndefined()
  })

  it('shows an attachment-authored message only for the published attachment codes', () => {
    const authored = Object.assign(new Error('stored object could not be written'), { code: 'ATTACHMENT_WRITE_FAILED' })
    expect(attachmentAuthoredMessage(authored)).toBe('stored object could not be written')
    // A filesystem failure is never shown raw: its message may name a host path.
    const fsFailure = Object.assign(new Error('cannot read /private/secret.log'), { code: 'FS_IO_ERROR' })
    expect(attachmentAuthoredMessage(fsFailure)).toBeUndefined()
    expect(attachmentAuthoredMessage(new Error('plain failure'))).toBeUndefined()
  })
})
