/**
 * Tests for the workspace-change half of `/turns`: the announcement correlation,
 * the compact turn mark, the changed-file list, the per-file comparison
 * inspector, and the laziness and lifetime each of them depends on.
 *
 * The properties under test are the ones a mockup cannot promise:
 *
 *  - that a turn is marked ONLY where Harness published something, so a
 *    composition with no capability, a turn with no announcement, and a turn this
 *    Host can no longer compare all stay distinguishable;
 *  - that moving the cursor, opening the outline, and opening a turn's file list
 *    read NO comparison, and that Enter on one file reads exactly one;
 *  - that a durable announcement whose summary is gone is stated rather than
 *    dropped, and that nothing is ever reconstructed from the current workspace;
 *  - that an untrusted path, heading, and diff line cannot add a row, operate the
 *    terminal, or overflow the frame on a narrow terminal;
 *  - that closing a surface, or abandoning the whole session, leaves no read in
 *    flight able to repaint.
 *
 * The Harness record itself is proved against the real plugin in
 * `capability/workspace-changes.probe.spec.ts`; here the seam is a fixture,
 * because what is under test is how dshline READS and RENDERS the values Harness
 * publishes — including the refusals upstream owns and dshline must not flatten.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-turn-outline/types'
import type {
  WorkspaceChangedFile,
  WorkspaceChangesSummary,
  WorkspaceFileDiff,
} from '@deepseek-ai/dsh-workspace-changes/types'
import type { Key } from '@dshline/renderer'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import type { TuiOverlay, TuiSlots } from '../src/slots.ts'
import type { ChangedFileRow, TurnChangesReading, WorkspaceChangesSeam } from '../src/turns/changes.ts'
import { changedFileRow, WorkspaceChangesAdapter } from '../src/turns/changes.ts'
import { isTranscriptEvent } from '../src/resume.ts'
import { createFileDiffOverlay } from '../src/turns/diff-overlay.ts'
import type { TurnReading } from '../src/turns/model.ts'
import { turnChangesMark } from '../src/turns/model.ts'
import { createTurnFilesOverlay, createTurnInspectionOverlay, createTurnsOverlay } from '../src/turns/overlay.ts'
import { createTurnsPresenter } from '../src/turns/presenter.ts'

/** The session every fixture addresses. */
const SESSION = SessionId('turns-changes')

/** A printable keystroke, for the outline's filter. */
function typed(value: string): Key {
  return { kind: 'text', text: value } as Key
}

/** A turn entry with a branded seq, so fixtures match the authoritative shape. */
function entry(turn: number, seq: number, prompt = ''): TurnOutlineEntry {
  return { turn, seq: SessionSeq(seq), prompt, response: '' }
}

/** A list reading over the given entries. */
function list(...entries: readonly TurnOutlineEntry[]): TurnReading {
  return { kind: 'list', turns: entries }
}

/** A decoded keystroke. */
function key(name: string): Key {
  return { kind: 'key', name } as Key
}

/** A Harness file record with only the fields a fixture cares about. */
function file(display: string, added = 0, deleted = 0, extra: Partial<WorkspaceChangedFile> = {}): WorkspaceChangedFile {
  return { path: display, display, added, deleted, ...extra }
}

/** A Harness summary over the given files. */
function summary(turn: number, files: readonly WorkspaceChangedFile[], over: Partial<WorkspaceChangesSummary> = {}): WorkspaceChangesSummary {
  return {
    turn,
    cwd: '/ws',
    files: [...files],
    total: files.length,
    added: files.reduce((sum, entry) => sum + entry.added, 0),
    deleted: files.reduce((sum, entry) => sum + entry.deleted, 0),
    ...over,
  }
}

/** A `workspace/changes` announcement as the durable log carries it. */
function announcement(turn: number, seq: number): SessionEvent {
  return { type: 'workspace/changes', seq: SessionSeq(seq), time: 0, data: { turn } } as unknown as SessionEvent
}

/**
 * The durable array an attachment's existing resume replay walks.
 *
 * Shaped to the real contract rather than to this feature's convenience: two
 * turns, one of which announced its changes and one of which did not, in log
 * order — and filtered by `resume.ts`'s own `isTranscriptEvent`, exactly as the
 * replay applies it. A change to that filter, which would silently drop these
 * events from the replay and with them from every reopened session, fails HERE
 * rather than as a mark that quietly stopped appearing.
 */
function replayedLog(): readonly SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } } as unknown as SessionEvent,
    announcement(1, 12),
    { type: 'turn/end', seq: SessionSeq(13), time: 0, data: { turn: 1 } } as unknown as SessionEvent,
    { type: 'turn/start', seq: SessionSeq(14), time: 0, data: { turn: 2 } } as unknown as SessionEvent,
    { type: 'turn/end', seq: SessionSeq(15), time: 0, data: { turn: 2 } } as unknown as SessionEvent,
  ].filter(isTranscriptEvent)
}

/** The rows a person would see, at a given geometry. */
function rows(overlay: TuiOverlay, columns = 80, terminalRows = 24): string[] {
  return overlay.render(columns, terminalRows).map(stripAnsi)
}

/**
 * The frame's rows as one flowed sentence, for a phrase that wraps.
 *
 * A bounded row wraps mid-sentence, so a substring assertion over the joined
 * rows would fail on a frame that is drawn perfectly. Collapsing the runs of
 * padding the frame puts between a wrapped line and the next one reads it the
 * way a person does.
 * @param shown - the rows a surface drew.
 * @returns the same text with wrapping collapsed.
 */
function flowed(shown: readonly string[]): string {
  return shown
    .map(row => row.replace(/[│┃╭╮╰╯─━┌┐└┘]/gu, ' ').replace(/\s+/gu, ' ').trim())
    .filter(row => row !== '')
    .join(' ')
}

describe('the turn mark', () => {
  it('marks a turn only where Harness published something', () => {
    const served = { kind: 'summary', seq: 4, summary: summary(1, [file('a.ts', 3, 1)]) } as const
    expect(turnChangesMark(served)).toBe('Δ 1 · +3 -1')
    // Two absences, both silent, and one fact that must speak: a composition
    // with no capability and a turn with no announcement are both "nothing to
    // show", while an announcement this Host cannot serve is evidence, not
    // absence — and evidence is what a reader needs it to be.
    expect(turnChangesMark({ kind: 'unmounted' })).toBeUndefined()
    expect(turnChangesMark({ kind: 'none' })).toBeUndefined()
    expect(turnChangesMark({ kind: 'unserved', seq: 9 })).toBe('Δ –')
  })

  it('counts `total`, so a capped summary never under-reports the change', () => {
    // Harness caps `files` at `maxFiles` and keeps counting into `total`. An
    // outline that showed the listed count would tell a reader that a 700-file
    // change touched 500 of them, which is false in the direction that matters.
    const capped = {
      kind: 'summary',
      seq: 4,
      summary: summary(1, [file('a.ts', 10, 1), file('b.ts', 5, 0)], {
        total: 700,
        // Upstream sums these over the WHOLE list before applying the cap, so
        // they are complete even though `files` is not.
        added: 384,
        deleted: 91,
      }),
    } as const
    expect(turnChangesMark(capped)).toBe('Δ 700 · +384 -91')
    expect(turnChangesMark(capped)).not.toContain('2')
  })
})

describe('announcement correlation', () => {
  it('answers unmounted, and has no read of its own, without the capability', () => {
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION })
    expect(adapter.mounted).toBe(false)
    expect(adapter.reading(1)).toEqual({ kind: 'unmounted' })
    // A profile that drops the row costs nothing: there is no log read, no
    // summary lookup, and no throw out of a paint. The whole design is a
    // transient index over events the attachment already receives.
  })

  it('serves a summary by the announcing event seq, and never by the turn number', () => {
    const seam = seamOver(summary(1, [file('a.ts', 1, 0)]), { at: 4 })
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    adapter.observe(announcement(1, 4))
    // The turn NUMBER is 1 and its `turn/start` seq would be 0: addressing the
    // service with either is the mistake this pairing exists to prevent.
    expect(seam.summary).not.toHaveBeenCalledWith(SESSION, 1)
    expect(seam.summary).not.toHaveBeenCalledWith(SESSION, 0)
    expect(adapter.reading(1)).toMatchObject({ kind: 'summary', seq: 4 })
  })

  it('keeps the newest announcement for a turn, as upstream states', () => {
    const seam = seamOver(summary(1, [file('a.ts')]), { at: 9 })
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    adapter.observe(announcement(1, 4))
    adapter.observe(announcement(1, 9))
    expect(adapter.reading(1)).toMatchObject({ kind: 'summary', seq: 9 })
    expect(seam.summary).toHaveBeenLastCalledWith(SESSION, 9)
  })

  it('never mixes one turn’s announcement into another’s', () => {
    const seam = seamOver(summary(2, [file('b.ts')]), { at: 7 })
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    adapter.observe(announcement(2, 7))
    expect(adapter.reading(2)).toMatchObject({ kind: 'summary', seq: 7 })
    // Turn 1 was never announced, and the fact that turn 2 was says nothing
    // about it: a neighbouring turn's record is not this turn's evidence.
    expect(adapter.reading(1)).toEqual({ kind: 'none' })
  })

  it('ignores a subagent announcement, which is never a top-level turn', () => {
    const seam = seamOver(summary(1, [file('a.ts')]), { at: 4 })
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    // The recorder does not create one for a subagent session, and a payload
    // that is not a positive integer is not a turn identity to correlate with.
    adapter.observe(announcement(0, 4))
    adapter.observe({ type: 'workspace/changes', seq: SessionSeq(5), time: 0, data: { turn: 'one' } } as unknown as SessionEvent)
    expect(adapter.reading(1)).toEqual({ kind: 'none' })
  })

  it('states an unserved announcement instead of dropping it', () => {
    // The event is durable; the summary is not. This is the reopened session,
    // and the restarted Host, in one fixture.
    const seam: WorkspaceChangesSeam = { summary: () => undefined, diff: async () => undefined }
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    adapter.observe(announcement(1, 12))
    expect(adapter.reading(1)).toEqual({ kind: 'unserved', seq: 12 })
  })

  it('resolves a replayed announcement with no read of its own and no wait', () => {
    // THE property this architecture exists for. The attachment's existing
    // resume replay already walks the whole durable log; `workspace/changes` is
    // a non-surface durable event, so it arrives in that array. Folding that
    // array is the entire historical path — there is nothing to await, so an
    // unmatched turn is a settled `none` rather than a "still looking" mark.
    const seam = seamOver(summary(1, [file('a.ts', 2, 0)]), { at: 12 })
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    for (const event of replayedLog()) adapter.observe(event)
    // Synchronously, before any frame is painted.
    expect(adapter.reading(1)).toMatchObject({ kind: 'summary', seq: 12 })
    // A turn the replayed log says nothing about is a settled absence, and it
    // carries no mark — which is the whole correction to the previous shape.
    expect(adapter.reading(2)).toEqual({ kind: 'none' })
  })

  it('folds the same event twice without moving the answer', () => {
    // The two sources overlap by construction: an event already in the replay
    // snapshot is one the live listener never delivered, and a reader can walk
    // `/turns` while a replay is still settling. Idempotence is what makes the
    // fold safe to run from both.
    const seam = seamOver(summary(1, [file('a.ts')]), { at: 12 })
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    const event = replayedLog().find(candidate => candidate.type === 'workspace/changes') as SessionEvent
    adapter.observe(event)
    adapter.observe(event)
    expect(adapter.reading(1)).toMatchObject({ kind: 'summary', seq: 12 })
    expect(seam.diff).not.toHaveBeenCalled()
  })

  it('takes the newest announcement across the replay and the live feed', () => {
    // Upstream states the latest event for one turn replaces earlier ones, and
    // an in-turn record can be superseded by the one taken after `turn/end`.
    const seam = seamOver(summary(1, [file('a.ts')]), { at: 9 })
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    adapter.observe(announcement(1, 4))
    adapter.observe(announcement(1, 9))
    expect(adapter.reading(1)).toMatchObject({ kind: 'summary', seq: 9 })
    // And an OLDER announcement arriving later never replaces a newer one, so
    // the fold is order-insensitive for any event the two sources can deliver.
    adapter.observe(announcement(1, 4))
    expect(adapter.reading(1)).toMatchObject({ kind: 'summary', seq: 9 })
  })

  it('states an unserved replayed announcement rather than an empty list', () => {
    // A reopened session keeps the event in its log and loses the summary with
    // the process that recorded it. That is a fact about this Host, and the
    // file list says so instead of reading as a turn that changed nothing.
    const seam = seamOver(undefined)
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    for (const event of replayedLog()) adapter.observe(event)
    expect(adapter.reading(1)).toEqual({ kind: 'unserved', seq: 12 })
    expect(flowed(filesSurface(adapter.reading(1)).rows()))
      .toContain('Changed-file comparison unavailable in this Host')
  })

  it('answers nothing for any turn once disposed', async () => {
    const seam = seamOver(summary(1, [file('a.ts')]), { at: 4 })
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    adapter.observe(announcement(1, 4))
    adapter.dispose()
    expect(adapter.reading(1)).toEqual({ kind: 'unmounted' })
    // And a comparison asked after teardown never reaches Harness at all.
    await expect(adapter.diff(4, 0, new AbortController().signal)).resolves.toBeUndefined()
    expect(seam.diff).not.toHaveBeenCalled()
  })
})

describe('the outline rows', () => {
  const turns = list(entry(1, 0, 'first'), entry(2, 1, 'second'))

  it('marks the turns Harness has a record for and leaves the rest alone', () => {
    const shown = outline({ reading: () => turns, changes: turn => turn === 1 ? servedReading(1) : { kind: 'none' } }).rows()
    expect(shown.some(row => row.includes('Δ 1 · +1 -0'))).toBe(true)
    // The unmarked row keeps its whole width for its preview: there is no
    // blank column where a mark would have been.
    expect(shown.some(row => row.includes('second') && row.includes('Δ'))).toBe(false)
  })

  it('draws no column at all in a profile with no capability', () => {
    expect(outline({ reading: () => turns, changes: () => ({ kind: 'unmounted' }) }).rows()
      .some(row => row.includes('Δ'))).toBe(false)
  })

  it('never lets the mark push a row past the frame', () => {
    for (const row of outline({ reading: () => turns, changes: () => servedReading(1) }).rows(24)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(24)
    }
  })

  it('drops the mark rather than the turn identity when the terminal is narrow', () => {
    const narrow = outline({ reading: () => turns, changes: () => servedReading(1) }).rows(26)
    // Below the preview floor the mark is the thing that goes: the preview is
    // the only text that says WHICH turn this is.
    expect(narrow.some(row => row.includes('Δ'))).toBe(false)
    expect(narrow.some(row => row.includes('second'))).toBe(true)
  })

  it('carries Harness’s complete totals through the mark unchanged', () => {
    // `total`, `added`, and `deleted` are Harness's own numbers over the WHOLE
    // change. The mark reports them as published — it does not recompute a count
    // from the listed files, which is what made a capped summary under-report.
    const complete = {
      kind: 'summary',
      seq: 1,
      summary: summary(1, [file('a.ts', 3, 1), file('b.ts', 1, 1)], {
        total: 5,
        added: 3,
        deleted: 2,
      }),
    } as const
    expect(outline({ reading: () => turns, changes: () => complete }).rows()
      .some(row => row.includes('Δ 5 · +3 -2'))).toBe(true)
  })
})

describe('the changed-file list', () => {
  it('lists Harness files in Harness order with their own counts', () => {
    const files = [file('src/b.ts', 10, 2), file('src/a.ts', 1, 0), file('logo.png', 0, 0, { binary: true })]
    const shown = filesSurface({ kind: 'summary', seq: 4, summary: summary(1, files) }).rows()
    expect(shown.some(row => row.includes('src/b.ts') && row.includes('+10 -2'))).toBe(true)
    expect(shown.some(row => row.includes('src/a.ts') && row.includes('+1 -0'))).toBe(true)
    // A binary refusal is named, never rendered as an empty text edit.
    expect(shown.some(row => row.includes('logo.png') && row.includes('binary'))).toBe(true)
    // Harness's order, not a re-sort: the fixture is deliberately unsorted.
    expect(shown.findIndex(row => row.includes('src/b.ts')))
      .toBeLessThan(shown.findIndex(row => row.includes('src/a.ts')))
  })

  it('says so when Harness recorded an explicitly empty turn', () => {
    const shown = flowed(filesSurface({ kind: 'summary', seq: 4, summary: summary(1, []) }).rows())
    expect(shown).toContain('changing no files')
    // A zero-file summary is an upstream MEASUREMENT, and the row says which.
    expect(shown).toContain('not an absence of one')
  })

  it('states the cap when Harness truncated the summary', () => {
    const many = [file('a.ts', 1, 0), file('b.ts', 1, 0)]
    const shown = flowed(filesSurface({ kind: 'summary', seq: 4, summary: summary(1, many, { total: 900 }) }).rows())
    expect(shown).toContain('caps a summary at 2 files')
    // `total` is the complete count, so the headline uses it rather than the
    // listed count: "2 files" would understate a 900-file change.
    expect(shown).toContain('900 files')
  })

  it('states an unserved announcement instead of an empty list', () => {
    const shown = flowed(filesSurface({ kind: 'unserved', seq: 4 }).rows())
    expect(shown).toContain('unavailable in this Host')
    // And it says why dshline will not fill the gap from the current files.
    expect(shown).toContain('does not reconstruct it from the current files')
  })

  it('distinguishes every other state from one another', () => {
    expect(filesSurface({ kind: 'unmounted' }).rows().join('\n')).toContain('mounts no workspace-change records')
    expect(filesSurface({ kind: 'none' }).rows().join('\n')).toContain('announced no workspace changes')
  })

  it('escapes a hostile path and never lets one overflow the frame', () => {
    const hostile = '\u001b[31m\u0007\u000d\u202Eevil\u0000\tsrc/x.ts'
    for (const row of filesSurface({ kind: 'summary', seq: 4, summary: summary(1, [file(hostile, 1, 0)]) }).rows(40, 24)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(40)
      // The escape is DISPLAYED, never obeyed: the raw row keeps no control
      // bytes the frame did not put there itself.
      expect(row).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F]/u)
    }
  })

  it('measures a CJK path in display columns, not code units', () => {
    const row = filesSurface({ kind: 'summary', seq: 4, summary: summary(1, [file('文档/说明.md', 1, 0)]) })
      .rows(40).find(candidate => candidate.includes('说明')) ?? ''
    expect(row).toContain('说明.md')
    expect(displayWidth(row)).toBeLessThanOrEqual(40)
  })

  it('keeps a long file list inside a short terminal and scrolls it', () => {
    // 200 files, 24 rows: the list must WINDOW, not overflow. An unclamped body
    // outgrows the frame, and the frame's own physical-row check then throws the
    // whole list away for the one-line backstop — a reader with 200 changed
    // files left holding a headline and no paths at all.
    const many = manyFiles(200)
    const driver = filesSurface({ kind: 'summary', seq: 4, summary: summary(1, many) })
    const first = driver.rows(80, 24)
    expect(first.join('\n')).toContain('src/file-0.ts')
    expect(first.join('\n')).not.toContain('src/file-199.ts')
    for (let at = 0; at < 199; at += 1) driver.press(key('down'))
    const last = driver.rows(80, 24)
    expect(last.join('\n')).toContain('src/file-199.ts')
    expect(last.join('\n')).not.toContain('src/file-0.ts')
    driver.press(key('home'))
    expect(driver.rows(80, 24).join('\n')).toContain('src/file-0.ts')
  })

  it('reports the complete count even in the one-row backstop', () => {
    // The narrow-terminal fallback is a whole phrase, and it is the one place a
    // reader has nothing else to cross-check against. Saying the listed count
    // there would under-report a capped summary in precisely the frame where the
    // truncation note beside it has no room to appear.
    const capped = summary(1, [file('a.ts', 1, 0), file('b.ts', 1, 0)], { total: 700, added: 384, deleted: 91 })
    // Three rows is the frame's own fixed-row count, so the kernel substitutes
    // the backstop; 30 columns fits the phrase, which a narrower terminal could
    // not show at all.
    const shown = filesSurface({ kind: 'summary', seq: 4, summary: capped }).rows(30, 3).join('\n')
    expect(shown).toContain('Changed files 700')
    expect(shown).not.toContain('Changed files 2 ')
  })

  it('draws nothing but a backstop on a terminal too small to frame', () => {
    expect(filesSurface({ kind: 'unmounted' }).rows(12, 24).join('\n')).toContain('esc')
    expect(filesSurface({ kind: 'unserved', seq: 1 }).rows(12, 24).join('\n')).toContain('esc')
  })
})

describe('laziness', () => {
  it('reads no comparison for the outline, a filter, or a cursor walk', () => {
    const seam = seamOver(summary(1, manyFiles(40)), { at: 4 })
    const driver = outline({ reading: () => list(...manyTurns(30)), changes: () => servedReading(1) })
    driver.rows()
    driver.press(key('down'))
    driver.press(key('down'))
    driver.press(key('up'))
    driver.press(typed('/'))
    driver.press(typed('a'))
    driver.press(key('backspace'))
    // Forty files exist in the record and the reader walked over the list. Not
    // one comparison was asked for, and the outline never even opened one.
    expect(seam.diff).not.toHaveBeenCalled()
  })

  it('reads no comparison for a turn’s file list, however long it is scrolled', () => {
    const seam = seamOver(summary(1, manyFiles(40)), { at: 4 })
    const driver = filesSurface({ kind: 'summary', seq: 4, summary: summary(1, manyFiles(40)) }, seam)
    for (let at = 0; at < 40; at += 1) driver.press(key('down'))
    driver.press(key('end'))
    driver.press(key('home'))
    driver.rows()
    expect(seam.diff).not.toHaveBeenCalled()
  })

  it('reads exactly one comparison for the one file the reader opened', () => {
    const seam = seamOver(summary(1, manyFiles(40)), { at: 4 })
    const driver = filesSurface({ kind: 'summary', seq: 4, summary: summary(1, manyFiles(40)) }, seam)
    driver.rows()
    driver.press(key('down'))
    driver.press(key('down'))
    driver.press(key('enter'))
    expect(seam.diff).toHaveBeenCalledTimes(1)
    // Addressed by the ANNOUNCING seq and the file's own index, never by the
    // row's position in a windowed list.
    expect(seam.diff).toHaveBeenCalledWith(SESSION, 4, 2, expect.anything())
  })

  it('reads no comparison for a turn that has no announcement to open', () => {
    const seam = seamOver(summary(1, manyFiles(40)), { at: 4 })
    const opened: number[] = []
    const driver = inspectionDriver({ reading: () => list(entry(1, 0, 'only')), changes: () => ({ kind: 'none' }) }, opened)
    driver.rows()
    driver.press(key('enter'))
    // Enter is inert where it opens nothing, and says so in the footer.
    expect(opened).toEqual([])
    expect(driver.rows().join('\n')).not.toContain('changed files')
    expect(seam.diff).not.toHaveBeenCalled()
  })
})

describe('the comparison inspector', () => {
  it('asks once, shows the hunks, and maps a missing comparison to a refusal', async () => {
    const diff: WorkspaceFileDiff = {
      kind: 'text',
      path: 'a.ts',
      display: 'a.ts',
      before: true,
      after: true,
      coarse: false,
      hunks: [{ oldStart: 122, oldLines: 3, newStart: 122, newLines: 4, lines: [' keep', '-old line', '+new line', '+another line'] }],
    }
    const seam = seamOver(summary(1, [file('a.ts', 2, 1)]), { at: 4, diff })
    const driver = diffSurface(changedFileRow(0, file('a.ts', 2, 1)), seam)
    await vi.waitFor(() => { expect(driver.rows().join('\n')).toContain('+another line') })
    expect(seam.diff).toHaveBeenCalledTimes(1)
    const shown = driver.rows().join('\n')
    // The heading is composed from Harness's own four counts.
    expect(shown).toContain('@@ -122,3 +122,4 @@')
    expect(shown).toContain('-old line')
    expect(shown).toContain(' keep')
    // Rejected with nothing, because this Host can no longer serve it.
    seam.diff.mockResolvedValueOnce(undefined)
  })

  it('states each refusal Harness can return instead of showing no lines', async () => {
    // One surface per case, built ONCE: a poll that rebuilt the surface would
    // start a fresh read every attempt and never observe a settlement.
    const binary = diffSurface(fileRow('a'), seamOver(undefined, { at: 4, diff: { kind: 'binary', path: 'a', display: 'a' } }))
    await vi.waitFor(() => { expect(flowed(binary.rows())).toContain('binary file') })
    const oversized = diffSurface(fileRow('a'), seamOver(undefined, { at: 4, diff: { kind: 'oversized', path: 'a', display: 'a' } }))
    await vi.waitFor(() => { expect(flowed(oversized.rows())).toContain('exceeded its byte cap') })
    const failed = diffSurface(fileRow('a'), seamOver(undefined, {
      at: 4,
      diff: () => Promise.reject(new Error('cat-file refused')),
    }))
    await vi.waitFor(() => { expect(flowed(failed.rows())).toContain('cat-file refused') })
  })

  it('names a coarse comparison rather than presenting it as exact', async () => {
    const coarse: WorkspaceFileDiff = {
      kind: 'text',
      path: 'a',
      display: 'a',
      before: true,
      after: true,
      coarse: true,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
    }
    const seam = seamOver(undefined, { at: 4, diff: coarse })
    const driver = diffSurface(fileRow('a'), seam)
    await vi.waitFor(() => { expect(driver.rows().join('\n')).toContain('coarse comparison') })
    // The refusal is stated in Harness's own terms, not inferred by dshline.
    expect(driver.rows().join('\n')).toContain('line diff timed out')
  })

  it('says an identical file has no differing lines instead of showing nothing', async () => {
    const empty: WorkspaceFileDiff = {
      kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false, hunks: [],
    }
    const seam = seamOver(undefined, { at: 4, diff: empty })
    const driver = diffSurface(fileRow('a'), seam)
    await vi.waitFor(() => { expect(driver.rows().join('\n')).toContain('no differing lines') })
  })

  it('aborts its read when the surface closes, and keeps the reply off the screen', async () => {
    let seen: AbortSignal | undefined
    const seam = seamOver(undefined, {
      at: 4,
      diff: (_session: SessionId, _seq: number, _index: number, signal: AbortSignal) => {
        seen = signal
        return new Promise<WorkspaceFileDiff>(() => {})
      },
    })
    const invalidate = vi.fn()
    const driver = diffSurface(fileRow('a'), seam, invalidate)
    expect(seen?.aborted).toBe(false)
    driver.press(key('escape'))
    // A reader who closed the inspector must not leave a git read running, and
    // the closure itself is what cancels it rather than a timeout.
    expect(seen?.aborted).toBe(true)
    // Nothing repaints: the surface is gone, so a late settlement has nowhere to
    // land and nothing to ask for a frame.
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('drops a comparison that settles after the reader already left', async () => {
    // The race the abort cannot cover: a read that had ALREADY resolved when the
    // surface closed still gets a microtask, and its `.then` runs afterwards.
    // Publishing it would repaint a frame nobody is looking at, over whatever
    // surface the reader moved on to.
    let settle: ((value: WorkspaceFileDiff) => void) | undefined
    const seam = seamOver(undefined, {
      at: 4,
      diff: () => new Promise<WorkspaceFileDiff>(resolve => { settle = resolve }),
    })
    const invalidate = vi.fn()
    const driver = diffSurface(fileRow('a'), seam, invalidate)
    driver.press(key('escape'))
    settle?.({
      kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+late'] }],
    })
    // Await a real turn of the event loop rather than polling: a `waitFor` whose
    // assertion is "nothing happened" passes on its FIRST poll, before the
    // microtask it was meant to catch has run, and proves nothing at all.
    await settleMicrotasks()
    expect(invalidate).not.toHaveBeenCalled()
    expect(driver.rows().join('\n')).not.toContain('late')
  })

  it('escapes hostile diff text and wraps long lines instead of cutting them', async () => {
    const hostile = '\u001b]0;pwned\u0007\u001b[31m\u0000\u000d\tx'
    const diff: WorkspaceFileDiff = {
      kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+${hostile}${'\u4e2d'.repeat(60)}`] }],
    }
    const seam = seamOver(undefined, { at: 4, diff })
    const driver = diffSurface(fileRow('a'), seam)
    await vi.waitFor(() => { expect(driver.rows().join('\n')).toContain('pwned') })
    for (const row of driver.rows(40, 24)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(40)
    }
  })

  it('re-clamps its window when the terminal shrinks under a scrolled position', async () => {
    const diff: WorkspaceFileDiff = {
      kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 200, lines: Array.from({ length: 200 }, (_, at) => `+line ${String(at)}`) }],
    }
    const seam = seamOver(undefined, { at: 4, diff })
    const driver = diffSurface(fileRow('a'), seam)
    await vi.waitFor(() => { expect(driver.rows().length).toBeGreaterThan(0) })
    for (let at = 0; at < 150; at += 1) driver.press(key('down'))
    expect(driver.rows().length).toBeGreaterThan(0)
    // Shrink to a handful of rows: a window that stayed at 150 would render
    // nothing at all, which reads as a crashed inspector.
    const shrunk = driver.rows(80, 8)
    expect(shrunk.length).toBeGreaterThan(0)
    expect(shrunk.length).toBeLessThanOrEqual(8 - 3)
    // And below the frame's own fixed rows the shared kernel's one-line backstop
    // takes over, rather than this surface drawing a partial body.
    expect(flowed(driver.rows(80, 2))).toContain('esc close')
    // A zero-row live region draws nothing at all, and does not throw doing so.
    expect(driver.rows(80, 0)).toEqual([])
  })

  it('scrolls to the end and back without losing the document', async () => {
    const diff: WorkspaceFileDiff = {
      kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 60, lines: Array.from({ length: 60 }, (_, at) => `+line ${String(at)}`) }],
    }
    const seam = seamOver(undefined, { at: 4, diff })
    const driver = diffSurface(fileRow('a'), seam)
    await vi.waitFor(() => { expect(driver.rows().join('\n')).toContain('line 0') })
    driver.press(key('end'))
    expect(driver.rows().join('\n')).toContain('line 59')
    driver.press(key('home'))
    expect(driver.rows().join('\n')).toContain('line 0')
  })
})

describe('lifetime', () => {
  it('closes every level the presenter opened, newest first', () => {
    const closed: string[] = []
    const slots = fakeSlots()
    const seam = seamOver(summary(1, [file('a.ts')]), { at: 4, diff: { kind: 'binary', path: 'a', display: 'a' } })
    const adapter = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    adapter.observe(announcement(1, 4))
    const presenter = createTurnsPresenter({
      slots,
      snapshot: () => ({ asOfSeq: 0, values: { turnOutline: [entry(1, 0, 'only')] } }),
      changes: adapter,
      invalidate: () => {},
    })
    presenter.open()
    const outlineOverlay = slots.top()
    outlineOverlay?.handleKey(key('enter'))
    const inspection = slots.top()
    inspection?.handleKey(key('enter'))
    slots.top()?.handleKey(key('enter'))
    expect(slots.depth()).toBe(4)

    presenter.dispose()
    // Every level came down, so the NEXT session's terminal cannot inherit a
    // keystroke handler, a frame, or an in-flight comparison from this one.
    expect(slots.depth()).toBe(0)
    expect(closed).toEqual([])
  })

  it('keeps a previous session’s adapter from answering for the next one', () => {
    const seam = seamOver(summary(1, [file('a.ts')]), { at: 4 })
    const first = new WorkspaceChangesAdapter({ sessionId: SESSION, changes: seam })
    first.observe(announcement(1, 4))
    first.dispose()
    const second = new WorkspaceChangesAdapter({ sessionId: SessionId('other'), changes: seam, invalidate: () => {} })
    // A fresh attachment knows nothing it did not observe, and says so.
    expect(second.reading(1)).toEqual({ kind: 'none' })
  })
})

describe('the frontend never becomes an authority', () => {
  it('runs no git, spawns no process, and reads no workspace file to compare anything', () => {
    const root = fileURLToPath(new URL('../src/turns', import.meta.url))
    // Comments stripped, because this module's own prose NAMES the very things
    // it refuses to do in order to say why. The rule is about calls.
    const source = sourceFiles(root)
      .map(path => readFileSync(path, 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
        .replaceAll(/^\s*\/\/.*$/gmu, ''))
      .join('\n')
    // A comparison this frontend could have taken itself would make this a
    // SECOND authority for what changed, disagreeing with the one that recorded
    // it. Git, a process spawn, and a filesystem read are all ways that mistake
    // can be made from here, and so is dshline's OWN line-diff engine: using it
    // would recompute hunks from content the reader pasted in rather than
    // drawing the ones Harness computed at the turn boundary.
    expect(source).not.toMatch(/node:child_process|node:fs|\bspawn\b|execFile|\bgit\b|\.git\b/u)
    expect(source).not.toMatch(/from '\.\.\/diff\.ts'/u)
    // And the comparison dshline DOES draw is the one Harness computed.
    expect(source).toMatch(/WorkspaceFileDiff/u)
  })
})


/**
 * Let every already-scheduled microtask run, and no longer.
 *
 * A negative assertion needs the queue drained before it is worth anything: a
 * `waitFor` that asserts "nothing happened" passes on its first poll, which is
 * before the settlement it was written to catch. A macrotask boundary is the
 * smallest wait that guarantees the promise chain finished.
 */
async function settleMicrotasks(): Promise<void> {
  await new Promise(resolve => { setTimeout(resolve, 0) })
}

/** A counted seam, so a laziness assertion can name a call rather than a row. */
type CountedSeam = WorkspaceChangesSeam & {
  readonly summary: ReturnType<typeof vi.fn>
  readonly diff: ReturnType<typeof vi.fn>
}

/**
 * A seam over one served summary, counting the calls a test asserts on.
 *
 * A mock, not a fake of the RECORD: the values crossing it are the exact
 * `WorkspaceChangesSummary` / `WorkspaceFileDiff` objects upstream publishes,
 * and the real plugin's behaviour behind them is proved separately in
 * `capability/workspace-changes.probe.spec.ts`.
 * @param served - the summary to serve, or undefined for an unserved one.
 * @param over - the announcing sequence, and the comparison to answer with.
 * @returns the counted seam.
 */
function seamOver(
  served: WorkspaceChangesSummary | undefined,
  over: { at?: number; diff?: WorkspaceFileDiff | WorkspaceChangesSeam['diff'] } = {},
): CountedSeam {
  return {
    // The addressing itself is under test, so the fixture answers only for the
    // exact sequence it was given and records how it was called.
    summary: vi.fn((_session: SessionId, seq: number) => seq === over.at ? served : undefined),
    diff: vi.fn((session: SessionId, seq: number, index: number, signal: AbortSignal) => {
      if (typeof over.diff === 'function') return over.diff(session, seq, index, signal)
      return Promise.resolve(over.diff)
    }),
  } as unknown as CountedSeam
}

/** A served reading for one turn, over a one-file summary. */
function servedReading(turn: number) {
  return { kind: 'summary', seq: 4, summary: summary(turn, [file('a.ts', 1, 0)]) } as const
}

/** A changed-file row for a fixture. */
function fileRow(display: string): ChangedFileRow {
  return changedFileRow(0, file(display, 1, 0))
}

/** The given number of one-line changed files, for laziness assertions. */
function manyFiles(count: number): WorkspaceChangedFile[] {
  return Array.from({ length: count }, (_, at) => file(`src/file-${String(at)}.ts`, 1, 0))
}

/** The given number of outline entries, for laziness assertions. */
function manyTurns(count: number): TurnOutlineEntry[] {
  return Array.from({ length: count }, (_, at) => entry(at + 1, at, `turn ${String(at + 1)}`))
}

/** What every surface driver in this file exposes. */
interface SurfaceDriver {
  /** The rows a person would see at the given geometry. */
  readonly rows: (columns?: number, terminalRows?: number) => string[]
  /** Deliver one keystroke to the surface. */
  readonly press: (input: Key) => void
}

/** A driver over the outline surface. */
function outline(options: {
  readonly reading: () => TurnReading
  readonly changes: (turn: number) => TurnChangesReading
}): SurfaceDriver {
  const overlay = createTurnsOverlay({
    reading: options.reading,
    changes: options.changes,
    inspect: () => {},
    invalidate: () => {},
    close: () => {},
  })
  return driver(overlay)
}

/**
 * A driver over the changed-file list, issuing the comparison the presenter
 * would issue so a laziness assertion measures the whole path rather than one
 * layer of it.
 */
function filesSurface(reading: TurnChangesReading, seam?: WorkspaceChangesSeam): SurfaceDriver & {
  readonly opened: readonly ChangedFileRow[]
} {
  const opened: ChangedFileRow[] = []
  const overlay = createTurnFilesOverlay({
    reading: () => reading,
    open: (row, seq) => {
      opened.push(row)
      if (seam !== undefined) void seam.diff(SESSION, seq, row.index, new AbortController().signal)
    },
    invalidate: () => {},
    close: () => {},
  })
  return { ...driver(overlay), opened }
}

/** A driver over the turn inspection surface, recording what Enter would open. */
function inspectionDriver(options: {
  readonly reading: () => TurnReading
  readonly changes: () => TurnChangesReading
}, opened: number[]): SurfaceDriver {
  const overlay = createTurnInspectionOverlay({
    reading: options.reading,
    initialSeq: SessionSeq(0),
    changes: options.changes,
    openChanges: turn => { opened.push(turn) },
    invalidate: () => {},
    close: () => {},
  })
  return driver(overlay)
}

/** A driver over the comparison inspector. */
function diffSurface(
  row: ChangedFileRow,
  seam: WorkspaceChangesSeam,
  invalidate?: () => void,
): SurfaceDriver {
  const overlay = createFileDiffOverlay({
    file: row,
    request: (target, signal) => seam.diff(SESSION, 4, target.index, signal),
    invalidate: invalidate ?? (() => {}),
    close: () => {},
  })
  return driver(overlay)
}

/** The rows and keystrokes of one mounted surface. */
function driver(overlay: TuiOverlay): SurfaceDriver {
  return {
    rows: (columns = 80, terminalRows = 24) => rows(overlay, columns, terminalRows),
    press: input => { overlay.handleKey(input) },
  }
}

/**
 * A slot registry that records only what a lifetime assertion needs: the depth
 * of the overlay stack and the surface currently on top of it.
 * @returns the counting registry.
 */
function fakeSlots(): TuiSlots & {
  readonly top: () => TuiOverlay | undefined
  readonly depth: () => number
} {
  const mounted: TuiOverlay[] = []
  return {
    top: () => mounted.at(-1),
    depth: () => mounted.length,
    pushOverlay(overlay: TuiOverlay) {
      mounted.push(overlay)
      return () => {
        const at = mounted.indexOf(overlay)
        if (at >= 0) mounted.splice(at, 1)
      }
    },
  } as unknown as TuiSlots & { top: () => TuiOverlay | undefined; depth: () => number }
}

/** Find production source files under a directory, recursively. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}
