/**
 * Presentation of one Harness workspace file comparison.
 *
 * Pure, and one-directional: it turns `WorkspaceFileDiff` into the rows a
 * terminal draws. It computes nothing about WHAT changed — there is no Git, no
 * file read, and no comparison of dshline's own — and it re-derives no hunk.
 * Harness already decided the hunks, the `binary` and `oversized` refusals, and
 * whether its line comparison degraded; this module's only job is to keep every
 * one of those distinctions visible instead of flattening them into a textual
 * diff that would be confidently wrong.
 * @module dshline/turns/file-diff
 */

import type { WorkspaceDiffHunk, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import type { ChangedFileRow } from './changes.ts'

/** One hunk heading plus its lines, ready to draw. */
export interface DiffHunkRows {
  /** The `@@ -a,b +c,d @@` heading, escaped and cut like any other text. */
  readonly heading: string
  /** Every body line, in Harness's order, each still carrying its own prefix. */
  readonly lines: readonly string[]
}

/** The disclosure-gated read of one file's comparison. */
export type FileDiffRequest = (
  file: ChangedFileRow,
  signal: AbortSignal,
) => Promise<WorkspaceFileDiff | undefined>

/** What the comparison inspector may truthfully show for one file. */
export type FileDiffReading =
  /** Harness has been asked and has not answered. */
  | { readonly kind: 'pending' }
  /**
   * The read was cancelled before it answered.
   *
   * Its own state, not a failure: an aborted subprocess read REJECTS rather than
   * resolving an empty comparison, and reporting that rejection as a Harness
   * error would put "reading the file failed" in front of a reader who simply
   * closed the surface and asked for it to stop. There is nothing to draw.
   */
  | { readonly kind: 'cancelled' }
  /** An announcement exists but this Host can no longer serve its comparison. */
  | { readonly kind: 'unserved' }
  /** The read threw while the Session was still live. */
  | { readonly kind: 'failed'; readonly message: string }
  /** Harness reports the file as binary and serves no lines. */
  | { readonly kind: 'binary' }
  /** A side exceeded the recorder's `maxFileBytes` and serves no lines. */
  | { readonly kind: 'oversized' }
  /** A text comparison, including the empty one and the coarse one. */
  | {
    readonly kind: 'text'
    /** Harness's hunks, in file order. */
    readonly hunks: readonly DiffHunkRows[]
    /** Whether the line comparison exceeded the recorder's `diffTimeoutMs`. */
    readonly coarse: boolean
  }

/**
 * Ask Harness for one file's comparison and fold the answer.
 *
 * The ONE place `WorkspaceFileDiff` is interpreted, so every refusal upstream can
 * express is a branch here rather than a branch in each surface. A read that
 * fails is reported as itself: Harness documents that a live Session's snapshot
 * read can throw, and inventing a "no changes" answer for that failure would
 * claim a comparison nobody performed.
 * @param file - the disclosed file row.
 * @param request - the disclosure-gated read.
 * @param signal - the SURFACE's cancellation, so closing it ends this read too.
 * @returns the reading for that file.
 */
export async function fileDiffRows(
  file: ChangedFileRow,
  request: FileDiffRequest,
  signal: AbortSignal,
): Promise<FileDiffReading> {
  let diff: WorkspaceFileDiff | undefined
  try {
    diff = await request(file, signal)
  } catch (error: unknown) {
    // Checked FIRST, because an aborted read is the caller's own decision and
    // not a Harness failure: the subprocess seam rejects an aborted spawn, and
    // `readSession`-backed cancellation is not an exception at all.
    if (signal.aborted) return { kind: 'cancelled' }
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
  if (diff === undefined) return { kind: 'unserved' }
  switch (diff.kind) {
    case 'binary':
      return { kind: 'binary' }
    case 'oversized':
      return { kind: 'oversized' }
    case 'text':
      return {
        kind: 'text',
        hunks: diff.hunks.map(hunkRows),
        coarse: diff.coarse,
      }
  }
}

/**
 * The heading and body of one Harness hunk.
 *
 * The heading is composed from Harness's own four counts rather than by
 * stringifying a patch: `structuredPatch` omits a count of one and upstream
 * states that a side without lines starts at 1 with zero lines, so the omitted
 * form is restored here instead of being left to a diff library's conventions.
 * @param hunk - one authoritative hunk.
 * @returns the rows that hunk contributes.
 */
function hunkRows(hunk: WorkspaceDiffHunk): DiffHunkRows {
  return {
    heading: `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
    lines: hunk.lines,
  }
}
