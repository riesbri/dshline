/**
 * Guards the properties that make the Harness compatibility policy true
 * rather than merely written down.
 *
 * dshline targets ONE Harness architecture at a time, and the blocking lanes in
 * `ci.yml` ask about exactly that: an exact upstream commit, gating every merge.
 * Nothing mutable may decide a merge — a `ref:` changed from a commit to a
 * branch, or a dist-tag read added to a blocking path, turns a merge gate into
 * something DeepSeek can fail from a thousand miles away. A diagnostic may
 * observe distribution state, but it must remain outside that verdict.
 *
 * Watching upstream for a NEWER generation is a separate workflow with a
 * separate question (`harness-sync.yml`), and its own spec.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/** Jobs whose result is a merge gate. Every job here is one. */
const BLOCKING_JOBS = ['core', 'windows-launcher', 'docs', 'harness-target', 'harness-published']

/**
 * Extract one top-level job's YAML block by name, with `#`-comment lines
 * stripped so prose that merely mentions a branch or a flag does not read as
 * the workflow actually using it.
 * @param workflow - the full workflow file text.
 * @param jobName - the job key under `jobs:`.
 * @returns the block's code (no comments), from its `<jobName>:` line up to (not including) the next job at the same indentation.
 */
function extractJob(workflow, jobName) {
  const match = workflow.match(new RegExp(`\\n  ${jobName}:\\n([\\s\\S]*?)(?=\\n  \\S|$)`))
  if (match === null) throw new Error(`job not found in workflow: ${jobName}`)
  return match[1].split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
}

/**
 * Read the CI workflow once per assertion, from the repository rather than a fixture.
 * @returns the workflow file text.
 */
async function readWorkflow() {
  return readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
}

/**
 * The workflow with `#` comment lines removed, so prose EXPLAINING a deleted
 * lane does not read as the workflow still having one. The header deliberately
 * records why `Harness upstream · master` is gone; that sentence is the
 * documentation, not the job.
 * @returns the workflow's code lines only.
 */
async function readWorkflowCode() {
  const workflow = await readWorkflow()
  return workflow.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
}

describe('nothing mutable can gate a merge (.github/workflows/ci.yml)', () => {
  it('follows no branch of the harness repository, in any job', async () => {
    const workflow = await readWorkflowCode()
    for (const jobName of BLOCKING_JOBS) {
      expect(extractJob(workflow, jobName), `${jobName} must not follow a branch of the harness repository`)
        .not.toMatch(/ref:\s*master/)
    }
    expect(workflow).not.toMatch(/ref:\s*master/)
  })

  it('has no scheduled run, and therefore no lane that only a schedule reaches', async () => {
    const workflow = await readWorkflowCode()
    // The daily run existed for one job: `Harness upstream · master`. Watching
    // a branch head produced a signal nobody could act on directly, because an
    // arbitrary master commit is not something HARNESS_TARGET can record.
    // `harness-sync.yml` watches release tags instead — an adoption unit.
    expect(workflow).not.toMatch(/^\s*schedule:/mu)
    expect(workflow).not.toContain('cron')
    expect(workflow).not.toContain('harness-upstream')
    expect(workflow).not.toContain('Harness upstream')
  })

  it('runs every job on the same ordinary events', async () => {
    const workflow = await readWorkflow()
    for (const jobName of BLOCKING_JOBS) {
      expect(extractJob(workflow, jobName), `${jobName} should not need an event filter any more`)
        .not.toMatch(/^\s{4}if:\s*github\.event_name/mu)
    }
  })
})

describe('Core proves the adopted graph agrees with itself', () => {
  it('fails on an unmet peer requirement rather than warning about it', async () => {
    const job = extractJob(await readWorkflow(), 'core')
    // The cordis/schemastery class: Harness raises a floor for a package that
    // is deliberately NOT pinned to HARNESS_TARGET.version, and an ordinary
    // install only warns. The source-linked target lane cannot see it either,
    // because linking a Harness checkout substitutes its own vendored cordis.
    expect(job).toContain('pnpm peers check')
    const steps = job.split('\n      - ')
    const install = steps.findIndex(step => step.includes('pnpm install'))
    const peers = steps.findIndex(step => step.includes('pnpm peers check'))
    expect(install).toBeGreaterThanOrEqual(0)
    expect(peers).toBeGreaterThan(install)
  })
})

describe('the adopted target lane is deterministic', () => {
  it('takes its revision from HARNESS_TARGET and nothing else', async () => {
    const job = extractJob(await readWorkflow(), 'harness-target')
    expect(job).toContain('node tools/harness-target.mjs --revision')
    expect(job).toMatch(/ref:\s*\$\{\{\s*steps\.target\.outputs\.revision\s*\}\}/)
    // A dist-tag is a pointer someone else moves; resolving one here would
    // make "the revision we adopted" mean whatever upstream published last.
    expect(job).not.toMatch(/\bdist-tag\b|--channel|@(next|alpha|latest)\b/)
  })

  it('blocks on both its typecheck and its capability probes', async () => {
    const job = extractJob(await readWorkflow(), 'harness-target')
    // continue-on-error collects both signals; the verdict step is what must
    // still turn a failure into a red job.
    expect(job).toMatch(/if \[ "\$TYPECHECK_OUTCOME" != "success" \] \|\| \[ "\$CAPABILITY_OUTCOME" != "success" \]/)
    expect(job).toContain('exit 1')
  })
})

describe('the capability step cannot report success for a capability report that failed', () => {
  /**
   * The `run:` script of one step in a job, with the block-scalar indentation
   * removed, so it can be handed to a shell exactly as GitHub would.
   * @param {string} job - the job's code block.
   * @param {string} stepId - the step's `id:` value.
   * @returns {string} the script, newline-joined.
   */
  function runScript(job, stepId) {
    const step = job.split('\n      - ').find(candidate => candidate.includes(`id: ${stepId}`))
    if (step === undefined) throw new Error(`no step with id: ${stepId}`)
    const block = /\n\s*run: \|\n([\s\S]*)$/u.exec(step)
    if (block === null) throw new Error(`step ${stepId} has no \`run: |\` block`)
    const indent = block[1].split('\n').find(line => line.trim() !== '')?.match(/^ */u)[0].length ?? 0
    return block[1].split('\n').map(line => line.slice(indent)).join('\n')
  }

  it('exits non-zero when the reporter fails, and still writes capability.txt', async () => {
    // The bug this guards is behavioural, not textual: a pipeline reports the
    // status of its LAST command, so `report | tee capability.txt` handed GitHub
    // tee's success while the report printed `✗ skills`, and the verdict step
    // read CAPABILITY_OUTCOME=success and let the lane go green. Searching for
    // the token `PIPESTATUS` would not have caught a differently-shaped
    // mistake, so this runs the step's ACTUAL script with the reporter swapped
    // for one that fails.
    const job = extractJob(await readWorkflow(), 'harness-target')
    const script = runScript(job, 'capability')

    // A reporter that writes a report and fails, standing in for
    // capability-report.mjs when it renders a `✗` line. mkdtemp's alphabet
    // contains nothing the shell would treat specially, so this path needs no
    // quoting beyond the double quotes JSON.stringify supplies.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-capability-step-'))
    try {
      const stub = join(dir, 'failing-report.sh')
      writeFileSync(stub, 'echo "Harness compatibility · target (0.0.0)"\necho "✗ skills"\nexit 1\n')
      const exercised = script.replace(
        // Only the reporter command, NOT the rest of the line: the `| tee
        // capability.txt` downstream is part of what is under test.
        /node tools\/capability-report\.mjs[^\n|]*/u,
        `sh ${JSON.stringify(stub)}`,
      )
      expect(exercised, 'the reporter command must be the one substituted').not.toBe(script)

      const result = spawnSync('bash', ['-c', exercised], { cwd: dir, encoding: 'utf8' })
      // The step's own status is what GitHub records, and what `steps.capability.outcome`
      // — the value the verdict reads — is taken from.
      expect(result.status, 'a failing capability report must fail the step').not.toBe(0)
      // The diagnostics that make continue-on-error worth having must survive.
      const report = readFileSync(join(dir, 'capability.txt'), 'utf8')
      expect(report).toContain('✗ skills')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves no step whose exit status would be tee\'s rather than its producer\'s', async () => {
    // The general form of the same invariant, so a future step added to this
    // lane cannot reintroduce it. The hazard is precise: a step whose LAST
    // command is a `... | tee <file>` pipeline reports tee's status, not its
    // producer's. A step that pipes into tee and then goes on to decide its own
    // status — the verdict step does, with its `if` — is not affected, so this
    // looks at the final command rather than at any pipeline anywhere.
    const job = extractJob(await readWorkflow(), 'harness-target')
    for (const step of job.split('\n      - ')) {
      const name = /(?:^|\n)\s*(?:-\s+)?(?:id|name):\s*(.+)$/mu.exec(step)?.[1].trim() ?? 'unnamed step'
      const inline = /\n\s*run:\s*(\S.*)$/mu.exec(step)?.[1]
      const block = /\n\s*run: \|\n([\s\S]*)$/u.exec(step)
      let last
      if (block !== null) {
        const lines = block[1].split('\n').filter(line => line.trim() !== '')
        last = lines[lines.length - 1]?.trim()
      } else {
        last = inline
      }
      if (last === undefined || !/\|\s*tee\b/.test(last)) continue
      expect(step, `${name} ends on a tee pipeline, so it would report tee's status`).toContain('PIPESTATUS')
    }
  })
})

describe('the published consumer lane separates compatibility from distribution', () => {
  it('keeps only the packed smoke on the exact-target path', async () => {
    const job = extractJob(await readWorkflow(), 'harness-published')
    const smokeSteps = job.split('\n      - ').filter(step => step.includes('node tools/consumer-smoke.mjs'))
    expect(smokeSteps).toHaveLength(2)
    expect(smokeSteps.map(step => step.match(/run:\s*(node tools\/consumer-smoke\.mjs[^\n]+)/u)?.[1])).toEqual([
      'node tools/consumer-smoke.mjs --launcher-version "$TARGET_VERSION"',
      'node tools/consumer-smoke.mjs --bootstrap',
    ])
    expect(smokeSteps[0]).toMatch(/TARGET_VERSION:\s*\$\{\{\s*steps\.target\.outputs\.version\s*\}\}/u)
    expect(smokeSteps[0]).not.toContain('continue-on-error')
    expect(smokeSteps[1]).not.toContain('TARGET_VERSION')
    expect(smokeSteps[1]).toMatch(/continue-on-error:\s*true/u)
  })

  it('surfaces the bootstrap outcome without making it authoritative', async () => {
    const job = extractJob(await readWorkflow(), 'harness-published')
    expect(job).toContain('BOOTSTRAP_OUTCOME: ${{ steps.bootstrap.outcome }}')
    expect(job).toContain('Default-install bootstrap: PASS (diagnostic only)')
    expect(job).toContain('Default-install bootstrap: FAIL (')
    expect(job).toContain('diagnostic only; does not invalidate HARNESS_TARGET compatibility')
    expect(job).not.toContain('First-run path validated')
  })

  it('keeps CI required dependent on the compatibility job, not a bootstrap verdict', async () => {
    const workflow = await readWorkflow()
    const required = extractJob(workflow, 'required')
    expect(required).toContain('needs: [core, windows-launcher, docs, harness-target, harness-published]')
    const published = extractJob(workflow, 'harness-published')
    expect(published).toContain('id: packed')
    expect(published).toContain('id: bootstrap')
    expect(published).toContain('continue-on-error: true')
  })
})

describe('the obsolete multi-line compatibility machinery is gone', () => {
  it('carries no Minimum floor, no dist-tag lanes, and no rolling sync automation', async () => {
    const workflow = await readWorkflow()
    for (const gone of [
      'HARNESS_MINIMUM_VERSION',
      'pin-harness-floor',
      'sync-harness',
      'check-peer-currency',
      'latest-harness-release',
      'harness-minimum',
      'harness-released',
      'harness-alpha',
      'harness-edge',
      'automation/harness-sync',
    ]) {
      expect(workflow, `${gone} should have been deleted, not renamed`).not.toContain(gone)
    }
  })

  it('holds no write permissions and no secrets, now that the sync job is gone', async () => {
    const workflow = await readWorkflow()
    // The only job that ever needed a write token was the rolling sync pull
    // request, which turned every upstream publish into an implied
    // compatibility promise. Nothing in this workflow writes any more.
    expect(workflow).not.toMatch(/contents:\s*write/)
    expect(workflow).not.toMatch(/pull-requests:\s*write/)
    expect(workflow).not.toContain('secrets.')
  })

  it('keeps the release-age brake on every job', async () => {
    const workflow = await readWorkflow()
    // The bypass existed so the Released lane could see a brand-new published
    // version the day it shipped. Nothing races a dist-tag any more, so the
    // repository-wide brake in pnpm-workspace.yaml now applies everywhere.
    expect(workflow).not.toContain('PNPM_CONFIG_MINIMUM_RELEASE_AGE')
    expect(workflow).not.toContain('minimum-release-age')
  })
})

describe('security posture', () => {
  it('checks out with persist-credentials: false everywhere', async () => {
    const workflow = await readWorkflow()
    const checkouts = [...workflow.matchAll(/uses: actions\/checkout@/g)]
    expect(checkouts.length).toBeGreaterThan(0)
    expect([...workflow.matchAll(/persist-credentials: false/g)]).toHaveLength(checkouts.length)
  })

  it('installs dependencies without running their lifecycle scripts', async () => {
    const workflow = await readWorkflow()
    const installs = [...workflow.matchAll(/pnpm install(?! --lockfile-only)[^\n]*/g)]
    expect(installs.length).toBeGreaterThan(0)
    for (const install of installs) {
      expect(install[0], 'every install must run with --ignore-scripts').toContain('--ignore-scripts')
    }
  })
})

describe('the aggregate gates are stable contexts, not a second copy of CI', () => {
  /**
   * One workflow's code, `#` comment lines stripped.
   * @param name - the workflow file name.
   * @returns the code lines only.
   */
  async function code(name) {
    const text = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
    return text.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
  }

  it('CI · required depends on every blocking lane and nothing else', async () => {
    const job = extractJob(await readWorkflow(), 'required')
    expect(job).toContain('name: CI · required')
    const needs = job.match(/needs:\s*\[(.+)\]/u)[1].split(',').map(entry => entry.trim())
    expect(needs.sort()).toEqual([...BLOCKING_JOBS].sort())
  })

  it('carries no build or test logic of its own', async () => {
    const job = extractJob(await readWorkflow(), 'required')
    for (const duplicated of ['pnpm run build', 'pnpm run typecheck', 'pnpm run test', 'pnpm install', 'actions/checkout']) {
      expect(job, `${duplicated} belongs to the lanes, not to the verdict`).not.toContain(duplicated)
    }
  })

  it('cannot go green by being skipped when a dependency fails', async () => {
    const job = extractJob(await readWorkflow(), 'required')
    // GitHub reports a SKIPPED required check as satisfied. Without always()
    // this job would skip on any failed dependency and the merge gate would
    // pass on red CI.
    expect(job).toMatch(/^\s{4}if: always\(\)/mu)
    // Compared against 'success' explicitly: `!failure()` is also true for a
    // cancelled or skipped dependency.
    expect(job).toContain('*=success)')
    expect(job).toContain('exit 1')
  })

  it('bakes no Node or Harness version into its display name', async () => {
    const job = extractJob(await readWorkflow(), 'required')
    const name = job.match(/^\s{4}name:\s*(.+)$/mu)[1]
    expect(name.trim()).toBe('CI · required')
    expect(name).not.toMatch(/\d+\.\d+/u)
  })

  it('Security · required covers every pull-request blocker and excludes scorecard', async () => {
    const workflow = await code('security.yml')
    const job = workflow.match(/\n  required:\n([\s\S]*?)(?=\n  \S|$)/u)[1]
    expect(job).toContain('name: Security · required')
    const needs = job.match(/needs:\s*\[(.+)\]/u)[1].split(',').map(entry => entry.trim())
    expect(needs.sort()).toEqual(['advisories', 'codeql', 'new-dependencies', 'secrets', 'workflow-hardening'])
    // Scorecard grades the repository, cannot run on a fork pull request, and
    // is not a merge gate; requiring it would make fork contributions
    // unmergeable.
    expect(needs).not.toContain('scorecard')
  })

  it('Security · required runs on the event it gates, and cannot false-green', async () => {
    const workflow = await code('security.yml')
    const job = workflow.match(/\n  required:\n([\s\S]*?)(?=\n  \S|$)/u)[1]
    expect(job).toContain('always()')
    expect(job).toContain("github.event_name == 'pull_request'")
    expect(job).toContain('*=success)')
    expect(job).toContain('exit 1')
    for (const duplicated of ['pnpm audit', 'codeql-action', 'gitleaks', 'lint-workflows']) {
      expect(job, `${duplicated} belongs to its own job`).not.toContain(duplicated)
    }
  })
})
