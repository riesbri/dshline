/**
 * `/skills`: an inspector over the effective Harness catalog, and a launcher
 * for the Composer.
 *
 * Deliberately not an executor. Enter writes the literal `/name ` a person
 * could have typed and gets out of the way; whether that line becomes a skill
 * invocation is Harness's decision, made at its own pre-step boundary. Nothing
 * here loads a skill, renders instructions, or spends a model turn.
 * @module dshline/skills/overlay
 */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  paint,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import type { TuiOverlay } from '../slots.ts'
import type { SkillCatalogReading } from './catalog.ts'
import { filterSkillRows, invocationLabel, skillRows, sourceLabel } from './model.ts'
import type { SkillRow } from './model.ts'

/** Leading blank and the two frame borders, outside any content. */
const FIXED_ROWS = 3

/** Narrower than this and the framed form cannot hold a name beside a mark. */
const MIN_COLUMNS = BOX_CHROME_COLUMNS + 14

/** Inner width at which a row can carry a description beside its name. */
const DESCRIPTION_COLUMNS = 34

/** Inner width at which the detail block can afford its label column. */
const LABELLED_DETAIL_COLUMNS = 46

/** Widest a name column grows, so a long name cannot crowd out every description. */
const NAME_COLUMN_MAX = 22

/** Columns between the name and the description. */
const NAME_GAP = 2

/** Width of the detail block's label column, including its trailing space. */
const LABEL_COLUMN = 15

/** Rows the wrapped description in the detail block may take. */
const DETAIL_DESCRIPTION_ROWS = 3

/** Marker on the highlighted row. */
const CURSOR = '›'

/** What the inspector needs from the attachment that opens it. */
export interface SkillsOverlaySpec {
  /** The live catalog reading; re-read every frame. */
  readonly reading: () => SkillCatalogReading
  /** Names the command registries already claim, for the shadowing rule. */
  readonly commandNames: () => Iterable<string>
  /** Put `/name ` in the Composer. Called at most once, and never submits. */
  readonly insert: (name: string) => void
  /** Remove this temporary overlay. */
  readonly close: () => void
  /** Ask the runner to redraw. */
  readonly invalidate: () => void
}

/**
 * Create the `/skills` inspector.
 * @param spec - the catalog reading, the shadowing names, and the two actions.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createSkillsOverlay(spec: SkillsOverlaySpec): TuiOverlay {
  let query = ''
  let cursor = 0
  let notice: string | undefined
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  /** Rows the current reading and query leave, recomputed on every read. */
  const rows = (): readonly SkillRow[] => {
    const reading = spec.reading()
    const skills = reading.kind === 'ready' || reading.kind === 'incomplete' ? reading.skills : []
    return filterSkillRows(skillRows(skills, spec.commandNames()), query)
  }
  const edit = (next: string): void => {
    query = next
    cursor = 0
    notice = undefined
    spec.invalidate()
  }
  const move = (amount: number): void => {
    const total = rows().length
    if (total === 0) return
    cursor = (cursor + amount + total) % total
    notice = undefined
    spec.invalidate()
  }
  const confirm = (): void => {
    const row = rows()[cursor]
    if (row === undefined) return
    if (!row.launchable) {
      // No Agent turn is spent on a gesture Harness would not honour, and the
      // row stays inspectable — the reason it cannot be launched is already in
      // the detail block above this line.
      notice = row.shadowed
        ? `/${row.skill.name} runs the command of that name`
        : `${row.skill.name} is not invocable by a person`
      spec.invalidate()
      return
    }
    // Reported BEFORE the close, so a caller that settles its promise from
    // `close` already knows which name it settled with.
    spec.insert(row.skill.name)
    close()
  }
  return {
    render(columns, terminalRows = 24) {
      const reading = spec.reading()
      const visible = rows()
      cursor = Math.min(cursor, Math.max(0, visible.length - 1))
      if (terminalRows <= FIXED_ROWS || columns < MIN_COLUMNS) {
        return compactFallback(reading, visible[cursor], columns, terminalRows)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const capacity = terminalRows - FIXED_ROWS
      const body = bodyRows(reading, visible, cursor, query, notice, inner, capacity)
      if (body.length === 0) return compactFallback(reading, visible[cursor], columns, terminalRows)
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint('Skills', 'overlay-title'),
          body,
          footer: fitFooterHelp(help(cursor, visible, query), footerBudget(columns)),
        }),
      ]
      // Every content row above is already truncated to `inner`; this is the
      // backstop that keeps a forgotten one from pushing the live region into
      // committed scrollback.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(reading, visible[cursor], columns, terminalRows)
    },
    handleKey(key: Key) {
      if (key.kind === 'text') {
        edit(query + key.text)
        return
      }
      if (key.kind === 'paste') {
        // A filter is one line; pasted breaks collapse where they can be seen.
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
          // Code points, not UTF-16 units: one press deletes one character.
          edit([...query].slice(0, -1).join(''))
          return
        case 'ctrl-u':
          edit('')
          return
        case 'ctrl-w':
          edit(query.replace(/\s*\S*$/u, ''))
          return
        case 'enter':
          confirm()
          return
        case 'escape':
          // Two stages while there is a filter, which is what every
          // type-to-filter browser here does — Sessions, Connect, Plugins, and
          // the shared `promptSelect` picker: the typed text is what a reader
          // most often wants back, and spending that keystroke on the whole
          // view costs them the list as well. `ctrl-c` below is the one-press
          // way out, as it is in all of them.
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
 * The framed body: heading, list, and the selected skill's detail.
 * @param reading - the catalog's current state.
 * @param visible - rows the filter left.
 * @param cursor - the highlighted row.
 * @param query - the typed filter.
 * @param notice - a one-row local message, when one is standing.
 * @param inner - the frame's inner width in columns.
 * @param capacity - rows available inside the frame.
 * @returns the body rows, or none when nothing useful fits.
 */
function bodyRows(
  reading: SkillCatalogReading,
  visible: readonly SkillRow[],
  cursor: number,
  query: string,
  notice: string | undefined,
  inner: number,
  capacity: number,
): string[] {
  if (capacity < 1) return []
  const heading = headingRow(reading, visible.length, query, inner)
  if (reading.kind === 'unavailable' || reading.kind === 'loading') {
    return [heading, ...capacity >= 3 ? ['', paint(truncateToWidth(stateMessage(reading), inner), 'muted')] : []]
  }
  if (visible.length === 0) {
    const message = query === ''
      ? stateMessage(reading)
      : `No skill matches ${escapeControls(query)}.`
    return [heading, ...capacity >= 3 ? ['', paint(truncateToWidth(message, inner), 'muted')] : []]
  }
  const selected = visible[cursor]
  const detail = selected === undefined ? [] : detailRows(selected, inner)
  const noticeRows = notice === undefined ? [] : [paint(truncateToWidth(`· ${notice}`, inner), 'warning')]
  // The list gets whatever the detail block and its separators leave, and the
  // detail is what gives way first: a reader who cannot see the row they are
  // moving through has lost the list, while a missing detail is one keystroke
  // of scrolling away from being visible again on a taller terminal.
  const tail = [...noticeRows, ...detail]
  const withDetail = capacity - 1 - (tail.length === 0 ? 0 : tail.length + 1)
  const listCapacity = withDetail >= 1 ? withDetail : capacity - 1
  if (listCapacity < 1) return [heading]
  const shownTail = withDetail >= 1 && tail.length > 0 ? ['', ...tail] : []
  return [heading, ...listRows(visible, cursor, inner, listCapacity), ...shownTail]
}

/**
 * The list, bounded to its capacity with a truthful omission marker.
 * @param visible - rows the filter left.
 * @param cursor - the highlighted row.
 * @param inner - the frame's inner width in columns.
 * @param capacity - rows the list may take.
 * @returns the rendered rows.
 */
function listRows(
  visible: readonly SkillRow[],
  cursor: number,
  inner: number,
  capacity: number,
): string[] {
  const marker = visible.length > capacity ? 1 : 0
  const room = Math.max(1, capacity - marker)
  const start = Math.min(Math.max(0, cursor - room + 1), Math.max(0, visible.length - room))
  const shown = visible.slice(start, start + room)
  const nameColumn = Math.min(
    NAME_COLUMN_MAX,
    Math.max(...visible.map(row => displayWidth(label(row)))),
  )
  const rows = shown.map((row, index) => skillRowText(row, start + index === cursor, nameColumn, inner))
  const omitted = visible.length - (start + shown.length)
  if (omitted > 0) rows.push(`    ${paint(`… ${String(omitted)} more`, 'muted')}`)
  return rows
}

/**
 * One list row: the mark, the launchable name, and the description.
 * @param row - the skill row.
 * @param selected - whether this row holds the cursor.
 * @param nameColumn - display width reserved for the name.
 * @param inner - the frame's inner width in columns.
 * @returns one safely truncated physical row.
 */
function skillRowText(row: SkillRow, selected: boolean, nameColumn: number, inner: number): string {
  const mark = selected ? paint(CURSOR, 'selection-mark') : ' '
  const name = truncateToWidth(label(row), nameColumn)
  const painted = selected ? paint(name, 'selection') : name
  const room = inner - 2 - nameColumn - NAME_GAP
  if (inner < DESCRIPTION_COLUMNS || room < 8 || row.skill.description === '') {
    return truncateToWidth(`${mark} ${painted}`, inner)
  }
  const pad = ' '.repeat(Math.max(0, nameColumn - displayWidth(name)) + NAME_GAP)
  const note = paint(truncateToWidth(escapeControls(row.skill.description), room), 'muted')
  return `${mark} ${painted}${pad}${note}`
}

/**
 * How one skill's name reads in the list.
 *
 * The slash is a claim about a gesture, so it appears only where the gesture
 * works: a model-only skill and one whose name a command already claims are
 * shown bare, which is the difference between an inspector and a menu that
 * lies.
 * @param row - the skill row.
 * @returns the name as it should be shown.
 */
function label(row: SkillRow): string {
  return row.launchable ? `/${row.skill.name}` : row.skill.name
}

/**
 * The selected skill's facts, at whichever detail the width affords.
 * @param row - the selected row.
 * @param inner - the frame's inner width in columns.
 * @returns the detail rows.
 */
function detailRows(row: SkillRow, inner: number): string[] {
  const skill = row.skill
  const rows = [paint(truncateToWidth(escapeControls(skill.name), inner), 'section-heading')]
  if (inner < LABELLED_DETAIL_COLUMNS) {
    rows.push(paint(truncateToWidth(
      `${invocationLabel(skill)} · ${sourceLabel(skill.source)}`,
      inner,
    ), 'muted'))
    return rows
  }
  for (const line of wrapToWidth(escapeControls(skill.description), inner).slice(0, DETAIL_DESCRIPTION_ROWS)) {
    rows.push(truncateToWidth(line, inner))
  }
  rows.push('')
  rows.push(field('Available to', invocationLabel(skill), inner))
  rows.push(field('Source', sourceLabel(skill.source), inner))
  if (row.shadowed) {
    rows.push(field('Invocation', `/${skill.name} is shadowed by a command`, inner))
  } else if (!skill.userInvocable) {
    rows.push(field('Invocation', 'the model loads this one', inner))
  }
  if (skill.whenToUse !== undefined && skill.whenToUse !== '') {
    rows.push(field('When to use', skill.whenToUse, inner))
  }
  return rows
}

/**
 * One labelled detail row.
 * @param name - the label.
 * @param value - the value, untrusted and escaped here.
 * @param inner - the frame's inner width in columns.
 * @returns one row.
 */
function field(name: string, value: string, inner: number): string {
  const head = paint(name.padEnd(LABEL_COLUMN, ' '), 'muted')
  return `${head}${truncateToWidth(escapeControls(value), Math.max(1, inner - LABEL_COLUMN))}`
}

/**
 * The heading: how many skills there are, and the filter when one is typed.
 * @param reading - the catalog's current state.
 * @param shown - rows the filter left.
 * @param query - the typed filter.
 * @param inner - the frame's inner width in columns.
 * @returns one row.
 */
function headingRow(
  reading: SkillCatalogReading,
  shown: number,
  query: string,
  inner: number,
): string {
  const total = reading.kind === 'ready' || reading.kind === 'incomplete' ? reading.skills.length : 0
  const left = query !== ''
    ? `Skills · ${String(shown)} matches`
    : reading.kind === 'ready' || reading.kind === 'incomplete'
      ? `Skills · ${String(total)} available`
      : 'Skills'
  const right = query !== ''
    ? `filter: ${escapeControls(query)}`
    : reading.kind === 'incomplete'
      ? 'may be incomplete'
      : reading.kind === 'ready' && (reading.stale || reading.refreshing)
        ? 'refreshing…'
        : ''
  const heading = paint(truncateToWidth(left, inner), 'overlay-headline')
  if (right === '') return heading
  const room = inner - displayWidth(truncateToWidth(left, inner)) - 1
  if (room < displayWidth(right)) return heading
  return `${heading}${' '.repeat(room - displayWidth(right) + 1)}${paint(right, 'muted')}`
}

/**
 * What to say when there is no list to show.
 * @param reading - the catalog's current state.
 * @returns one sentence.
 */
function stateMessage(reading: SkillCatalogReading): string {
  switch (reading.kind) {
    case 'unavailable':
      return 'Skills are unavailable in this composition.'
    case 'loading':
      return 'Discovering skills…'
    case 'incomplete':
      return 'Skills could not be listed completely.'
    case 'ready':
      return 'No skills are available to this agent.'
  }
}

/**
 * The footer help, least essential first.
 *
 * A skill's own row drops its slash when the gesture would not work, and the
 * footer follows the same rule: `enter insert` is named only for a launchable
 * row, because Enter on a model-only or shadowed row reports why it cannot be
 * invoked rather than inserting anything. `↑↓ select` goes with it when the
 * filter left nothing to select, and the way out names what Escape will
 * actually do — clear the filter while one is typed, otherwise close.
 * @param cursor - the highlighted row.
 * @param visible - rows the filter left.
 * @param query - the typed filter.
 * @returns the help text, before it is fitted to the border.
 */
function help(cursor: number, visible: readonly SkillRow[], query: string): string {
  const row = visible[cursor]
  const position = row === undefined ? '' : `${String(cursor + 1)}/${String(visible.length)} · `
  const insert = row?.launchable === true ? 'enter insert · ' : ''
  const select = row === undefined ? '' : '↑↓ select · '
  const leave = query === '' ? 'esc close' : 'esc clear'
  return `${position}${insert}${select}type filter · ${leave}`
}

/** Count the physical rows Screen will draw for a candidate live region. */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * A closable answer for a terminal too small to draw the frame.
 * @param reading - the catalog's current state.
 * @param row - the selected row, when there is one.
 * @param columns - the terminal's width.
 * @param rows - rows available.
 * @returns at most one row.
 */
function compactFallback(
  reading: SkillCatalogReading,
  row: SkillRow | undefined,
  columns: number,
  rows: number,
): string[] {
  if (rows <= 0) return []
  const identity = row === undefined
    ? stateMessage(reading)
    : `${label(row)} · ${invocationLabel(row.skill)}`
  const visible = [`${identity} · esc close`, identity, 'esc close', 'esc']
    .find(candidate => displayWidth(candidate) <= columns)
  // Nothing here is untrusted: a skill name carries Harness's own kebab-case
  // grammar, and every other part of the line is this module's own words.
  return visible === undefined ? [] : [paint(visible, 'overlay-headline')]
}
