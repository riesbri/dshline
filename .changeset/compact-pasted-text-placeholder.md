---
'@dshline/dshline': minor
'@dshline/renderer': minor
---

Collapse large bracketed pastes into compact composer placeholders while
preserving the full sanitized text for editing, history, and Harness
submission.

Pasting a stack trace, a diff, or a minified bundle filled the input line with
hundreds of rows and pushed the sentence you were typing off the screen. A paste
that reaches eight logical lines or a thousand code points now draws as a single
`[Pasted text #1 +11 lines]` token, measured on the sanitized text the buffer
actually holds. The interaction is inspired by the compact-paste UX other
coding agents use; nothing here is derived from or compatible with their
internals.

The placeholder is a drawing, never the message. `Composer.value` keeps the
complete sanitized text, and that is what a submission sends, what a history
entry records, and what completion and slash-command parsing read. There is no
expansion step, because there is nothing to expand. A string that happens to
look like a placeholder stays ordinary text, because a fold is a recorded range
rather than a pattern anything matches against.

`@dshline/renderer` now separates what the composer holds from what a reader
sees. Layout consumes a display projection with an exact mapping back to
authoritative offsets, so a cell inside a placeholder resolves to that
placeholder's boundary and no arrow key can leave the cursor where nothing is
drawn. The projection skips folded interiors, and the composer exposes a
revision counter so an unchanged frame no longer joins the whole draft to
decide whether it can reuse the previous layout — which matters most exactly
when a large document is hidden.

Folds are O(1) range metadata and never a second copy of the pasted body. Typing
outside a fold leaves it folded; an edit before it shifts its range. Moving the
cursor into one, or editing inside it, reveals the text first — a horizontal
move unfolds and then moves, so the cursor is never invisible, and a mutation
that would touch hidden characters invalidates the label before it applies.
Deleting a folded span removes its metadata with the text. Undo and redo restore
fold state along with the characters, and paste numbers are monotonic for the
life of a session: a submitted draft does not reset the counter, and undo never
hands a number to different content.

History recall returns the full ordinary text, because paste provenance is
ephemeral composer presentation and is not persisted — labelling a long prompt
the user typed by hand as pasted would put a false claim into the message.
Committed scrollback and session events are unchanged.
