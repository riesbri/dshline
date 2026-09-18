---
'@dshline/dshline': patch
---

Stop formatting every matching history entry before the `ctrl-r` viewport is
applied. The framed history search rendered all of its matches into result rows
and only then sliced to the terminal, so a redraw's cost grew with the number of
matches even though only a screenful can be drawn. It now measures the result
list arithmetically from the selected entry and formats only the rows the
viewport can show. Matching, result order, selection, preview behavior, and the
viewport-follow policy are unchanged.
