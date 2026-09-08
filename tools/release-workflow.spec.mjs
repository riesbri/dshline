import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

/**
 * Extract a workflow job while ignoring full-line comments, so prose cannot
 * satisfy a topology assertion.
 * @param workflow - workflow YAML text.
 * @param jobName - job key under `jobs:`.
 * @returns the job's code block.
 */
function extractJob(workflow, jobName) {
  const match = workflow.match(new RegExp(`\\n  ${jobName}:\\n([\\s\\S]*?)(?=\\n  \\S|$)`))
  if (match === null) throw new Error(`job not found in publish workflow: ${jobName}`)
  return match[1].split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
}

/**
 * Read the publish workflow once per assertion.
 * @returns the workflow text.
 */
async function readWorkflow() {
  return readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
}

/** @returns the version workflow text. */
async function readVersionWorkflow() {
  return readFile(new URL('../.github/workflows/version.yml', import.meta.url), 'utf8')
}

describe('version workflow recovery boundaries', () => {
  it('does not let arbitrary manual dispatches run the Version Packages writer', async () => {
    const workflow = await readVersionWorkflow()
    expect(workflow).toContain("github.event_name == 'push'")
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
    expect(workflow).toContain("inputs.recovery-commit == ''")
    expect(workflow).toContain('ref: ${{ github.sha }}')
  })
})

describe('publish workflow state machine', () => {
  it('puts accepted npm publication and registry visibility in different jobs', async () => {
    const workflow = await readWorkflow()
    const preflight = extractJob(workflow, 'release-preflight')
    const publish = extractJob(workflow, 'publish-to-npm')
    const verify = extractJob(workflow, 'verify-registry')
    const release = extractJob(workflow, 'github-release')

    expect(preflight).toContain('node tools/check-release-tag.mjs')
    expect(preflight).toContain('pnpm run build')
    expect(preflight).toContain('pnpm run typecheck')
    expect(preflight).toContain('pnpm run test')
    expect(preflight).toContain('pnpm run audit')
    expect(preflight).toContain('pack --config.ignore-scripts=true')
    expect(preflight).toContain('version: 11.22.0')
    expect(preflight).toContain('dshline-renderer-*.tgz')
    expect(preflight).not.toContain('id-token: write')
    expect(publish).toContain('node tools/publish-packages.mjs')
    expect(publish).toContain('actions/download-artifact@')
    expect(publish).toContain('id-token: write')
    expect(publish).toContain('PUBLISH_ARTIFACT_ROOT')
    expect(publish).toContain('version: 11.22.0')
    expect(publish).toContain('NPM_CONFIG_USERCONFIG')
    expect(publish).not.toContain('npm_config_userconfig')
    expect(publish).toContain("NPM_TOKEN: ''")
    expect(publish).toContain("NODE_AUTH_TOKEN: ''")
    expect(publish).not.toContain('pnpm install')
    expect(publish).not.toContain('pnpm run test')
    expect(verify).toContain('needs: publish-to-npm')
    expect(verify).toContain('node tools/verify-published.mjs')
    expect(verify).not.toContain('publish-packages')
    expect(release).toContain('needs: verify-registry')
    expect(release).toContain('node tools/ensure-github-release.mjs')
  })

  it('keeps the validated artifact handoff outside the OIDC publisher', async () => {
    const workflow = await readWorkflow()
    const preflight = extractJob(workflow, 'release-preflight')
    const publisher = extractJob(workflow, 'publish-to-npm')
    expect(preflight).toContain('pnpm run build')
    expect(preflight).toContain('pnpm run typecheck')
    expect(preflight).toContain('pnpm run test')
    expect(preflight).toContain('pack --config.ignore-scripts=true')
    expect(preflight).toContain('actions/upload-artifact@')
    expect(preflight).toContain('name: dshline-npm-packages')
    expect(publisher).toContain('needs: release-preflight')
    expect(publisher).toContain('actions/download-artifact@')
    expect(publisher).toContain('name: dshline-npm-packages')
    expect(publisher).toContain('node tools/publish-packages.mjs')
    expect(publisher).not.toMatch(/pnpm install|pnpm run build|pnpm run typecheck|pnpm run test|pack --/u)
    expect(publisher).not.toMatch(/prepublish|prepare|postinstall|npm publish/u)
  })

  it('cannot publish on a verification rerun or through manual recovery', async () => {
    const workflow = await readWorkflow()
    const publish = extractJob(workflow, 'publish-to-npm')
    const verify = extractJob(workflow, 'verify-registry')
    const recovery = extractJob(workflow, 'recover-existing-tag')
    const recoveryRelease = extractJob(workflow, 'recover-github-release')

    expect(publish).toContain("if: github.event_name == 'push'")
    expect(verify).toContain("if: github.event_name == 'push'")
    expect(recovery).not.toMatch(/pnpm|publish-packages|npm publish/u)
    expect(recoveryRelease).not.toMatch(/pnpm|publish-packages|npm publish/u)
    expect(workflow).toContain('recovery-tag:')
    expect(workflow).toContain('git worktree add --detach')
  })

  it('keeps OIDC and repository-write permissions at their narrow boundaries', async () => {
    const workflow = await readWorkflow()
    const publish = extractJob(workflow, 'publish-to-npm')
    const verify = extractJob(workflow, 'verify-registry')
    const release = extractJob(workflow, 'github-release')
    const recovery = extractJob(workflow, 'recover-existing-tag')
    const recoveryRelease = extractJob(workflow, 'recover-github-release')

    expect(publish).toContain('contents: read')
    expect(publish).toContain('id-token: write')
    expect(verify).not.toContain('id-token: write')
    expect(recovery).not.toContain('id-token: write')
    expect(recovery).toContain('contents: read')
    expect(release).toContain('contents: write')
    expect(release).not.toContain('id-token: write')
    expect(recoveryRelease).toContain('contents: write')
    expect(recoveryRelease).not.toContain('id-token: write')
  })

  it('keeps manual trusted-publisher verification non-publishing and tags as the publish trigger', async () => {
    const workflow = await readWorkflow()
    const trusted = extractJob(workflow, 'trusted-publisher')
    expect(trusted).toContain("github.event_name == 'workflow_dispatch'")
    expect(trusted).toContain("github.ref == 'refs/heads/main'")
    expect(trusted).toContain('ref: ${{ github.sha }}')
    expect(trusted).toContain('node tools/check-trusted-publishers.mjs')
    expect(trusted).not.toMatch(/pnpm publish|publish-packages/u)
    expect(workflow).toMatch(/push:\n\s+tags: \['v\*'\]/u)
    expect(workflow).toContain("NPM_TOKEN: ''")
    expect(workflow).toContain('NPM_CONFIG_USERCONFIG')
  })

  it('keeps release serialization and checks the release object idempotently', async () => {
    const workflow = await readWorkflow()
    expect(workflow).toContain('group: publish-${{')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain('node tools/ensure-github-release.mjs')
    expect(workflow).not.toContain('gh release create "$RELEASE_TAG"')
  })

  it('checks the exact tag tree before recovery can reach the write job', async () => {
    const workflow = await readWorkflow()
    const recovery = extractJob(workflow, 'recover-existing-tag')
    const release = extractJob(workflow, 'recover-github-release')
    expect(recovery).toContain('WORKFLOW_REF')
    expect(recovery).toContain('refs/tags/$RECOVERY_TAG')
    expect(recovery).toContain('RELEASE_ROOT="$TAG_ROOT" node tools/check-release-tag.mjs')
    expect(recovery).toContain('RELEASE_ROOT="$TAG_ROOT" node tools/harness-target.mjs')
    expect(recovery).toContain('RELEASE_RECOVERY: \'true\'')
    expect(recovery).toContain('RELEASE_ROOT="$TAG_ROOT" node tools/verify-published.mjs')
    expect(recovery).not.toContain('check-release-harness.mjs')
    expect(recovery).toContain('git merge-base --is-ancestor')
    expect(recovery).not.toMatch(/git (push|tag|update-ref)|gh api --method POST/u)
    expect(release).toContain('needs: recover-existing-tag')
    expect(release).toContain('ref: ${{ github.sha }}')
    expect(release).not.toContain('ref: main')
    expect(release).toContain("github.ref == 'refs/heads/main'")
  })
})
