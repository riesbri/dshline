/**
 * The bounded per-file comparison inspector.
 *
 * One file, one surface, opened only by explicit disclosure from the
 * changed-file list. It asks Harness for that ONE file's comparison on the open
 * it was given and paints nothing until the answer settles, so a reader who
 * scrolls the list, opens a different turn, or walks back to the outline pays
 * for no comparison at all.
 *
 * The window is the shared {@link RowViewport} and the frame is the shared
 * {@link createBoundedSurface}: this file introduces no scrolling engine and no
 * alternate screen, and the terminal's own scrollback remains the transcript
 * underneath. Its key set is the same one the turn inspection surface already
 * offers. There is no `pgup`/`pgdn` because the renderer's `KeyName` has no such
 * key, and writing a second decoding table here would be the mistake rule 6 of
 * AGENTS.md exists to prevent.
 *
 * Every upstream string is untrusted. `display`, the hunk heading, and each diff
 * line are file CONTENT — a path or a line may carry an escape, a control
 * character, a combining mark, or ten thousand columns of text — and each passes
 * through `escapeControls` before it is measured and again before it is drawn. A
 * coarse comparison is Harness saying its own line comparison timed out and every
 * line is shown replaced; that fact is stated, because presenting the result as an
 * ordinary hunk would claim a precision the recorder did not have.
 * @module dshline/turns/diff-overlay
 */

import type { Key } from '@dshline/renderer'
import { escapeControls, paint, truncateToWidth, wrapToWidth } from '@dshline/renderer'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { createBoundedSurface } from '../surface.ts'
import type { ChangedFileRow } from './changes.ts'
import { fileDiffRows, type FileDiffReading, type FileDiffRequest } from './file-diff.ts'

/** Columns a file name is cut to inside a sentence quoting it. */
const LABEL_COLUMNS = 24

/** Inputs the comparison inspector needs from the presenter. */
export interface FileDiffOverlaySpec {
  /** The file this surface was opened on. */
  readonly file: ChangedFileRow
  /**
   * Ask Harness for this one file's comparison.
   *
   * Called ONCE per open, by the surface, before the first paint. `signal` is
   * aborted by {@link close}, so an inspector the reader has already left never
   * holds a git read open.
   * @param file - the disclosed file row.
   * @param signal - cancels the reads.
   * @returns the comparison, or undefined when Harness can serve none.
   * @throws whatever a live Session's read threw.
   */
  readonly request: FileDiffRequest
  /** Redraw after a read settles or a keystroke moved the window. */
  readonly invalidate: () => void
  /** Remove this temporary surface. */
  readonly close: () => void
}

/**
 * Create the bounded comparison surface.
 *
 * The read starts here rather than in the presenter so that closing the surface
 * and a late settlement arriving are the same code path: {@link close} aborts,
 * {@link publish} refuses anything that arrives after it, and a surface the
 * reader has left cannot repaint over the file list underneath it.
 * @param spec - the disclosed file, the read, and the surface controls.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createFileDiffOverlay(spec: FileDiffOverlaySpec): TuiOverlay {
  const viewport = new RowViewport()
  const abort = new AbortController()
  let reading: FileDiffReading = { kind: 'pending' }
  let closed = false

  /**
   * Absorb one settled comparison, if this surface still wants it.
   * @param settled - the reading the fold produced.
   */
  const publish = (settled: FileDiffReading): void => {
    if (closed) return
    reading = settled
    viewport.first()
    spec.invalidate()
  }
  void fileDiffRows(spec.file, spec.request, abort.signal).then(publish)

  return createBoundedSurface<FileDiffReading>({
    reading: () => reading,
    title: () => `Diff · ${spec.file.display}`,
    body: (current, width, capacity) => {
      const rows = diffRows(current, spec.file, width)
      // Re-clamped on EVERY paint, so a resize, a narrower window, and a shorter
      // document all leave the position inside the document rather than past its
      // end — a window that starts below `total` renders nothing at all.
      viewport.update(rows.length, Math.max(0, capacity))
      return rows.slice(viewport.start, viewport.end)
    },
    compact: () => `Diff ${spec.file.display}`,
    footer: () => '↑↓ scroll · home/end jump · esc back',
    onKey: (key: Key) => {
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          viewport.move(-1)
          break
        case 'down':
          viewport.move(1)
          break
        case 'home':
        case 'ctrl-a':
          viewport.first()
          break
        case 'end':
        case 'ctrl-e':
          viewport.last()
          break
        default:
          return
      }
      spec.invalidate()
    },
    close: () => {
      if (closed) return
      closed = true
      abort.abort()
      spec.close()
    },
  })
}

/**
 * The bounded body of one comparison.
 *
 * Long lines WRAP rather than being cut: a cut diff line is indistinguishable
 * from one that really ends there, and a reader reviewing a change is exactly the
 * reader for whom that ambiguity is expensive. The frame's own physical-row check
 * then bounds the result, which is why a `coarse` comparison of a large file
 * cannot overflow the live region.
 * @param reading - the current comparison state.
 * @param file - the disclosed file, for the states that name it.
 * @param width - display columns inside the frame.
 * @returns the body rows, before windowing.
 */
function diffRows(reading: FileDiffReading, file: ChangedFileRow, width: number): string[] {
  const inner = Math.max(1, width)
  switch (reading.kind) {
    case 'pending':
      return [muted('Reading this file’s comparison from Harness…', inner)]
    case 'cancelled':
      // Reachable only after the reader left: the surface's own guard drops a
      // settlement that arrives once it has closed, so this paints nothing and
      // exists to keep a cancellation from reading as a Harness failure.
      return []
    case 'failed':
      return [paint(truncateToWidth(escapeControls(reading.message), inner), 'error')]
    case 'unserved':
      return [
        muted('Changed-file comparison unavailable in this Host.', inner),
        '',
        muted('Harness announced this turn’s changes durably, but the summary it', inner),
        muted('recorded stays in the process that recorded it.', inner),
      ]
    case 'binary':
      return [
        muted(`Harness compared ${label(file)} as a binary file.`, inner),
        '',
        muted('Git or a NUL byte in a captured side marks it binary, and Harness', inner),
        muted('serves no lines for it.', inner),
      ]
    case 'oversized':
      return [
        muted(`Harness did not read ${label(file)}: a side exceeded its byte cap.`, inner),
        '',
        muted('The file is listed without line counts, and no comparison is served.', inner),
      ]
    case 'text': {
      if (reading.hunks.length === 0) {
        return [muted(`Harness compared ${label(file)} and found no differing lines.`, inner)]
      }
      const rows: string[] = []
      if (reading.coarse) {
        // Harness's own fact, not an inference: its line comparison exceeded
        // `diffTimeoutMs` and degraded to whole-file replacement.
        rows.push(paint(
          truncateToWidth(
            escapeControls('coarse comparison — Harness’s line diff timed out, so every line is shown replaced'),
            inner,
          ),
          'warning',
        ))
        rows.push('')
      }
      for (const hunk of reading.hunks) {
        rows.push(paint(truncateToWidth(escapeControls(hunk.heading), inner), 'section-heading'))
        for (const line of hunk.lines) rows.push(...diffLineRows(line, inner))
      }
      return rows
    }
  }
}

/**
 * One diff line, wrapped to the frame.
 *
 * Escaped BEFORE wrapping, so a line carrying a control sequence is measured as
 * the text it will actually occupy rather than as the bytes it arrived as — that
 * mismatch is how a width bug turns into a terminal injection. The line keeps
 * Harness's own prefix as its first column: re-indenting it would make a leading
 * `+` in the file's content ambiguous with a change.
 * @param line - the Harness line, already carrying its `+`, `-`, or space prefix.
 * @param width - display columns inside the frame.
 * @returns the wrapped rows for that line.
 */
function diffLineRows(line: string, width: number): string[] {
  const role = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : 'subdued'
  return wrapToWidth(escapeControls(line), Math.max(1, width)).map(row => paint(row, role))
}

/**
 * A file name quoted into a sentence, escaped and cut to fit.
 * @param file - the disclosed file row.
 * @returns a short, safe name fragment.
 */
function label(file: ChangedFileRow): string {
  return `“${truncateToWidth(escapeControls(file.display), LABEL_COLUMNS)}”`
}

/**
 * A truncated, escaped muted row.
 * @param text - fixed or untrusted message text.
 * @param width - display columns inside the frame.
 * @returns the finished row.
 */
function muted(text: string, width: number): string {
  return paint(truncateToWidth(escapeControls(text), Math.max(1, width)), 'muted')
}
