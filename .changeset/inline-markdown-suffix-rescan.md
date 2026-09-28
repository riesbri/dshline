---
'@dshline/renderer': patch
---

Stop rescanning the rest of a line for every inline construct that fails to
match. The link, code span, and emphasis patterns were each asked about the
whole remaining suffix at every character, so a reply containing a long run of
unmatched `[` — or a backtick run, or underscores that never close — cost time
quadratic in the line's length: a 128k line of brackets took 6 seconds, and a
1M one would take six minutes. Each construct is now asked only at the
characters that can open it, and the search for its closer remembers what it has
already ruled out rather than asking the same question again one character
later. Ordinary lines render two to five times faster as a side effect, and
rendering is byte for byte what it was: unmatched markers stay literal, and
nothing about the markdown itself changed.
