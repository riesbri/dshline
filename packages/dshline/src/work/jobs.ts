/**
 * Ephemeral observation of ONE background Job's retained output.
 *
 * This is deliberately not a second Job runtime, a ring, or a history. The
 * registry owns the output ring and the byte coordinates; everything here is
 * presentation state that exists only while one Job's detail stage is open.
 *
 * The read is the one that does not move the model cursor:
 * `JobRegistry.readAt(id, from, caller)` rather than `read(id, caller)`. The
 * consuming `read` is how the MODEL collects a Job's output and may carry the
 * producer's terminal result; a terminal UI that called it would take bytes out
 * of the model's own mouth. This module therefore never names `read`, and the
 * capability probe fails the build if that member is ever reached.
 *
 * The race discipline is upstream's (`dsh-api-job-controller`'s observer):
 * SUBSCRIBE FIRST, then establish the anchor, then read. An observer that read
 * first and subscribed second loses every append landing in between, which is
 * exactly the window a noisy producer spends most of its time in.
 *
 * @module dshline/work/jobs
 */

import type { JobChannel, JobChunk, JobOutputRead, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * The registry's own Job-id type, read off the method that consumes it.
 *
 * `JobId` is a branded string whose constructor is a runtime VALUE in
 * `@deepseek-ai/dsh-jobs`, and that package is OPTIONAL: a profile without the
 * jobs capability must still boot this frontend. Deriving the type from
 * `JobRegistry['kill']` keeps the branding with no value import, and pins it to
 * the real registry contract instead of a second local declaration that could
 * drift from it.
 */
type RegistryJobId = Parameters<JobRegistry['kill']>[0]

/**
 * How many UTF-8 bytes of one Job's output the detail presentation retains.
 *
 * Bytes, not characters and not rows, and for the same reason the ring uses
 * them: eviction then cuts on a code-point boundary rather than guessing, and
 * the number stays comparable to the retention the Harness ring applies to the
 * same stream. The value is chosen against what a `/work` detail can ever draw.
 * A bounded live region is at most the terminal's rows, and Work frames cap
 * around 100 columns, so one frame shows well under 4 KiB of output; 32 KiB
 * holds roughly an order of magnitude more than any single view can display,
 * which keeps a long-running Job's detail useful while bounding memory
 * independently of how long the Job runs. It is a PRESENTATION cap, and being
 * smaller than a ring a fast producer can fill is the point: local eviction is
 * a normal, MARKED event here rather than a failure.
 */
export const JOB_OUTPUT_TAIL_BYTES = 32 * 1024

/**
 * One line of a Job's output as the presentation layer receives it.
 *
 * The channel is carried through rather than flattened, because deciding what
 * `stderr` MEANS is a presentation decision and flattening it here would take
 * that decision away. An unrecognized channel is treated exactly like an absent
 * one, as the seam's own contract requires.
 */
export interface JobOutputLine {
  /** The line's text, with its terminator removed. Empty on a gap marker. */
  readonly text: string
  /** The channel of the chunk that OPENED this line, when the producer labelled one. */
  readonly channel?: JobChannel
  /** Bytes immediately before this line are missing and were not retained. */
  readonly gapBefore?: true
}

/** The newest retained tail of one Job's output, in authoritative ring order. */
export interface JobOutputReading {
  /** Newest line last. Empty when the Job has produced nothing displayable. */
  readonly lines: readonly JobOutputLine[]
}

/** One open Job output observation, alive only while a Job detail is on screen. */
export interface JobOutputObservation {
  /**
   * The current bounded tail.
   *
   * This MATERIALIZES what event-driven reads already absorbed; it performs no
   * registry read of its own, so a repaint costs no `readAt` and the frame clock
   * can never become a poll.
   * @returns the retained lines, oldest first.
   */
  reading(): JobOutputReading
  /** Stop observing synchronously. Idempotent; late events reach nothing. */
  dispose(): void
}

/**
 * One retained chunk, its cached UTF-8 length, and the loss facts beside it.
 *
 * `at`, `text`, and `bytes` are mutable for exactly one reason: trimming a
 * single oversized chunk rewrites them in place, the way the ring's own tail cut
 * does. Every other mutation is add-at-the-end or shift-off-the-front.
 */
interface RetainedChunk {
  /** Absolute byte offset of the chunk's first byte in the Job's whole stream. */
  at: number
  /** The chunk's text exactly as the producer appended it. */
  text: string
  /** `Buffer.byteLength(text, 'utf8')`, cached because eviction reads it per chunk. */
  bytes: number
  /** Producer's stream label, when it supplied one. */
  readonly channel?: JobChannel
  /** Bytes before this chunk are missing — a producer gap, or local eviction. */
  readonly gapBefore?: true
}

/** What {@link observeJobOutput} needs in order to read one Job. */
export interface JobObservationOptions {
  /** The mounted registry. Never a stand-in that answers the consuming `read`. */
  readonly jobs: JobRegistry
  /** The exact Job being inspected. */
  readonly id: string
  /**
   * The attached session, passed to `get`/`readAt` as the fenced caller and
   * used as the subscription's owner filter. An UNOWNED Job still accepts it:
   * the seam's access contract is owner-relative, and an unowned Job is visible
   * to every caller.
   */
  readonly caller: SessionId
  /** Redraw the live region after a matching Harness event. */
  readonly invalidate: () => void
  /** Retention cap in UTF-8 bytes; defaults to {@link JOB_OUTPUT_TAIL_BYTES}. */
  readonly limitBytes?: number
}

/**
 * The text of `text` after its first `skip` UTF-8 bytes.
 *
 * The mirror image of the ring's own tail cut, and it exists for the same
 * reason: Harness coordinates output in UTF-8 BYTES while a JavaScript string is
 * indexed in UTF-16 code units. `readAt` may hand back a whole chunk that begins
 * BEFORE the requested offset (see {@link JobOutputObserver.absorb}), so trimming
 * has to happen in the byte domain — and the boundary must then walk forward
 * past any continuation byte, or the surviving text would start inside a code
 * point and decode to a replacement character.
 *
 * The Buffer round-trip is the one lossy step, and it runs only on the trim path,
 * where a chunk really did begin earlier than the cursor. A chunk read whole is
 * never re-encoded.
 * @param text - the chunk text as the ring returned it.
 * @param skip - whole-stream bytes already consumed; zero or less returns `text`.
 * @returns the chunk's text from byte `skip` onward.
 */
function skipUtf8Bytes(text: string, skip: number): string {
  if (skip <= 0) return text
  const raw = Buffer.from(text, 'utf8')
  if (skip >= raw.length) return ''
  let start = skip
  // The bound proves the index is in range; the assertion only discharges
  // noUncheckedIndexedAccess, exactly as the ring's own tail cut does.
  while (start < raw.length && ((raw[start] as number) & 0xC0) === 0x80) start += 1
  return raw.subarray(start).toString('utf8')
}

/**
 * The newest text of `text` no longer than `maxBytes`, starting on a code point.
 *
 * The local-eviction twin of {@link skipUtf8Bytes}: when one chunk alone exceeds
 * the whole presentation budget the cut is taken from the FRONT, and the
 * boundary again walks past continuation bytes.
 * @param text - the oversized chunk text.
 * @param maxBytes - positive byte budget for the surviving tail.
 * @returns the surviving text and its exact byte length.
 */
function newestWithinBytes(text: string, maxBytes: number): { text: string; bytes: number } {
  if (maxBytes <= 0) return { text: '', bytes: 0 }
  const raw = Buffer.from(text, 'utf8')
  if (raw.length <= maxBytes) return { text, bytes: raw.length }
  let start = raw.length - maxBytes
  while (start < raw.length && ((raw[start] as number) & 0xC0) === 0x80) start += 1
  const tail = raw.subarray(start)
  return { text: tail.toString('utf8'), bytes: tail.length }
}

/**
 * The one observation, for one Job, alive while its detail stage is open.
 *
 * It owns three things and nothing else: a subscription, an absolute byte
 * cursor, and a bounded list of retained chunks. It owns no lifecycle state — a
 * Job that settles is settled in the registry, and the stage that reads this
 * leaves with it rather than being kept alive to show a final output.
 */
class JobOutputObserver implements JobOutputObservation {
  /** Retained chunks in offset order, trimmed to the presentation budget. */
  private readonly chunks: RetainedChunk[] = []
  /** Sum of the retained chunks' byte lengths. */
  private retainedBytes = 0
  /** Absolute byte offset the next `readAt` resumes from. */
  private cursor = 0
  /**
   * A loss boundary that is known but not yet attached to any retained text.
   *
   * The seam makes no promise that a lossy read yields anything displayable: the
   * ring's own tail cut can reduce a chunk to zero bytes, and a zero-length
   * chunk still reports the loss through `gapBefore`. Representing loss only as a
   * property of a retained chunk therefore loses the loss exactly when there is
   * nothing left to represent it on — and an empty tail then reads as "no output
   * yet", which is the opposite of the truth.
   *
   * This flag is that missing representation. It survives reads until output
   * arrives to carry it, and it is never cleared by rendering, so the marker is
   * one fact about the stream rather than one per frame.
   */
  private unattachedGap = false
  /** True once {@link dispose} ran; a late event must reach nothing. */
  private disposed = false
  /** Unsubscribes from the registry. */
  private readonly unsubscribe: () => void

  constructor(private readonly options: JobObservationOptions) {
    // SUBSCRIBE FIRST. The anchor read below and this subscription are the two
    // halves of a race: an append landing between an initial read and a later
    // subscribe would sit in the ring with nobody awake to notice it, and the
    // detail would silently start one chunk late. Registering first means that
    // append instead arrives as an event this observer is already listening for.
    this.unsubscribe = options.jobs.events.subscribe({ owner: options.caller }, event => {
      // The seam's filter is OWNER-based, not Job-id-based, so this subscription
      // legitimately carries other Jobs this session can see. Filter by the
      // exact id before doing anything at all.
      const changed = event.type === 'output' ? event.id : event.job.id
      if (String(changed) !== options.id) return
      if (this.disposed) return
      this.pull()
      options.invalidate()
    })
    // The anchor, then the first read. `get` proves the Job is one this session
    // may read at all; `readAt` then starts from 0 rather than from
    // `output.earliest`, because anchoring at the retained head would present a
    // truncated stream as a complete one. It costs nothing — the ring only ever
    // returns retained bytes either way — and starting below the head is
    // exactly what makes `lossy` true, so the missing prefix can be MARKED
    // instead of being silently absent.
    try {
      options.jobs.get(options.id as RegistryJobId, options.caller)
      this.pull()
    } catch {
      // A Job that settled or vanished between its row being drawn and the
      // stage being opened has nothing to observe. The stage leaves on the next
      // build, so failing closed here is what stops a dead Job from being kept
      // reachable by its own observer.
      this.dispose()
    }
  }

  reading(): JobOutputReading {
    return { lines: this.lines() }
  }

  /**
   * Whether this observation failed closed — the Job was not observable.
   *
   * Distinguishes "opened and is reading" from "disposed before it ever read",
   * which are the same value to a caller that only wants a handle.
   * @returns true once the observer gave up or was released.
   */
  isDead(): boolean {
    return this.disposed
  }

  dispose(): void {
    if (this.disposed) return
    // Set BEFORE unsubscribing, so an event already in flight in this tick
    // reaches a disposed observer and stops there rather than invalidating a
    // live region that has already moved on.
    this.disposed = true
    this.unsubscribe()
    this.chunks.length = 0
    this.retainedBytes = 0
  }

  /**
   * Read the ring forward from the cursor and absorb what comes back.
   *
   * There is no poll and no timer here: this runs once at open and once per
   * matching Harness event. `readAt` is a synchronous in-memory read in the same
   * process, and the window's own `RedrawScheduler` already collapses a burst of
   * same-turn repaint requests into one frame, so the 100 ms coalescing window
   * upstream uses buys nothing here — upstream pays a network frame per read,
   * which is the only reason batching them is worth its latency there.
   */
  private pull(): void {
    if (this.disposed) return
    let read: JobOutputRead
    try {
      read = this.options.jobs.readAt(this.options.id as RegistryJobId, this.cursor, this.options.caller)
    } catch {
      // The Job settled, was removed, or belongs to another session. There is
      // nothing more to read and nothing to report; the next build drops the
      // stage, so swallowing the failure here cannot hide a live Job.
      this.dispose()
      return
    }
    if (read.lossy || read.chunks.length > 0) {
      this.absorb(read)
      this.cursor = read.next
    }
  }

  /**
   * Fold one read into the retained tail by ABSOLUTE byte range.
   *
   * A naïve `tail += chunk.text` duplicates content here, and not only in a rare
   * edge: the seam's own contract is that a read starting inside a retained
   * chunk returns that WHOLE chunk, so its `at` may be LESS than the requested
   * `from`. Every incremental read would then re-append the already-seen prefix
   * of its first chunk. The comparison is therefore in bytes, against each
   * chunk's own absolute `at` and its UTF-8 length — never in UTF-16 indices,
   * which would cut a CJK or astral code point in half.
   * @param read - one non-consuming `readAt` result.
   */
  private absorb(read: JobOutputRead): void {
    // `lossy` means the ring's retained window no longer reaches the cursor, so
    // the front of what we hold would be a lie unless it is marked. It rides on
    // the FIRST chunk kept rather than on every chunk, which is what keeps one
    // missing region from being reported once per chunk.
    //
    // It rides on the first chunk kept ONLY if there is one. Nothing in the
    // contract ties `lossy` to surviving text: the ring's own tail cut can leave a
    // zero-length chunk (a cap of one byte against a three-byte CJK code point
    // walks the boundary forward to the end of the string), and a chunk that
    // retains nothing can still carry a `gapBefore`. So the gap is its own state
    // and outlives the read that discovered it, rather than a property of a chunk
    // that may not exist. A loss with nothing to draw it on is still a loss.
    let gapPending = read.lossy || this.unattachedGap
    for (const chunk of read.chunks) {
      const gap = gapPending || chunk.gapBefore === true
      const text = unseenText(chunk, this.cursor)
      if (text === '') {
        // Nothing survives to carry the marker, so it waits for output that does.
        if (gap) gapPending = true
        continue
      }
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes === 0) {
        if (gap) gapPending = true
        continue
      }
      gapPending = false
      this.unattachedGap = false
      this.chunks.push({
        at: chunk.at + Buffer.byteLength(chunk.text, 'utf8') - bytes,
        text,
        bytes,
        ...chunk.channel === undefined ? {} : { channel: chunk.channel },
        ...gap ? { gapBefore: true as const } : {},
      })
      this.retainedBytes += bytes
    }
    this.unattachedGap = gapPending
    this.trim()
  }

  /**
   * Hold the tail at the presentation budget, newest output winning.
   *
   * Whole chunks drop from the front first, which is what keeps eviction from
   * splitting a code point. If a SINGLE oversized chunk still exceeds the
   * budget, its own UTF-8-safe tail is kept and its absolute `at` moves forward
   * to match — the ring's own rule, because the offsets compared here are the
   * ring's offsets. Either way the new front is MARKED, so local eviction reads
   * as honestly as a registry or producer loss instead of a silent splice.
   */
  private trim(): void {
    const cap = this.options.limitBytes ?? JOB_OUTPUT_TAIL_BYTES
    if (cap <= 0) {
      this.chunks.length = 0
      this.retainedBytes = 0
      return
    }
    let evicted = false
    while (this.retainedBytes > cap && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      /* v8 ignore next -- the length guard proves shift() returned a chunk; the check only satisfies noUncheckedIndexedAccess. */
      if (dropped === undefined) break
      this.retainedBytes -= dropped.bytes
      evicted = true
    }
    const single = this.chunks.length === 1 ? this.chunks[0] : undefined
    if (single !== undefined && single.bytes > cap) {
      const tail = newestWithinBytes(single.text, cap)
      single.at += single.bytes - tail.bytes
      single.text = tail.text
      single.bytes = tail.bytes
      this.retainedBytes = tail.bytes
      evicted = true
    }
    // Only eviction earns a marker. Marking an untouched front would invent a
    // loss on the first read of every Job, which is the opposite of honest.
    if (!evicted) return
    const front = this.chunks[0]
    if (front !== undefined && front.gapBefore !== true) {
      this.chunks[0] = { ...front, gapBefore: true }
    }
  }

  /**
   * The retained chunks as displayable lines.
   *
   * Line structure comes from the producer's own newlines in the ring's
   * authoritative order, and a line carries the channel of the chunk that
   * OPENED it: a line whose tail arrives on another stream is still read as the
   * stream it started on, which is the one a reader notices first. A chunk
   * carrying a gap marker FORCES a boundary even mid-line, because a loss
   * absorbed into the previous line is a loss nobody sees.
   *
   * The trailing empty line a final newline leaves open is dropped: it is the
   * producer saying the stream continues, not a blank row to draw.
   * @returns the retained lines, oldest first.
   */
  private lines(): JobOutputLine[] {
    const lines: JobOutputLine[] = []
    let open: { text: string; channel?: JobChannel } | undefined
    // A loss with no retained text to sit on is reported as its own leading
    // marker. Suppressed when the front of what IS retained already carries one,
    // because then the two describe the same missing stretch and one marker says
    // it better than two. Reading does not clear the flag: the next rendering
    // must say the same thing, and the flag itself is cleared only when output
    // arrives to carry it.
    if (this.unattachedGap && this.chunks[0]?.gapBefore !== true) {
      lines.push({ text: '', gapBefore: true })
    }
    for (const chunk of this.chunks) {
      if (chunk.gapBefore === true) {
        if (open !== undefined) lines.push(open)
        open = undefined
        // The marker itself carries no producer channel: it is this frontend
        // reporting missing bytes, and there is no stream to attribute that to.
        lines.push({ text: '', gapBefore: true })
      }
      const parts = chunk.text.split('\n')
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index] ?? ''
        if (index > 0) {
          if (open !== undefined) lines.push(open)
          open = undefined
        }
        const piece = part.endsWith('\r') ? part.slice(0, -1) : part
        if (open !== undefined) {
          open = { ...open, text: open.text + piece }
          continue
        }
        // A chunk that ENDS on a newline leaves no line open behind it: the
        // empty piece after that newline is the producer saying the stream
        // continues, not a blank row to draw. The next chunk opens the next line.
        // A genuinely blank line in the middle still survives, because its empty
        // piece is followed by more parts rather than terminating the split.
        if (piece === '' && index > 0 && index === parts.length - 1) continue
        open = {
          text: piece,
          ...chunk.channel === undefined ? {} : { channel: chunk.channel },
        }
      }
    }
    if (open !== undefined) lines.push(open)
    return lines
  }
}

/**
 * The part of one returned chunk that is genuinely new.
 *
 * A chunk that ends at or below the cursor is fully seen and contributes
 * nothing; a chunk that begins below the cursor and ends above it contributes
 * only its unseen tail, trimmed in BYTES so no code point is cut.
 * @param chunk - one chunk from a read.
 * @param cursor - the absolute byte offset already accumulated.
 * @returns the unseen text, empty when the chunk was fully seen.
 */
function unseenText(chunk: JobChunk, cursor: number): string {
  if (chunk.at + Buffer.byteLength(chunk.text, 'utf8') <= cursor) return ''
  return skipUtf8Bytes(chunk.text, Math.max(0, cursor - chunk.at))
}

/**
 * Observe one Job's retained output, non-consumingly, until disposed.
 *
 * Returns `undefined` when the Job could not be observed, which is the truthful
 * outcome for one that settled or vanished as the stage opened. The caller owns
 * the handle and must dispose it: that is the whole lifetime contract.
 * @param options - the registry, the exact Job, the fenced caller, and the redraw.
 * @returns an open observation, or undefined when the Job was not observable.
 */
export function observeJobOutput(options: JobObservationOptions): JobOutputObservation | undefined {
  const observer = new JobOutputObserver(options)
  return observer.isDead() ? undefined : observer
}
