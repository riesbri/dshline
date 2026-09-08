/**
 * Capability probe: the command attachment contract, against the real runtime.
 *
 * `image-attachment-flow.spec.ts` proves dshline's half — it declines before
 * dispatch when a command does not admit attachments, and it submits image
 * drafts as discriminated members — but it does so over a doubled `commands`
 * service, so it cannot prove that Harness accepts that shape. This probe
 * mounts the REAL `CommandRuntime` from `@deepseek-ai/dsh-commands` over a
 * local `AttachmentStore` subclass, so `execute()`'s own admission runs: the
 * declaration it reads, the submission members it decodes, and the durable
 * blocks it hands a handler.
 *
 * That is the half of the contract this Harness generation changed.
 * `CommandInputDescriptor.attachments` replaced an image-specific flag, and
 * `CommandSubmitAttachment` became a discriminated union whose image member
 * carries `type: 'image'`. Both are silent failures if upstream moves them
 * again: dshline would submit a shape the runtime quietly refuses, and the only
 * visible symptom would be a command that stopped seeing its images. This file
 * fails by capability name instead.
 *
 * The store is local, so deployment limits, validation, and storage policy are
 * this probe's own and are not attributed to a production attachment backend.
 * What is real is the runtime's admission, ordering, and refusal.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandSubmitAttachment } from '@deepseek-ai/dsh-commands'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeCommandImages } from '../../src/image-drafts.ts'

/** Limits this probe publishes through its local backend. */
const LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1 << 20,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 2 << 20,
  maxImagePixels: 1 << 22,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg'],
}

/** Minimal in-memory store satisfying the real abstract contract. */
class MemoryAttachmentStore extends AttachmentStore {
  /** Members actually persisted, in commit order. */
  readonly stored: SaveImageAttachment[] = []

  override get imageLimits(): ImageAttachmentLimits {
    return LIMITS
  }

  override async validateImage(input: SaveImageAttachment): Promise<void> {
    if (!LIMITS.mediaTypes.includes(input.mediaType)) {
      throw Object.assign(new Error(`unsupported ${input.mediaType}`), { code: 'UNSUPPORTED_IMAGE_TYPE' })
    }
  }

  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.stored.push(input)
    return {
      attachmentId: AttachmentId(`probe-${String(this.stored.length)}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    }
  }
}

/** One registered command, recording exactly what the runtime admitted for it. */
interface Registered {
  readonly seen: CommandInvocation[]
}

/** Contexts to unwind after each case, so no harness outlives its assertions. */
const mounted: Context[] = []

afterEach(async () => {
  for (const ctx of mounted.splice(0)) await ctx.fiber.dispose()
})

/**
 * Mount the real store, session store, and command runtime with two commands:
 * one that declares attachments and one that declares only a text hint.
 * @returns the context, an addressable agent, and each command's admissions.
 */
async function harness(): Promise<{
  readonly ctx: Context
  readonly agent: Agent
  readonly store: MemoryAttachmentStore
  readonly vision: Registered
  readonly ask: Registered
}> {
  const ctx = new Context()
  mounted.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  // Constructing the store registers it: `AttachmentStore` is a cordis Service,
  // so this IS the `ctx.get('attachments')` the runtime resolves.
  const store = new MemoryAttachmentStore(ctx)
  const vision: Registered = { seen: [] }
  const ask: Registered = { seen: [] }
  ctx.commands.register({
    name: 'vision',
    description: 'inspect an image',
    // The generic admission flag: not an image-specific one, and the only thing
    // that lets any attachment reach a handler.
    input: { hint: 'what to look for', attachments: true },
    handler: invocation => {
      vision.seen.push(invocation)
      return { kind: 'success', text: `saw ${String(invocation.attachments.length)}` }
    },
  })
  ctx.commands.register({
    name: 'ask',
    description: 'ask something',
    // Free-form text WITHOUT attachments: the case the two flags distinguish.
    input: { hint: 'question' },
    handler: invocation => {
      ask.seen.push(invocation)
      return { kind: 'success', text: 'asked' }
    },
  })
  const session: Session = ctx.sessions.create(SessionId('command-attachment-probe'))
  const agent = { id: session.id, session, inject: vi.fn() } as unknown as Agent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
  return { ctx, agent, store, vision, ask }
}

/**
 * Encode drafted bytes into the exact submission dshline sends.
 *
 * Deliberately through the production helper plus the production envelope, so
 * this asserts the shape the attachment call site actually produces rather than
 * a shape hand-written to match the runtime.
 * @param images - bytes and metadata for each draft, in submission order.
 * @returns discriminated command submissions.
 */
function submissions(
  images: readonly { data: Uint8Array; mediaType: 'image/png' | 'image/jpeg'; name: string }[],
): readonly CommandSubmitAttachment[] {
  return encodeCommandImages(images).map(image => ({ type: 'image', ...image }))
}

describe('capability: command attachments', () => {
  it('admits a discriminated image submission for a command that declares input.attachments', async () => {
    const { ctx, agent, store, vision } = await harness()
    const execution = await ctx.commands.execute(
      agent,
      '/vision what is this',
      submissions([
        { data: Uint8Array.of(1, 2, 3), mediaType: 'image/png', name: 'first.png' },
        { data: Uint8Array.of(4, 5), mediaType: 'image/jpeg', name: 'second.jpg' },
      ]),
      new AbortController().signal,
    )
    expect(execution?.result).toEqual({ kind: 'success', text: 'saw 2' })
    // The runtime decoded the base64 members and durably admitted them IN
    // SUBMISSION ORDER, which is the ordering `/image` promises its reader.
    expect(store.stored.map(input => input.name)).toEqual(['first.png', 'second.jpg'])
    const admitted = vision.seen[0]?.attachments ?? []
    expect(admitted).toHaveLength(2)
    expect(admitted.map(block => block.type)).toEqual(['image', 'image'])
    expect((admitted[0] as ImageBlock).attachment).toMatchObject({
      attachmentId: 'probe-1', mediaType: 'image/png', name: 'first.png',
    })
  })

  it('refuses attachments for a command that declares only a text hint', async () => {
    // dshline declines this before dispatch so the drafts survive; the runtime
    // is the authority that makes declining correct rather than merely polite.
    const { ctx, agent, store, ask } = await harness()
    const execution = await ctx.commands.execute(
      agent,
      '/ask what is this',
      submissions([{ data: Uint8Array.of(1), mediaType: 'image/png', name: 'one.png' }]),
      new AbortController().signal,
    )
    expect(execution?.result.kind).toBe('error')
    expect(execution?.result.text).toContain('does not accept attachments')
    // Nothing was stored and the handler never ran: a refusal is not a partial
    // admission, which is what lets the composer keep the originals.
    expect(store.stored).toEqual([])
    expect(ask.seen).toEqual([])
  })

  it('runs an attachment-declaring command normally with no attachments at all', async () => {
    // The declaration admits attachments; it does not require them.
    const { ctx, agent, vision } = await harness()
    const execution = await ctx.commands.execute(
      agent, '/vision nothing staged', [], new AbortController().signal,
    )
    expect(execution?.result).toEqual({ kind: 'success', text: 'saw 0' })
    expect(vision.seen[0]?.attachments).toEqual([])
  })
})
