/**
 * Capability probe: `ctx.fs`, against the abstract contract and dshline use.
 *
 * dshline reads exactly two operations off the active filesystem:
 * `resolve(path, { cwd, signal })` to turn a draft into a stable target, and
 * `readBytes(target, signal, maxBytes)` for the bounded read
 * `readImageDrafts` performs. `image-drafts.spec.ts` proves dshline's own
 * guard logic over hand-typed objects; this probe drives that same function
 * through the real abstract `FileSystem` base from `@deepseek-ai/dsh-fs`.
 * The in-memory subclass supplies resolution and byte bounding itself, so the
 * evidence is the abstract contract plus dshline passing the expected cwd,
 * signal, and bound—not a production filesystem implementation's policy.
 *
 * Everything else the abstract class declares is refused, which documents
 * that the drafting path consumes nothing more of the seam.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import FileSystem, { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditRequest, FsInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { describe, expect, it } from 'vitest'
import { readImageDrafts } from '../../src/image-drafts.ts'
import type { ImageDraft } from '../../src/image-drafts.ts'

/** One stored file, bytes keyed by display path. */
const FILES: ReadonlyMap<string, Uint8Array> = new Map([
  ['/ws/pictures/probe.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])],
])

/** Minimal in-memory backend satisfying the real abstract contract. */
class MemoryFileSystem extends FileSystem {
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

  override contains(): never {
    throw new Error('capability probe: the drafting path consumes no containment check')
  }

  override async stat(): Promise<FsInfo | undefined> {
    throw new Error('capability probe: the drafting path consumes no stat')
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

describe('capability: fs', () => {
  it('passes cwd and a read bound through the real FileSystem contract', async () => {
    const drafts: readonly ImageDraft[] = [
      { path: '/ws/pictures/probe.png', mediaType: 'image/png', name: 'probe.png' },
    ]
    const inputs = await readImageDrafts(drafts, new MemoryFileSystem(new Context()), '/ws', 1 << 20)
    expect(inputs).toEqual([
      { data: FILES.get('/ws/pictures/probe.png'), mediaType: 'image/png', name: 'probe.png' },
    ])
  })

  it('reads a relative draft against the session workspace', async () => {
    const drafts: readonly ImageDraft[] = [
      { path: 'pictures/probe.png', mediaType: 'image/png', name: 'probe.png' },
    ]
    const inputs = await readImageDrafts(drafts, new MemoryFileSystem(new Context()), '/ws', 1 << 20)
    expect(inputs).toHaveLength(1)
  })
})
