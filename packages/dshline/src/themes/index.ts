/**
 * `/theme`: choose the palette, and show what it did.
 *
 * Two things about this frontend make a theme picker unusual, and both are
 * terminal-model consequences rather than gaps to fill in later.
 *
 * The first is that finished rows are committed to the user's real scrollback
 * and are never rewritten. Switching palette repaints the bounded live region;
 * everything above it keeps the colours it was printed with, permanently. That
 * is the invariant the whole renderer is built on, so the command says so rather
 * than letting a reader conclude the switch half-failed.
 *
 * The second follows from the first. A picker cannot preview a palette by
 * repainting the transcript, so applying one is confirmed by a single line drawn
 * in the palette just installed — enough to see that something changed, and the
 * whole live region below it is redrawn anyway. An earlier version committed a
 * sample transcript instead: a fabricated reply, tool call, diff, and failure,
 * written permanently into the reader's scrollback and indistinguishable
 * afterwards from output a session actually produced. A theme is not worth
 * putting fiction in the record for.
 * @module dshline/themes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ColorDepth, Palette } from '@dshline/renderer'
import { escapeControls, paint } from '@dshline/renderer'
import { promptSelect } from '../select.ts'
import { THEMES, findTheme } from './builtin.ts'

/**
 * How the depths are named where one has to be reported.
 *
 * Reported at all because "no silent degradation" applies to palettes too: a
 * reader who picks a 24-bit theme on a sixteen-colour terminal should be told
 * they are seeing its declared fallback, not left to wonder why it looks like
 * the one they just left.
 */
const DEPTH_NAMES: Readonly<Record<ColorDepth, string>> = {
  0: 'no colour',
  4: '16 colours',
  8: '256 colours',
  24: '24-bit colour',
}

/**
 * The values `/theme` accepts, for completing its argument.
 * @returns each shipped theme's id, with its description beside it.
 */
export function themeValues(): readonly { value: string; note?: string }[] {
  return THEMES.map(theme => ({ value: theme.id, note: theme.description }))
}


/**
 * What applying a palette should report into the transcript.
 *
 * The scrollback caveat is stated only where it is TRUE. On the first switch of
 * a session there may be nothing above worth mentioning, but the command cannot
 * know that — it does not own the transcript — so it says it whenever the
 * palette actually changed, and stays quiet when a reader re-picks the palette
 * they already had.
 * @param palette - the palette now in force.
 * @param depth - what the terminal can actually show.
 * @param changed - whether this switch changed anything.
 * @param note - what storing the choice had to say, when it had anything.
 * @returns the report line.
 */
export function themeReport(
  palette: Palette,
  depth: ColorDepth,
  changed: boolean,
  note?: string | undefined,
): string {
  const degraded = palette.depth > depth
    ? ` · authored for ${DEPTH_NAMES[palette.depth]}, showing its ${DEPTH_NAMES[depth]} fallback`
    : ''
  const stored = note === undefined ? '' : ` · ${note}`
  const mark = paint('·', 'chrome')
  const name = paint(`theme: ${palette.id}`, 'mode')
  if (!changed) return `${mark} ${name}${paint(` — already in use${degraded}${stored}`, 'muted')}`
  // Two roles rather than one: this line is the only thing drawn in the new
  // palette at the moment it lands, so a reader who switched in order to see a
  // difference should be able to see one in it.
  return `${mark} ${name}${paint(`${degraded} · rows above keep the colours they were printed with${stored}`, 'muted')}`
}

/** What the caller has to supply for `/theme` to do its work. */
export interface ThemeCommand {
  /** Plugin context, for the picker overlay. */
  readonly ctx: Context
  /** The palette currently in force. */
  readonly current: () => Palette
  /** What the terminal can show, resolved once when the window opened. */
  readonly depth: ColorDepth
  /** Install a palette for this window. */
  readonly apply: (palette: Palette) => void
  /** Write finished rows into scrollback. */
  readonly commit: (lines: readonly string[]) => void
  /**
   * Store the choice in the settings user layer. Injected so the command can
   * be tested without a settings service, and so a deployment that mounts
   * none still switches for the life of the window.
   * @param id - the theme now in force.
   * @returns a phrase to append to the report, or nothing to add.
   */
  readonly remember?: (id: string) => Promise<string | undefined>
}

/**
 * Run `/theme`, named or asked for.
 *
 * Named and asked-for meet at one resolve, so a typed word and a chosen row
 * cannot drift — the same rule `/usage` and `/reasoning` follow. A name that
 * matches nothing reports what was on offer instead of opening a picker the
 * reader did not ask for.
 * @param spec - the window seams this command needs.
 * @param rawInput - exactly what followed the command name.
 * @returns once the switch and its report are complete.
 */
export async function runThemes(spec: ThemeCommand, rawInput: string): Promise<void> {
  const named = rawInput.trim()
  const current = spec.current()
  const picked = named === ''
    ? await promptSelect(spec.ctx, {
      title: 'Theme',
      view: 'Theme',
      detail: `current: ${current.id}`,
      // Theme choices already carry the stable id as their value, so the
      // current palette maps directly; an id no longer shipped simply matches
      // nothing and the picker falls back to its first row.
      initialValue: current.id,
      choices: THEMES.map(theme => ({
        value: theme.id,
        label: theme.name,
        description: theme.depth > spec.depth
          ? `${theme.description} — this terminal shows its ${DEPTH_NAMES[spec.depth]} fallback`
          : theme.description,
      })),
    })
    : named
  // Dismissed, so nothing changed and there is nothing to report.
  if (picked === undefined) return
  const chosen = findTheme(picked)
  if (chosen === undefined) {
    const offered = THEMES.map(theme => theme.id).join(', ')
    spec.commit([paint(
      `✗ no theme named ${escapeControls(picked)}; try one of: ${offered}`,
      'error',
    )])
    return
  }
  const changed = chosen.id !== current.id
  // Applied before anything is drawn with it, so the report is rendered under
  // the palette it is describing.
  if (changed) spec.apply(chosen)
  // Stored whether or not the palette moved. A switch whose write failed
  // leaves the terminal already showing the theme and the document still
  // naming the old one, and the obvious way to retry is to pick the same
  // theme again — which used to be the one gesture that did nothing.
  //
  // Never rolled back on failure, for the reason `../selection.ts` gives: the
  // palette HAS changed by the time this runs, so a write that did not land
  // is a reason to say so rather than to put the colours back.
  const note = await spec.remember?.(chosen.id)
  spec.commit([themeReport(chosen, spec.depth, changed, note)])
}
