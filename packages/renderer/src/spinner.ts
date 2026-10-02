/**
 * Activity indication.
 *
 * Animation is the only part of the live region that changes without an event
 * to drive it, so every form here is a pure function of a tick counter the
 * caller owns. Owning the counter outside means the redraw timer can be started
 * and stopped with the work it reports, rather than running whenever the
 * process is alive.
 *
 * Two forms, for two different questions, and which one a line uses is the
 * caller's decision. The glint is a VOICE: it lights one word, answering
 * "running what" for a line whose neighbours may be running too, where a shared
 * turning arc would say the same thing on every row at once. An arc is a MARK:
 * it answers "is anything running" for a line that has no word of its own to
 * move. A line never carries both at once, because two motions on one line say
 * one thing twice.
 *
 * The arc comes in two widths, which is a question about the caller's room and
 * not about the animation: {@link spinnerFrame} is one cell for a gutter that
 * cannot spare two, {@link spinnerFrameOrbit} two for a list that can. Both turn
 * at the same 600 ms from the same phase, so the pair reads as one arc drawn
 * larger and not as two designs.
 * @module @dshline/renderer/spinner
 */

import { paint } from './theme.ts'
import type { Role } from './theme.ts'
import { displayWidth, splitAtColumns } from './width.ts'

/**
 * The compact one-cell mark: four quadrant arcs, in clockwise order.
 *
 * The half circles `\u25e0` and `\u25e1` are in {@link ORBIT_GLYPHS} instead:
 * Unicode calls these four `QUADRANT CIRCULAR ARC` — thin outlines — and the
 * other two `HALF CIRCLE`, which fonts draw as a FILLED half-disc. Alternating
 * a hairline with a solid swings the mark's weight twice per revolution, which
 * reads as growing and shrinking rather than as turning, so a one-cell mark
 * holds only arcs.
 */
const FRAMES = ['\u25dc', '\u25dd', '\u25de', '\u25df'] as const

/** Milliseconds between ticks; the caller's timer should match. */
export const SPINNER_INTERVAL_MS = 100

/**
 * Ticks in one revolution of the spinner: 600 ms.
 *
 * The two tables below map ticks to frames differently — the compact one holds
 * four frames for 2, 1, 2 and 1 ticks, the orbit one frame per tick — but both
 * take their length from this one number and the caller's one timer, so a
 * revolution of either is 600 ms and neither can drift from the other in speed.
 * The compact hold is inherited rather than chosen: four frames do not divide
 * six ticks, and 2, 1, 2, 1 is the rhythm dshline has always turned at.
 */
export const SPINNER_REVOLUTION_TICKS = 6

/**
 * The phase of a tick within the shared revolution.
 * @param tick - a monotonically increasing counter; negative values are clamped.
 * @returns a tick in `[0, SPINNER_REVOLUTION_TICKS)`.
 */
function revolutionPhase(tick: number): number {
  return Math.max(0, Math.trunc(tick)) % SPINNER_REVOLUTION_TICKS
}

/**
 * The compact one-cell mark, for a gutter that cannot spare two columns.
 * @param tick - a monotonically increasing counter; negative values are clamped.
 * @returns one quadrant-arc glyph, turning clockwise, one cell wide.
 */
export function spinnerFrame(tick: number): string {
  const phase = revolutionPhase(tick)
  return FRAMES[Math.floor((phase * FRAMES.length) / SPINNER_REVOLUTION_TICKS)] ?? FRAMES[0]
}

/**
 * The six shapes of the original arc, in the order they always turned in.
 *
 * Read clockwise around a circle, and every step is one position along it:
 * upper-left, top, upper-right, lower-right, bottom, lower-left. That walk is
 * why the half circles are in this table and not in {@link FRAMES} — a circle
 * needs them as its cardinal points, and the two heavier glyphs land on exactly
 * the two steps where a heavier glyph is what the shape calls for.
 */
const ORBIT_GLYPHS = ['\u25dc', '\u25e0', '\u25dd', '\u25de', '\u25e1', '\u25df'] as const

/**
 * Which cell of the two-column box each orbit glyph occupies, in step with
 * {@link ORBIT_GLYPHS}.
 *
 * Read off the shapes rather than picked for looks. The mark spends three of
 * its six steps on the right of the circle and three on the left; the two
 * cardinal shapes sit on the vertical axis, and `\u25e0` is given to the right and
 * `\u25e1` to the left so the two halves of the revolution each stay on one side
 * for a continuous three ticks. The mark therefore crosses the box once per half
 * turn, in the same direction it is rotating, instead of vibrating between the
 * cells on every tick.
 */
const ORBIT_SIDES = ['left', 'right', 'right', 'right', 'left', 'left'] as const

/**
 * Columns the orbit's animation box reserves, animating or not.
 *
 * A stable gutter is the point: a row's body must start in the same column
 * whether the mark is turning or settled, so every mark in a list reserves this
 * and the settling ones pad to it.
 */
export const SPINNER_MARK_COLUMNS = 2

/**
 * The two-cell orbit: ONE glyph moving through a fixed two-column box.
 *
 * Six frames for six ticks, one each, so a revolution is the original 600 ms
 * with nothing held and nothing duplicated. The glyph is never joined to a
 * second one, because a two-glyph frame reads as a terminal drawing a
 * combination rather than as one mark with presence. The glyph keeps its own
 * cell and the animation owns the box.
 *
 * Every frame is exactly two columns because the second is always a space, and
 * every glyph is East Asian NEUTRAL, so a terminal in ambiguous-width mode
 * still advances one cell for it. The width contract therefore holds without
 * depending on a terminal setting.
 * @param tick - a monotonically increasing counter; negative values are clamped.
 * @returns one glyph and one space, always exactly two columns wide.
 */
export function spinnerFrameOrbit(tick: number): string {
  const phase = revolutionPhase(tick)
  const glyph = ORBIT_GLYPHS[phase] ?? ORBIT_GLYPHS[0]
  return (ORBIT_SIDES[phase] ?? ORBIT_SIDES[0]) === 'left' ? `${glyph} ` : ` ${glyph}`
}

/**
 * Pad a settling mark to the same width the orbit reserves.
 *
 * `\u25cf active` beside `\u25dc  reading` would otherwise push the row body one
 * column right the moment a worker finished, which moves text under the reader
 * for no reason the row's state asked for.
 * @param mark - a one-cell settling glyph.
 * @returns the glyph followed by padding, exactly {@link SPINNER_MARK_COLUMNS} wide.
 */
export function spinnerMark(mark: string): string {
  return mark.padEnd(SPINNER_MARK_COLUMNS)
}

/**
 * Ticks in one glint cycle — a sweep and the rest after it. 1.6 s at
 * {@link SPINNER_INTERVAL_MS}.
 *
 * This is the root line's only liveness signal, so the cycle is close to
 * continuously alive: a seven-column word is lit for 0.9 s and rests 0.7 s, a
 * ten-column one for 1.2 s and rests 0.4 s. A line standing still over running
 * work reads as a hung process, which is what a longer rest here once looked
 * like on the one line that is never closed.
 *
 * The cycle is fixed rather than proportional to the text, and its phase comes
 * from the tick alone, so a word that changes mid-cycle neither restarts nor
 * stutters.
 */
export const GLINT_PERIOD_TICKS = 16

/**
 * Columns the lit band covers: wide enough to read as light moving across a
 * word, narrow enough that the word underneath it stays legible.
 *
 * The width is paid for in liveness, which is what this line is selling: a word
 * of `width` columns is lit for `width + 3 - 1` ticks of the cycle, because the
 * last step leaves the band wholly past the right edge. Every column here buys
 * one more lit tick and nothing else in this geometry does, so a band wide
 * enough to stop reading as light passing over a short word costs more than the
 * presence it adds.
 */
export const GLINT_BAND_COLUMNS = 3

/**
 * Ticks every cycle spends at rest, however long the text. A longer text is
 * crossed faster instead, so the pause cannot be spent on travel.
 *
 * The floor exists so a word long enough to cross at one column a tick cannot
 * eat the pause entirely: an eleven-column word would otherwise claim all
 * sixteen ticks. Every word dshline can currently draw is ten columns or fewer,
 * so this is a guard on the shape of the geometry rather than something any of
 * them reaches.
 */
const GLINT_MIN_REST_TICKS = 2

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
