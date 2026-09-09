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
  at every width. The width is now clamped to the terminal, the label budget
  floors at one, and every row is cut. This is the same correction the status
  line already carries, for the reason its own comment gives.
- **The timing panel's measured rows** are budgeted from the DATA as well as
  from the width: the label width, field gap and bar cells are what is left
  after the longest duration's width is subtracted, and the label and gap have
  floors of one. A long-running turn on a narrow terminal therefore produced a
  row wider than the width it was laid out for. The heading and the elision row
  were already cut for this reason; the measured rows now are too.

Neither is reachable at an ordinary window size, and neither is the cause of the
duplicate header a subagent produces — that is a foreign writer on descriptor 2,
fixed separately. These are the same failure class found while probing for it.

The regression test is the property both bugs broke, checked over the real views
composed together: no row wider than the terminal, no more physical rows than
the terminal has, and no cursor outside the drawn region — across 8–200 columns
and 10–50 rows, with an empty, short, thirty-line and two-thousand-character
composer, a standing completion offer, streaming on and off, and the timing
panel on and off. It reports 2583 violations without these two changes.
