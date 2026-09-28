---
'@dshline/renderer': patch
---

Make a prefix cut cost what it keeps. `truncateToWidth()` broke out of its loop at
the column limit, but the tokens it looped over were built first and for the whole
string, so keeping eighty columns of a million-character line allocated a million
token objects: 68 MB of garbage and 15 ms, growing with the input rather than with
the answer. The line is now walked by index and the walk ends at the first token
that would push the total past the budget, so the same cut takes 0.2 µs and
allocates one string.

That cost is bounded by the retained prefix, and the bound is worth stating
precisely rather than calling it flat: the scan also reads whatever it must to
establish where the prefix ends. Reached the budget is deliberately not where it
stops. A combining mark, a variation selector, a ZWJ, or an SGR that follows the
budget are all part of the answer, and the last of them decides whether a reset is
owed, so a cut at `used === columns` would drop both. The stopping rule is "the
first token that does not fit". An escape whose terminator never arrives is the
unbounded case, since its length is only known by scanning forward for one — text
no terminal can render, which the scan is what proves. Ordinary styled text meets
the first kind constantly and the second never, which is why the cost above is
constant with respect to an ordinary discarded visible tail.

`displayWidth()` and `chunkToWidth()` were re-pointed at the same scan: the first
used to strip escapes, which copies the whole string to answer a question about
all of it, and the second built a token array it walked once. Both are faster for
it (1M characters: 3.8 ms → 2.9 ms and 30 ms → 8 ms) and agree with a cut exactly
as before. `wrapToWidth()` and `tailToWidth()` keep the tokenizer: the first
reorders tokens into rows and the second starts from the end, so neither can stop
early, and neither is made simpler by a scan.
