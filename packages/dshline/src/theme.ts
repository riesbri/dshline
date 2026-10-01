/**
 * The roles this frontend adds to the renderer's vocabulary.
 *
 * The renderer declares the roles it draws itself — markdown structure and
 * generic emphasis — and nothing more, because it must not learn what a reply,
 * a tool call, or context pressure is. Everything below is domain: it exists
 * because this frontend presents an agent session, and it belongs on this side
 * of the boundary for the same reason `cards.ts` does.
 *
 * Augmenting the renderer's `PaletteRoles` rather than defining a second
 * vocabulary keeps one `paint` and one `Palette`. It also makes totality do the
 * work: adding a member here fails the build of every palette in
 * `./builtin.ts` until it is given a colour.
 * @module dshline/theme
 */

import type { Palette, RoleColor } from '@dshline/renderer'
import { MARKDOWN_ROLES } from '@dshline/renderer'

declare module '@dshline/renderer' {
  interface PaletteRoles {
    // Who produced a line.
    /** The reader's own prompt, and the gutter mark introducing it. */
    user: RoleColor
    /** The mark on the reply channel. */
    assistant: RoleColor
    /** The model's working notes, shown as written. */
    reasoning: RoleColor
    /** The mark that introduces them. */
    'reasoning-mark': RoleColor

    // Tool cards and diffs.
    /** A heading over a group of rows inside a view. */
    'section-heading': RoleColor
    /** The glyph saying which KIND of tool ran. */
    'tool-icon': RoleColor
    /** The tool's name. */
    'tool-name': RoleColor
    /** A path a tool reports. */
    path: RoleColor
    /** A line a change added. */
    'diff-add': RoleColor
    /** A line a change removed. */
    'diff-remove': RoleColor

    // The banner and the status line.
    /** The product name in the startup banner and the root frame's left label. */
    banner: RoleColor
    /** Something is in flight. */
    busy: RoleColor
    /** Nothing is running. */
    ready: RoleColor
    /** A mode worth reporting: plan, todo, work. */
    mode: RoleColor
    /** A mode worth looking at: an overridden tool detail, a driving goal. */
    'mode-alert': RoleColor
    /** Context pressure, while there is room. */
    'pressure-nominal': RoleColor
    /** Context pressure, getting full. */
    'pressure-warn': RoleColor
    /** Context pressure, nearly spent. */
    'pressure-alarm': RoleColor

    // Outcomes.
    /** Something failed. */
    error: RoleColor
    /** Something needs attention but is not a failure. */
    warning: RoleColor
    /** Something finished. */
    success: RoleColor

    // Chrome and interaction.
    /** Borders, gutter marks, separators — structure the eye skips. */
    chrome: RoleColor
    /**
     * A foreground human shell operation currently owns direct shell interaction.
     *
     * Its own role rather than `warning` or `busy`, and the reason is the same
     * one that keeps `mode-alert` separate from `warning`: those name a FEELING
     * about a settled thing, while this names WHO HOLDS THE INPUT SURFACE. An
     * ordinary prompt typed while a `!` command runs is still an ordinary
     * prompt, so nothing inside the composer may claim otherwise — the frame
     * around it is what reports the ownership, and it agrees with the Ctrl-C
     * priority that already gives the shell first refusal.
     *
     * Deliberately NOT `error`. A running command is not a failure; red is what
     * `✗ shell exit 1` spends. It shares amber with `warning` today, and a
     * palette is free to give it a colour of its own later without touching one.
     */
    'shell-active': RoleColor
    /**
     * The composer's current draft would be executed locally, not sent to the model.
     *
     * A DIFFERENT fact from `shell-active`: nothing is running here, so this is
     * what the frame says while the reader is still composing — before enter,
     * before any process exists, and for a command that may settle too quickly to
     * ever be seen executing. The two share amber today and stay separate roles
     * anyway, because a palette is free to tell "you are writing a shell command"
     * from "a shell command owns your ctrl-c" later without a line of runtime
     * changing. Merging them now would spend that freedom for nothing.
     *
     * Deliberately not `error` either: a command being typed is not a failure,
     * and red is reserved for the result rows that report one.
     */
    'shell-input': RoleColor
    /** The root frame's right label while composing: the workspace basename. */
    'composer-title': RoleColor
    /** The root frame's right label for a temporary overlay: the view identity. */
    'overlay-title': RoleColor
    /** The bare headline an overlay falls back to on a narrow terminal. */
    'overlay-headline': RoleColor
    /** The heading of a persistent live panel. */
    'panel-title': RoleColor
    /** The selected row in a list. */
    selection: RoleColor
    /** The pointer glyph, where it is styled apart from that row. */
    'selection-mark': RoleColor
    /** A span still running, and the filled part of its bar. */
    'timing-active': RoleColor
    /** The glyph in front of a query or a text prompt. */
    'prompt-mark': RoleColor

    /**
     * Real content, de-emphasized: summaries, quotes, secondary status.
     *
     * Held apart from the renderer's `muted` on purpose. That one is an absolute
     * colour and this one is an attribute that composes with whatever foreground
     * is already active, so a palette written for a light terminal has to move
     * the first and leave the second alone.
     */
    subdued: RoleColor
  }
}

/**
 * The palette this project shipped before it had palettes.
 *
 * Assembled rather than imported whole: the renderer publishes MARKDOWN_ROLES
 * for the roles it draws itself, and the rest are declared above because they
 * are this frontend's domain. Every entry reproduces the exact `style(...)`
 * arguments of the call sites it replaced, in their original ORDER, so
 * `paint(text, role)` emits the same bytes the same row emitted before. That is
 * what makes migrating every call site a refactor with a mechanical proof, and
 * `theme.spec.ts` locks it role by role.
 *
 * Authored at depth 4 and carrying no deeper forms, which is also what a
 * terminal that reports nothing about itself receives.
 */
export const DEFAULT_PALETTE: Palette = {
  id: 'default',
  name: 'Default',
  description: 'The palette dshline has always shipped',
  depth: 4,
  roles: {
    ...MARKDOWN_ROLES,
    // transcript.ts: the gutter mark and the row it introduces.
    user: { ansi: [36, 1] },
    // stream.ts: the mark on the reply channel.
    assistant: { ansi: [32] },
    // stream.ts: the model's working notes, shown as written.
    reasoning: { ansi: [2, 3] },
    'reasoning-mark': { ansi: [90] },
    'section-heading': { ansi: [1] },
    // cards.ts: the call mark and the per-kind glyphs beside it.
    'tool-icon': { ansi: [34] },
    'tool-name': { ansi: [1] },
    path: { ansi: [36] },
    'diff-add': { ansi: [32] },
    'diff-remove': { ansi: [31] },
    // views.ts: the product name in the startup banner.
    banner: { ansi: [1, 36] },
    busy: { ansi: [33] },
    ready: { ansi: [32] },
    // views.ts: the plan, todo, and work segments of the status line.
    mode: { ansi: [36] },
    'mode-alert': { ansi: [33] },
    'pressure-nominal': { ansi: [2] },
    'pressure-warn': { ansi: [33] },
    'pressure-alarm': { ansi: [31] },
    error: { ansi: [31] },
    warning: { ansi: [33] },
    success: { ansi: [32] },
    // Borders, gutter marks, separators — structure the eye skips over.
    chrome: { ansi: [90] },
    // views.ts, attachment.ts: the composer frame and the shell-running row
    // while a direct human shell operation owns foreground shell interaction.
    // Amber, like `busy` and `warning`, because it is neither good nor bad.
    'shell-active': { ansi: [33] },
    // views.ts: the composer frame while the DRAFT it holds is a human shell
    // gesture. The same amber, and a separate role for a separate fact: nothing
    // is running yet, and a palette may say so differently later.
    'shell-input': { ansi: [33] },
    'composer-title': { ansi: [36] },
    'overlay-title': { ansi: [1, 33] },
    // The bare headline an overlay falls back to when the terminal is too
    // narrow to frame anything. A separate role from the framed title because
    // it is a separate thing, and because the two are different bytes today.
    'overlay-headline': { ansi: [33, 1] },
    'panel-title': { ansi: [36, 1] },
    selection: { ansi: [36, 1] },
    'selection-mark': { ansi: [36] },
    'timing-active': { ansi: [36] },
    'prompt-mark': { ansi: [33] },
    subdued: { ansi: [2] },
  },
}
