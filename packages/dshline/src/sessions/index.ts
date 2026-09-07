/**
 * Opening the Sessions browser, from launch or from inside a session.
 *
 * One entry point for both, on purpose. `--resume` with no id and `/sessions`
 * ask the same question — which past session do you want — and the only thing
 * that differs is what is at stake when the answer arrives: at launch there is
 * no agent yet, so every choice is free, while inside a session the choice
 * retires a live agent and therefore has to pass {@link planResume}.
 *
 * Encoding that as one browser with different conditions rather than two
 * pickers is what keeps the launch path from being the poor relation it was:
 * search, titles, workspaces, lineage, and the same keyboard are available
 * before the first agent exists.
 * @module dshline/sessions
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { escapeControls } from '@dshline/renderer'
import { promptText } from '../prompt.ts'
import { SessionCatalog } from './catalog.ts'
import { createSessionsOverlay, type RenameDraftOutcome } from './overlay.ts'
import { CHILD_CLOSE_REQUESTED, type SessionsChildOverlay } from './panels.ts'
import { planResume } from './plan.ts'

export type { SessionCatalogSpec, SessionQueryReads } from './catalog.ts'
export { CATALOG_LIMIT, CONTENT_SEARCH_LIMIT, SessionCatalog } from './catalog.ts'
export type { AgeChoice, OriginChoice, SessionFiltersValue, WorkspaceChoice } from './filters.ts'
export { equalFilters, NO_FILTERS } from './filters.ts'
export type {
  CatalogState,
  ContentState,
  EventHitEntry,
  EventSearchState,
  LineageState,
  SessionDetail,
  SessionEntry,
  SessionFact,
  SessionOrigin,
  SessionSearchMode,
} from './model.ts'
export { CURRENT, filterEntries, matchesQuery, relativeAge, sessionFacts, sessionLabel, shortWorkspace, UNTITLED } from './model.ts'
export { createSessionsOverlay } from './overlay.ts'
export type { RenameDraftOutcome, ResumeRequest, SessionsOverlaySpec } from './overlay.ts'
export type { ResumeConditions, ResumePlan } from './plan.ts'
export { planResume } from './plan.ts'
export type { AgentOpener, Attached, AttachOutcome, AttachSpec, AttachTarget } from './reopen.ts'
export { attachTarget, newSessionFailureLines, reopenFailureLines } from './reopen.ts'

/** Result of asking Harness to accept a user-supplied session title. */
export type RenameTitleResult =
  /** Accepted, carrying Harness's normalized title. */
  | { readonly ok: true; readonly title: string }
  /** Rejected, carrying the reason safe to report to the reader. */
  | { readonly ok: false; readonly message: string }

/** What opening the browser needs to know about the window it opens over. */
export interface BrowseSpec {
  /** Context carrying `ctx.sessionQuery` and the slot registry. */
  readonly ctx: Context
  /** The session this window is driving, or undefined before an agent exists. */
  readonly currentSessionId: SessionId | undefined
  /**
   * Whether the attached agent is mid-turn.
   *
   * A function rather than a value: the browser stays open across turns, and the
   * answer that matters is the one at the moment `enter` is pressed.
   */
  readonly busy: () => boolean
  /** Jobs and subagents attached to the session that would be left. */
  readonly activeWork: () => number
  /** Rename authority supplied only by the caller holding the live session. */
  readonly renameTitle?: (title: string) => Promise<RenameTitleResult>
  /** The user's home directory; injected so path shortening is assertable. */
  readonly home?: string
  /** Effective workspace used by the catalog's `current` filter. */
  readonly workspace?: string
  /** Current time; injected so relative ages are assertable. */
  readonly now?: () => number
}

/**
 * Show the Sessions browser and wait for the reader's answer.
 *
 * Resolves with a session id only when the reader chose one AND the resume plan
 * accepted it, so the caller never has to re-check the conditions. Dismissing,
 * or choosing a session the plan refused, resolves with undefined.
 * @param spec - the context, the current session, and the live conditions.
 * @returns the session to reopen, or undefined when nothing was chosen.
 */
export async function browseSessions(spec: BrowseSpec): Promise<SessionId | undefined> {
  const { ctx } = spec
  const catalog = new SessionCatalog({
    query: ctx.get('sessionQuery'),
    invalidate: () => { ctx.tuiSlots.invalidate() },
    ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
    ...(spec.now === undefined ? {} : { now: spec.now }),
  })
  catalog.refresh()
  const renameDraft = async (focusedTitle: string | undefined): Promise<RenameDraftOutcome> => {
    // The focused row's title is the prefill: when the current session was
    // found through content search, the bounded base listing may not contain
    // it, and the row already carries the authoritative folded title.
    const entryTitle = focusedTitle ?? ''
    const draft = await promptText(ctx, {
      title: 'Rename session',
      message: entryTitle === ''
        ? 'Rename this session'
        : `Rename “${escapeControls(entryTitle)}”`,
      kind: 'text',
      initial: entryTitle,
      view: 'Sessions · rename',
    })
    if (draft === undefined) return { kind: 'cancelled' }
    if (spec.renameTitle === undefined) {
      return { kind: 'failed', message: 'No rename capability in this window.' }
    }
    const outcome = await spec.renameTitle(draft)
    if (!outcome.ok) return { kind: 'failed', message: outcome.message }
    // Re-observe titles for every live projection: the base listing, the
    // active content-search chain, and any cached lineage tree.
    catalog.refreshTitles()
    return { kind: 'renamed', title: outcome.title }
  }
  try {
    return await new Promise<SessionId | undefined>(resolve => {
      let dismiss = (): void => {}
      let settled = false
      let chosen: SessionId | undefined
      const settle = (): void => {
        // The overlay dismisses itself on an accepted resume and the registry
        // may deliver one more keystroke before the unmount, so settlement is
        // once-only for the same reason the select overlay's is.
        if (settled) return
        settled = true
        dismiss()
        resolve(chosen)
      }
      const overlay = createSessionsOverlay({
        listing: () => catalog.listing(),
        content: () => catalog.content(),
        filters: () => catalog.filters(),
        applyFilters: filters => { catalog.applyFilters(filters) },
        loadMoreContent: () => { catalog.loadMoreContent() },
        restartContentSearch: () => { catalog.restartContentSearch() },
        lineage: sessionId => catalog.lineage(sessionId),
        requestLineage: sessionId => { catalog.requestLineage(sessionId) },
        events: () => catalog.events(),
        searchEvents: (sessionId, text) => { catalog.searchEvents(sessionId, text) },
        loadMoreEvents: () => { catalog.loadMoreEvents() },
        detail: sessionId => catalog.detail(sessionId),
        requestDetail: sessionId => { catalog.requestDetail(sessionId) },
        search: text => { catalog.search(text) },
        currentSessionId: spec.currentSessionId,
        workspace: spec.workspace,
        home: spec.home ?? homedir(),
        now: spec.now ?? ((): number => Date.now()),
        resume: entry => {
          const plan = planResume({
            target: entry,
            currentSessionId: spec.currentSessionId,
            busy: spec.busy(),
            activeWork: spec.activeWork(),
          })
          if (plan.kind === 'resume') chosen = entry.id
          return plan
        },
        ...(spec.renameTitle === undefined ? {} : { renameDraft }),
        push: child => {
          const signalled = child as Partial<SessionsChildOverlay>
          if (signalled[CHILD_CLOSE_REQUESTED] === undefined) {
            ctx.tuiSlots.pushOverlay(child)
            return
          }
          let dismiss = (): void => {}
          const wrapper = {
            render: (columns: number, rows?: number) => child.render(columns, rows),
            handleKey: (key: Parameters<typeof child.handleKey>[0]) => {
              child.handleKey(key)
              if (signalled[CHILD_CLOSE_REQUESTED]?.()) dismiss()
            },
            ...(child.mounted === undefined ? {} : { mounted: () => { child.mounted?.() } }),
            ...(child.dispose === undefined ? {} : { dispose: () => { child.dispose?.() } }),
          }
          dismiss = ctx.tuiSlots.pushOverlay(wrapper)
        },
        close: settle,
        invalidate: () => { ctx.tuiSlots.invalidate() },
      })
      dismiss = ctx.tuiSlots.pushOverlay(overlay)
    })
  } finally {
    // In-flight listing, search, and detail reads are abandoned with the
    // browser: their results would repaint a live region that has moved on.
    catalog.dispose()
  }
}
