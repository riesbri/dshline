---
'@dshline/dshline': patch
'@dshline/renderer': patch
---

Workspace names in the composer's frame label now keep far more international
text instead of collapsing it to `?`, and the renderer's width tables come from
a pinned Unicode release instead of a hand-maintained list.

The composer draws its workspace basename inside the live region's top border,
where a character the terminal draws wider than `displayWidth` measures makes
the border wrap a physical row the redraw arithmetic never counts; the stale
border then survives every erase. The label was therefore projected to
width-stable characters, but the renderer's hand-written tables trailed Unicode
badly enough that the replacement was applied to code points no terminal is
entitled to widen: Hebrew, Arabic, and Indic letters, combining marks across
every script, and the non-emoji wide script blocks (Nushu, Khitan, Yijing
hexagrams, Tai Xuan Jing) all became `?`.

The renderer's wide and zero-width ranges are now generated from the Unicode
Character Database 17.0.0 by a committed, dependency-free generator with
checksum-pinned inputs, so the model measures what a current terminal draws.
General_Category is not a terminal `wcwidth` function, so the zero-width table
is nonspacing and enclosing marks plus an explicit allowlist of format controls;
U+00AD and the prepended or spanning marks (U+0600..U+0605, U+06DD, U+070F,
U+0890..U+0891, U+08E2, U+110BD, U+110CD) are measured one cell, and the line
and paragraph separators are too. The label keeps every unambiguously narrow
script, wide and zero-width code points, and a precomposed Latin accent via its
canonical decomposition — `café` is drawn as `cafe` plus U+0301 — and composes a
decomposed Hangul syllable with NFC instead of projecting its Jamo. Only what a
terminal may draw wider than the model counts is projected: an East Asian
Ambiguous character with no stable decomposition, a text-default emoji, a format
character outside the allowlist, and the multi-code-point sequences a
per-code-point rule cannot see (VS15/VS16 presentation, keycaps, regional
indicator flags, ZWJ sequences, and skin-tone modifiers). The committed banner
still prints the raw workspace name byte for byte.
