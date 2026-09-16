---
'@dshline/dshline': patch
---

Workspace names in the composer's frame label now keep far more international
text instead of collapsing it to `?`.

The composer draws its workspace basename inside the live region's top border,
where a character the terminal draws wider than `displayWidth` measures makes
the border wrap a physical row the redraw arithmetic never counts; the stale
border then survives every erase. The label was therefore projected to
width-stable characters, but the renderer's hand-written wide table trailed
Unicode badly enough that the replacement was applied to code points no
terminal is entitled to widen: Hebrew, Arabic, and Indic letters, combining
marks across every script, and the non-emoji wide script blocks (Nushu,
Khitan, Yijing hexagrams, Tai Xuan Jing) all became `?`.

The renderer's wide and zero-width ranges are now generated from the Unicode
Character Database 16.0.0 by a committed, dependency-free generator, so the
model measures what terminals draw. On top of that the label keeps every
unambiguously narrow script, wide and zero-width code points, and a precomposed
Latin accent via its canonical decomposition — `café` is drawn as `cafe` plus
U+0301 rather than replaced. Only what a terminal may genuinely draw
differently is still projected: an East Asian Ambiguous character with no
stable decomposition, a text-default emoji, and the multi-code-point sequences
a per-code-point rule cannot see (VS15/VS16 presentation, keycaps, regional
indicator flags, ZWJ sequences, and skin-tone modifiers). The committed banner
still prints the raw workspace name byte for byte.
