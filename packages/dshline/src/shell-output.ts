/**
 * TEMPORARY COMPATIBILITY SHIM for the adopted Harness generation, registered
 * in HARNESS_COMPAT. Confirmed against 0.2.0-rc.2 at
 * 639ed015397290b3745d163aafe02ffee4aa3f84: subprocess-local/src/output.ts
 * readFrom independently decodes each retained byte slice, and bash-local's
 * consuming reader advances through incomplete UTF-8 characters.
 *
 * Independent observed re-reads withhold ALL trailing U+FFFD until repaired or
 * captured-stream settlement. Literal replacement characters therefore incur
 * latency too. UTF-16 prefix counts, not re-encoded byte lengths, prevent
 * duplicates even for malformed bytes. A lossy read skips its uncertain snapshot
 * entirely, flushes the previous tails, and resynchronizes on later text; empty
 * polls cannot clear resynchronization. No spill paths are read or displayed.
 *
 * Removal: when the adopted executor supplies incremental, Unicode-correct
 * observed deltas (including malformed input, EOF and retained-window gaps),
 * delete this re-read adapter and its compatibility record/tests in that adoption.
 * Keep only ordinary bounded line framing and terminal escaping.
 * @module dshline/shell-output
 */
import type { ShellExecution } from '@deepseek-ai/dsh-shell'
import { escapeControls, paint, truncateToWidth } from '@dshline/renderer'

/** Bound an unfinished logical line without cutting a surrogate pair. */
const LINE_CODE_UNITS = 4096
/** Small commit batches keep a newline-heavy capture from making a huge array. */
const EMIT_LINES = 32
/** Both streams share one warning; repeated overflow must not flood scrollback. */
const GAP_WARNING = '[shell output skipped: retained capture window overflowed]'

interface StreamState {
  offset: number
  emitted: number
  resync: boolean
  pending: string
}

function streamState(): StreamState {
  return { offset: 0, emitted: 0, resync: false, pending: '' }
}

/**
 * Bounded, terminal-safe projection of the shell's independent captured streams.
 * Completed rows are logical lines: Screen wraps them at its current width.
 */
export class ShellOutput {
  private readonly stdout = streamState()
  private readonly stderr = streamState()
  private batch: string[] = []
  private warned = false

  /**
   * @param emit - commits completed bounded logical lines through Screen.
   */
  constructor(private readonly emit: (rows: readonly string[]) => void) {}

  /**
   * Read without stealing the executor's consuming cursor.
   * @param readers - public non-consuming stdout/stderr readers.
   * @param ended - true only after done, when captured streams are definitive.
   * @returns nothing; completed lines go to the constructor callback.
   */
  poll(readers: ShellExecution['observed'], ended = false): void {
    this.read(this.stdout, readers.stdout, false, ended)
    this.read(this.stderr, readers.stderr, true, ended)
    this.drain()
  }

  /**
   * Commit remaining framed tails; call poll(readers, true) first at EOF.
   * @returns nothing; tails go to the constructor callback exactly once.
   */
  flush(): void {
    this.tail(this.stdout, false)
    this.tail(this.stderr, true)
    this.drain()
  }

  /**
   * One short unfinished row per stream, never an unbounded wrapped live area.
   * @param columns - current available terminal columns.
   * @returns zero to two escaped, truncated, row-styled rows.
   */
  live(columns: number): string[] {
    const rows: string[] = []
    for (const [state, stderr] of [[this.stdout, false], [this.stderr, true]] as const) {
      if (state.pending.length === 0 || columns <= 0) continue
      const safe = escapeControls(state.pending)
      const row = truncateToWidth(stderr ? `[stderr] ${safe}` : safe, columns)
      rows.push(stderr ? paint(row, 'error') : row)
    }
    return rows
  }

  private read(state: StreamState, reader: ShellExecution['observed']['stdout'], stderr: boolean, ended: boolean): void {
    const snapshot = reader.readFrom(state.offset)
    if (snapshot.lossy) {
      // Joining pre-gap tails to post-gap bytes would fabricate a logical line.
      this.flush()
      if (!this.warned) {
        this.queue(paint(GAP_WARNING, 'warning'))
        this.warned = true
      }
      state.offset = snapshot.nextOffset
      state.emitted = 0
      state.resync = true
      return
    }
    let stableEnd = snapshot.text.length
    if (!ended) {
      while (stableEnd > 0 && snapshot.text.charCodeAt(stableEnd - 1) === 0xfffd) stableEnd -= 1
    }
    let delta = snapshot.text.slice(state.emitted, stableEnd)
    if (state.resync && delta.length > 0) {
      delta = delta.replace(/^\ufffd+/u, '')
      if (delta.length > 0) state.resync = false
    }
    this.frame(state, delta, stderr)
    state.emitted = stableEnd
    if (stableEnd === snapshot.text.length) {
      state.offset = snapshot.nextOffset
      state.emitted = 0
    }
  }

  private frame(state: StreamState, text: string, stderr: boolean): void {
    let cursor = 0
    while (cursor < text.length) {
      const newline = text.indexOf('\n', cursor)
      const end = newline < 0 ? text.length : newline
      while (cursor < end) {
        let take = Math.min(end - cursor, LINE_CODE_UNITS - state.pending.length)
        if (take > 0) {
          const last = text.charCodeAt(cursor + take - 1)
          if (last >= 0xd800 && last <= 0xdbff && cursor + take < end) take -= 1
        }
        if (take === 0) {
          this.tail(state, stderr)
          continue
        }
        state.pending += text.slice(cursor, cursor + take)
        cursor += take
        if (cursor < end && state.pending.length >= LINE_CODE_UNITS - 1) this.tail(state, stderr)
      }
      if (newline < 0) break
      this.queue(this.row(state.pending, stderr))
      state.pending = ''
      cursor += 1
    }
  }

  private row(text: string, stderr: boolean): string {
    const safe = escapeControls(text)
    return stderr ? paint(`[stderr] ${safe}`, 'error') : safe
  }

  private tail(state: StreamState, stderr: boolean): void {
    if (state.pending.length === 0) return
    this.queue(this.row(state.pending, stderr))
    state.pending = ''
  }

  private queue(row: string): void {
    this.batch.push(row)
    if (this.batch.length >= EMIT_LINES) this.drain()
  }

  private drain(): void {
    if (this.batch.length === 0) return
    const batch = this.batch
    this.batch = []
    this.emit(batch)
  }
}
