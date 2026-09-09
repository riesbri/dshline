/**
 * Hold foreign raw writes off the terminal the live region owns.
 *
 * `Screen`'s whole correctness argument is that it is the only writer: it
 * remembers how many rows the live region occupies and where it left the
 * cursor, and every redraw climbs that remembered geometry to erase the frame
 * before drawing the next one. A write it did not issue moves the cursor and
 * scrolls the screen behind its back, and from then on the climb starts from
 * the wrong row — so `CSI 0J` clears from below the frame's first rows instead
 * of from above them. Those rows are never erased again, scroll up as ordinary
 * output, and stay in native scrollback for good. What a reader sees is the
 * root chrome — `╭─ dshline ─… ─╮` — printed a second time, once per commit
 * that follows.
 *
 * dshline can enforce that rule for its own code and does. It cannot enforce it
 * for a plugin that writes to file descriptor 2 directly, and a subagent
 * backend in the adopted Harness generation does exactly that: it forwards a
 * delegated child process's stderr with
 * `writeFileSync(process.stderr.fd, bytes)` for the whole life of the
 * delegation. On an interactive launch descriptor 2 IS the terminal dshline is
 * drawing on, so a delegation's startup diagnostics land inside the composer
 * frame — which is why this shows up the moment a subagent is spawned and not
 * before.
 *
 * Patching `process.stderr.write` would not catch it — the forward never goes
 * through the stream. What it does read, every time, is `process.stderr.fd`. So
 * that is what this moves: while the window owns the terminal, the descriptor
 * that property reports is a writable hole rather than the terminal, and a raw
 * write through it changes no cell. `process.stderr.write` is deliberately left
 * alone, so dshline's own boot-failure reporting still reaches a real stderr,
 * and so does every ordinary stream writer.
 *
 * The cost is stated rather than hidden: a raw-descriptor writer's bytes are
 * dropped instead of being drawn somewhere safe. For the writer this exists to
 * contain that is not a loss of failure reporting — a backend's own run
 * failures reach the transcript through the subagent lifecycle, not through
 * descriptor 2 — and the bytes it was dropping were unreadable anyway, because
 * they were overwriting the input frame they landed in. The real fix belongs
 * upstream, in a backend that should not be writing to a frontend's terminal
 * at all; this only keeps the frame correct until it does.
 * @module dshline/stderr
 */

import { closeSync, openSync } from 'node:fs'
import { devNull } from 'node:os'

/**
 * Point `process.stderr.fd` at a hole for as long as the window draws.
 *
 * Nothing happens unless it would matter. A stderr that is not a terminal — a
 * `2>log` run, a pipe, a test — cannot displace a live region however it is
 * written to, so its descriptor is left exactly as it was found; the same goes
 * for a stream that reports no own `fd` to move, and for a platform with no
 * openable null device.
 * @param stderr - the stream to hold; the process's own by default.
 * @param stdout - the stream the live region is drawn on, used only to decide
 *   whether a raw stderr write could reach it at all.
 * @returns the disposer restoring the original descriptor; safe to call twice.
 */
export function holdStderrOffTerminal(
  stderr: NodeJS.WriteStream = process.stderr,
  stdout: NodeJS.WriteStream = process.stdout,
): () => void {
  const nothing = (): void => {}
  // Both halves are required. A raw write can only corrupt the frame when the
  // frame is on a terminal AND the descriptor being written to is one too;
  // either answer being no makes this an unnecessary mutation of a global.
  if (stdout.isTTY !== true || stderr.isTTY !== true) return nothing
  const original = Object.getOwnPropertyDescriptor(stderr, 'fd')
  // An accessor, or nothing at all, is not a descriptor this may redefine
  // without changing what the property MEANS to whoever defined it.
  if (original === undefined || !('value' in original) || original.configurable !== true) return nothing
  let hole: number
  try {
    hole = openSync(devNull, 'w')
  } catch {
    // No null device to hold the writes. The frame is better off with the
    // corruption than with a boot that fails over a diagnostic sink.
    return nothing
  }
  Object.defineProperty(stderr, 'fd', { ...original, value: hole })
  let released = false
  return () => {
    // Terminal ownership is disposed on several paths, and the descriptor must
    // go back exactly once: redefining it a second time would restore the hole
    // that has already been closed.
    if (released) return
    released = true
    Object.defineProperty(stderr, 'fd', original)
    try {
      closeSync(hole)
    } catch {
      // The descriptor is already gone; the property is what mattered.
    }
  }
}
