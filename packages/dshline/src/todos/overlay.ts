/** Bounded read-only terminal presentation of Harness Todo snapshots. */

import { escapeControls, paint, truncateToWidth } from '@dshline/renderer'
import { createBoundedSurface } from '../surface.ts'
import type { TuiOverlay } from '../slots.ts'
import type { TodoReading } from './model.ts'

/** Inputs the read-only Todo overlay needs from the runner. */
export interface TodoOverlaySpec {
  /** Current projection-derived Todo reading. */
  readonly reading: () => TodoReading
  /** Remove this temporary overlay. */
  readonly close: () => void
}

/**
 * Create a bounded read-only Todo overlay.
 * @param spec - current reading and close control.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createTodoOverlay(spec: TodoOverlaySpec): TuiOverlay {
  return createBoundedSurface<TodoReading>({
    reading: spec.reading,
    title: () => 'Todos',
    body: (reading, width, capacity) => contentRows(reading, width, capacity),
    compact: reading => compactSummary(reading),
    close: spec.close,
  })
}

/** Turn a small projection state into as many bounded one-row list entries as fit. */
function contentRows(reading: TodoReading, width: number, capacity: number): string[] {
  switch (reading.kind) {
    case 'projections-unavailable':
      return [paint(truncateToWidth('Session projections are unavailable in this profile.', width), 'muted')]
    case 'unregistered':
      return [paint(truncateToWidth('Todo projection is unavailable.', width), 'muted')]
    case 'none':
      return [paint('No active todo list.', 'muted')]
    case 'empty':
      return [paint('Todo list is empty.', 'muted')]
    case 'list': {
      // One capacity slot is reserved for the truthful omission marker. Items
      // stay in Harness order; sorting by status would create TUI-owned meaning.
      const shown = reading.items.slice(0, Math.max(0, capacity - (reading.items.length > capacity ? 1 : 0)))
      const rows = shown.map(item => itemRow(item.content, item.status, width))
      const omitted = reading.items.length - shown.length
      if (omitted > 0 && rows.length < capacity) rows.push(paint(`… +${String(omitted)} more`, 'muted'))
      return rows.length > 0 ? rows : [paint(`… +${String(reading.items.length)} more`, 'muted')]
    }
  }
}

/** Render one untrusted Todo item into one safely truncated physical row. */
function itemRow(content: string, status: 'pending' | 'in_progress' | 'completed', width: number): string {
  const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '●' : '○'
  const color = status === 'completed' ? 'success' : status === 'in_progress' ? 'busy' : 'subdued'
  // Escape before styling: model-authored content must not add rows, operate the
  // terminal, or consume a style reset belonging to the overlay.
  return paint(truncateToWidth(`${mark} ${safeTodoContent(content)}`, width), color)
}

/** Make one Todo label safe without allowing model text to add a list row. */
function safeTodoContent(content: string): string {
  // Newlines are normally meaningful in transcript text, but a Todo is one list
  // row. Escape all controls first, then make its preserved line separator visible.
  return escapeControls(content).replaceAll('\n', '^J')
}

/** Describe the current projection reading without exposing any model-authored text. */
function compactSummary(reading: TodoReading): string {
  switch (reading.kind) {
    case 'projections-unavailable':
      return 'Todos unavailable'
    case 'unregistered':
      return 'Todo unavailable'
    case 'none':
      return 'No active todos'
    case 'empty':
      return 'Todo list empty'
    case 'list': {
      const completed = reading.items.filter(item => item.status === 'completed').length
      return `Todos ${String(completed)}/${String(reading.items.length)}`
    }
  }
}
