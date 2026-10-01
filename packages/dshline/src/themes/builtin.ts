/**
 * The palettes this frontend ships, and the shape a theme is authored in.
 *
 * A theme is nine colours, not forty-six. Writing one role at a time would make
 * every palette a place for two roles to drift apart by accident — the four
 * meanings that used to share yellow got there exactly that way — so a theme
 * declares a SWATCH and {@link fromSwatch} assigns every role from it. Adding a
 * role therefore updates every shipped theme at once, and cannot leave one of
 * them with a hole.
 *
 * `default` is not built that way. It is assembled in `../theme.ts`, because it
 * has to emit the bytes this project emitted before palettes existed and its
 * per-role argument order is transcribed from the call sites rather than chosen.
 *
 * No user-authored themes yet. `Role` is the contract a theme is written
 * against, and publishing it before real palettes have exercised it would freeze
 * a vocabulary nothing has tested — the mistake the roadmap already warns about
 * for `TuiSlots`.
 * @module dshline/themes/builtin
 */

import type { ColorDepth, Palette, Role, RoleColor, Sgr } from '@dshline/renderer'
import { DEFAULT_PALETTE } from '../theme.ts'

/** SGR parameter for bold, applied ahead of a colour. */
const BOLD = 1

/** SGR parameter for italic, applied ahead of a colour. */
const ITALIC = 3

/**
 * The nine colours a theme is written in.
 *
 * Every role maps onto one of these, so two roles differ in appearance only
 * where a theme actually meant them to.
 */
export interface Swatch {
  /** Ordinary content the theme wants read: headings, names, section titles. */
  readonly text: RoleColor
  /** Identifiers and interactive state: paths, code, links, the selected row. */
  readonly accent: RoleColor
  /** The glyph that says which KIND of tool ran. */
  readonly tool: RoleColor
  /** Something finished, arrived, or was added. */
  readonly good: RoleColor
  /** Something failed, or was removed. */
  readonly bad: RoleColor
  /** Something is in flight, overridden, or worth a second look. */
  readonly warn: RoleColor
  /** Structure the eye skips: borders, gutter marks, rules, bullets. */
  readonly chrome: RoleColor
  /** Asides nobody reads twice: hints, elisions, line numbers, URLs. */
  readonly muted: RoleColor
  /** Real content, de-emphasized: summaries, quotes, reasoning. */
  readonly subdued: RoleColor
}

/**
 * Prefix one colour with an attribute, at every depth it declares.
 *
 * Attributes lead, which is the conventional order and the one the shipped
 * palette already uses.
 * @param color - the colour to decorate.
 * @param attribute - the SGR attribute parameter.
 * @returns the decorated colour.
 */
function with_(color: RoleColor, attribute: number): RoleColor {
  const lead = (params: Sgr): Sgr => [attribute, ...params]
  return {
    ...color.truecolor === undefined ? {} : { truecolor: lead(color.truecolor) },
    ...color.ansi256 === undefined ? {} : { ansi256: lead(color.ansi256) },
    ansi: lead(color.ansi),
  }
}

/** A bare attribute with no colour of its own, at every depth. */
const PLAIN = (attribute: number): RoleColor => ({ ansi: [attribute] })

/**
 * Assign every role from a swatch.
 *
 * The mapping is the theme system's actual editorial content: it decides that a
 * removed diff line and a failed command share `bad`, that an overlay border and
 * a running goal share `warn`, and that `muted` and `subdued` stay apart. A
 * theme chooses the colours; this chooses what they mean.
 * @param id - stable identifier a reader types.
 * @param name - display name for a picker row.
 * @param description - one line saying what the palette is for.
 * @param depth - the deepest colour space the swatch is authored at.
 * @param s - the swatch.
 * @returns a complete palette.
 */
function fromSwatch(
  id: string,
  name: string,
  description: string,
  depth: ColorDepth,
  s: Swatch,
): Palette {
  const roles: { [K in Role]: RoleColor } = {
    user: with_(s.accent, BOLD),
    assistant: s.good,
    reasoning: with_(s.subdued, ITALIC),
    'reasoning-mark': s.muted,
    'heading-1': with_(s.accent, BOLD),
    'heading-2': with_(s.text, BOLD),
    'heading-3': with_(s.subdued, BOLD),
    // Emphasis a model wrote carries no colour of its own: it marks a span
    // inside a sentence, and colouring it would make prose read as chrome.
    strong: PLAIN(BOLD),
    emphasis: PLAIN(ITALIC),
    strike: s.subdued,
    code: s.accent,
    link: s.accent,
    'link-target': s.muted,
    quote: s.subdued,
    'quote-bar': s.chrome,
    bullet: s.chrome,
    rule: s.chrome,
    'section-heading': with_(s.text, BOLD),
    'tool-icon': s.tool,
    'tool-name': with_(s.text, BOLD),
    path: s.accent,
    'diff-add': s.good,
    'diff-remove': s.bad,
    banner: with_(s.accent, BOLD),
    busy: s.warn,
    ready: s.good,
    mode: s.accent,
    'mode-alert': s.warn,
    'pressure-nominal': s.subdued,
    'pressure-warn': s.warn,
    'pressure-alarm': s.bad,
    error: s.bad,
    warning: s.warn,
    success: s.good,
    chrome: s.chrome,
    // The composer frame while a direct human shell operation owns foreground
    // shell interaction. `warn` rather than `bad`: the operation is in flight,
    // not failed, and a theme that wants the input surface to read as alarming
    // is choosing a different opinion, not correcting this one.
    'shell-active': s.warn,
    'composer-title': s.accent,
    'overlay-title': with_(s.warn, BOLD),
    'overlay-headline': with_(s.warn, BOLD),
    'panel-title': with_(s.accent, BOLD),
    selection: with_(s.accent, BOLD),
    'selection-mark': s.accent,
    'timing-active': s.accent,
    'prompt-mark': s.warn,
    muted: s.muted,
    subdued: s.subdued,
  }
  return { id, name, description, depth, roles }
}

/**
 * Bright sixteen-colour palette for terminals where the defaults are hard to
 * read.
 *
 * Deliberately spends nothing on `dim` or on bright black: both are the first
 * thing to disappear on a washed-out projector or a low-contrast profile, and
 * they are what the shipped palette leans on hardest. `subdued` therefore stops
 * being an attribute here and becomes a colour, which is the one place a theme
 * is allowed to collapse that distinction — a palette that cannot be read has
 * no distinctions worth keeping.
 */
const HIGH_CONTRAST = fromSwatch(
  'high-contrast',
  'High contrast',
  'Bright sixteen-colour palette that avoids dim and grey entirely',
  4,
  {
    text: { ansi: [97] },
    accent: { ansi: [96] },
    tool: { ansi: [94] },
    good: { ansi: [92] },
    bad: { ansi: [91] },
    warn: { ansi: [93] },
    chrome: { ansi: [37] },
    muted: { ansi: [37] },
    subdued: { ansi: [37] },
  },
)

/** Warm palette for a dark terminal. */
const EMBER = fromSwatch(
  'ember',
  'Ember',
  'Warm palette for a dark terminal',
  24,
  {
    text: { truecolor: [38, 2, 236, 224, 212], ansi256: [38, 5, 224], ansi: [37] },
    accent: { truecolor: [38, 2, 240, 168, 104], ansi256: [38, 5, 215], ansi: [36] },
    tool: { truecolor: [38, 2, 201, 162, 39], ansi256: [38, 5, 178], ansi: [34] },
    good: { truecolor: [38, 2, 163, 199, 109], ansi256: [38, 5, 149], ansi: [32] },
    bad: { truecolor: [38, 2, 229, 100, 107], ansi256: [38, 5, 203], ansi: [31] },
    warn: { truecolor: [38, 2, 232, 163, 61], ansi256: [38, 5, 214], ansi: [33] },
    chrome: { truecolor: [38, 2, 109, 93, 82], ansi256: [38, 5, 242], ansi: [90] },
    muted: { truecolor: [38, 2, 138, 119, 103], ansi256: [38, 5, 244], ansi: [90] },
    subdued: { truecolor: [38, 2, 169, 150, 134], ansi256: [38, 5, 246], ansi: [2] },
  },
)

/** Cool palette for a dark terminal. */
const TIDE = fromSwatch(
  'tide',
  'Tide',
  'Cool palette for a dark terminal',
  24,
  {
    text: { truecolor: [38, 2, 220, 230, 240], ansi256: [38, 5, 253], ansi: [37] },
    accent: { truecolor: [38, 2, 122, 184, 245], ansi256: [38, 5, 111], ansi: [36] },
    tool: { truecolor: [38, 2, 157, 140, 240], ansi256: [38, 5, 141], ansi: [34] },
    good: { truecolor: [38, 2, 111, 208, 168], ansi256: [38, 5, 79], ansi: [32] },
    bad: { truecolor: [38, 2, 242, 112, 110], ansi256: [38, 5, 203], ansi: [31] },
    warn: { truecolor: [38, 2, 227, 196, 106], ansi256: [38, 5, 179], ansi: [33] },
    chrome: { truecolor: [38, 2, 78, 91, 107], ansi256: [38, 5, 240], ansi: [90] },
    muted: { truecolor: [38, 2, 107, 122, 140], ansi256: [38, 5, 244], ansi: [90] },
    subdued: { truecolor: [38, 2, 143, 160, 178], ansi256: [38, 5, 246], ansi: [2] },
  },
)

/**
 * Palette for a light terminal.
 *
 * The reason the role layer had to separate `muted` from `subdued`. Every other
 * palette here leans on bright black and on the dim attribute, and on a white
 * background bright black is nearly invisible while dim is merely quiet — so a
 * light palette has to move the absolute grey and leave the attribute alone.
 * One role could never have done both.
 */
const PAPER = fromSwatch(
  'paper',
  'Paper',
  'For a light terminal, where bright black and dim stop meaning the same thing',
  24,
  {
    text: { truecolor: [38, 2, 28, 28, 28], ansi256: [38, 5, 234], ansi: [30] },
    accent: { truecolor: [38, 2, 11, 92, 173], ansi256: [38, 5, 25], ansi: [34] },
    tool: { truecolor: [38, 2, 106, 63, 160], ansi256: [38, 5, 55], ansi: [35] },
    good: { truecolor: [38, 2, 31, 122, 61], ansi256: [38, 5, 28], ansi: [32] },
    bad: { truecolor: [38, 2, 179, 38, 30], ansi256: [38, 5, 124], ansi: [31] },
    warn: { truecolor: [38, 2, 138, 90, 0], ansi256: [38, 5, 94], ansi: [33] },
    chrome: { truecolor: [38, 2, 154, 154, 154], ansi256: [38, 5, 247], ansi: [90] },
    muted: { truecolor: [38, 2, 110, 110, 110], ansi256: [38, 5, 242], ansi: [90] },
    subdued: { truecolor: [38, 2, 74, 74, 74], ansi256: [38, 5, 239], ansi: [2] },
  },
)

/**
 * Every shipped palette, in the order `/theme` offers them.
 *
 * `default` leads because it is what a reader already has, and the rest are
 * ordered shallowest first so the two that work on any terminal are seen before
 * the three that need one able to show them.
 */
export const THEMES: readonly Palette[] = [DEFAULT_PALETTE, HIGH_CONTRAST, EMBER, TIDE, PAPER]

/** The palette used when nothing has been chosen, and when a name is unknown. */
export const FALLBACK_THEME = DEFAULT_PALETTE

/**
 * Find a shipped palette by identifier.
 * @param id - the identifier a reader typed or a picker returned.
 * @returns the palette, or undefined when no shipped theme has that id.
 */
export function findTheme(id: string): Palette | undefined {
  const wanted = id.trim().toLowerCase()
  return THEMES.find(theme => theme.id === wanted)
}
