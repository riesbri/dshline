---
'@dshline/renderer': minor
'@dshline/dshline': minor
---

Identify terminal windows with `dshline · <workspace basename>` from the window's launch workspace, using an ordinary OSC 2 terminal title rather than a multiplexer API. The renderer's `Terminal.setTitle()` removes terminal controls and bounds metadata to 120 Unicode code points. The title stays stable across session changes; exit leaves it for the shell's normal title machinery rather than pretending to restore an unknown previous title.
