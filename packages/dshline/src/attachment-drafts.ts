/**
 * Process-local attachment drafts and bounded filesystem reads.
 *
 * A draft deliberately retains a user-facing path, not bytes or an attachment
 * reference. The current session's filesystem resolves and reads it only when
 * the message is sent; the attachment store then validates and durably commits
 * the complete ordered batch before any content block enters the Agent inbox.
 *
 * ONE ordered ledger holds both kinds, because the order the reader staged in
 * is the order the message is built in. Two parallel lists would have to be
 * merged at send time, and every such merge is a place where "all the images,
 * then all the files" can quietly become the projection — which is not what
 * `/image a.png /attach trace.json /image b.png` asked for.
 * @module dshline/attachment-drafts
 */

import { basename, extname } from 'node:path'
import type { EncodedImageAttachment, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/** A raster image staged for the current session's next ordinary prompt. */
export interface ImageDraft {
  /** Which durable content block this draft becomes. */
  readonly kind: 'image'
  /** Path in the session filesystem's vocabulary; never persisted by dshline. */
  readonly path: string
  /** Declared type inferred from the explicit raster suffix and verified by Harness. */
  readonly mediaType: ImageMediaType
  /** Basename-only display metadata handed to the attachment store. */
  readonly name: string
}

/**
 * A verbatim file staged for the current session's next ordinary prompt.
 *
 * There is no media type because there is no type: Harness stores these bytes
 * exactly and decides what they mean, so a suffix this frontend recognized
 * would be a policy the adopted attachment contract explicitly declines to own
 * here — files carry no admission limits precisely because storage is streamed
 * and content is consumed lazily.
 */
export interface FileDraft {
  /** Which durable content block this draft becomes. */
  readonly kind: 'file'
  /** Path in the session filesystem's vocabulary; never persisted by dshline. */
  readonly path: string
  /** Basename-only display metadata handed to the attachment store. */
  readonly name: string
}

/** One staged attachment, in the order it will appear in the next message. */
export type AttachmentDraft = ImageDraft | FileDraft

/** Result of trying to add one local path to the current image draft. */
export type StageImageResult =
  | { readonly ok: true; readonly draft: ImageDraft }
  | { readonly ok: false; readonly reason: 'empty' | 'unsupported-type' | 'deployment-type' | 'too-many' | 'duplicate' }

/**
 * Result of trying to add one local path to the current file draft.
 *
 * Only `empty` and `duplicate` exist. The ordinary response to "you cannot
 * attach that" would be a size, an extension list, and a type check; none of
 * them is here, and adding one would mean this composer disagreeing with the
 * capability that actually owns the bytes.
 */
export type StageFileResult =
  | { readonly ok: true; readonly draft: FileDraft }
  | { readonly ok: false; readonly reason: 'empty' | 'duplicate' }

/** Authoritative deployment facts usable before bytes are read. */
export interface ImageDraftPolicy {
  /** Maximum images in one message. */
  readonly maxImages: number
  /** Raster types this attachment provider currently admits. */
  readonly mediaTypes: readonly ImageMediaType[]
}

/** Raster suffixes represented by Harness's version-one attachment contract. */
const IMAGE_TYPES: Readonly<Record<string, ImageMediaType>> = Object.freeze({
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
})

/**
 * Remove the optional mention sigil and one matching quote pair.
 *
 * The whole command remainder is one path, so spaces need no shell escaping.
 * Quotes are accepted only as outer presentation; backslashes remain path
 * characters because dshline must not invent a shell grammar over filesystem
 * names.
 * @param raw - text following `/image` or `/attach`.
 * @returns the path text, trimmed only at its outer boundary.
 */
export function stagedPath(raw: string): string {
  let value = raw.trim()
  if (value.startsWith('@')) value = value.slice(1)
  if (value.length >= 2) {
    const first = value[0]
    if ((first === '"' || first === "'") && value.at(-1) === first) value = value.slice(1, -1)
  }
  return value
}

/**
 * Infer the only image attachment kind Harness currently accepts.
 *
 * This is admission routing, not validation: the attachment store fully
 * decodes the bytes and rejects a false or mismatched suffix at send time.
 * @param path - path in the mounted filesystem's vocabulary.
 * @returns the declared raster media type, or undefined for a non-image suffix.
 */
export function imageMediaType(path: string): ImageMediaType | undefined {
  return IMAGE_TYPES[extname(path).toLocaleLowerCase('en-US')]
}

/** Session-scoped ordered collection of unsent attachment paths. */
export class AttachmentDrafts {
  private readonly entries: AttachmentDraft[] = []

  /** Current drafts in staging order, which is the next message's block order. */
  get items(): readonly AttachmentDraft[] {
    // A caller may retain this value across filesystem awaits. Giving it a
    // snapshot keeps a later local command from changing what that caller sees.
    return [...this.entries]
  }

  /** Only the image drafts, in staging order, for the `/image` list. */
  get images(): readonly ImageDraft[] {
    return this.entries.filter((entry): entry is ImageDraft => entry.kind === 'image')
  }

  /** Only the generic file drafts, in staging order, for the `/attach` list. */
  get files(): readonly FileDraft[] {
    return this.entries.filter((entry): entry is FileDraft => entry.kind === 'file')
  }

  /** Number of attachments waiting for the next ordinary prompt. */
  get size(): number {
    return this.entries.length
  }

  /**
   * Stage one image path without reading it or creating durable attachment objects.
   * @param raw - full command argument, optionally beginning with `@`.
   * @param policy - deployment count and media-type limits, when known.
   * @returns the accepted draft or a stable refusal reason.
   */
  stageImage(raw: string, policy?: ImageDraftPolicy): StageImageResult {
    const path = stagedPath(raw)
    if (path === '') return { ok: false, reason: 'empty' }
    const mediaType = imageMediaType(path)
    if (mediaType === undefined) return { ok: false, reason: 'unsupported-type' }
    if (policy !== undefined && !policy.mediaTypes.includes(mediaType)) {
      return { ok: false, reason: 'deployment-type' }
    }
    if (policy !== undefined && this.images.length >= policy.maxImages) {
      return { ok: false, reason: 'too-many' }
    }
    if (this.entries.some(entry => entry.kind === 'image' && entry.path === path)) {
      return { ok: false, reason: 'duplicate' }
    }
    const draft: ImageDraft = { kind: 'image', path, mediaType, name: basename(path) }
    this.entries.push(draft)
    return { ok: true, draft }
  }

  /**
   * Stage one verbatim file path.
   *
   * Deliberately reads nothing and checks nothing. The file may not exist yet,
   * may be a directory, may be unreadable, and may be replaced before the
   * message is sent; every one of those is a true statement the filesystem
   * answers at admission, when the reader has actually asked to send something.
   * Answering it here would be a second, staler authority than the one that has
   * to be right, and it would refuse paths the session's own filesystem can
   * reach and this terminal cannot name.
   * @param raw - full command argument, optionally beginning with `@`.
   * @returns the accepted draft or a stable refusal reason.
   */
  stageFile(raw: string): StageFileResult {
    const path = stagedPath(raw)
    if (path === '') return { ok: false, reason: 'empty' }
    if (this.entries.some(entry => entry.kind === 'file' && entry.path === path)) {
      return { ok: false, reason: 'duplicate' }
    }
    const draft: FileDraft = { kind: 'file', path, name: basename(path) }
    this.entries.push(draft)
    return { ok: true, draft }
  }

  /** Remove every unsent draft, leaving no durable object behind. */
  clear(): void {
    this.entries.length = 0
  }

  /**
   * Remove the image drafts only.
   * @returns how many image drafts were removed, for the acknowledgement.
   */
  clearImages(): number {
    return this.#removeKind('image')
  }

  /**
   * Remove the generic file drafts only.
   * @returns how many file drafts were removed, for the acknowledgement.
   */
  clearFiles(): number {
    return this.#removeKind('file')
  }

  /**
   * Remove one image draft by its one-based position in the `/image` list.
   * @param position - number shown by `/image`.
   * @returns the removed draft, or undefined when the position does not exist.
   */
  removeImage(position: number): ImageDraft | undefined {
    return this.#removeAt(this.images, position)
  }

  /**
   * Remove one generic file draft by its one-based position in the `/attach` list.
   * @param position - number shown by `/attach`.
   * @returns the removed draft, or undefined when the position does not exist.
   */
  removeFile(position: number): FileDraft | undefined {
    return this.#removeAt(this.files, position)
  }

  /**
   * Remove exactly the drafts one submission admitted, and nothing else.
   *
   * Identity-based rather than "clear whatever is staged now": a submission
   * owns only what was present when its admission began, and the ledger can
   * change while an unrelated command is in flight. Consuming by identity is
   * what keeps a draft the reader stages mid-submission out of an earlier
   * one's success.
   *
   * The pair `(kind, path)` is that identity: each kind refuses a duplicate
   * path within itself, so the pair is unique, while the SAME path may
   * legitimately be staged once as an image and once as a file. Keying on the
   * path alone would let one of them consume the other.
   * @param admitted - the snapshot one submission actually received.
   */
  consume(admitted: readonly AttachmentDraft[]): void {
    const owned = new Set(admitted.map(draft => `${draft.kind}:${draft.path}`))
    const kept = this.entries.filter(entry => !owned.has(`${entry.kind}:${entry.path}`))
    this.entries.length = 0
    this.entries.push(...kept)
  }

  /**
   * Drop every draft of one kind, leaving the other kind's order untouched.
   * @param kind - which kind to forget.
   * @returns how many drafts were removed.
   */
  #removeKind(kind: AttachmentDraft['kind']): number {
    const removed = this.entries.filter(entry => entry.kind === kind)
    if (removed.length === 0) return 0
    const kept = this.entries.filter(entry => entry.kind !== kind)
    this.entries.length = 0
    this.entries.push(...kept)
    return removed.length
  }

  /**
   * Remove the entry a one-based per-kind position names.
   * @param selection - the per-kind list the number was chosen from.
   * @param position - number shown by the listing command.
   * @returns the removed draft, or undefined when the position does not exist.
   */
  #removeAt<T extends AttachmentDraft>(selection: readonly T[], position: number): T | undefined {
    if (!Number.isSafeInteger(position) || position < 1 || position > selection.length) return undefined
    const target = selection[position - 1]
    if (target === undefined) return undefined
    // Removed by identity rather than by index arithmetic: the per-kind list is
    // a filtered view, so the number the reader chose is an index into THAT,
    // and the ledger's own index is somewhere else entirely.
    const at = this.entries.indexOf(target)
    if (at < 0) return undefined
    this.entries.splice(at, 1)
    return target
  }
}

/** dshline's local guard for an in-memory batch exceeding its published limit. */
class ImageBatchTooLargeError extends Error {
  readonly code = 'IMAGE_BATCH_TOO_LARGE'

  constructor() {
    super('image batch exceeds this deployment\'s total limit')
  }
}

/**
 * Resolve and read draft paths through the current filesystem under a hard cap.
 * @param drafts - ordered process-local paths.
 * @param fs - current session's filesystem authority.
 * @param cwd - current session workspace for relative paths.
 * @param maxBytes - inclusive bound for each complete read.
 * @param maxTotalBytes - inclusive bound for the complete in-memory batch.
 * @param signal - optional cancellation shared by resolution and reads.
 * @returns raw, bounded inputs suitable for an authoritative Harness consumer.
 */
export async function readImageDrafts(
  drafts: readonly ImageDraft[],
  fs: FileSystem,
  cwd: string,
  maxBytes: number,
  maxTotalBytes = Number.POSITIVE_INFINITY,
  signal?: AbortSignal,
): Promise<readonly SaveImageAttachment[]> {
  signal?.throwIfAborted()
  const inputs: SaveImageAttachment[] = []
  let totalBytes = 0
  for (const draft of drafts) {
    const target = await fs.resolve(draft.path, { cwd, ...(signal === undefined ? {} : { signal }) })
    const data = await fs.readBytes(target, signal, maxBytes)
    if (totalBytes + data.byteLength > maxTotalBytes) {
      throw new ImageBatchTooLargeError()
    }
    inputs.push({ data, mediaType: draft.mediaType, name: draft.name })
    totalBytes += data.byteLength
  }
  return inputs
}

/**
 * Serialize bounded draft inputs for the command registry's composer envelope.
 *
 * Base64 exists only at this immediate call boundary; dshline never stores or
 * logs it. The registry decodes, validates, and durably admits the batch before
 * an attachment-authorized command handler runs.
 * @param inputs - bounded bytes read from the mounted filesystem.
 * @returns ordered transient command image envelopes.
 */
export function encodeCommandImages(inputs: readonly SaveImageAttachment[]): readonly EncodedImageAttachment[] {
  return inputs.map(input => ({
    mediaType: input.mediaType,
    data: Buffer.from(input.data).toString('base64'),
    ...(input.name === undefined ? {} : { name: input.name }),
  }))
}
