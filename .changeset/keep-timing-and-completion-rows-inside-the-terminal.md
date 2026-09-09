---
'@dshline/dshline': patch
---

Keep the timing panel's measured rows and the completion list's rows inside the
terminal, so a narrow window cannot leave root chrome in scrollback.

`TuiSlots.compose` budgets the live region in LOGICAL lines and hands each view
the rows the views above it have not spent. That is only the same thing as the
physical budget while every row fits the terminal's width: `Screen.wrap`
re-wraps an overlong row into two AFTER the budgeting is finished, so one row
wider than the terminal is one row of overflow no view's own accounting can see.
Once the region is taller than the screen its first rows cannot be climbed back
to and erased, and the next redraw leaves `╭─ dshline ─… ─╮` in native
scrollback for good.

Two views could emit such a row, for two different reasons:

- **The completion list** laid its rows out against `chromeWidth(columns)`,
  which floors at the shared chrome minimum and therefore returns a width WIDER
  than the terminal below that floor. Its label budget also carried a floor of
  eight columns independent of the terminal, and its shortest row — the
  `… N more` marker — was not cut at all, so `… 14 more` drew thirteen columns
  at every width. Worse, only the label was ever bounded: every row carries a
  fixed four-column prefix (`  › `) that sat outside the budget entirely, so at
  one to four columns the row was five columns wide no matter what the label was
  cut to. The width is now clamped to the terminal, the prefix is one named
  constant shared by every budget that has to account for it, the WHOLE
  assembled row is cut rather than only its payload, and below a prefix plus one
  column of label the list stands down instead of spending a live row on a
  candidate it cannot name.
- **The timing panel's measured rows** are budgeted from the DATA as well as
  from the width: the label width, field gap and bar cells are what is left
  after the longest duration's width is subtracted, and the label and gap have
  floors of one. A long-running turn on a narrow terminal therefore produced a
  row wider than the width it was laid out for.

  Cutting the row would have bounded it and broken a different rule this file
  already keeps: the duration sits at the right edge, so a plain truncation
  turns `2h 41m` into `2h 4` — not a narrower fact but a different, entirely
  plausible one, which is what the heading's own ladder exists to avoid. So the
  fields are not cut and the FORM is chosen instead, by a ladder from
  `label + bar + duration` through `label + duration`, an indented duration, a
  bare duration, and finally `…` where not even a whole duration fits. The
  widest form that fits is picked once for the panel rather than per row, so a
  narrow panel stays aligned instead of going ragged for a reason no reader
  could see.

Neither is reachable at an ordinary window size, and neither is the cause of the
duplicate header a subagent produces — that is a foreign writer on descriptor 2,
fixed separately. These are the same failure class found while probing for it.

The regression test is the property both bugs broke, checked over the real views
composed together — stream, composer, completion, timing and status at once,
because the failure only appears in combination and a view that fits alone can
still be the one that pushes the region over. Six claims per composition: every
logical row fits the terminal's width, the wrapped physical rows fit its height,
and the cursor's row and column are each non-negative and inside what was
actually drawn.

Widths run **exhaustively from one column** to the shared chrome floor — the
same range `narrow-root.spec.ts` already holds the root chrome to — and then
across representative ordinary widths to 200, over heights 10–50, with an empty,
short, thirty-line and two-thousand-character composer, a standing completion
offer, streaming on and off, and the timing panel on and off. Extending it below
eight columns is what exposed the completion prefix; the previous sampling
started at eight and could not see it. Two focused cases name each view
directly, assert the stand-down policy rather than leaving it to whatever the
arithmetic happens to do, and check that a duration which appears at all appears
whole. All three fail without these two changes.
