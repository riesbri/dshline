/**
 * Semantic roles, and the active palette that resolves them to SGR parameters.
 *
 * The indirection exists because a colour name at a call site is not a decision
 * anyone can revisit later. `style(text, 'red')` is written identically for a
 * failed tool and for a removed line of a diff, so no palette could ever move
 * one without moving the other. A ROLE says what a piece of text is; a PALETTE
 * says what that looks like. Only the second is a theme's to choose.
 *
 * **This module owns the mechanism, not the vocabulary.** The roles declared
 * here are the ones this package draws itself — markdown structure and generic
 * emphasis — because rendering markdown is a renderer capability. Everything a
 * frontend means by a colour, a reply or a tool card or context pressure, is
 * that frontend's domain: it adds those roles by augmenting {@link PaletteRoles}
 * from its own package. That keeps this one ignorant of agents, sessions, and
 * tools, which is the same rule that keeps it free of dependencies.
 *
 * The active palette is process-global, for the reason raw mode is: there is one
 * terminal. It follows the same rule too — installing one returns the disposer
 * that puts the previous one back, and calling that disposer twice is safe.
 * @module @dshline/renderer/theme
 */

import { sgr } from './text.ts'

/**
 * The role vocabulary, open for augmentation.
 *
 * Declared as an interface rather than a union so a consumer can add its own
 * roles from its own package:
 *
 * ```ts
 * declare module '@dshline/renderer' {
 *   interface PaletteRoles {
 *     'diff-add': RoleColor
 *   }
 * }
 * ```
 *
 * The members below are the ones this package paints. A consumer that adds
 * roles is then obliged to supply them in every palette it builds, because
 * {@link Palette} is total over {@link Role}.
 */
export interface PaletteRoles {
  /** A level-one markdown heading. */
  'heading-1': RoleColor
  /** A level-two markdown heading. */
  'heading-2': RoleColor
  /** A level-three or deeper markdown heading. */
  'heading-3': RoleColor
  /** `**bold**`, as a model wrote it. */
  strong: RoleColor
  /** `*italic*`, as a model wrote it. */
  emphasis: RoleColor
  /** `~~struck~~`, as a model wrote it. */
  strike: RoleColor
  /** Inline spans and fenced bodies alike; never syntax-parsed. */
  code: RoleColor
  /** The text of a link, which is what a reader follows. */
  link: RoleColor
  /** The target beside it. */
  'link-target': RoleColor
  /** Quoted prose. */
  quote: RoleColor
  /** The bar drawn beside it. */
  'quote-bar': RoleColor
  /** A list marker, ordered or not. */
  bullet: RoleColor
  /** A thematic break. */
  rule: RoleColor
  /** Asides nobody reads twice: a fence's language tag, a hint, an elision. */
  muted: RoleColor
}

/** One semantic role: what a piece of text IS. */
export type Role = keyof PaletteRoles

/**
 * The SGR parameters for one appearance: what goes between `CSI` and `m`.
 *
 * An array rather than a single number because a role is a whole appearance —
 * bold cyan is `[1, 36]` — and because the deeper colour spaces are themselves
 * multi-parameter: `[38, 5, 208]` and `[38, 2, 255, 128, 0]`. Emitting is a
 * join, so widening a palette past sixteen colours needs no new syntax here and
 * none in the width arithmetic, which treats a whole sequence as one token.
 *
 * **Order is significant and is asserted.** `[1, 36]` and `[36, 1]` render
 * identically and are different bytes, and tests in both packages match those
 * bytes literally.
 */
export type Sgr = readonly number[]

/** How much colour a terminal has been determined to support. */
export type ColorDepth =
  /** None: {@link paint} returns its input untouched, attributes included. */
  | 0
  /** The basic sixteen — what this project emitted before palettes existed. */
  | 4
  /** The 256-colour cube. */
  | 8
  /** Twenty-four bit. */
  | 24

/**
 * One role's appearance, authored once per colour space worth authoring.
 *
 * {@link RoleColor.ansi} is required, and that is the whole contract keeping
 * "no silent degradation" true for palettes: every theme states what it looks
 * like on a sixteen-colour terminal as a reviewed decision, rather than being
 * put through a nearest-colour approximation nobody looked at.
 */
export interface RoleColor {
  /** Twenty-four bit form, used when the terminal reaches it. */
  readonly truecolor?: Sgr
  /** 256-colour form, used when the terminal reaches that and no further. */
  readonly ansi256?: Sgr
  /** The sixteen-colour floor. Required: every terminal gets an answer. */
  readonly ansi: Sgr
}

/** A complete role table, before it is folded down to one terminal's depth. */
export interface Palette {
  /** Stable identifier; what a user types and what diagnostics report. */
  readonly id: string
  /** Display name for a picker row. */
  readonly name: string
  /** One line explaining what this palette is for. */
  readonly description: string
  /** The deepest colour space its entries are authored at. */
  readonly depth: ColorDepth
  /**
   * Every role, including any a consumer added. Total on purpose: a role
   * declared without a value here is a compile error rather than a blank row
   * discovered on screen.
   */
  readonly roles: { readonly [K in Role]: RoleColor }
}

/**
 * What this package's own roles look like, reproducing the bytes it emitted
 * before palettes existed.
 *
 * A partial table rather than a {@link Palette}, and deliberately so: a consumer
 * that augments {@link PaletteRoles} makes `Palette` total over roles this
 * package knows nothing about, so a complete palette is not this package's to
 * publish. Spread it into one instead.
 */
export const MARKDOWN_ROLES = {
  // Transcribed from the `style(...)` arguments these replaced, in their
  // original ORDER — `[1, 36]` and `[36, 1]` are different bytes, and two specs
  // match them literally.
  'heading-1': { ansi: [1, 36] },
  'heading-2': { ansi: [1] },
  'heading-3': { ansi: [1, 2] },
  strong: { ansi: [1] },
  emphasis: { ansi: [3] },
  strike: { ansi: [2] },
  code: { ansi: [36] },
  link: { ansi: [36] },
  'link-target': { ansi: [90] },
  quote: { ansi: [2] },
  'quote-bar': { ansi: [90] },
  bullet: { ansi: [90] },
  rule: { ansi: [90] },
  muted: { ansi: [90] },
  // `satisfies` rather than an annotation, so the KEYS survive: a consumer
  // spreads this into its own palette and totality is then checked for real.
} satisfies Readonly<Record<string, RoleColor>>

/** A palette already folded to one depth: role to parameters. */
interface ActivePalette {
  /** Which palette this came from, for reporting it back. */
  readonly id: string
  /** The depth it was folded to; 0 means {@link paint} does nothing. */
  readonly depth: ColorDepth
  /** The resolved parameters, by role. Partial: a consumer may add roles. */
  readonly roles: Readonly<Record<string, Sgr | undefined>>
}

/**
 * Choose the deepest authored form a terminal can actually show.
 * @param color - the role's authored appearances.
 * @param depth - what the terminal supports.
 * @returns the parameters to emit for that role.
 */
function fold(color: RoleColor, depth: ColorDepth): Sgr {
  if (depth >= 24 && color.truecolor !== undefined) return color.truecolor
  if (depth >= 8 && color.ansi256 !== undefined) return color.ansi256
  return color.ansi
}

/**
 * Fold a whole table once, at install time.
 *
 * Folding here rather than inside {@link paint} is a deliberate trade: `paint`
 * runs once per styled token per frame, so it has to stay a lookup and a join.
 * @param id - the palette's identifier.
 * @param depth - what the terminal supports.
 * @param table - the role table to fold.
 * @returns the resolved table.
 */
function resolve(
  id: string,
  depth: ColorDepth,
  table: Readonly<Record<string, RoleColor>>,
): ActivePalette {
  const roles: Record<string, Sgr> = {}
  for (const [role, color] of Object.entries(table)) {
    roles[role] = fold(color, depth)
  }
  return { id, depth, roles }
}

/**
 * The palette in force.
 *
 * Starts on this package's own roles, so markdown draws correctly with no
 * consumer wiring at all — which is what keeps the renderer testable on its own,
 * with no terminal, no model, and nothing installed.
 */
let active: ActivePalette = resolve('markdown', 4, MARKDOWN_ROLES)

/**
 * Style `text` for the roles given, resetting afterwards.
 *
 * For frontend-authored strings only, under the same rule as `style`: untrusted
 * text is made safe by `escapeControls` FIRST, because escaping neutralizes the
 * escape character itself and would destroy styling applied before it. Apply it
 * to one row at a time, after any gutter mark — the reset lands at the end of
 * whatever is wrapped, so a multi-line string is left with styling still
 * switched on for every row but the last.
 *
 * Do not nest calls. `paint(paint(x, 'code'), 'quote')` has the inner reset
 * close the outer styling, which is the same hazard `style` has always had; the
 * role names make nesting read as though it were safe, and it is not.
 *
 * A role the active palette does not carry is drawn unstyled rather than
 * throwing. The palette is process state, and a half-painted frame is a better
 * failure than a crashed one.
 * @param text - frontend-authored text that has already been made safe.
 * @param roles - roles to apply together, in order.
 * @returns the styled text; `text` unchanged with no roles, or at depth 0.
 */
export function paint(text: string, ...roles: readonly Role[]): string {
  if (active.depth === 0 || roles.length === 0) return text
  const params: number[] = []
  for (const role of roles) {
    const resolved = active.roles[role]
    if (resolved !== undefined) params.push(...resolved)
  }
  return sgr(text, params)
}

/**
 * Install `palette`, folded down to what the terminal can show.
 * @param palette - the palette to make active.
 * @param depth - the terminal's resolved colour depth.
 * @returns a disposer restoring the palette that was active before. Safe to
 *   call more than once, as `acquireTerminal`'s disposer is.
 */
export function setPalette(palette: Palette, depth: ColorDepth): () => void {
  const previous = active
  active = resolve(palette.id, depth, palette.roles)
  let restored = false
  return () => {
    if (restored) return
    restored = true
    active = previous
  }
}

/**
 * The palette currently in force.
 * @returns its identifier, and the depth it was folded to.
 */
export function activePalette(): { readonly id: string; readonly depth: ColorDepth } {
  return { id: active.id, depth: active.depth }
}

/** Internal lossless resolved presentation snapshot for the native transport.
 * @returns a detached palette, including opaque role keys and metadata.
 */
export function nativePaletteSnapshot(): { id: string; depth: ColorDepth; roles: Record<string, readonly number[]> } {
  return { id: active.id, depth: active.depth, roles: Object.fromEntries(Object.entries(active.roles).map(([role, params]) => [role, [...params ?? []]])) }
}
