---
'@dshline/dshline': patch
---

`shift-enter` now starts a new line in native Windows terminals. Windows Terminal
1.24 and earlier, and the Windows console host itself, ignore the kitty keyboard
request the renderer sends; the console flattened `shift-enter` into the same
carriage return as `enter`, so the composer could only submit. The renderer now
also asks a Windows console for its own win32-input-mode and translates those key
records into the encodings it already reads, which restores `shift-enter` and
makes `ctrl-enter` distinguishable there as well. `enter` and `alt-enter` are
unchanged, and the mode is switched off when the interface exits.
