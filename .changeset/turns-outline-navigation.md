---
'@dshline/dshline': minor
---

Add `/turns`: a bounded, Harness-native index of this session's turns, read from
the `turnOutline` session projection. Move the selection with `↑`/`↓`, open a
read-only inspection of a turn's prompt and response previews with `enter`, walk
turns with `←`/`→`, filter by turn number or preview text with `/`, and leave
with `esc`. `/turns <text>` opens pre-filtered. The outline is a view over
Harness's authoritative fold — no second transcript model, no rewrite of native
scrollback — and a composition that mounts no turn outline says so instead of
folding the log itself.
