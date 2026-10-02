/** Pure, bounded flattening of Harness session-lineage traces. */

import type {
  SessionLineageNode,
  SessionLineageTrace,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
import type { LineageRow, SessionOrigin } from './model.ts'

/** Bounds that keep a lineage tree inside an overlay-sized data budget. */
export interface LineageBounds {
  /** Closest known ancestors to retain. */
  readonly ancestors: number
  /** Descendant generations to retain below the target. */
  readonly depth: number
  /** Descendant session rows to retain across the complete DFS. */
  readonly nodes: number
}

/** Default number of closest ancestors retained by a lineage trace. */
const DEFAULT_ANCESTOR_LIMIT = 16
/** Default descendant generations retained below the target. */
const DEFAULT_DESCENDANT_DEPTH = 4
/** Default descendant session rows retained across the tree. */
const DEFAULT_DESCENDANT_NODE_LIMIT = 50

/** The bounded lineage budget used when a caller supplies no override. */
export const DEFAULT_LINEAGE_BOUNDS: LineageBounds = {
  ancestors: DEFAULT_ANCESTOR_LIMIT,
  depth: DEFAULT_DESCENDANT_DEPTH,
  nodes: DEFAULT_DESCENDANT_NODE_LIMIT,
}

/**
 * Flatten a lineage trace into display order under explicit bounds.
 *
 * Ancestors arrive immediate-parent first and are reversed into root-to-target
 * order. Descendants use stable DFS pre-order, matching Harness's child order.
 * Pruned markers report exact omitted counts rather than making a bounded tree
 * look complete.
 * @param trace - the complete known trace from Harness.
 * @param bound - the presentation budget.
 * @returns bounded rows, including the target exactly once.
 */
export function flattenLineage(
  trace: SessionLineageTrace,
  bound: LineageBounds = DEFAULT_LINEAGE_BOUNDS,
): LineageRow[] {
  const ancestorLimit = nonNegativeInteger(bound.ancestors)
  const descendantDepth = nonNegativeInteger(bound.depth)
  const descendantLimit = nonNegativeInteger(bound.nodes)
  const keptAncestors = trace.ancestors.slice(0, ancestorLimit).reverse()
  const omittedAncestors = trace.ancestors.length - keptAncestors.length
  const rows: LineageRow[] = []
  if (omittedAncestors > 0) {
    rows.push({ kind: 'pruned', depth: 0, label: `… ${String(omittedAncestors)} earlier ancestors` })
  }
  keptAncestors.forEach((record, index) => {
    rows.push(sessionRow('ancestor', index, record))
  })
  const targetDepth = keptAncestors.length
  rows.push(sessionRow('target', targetDepth, trace.target))

  const descendants = countDescendants(trace.descendants)
  let emitted = 0
  const visit = (nodes: readonly SessionLineageNode[], relativeDepth: number): void => {
    if (relativeDepth > descendantDepth || emitted >= descendantLimit) return
    for (const node of nodes) {
      if (emitted >= descendantLimit) return
      rows.push(sessionRow('descendant', targetDepth + relativeDepth, node.session))
      emitted += 1
      visit(node.descendants, relativeDepth + 1)
    }
  }
  visit(trace.descendants, 1)
  const hidden = descendants - emitted
  if (hidden > 0) {
    rows.push({
      kind: 'pruned',
      depth: targetDepth + 1,
      label: `… ${String(hidden)} descendants hidden`,
    })
  }
  return rows
}

function nonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function countDescendants(nodes: readonly SessionLineageNode[]): number {
  let count = 0
  for (const node of nodes) count += 1 + countDescendants(node.descendants)
  return count
}

function origin(record: SessionRecord): SessionOrigin {
  return record.header.origin === 'subagent' ? 'delegated' : 'own'
}

function sessionRow(
  kind: 'ancestor' | 'target' | 'descendant',
  depth: number,
  record: SessionRecord,
): LineageRow {
  return {
    kind,
    depth,
    id: record.header.id,
    createdAt: record.header.createdAt,
    ...record.header.cwd === undefined ? {} : { cwd: record.header.cwd },
    origin: origin(record),
    // Carried verbatim rather than re-derived: `cloneRecord` preserves both
    // flags on every traced record, and this is what lets a row reached through
    // a relationship reach the SAME resume policy a list row reaches.
    live: record.live,
    persisted: record.persisted,
  }
}
