/**
 * The composer's DISPLAY projection: what a reader sees, and how every position
 * in it maps back to the authoritative buffer.
 *
 * A large paste stays in the buffer as the complete sanitized text, because that
 * text is the message — the submission, the history entry, the thing a
 * completion reads. What a reader does not need is to re-read four hundred lines
 * of a stack trace to find the sentence they are typing, so a big enough span
 * DRAWS as one compact token instead. Those are two different questions about one
 * buffer, so this file is where they are separated: the buffer stays whole, and
 * the projection carries the shortened reading of it.
 *
 * The split is STRUCTURAL, never textual. A fold is a record of a range over the
 * authoritative buffer, and the mapping between the two is built by walking the
 * buffer once and skipping the interiors. Nothing here ever recognizes the label
 * it produced: a user who types `[Pasted text #1 +11 lines]` by hand holds ordinary
 * text with no fold over it, because a fold is a range the composer recorded when
 * a paste arrived, never a string that was matched afterwards.
 * @module @dshline/renderer/composer-display
 */

/**
 * How many logical lines a paste must hold before it folds.
 *
 * Eight is the line at which a paste stops being something a reader reviews in
 * the composer and becomes something they scroll past: a traceback, a diff, a
 * pasted table. Below it the text stays visible, which is what keeps ordinary
 * multi-line pastes — a shell snippet, three bullet points, a short dictation —
 * reviewable in place, because a folded token would hide text a reader is
 * actively checking. It is fixed and tested rather than a setting: no request for
 * a different number has been earned yet, and a threshold nobody can move is one
 * fewer thing to get wrong.
 */
export const PASTE_FOLD_MIN_LINES = 8

/**
 * How many code points a paste must hold before it folds, independently of lines.
 *
 * A single-line paste has no line count to trip the other threshold, and a long
 * JSON blob, a minified asset, or one enormous `docker inspect` line is exactly
 * as unreadable in the composer as eleven short lines are. A thousand code
 * points is roughly a screenful or two of dense text, which is where the composer
 * stops being a place you can see what you are editing. It trades a little extra
 * folding of genuinely large one-liners against a composer that never scrolls a
 * single enormous line out of view.
 */
export const PASTE_FOLD_MIN_CHARS = 1000

/**
 * One folded span, as metadata over the authoritative buffer.
 *
 * Deliberately O(1): it holds the RAW RANGE the paste occupies and the numbers a
 * label needs, and never a second copy of the pasted body. The composer already
 * owns that text, and a copy here would double the memory a large paste costs and
 * create a second thing to fall out of step with the buffer it describes.
 */
export interface FoldedPaste {
  /** Monotonic per-composer identity, shown in the label and never parsed back. */
  readonly id: number
  /** First raw code point of the span, inclusive. */
  readonly start: number
  /** One past the last raw code point of the span. */
  readonly end: number
  /** Logical lines the span holds, counted after newline normalization. */
  readonly lines: number
}

/**
 * The composer's buffer as a reader sees it, plus the mapping back.
 *
 * Every offset in {@link ComposerDisplay.text} is a code-point offset, matching
 * the buffer's own unit, so the two are directly comparable and a row of laid-out
 * text is chunked by the same arithmetic either way.
 */
export interface ComposerDisplay {
  /**
   * The visible text: the buffer with each folded span replaced by its label.
   * This is what a layout draws and what cursor columns are measured in — it is
   * NOT what the composer holds, submits, or records.
   */
  readonly text: string
  /** The raw cursor, expressed as a code-point offset into {@link text}. */
  readonly cursor: number
  /** Code points in the authoritative buffer, which may exceed `text.length`. */
  readonly rawLength: number
  /**
   * The raw buffer offset a visible boundary sits at.
   *
   * The whole reason this is a projection rather than a string: a boundary inside
   * a label is not a character position at all, and answering it honestly means
   * returning a fold BOUNDARY — the span's start for its interior, its end for the
   * boundary just past it. An answer from inside a folded span would be a cursor
   * position with no character on screen to sit in, which is precisely the
   * invisible-cursor failure this mapping exists to make impossible.
   * @param offset - a code-point offset into {@link text}, clamped to it.
   * @returns the raw buffer offset for that boundary, never inside a folded span.
   */
  rawAt(offset: number): number
}

/**
 * The label one folded span draws as.
 *
 * Built entirely from generated numbers: the span's own id and the line count
 * measured from the sanitized text it covers. No character of the paste, and no
 * character of the terminal, reaches it — so a label is exactly as safe to draw
 * as text the renderer authored itself, whatever the paste contained.
 * @param id - the span's monotonic identity.
 * @param lines - logical lines the span holds.
 * @returns the placeholder text, brackets included.
 */
export function pastedTextLabel(id: number, lines: number): string {
  return `[Pasted text #${String(id)} +${String(lines)} ${lines === 1 ? 'line' : 'lines'}]`
}

/**
 * One contiguous run of the projection, either visible text or a folded span.
 *
 * Segments tile the visible text with no gaps, which is what lets {@link
 * ComposerDisplay.rawAt} answer with a single ordered walk instead of a search
 * over folds and a separate gap table that could disagree with them.
 */
interface DisplaySegment {
  /** Whether this run is a folded span rather than visible text. */
  readonly folded: boolean
  /** First raw code point covered. */
  readonly rawStart: number
  /** One past the last raw code point covered. */
  readonly rawEnd: number
  /** First code point of {@link ComposerDisplay.text} this run occupies. */
  readonly start: number
  /** One past the last, in {@link ComposerDisplay.text} coordinates. */
  readonly end: number
}

/**
 * Project a buffer and its folds into the text a reader sees.
 *
 * Folds are walked in order and the VISIBLE runs between them are copied
 * verbatim; a folded span contributes its label and nothing else. The interior of
 * a fold is never visited — that is the point of the projection, and the reason
 * an unchanged frame does not have to rebuild a hidden document to draw it. The
 * cost is proportional to what is on screen plus the number of folds, not to the
 * size of the buffer.
 * @param chars - the authoritative buffer, one entry per code point.
 * @param cursor - the raw cursor offset.
 * @param folds - folded spans, in ascending, non-overlapping order.
 * @returns the projection, with a mapping from every visible boundary to a raw offset.
 */
export function projectDisplay(chars: readonly string[], cursor: number, folds: readonly FoldedPaste[]): ComposerDisplay {
  const rawLength = chars.length
  if (folds.length === 0) {
    // Nothing is hidden, so the projection is the buffer and the mapping is the
    // identity. Kept as its own branch because it is the overwhelmingly common
    // one, and it must not pay for segment bookkeeping no fold needs.
    const text = chars.join('')
    return {
      text,
      cursor: Math.min(Math.max(cursor, 0), rawLength),
      rawLength,
      rawAt: (offset: number) => (offset <= 0 ? 0 : offset >= rawLength ? rawLength : offset),
    }
  }

  const segments: DisplaySegment[] = []
  const parts: string[] = []
  /** Visible code points emitted so far. */
  let displayLength = 0
  /** Last raw code point already covered, so runs never overlap. */
  let previous = 0
  for (const fold of folds) {
    // A fold is clamped into the buffer and into what earlier folds left over.
    // The composer keeps these well-formed; the clamp is here so a projection can
    // never index past the buffer even if a caller assembles a malformed range.
    const start = Math.max(previous, Math.min(fold.start, rawLength))
    const end = Math.max(start, Math.min(fold.end, rawLength))
    if (end <= start) continue
    if (start > previous) {
      segments.push({ folded: false, rawStart: previous, rawEnd: start, start: displayLength, end: displayLength + (start - previous) })
      parts.push(chars.slice(previous, start).join(''))
      displayLength += start - previous
    }
    const label = pastedTextLabel(fold.id, fold.lines)
    segments.push({ folded: true, rawStart: start, rawEnd: end, start: displayLength, end: displayLength + label.length })
    parts.push(label)
    displayLength += label.length
    previous = end
  }
  if (previous < rawLength) {
    segments.push({ folded: false, rawStart: previous, rawEnd: rawLength, start: displayLength, end: displayLength + (rawLength - previous) })
    parts.push(chars.slice(previous, rawLength).join(''))
    displayLength += rawLength - previous
  }

  // The cursor's visible offset. Segments tile the raw buffer contiguously, so
  // exactly one of them contains it, and a raw offset shared by two segments —
  // the end of a fold and the start of the text after it — resolves to the same
  // visible boundary either way. A raw offset INSIDE a folded span has no
  // character to stand in, so it resolves to that span's start: the composer
  // unfolds a span before letting the cursor reach one, so this is a guard
  // against a position that should not exist rather than a route into one.
  let visible = displayLength
  for (const segment of segments) {
    if (cursor < segment.rawStart || cursor > segment.rawEnd) continue
    visible = segment.folded
      ? cursor >= segment.rawEnd
        ? segment.end
        : segment.start
      : segment.start + (cursor - segment.rawStart)
    break
  }

  return {
    text: parts.join(''),
    cursor: visible,
    rawLength,
    rawAt: (offset: number): number => {
      if (offset <= 0) return 0
      for (const segment of segments) {
        if (offset < segment.start) break
        if (offset > segment.end) continue
        if (!segment.folded) return segment.rawStart + (offset - segment.start)
        // Past the label is the span's end; anywhere inside it is the span's
        // start. Both are boundaries a cursor can honestly occupy, and neither is
        // a character the reader cannot see.
        return offset >= segment.end ? segment.rawEnd : segment.rawStart
      }
      return rawLength
    },
  }
}
