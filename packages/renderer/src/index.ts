/**
 * An append-and-live-region terminal renderer.
 *
 * Deliberately agent-agnostic: nothing here imports the harness, so the whole
 * package is testable against a fake `ScreenTarget` with no terminal, no model,
 * and no plugin context. The harness wiring lives in `dshline`.
 * @module @dshline/renderer
 */

export { BOX_CHROME_COLUMNS, box, boxHeight, fitToWidth, frame, frameHeight } from './box.ts'
export type { BoxOptions, FrameDivider, FrameOptions, FrameRow } from './box.ts'
export { Composer } from './composer.ts'
export type { ComposerAction, SubmitGesture } from './composer.ts'
export { layoutComposer } from './composer-layout.ts'
export type { ComposerLayout } from './composer-layout.ts'
export { createMarkdownRenderer, renderInline, renderMarkdown } from './markdown.ts'
export type { MarkdownRenderer } from './markdown.ts'
export { formatElapsed, formatTokens, SPINNER_INTERVAL_MS, spinnerFrame } from './spinner.ts'
export { createKeyDecoder, decodeKeys } from './keys.ts'
export type { Key, KeyDecoder, KeyName } from './keys.ts'
export { Screen } from './screen.ts'
export type { LiveCursor, ScreenTarget } from './screen.ts'
export { acquireTerminal, isInteractive } from './terminal.ts'
export type { Terminal, TerminalStreams } from './terminal.ts'
export { chunkToWidth, codePointWidth, displayWidth, hangingIndent, stripAnsi, tailToWidth, truncateToWidth, wrapToWidth } from './width.ts'
export { escapeControls, sanitizePasted, sgr, style, Style } from './text.ts'
export type { StyleName } from './text.ts'
export { activePalette, MARKDOWN_ROLES, paint, setPalette } from './theme.ts'
export type { ColorDepth, Palette, PaletteRoles, Role, RoleColor, Sgr } from './theme.ts'
