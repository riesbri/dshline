---
'@dshline/dshline': patch
---

Stop a long streamed line from slowing the reply it belongs to. The incremental
stream accumulator searched its entire unfinished line for the last newline on
every delta, which is quadratic for a minified payload, a URL, or one long code
line delivered in small chunks. It now searches only the delta that just
arrived: the unfinished line never holds a newline between deltas, so a
completed line can only have come in with that delta. The rows produced are
unchanged; the repeated scan is gone.
