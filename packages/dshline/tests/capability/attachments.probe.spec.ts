/**
 * Capability probe: `ctx.attachments`, against the base orchestration.
 *
 * `image-drafts.spec.ts` and `image-attachment-flow.spec.ts` prove dshline's
 * drafting logic over hand-typed attachment stores. This probe subclasses the
 * real abstract `AttachmentStore` from `@deepseek-ai/dsh-attachment`, so its
 * concrete `saveImages()` base implementation validates a batch before calling
 * the local backend's `saveImage()` method. The local subclass supplies the
 * deployment limits, media-type policy, validation, and storage; those are not
 * attributed to the abstract base or to a production deployment.
 *
 * The assertions cover the base-owned ordered references, count/aggregate
 * admission, caller-correctable admission errors, and no writes after a failed
 * validation—the shapes the production `/image` path consumes.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import AttachmentStore, { AttachmentId, isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { describe, expect, it } from 'vitest'

/** Limits this probe publishes through its local backend; dshline reads the same shape. */
const LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1 << 20,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 2 << 20,
  maxImagePixels: 1 << 22,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg'],
}

/** Minimal in-memory store satisfying the real abstract contract. */
class MemoryAttachmentStore extends AttachmentStore {
  /** Members actually persisted, in commit order. */
  readonly stored: SaveImageAttachment[] = []
  readonly #limits: ImageAttachmentLimits

  constructor(ctx: Context, limits: ImageAttachmentLimits = LIMITS) {
    super(ctx)
    this.#limits = limits
  }

  override get imageLimits(): ImageAttachmentLimits {
    return this.#limits
  }

  override async validateImage(input: SaveImageAttachment): Promise<void> {
    if (!LIMITS.mediaTypes.includes(input.mediaType)) {
      throw Object.assign(new Error(`unsupported ${input.mediaType}`), { code: 'UNSUPPORTED_IMAGE_TYPE' })
    }
    if (input.data.byteLength > LIMITS.maxImageBytes) {
      throw Object.assign(new Error('single image too large'), { code: 'IMAGE_TOO_LARGE' })
    }
  }

  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.stored.push(input)
    return {
      attachmentId: AttachmentId(`probe-${this.stored.length}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    }
  }

  override async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    throw new Error(`capability probe: nothing to read back for ${String(ref.attachmentId)}`)
  }
}

/** One encoded input for the store.
 * @param mediaType - declared type.
 * @param name - optional display name.
 * @param bytes - encoded byte count for admission cases.
 * @returns the input. */
function input(mediaType: ImageMediaType, name?: string, bytes = 3): SaveImageAttachment {
  return { data: new Uint8Array(bytes), mediaType, ...name === undefined ? {} : { name } }
}

describe('capability: attachments', () => {
  it('publishes the limits the image drafting policy reads', async () => {
    const store = new MemoryAttachmentStore(new Context())
    expect(store.imageLimits.maxImagesPerMessage).toBe(2)
    expect(store.imageLimits.mediaTypes).toEqual(['image/png', 'image/jpeg'])
    expect(store.imageLimits.maxImageBytes).toBeGreaterThan(0)
    expect(store.imageLimits.maxMessageImageBytes).toBeGreaterThan(0)
  })

  it('commits an ordered batch and returns references in exact input order', async () => {
    const store = new MemoryAttachmentStore(new Context())
    const refs = await store.saveImages([input('image/png', 'first'), input('image/jpeg', 'second')])
    expect(refs.map(ref => [ref.mediaType, ref.name])).toEqual([
      ['image/png', 'first'],
      ['image/jpeg', 'second'],
    ])
    expect(store.stored).toHaveLength(2)
  })

  it('refuses a batch over the published count limit as a caller-correctable admission error', async () => {
    const store = new MemoryAttachmentStore(new Context())
    const error = await store.saveImages([
      input('image/png'), input('image/png'), input('image/png'),
    ]).then(() => undefined, (thrown: unknown) => thrown)
    expect(isImageAdmissionError(error)).toBe(true)
    expect((error as { code: string }).code).toBe('TOO_MANY_IMAGES')
    // Validation failures start no writes.
    expect(store.stored).toHaveLength(0)
  })

  it('refuses a batch over the aggregate byte limit before local storage', async () => {
    const store = new MemoryAttachmentStore(new Context(), {
      ...LIMITS,
      maxImagesPerMessage: 3,
      maxMessageImageBytes: 5,
    })
    const error = await store.saveImages([input('image/png', undefined, 3), input('image/png', undefined, 3)])
      .then(() => undefined, (thrown: unknown) => thrown)
    expect(isImageAdmissionError(error)).toBe(true)
    expect((error as { code: string }).code).toBe('IMAGES_TOO_LARGE')
    expect(store.stored).toHaveLength(0)
  })

  it('refuses a type the local backend does not admit, storing nothing', async () => {
    const store = new MemoryAttachmentStore(new Context())
    const error = await store.saveImages([input('image/gif')])
      .then(() => undefined, (thrown: unknown) => thrown)
    expect(isImageAdmissionError(error)).toBe(true)
    expect((error as { code: string }).code).toBe('UNSUPPORTED_IMAGE_TYPE')
    expect(store.stored).toHaveLength(0)
  })
})
