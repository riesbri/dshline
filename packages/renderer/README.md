# @dshline/renderer

The terminal renderer behind [`dshline`](https://www.npmjs.com/package/@dshline/dshline), published separately because it knows nothing about agents.

**No dependencies, and no peers.** It provides display width by Unicode East Asian Width, raw-mode key decoding with bracketed paste, an input buffer that draws a large paste as one compact token while keeping the whole text, box drawing, a small markdown-to-ANSI pass, and an append-plus-live-region screen that never enters the alternate screen.

Two invariants it is built around:

- **Measuring and cutting agree about escape sequences.** `displayWidth` ignores them, so `wrapToWidth` and `truncateToWidth` do too — they tokenize into zero-width escapes and visible characters, never cut inside a sequence, and reopen styling on a continuation row.
- **Untrusted text is escaped before it can reach the terminal.** Anything a model, a tool, or a paste produces goes through `escapeControls` and is shown in caret notation, so an escape sequence is displayed rather than executed.

And one about the input buffer: **what it draws is not what it holds.** A paste large enough to be unreadable is drawn as `[Pasted text #1 +11 lines]`, but the buffer keeps the complete text, and the buffer is what a caller reads, records, and submits. The label is a projection over a range, not a replacement for it — moving the cursor into one reveals the text, and editing it reveals the text.

Source, tests, and documentation: **https://github.com/riesbri/dshline**

## License

MIT
