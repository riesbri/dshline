/**
 * The `/worktrees` command: what it needs, and how a choice becomes a transition.
 *
 * The invariant this module protects is that one dshline window drives one
 * root Session. `/worktrees` does not open a tab, a pane, or a second agent —
 * it resolves to exactly the same two attachment targets `/sessions` and
 * `/new` already produce, and hands them to the window's own transition:
 *
 * ```
 * current attachment
 *     ↓ retire (the owned AgentHandle disposer)
 * next target
 *     ↓
 * ctx.agents.resume({ resumeSessionId })      an existing conversation
 * ctx.agents.create({ meta: { cwd } })        a fresh one in the chosen worktree
 *     ↓
 * next attachment
 * ```
 *
 * Parallel work across worktrees is therefore still several terminals, each
 * rooted in its own directory — which is what the shell already gives, and
 * what a multiplexer inside the frontend would take over badly.
 * @module dshline/worktrees
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionEntry } from '../sessions/model.ts'
import type { NewPlan, ResumePlan } from '../sessions/plan.ts'
import { WorktreeCatalog } from './catalog.ts'
import { worktreesSeams } from './harness.ts'
import type { WorktreeChoice, WorktreeRow } from './model.ts'
import { createWorktreesOverlay } from './overlay.ts'

export type { RegisterOutcome, WorktreeCatalogSpec } from './catalog.ts'
export { WORKTREE_SESSION_LIMIT, WorktreeCatalog } from './catalog.ts'
export type {
  MembershipOutcome,
  WorkspaceEntry,
  WorkspaceRegistryReads,
  WorktreeSeams,
} from './harness.ts'
export { recordWorkspaceMembership, worktreesSeams } from './harness.ts'
export type {
  WorktreeChoice,
  WorktreeListing,
  WorktreeListRow,
  WorktreeRow,
  WorktreeSelection,
  WorktreeSessionRow,
  WorktreeStatus,
} from './model.ts'
export {
  listingMessage,
  matchesWorktree,
  sessionCountLabel,
  sessionsMessage,
  worktreeListRows,
  worktreePath,
  worktreeSessionRows,
} from './model.ts'
export { membershipFailureLines, recordAttachmentMembership } from './membership.ts'
export type { WorktreesOverlaySpec } from './overlay.ts'
export { createWorktreesOverlay } from './overlay.ts'

/** What opening the picker needs to know about the window it opens over. */
export interface WorktreesSpec {
  /** Context carrying the Workspace registry, the session corpus, and the slots. */
  readonly ctx: Context
  /** The session this window is driving. */
  readonly currentSessionId: SessionId
  /**
   * The workspace the attached session is rooted in.
   *
   * Its header's own `cwd`. Used to mark the current row and to decide whether
   * to offer registration; never to re-root anything.
   */
  readonly currentWorkspace: string
  /**
   * Decide whether reopening one session is safe right now.
   *
   * The whole plan rather than the conditions it reads, and a function
   * rather than a value: the picker stays open across turns, so the busy and
   * active-work facts have to be sampled at the instant `enter` is pressed.
   * It is the same {@link planResume} `/sessions` uses — retiring this agent
   * for a worktree is exactly as consequential as retiring it for a session.
   */
  readonly planResume: (entry: SessionEntry) => ResumePlan
  /** Decide whether retiring this attachment for a fresh session is safe right now. */
  readonly planNew: () => NewPlan
  /** The user's home directory; injected so path shortening is assertable. */
  readonly home: string
  /** Current time; injected so relative ages are assertable. */
  readonly now?: () => number
}

/**
 * Show the `/worktrees` picker and wait for the reader's answer.
 *
 * Resolves with a transition only when the reader chose one AND its plan
 * accepted it, so the caller never re-checks the conditions. Dismissing, or
 * choosing something a plan refused, resolves with undefined.
 * @param spec - the context, the attached session, and the live plans.
 * @returns the attachment transition to request, or undefined.
 */
export async function openWorktrees(spec: WorktreesSpec): Promise<WorktreeChoice | undefined> {
  const { ctx } = spec
  const catalog = new WorktreeCatalog({
    registry: worktreesSeams(ctx).workspaceRegistry,
    query: ctx.get('sessionQuery'),
    invalidate: () => { ctx.tuiSlots.invalidate() },
    currentWorkspace: spec.currentWorkspace,
    ...(spec.now === undefined ? {} : { now: spec.now }),
  })
  catalog.refresh()
  try {
    return await new Promise<WorktreeChoice | undefined>(resolve => {
      let dismiss = (): void => {}
      let settled = false
      let chosen: WorktreeChoice | undefined
      const settle = (): void => {
        // Once-only, for the reason every overlay here settles once: the slot
        // registry can deliver one more keystroke between the decision and the
        // unmount.
        if (settled) return
        settled = true
        dismiss()
        resolve(chosen)
      }
      const overlay = createWorktreesOverlay({
        listing: () => catalog.listing(),
        unregistered: () => catalog.unregistered(),
        selection: () => catalog.selection(),
        open: workspaceId => { catalog.select(workspaceId) },
        back: () => { catalog.select(undefined) },
        register: path => catalog.register(path),
        resume: entry => {
          const plan = spec.planResume(entry)
          if (plan.kind === 'resume') chosen = { kind: 'resume', id: entry.id }
          return plan
        },
        create: (workspace: WorktreeRow) => {
          const plan = spec.planNew()
          if (plan.kind === 'new') {
            chosen = { kind: 'new', cwd: workspace.path, workspaceId: workspace.id }
          }
          return plan
        },
        currentSessionId: spec.currentSessionId,
        home: spec.home,
        now: spec.now ?? ((): number => Date.now()),
        close: settle,
        invalidate: () => { ctx.tuiSlots.invalidate() },
      })
      dismiss = ctx.tuiSlots.pushOverlay(overlay)
    })
  } finally {
    // In-flight listing, resolve, and session reads are abandoned with the
    // picker: their results would repaint a live region that has moved on.
    catalog.dispose()
  }
}
