/**
 * TEMPORARY COMPATIBILITY SHIM for a defect in the adopted Harness generation.
 * Not a dshline abstraction, and it should not grow into one.
 *
 * Registered in `HARNESS_COMPAT`, so the next generation cannot be adopted
 * without someone deciding whether this is still needed. See ## Removal.
 *
 * ## What it contains
 *
 * `Screen` is correct only because it is the sole writer: it remembers how
 * many rows the live region occupies and where it left the cursor, and every
 * redraw climbs that remembered geometry to erase the frame before drawing the
 * next one. A write it did not issue moves the cursor and scrolls the screen
 * behind its back, so from then on the climb starts from the wrong row and
 * `CSI 0J` clears from below the frame's first rows instead of from above
 * them. Those rows are never erased again and stay in native scrollback for
 * good: the root chrome — `╭─ dshline ─… ─╮` — printed a second time, once per
 * commit that follows.
 *
 * dshline enforces that rule for its own code. It cannot enforce it for a
 * plugin writing to file descriptor 2 directly, and a subagent backend in the
 * generation named by `HARNESS_TARGET` does exactly that for the whole life of
 * a delegation:
 *
 * ```ts
 * child.stderr?.on('data', chunk => {
 *   writeFileSync(process.stderr.fd, Buffer.from(chunk))
 * })
 * ```
 *
 * On an interactive launch descriptor 2 is the terminal dshline is drawing on,
 * so the delegated child's diagnostics land inside the composer frame — which
 * is why the duplicate appears the moment a subagent is spawned. Nothing here
 * branches on a provider: what is contained is a WRITE SHAPE, not a vendor.
 *
 * ## Why the descriptor and not the stream
 *
 * Wrapping `process.stderr.write` would not catch the forward, which never
 * goes through the stream. What it does read, on every write, is
 * `process.stderr.fd` — so that is what moves: while the window owns the
 * terminal, the descriptor that property reports is a writable hole, and a raw
 * write through it changes no cell.
 *
 * That leaves the ordinary stream path alone, and the reason is a Node
 * implementation detail rather than anything Node promises. What is actually
 * tested, in real child processes (`tests/stderr-descriptor.spec.ts`), is:
 *
 * - a raw `writeFileSync(process.stderr.fd, …)` follows the substitution, and
 *   the substitution reverses exactly;
 * - a SOCKET-backed `process.stderr` writes through a handle rather than
 *   through the property, so `write` is unaffected. The test drives a pipe; a
 *   terminal is the same stream family (`tty.WriteStream` extends
 *   `net.Socket`) but the suite cannot allocate a pty, so the production case
 *   is inferred from the pipe rather than observed. That inference is the one
 *   thing here taken on trust;
 * - a FILE-backed `process.stderr` is `SyncWriteStream` and DOES re-resolve
 *   the property per write, so holding one would capture ordinary stream
 *   writes too.
 *
 * The third is why {@link rawStderrReach} refusing a non-terminal stderr is
 * load-bearing rather than merely tidy, and it is the stronger of that
 * refusal's two reasons — the other is only that no frame could be corrupted.
 *
 * ## What it deliberately is not
 *
 * Not a capture, tee, or logging sink. Harness owns Host diagnostics and
 * subagent failure reporting; a second sink here would be a second authority
 * over the same bytes. So a raw-descriptor writer's output is DROPPED while
 * the window draws. That costs no failure reporting — a run's own failure
 * reaches the transcript through the subagent lifecycle, never through
 * descriptor 2 — and the dropped bytes were unreadable anyway, because they
 * were landing on top of the frame they corrupted.
 *
 * ## Removal
 *
 * Delete this module, its `ctx.effect` in `./window.ts`,
 * `tests/stderr-descriptor.spec.ts`, the containment half of
 * `tests/foreign-writes.spec.ts`, and this shim's `HARNESS_COMPAT` record,
 * once a generation routes a delegated child's diagnostics through a
 * Host-owned seam — a diagnostic sink, a session event, anything but the
 * frontend's terminal descriptor.
 *
 * The `HARNESS_COMPAT` record is what forces that question to be asked:
 * `node tools/harness-target.mjs` fails while the record names a generation
 * other than the adopted one, and that check runs in the blocking `Harness
 * target` lane, in the Harness-Sync adoption proposal, and at release. It
 * cannot answer the question — confirming the upstream behavior is the
 * adopter's job — it can only refuse to let the migration go green until
 * someone has.
 * @module dshline/stderr
 */

import { closeSync, fstatSync, openSync } from 'node:fs'
import { devNull } from 'node:os'

/**
 * What is KNOWN about whether a raw descriptor-2 write can reach the terminal
 * the live region is drawn on. Three answers, because two of them are facts and
 * the third is the honest absence of one.
 */
type RawStderrReach =
  /** Proven to be the same terminal device the live region is drawn on. */
  | 'reaches'
  /** Proven not to be: not a terminal at all, or a different terminal device. */
  | 'cannot-reach'
  /** Neither could be established on this platform. */
  | 'unknown'

/**
 * The descriptor a stream reports, when it reports a numeric one at all.
 *
 * `NodeJS.WriteStream` does not declare `fd`, and a stand-in may expose it
 * through an accessor, so it is read reflectively rather than cast into
 * existence. A stream with no numeric descriptor is not an error here — it is
 * simply nothing to stat.
 * @param stream - the stream to read.
 * @returns the descriptor, or nothing when there is no numeric one.
 */
function descriptorOf(stream: NodeJS.WriteStream): number | undefined {
  const value: unknown = Reflect.get(stream, 'fd')
  return typeof value === 'number' ? value : undefined
}

/**
 * Whether a raw write to `stderr`'s descriptor can land on `stdout`'s terminal.
 *
 * `isTTY` on both streams does NOT establish this, and the previous version of
 * this check claimed it did. It answers a weaker question — each descriptor is
 * *a* terminal — and two terminals are exactly the case where moving stderr
 * would be an unnecessary mutation of a process global.
 *
 * The stronger question is answerable on POSIX and is asked here: a terminal is
 * a character device, and `fstat`'s `rdev` is the device it is a handle on, so
 * two descriptors on ONE terminal report one non-zero `rdev` and descriptors on
 * two terminals report two. That is a real identity test rather than an
 * inference, and it is what `reaches` and `cannot-reach` are read off.
 *
 * It is not universally available. A Windows console handle is a character
 * device with an `rdev` of zero, which distinguishes nothing, and a stream may
 * report no own descriptor to stat at all. Those answer `unknown` rather than
 * guessing, and the caller decides what to do about not knowing.
 * @param stdout - the stream the live region is drawn on.
 * @param stderr - the stream whose raw descriptor writes are in question.
 * @returns what is known, never a guess dressed as a fact.
 */
export function rawStderrReach(
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): RawStderrReach {
  // Nothing is being drawn on a terminal, or the descriptor in question is not
  // one. Either answer settles it: there is no live region for a raw write to
  // displace, or the write cannot arrive at a terminal to displace it. The
  // second case is also the one where holding would be actively wrong — a
  // file-backed `process.stderr` resolves `this.fd` on every stream write, so
  // substituting it would redirect writes this module has no business
  // redirecting. See the module doc.
  if (stdout.isTTY !== true || stderr.isTTY !== true) return 'cannot-reach'
  const drawn = descriptorOf(stdout)
  const raw = descriptorOf(stderr)
  if (drawn === undefined || raw === undefined) return 'unknown'
  try {
    const drawnStat = fstatSync(drawn)
    const rawStat = fstatSync(raw)
    // A zero `rdev` carries no device identity — Windows consoles report one —
    // so it is read as an absence of evidence rather than as a match.
    if (
      !drawnStat.isCharacterDevice() || !rawStat.isCharacterDevice()
      || drawnStat.rdev === 0 || rawStat.rdev === 0
    ) return 'unknown'
    return drawnStat.rdev === rawStat.rdev ? 'reaches' : 'cannot-reach'
  } catch {
    // A descriptor that cannot be stat'd tells us nothing about where it points.
    return 'unknown'
  }
}

/**
 * Point `process.stderr.fd` at a hole for as long as the window draws.
 *
 * Engaged on `reaches` and on `unknown`, and that asymmetry is the conservative
 * choice made explicit: where the platform cannot prove the two descriptors are
 * different terminals, the frame is protected. The cost of being wrong that way
 * is a dropped raw-descriptor diagnostic on a terminal nobody was drawing on;
 * the cost of being wrong the other way is a corrupted transcript the reader
 * cannot repair. `cannot-reach` is left completely alone, so a `2>log` run, a
 * piped stderr, and a proven second terminal all keep their descriptor exactly
 * as it was found.
 * @param stderr - the stream to hold; the process's own by default.
 * @param stdout - the stream the live region is drawn on; the process's own by
 *   default. Read only to decide whether holding is warranted at all.
 * @returns the disposer restoring the original descriptor; safe to call twice.
 */
export function holdStderrOffTerminal(
  stderr: NodeJS.WriteStream = process.stderr,
  stdout: NodeJS.WriteStream = process.stdout,
): () => void {
  const nothing = (): void => {}
  if (rawStderrReach(stdout, stderr) === 'cannot-reach') return nothing
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
