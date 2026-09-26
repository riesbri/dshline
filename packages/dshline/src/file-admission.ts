/**
 * Verbatim file bytes: from the session filesystem, in bounded windows, to
 * Harness's durable attachment store.
 *
 * The whole point of this module is the shape of the read. A generic file has
 * no size policy and no type policy — the adopted attachment contract says so
 * explicitly, because its storage is streamed and its content is consumed
 * lazily — so the one thing this frontend still had to decide was how to get
 * bytes into that stream without itself becoming a second file store. It reads
 * fixed-size windows through `FileSystem.readByteRange` and hands the store an
 * async iterable, which keeps the peak memory this process holds for a file
 * at one window rather than at the file's size.
 *
 * Everything the bytes pass through on the way is Harness's: the bytes are read
 * only through `ctx.fs`, so a remote or sandboxed backend is the one that
 * decides what the path means, and they are durably committed only through
 * `ctx.attachments`. `node:fs` is deliberately absent — its `createReadStream`
 * would bypass the filesystem seam entirely and work only for a host-local
 * profile, which is exactly the deployment this feature must not be limited to.
 * @module dshline/file-admission
 */

import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileSystem, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { FileDraft } from './attachment-drafts.ts'

/**
 * Bytes requested per `readByteRange` window.
 *
 * A memory bound on THIS process, not a file-size policy: nothing is refused
 * for being larger, and the store still decides what it admits. 256 KiB is
 * chosen so a multi-megabyte log costs a few hundred windows rather than
 * hundreds of thousands, while the peak this process holds stays small next to
 * the provider's own staging buffer — a much larger window would buy nothing
 * once the copy inside `saveFileStream` is counted, and a much smaller one
 * turns a large upload into a round-trip storm against a remote filesystem.
 */
export const FILE_CHUNK_BYTES = 256 * 1024

/**
 * Refusals this module raises itself, in the vocabulary `FsError` already
 * established.
 *
 * They are a local class rather than `FsError` for the same reason the image
 * read path invents `IMAGE_BATCH_TOO_LARGE` rather than borrowing one: routing
 * reads `code`, and importing the filesystem package as a value would make a
 * profile that mounts no filesystem load it to read a draft. `FileSystem` is
 * still a type-only import here, so the module compiles to code that touches
 * only the two capability objects it is handed.
 */
export type FileDraftErrorCode = 'FS_NOT_FOUND' | 'FS_NOT_REGULAR_FILE' | 'FILE_CHANGED_DURING_ATTACHMENT'

/** One refusal raised by dshline's own file-admission path. */
export class FileDraftError extends Error {
  /**
   * @param code - the stable routing code, shared with `FsErrorCode` where one exists.
   * @param message - dshline's own description, never a provider or host path.
   */
  constructor(readonly code: FileDraftErrorCode, message: string) {
    super(message)
  }
}

/**
 * Read one staged file and durably commit it, byte for byte.
 *
 * The whole path is `resolve` → `stat` → streamed windows → `saveFileStream` →
 * `stat` again. The second `stat` is not optional bookkeeping:
 * `readByteRange` carries no version precondition, so nothing in the adopted
 * filesystem contract stops the file being rewritten between the first `stat`
 * and the last window. Comparing `FsInfo.version` around the stream is the only
 * evidence available that the bytes stored are the bytes that were there when
 * this submission started, and a mismatch is reported rather than sent — an
 * object may already have been published, and that is Harness's retention to
 * collect; there is no rollback to invent here.
 * @param draft - the staged path and its display name.
 * @param fs - the current session's filesystem authority.
 * @param attachments - the current session's durable attachment store.
 * @param cwd - the current session workspace, for relative paths.
 * @param signal - cancellation shared by resolution, reads, and the store.
 * @param chunkBytes - window size; {@link FILE_CHUNK_BYTES} is the default.
 * @returns the durable, content-addressed reference Harness recorded.
 * @throws FileDraftError when the path is absent, is not a regular file, or
 * changed while it was being attached.
 */
export async function admitFileDraft(
  draft: FileDraft,
  fs: FileSystem,
  attachments: AttachmentStore,
  cwd: string,
  signal: AbortSignal,
  chunkBytes: number = FILE_CHUNK_BYTES,
): Promise<FileAttachmentRef> {
  signal.throwIfAborted()
  const target = await fs.resolve(draft.path, { cwd, signal })
  const before = await regularFile(fs, target, signal)
  // The store pulls the iterable itself, so a failure inside a window arrives
  // as whatever the STORE chose to call it. A provider that wraps a source
  // error reports a storage failure — "unable to persist" — for a file it was
  // never able to read in the first place, and that is the sentence the reader
  // would be shown. This slot is the one fact only this side has: what the
  // window read actually raised.
  let readFailure: unknown
  let saved: FileAttachmentRef
  try {
    saved = await attachments.saveFileStream({
      data: byteWindows(fs, target, before.size, chunkBytes, signal, error => { readFailure = error }),
      signal,
      name: draft.name,
    })
  } catch (error: unknown) {
    throw readFailure ?? error
  }
  // A durable reference is in hand. Cancellation and the freshness check both
  // run before it can reach a message, because a reference the reader withdrew
  // — or one describing bytes that are no longer on disk — must not be logged.
  signal.throwIfAborted()
  const after = await fs.stat(target, signal)
  if (after?.version !== before.version) {
    throw new FileDraftError('FILE_CHANGED_DURING_ATTACHMENT', 'the file changed while it was being attached')
  }
  return saved
}

/**
 * Stat one target and insist it is a regular file.
 *
 * `stat` answers `undefined` for an absent target rather than raising, and a
 * directory is a perfectly good target for plenty of other operations, so
 * neither case can be left to the first window read: a directory's first read
 * would fail with a backend's own wording instead of the one stable refusal
 * this frontend can present without leaking a host path.
 * @param fs - the filesystem authority that resolved the target.
 * @param target - the resolved target to inspect.
 * @param signal - cancellation for the metadata round-trip.
 * @returns the target's metadata.
 * @throws FileDraftError when the target is absent or is not a regular file.
 */
async function regularFile(fs: FileSystem, target: FsTarget, signal: AbortSignal): Promise<FsInfo> {
  const info = await fs.stat(target, signal)
  if (info === undefined) {
    throw new FileDraftError('FS_NOT_FOUND', 'the staged path no longer exists')
  }
  if (info.type !== 'file') {
    throw new FileDraftError('FS_NOT_REGULAR_FILE', 'the staged path is not a regular file')
  }
  return info
}

/**
 * Yield one file's exact bytes as bounded windows, in order.
 *
 * Reading to the recorded size rather than to end-of-stream is what bounds the
 * read even if the file grows while it is being attached: the loop stops at the
 * size `stat` reported, and the freshness check in {@link admitFileDraft} then
 * refuses the result. That is a memory and round-trip bound, not a policy about
 * how large a file may be.
 *
 * A short window is the contract's own end-of-file signal, so it terminates the
 * iteration when the size is unknown, and a zero-length file simply yields
 * nothing: the store is still called, and the zero-byte object it commits is
 * the truthful record of an empty file rather than a missing one.
 * @param fs - the filesystem authority that resolved the target.
 * @param target - the resolved target to read.
 * @param size - byte length `stat` reported, when the backend can report it.
 * @param chunkBytes - window size, the ceiling on any one yielded chunk.
 * @param signal - cancellation checked before every window.
 * @param onReadFailure - told what a window read raised, so the caller can tell
 * a read fault from a storage fault after the store has relabelled it.
 * @returns the exact bytes, in order, never more than `chunkBytes` at a time.
 */
async function* byteWindows(
  fs: FileSystem,
  target: FsTarget,
  size: number | undefined,
  chunkBytes: number,
  signal: AbortSignal,
  onReadFailure: (error: unknown) => void,
): AsyncGenerator<Uint8Array> {
  const total = size ?? Number.POSITIVE_INFINITY
  for (let offset = 0; offset < total; offset += chunkBytes) {
    signal.throwIfAborted()
    const length = Math.min(chunkBytes, total - offset)
    let chunk: Uint8Array
    try {
      chunk = await fs.readByteRange(target, { offset, length }, signal)
    } catch (error: unknown) {
      onReadFailure(error)
      throw error
    }
    if (chunk.byteLength === 0) return
    yield chunk
    if (chunk.byteLength < length) return
  }
}

/**
 * The stable code a failure carries, or undefined when it carries none.
 *
 * Codes are read, never message text: both the filesystem and the attachment
 * capability publish a code vocabulary precisely so a frontend does not have to
 * guess a condition out of somebody's English.
 * @param error - any thrown value.
 * @returns the code string, when the value has one.
 */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Attachment failure codes whose own message is safe to show.
 *
 * The adopted attachment error class documents its message as carrying no raw
 * bytes and no host paths, so a failure it authored can be printed exactly as
 * written. That is how a storage fault has always been reported, and flattening
 * one into "could not be read" would throw away a diagnostic that names the
 * actual fault.
 *
 * The list is the package's published `AttachmentErrorCode` union, matched by
 * value rather than by importing its `isAttachmentError` helper: that helper
 * lives in a package which is a devDependency precisely because it does not
 * have to be mounted, and importing it for a value would make it one. A code
 * added upstream is therefore treated as a filesystem failure until this list
 * is updated, which is the safe direction to be wrong in — it renders one of
 * this module's own path-free sentences rather than printing an unknown string.
 */
const ATTACHMENT_CODES: ReadonlySet<string> = new Set([
  'TOO_MANY_IMAGES',
  'IMAGES_TOO_LARGE',
  'UNSUPPORTED_IMAGE_TYPE',
  'INVALID_IMAGE_BASE64',
  'INVALID_IMAGE',
  'IMAGE_TYPE_MISMATCH',
  'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_DIMENSION_TOO_LARGE',
  'INVALID_FILE_BASE64',
  'INVALID_ATTACHMENT_REF',
  'ATTACHMENT_CORRUPT',
  'ATTACHMENT_WRITE_FAILED',
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_READ_FAILED',
  'ATTACHMENT_PROJECTION_UNSUPPORTED',
  'ATTACHMENT_FILES_UNSUPPORTED',
])

/**
 * The failure's own message, when the attachment capability authored it.
 *
 * Kept separate from {@link fileAttachmentFailure} so the two vocabularies
 * cannot be confused for one another: a filesystem failure is never printed
 * raw, because an `FsError` message may spell an absolute user path, while an
 * attachment failure is printed as Harness wrote it.
 * @param error - an admission failure.
 * @returns the authored message, or undefined when the failure is not one of ours.
 */
export function attachmentAuthoredMessage(error: unknown): string | undefined {
  const code = codeOf(error)
  if (code === undefined || !ATTACHMENT_CODES.has(code)) return undefined
  return error instanceof Error ? error.message : String(error)
}

/**
 * Path-free presentation for a failure raised while admitting a staged file.
 *
 * `FsError` messages may spell an absolute user path, and a file is far more
 * likely than an image to be named by one, so every branch here is a sentence
 * about the condition rather than about the path.
 *
 * `ATTACHMENT_FILES_UNSUPPORTED` is the one that matters most, because it is
 * not really a failure: it is the adopted base class answering a backend that
 * was never written to store files, and a profile without verbatim file
 * storage must still start, stage, and prompt normally. Its sentence is
 * specific rather than the class's own wording because the class describes
 * itself, and what a reader needs to know is which profile they are in.
 *
 * `undefined` means "no sentence here", which sends the caller on to
 * {@link attachmentAuthoredMessage} for a Harness-authored storage diagnostic.
 * @param error - an admission failure.
 * @returns a path-free sentence, or undefined when the failure is not one of ours.
 */
export function fileAttachmentFailure(error: unknown): string | undefined {
  switch (codeOf(error)) {
    case 'FS_NOT_FOUND': return 'file no longer exists'
    case 'FS_NOT_REGULAR_FILE': return 'that path is not a regular file'
    case 'FILE_CHANGED_DURING_ATTACHMENT': return 'the file changed while it was being attached'
    case 'FS_PERMISSION_DENIED':
    case 'FS_SANDBOX_DENIED': return 'file cannot be read by this profile'
    case 'FS_IO_ERROR': return 'file could not be read'
    case 'FS_ABORTED': return 'file read was aborted'
    case 'ATTACHMENT_FILES_UNSUPPORTED': return 'this profile\'s attachment provider does not support generic files'
    default: return undefined
  }
}
