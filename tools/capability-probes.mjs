/**
 * The Harness capability seams this frontend depends on, and where each one's
 * compatibility evidence already lives.
 *
 * This is a POINTER table, not a second copy of the contract: every entry
 * names an existing or purpose-built test file that exercises the real
 * `@deepseek-ai/*` class for that seam (a real `SessionQueryEngine`, a real
 * `SubagentRuntime`, a real abstract `JobRegistry` subclass, …), never a
 * dshline-shaped fake. If a seam's real contract changes upstream, the file
 * named here fails — by capability name — before anything has to fall back to
 * a generic `pnpm typecheck failed`.
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
 * @property {string[]} files - repository-relative test files whose pass/fail
 *   IS this capability's verdict.
 * @property {string} [note] - shown beside the capability name in the report,
 *   for coverage that rides on an existing acceptance test rather than a
 *   dedicated probe.
 */

/** @type {readonly CapabilityProbe[]} */
export const CAPABILITY_PROBES = [
  {
    name: 'sessionQuery',
    files: ['packages/dshline/tests/sessions-query.integration.spec.ts'],
  },
  {
    name: 'jobs',
    files: ['packages/dshline/tests/capability/jobs.probe.spec.ts'],
  },
  {
    name: 'subagents',
    files: [
      'packages/dshline/tests/capability/subagents.probe.spec.ts',
      'packages/dshline/tests/capability/subagent-telemetry.probe.spec.ts',
    ],
    note: 'lifecycle seam, plus the subagentTiming/tokenUsage projections a Work row reads',
  },
  {
    name: 'sessionProjections',
    files: [
      'packages/dshline/tests/todos.spec.ts',
      'packages/dshline/tests/goals.spec.ts',
      'packages/dshline/tests/permission.spec.ts',
    ],
    note: 'Todo, Goal, and permission projection acceptance tests',
  },
  {
    name: 'sessionStats',
    files: ['packages/dshline/tests/capability/session-stats.probe.spec.ts'],
    note: 'the optional whole-log turn/step and wall-time unit `/usage` reports',
  },
  {
    name: 'workflows',
    files: ['packages/dshline/tests/capability/workflow.probe.spec.ts'],
  },
  {
    name: 'userQuestions',
    files: ['packages/dshline/tests/capability/user-questions.probe.spec.ts'],
  },
  {
    name: 'tokenMeter',
    files: ['packages/dshline/tests/capability/token-meter.probe.spec.ts'],
  },
  {
    name: 'compaction',
    files: ['packages/dshline/tests/capability/compaction.probe.spec.ts'],
  },
  {
    name: 'skills',
    files: ['packages/dshline/tests/capability/skills.probe.spec.ts'],
  },
  {
    name: 'authorization',
    files: ['packages/dshline/tests/capability/authorization.probe.spec.ts'],
    note: 'the sign-in seam `/connect` runs and this bundle now composes as a host row',
  },
]

/** Every test file any probe names, for the runner to pass to vitest in one pass. */
export const CAPABILITY_PROBE_FILES = [...new Set(CAPABILITY_PROBES.flatMap(probe => probe.files))]
