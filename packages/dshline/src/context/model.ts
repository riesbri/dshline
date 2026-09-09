/**
 * Presentation-facing readings of what the model is currently carrying.
 *
 * Two authorities, deliberately kept apart because they answer different
 * questions and cost different amounts:
 *
 * - the `contextPressure` and `contextBreakdown` session projections are O(1)
 *   folds Harness already maintains, so occupancy and composition are free to
 *   read on every frame;
 * - `ctx.tokenMeter.measure(session)` prices every node of the current surface
 *   and clones the result, which its own contract states is O(surface) per
 *   call. That is the X-ray, and nothing but an open inspector may ask for it.
 *
 * Nothing here knows about a terminal or a Context, so all of it is testable
 * directly.
 * @module dshline/context/model
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage, isReplacementSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
// Type-only, and a devDependency rather than a peer: the meter is an optional
// Harness plugin. This activates the `Context.tokenMeter` declaration and the
// `SessionProjectionMap` keys its three units publish, without requiring the
// package to be mounted — or even installed — for this frontend to run.
import type { TokenMeasurement, TokenSurfaceNode } from '@deepseek-ai/dsh-token-meter'

/**
 * How full the model's context is, as the authoritative projection states it.
 *
 * `tokens` is `projectedTokens`, which upstream defines as what the NEXT
 * request's prompt would cost: the provider's own sample for the last request
 * plus the heuristic repricing of everything the surface gained or lost since.
 * It is therefore ONE kind of figure — a projection — and is presented as one.
 *
 * An earlier revision marked it `~` whenever `projectedTokens` differed from
 * `pressureTokens` and left the mark off when they matched. That equality does
 * not prove what it looked like it proved: several changes can net to a zero
 * heuristic delta, so a bare figure could claim the provider's own precision for
 * a surface that had in fact moved. Rather than add shadow state to make the
 * claim true, the claim is gone: the projection is a projection, and the word
 * `projected` says so once.
 */
export interface ContextOccupancy {
  /** Prompt tokens the next request is projected to carry. */
  readonly tokens: number
  /** The newest route capacity, when an adapter advertised one. */
  readonly capacity: number | undefined
}

/**
 * What the next request's prompt is made of, under the meter's fixed estimator.
 *
 * These three are a COMPOSITION, never a total: upstream states that the same
 * estimator systematically underprices CJK text and JSON schemas, which is the
 * error the provider anchoring in {@link ContextOccupancy} exists to keep out
 * of that figure. So the shares below are shares of `total` — the sum of these
 * three — and are never divided into an occupancy figure.
 */
export interface ContextComposition {
  /**
   * Estimated tokens of the last nonempty surviving system prompt in surface
   * order — the one actually in force. Superseded system nodes still on the
   * surface are priced into {@link ContextComposition.messages}, because they
   * are still occupying context.
   */
  readonly system: number
  /** Estimated tokens of the newest request envelope's assembled tool schemas. */
  readonly tools: number
  /** Estimated tokens of every other visible surface node. */
  readonly messages: number
  /** The three added together, which is the only figure their shares divide. */
  readonly total: number
}

/** Everything the cheap projections can truthfully say about current context. */
export interface ContextReading {
  /** Whether this profile mounted the generic projection infrastructure. */
  readonly projections: boolean
  /** Whether the token meter's projection units are registered in this process. */
  readonly metered: boolean
  /** Occupancy, once a provider has reported a prompt size. */
  readonly occupancy: ContextOccupancy | undefined
  /** Composition, once the meter's breakdown unit has a value. */
  readonly composition: ContextComposition | undefined
}

/**
 * Read current context occupancy and composition from one projection cut.
 *
 * Takes the snapshot rather than the observer so a caller that also reads other
 * units — the status line reads Todo from the same cut — pays for one snapshot
 * per frame instead of one per consumer.
 * @param snapshot - the authoritative cut, or undefined when the profile mounts no registry.
 * @returns the small terminal-facing reading.
 */
export function contextReading(snapshot: ProjectionSnapshot | undefined): ContextReading {
  if (snapshot === undefined) {
    return { projections: false, metered: false, occupancy: undefined, composition: undefined }
  }
  const pressure = snapshot.values.contextPressure
  const breakdown = snapshot.values.contextBreakdown
  // `undefined` is the typed absence of an unregistered process-wide unit, which
  // is what a profile without the token meter looks like from here.
  const metered = pressure !== undefined || breakdown !== undefined
  // Both figures are absent until a provider reports usage, so a fresh session
  // reports no occupancy rather than a fabricated zero of an unknown window.
  const projected = pressure?.projectedTokens
  return {
    projections: true,
    metered,
    occupancy: projected === undefined
      ? undefined
      : { tokens: projected, capacity: pressure?.contextWindow },
    composition: breakdown === undefined
      ? undefined
      : {
        // Straight off Harness's `contextBreakdown` projection, whose three
        // figures are the authority for this split: the system share is the
        // surviving prompt node it classifies, not a header field this frontend
        // reads or a fold it repeats.
        system: breakdown.systemTokens,
        tools: breakdown.toolsTokens,
        messages: breakdown.messageTokens,
        total: breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens,
      },
  }
}

/**
 * The occupancy number the status line draws, or nothing to draw.
 *
 * Deliberately the projection's figure and not `tokenMeter.measure()`: the
 * status line needs one number, `measure()` prices and clones every surface
 * node to produce it, and the status line is redrawn on every spinner
 * heartbeat, every streamed delta, and every tool transition.
 * @param reading - the current cheap reading.
 * @returns prompt tokens for the next request, or undefined before a sample.
 */
export function contextPressureTokens(reading: ContextReading): number | undefined {
  return reading.occupancy?.tokens
}

/** What kind of context one current surface node is. */
export type ContextEntryKind =
  /**
   * The rendered system prompt.
   *
   * A surface node like any other since Session format V3: the loop appends the
   * first `system/message` as node 0 and a route that reads a later one appends
   * changes after the cached history, so a session can carry several — of which
   * the last nonempty one is in force. Named here because it is regularly the
   * largest node in a fresh session, and reading `context entry` for it answered
   * "what is occupying the context" with a shrug.
   */
  | 'system'
  /** A prompt the human typed. */
  | 'user'
  /** Producer-supplied context the model was given but nobody typed. */
  | 'context'
  /**
   * A compaction checkpoint: the summary standing in for a replaced span.
   *
   * Claimed only for a node carrying compaction's own durable provenance, never
   * for any replacement. See {@link isCompactionCheckpoint}.
   */
  | 'summary'
  /** One assistant reply, tool calls included. */
  | 'assistant'
  /** One tool's model-facing result. */
  | 'tool-result'
  /** A surface node whose event this frontend has never seen a type for. */
  | 'other'

/** One current surface node, resolved into something a person can read. */
export interface ContextEntry {
  /** Durable seq of the surface event; the entry's stable focus identity. */
  readonly seq: SessionSeq
  /** Position of this node in the current surface, one-based. */
  readonly position: number
  /** The node's priced tokens, as the meter reports them. Always an estimate. */
  readonly tokens: number
  /**
   * Share of the measured MESSAGE surface, 0 to 1; 0 when that total is 0.
   *
   * Deliberately not a share of the whole request context: the denominator is
   * `TokenMeasurement.surfaceTokens`, which prices the model-visible message
   * surface and nothing else. That surface now includes the system prompt's own
   * node, but the tool schemas are still priced by a different authority in a
   * different vocabulary (see {@link ContextComposition}), and adding the two
   * together to reach a whole-context percentage would be dshline inventing a
   * total neither authority states. Presentation must say which context this
   * divides.
   */
  readonly share: number
  /** What kind of context this is. */
  readonly kind: ContextEntryKind
  /** The producer's declared context form, for a `context` entry. */
  readonly form: string | undefined
  /** The tool's registered name, paired by call id; undefined when unpaired. */
  readonly tool: string | undefined
  /** The turn and step the event belongs to, when its type records them. */
  readonly turn: number | undefined
  readonly step: number | undefined
  /**
   * Whether this node entered the surface by replacing an earlier range.
   *
   * The generic surface fact and nothing more. Harness permits a replacement
   * from any producer, so this says a range was replaced — not who replaced it,
   * and not that the replacement was a reduction.
   */
  readonly replaced: boolean
}

/** The expensive per-node reading, produced only while an inspector is open. */
export interface ContextSurvey {
  /** Whether a per-node measurement was available and answered. */
  readonly available: boolean
  /**
   * Total priced tokens across the current surface — the share denominator.
   * Deliberately the measurement's own total rather than the occupancy figure:
   * shares must divide the number the node prices add up to, not one anchored
   * to a different vocabulary.
   */
  readonly surfaceTokens: number
  /** How many nodes the current surface has, before the display bound. */
  readonly nodes: number
  /** The largest entries, descending, bounded by the surveyor's limit. */
  readonly entries: readonly ContextEntry[]
}

/** The one thing a surveyor needs from the optional Harness token meter. */
export interface ContextMeter {
  /**
   * Price and clone every node of one session's current surface.
   * @param session - the session to measure.
   * @returns the detached measurement.
   */
  measure(session: Session): TokenMeasurement
}

/** Inputs a context surveyor needs from the runner. */
export interface ContextSurveyorSpec {
  /** The optional Harness meter, read fresh so a late mount is picked up. */
  readonly meter: () => ContextMeter | undefined
  /** Exact session whose surface is surveyed. */
  readonly session: Session
  /** Most entries to resolve; the inspector scrolls within them. */
  readonly limit: number
}

/**
 * The largest entries of one session's current surface, measured on demand.
 *
 * The cache key is every input a node price depends on and nothing else — the
 * surface revision and the effective pricing route (see {@link
 * ContextSurveyor.revision}) — rather than the log length. So an inspector left
 * open through a streaming reply, a spinner, or a turn's worth of tool calls
 * measures once, while a landed compaction or a route change is picked up on
 * the next paint. No timer and no polling: the overlay redraws on Harness's own change
 * feed and this answers from the cache until a priced input moves.
 */
export class ContextSurveyor {
  private cached: { revision: string; survey: ContextSurvey } | undefined

  /**
   * @param spec - meter accessor, exact session, and the display bound.
   */
  constructor(private readonly spec: ContextSurveyorSpec) {}

  /**
   * The current survey, measuring only when a priced input has moved.
   * @returns the bounded per-node reading.
   */
  read(): ContextSurvey {
    const revision = this.revision()
    if (this.cached?.revision === revision) return this.cached.survey
    const survey = this.survey()
    // Only a SUCCESSFUL survey is cached. An absent or refusing meter is a
    // capability that may arrive: the meter is a host-plane plugin a profile can
    // mount after this inspector first read, and `measure()` documents a throw
    // for a malformed log that a later append can repair. Caching either against
    // a revision would freeze "unavailable" for as long as the surface held
    // still, which on an idle session is forever.
    if (survey.available) this.cached = { revision, survey }
    else this.cached = undefined
    return survey
  }

  /**
   * Identity of everything a measurement's node prices depend on.
   *
   * Two inputs, both O(1) amortized reads of folds Harness already maintains:
   *
   * - the SURFACE revision — its node count and Harness's own monotonic
   *   `replaceGeneration`. Node count alone would serve a stale survey after a
   *   compaction, which SHRINKS the surface; the generation alone would miss an
   *   ordinary append. Together they also cover a system-prompt change, which is
   *   a surface change since Session format V3 — an in-history route appends a
   *   `system/message` node and an incapable one replaces the head — so there is
   *   nothing extra to track for the prompt.
   * - the effective pricing ROUTE, read from the folded request envelope. It is
   *   what `measure()` prices with: the header's provider and model select the
   *   routed adapter's declared image pricing, so the same surface reprices when
   *   the route changes. Read through `session.requestHeader()`, which folds each
   *   header event once, rather than through `request/context` — that record is
   *   route METADATA and upstream documents it as taking no part in request
   *   reconstruction, while the header is the thing the meter actually reads.
   *
   * Deliberately NOT the log length: that moves on every committed event a turn
   * logs — request headers, steps, tool calls and results, settled Assistant
   * attempts — and remeasuring the whole surface for each would pay O(surface)
   * repeatedly for no new priced fact.
   * @returns a string identity for the current priced inputs.
   */
  private revision(): string {
    const { session } = this.spec
    const surface = session.surface
    // Guarded: the accessor folds header events, and a malformed one throws
    // there exactly as it would inside `measure()`. An unreadable route degrades
    // to a distinct identity rather than taking the read down.
    let route = '?'
    try {
      const config = session.requestHeader()?.config
      if (config !== undefined) route = `${config.provider}/${config.model}`
    } catch {
      route = '!'
    }
    return `${String(surface.nodes.length)}:${String(surface.replaceGeneration)}:${route}`
  }

  /** Drop the cache, for a caller that knows the measurement is stale. */
  invalidate(): void {
    this.cached = undefined
  }

  /** Measure and resolve once. */
  private survey(): ContextSurvey {
    const meter = this.spec.meter()
    if (meter === undefined) return { available: false, surfaceTokens: 0, nodes: 0, entries: [] }
    let measurement: TokenMeasurement
    try {
      measurement = meter.measure(this.spec.session)
    } catch {
      // The meter documents throws for a malformed log. An inspector that says
      // so is better than one that takes the whole live region down with it.
      return { available: false, surfaceTokens: 0, nodes: 0, entries: [] }
    }
    return {
      available: true,
      surfaceTokens: measurement.surfaceTokens,
      nodes: measurement.nodes.length,
      entries: resolveEntries(this.spec.session, measurement, this.spec.limit),
    }
  }
}

/**
 * The largest measured nodes, resolved against the durable log.
 *
 * Sorted by price descending, then by seq ascending so equal sizes keep one
 * stable order across paints rather than swapping under the cursor.
 * @param session - the session the measurement came from.
 * @param measurement - the meter's detached snapshot.
 * @param limit - most entries to resolve.
 * @returns the bounded resolved entries.
 */
export function resolveEntries(
  session: Session,
  measurement: TokenMeasurement,
  limit: number,
): readonly ContextEntry[] {
  const { nodes, surfaceTokens } = measurement
  const positions = new Map<number, number>()
  for (const [index, node] of nodes.entries()) positions.set(node.seq, index + 1)
  const ranked = [...nodes].sort(compareNodes).slice(0, Math.max(0, limit))
  const tools = toolNames(session, ranked)
  return ranked.map(node => entryOf(
    session,
    node,
    positions.get(node.seq) ?? 0,
    surfaceTokens,
    tools,
  ))
}

/** Largest first; equal sizes fall back to log order so the ordering is stable. */
function compareNodes(left: TokenSurfaceNode, right: TokenSurfaceNode): number {
  return right.tokens - left.tokens || left.seq - right.seq
}

/**
 * Registered tool names for the results among these nodes, paired by call id.
 *
 * Paired by the `callId` the contract says pairs a `tool/call` with its
 * `tool/result`, never by adjacency: a parallel batch interleaves calls and
 * results, so the neighbouring call is regularly the wrong one. One backward
 * pass of point reads, stopping as soon as every wanted id is answered.
 *
 * Deliberately `eventAt()` rather than `snapshotEvents()`: the answer is
 * almost always a handful of events below the newest wanted result, and
 * materializing the whole log to scan it backwards would turn a bounded
 * early-stopping search into O(log length) work on every inspector frame.
 * @param session - the session holding the durable log.
 * @param nodes - the nodes about to be resolved.
 * @returns call id to registered tool name, for the ids that were found.
 */
function toolNames(
  session: Session,
  nodes: readonly TokenSurfaceNode[],
): ReadonlyMap<string, string> {
  const wanted = new Set<string>()
  let from: SessionSeq | undefined
  for (const node of nodes) {
    const event = session.eventAt(node.seq)
    if (event?.type !== 'tool/result') continue
    const callId = event.data.message.content[0]?.toolCallId
    if (callId === undefined) continue
    wanted.add(callId)
    if (from === undefined || node.seq > from) from = node.seq
  }
  const found = new Map<string, string>()
  if (wanted.size === 0 || from === undefined) return found
  // `from` is the seq of an event this log actually returned, so every
  // position at or below it denotes an existing event: the descending
  // arithmetic re-enters the branded domain through `SessionSeq` without a
  // bounds question of its own.
  for (let seq = from - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type !== 'tool/call') continue
    const { callId, name } = event.data
    if (!wanted.delete(callId)) continue
    found.set(callId, name)
    if (wanted.size === 0) break
  }
  return found
}

/** Resolve one measured node against its durable event. */
function entryOf(
  session: Session,
  node: TokenSurfaceNode,
  position: number,
  surfaceTokens: number,
  tools: ReadonlyMap<string, string>,
): ContextEntry {
  const event = session.eventAt(node.seq)
  const share = surfaceTokens > 0 ? node.tokens / surfaceTokens : 0
  const base = {
    seq: node.seq,
    position,
    tokens: node.tokens,
    share,
    replaced: event !== undefined && isReplacementSurfaceEvent(event),
  }
  if (event === undefined) {
    // A node whose event is not in this log window is reported as what it is
    // rather than guessed at: the price is still the meter's, the identity is not.
    return { ...base, kind: 'other', form: undefined, tool: undefined, turn: undefined, step: undefined }
  }
  return { ...base, ...identityOf(event, tools) }
}

/**
 * Whether one surface message's provenance is a compaction checkpoint.
 *
 * A STRUCTURAL check against the durable checkpoint source every compaction
 * backend is required to write — `{ kind: 'plugin', plugin: 'compact' }` plus
 * the transaction's `compactionId`, as `compactCheckpointSource` in
 * `@deepseek-ai/dsh-compaction/checkpoint` constructs it and
 * `isCompactCheckpointSource` recognizes it. The predicate is not imported,
 * deliberately: it is a VALUE, and the compaction plugin is optional, so
 * importing it would give a frontend that must start without compaction a hard
 * runtime dependency on it. The marker is a persisted contract rather than a
 * private implementation detail — it exists precisely so a consumer can
 * recognize a checkpoint independently of the backend — so reading it off the
 * restored source is the same authority the predicate reads.
 *
 * `compactionId` is required as well as the marker, because it is what makes
 * the source a compaction TRANSACTION's checkpoint rather than any message some
 * plugin named `compact` happened to inject.
 * @param source - the message source restored from the durable log.
 * @returns whether this message is a compaction's replacement checkpoint.
 */
function isCompactionCheckpoint(source: SessionEvent<'user/message'>['data']['source']): boolean {
  if (source.kind !== 'plugin' || source.plugin !== 'compact') return false
  return typeof (source as { compactionId?: unknown }).compactionId === 'string'
}

/** The identity fields one surface event contributes. */
function identityOf(
  event: SessionEvent,
  tools: ReadonlyMap<string, string>,
): Pick<ContextEntry, 'kind' | 'form' | 'tool' | 'turn' | 'step'> {
  const none = { form: undefined, tool: undefined, turn: undefined, step: undefined }
  switch (event.type) {
    case 'system/message':
      return { ...none, kind: 'system', turn: event.data.turn, step: event.data.step }
    case 'assistant/message':
      return { ...none, kind: 'assistant', turn: event.data.turn, step: event.data.step }
    case 'tool/result': {
      const callId = event.data.message.content[0]?.toolCallId
      return {
        ...none,
        kind: 'tool-result',
        tool: callId === undefined ? undefined : tools.get(callId),
        turn: event.data.turn,
        step: event.data.step,
      }
    }
    case 'user/message': {
      const source = event.data.source
      // A compaction summary is claimed only from compaction's OWN durable
      // provenance, not from the fact that a range was replaced: the surface
      // contract lets any producer replace a range, so "replaced" alone would
      // have named a summary wherever anything else rewrote history.
      if (isCompactionCheckpoint(source)) return { ...none, kind: 'summary' }
      if (source.kind === 'user') return { ...none, kind: 'user' }
      return {
        ...none,
        kind: 'context',
        // The producer's own declared form, when it declared one. An absent
        // form is upstream's documented default and stays absent here.
        form: 'form' in source && typeof source.form === 'string' ? source.form : undefined,
      }
    }
    default:
      return { ...none, kind: 'other' }
  }
}

/** Characters of one entry preview, before the reader is told it was cut. */
const PREVIEW_CHARS = 4_000

/** One bounded preview of an entry's model-facing content. */
export interface ContextPreview {
  /** Raw text, still unescaped: the caller escapes before it adds colour. */
  readonly text: string
  /** Whether the bound cut further content. */
  readonly truncated: boolean
  /** Whether the event could be read at all. */
  readonly available: boolean
}

/**
 * What one surface node actually contains, bounded for a terminal.
 *
 * Read through `deriveEventMessage`, which is the one per-node projection rule
 * Harness builds its own requests from — so the preview is the content the
 * model carries, not a second interpretation of the log.
 * @param session - the session holding the durable log.
 * @param seq - the node's durable seq.
 * @returns bounded raw text and whether it was cut.
 */
export function contextPreview(session: Session, seq: SessionSeq): ContextPreview {
  const event = session.eventAt(seq)
  if (event === undefined) return { text: '', truncated: false, available: false }
  const message = deriveEventMessage(event)
  if (message === null) return { text: '', truncated: false, available: false }
  const text = blockText(message.content)
  return text.length > PREVIEW_CHARS
    ? { text: text.slice(0, PREVIEW_CHARS), truncated: true, available: true }
    : { text, truncated: false, available: true }
}

/**
 * Flatten model-facing blocks to text, naming the ones that carry none.
 *
 * A node can be large because of a tool call's arguments or an image, not only
 * because of prose, and a preview that showed nothing for those would answer
 * "why is this large?" with a blank box.
 * @param blocks - the message's content blocks.
 * @returns the joined text.
 */
function blockText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        parts.push(block.text)
        break
      case 'tool-call':
        parts.push(`${block.name} ${block.arguments}`)
        break
      case 'tool-result':
        parts.push(blockText(block.content))
        break
      default:
        // ContentBlockMap is merge-extensible: a block this frontend has never
        // seen is named by its type rather than dropped or guessed at.
        parts.push(`[${block.type}]`)
    }
  }
  return parts.join('\n').trim()
}
