---
'@dshline/renderer': patch
---

Make a modified `enter` distinguishable through a terminal multiplexer.

dshline asked its terminal for distinguishable modified keys with the kitty
keyboard protocol's *disambiguate escape codes* flag, and nothing else. That
request is correct for a terminal and silently does nothing behind tmux, because
a terminal multiplexer is itself a terminal emulator: it consumes the request as
program output and answers it in its own terms. Measured on tmux 3.7c, a pane's
`CSI > 1 u` left `pane_key_mode` at its `VT10x` default and a modified `enter`
still arrived as the bare carriage return an unmodified one uses — so
`shift-enter` **sent the message**, and `ctrl-enter` had no representation at all,
on the one gesture that exists to avoid submitting.

The renderer now also asks for the same property in xterm's spelling,
`CSI > 4 ; 1 m`, released with `CSI > 4 ; 0 m`. tmux honours that one, and
answers in `CSI 27 ; modifiers ; code ~` — an encoding this decoder already read.
Level 1 rather than 2 because it is the smaller promise: only keys with no legacy
encoding change, so every shortcut that already worked still arrives byte for
byte. Verified on tmux 3.7c — under level 2 tmux also re-encodes `ctrl-c` as
`CSI 27 ; 5 ; 99 ~`, where under level 1 it stays the single byte `0x03`.

Both requests go to every terminal, because a terminal that implements neither
ignores both and asking costs nothing. That includes tmux older than 3.5,
which has no way for a program to ask at all: the capability arrived in 3.5,
and before that `extended-keys` only makes tmux send extended keys unasked.
The usage page now carries that matrix, because "set this option" is not a
useful answer on a release where the option cannot help. There is no tmux branch anywhere in the
renderer and nothing new to detect at runtime: the same two sequences are sent
whether or not a multiplexer is present, and both are released in reverse order on
exit, so no keyboard mode survives this process.

This does not change what the interface advertises. `ctrl-enter` is still never
offered, because a terminal that cannot distinguish it is still allowed to send a
bare carriage return, and nothing here can tell the two apart at runtime.

`tools/keyprobe.mjs` now reports the whole chain rather than only the bytes:
`TERM`, `TERM_PROGRAM`, whether `TMUX` and SSH are present, and — when there is a
multiplexer to ask — its version, its `extended-keys` and key format options, and
whether **it** accepted the request. SSH variable values are reported as presence
only, and a missing, hanging, or absent tmux cannot break the probe.
