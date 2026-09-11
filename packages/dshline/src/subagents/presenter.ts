/**
 * The durable subagent-conversation presenter.
 *
 * This is the adapter layer between Harness authority and the terminal: it
 * reads durable direct children from `ctx.subagents.listChildren`, reads one
 * child's bounded session window from `ctx.sessionQuery`, and routes human
 * follow-up/steer through the one human prompt operation Harness publishes.
 * It owns no lifecycle, no scheduling, and no child conversation state — every
 * paint re-reads the current reading, and neither a refresh nor a keystroke
 * invents a row the authority did not publish.
 *
 * It is deliberately separate from `HarnessWork`. Work owns active lifecycle
 * epochs keyed by `runId`, and a settled continuable child has no epoch while
 * still being a durable conversation. Folding this into Work would also make
 * `activeWorkCount` see a settled child, which gates retiring the session.
 *
 * Interruption is NOT implemented here: it is delegated to the one
 * `HarnessWork.interruptSubagent` adapter so the terminal never grows a second
 * human authorization path.
 * @module dshline/subagents/presenter
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { LocalCommand } from '../local-commands.ts'
import type { TuiSlots } from '../slots.ts'
import { openSurface, SurfaceNotice } from '../surface.ts'
import type { WorkInterruptResult } from '../work/model.ts'
import { deliverHumanPrompt, type HumanPromptDelivery } from './control.ts'
import {
  catalogReading,
  subagentRowFollowUp,
  subagentRowInterruptible,
  subagentRowLabel,
  type SubagentCatalogReading,
  type SubagentChildRow,
} from './model.ts'
import {
  CONVERSATION_NOTICE_MS,
  createSubagentCatalogOverlay,
  createSubagentConversationOverlay,
  createSubagentMessageOverlay,
} from './overlay.ts'
import type { ChildSessionReads, HumanSubagentSeam } from './seam.ts'
import {
  initialTranscript,
  readTranscriptOlder,
  readTranscriptTail,
  transcriptReading,
  type TranscriptState,
} from './transcript.ts'

/** Narrow dependencies the subagent-conversation presenter needs. */
export interface SubagentsPresenterDeps {
  /** Live-region registry that owns the overlay stack. */
  readonly slots: Pick<TuiSlots, 'pushOverlay'>
  /** The attached session, which is the durable direct parent Harness authorizes. */
  readonly parentSessionId: SessionId
  /** Redraw after a read or action changes presentation state. */
  readonly invalidate: () => void
  /** Human-authoritative subagent operations, or undefined without `ctx.subagents`. */
  readonly subagents?: HumanSubagentSeam
  /** Bounded child-session reads, or undefined without `ctx.sessionQuery`. */
  readonly query?: ChildSessionReads
  /**
   * Human interrupt, routed to the single `HarnessWork` adapter.
   * @param childId - the durable direct child.
   * @param authorized - whether Harness's descriptor mode authorizes interruption.
   */
  readonly interrupt: (childId: string, authorized: boolean) => WorkInterruptResult
  /** Subscribe to parent-scoped subagent lifecycle edges. */
  readonly onLifecycle?: (listener: () => void) => () => void
  /**
   * Subscribe to Harness session events, for a selected child's staleness hint.
   * @param listener - receives the event's durable session id.
   */
  readonly onSessionEvent?: (listener: (sessionId: string) => void) => () => void
}

/** The subagent-conversation capability as one local command and entry point. */
export interface SubagentsPresenter {
  /** `/subagents` — browse durable direct children and inspect one. */
  readonly command: LocalCommand
  /** Open the catalog; Work's `c` key calls this. */
  open(): void
  /** Abort in-flight reads and release lifecycle subscriptions. */
  dispose(): void
}

/** One open conversation inspector's presenter-owned state. */
interface OpenConversation {
  /** The durable child being inspected; refreshed when discovery re-lists it. */
  child: SubagentChildRow
  /** The currently loaded bounded transcript state. */
  transcript: TranscriptState
  /** Cancels this inspector's in-flight reads when it closes or navigates. */
  readonly abort: AbortController
  /**
   * Identity of the newest read started for this inspector. A read that settles
   * after a newer one started is discarded, so two quick refreshes (or a refresh
   * racing a paging read) cannot publish an older window over a newer one.
   */
  readGeneration: number
  /** The inspector's own outcome notice. */
  readonly notice: SurfaceNotice
}

/**
 * Build the durable subagent-conversation presenter.
 * @param deps - narrow Harness seams, the parent address, and surface controls.
 * @returns the presenter's local command and Work entry point.
 */
export function createSubagentsPresenter(deps: SubagentsPresenterDeps): SubagentsPresenter {
  let catalog: SubagentCatalogReading = deps.subagents === undefined
    ? { kind: 'unavailable' }
    : { kind: 'loading' }
  let catalogGeneration = 0
  let catalogAbort: AbortController | undefined
  let catalogOpen = false
  let closeCatalog: (() => void) | undefined

  let conversation: OpenConversation | undefined
  let conversationAbort: AbortController | undefined

  const disposers: (() => void)[] = []

  /** Re-run durable discovery under a generation guard. */
  const refreshCatalog = (): void => {
    const seam = deps.subagents
    if (seam === undefined) {
      catalog = { kind: 'unavailable' }
      deps.invalidate()
      return
    }
    const generation = (catalogGeneration += 1)
    catalogAbort?.abort()
    const abort = new AbortController()
    catalogAbort = abort
    // The previous listing's rows are dropped rather than kept: an aging list
    // beside a "loading" label would present stale facts as current ones.
    catalog = { kind: 'loading' }
    deps.invalidate()
    void seam.listChildren(deps.parentSessionId, abort.signal).then(entries => {
      if (generation !== catalogGeneration) return
      catalog = catalogReading(entries)
      // An open inspector keeps showing the freshest residency Harness published
      // rather than the snapshot taken when it opened. Durable identity, mode,
      // and label do not change, but residency can.
      const open = conversation
      if (open !== undefined && catalog.kind === 'ready') {
        const fresh = catalog.rows.find(
          (row): row is SubagentChildRow => row.kind === 'child' && row.id === open.child.id,
        )
        if (fresh !== undefined) open.child = fresh
      }
      deps.invalidate()
    }).catch((error: unknown) => {
      if (generation !== catalogGeneration) return
      // Discovery failing is not "no children": the reading says so, and it
      // never falls back to scanning or to another registry.
      catalog = { kind: 'failed', message: reason(error) }
      deps.invalidate()
    })
  }

  /** Re-read the newest page of one open inspector. */
  const reload = (state: OpenConversation): void => {
    const query = deps.query
    if (query === undefined) return
    const generation = (state.readGeneration += 1)
    void readTranscriptTail(query, state.child.id as SessionId, state.abort.signal).then(next => {
      if (conversation !== state || state.readGeneration !== generation) return
      state.transcript = next
      deps.invalidate()
    })
  }

  /** Append one older page, keeping the loaded window on a failed read. */
  const loadOlder = (state: OpenConversation): void => {
    const query = deps.query
    if (query === undefined || state.transcript.kind !== 'ready' || !state.transcript.hasOlder) return
    const generation = (state.readGeneration += 1)
    void readTranscriptOlder(query, state.child.id as SessionId, state.transcript, state.abort.signal)
      .then(next => {
        if (conversation !== state || state.readGeneration !== generation) return
        state.transcript = next
        deps.invalidate()
      })
      .catch((error: unknown) => {
        if (conversation !== state || state.readGeneration !== generation) return
        state.notice.show(`Older events failed: ${reason(error)}`, true)
        deps.invalidate()
      })
  }

  /** Interrupt through the shared Work adapter and report its outcome. */
  const interruptChild = (state: OpenConversation): void => {
    const result = deps.interrupt(state.child.id, subagentRowInterruptible(state.child))
    state.notice.show(result.message, result.kind === 'failed')
    deps.invalidate()
  }

  /** Push the small message composer over one inspector. */
  const openComposer = (state: OpenConversation, delivery: HumanPromptDelivery): void => {
    openSurface(deps.slots, close => createSubagentMessageOverlay({
      childLabel: subagentRowLabel(state.child),
      delivery,
      submit: (text, signal) => deliverHumanPrompt(deps.subagents, {
        parentSessionId: deps.parentSessionId,
        childId: state.child.id as SessionId,
        text,
        delivery,
      }, signal),
      onAccepted: () => {
        // Harness accepted the message; the durable log is the only place the
        // message may appear, so the receipt is a notice and never a row.
        state.notice.show('Follow-up accepted')
        deps.invalidate()
      },
      close,
      invalidate: deps.invalidate,
    }))
  }

  /** Push the read-only conversation inspector over the catalog. */
  const openConversation = (childId: string): void => {
    const row = catalog.kind === 'ready'
      ? catalog.rows.find(candidate => candidate.kind === 'child' && candidate.id === childId)
      : undefined
    if (row === undefined || row.kind !== 'child') return
    conversationAbort?.abort()
    const state: OpenConversation = {
      child: row,
      transcript: initialTranscript(deps.query !== undefined),
      abort: new AbortController(),
      readGeneration: 0,
      notice: new SurfaceNotice(CONVERSATION_NOTICE_MS),
    }
    conversation = state
    conversationAbort = state.abort
    if (deps.query !== undefined) reload(state)
    openSurface(deps.slots, close => createSubagentConversationOverlay({
      child: () => state.child,
      reading: () => transcriptReading(state.transcript),
      followUp: subagentRowFollowUp(row, deps.subagents !== undefined),
      steer: subagentRowFollowUp(row, deps.subagents !== undefined),
      interruptible: subagentRowInterruptible(row),
      loadOlder: () => { loadOlder(state) },
      refresh: () => { reload(state) },
      message: delivery => { openComposer(state, delivery) },
      interrupt: () => { interruptChild(state) },
      notice: state.notice,
      close: () => {
        if (conversation === state) conversation = undefined
        // Cancel this inspector's in-flight reads now, rather than waiting for
        // the next open or teardown, so a late page never reaches a dead surface.
        state.abort.abort()
        close()
      },
      invalidate: deps.invalidate,
    }))
  }

  /** Open the durable-child catalog, replacing any catalog already open. */
  const open = (): void => {
    closeCatalog?.()
    catalogOpen = true
    refreshCatalog()
    closeCatalog = openSurface(deps.slots, close => createSubagentCatalogOverlay({
      reading: () => catalog,
      inspect: childId => { openConversation(childId) },
      refresh: refreshCatalog,
      close: () => {
        catalogOpen = false
        closeCatalog = undefined
        close()
      },
      invalidate: deps.invalidate,
    }))
  }

  if (deps.onLifecycle !== undefined) {
    disposers.push(deps.onLifecycle(() => {
      if (catalogOpen) refreshCatalog()
    }))
  }
  if (deps.onSessionEvent !== undefined) {
    disposers.push(deps.onSessionEvent(childId => {
      const state = conversation
      // A child event is only a staleness hint: it never mutates the transcript
      // and never triggers a read, because Harness publishes no per-child
      // transcript subscription and polling one would be a local state machine.
      if (state === undefined || state.child.id !== childId || state.transcript.kind !== 'ready') return
      state.transcript = { ...state.transcript, stale: true }
      deps.invalidate()
    }))
  }

  return {
    command: {
      name: 'subagents',
      description: 'Browse durable subagent conversations and continue one',
      execute: () => { open() },
    },
    open,
    dispose(): void {
      catalogGeneration += 1
      catalogAbort?.abort()
      conversationAbort?.abort()
      conversation = undefined
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

/**
 * A short, safe account of a read or discovery failure.
 * @param error - the thrown value.
 * @returns a message fit for a bounded row.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
