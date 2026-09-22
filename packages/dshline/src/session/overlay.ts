/**
 * Bounded current-session hub and routing to existing child surfaces.
 *
 * It deliberately reads no Harness state. The owning attachment supplies the
 * current title and facts, decides which controls are human-safe, and owns the
 * actual navigation and title mutation seams.
 * @module dshline/session/overlay
 */

import type { Key } from '@dshline/renderer'
import { displayWidth, escapeControls, paint, truncateToWidth } from '@dshline/renderer'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { EventContextState, EventSearchState, LineageState } from '../sessions/model.ts'
import { createLineageOverlay } from '../sessions/lineage-overlay.ts'
import { createEventsOverlay } from '../sessions/panels.ts'
import type { TuiOverlay } from '../slots.ts'
import { createBoundedSurface, SurfaceNotice } from '../surface.ts'
import {
  currentSessionHubAction,
  currentSessionHubActions,
  type CurrentSessionHubAction,
  type CurrentSessionHubCapabilities,
  type CurrentSessionReading,
} from './model.ts'

/** Columns allotted to one fact label before its value starts. */
const FACT_LABEL_COLUMNS = 13

/** How long a completed or refused rename outcome stays visible. */
const RENAME_NOTICE_MS = 4_000

/** Result of a title flow the owner performs for this live session. */
export type CurrentSessionRenameOutcome =
  /** The title was accepted and normalized by the owning authority. */
  | { readonly kind: 'renamed'; readonly title: string }
  /** The reader dismissed the owner-owned title prompt. */
  | { readonly kind: 'cancelled' }
  /** The authority refused the proposed title. */
  | { readonly kind: 'failed'; readonly message: string }

/**
 * The Session navigator callbacks a current-session child needs.
 *
 * This is intentionally a callback-shaped Session navigator, whose methods
 * match the existing SessionCatalog public methods without claiming a new
 * navigation service. An owner can pass those callbacks directly while still
 * choosing whether each operation is safe to expose here.
 */
export interface CurrentSessionNavigator {
  /** Current within-session event-search state. */
  readonly events: () => EventSearchState
  /** Start or restart an event search for a session. */
  readonly searchEvents: (sessionId: SessionId, query: string) => void
  /** Append the next event-search page. */
  readonly loadMoreEvents: () => void
  /** Request bounded context for one event hit. */
  readonly requestEventContext: (sessionId: SessionId, seq: SessionSeq) => void
  /** Read context state for one exact event hit. */
  readonly eventContext: (sessionId: SessionId, seq: SessionSeq) => EventContextState
  /** Read lineage state for one session. */
  readonly lineage: (sessionId: SessionId) => LineageState
  /** Request lineage for one session. */
  readonly requestLineage: (sessionId: SessionId) => void
  /**
   * Abandon in-flight navigation reads when the hub closes.
   *
   * Optional so a presenter that owns no cancellable work can omit it; when
   * supplied, a late page can never repaint a surface that has come down.
   */
  readonly cancel?: () => void
}

/** Inputs the current-session hub needs from its owner. */
export interface CurrentSessionHubOverlaySpec {
  /** Current title, stable id, and facts; re-read on every paint. */
  readonly reading: () => CurrentSessionReading
  /** Capability state already adjudicated by the owner. */
  readonly capabilities: () => CurrentSessionHubCapabilities
  /** Session navigator callbacks used by Find and Lineage children. */
  readonly navigator?: CurrentSessionNavigator
  /** Open the owner's authoritative turns surface over this hub. */
  readonly openTurns?: () => void
  /** Collect and submit a replacement title through the owner. */
  readonly rename?: () => Promise<CurrentSessionRenameOutcome>
  /**
   * Focus a lineage row outside this hub.
   *
   * The lineage child remains useful without it, but its Enter action reports
   * that the owner cannot navigate to another session instead of pretending a
   * SessionCatalog supplies such a mutation.
   */
  readonly focusLineage?: (sessionId: SessionId) => boolean
  /** User home used by the existing lineage presentation. */
  readonly home: string | undefined
  /** Current time injected for the existing lineage presentation and notices. */
  readonly now: () => number
  /**
   * Push a normal overlay-stack child, receiving the stack-owned close callback.
   *
   * This is the same factory shape used by `openSurface`, so Escape closes only
   * the child and returns to this still-mounted hub.
   */
  readonly push: (create: (close: () => void) => TuiOverlay) => void
  /** Remove this hub from the owner-managed overlay stack. */
  readonly close: () => void
  /** Request redraw after local selection or asynchronous title outcome changes. */
  readonly invalidate: () => void
}

/**
 * Create the bounded current-session hub.
 * @param spec - owner reading, capability decisions, callback seams, and stack controls.
 * @returns a temporary overlay that never writes scrollback.
 */
export function createCurrentSessionHubOverlay(spec: CurrentSessionHubOverlaySpec): TuiOverlay {
  let selected: CurrentSessionHubAction['kind'] | undefined
  let renameInFlight = false
  let closed = false
  const notice = new SurfaceNotice(RENAME_NOTICE_MS, { now: spec.now, invalidate: spec.invalidate })

  /** Restrict enabled declarations to callbacks this particular hub can fulfill. */
  const actions = (): readonly CurrentSessionHubAction[] => {
    if (spec.reading().sessionId === undefined) return []
    return currentSessionHubActions(spec.capabilities()).filter(action => {
      if (action.kind === 'turns') return spec.openTurns !== undefined
      if (action.kind === 'rename') return spec.rename !== undefined
      return spec.navigator !== undefined
    })
  }
  const selectedAction = (): CurrentSessionHubAction | undefined => {
    const available = actions()
    const current = selected === undefined ? undefined : currentSessionHubAction(available, selected)
    if (current !== undefined) return current
    selected = available[0]?.kind
    return available[0]
  }
  const move = (amount: number): void => {
    const available = actions()
    if (available.length === 0) return
    const current = selectedAction()
    const at = current === undefined ? 0 : available.indexOf(current)
    selected = available[(at + amount + available.length) % available.length]?.kind
    spec.invalidate()
  }
  const reportRename = (outcome: CurrentSessionRenameOutcome): void => {
    if (closed) return
    renameInFlight = false
    if (outcome.kind === 'cancelled') return
    if (outcome.kind === 'renamed') notice.show(`Renamed to “${outcome.title}”`)
    else notice.show(`Rename failed: ${outcome.message}`, true)
    spec.invalidate()
  }
  const renameFailed = (error: unknown): void => {
    if (closed) return
    renameInFlight = false
    notice.show(`Rename failed: ${error instanceof Error ? error.message : String(error)}`, true)
    spec.invalidate()
  }
  const activate = (action: CurrentSessionHubAction | undefined): void => {
    const reading = spec.reading()
    if (action === undefined || reading.sessionId === undefined) return
    if (action.kind === 'turns') {
      spec.openTurns?.()
      return
    }
    if (action.kind === 'rename') {
      if (renameInFlight || spec.rename === undefined) return
      renameInFlight = true
      void spec.rename().then(reportRename, renameFailed)
      return
    }
    const navigator = spec.navigator
    if (navigator === undefined) return
    if (action.kind === 'find') {
      spec.push(close => createEventsOverlay({
        target: reading.sessionId,
        events: navigator.events,
        searchEvents: navigator.searchEvents,
        loadMoreEvents: navigator.loadMoreEvents,
        readEvent: navigator.requestEventContext,
        eventContext: navigator.eventContext,
        push: spec.push,
        now: spec.now,
        close,
        invalidate: spec.invalidate,
      }))
      return
    }
    spec.push(close => createLineageOverlay({
      target: reading.sessionId,
      lineage: navigator.lineage,
      requestLineage: navigator.requestLineage,
      home: spec.home,
      now: spec.now,
      focus: spec.focusLineage ?? (() => false),
      close,
      invalidate: spec.invalidate,
    }))
  }
  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }

  return createBoundedSurface<CurrentSessionReading>({
    reading: spec.reading,
    title: () => 'Current session',
    body: (reading, width, capacity) => hubRows(reading, selectedAction(), actions(), width, capacity),
    compact: reading => reading.sessionId === undefined ? 'No current session' : 'Current session',
    footer: () => hubHelp(actions()),
    notice,
    onKey: key => {
      if (key.kind === 'text') {
        const action = currentSessionHubAction(actions(), key.text as CurrentSessionHubAction['accelerator'])
        if (action !== undefined) activate(action)
        return
      }
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
        case 'left':
          move(-1)
          return
        case 'down':
        case 'right':
          move(1)
          return
        case 'enter':
          activate(selectedAction())
          return
        default:
          return
      }
    },
    close,
    dispose: () => {
      notice.dispose()
      spec.navigator?.cancel?.()
    },
  })
}

/** Render the title, bounded fact prefix, and action menu. */
function hubRows(
  reading: CurrentSessionReading,
  selectedAction: CurrentSessionHubAction | undefined,
  actions: readonly CurrentSessionHubAction[],
  width: number,
  capacity: number,
): string[] {
  if (reading.sessionId === undefined) return [mutedRow('No current session is attached.', width)]
  const headline = paint(singleLine(reading.title ?? 'Current session', width), 'overlay-headline')
  const actionRows = actions.map(action => actionRow(action, action.kind === selectedAction?.kind, width))
  // Title and actions answer what this surface is FOR, so fact rows spend only
  // the leftover budget; otherwise a long supplied fact list would hide control.
  const essentials = [headline, ...actionRows]
  if (capacity <= essentials.length) return essentials.slice(0, Math.max(0, capacity))
  const factCapacity = Math.max(0, capacity - essentials.length - 1)
  const facts = (reading.facts ?? []).slice(0, factCapacity).map(fact => factRow(fact.label, fact.value, width))
  return facts.length === 0 ? essentials : [headline, ...facts, '', ...actionRows]
}

/** Render one selectable action, including its direct accelerator. */
function actionRow(action: CurrentSessionHubAction, selected: boolean, width: number): string {
  const text = `${action.accelerator}  ${action.label}`
  const fitted = truncateToWidth(text, Math.max(1, width - 2))
  return selected ? paint(`❯ ${fitted}`, 'selection') : `  ${fitted}`
}

/** Render one supplied fact with display-column-aware label alignment. */
function factRow(label: string, value: string, width: number): string {
  const labelWidth = Math.min(FACT_LABEL_COLUMNS, Math.max(1, Math.floor(width / 3)))
  const shownLabel = singleLine(label, labelWidth)
  const padding = ' '.repeat(Math.max(0, labelWidth - displayWidth(shownLabel)))
  const valueWidth = Math.max(1, width - 2 - labelWidth)
  return `  ${paint(`${shownLabel}${padding}`, 'muted')}${singleLine(value, valueWidth)}`
}

/** Escape, flatten, and fit one owner-supplied value to a physical row. */
function singleLine(value: string, width: number): string {
  return truncateToWidth(escapeControls(value).replaceAll('\n', ' '), Math.max(1, width))
}

/** Render one static absence message. */
function mutedRow(text: string, width: number): string {
  return paint(singleLine(text, width), 'muted')
}

/** Build whole footer help segments in least-to-most-essential order. */
function hubHelp(actions: readonly CurrentSessionHubAction[]): string {
  return [
    '←→/↑↓ move',
    ...actions.map(action => `${action.accelerator} ${action.label.toLocaleLowerCase()}`),
    ...actions.length === 0 ? [] : ['↵ open'],
    'esc close',
  ].join(' · ')
}
