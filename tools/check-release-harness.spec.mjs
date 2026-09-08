/**
 * The release-channel gate: its verdicts, and the three boundaries it holds.
 *
 * Two separate things are checked here, and they fail for different reasons.
 * The first half is the decision itself — exact equality, in both directions,
 * with a lookup failure kept distinct from a mismatch — driven through an
 * injected registry reader so nothing in this file touches npm.
 *
 * The second half is placement, which is the part that actually makes the
 * policy true. A correct script wired into the wrong step is worth nothing: a
 * gate after the tag is pushed cannot prevent an immutable tag, a gate after
 * the first publish cannot prevent an irreversible version, and a gate that
 * ordinary pull requests run would put every feature branch at the mercy of a
 * pointer DeepSeek moves — the exact architecture #133 removed.
 */

import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { formatChannelStatus, releaseChannelStatus } from './check-release-harness.mjs'

/** The one script all three boundaries must invoke. */
const GUARD = 'node tools/check-release-harness.mjs'

/**
 * Read one workflow file from the repository rather than a fixture.
 * @param name - the workflow's file name under `.github/workflows`.
 * @returns the workflow file text.
 */
async function readWorkflow(name) {
  return readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
}

/**
 * Extract one top-level job's YAML block by name, with `#`-comment lines
 * stripped so prose mentioning a step does not read as the workflow running it.
 * Mirrors `tools/ci-workflow.spec.mjs`, which owns the same trick for ci.yml.
 * @param workflow - the full workflow file text.
 * @param jobName - the job key under `jobs:`.
 * @returns the block's code, comments removed.
 */
function extractJob(workflow, jobName) {
  const match = workflow.match(new RegExp(`\\n  ${jobName}:\\n([\\s\\S]*?)(?=\\n  \\S|$)`))
  if (match === null) throw new Error(`job not found in workflow: ${jobName}`)
  return match[1].split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
}

/**
 * One job's `if:` expression, folded block scalars included.
 *
 * A three-clause condition reads far better as YAML's `>-` than as one long
 * line, so the assertions must see what the folded form actually means rather
 * than the two characters that introduce it.
 * @param job - one job's comment-stripped block.
 * @returns the condition as a single expression, or undefined when absent.
 */
function jobCondition(job) {
  const inline = job.match(/^ {4}if:[ \t]*(\S.*)$/mu)
  if (inline === null) return undefined
  const head = inline[1].trim()
  if (!/^[>|][-+]?$/u.test(head)) return head
  const rest = job.slice(job.indexOf(inline[0]) + inline[0].length + 1)
  const folded = []
  for (const line of rest.split('\n')) {
    if (!/^ {6}\S/u.test(line)) break
    folded.push(line.trim())
  }
  return folded.join(' ')
}

/**
 * One job's steps, whole, in declaration order.
 *
 * Ordering is the entire assertion for two of the three boundaries, so it is
 * read positionally rather than by searching the file for two substrings and
 * hoping the earlier one came first. Split on the `- ` step marker rather than
 * matched with one expression per step: a step body is multi-line shell, and a
 * pattern that ended at a line boundary would silently compare only each
 * step's first line — which looks like it works right up until the text being
 * searched for is on the second.
 * @param job - one job's comment-stripped block.
 * @returns each step's full text, in order.
 */
function jobSteps(job) {
  const steps = []
  for (const line of job.split('\n')) {
    if (/^ {6}- /u.test(line)) steps.push([line])
    else if (steps.length > 0) steps.at(-1).push(line)
  }
  return steps.map(lines => lines.join('\n'))
}

/**
 * Index of the first step containing `needle`.
 * @param job - one job's comment-stripped block.
 * @param needle - text to find in a step.
 * @returns the step index, or -1.
 */
function stepIndex(job, needle) {
  return jobSteps(job).findIndex(step => step.includes(needle))
}

describe('the release verdict is exact equality, in both directions', () => {
  it('is ready when the adopted generation is what an unqualified install resolves', () => {
    const result = releaseChannelStatus('1.2.3', { readLatest: () => '1.2.3\n' })
    expect(result).toEqual({ kind: 'ready', adopted: '1.2.3', latest: '1.2.3' })
    expect(formatChannelStatus(result).code).toBe(0)
  })

  it('fails, naming both values, when the adopted target is ahead of the default channel', () => {
    const result = releaseChannelStatus('2.0.0-beta.1', { readLatest: () => '1.9.0\n' })
    expect(result).toMatchObject({ kind: 'mismatch', adopted: '2.0.0-beta.1', latest: '1.9.0' })
    const { code, text } = formatChannelStatus(result)
    expect(code).toBe(1)
    expect(text).toContain('2.0.0-beta.1')
    expect(text).toContain('1.9.0')
  })

  it('fails just as hard when the registry is AHEAD of the adopted target', () => {
    // The one that a semver comparison would wave through. dshline carries no
    // compatibility code for a neighbouring generation, so a newer Harness
    // `latest` is not a satisfied floor — it is a generation this tree was
    // never built against, and the fix is to migrate HARNESS_TARGET forward.
    const result = releaseChannelStatus('2.0.0-alpha.4', { readLatest: () => '2.0.0-alpha.5\n' })
    expect(result).toMatchObject({ kind: 'mismatch', latest: '2.0.0-alpha.5' })
    expect(formatChannelStatus(result).code).toBe(1)
  })

  it('never compares by precedence: a prerelease of the same tuple is still a mismatch', () => {
    expect(releaseChannelStatus('1.0.0', { readLatest: () => '1.0.0-rc.1\n' }).kind).toBe('mismatch')
    expect(releaseChannelStatus('1.0.0-rc.1', { readLatest: () => '1.0.0\n' }).kind).toBe('mismatch')
  })

  it('says plainly that a mismatch is about the release channel, not compatibility', () => {
    const { text } = formatChannelStatus(releaseChannelStatus('2.0.0', { readLatest: () => '1.0.0\n' }))
    expect(text).toContain('RELEASE-channel failure')
    expect(text).toContain('main is not broken')
    // The two legitimate resolutions, and none of the illegitimate ones.
    expect(text).toContain('migrate HARNESS_TARGET')
    expect(text).toMatch(/Do not widen a peer range/)
  })
})

describe('the scenario this gate was built for', () => {
  it('refuses a release adopting a generation the default channel has not promoted', () => {
    // The concrete case, with real values rather than placeholders: main
    // adopts a Harness generation while npm's default tag still serves the
    // previous one. Development is fine and CI is green; releasing would not
    // be. Pinned as a fixture so the behaviour is provable without editing
    // HARNESS_TARGET or waiting on the registry.
    const result = releaseChannelStatus('0.1.2-alpha.5', { readLatest: () => '0.1.1-rc.2\n' })
    expect(result).toEqual({ kind: 'mismatch', adopted: '0.1.2-alpha.5', latest: '0.1.1-rc.2' })
    expect(formatChannelStatus(result).code).toBe(1)
  })

  it('still refuses when the default channel skips the adopted generation entirely', () => {
    // DeepSeek promoting a generation dshline did NOT adopt is not a green
    // light. The response is to migrate HARNESS_TARGET onto it, not to assume
    // the newer one works — which is exactly what this repository did when the
    // alpha channel moved while the adopting pull request was still open.
    const result = releaseChannelStatus('0.1.2-alpha.4', { readLatest: () => '0.1.2-alpha.5\n' })
    expect(result.kind).toBe('mismatch')
    expect(formatChannelStatus(result).text).toContain('migrate HARNESS_TARGET')
  })
})

describe('an unanswered question fails closed, and says so differently', () => {
  it('reports a lookup failure as unverifiable rather than as a mismatch', () => {
    const result = releaseChannelStatus('1.2.3', {
      readLatest: () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') },
    })
    expect(result.kind).toBe('unverifiable')
    const { code, text } = formatChannelStatus(result)
    // Non-zero — a release never proceeds on an unanswered question — but a
    // distinct code and a distinct sentence, because the response differs.
    expect(code).toBe(2)
    expect(text).toContain('Could not verify')
    expect(text).toContain('ENOTFOUND')
    expect(text).not.toContain('release is not ready')
  })

  it.each([
    ['empty output', ''],
    ['whitespace only', '   \n'],
    ['an npm error on stdout', 'npm ERR! code E404\n'],
    ['two versions', '1.0.0\n1.0.1\n'],
    ['a decorated line', "version = '1.0.0'\n"],
  ])('treats %s as unverifiable rather than passing or comparing it', (_label, answer) => {
    const result = releaseChannelStatus('1.0.0', { readLatest: () => answer })
    expect(result.kind).toBe('unverifiable')
    expect(formatChannelStatus(result).code).toBe(2)
  })

  it('cannot be satisfied by a non-string answer', () => {
    expect(releaseChannelStatus('1.0.0', { readLatest: () => undefined }).kind).toBe('unverifiable')
  })
})

describe('boundary A: only the generated Version Packages PR runs the live gate', () => {
  it('lives in release-channel.yml, and the old readiness naming is gone', async () => {
    const workflow = await readWorkflow('release-channel.yml')
    expect(workflow).toContain('name: release-channel')
    expect(workflow).toContain('release-channel-${{ github.ref }}')
    // The required status context is identified by exact name in branch
    // protection, so a drift here silently detaches the merge gate.
    expect(workflow).toContain('Release channel · Harness latest')
    expect(workflow).not.toContain('Release readiness')
    expect(workflow).not.toContain('release-readiness')
    // Compatibility is `Harness target`'s word; this gate is about the channel.
    expect(workflow).not.toContain('Release compatibility')
  })

  it('still runs on every pull request, so the required context resolves', async () => {
    const workflow = await readWorkflow('release-channel.yml')
    // The job is skipped on an ordinary pull request, and GitHub counts a
    // skipped required check as satisfied. A workflow that did not TRIGGER at
    // all would instead leave the context permanently pending, which blocks
    // every merge — the opposite of the intent.
    expect(workflow).toMatch(/^on:\n  pull_request:/mu)
  })

  it('is a job of its own, outside the development compatibility workflow', async () => {
    // Placement is the architecture: ci.yml decides whether dshline works
    // against HARNESS_TARGET, and must never resolve a dist-tag to do it.
    const ci = await readWorkflow('ci.yml')
    expect(ci).not.toContain(GUARD)
    expect(ci).not.toContain('@latest')
    const workflow = await readWorkflow('release-channel.yml')
    expect(workflow).toContain(GUARD)
  })

  it('runs only for the generated branch, on this repository, targeting main', async () => {
    const guardExpression = jobCondition(extractJob(await readWorkflow('release-channel.yml'), 'harness-latest'))
    expect(guardExpression, 'the job must carry a job-level if:').toBeDefined()
    // Identity, not the title: a PR title is attacker-supplied text, while
    // pushing `changeset-release/main` to this repository needs write access.
    expect(guardExpression).toContain("github.event.pull_request.head.ref == 'changeset-release/main'")
    expect(guardExpression).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(guardExpression).toContain("github.event.pull_request.base.ref == 'main'")
  })

  it('cannot be reached by an ordinary feature pull request', async () => {
    const guardExpression = jobCondition(extractJob(await readWorkflow('release-channel.yml'), 'harness-latest'))
    // Every clause is an AND: no `||` can admit a branch that is not the
    // generated one, which is what would put a feature PR at the mercy of a
    // pointer DeepSeek moves.
    expect(guardExpression).not.toContain('||')
  })

  it('carries a stable descriptive name with no version baked into it', async () => {
    const job = extractJob(await readWorkflow('release-channel.yml'), 'harness-latest')
    const name = job.match(/^\s{4}name:\s*(.+)$/mu)
    expect(name).not.toBeNull()
    expect(name[1].trim()).toBe('Release channel · Harness latest')
    expect(name[1]).not.toMatch(/\d+\.\d+\.\d+/u)
  })

  it('needs no write access and no secret to read a public registry', async () => {
    const workflow = await readWorkflow('release-channel.yml')
    expect(workflow).not.toMatch(/:\s*write/u)
    expect(workflow).not.toContain('secrets.')
    expect(workflow).toMatch(/permissions:\n\s+contents:\s*read/u)
    expect([...workflow.matchAll(/uses: actions\/checkout@/gu)])
      .toHaveLength([...workflow.matchAll(/persist-credentials: false/gu)].length)
  })
})

describe('boundary B: the gate precedes the immutable tag', () => {
  it('runs before the tag is created and pushed', async () => {
    const job = extractJob(await readWorkflow('version.yml'), 'tag')
    const gate = stepIndex(job, GUARD)
    // The ref-creating API call, not the string `refs/tags/` — that also
    // appears in the earlier read-only existence check, and passing against
    // that step would prove something weaker than it looks.
    const tagging = stepIndex(job, 'git/refs')
    expect(gate, 'the tag job must run the release gate').toBeGreaterThanOrEqual(0)
    expect(tagging, 'the tag job must still create a tag').toBeGreaterThanOrEqual(0)
    expect(jobSteps(job)[tagging], 'the located step must be the one that writes the ref')
      .toContain('--method POST')
    // A tag cannot be taken back, so a gate after it would only be able to
    // describe the mistake.
    expect(gate).toBeLessThan(tagging)
  })

  it('runs on the merged release tree, after the tree itself is validated', async () => {
    const job = extractJob(await readWorkflow('version.yml'), 'tag')
    expect(stepIndex(job, 'tools/check-release-tag.mjs')).toBeLessThan(stepIndex(job, GUARD))
  })
})

describe('boundary C: the gate precedes the first irreversible npm write', () => {
  it('checks the release channel in both jobs and immediately before publishing', async () => {
    const workflow = await readWorkflow('publish.yml')
    const preflight = extractJob(workflow, 'release-preflight')
    const publisher = extractJob(workflow, 'publish-to-npm')
    const preflightGate = stepIndex(preflight, GUARD)
    const publisherGate = stepIndex(publisher, GUARD)
    const publishing = stepIndex(publisher, 'node tools/publish-packages.mjs')
    expect(preflightGate, 'the preflight job must run the release gate').toBeGreaterThanOrEqual(0)
    expect(publisherGate, 'the publish job must re-check the release channel').toBeGreaterThanOrEqual(0)
    expect(publishing, 'the publish job must still publish').toBeGreaterThan(publisherGate)
    expect(publisher).toContain('needs: release-preflight')
    const beforePublisherGate = jobSteps(publisher).slice(0, publisherGate).join('\n')
    expect(beforePublisherGate).not.toMatch(/publish-packages|pnpm publish|npm publish/u)
  })
})

describe('the gate is never advisory', () => {
  it.each(['release-channel.yml', 'version.yml', 'publish.yml'])(
    '%s runs it without a bypass, a soft failure, or a swallowed exit code',
    async (name) => {
      const workflow = await readWorkflow(name)
      const invocations = [...workflow.matchAll(new RegExp(`^.*${GUARD}.*$`, 'gmu'))].map(match => match[0])
      expect(invocations.length).toBeGreaterThan(0)
      for (const line of invocations) {
        // `|| true`, `|| echo`, or a pipe would turn a refused release into a
        // green one; `continue-on-error` would do it from the step instead.
        expect(line).not.toMatch(/\|\||[;&]\s*(true|exit 0)|\|\s*\w/u)
      }
      expect(workflow).not.toContain('continue-on-error')
    },
  )
})
