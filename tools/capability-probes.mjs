/**
 * The Harness capability seams this frontend depends on, and where each one's
 * compatibility evidence already lives.
 *
 * This is a POINTER table, not a second copy of the contract: every entry
 * names at least one existing or purpose-built test that reaches the relevant
 * Harness class, base contract, or dshline integration. Some files use local
 * subclasses or fixtures because a seam is intentionally abstract; those local
 * implementations are not evidence for a concrete deployment policy. If a
 * named seam's consumed contract changes upstream, its file fails by capability
 * name before anything has to fall back to a generic `pnpm typecheck failed`.
 *
 * Adding a capability dshline newly depends on means adding one line here that
 * names an already-real test, or a small new probe under
 * `packages/dshline/tests/capability/`; it does not mean teaching this module
 * anything about the seam's shape. See docs/architecture.md, "Upstream
 * compatibility", and ROADMAP.md, "Upstream compatibility strategy".
 * @module tools/capability-probes
 */

/**
 * One capability's compatibility evidence.
 * @typedef {object} CapabilityProbe
 * @property {string} name - the seam's name, matching `docs/architecture.md`'s
 *   capability-surface vocabulary (`sessionQuery`, `jobs`, `subagents`, …).
 * @property {string[]} files - repository-relative test files containing this
 *   capability's named evidence and runtime verdict.
 * @property {string} [note] - shown beside the capability name in the report,
 *   for coverage that rides on an existing acceptance test rather than a
 *   dedicated probe.
 */

/** @type {readonly CapabilityProbe[]} */
export const CAPABILITY_PROBES = [
  {
    name: 'sessionQuery',
    files: ['packages/dshline/tests/sessions-query.integration.spec.ts'],
    note: 'real query service/store list, filter, title, and trace paths; full-text search uses local abstract-contract fixtures rather than a production search backend',
  },
  {
    name: 'agents',
    files: ['packages/dshline/tests/capability/agents.probe.spec.ts'],
    note: 'real AgentRegistry get/create/resume dispatch over entered agents and the published AgentFactory seam; local factory behavior does not prove AgentLoop creation, persistence, setup, or lifecycle policy',
  },
  {
    name: 'jobs',
    files: ['packages/dshline/tests/capability/jobs.probe.spec.ts'],
    note: 'real abstract JobRegistry contract plus HarnessWork observation over a local registry; concrete provider/controller policy is host-owned',
  },
  {
    name: 'subagents',
    files: [
      'packages/dshline/tests/capability/subagents.probe.spec.ts',
      'packages/dshline/tests/capability/subagent-telemetry.probe.spec.ts',
    ],
    note: 'real runtime lifecycle over a provider-neutral local backend, plus real subagentTiming/tokenUsage projections over synthetic Session events; no provider backend or discovery is claimed',
  },
  {
    name: 'inbox',
    files: ['packages/dshline/tests/capability/inbox.probe.spec.ts'],
    note: 'production AgentLoop Agents from the Harness testkit: durable followup/steer splice targets, the driver claim, cancellation, and cross-Agent isolation behind dshline’s pending count; no LLM adapter is mounted, so request and settlement behavior is not claimed',
  },
  {
    name: 'sessionProjections',
    files: [
      'packages/dshline/tests/todos.spec.ts',
      'packages/dshline/tests/goals.spec.ts',
      'packages/dshline/tests/permission.spec.ts',
    ],
    note: 'real projection/service assertions layered with dshline acceptance fixtures for Todo, Goal, and permission',
  },
  {
    name: 'sessionStats',
    files: ['packages/dshline/tests/capability/session-stats.probe.spec.ts'],
    note: 'real sessionStats projection and dshline performance fold over synthetic Session events; provider streaming/tool logging is outside the probe',
  },
  {
    name: 'turnOutline',
    files: ['packages/dshline/tests/turns.spec.ts'],
    note: 'real `@deepseek-ai/dsh-session-turn-outline` unit over a real Session store and projection registry, plus dshline outline/inspection presentation over that cut; no transcript paging, fork, or Web transport is claimed',
  },
  {
    name: 'workflows',
    files: ['packages/dshline/tests/capability/workflow.probe.spec.ts'],
    note: 'real abstract WorkflowEngine dispatch and dshline Work observation over local event fixtures; no concrete backend, script, or child run',
  },
  {
    name: 'userQuestions',
    files: ['packages/dshline/tests/capability/user-questions.probe.spec.ts'],
    note: 'real UserQuestionService dispatch through dshline’s local overlay provider; terminal, ask-user tool, and agent-scoped wiring are outside the probe',
  },
  {
    name: 'tokenMeter',
    files: ['packages/dshline/tests/capability/token-meter.probe.spec.ts'],
    note: 'real TokenMeter/projection registry and dshline context fold over replacement-shaped event fixtures; producer logging is not claimed',
  },
  {
    name: 'compaction',
    files: ['packages/dshline/tests/capability/compaction.probe.spec.ts'],
    note: 'durable compaction/* event contract and dshline presentation fold over a real Session; ctx.compaction backend and /compact command execution are host-owned',
  },
  {
    name: 'planMode',
    files: ['packages/dshline/tests/capability/plan-mode.probe.spec.ts'],
    note: 'real PlanModeController/projection reads typed plan/mode events, then dshline folds the real Session log; model-loop selection and terminal presentation are outside the probe',
  },
  {
    name: 'skills',
    files: ['packages/dshline/tests/capability/skills.probe.spec.ts'],
    note: 'real SkillRegistry and dsh-tool-skill pre-step boundary over local provider/Agent fixtures; live agent submission and filesystem discovery are outside the probe',
  },
  {
    name: 'authorization',
    files: ['packages/dshline/tests/capability/authorization.probe.spec.ts'],
    note: 'real AuthorizationService begin/list/cancel and route-key helper over a local credential fixture; bundle patch and browser `/connect` presentation are not covered',
  },
  {
    name: 'requestHeader',
    files: ['packages/dshline/tests/cache-inspector.spec.ts'],
    note: 'real `Session.requestHeader()` fold consumed by `/cache`; header events are fixture-appended, so loop logging policy is not covered',
  },
  {
    name: 'llm',
    files: ['packages/dshline/tests/capability/llm.probe.spec.ts'],
    note: 'real LlmRuntime over a minimal abstract-contract adapter: route/catalog, metadata shapes dshline reads, configurable-provider directory, and discovery callback',
  },
  {
    name: 'agentDefaultModel',
    files: ['packages/dshline/tests/capability/agent-default-model.probe.spec.ts'],
    note: 'concrete default-model service currentSelection/saveSelection over optional real SettingsProvider base; persistence is local in-memory evidence',
  },
  {
    name: 'settings',
    files: ['packages/dshline/tests/capability/settings.probe.spec.ts'],
    note: 'real SettingsProvider base path-op/revision behavior over local load/persist; the contract Connect and `/plugins` rely on, not those consumers themselves',
  },
  {
    name: 'credentials',
    files: ['packages/dshline/tests/capability/credentials.probe.spec.ts'],
    note: 'real abstract CredentialProvider contract with a local reference/record implementation; backend storage policy is not proved, and AuthorizationService covers record orchestration separately',
  },
  {
    name: 'commands',
    files: [
      'packages/dshline/tests/permission.spec.ts',
      'packages/dshline/tests/capability/command-attachments.probe.spec.ts',
    ],
    note: 'real CommandRuntime execute/lifecycle for `/permission review`, plus its own attachment admission over a local AttachmentStore — the `input.attachments` declaration and the discriminated image submission `/image` sends a command; local dispatch/list decoration and other fixtures are not discovery evidence',
  },
  {
    name: 'tools',
    files: ['packages/dshline/tests/capability/tools.probe.spec.ts'],
    note: 'real ToolRuntime/defineTool lookup to dshline ToolCards rendering over hand-built call/result inputs; execution, Session events, and attachment wiring are out of scope',
  },
  {
    name: 'attachments',
    files: ['packages/dshline/tests/capability/attachments.probe.spec.ts'],
    note: 'real AttachmentStore.saveImages base ordering/admission used by `/image`, over local limits/validation/storage; context mounting and deployment policy are not claimed',
  },
  {
    name: 'fs',
    files: ['packages/dshline/tests/capability/fs.probe.spec.ts'],
    note: 'real abstract FileSystem contract plus readImageDrafts passing cwd/signal/bound to a local backend; backend bounding policy is not claimed',
  },
  {
    name: 'agentPresets',
    files: ['packages/dshline/tests/capability/agent-presets.probe.spec.ts'],
    note: 'real AgentPresets list/resolve/read/copy and structural AgentPresetsSeam assignment, plus the creation-header projection read; mount/recompose/select and selected events are outside the probe',
  },
  {
    name: 'goals',
    files: ['packages/dshline/tests/goals.spec.ts'],
    note: 'real GoalService/projection plus dshline `goalReading` adapter path and source rule; no mounted status line is exercised',
  },
  {
    name: 'approval',
    files: ['packages/dshline/tests/capability/approval.probe.spec.ts'],
    note: 'real ApprovalService waterfall through dshline answerer, SessionStore audit pair, different-agent fail-closed result, and cancellation over minimal agent-shaped fixtures',
  },
  {
    name: 'subprocess',
    files: ['packages/dshline/tests/profiles-actions.spec.ts'],
    note: 'real LocalSubprocessRuntime child/env/timeout behavior plus unit-tested argv forwarding with an injected runner; no real dsh launcher/profile invocation',
  },
  {
    name: 'sessionTitle',
    files: ['packages/dshline/tests/sessions-query.integration.spec.ts'],
    note: 'real SessionTitleService.rename and live-store membership; browser action/overlay wiring is not exercised',
  },
]

/** Every test file any probe names, for the runner to pass to vitest in one pass. */
export const CAPABILITY_PROBE_FILES = [...new Set(CAPABILITY_PROBES.flatMap(probe => probe.files))]
