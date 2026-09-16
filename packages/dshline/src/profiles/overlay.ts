/**
 * The `/profiles` browser: Harness's profiles, and what each one composes.
 *
 * Two sections, unlike `/plugins`' single flat list, because there genuinely
 * are two things here and one contains the other: the profile roster, and the
 * bundle layers of whichever profile is selected. `connect/overlay.ts` draws
 * two sections for the same reason.
 *
 * Selection walks both as one sequence, so `↑`/`↓` never needs a mode and a
 * bundle operation always has an unambiguous target: every bundle row carries
 * the profile it belongs to.
 *
 * Every profile is expanded rather than one at a time. See
 * {@link selectableRows} for why — inspecting one profile makes the sequence
 * depend on the index that indexes it, and re-pointing it as the cursor moves
 * strands the rows the reader is walking toward.
 *
 * Every keystroke here reports an intent to its owner (`index.ts`); nothing in
 * this module runs a command or reads a directory.
 * @module dshline/profiles/overlay
 */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  SPINNER_INTERVAL_MS,
  spinnerFrame,
  paint,
  tailToWidth,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { SurfaceNotice, noticeText } from '../surface.ts'
import type { SurfaceNoticeReading } from '../surface.ts'
import type { BundleRow, PlainDependencyRow, ProfileRow } from './harness.ts'
import type { ProfilesState } from './catalog.ts'
import type { ProfilesActivityView } from './runtime.ts'
import {
  bundleFacts,
  bundleMark,
  filterProfileRows,
  pendingBuildInstructions,
  plainDependencyFacts,
  profileMark,
  profileTags,
} from './model.ts'

/**
 * Rows outside the scrolling list: the leading blank, two frame borders, the
 * query line, and the spacer.
 */
const PROFILES_FIXED_ROWS = 5

/** Narrowest terminal that can hold the framed list. */
const PROFILES_MIN_COLUMNS = BOX_CHROME_COLUMNS + 30

/** How long a result stays on screen before the list returns. */
const NOTICE_MS = 8_000

/** One selectable line: a profile, one of its bundle layers, or a plain dependency. */
export type ProfilesSelection =
  /** A profile in the roster. */
  | { readonly kind: 'profile'; readonly profile: ProfileRow }
  /** One bundle layer of the inspected profile. */
  | { readonly kind: 'bundle'; readonly profile: ProfileRow; readonly bundle: BundleRow }
  /**
   * One dependency of the profile that is NOT a layer. Selectable so `r` can
   * remove it: an inert install is the commonest thing a reader wants gone.
   */
  | { readonly kind: 'plain'; readonly profile: ProfileRow; readonly dependency: PlainDependencyRow }

/** What the browser needs from its owner. */
export interface ProfilesOverlaySpec {
  /** The current reading of the profile roster. */
  readonly state: () => ProfilesState
  /**
   * What is running and what is waiting on a restart.
   *
   * Read every render rather than pushed as a notice: a pnpm install takes
   * minutes and a notice expires in seconds, so a reader would watch the only
   * evidence of their own install disappear.
   */
  readonly activity: () => ProfilesActivityView
  /** Re-read the roster. */
  readonly refresh: () => void
  /** Install a new bundle into the selected profile. */
  readonly addBundle: (profile: ProfileRow) => void
  /** Update one bundle, or every bundle when no row names one. */
  readonly updateBundle: (profile: ProfileRow, bundle: BundleRow | undefined) => void
  /** Remove one bundle from the selected profile. */
  readonly removeBundle: (profile: ProfileRow, bundle: BundleRow) => void
  /** Remove one non-layer dependency from the selected profile. */
  readonly removeDependency: (profile: ProfileRow, dependency: PlainDependencyRow) => void
  /** Create (or initialize) a profile. */
  readonly createProfile: () => void
  /** Explain how the selected profile is booted. */
  readonly explainBoot: (profile: ProfileRow) => void
  /** Current time, injected so notice expiry is assertable. */
  readonly now: () => number
  /** Remove this overlay from the live region. */
  readonly close: () => void
  /** Redraw after a move or a landed read. */
  readonly invalidate: () => void
}

/**
 * The drawn document, and where its choices landed among the physical rows.
 *
 * `rows` is exactly what {@link RowViewport} scrolls over, so group captions,
 * the selected profile's detail lines, and every entry line count toward its
 * length. `entryRows` narrows that to the profile, bundle, and plain-dependency
 * lines alone — the browser's actual choices — because `more below` must not be
 * earned by a caption or by the selected profile's own detail.
 */
interface Rendered {
  readonly rows: readonly string[]
  readonly selectedRow: number
  readonly entryRows: readonly number[]
}

/** The Profiles overlay, plus what its owner pushes back into it. */
export interface ProfilesOverlay extends TuiOverlay {
  /**
   * Show a result over the list.
   * @param text - the sentence to show.
   * @param failed - whether it reports a refusal.
   */
  report(text: string, failed: boolean): void
  /**
   * Whether the reader has already closed the browser.
   * @returns true once this overlay has closed.
   */
  closed(): boolean
}

/**
 * Create the `/profiles` browser overlay.
 * @param spec - the reading, the action intents, and overlay controls.
 * @returns a temporary live-region overlay that never writes the transcript.
 */
export function createProfilesOverlay(spec: ProfilesOverlaySpec): ProfilesOverlay {
  const viewport = new RowViewport()
  let query = ''
  let selected = 0
  let visible: readonly ProfilesSelection[] = []
  let closed = false
  // The notice owns its own expiry repaint. The running-work heartbeat below
  // invalidates while an install is in flight, but an idle browser has no
  // heartbeat, so this timer is what retires a result on its own.
  const notice = new SurfaceNotice(NOTICE_MS, { now: spec.now, invalidate: spec.invalidate })
  // `/` enters search mode explicitly, for the same reason `/plugins` does:
  // `a`, `u`, `r`, and `n` are bare single-key actions, and a package name is
  // full of all four letters.
  let searching = false
  // Advanced by the ticker below, and read by `activityLines` so the running
  // row animates. Reusing the renderer's own frames and cadence rather than a
  // second spinner vocabulary: the status line already spins this way while a
  // turn runs, and a browser that span differently would read as a different
  // kind of busy.
  let tick = 0
  let ticker: NodeJS.Timeout | undefined
  const stopTicker = (): void => {
    if (ticker === undefined) return
    clearInterval(ticker)
    ticker = undefined
  }
  // Runs only while something is actually running, and stops the moment nothing
  // is: a spinner left turning over finished work says the opposite of the
  // truth, and an overlay that repainted forever would keep redrawing an idle
  // frame for as long as it stayed open.
  const syncTicker = (): void => {
    const busy = spec.activity().running.length > 0
    if (busy && ticker === undefined) {
      // Unref so a spinning timer never keeps the process alive on its own.
      ticker = setInterval(() => {
        tick += 1
        spec.invalidate()
      }, SPINNER_INTERVAL_MS)
      ticker.unref()
      return
    }
    if (!busy) stopTicker()
  }

  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const currentNotice = (): SurfaceNoticeReading | undefined => notice.read()
  const move = (amount: number): void => {
    if (visible.length === 0) return
    selected = (selected + amount + visible.length) % visible.length
    spec.invalidate()
  }
  const edit = (next: string): void => {
    query = next
    selected = 0
    viewport.first()
    spec.invalidate()
  }
  const at = (): ProfilesSelection | undefined => visible[selected]

  return {
    report(text, failed) {
      notice.show(text, failed)
      spec.invalidate()
    },
    closed(): boolean {
      return closed
    },
    mounted() {
      syncTicker()
    },
    dispose() {
      stopTicker()
      notice.dispose()
    },
    render(columns, terminalRows = 24) {
      // Checked here because this is the one place guaranteed to run after the
      // owner's state changes: an operation starting or finishing invalidates,
      // and an invalidate is what produces a render.
      syncTicker()
      const state = spec.state()
      visible = selectableRows(state, query)
      selected = Math.min(selected, Math.max(0, visible.length - 1))
      const active = currentNotice()
      if (columns < PROFILES_MIN_COLUMNS) {
        return compactFallback(state, visible.length, columns, terminalRows, active, spec.activity(), tick)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const header = headerRows(state, inner)
      const activityRows = activityLines(spec.activity(), tick, inner)
      const noticeRows = active === undefined
        ? []
        : wrapToWidth(paint(escapeControls(active.text), active.failed ? 'error' : 'success'), inner)
      const capacity = terminalRows - PROFILES_FIXED_ROWS - header.length
        - activityRows.length - noticeRows.length
      if (capacity <= 0) return compactFallback(state, visible.length, columns, terminalRows, active, spec.activity(), tick)
      const rendered = renderRows(state, visible, selected, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      if (rendered.selectedRow >= viewport.end) viewport.move(rendered.selectedRow - viewport.end + 1)
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint('Profiles', 'overlay-title'),
          body: [
            ...header,
            queryRow(query, searching, counter(visible.length, rendered, viewport), inner),
            ...activityRows,
            ...noticeRows,
            '',
            ...rendered.rows.slice(viewport.start, viewport.end),
          ],
          footer: fitFooterHelp(
            help(searching, query, at(), footerBudget(columns)),
            footerBudget(columns),
          ),
        }),
      ]
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(state, visible.length, columns, terminalRows, active, spec.activity(), tick)
    },
    handleKey(key: Key) {
      if (searching) {
        if (key.kind === 'text') {
          edit(query + key.text)
          return
        }
        if (key.kind === 'paste') {
          edit(query + key.text.replace(/\s+/gu, ' '))
          return
        }
        switch (key.name) {
          case 'up':
            move(-1)
            return
          case 'down':
            move(1)
            return
          case 'backspace':
            edit([...query].slice(0, -1).join(''))
            return
          case 'ctrl-u':
            edit('')
            return
          case 'ctrl-w':
            edit(query.replace(/\s*\S*$/u, ''))
            return
          case 'enter':
          case 'escape':
            searching = false
            spec.invalidate()
            return
          case 'ctrl-c':
            close()
            return
          default:
            return
        }
      }
      if (key.kind === 'text') {
        const row = at()
        switch (key.text) {
          case '/':
            searching = true
            spec.invalidate()
            return
          case 'a':
            if (row !== undefined) spec.addBundle(row.profile)
            return
          case 'u':
            // Only a bundle row, or a profile row meaning "all of them". A
            // plain dependency reached this with `bundle: undefined`, which
            // `performUpdate` reads as update-all — so a cursor resting on one
            // package silently widened into every managed bundle in the
            // profile. A keystroke must never escalate its own scope, and `U`
            // already exists for the wider operation.
            if (row?.kind === 'bundle') spec.updateBundle(row.profile, row.bundle)
            else if (row?.kind === 'profile') spec.updateBundle(row.profile, undefined)
            return
          case 'U':
            if (row !== undefined) spec.updateBundle(row.profile, undefined)
            return
          case 'r':
            if (row?.kind === 'bundle') spec.removeBundle(row.profile, row.bundle)
            else if (row?.kind === 'plain') spec.removeDependency(row.profile, row.dependency)
            return
          case 'n':
            spec.createProfile()
            return
          default:
            return
        }
      }
      if (key.kind === 'paste') return
      switch (key.name) {
        case 'up':
          move(-1)
          return
        case 'down':
          move(1)
          return
        case 'home':
        case 'ctrl-a':
          selected = 0
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          selected = Math.max(0, visible.length - 1)
          viewport.last()
          spec.invalidate()
          return
        case 'enter': {
          // The honest answer to "select this profile": a composed Host cannot
          // swap its bundle layers, so `enter` names the command that boots
          // it rather than pretending to switch. On a bundle it is `u`'s
          // target that matters, so enter explains the profile either way.
          const row = at()
          if (row !== undefined) spec.explainBoot(row.profile)
          return
        }
        case 'ctrl-r':
          spec.refresh()
          return
        case 'escape':
          if (query !== '') {
            edit('')
            return
          }
          close()
          return
        case 'ctrl-c':
          close()
          return
        default:
          return
      }
    },
  }
}

/**
 * The selectable sequence: every profile, each followed by its own bundle
 * layers.
 *
 * Every profile is expanded, and that is a deliberate simplification over
 * inspecting one at a time. Both alternatives were built and both are worse.
 * Expanding only the profile the cursor is on makes the sequence depend on the
 * selection index that indexes it — circular — and re-pointing the expansion
 * as the cursor moves creates a dead end: with the bundles drawn after the
 * whole roster, reaching the first profile's bundles means moving through the
 * second profile's row, which re-points the section away from the bundles the
 * reader was walking toward. A roster is a handful of directories under one
 * home, so showing all of it costs a few rows and owes the reader no mode.
 * @param state - the current reading.
 * @param query - the typed filter.
 * @returns the selectable rows, in draw order.
 */
export function selectableRows(state: ProfilesState, query: string): readonly ProfilesSelection[] {
  if (state.kind !== 'ready') return []
  return filterProfileRows(state.reading.profiles, query).flatMap((profile): ProfilesSelection[] => [
    { kind: 'profile', profile },
    ...profile.bundles.map((bundle): ProfilesSelection => ({ kind: 'bundle', profile, bundle })),
    ...profile.plain.map((dependency): ProfilesSelection => ({ kind: 'plain', profile, dependency })),
  ])
}

/**
 * The persistent activity lines: what is running, and what a restart is owed.
 *
 * Drawn inside the frame and above the notice, because these two facts outlive
 * any single keystroke's answer. A running row carries the renderer's spinner
 * frame so it visibly turns; `↻` is landed and waiting on a restart this
 * browser cannot perform.
 * @param activity - what the owner reports.
 * @param tick - the spinner tick, advanced while work is in flight.
 * @param inner - the frame's inner width.
 * @returns zero or more rows.
 */
function activityLines(activity: ProfilesActivityView, tick: number, inner: number): string[] {
  const rows: string[] = []
  for (const entry of activity.running) {
    rows.push(paint(
      truncateToWidth(escapeControls(`${spinnerFrame(tick)} ${entry.profile}: ${entry.what}…`), inner),
      'busy',
    ))
  }
  if (activity.restartQueued.length > 0) {
    rows.push(paint(
      truncateToWidth(
        // The one place the reason is spelled out: this row is persistent, so it
        // is where a reader looks when they want to know WHY, and the result
        // line above it does not have to repeat it.
        escapeControls(
          `↻ ${activity.restartQueued.join(', ')}: restart to pick this up — this Host keeps its boot composition until it exits`,
        ),
        inner,
      ),
      'mode',
    ))
  }
  return rows
}

/**
 * The header lines: the profiles root, and which profile this Host booted.
 * @param state - the current reading.
 * @param inner - the frame's inner width.
 * @returns the header rows.
 */
function headerRows(state: ProfilesState, inner: number): string[] {
  if (state.kind !== 'ready') return []
  const { reading } = state
  const left = `Host: ${reading.currentName ?? 'not booted from a profile'}`
  const right = `${String(reading.profiles.length)} profile${reading.profiles.length === 1 ? '' : 's'}`
  const gap = Math.max(1, inner - displayWidth(left) - displayWidth(right))
  return [
    truncateToWidth(`${escapeControls(left)}${' '.repeat(gap)}${right}`, inner),
    paint(truncateToWidth(escapeControls(reading.root), inner), 'subdued'),
    '',
  ]
}

/**
 * Draw a reading's rows at a known width.
 * @param state - the current reading.
 * @param rows - the selectable sequence.
 * @param selected - the selected row's index among them.
 * @param inner - the frame's inner width in columns.
 * @returns the physical rows, the selection's row index among them, and the
 *   physical row of every selectable entry line.
 */
function renderRows(
  state: ProfilesState,
  rows: readonly ProfilesSelection[],
  selected: number,
  inner: number,
): Rendered {
  if (state.kind === 'loading') return single('Reading Harness profiles…', inner)
  if (state.kind === 'unavailable') return single(state.message, inner)
  if (state.kind === 'failed') return single(`the profile roster could not be read: ${state.message}`, inner)
  if (rows.length === 0) {
    return single(
      state.reading.profiles.length === 0
        ? 'No profiles yet. Press n to create one.'
        : 'No profile matches that.',
      inner,
    )
  }
  const out: string[] = []
  const entryRows: number[] = []
  let selectedRow = 0
  rows.forEach((row, index) => {
    const active = index === selected
    // One caption per profile that has layers, drawn when its first bundle
    // row is reached: with every profile expanded, a single global heading
    // would sit above only the first group and mislabel the rest.
    if (row.kind === 'bundle' && rows[index - 1]?.kind === 'profile') {
      out.push(paint(truncateToWidth('    Bundles', inner), 'subdued'))
    }
    // Named by its CONSEQUENCE rather than by the vocabulary. "not a layer" is
    // upstream's word (`ProfileLayer`) and was read as jargon by the first
    // person to see it, reasonably: a reader wants to know what the package
    // does, and the answer is nothing. The row's own `not a bundle` says why.
    if (row.kind === 'plain' && rows[index - 1]?.kind !== 'plain') {
      out.push(paint(truncateToWidth('    Installed, composes nothing', inner), 'subdued'))
    }
    if (active) selectedRow = out.length
    // Recorded after any group caption and before the entry line, so this is the
    // choice's own physical row. Captions and the selected profile's trailing
    // detail are presentation and are deliberately not recorded.
    entryRows.push(out.length)
    out.push(row.kind === 'profile'
      ? profileLine(row.profile, active, inner)
      : row.kind === 'bundle'
        ? bundleLine(row.bundle, active, inner)
        : plainLine(row.dependency, active, inner))
    if (active && row.kind === 'profile') {
      // Under the selected profile only: these are several lines, and every
      // profile carrying them at once would bury the roster.
      const detail = [
        ...row.profile.broken === undefined ? [] : [row.profile.broken],
        ...pendingBuildInstructions(row.profile),
      ]
      for (const line of detail) {
        out.push(paint(`    ${truncateToWidth(escapeControls(line), Math.max(1, inner - 4))}`, 'muted'))
      }
    }
  })
  return { rows: out, selectedRow, entryRows }
}

/**
 * A reading with nothing to select, as one row.
 * @param text - the sentence to show.
 * @param inner - the frame's inner width.
 * @returns the single row.
 */
function single(text: string, inner: number): Rendered {
  return {
    rows: [paint(truncateToWidth(escapeControls(text), inner), 'muted')],
    selectedRow: 0,
    entryRows: [],
  }
}

/**
 * One profile line: its mark, its name, and the tags that distinguish it.
 * @param row - the profile row.
 * @param active - whether it is selected.
 * @param inner - the frame's inner width.
 * @returns the row.
 */
function profileLine(row: ProfileRow, active: boolean, inner: number): string {
  const tags = profileTags(row)
  const right = tags.join(' · ')
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 10))
  const label = truncateToWidth(escapeControls(row.name), Math.max(1, inner - 4 - rightWidth - 1))
  const gap = Math.max(1, inner - 4 - displayWidth(label) - rightWidth)
  const plain = `${label}${' '.repeat(gap)}${truncateToWidth(right, rightWidth)}`
  const body = active ? paint(plain, 'selection') : plain
  return `${active ? paint('❯', 'selection') : ' '} ${profileMark(row)} ${body}`
}

/**
 * One bundle line: its mark, its package name, and its version or state.
 * @param row - the bundle row.
 * @param active - whether it is selected.
 * @param inner - the frame's inner width.
 * @returns the row.
 */
function bundleLine(row: BundleRow, active: boolean, inner: number): string {
  const right = bundleFacts(row).join(' · ')
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 12))
  const label = truncateToWidth(
    escapeControls(`  ${row.packageName}`),
    Math.max(1, inner - 4 - rightWidth - 1),
  )
  const gap = Math.max(1, inner - 4 - displayWidth(label) - rightWidth)
  const plain = `${label}${' '.repeat(gap)}${truncateToWidth(escapeControls(right), rightWidth)}`
  const body = active ? paint(plain, 'selection') : plain
  return `${active ? paint('❯', 'selection') : ' '} ${bundleMark(row)} ${body}`
}

/**
 * One plain-dependency line: its package name and what it is.
 * @param row - the dependency row.
 * @param active - whether it is selected.
 * @param inner - the frame's inner width.
 * @returns the row.
 */
function plainLine(row: PlainDependencyRow, active: boolean, inner: number): string {
  const right = plainDependencyFacts(row).join(' · ')
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 12))
  const label = truncateToWidth(
    escapeControls(`  ${row.packageName}`),
    Math.max(1, inner - 4 - rightWidth - 1),
  )
  const gap = Math.max(1, inner - 4 - displayWidth(label) - rightWidth)
  const plain = `${label}${' '.repeat(gap)}${truncateToWidth(escapeControls(right), rightWidth)}`
  const body = active ? paint(plain, 'selection') : plain
  // `⚠` when the layer list is stale, `·` otherwise: a package that simply is
  // not a bundle is ordinary, not a problem.
  const mark = row.declaresBundle === true ? '⚠' : '·'
  return `${active ? paint('❯', 'selection') : ' '} ${mark} ${body}`
}

/**
 * The query line: a prompt, the typed text, a cursor block, and the counter.
 * @param query - the typed query.
 * @param searching - whether search mode is capturing keystrokes.
 * @param right - the counter text.
 * @param inner - the frame's inner width.
 * @returns one row.
 */
function queryRow(query: string, searching: boolean, right: string, inner: number): string {
  const prompt = '⌕ '
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 4))
  const room = Math.max(1, inner - displayWidth(prompt) - rightWidth - 1)
  const hint = '/ to search'
  const plain = searching
    ? `${tailToWidth(escapeControls(query), Math.max(1, room - 1))}█`
    // The empty hint is bounded like the typed path: raw, it could outgrow the
    // room the counter left and collapse the framed browser to its fallback.
    : query === '' ? truncateToWidth(hint, Math.max(1, room)) : tailToWidth(escapeControls(query), Math.max(1, room))
  const typed = !searching && query === '' ? paint(plain, 'muted') : plain
  const gap = Math.max(1, inner - displayWidth(prompt) - displayWidth(plain) - rightWidth)
  return `${paint(prompt, 'prompt-mark')}${typed}${' '.repeat(gap)}${paint(truncateToWidth(right, rightWidth), 'muted')}`
}

/**
 * What the counter says: how many rows, and whether another choice is below.
 *
 * `more below` means another selectable profile, bundle, or plain-dependency
 * entry sits outside the viewport, not merely that a group caption or the
 * selected profile's own detail line was cut off.
 * @param shown - selectable rows after the query.
 * @param rendered - the drawn rows and where their choices landed.
 * @param viewport - the scroll position over them.
 * @returns the counter text.
 */
function counter(shown: number, rendered: Rendered, viewport: RowViewport): string {
  const more = rendered.entryRows.some(row => row >= viewport.end) ? ' · more below' : ''
  return `${String(shown)} row${shown === 1 ? '' : 's'}${more}`
}

/**
 * The help line, truthful for what is selected.
 * @param searching - whether search mode is active.
 * @param query - the typed query.
 * @param row - the selected row, when there is one.
 * @param columns - room available for the line.
 * @returns the help text that fits.
 */
function help(searching: boolean, query: string, row: ProfilesSelection | undefined, columns: number): string {
  const parts = searching
    ? ['type to search', 'enter/esc done']
    : [
        ...row === undefined ? [] : ['↑↓ navigate', 'a add'],
        // `u` is offered only where it does something: on a plain dependency it
        // is deliberately absent rather than quietly meaning something wider.
        ...row?.kind === 'bundle' || row?.kind === 'profile' ? ['u update'] : [],
        ...row === undefined ? [] : ['U update all'],
        ...row?.kind === 'bundle' || row?.kind === 'plain' ? ['r remove'] : [],
        'n new',
        '/ search',
        query === '' ? 'esc close' : 'esc clear',
      ]
  for (let from = 0; from < parts.length; from += 1) {
    const line = parts.slice(from).join(' · ')
    if (displayWidth(line) <= columns) return line
  }
  return truncateToWidth(parts[parts.length - 1] ?? '', columns)
}

/**
 * Count the physical rows Screen will draw for candidate live-region lines.
 * @param lines - the candidate logical lines.
 * @param columns - the terminal's width.
 * @returns the wrapped physical rows.
 */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * A closable answer for a terminal too small to hold the frame.
 * @param state - the current reading.
 * @param shown - selectable rows after the query.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @param notice - a pending result, when there is one.
 * @returns at most `rows` lines.
 */
function compactFallback(
  state: ProfilesState,
  shown: number,
  columns: number,
  rows: number,
  notice: SurfaceNoticeReading | undefined,
  activity: ProfilesActivityView,
  tick: number,
): string[] {
  if (rows <= 0) return []
  // Running work outranks the notice here. A narrow terminal is exactly where a
  // reader has least to go on, and "something is still installing" is the one
  // fact they cannot infer from anything else on screen.
  const first = activity.running[0]
  if (first !== undefined) {
    const line = `${spinnerFrame(tick)} ${first.profile}: ${first.what}…`
    const fitted = [line, `${spinnerFrame(tick)} ${first.profile}…`, spinnerFrame(tick)]
      .find(option => displayWidth(option) <= columns)
    if (fitted !== undefined) return [paint(escapeControls(fitted), 'busy')]
  }
  if (notice !== undefined) {
    return [paint(truncateToWidth(noticeText(notice.text), Math.max(1, columns)), notice.failed ? 'error' : 'success')]
  }
  const restarts = activity.restartQueued.length
  const summary = restarts > 0
    ? `↻ restart required · esc close`
    : state.kind !== 'ready' || shown === 0
      ? 'Profiles · esc close'
      : `${String(shown)} rows · esc close`
  const candidate = [summary, 'esc close', 'esc'].find(option => displayWidth(option) <= columns)
  return candidate === undefined ? [] : [paint(candidate, 'overlay-headline')]
}
