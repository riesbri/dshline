/**
 * Activity indication.
 *
 * Animation is the only part of the live region that changes without an event
 * to drive it, so every form here is a pure function of a tick counter the
 * caller owns. Owning the counter outside means the redraw timer can be started
 * and stopped with the work it reports, rather than running whenever the
 * process is alive.
 *
 * Two forms, for two jobs. The spinner is a MARK: one glyph in a column of
 * rows, saying which of several things is executing. The glint is a VOICE: it
 * lights the one word that says what a single subject is doing. Neither is
 * drawn beside the other — two motions on one line would say one thing twice.
 * @module @dshline/renderer/spinner
 */

import { paint } from './theme.ts'
import type { Role } from './theme.ts'
import { displayWidth, splitAtColumns } from './width.ts'

/**
 * Four quarter arcs, in clockwise order.
 *
 * The half circles `◠` and `◡` that used to sit between them are gone: they
 * draw twice the arc of their neighbours, so the mark visibly grew and shrank
 * and jumped between the top and the bottom of its cell instead of turning.
 */
const FRAMES = ['◜', '◝', '◞', '◟'] as const

/** Milliseconds between ticks; the caller's timer should match. */
export const SPINNER_INTERVAL_MS = 100

/**
 * Ticks in one revolution of the spinner: 600 ms, the energy the six-glyph
 * spinner had.
 *
 * Four frames do not divide six ticks, so the frames are held for 2, 1, 2 and
 * 1 ticks. That is not an approximation of the old rhythm but the old rhythm
 * itself: each quarter arc appears on exactly the tick it always did, and the
 * tick a half circle used to fill keeps the quarter before it on screen. One
 * tick per frame (400 ms) would be faster than anything this ever drew, and two
 * (800 ms) noticeably slower.
 */
const SPINNER_REVOLUTION_TICKS = 6

/**
 * The frame for one tick.
 * @param tick - a monotonically increasing counter; negative values are clamped.
 * @returns one spinner glyph.
 */
export function spinnerFrame(tick: number): string {
  const phase = Math.max(0, Math.trunc(tick)) % SPINNER_REVOLUTION_TICKS
  return FRAMES[Math.floor((phase * FRAMES.length) / SPINNER_REVOLUTION_TICKS)] ?? FRAMES[0]
}

/**
 * Ticks in one glint cycle — a pass and the rest after it. 2.4 s.
 *
 * Long enough that the line is mostly still, short enough that a reader who
 * glances at it rarely waits for proof that something is running. The cycle is
 * fixed rather than proportional to the text, and its phase comes from the
 * tick alone, so a word that changes mid-cycle neither restarts nor stutters.
 */
export const GLINT_PERIOD_TICKS = 24

/**
 * Columns the lit band covers: wide enough to read as light moving across a
 * word, narrow enough that the word underneath it stays legible.
 */
export const GLINT_BAND_COLUMNS = 3

/**
 * Ticks every cycle spends at rest, however long the text. A longer text is
 * crossed faster instead, so the pause that makes the motion calm cannot be
 * spent on travel.
 */
const GLINT_MIN_REST_TICKS = 8

/**
 * The columns the glint lights on one tick.
 *
 * The band enters wholly beyond the left edge and leaves wholly beyond the
 * right, moving left to right — the direction text is read in, and the only
 * one: reversing would read as scanning.
 * @param width - the text's width in display columns.
 * @param tick - a monotonically increasing counter; negative values are clamped.
 * @returns the lit column range, or undefined while the text rests.
 */
export function glintBand(width: number, tick: number): { readonly from: number; readonly to: number } | undefined {
  if (width <= 0) return undefined
  const phase = Math.max(0, Math.trunc(tick)) % GLINT_PERIOD_TICKS
  const steps = width + GLINT_BAND_COLUMNS
  const passTicks = Math.min(steps, GLINT_PERIOD_TICKS - GLINT_MIN_REST_TICKS)
  if (phase >= passTicks) return undefined
  const head = Math.floor(((phase + 1) * steps) / passTicks)
  const from = Math.max(0, head - GLINT_BAND_COLUMNS)
  const to = Math.min(width, head)
  return from < to ? { from, to } : undefined
}

/**
 * Paint short plain text in `base`, with the glint's band in `lit`.
 *
 * Only styling changes from frame to frame, never a character, so the result
 * measures the same on every tick and nothing fitted around it can move. The
 * band's edges are moved outward to whole characters by {@link splitAtColumns}.
 * Text that already carries styling is painted whole in `base` instead:
 * splitting someone else's escapes is how styling leaks.
 * @param text - frontend-authored or already escaped text, unstyled.
 * @param tick - a monotonically increasing counter.
 * @param base - the role the text is drawn in at rest.
 * @param lit - the role for the columns the band covers.
 * @returns the painted text; each span is closed by its own reset.
 */
export function paintGlint(text: string, tick: number, base: Role, lit: Role): string {
  if (text.includes('\u001b')) return paint(text, base)
  const band = glintBand(displayWidth(text), tick)
  if (band === undefined) return paint(text, base)
  const [before, inside, after] = splitAtColumns(text, band.from, band.to)
  return `${before === '' ? '' : paint(before, base)}${paint(inside, lit)}${after === '' ? '' : paint(after, base)}`
}

/**
 * A duration in the compact form a status line wants: seconds under a minute,
 * then minutes and seconds.
 * @param milliseconds - elapsed time; negative values read as zero.
 * @returns e.g. `4s`, `1m 04s`.
 */
export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (totalSeconds < 60) return `${String(totalSeconds)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`
}

/**
 * A token count in the compact form a status line wants.
 * @param tokens - a non-negative count.
 * @returns e.g. `840`, `12.3k`, `1.2M`.
 */
export function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.trunc(tokens))
  if (value < 1000) return String(value)
  if (value < 1_000_000) {
    const thousands = value / 1000
    return `${thousands < 10 ? thousands.toFixed(1) : String(Math.round(thousands))}k`
  }
  return `${(value / 1_000_000).toFixed(1)}M`
}
