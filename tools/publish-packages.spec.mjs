import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import { RegistryReadError } from './verify-published.mjs'
import { classifyPublishResult, PUBLISH_ARGUMENTS, publishWorkspacePackages } from './publish-packages.mjs'

const PACKAGES = [
  { name: '@dshline/renderer', version: '0.20.0' },
  { name: '@dshline/dshline', version: '0.20.0' },
]

function makeArtifacts(rendererDependency = '^0.20.0') {
  const root = mkdtempSync(join(tmpdir(), 'dshline-release-artifacts-'))
  const definitions = [
    { file: 'renderer.tgz', name: '@dshline/renderer', dependencies: {} },
    { file: 'dshline.tgz', name: '@dshline/dshline', dependencies: { '@dshline/renderer': rendererDependency } },
  ]
  for (const definition of definitions) {
    const source = join(root, `${definition.file}.src`)
    mkdirSync(join(source, 'package'), { recursive: true })
    writeFileSync(join(source, 'package', 'package.json'), JSON.stringify({
      name: definition.name,
      version: '0.20.0',
      dependencies: definition.dependencies,
    }))
    execFileSync('tar', ['-czf', join(root, definition.file), '-C', source, 'package'])
    rmSync(source, { recursive: true, force: true })
  }
  return root
}

describe('classifyPublishResult()', () => {
  it('pins the irreversible publish to npm latest with scripts disabled', () => {
    expect(PUBLISH_ARGUMENTS).toEqual(expect.arrayContaining([
      '--ignore-scripts', '--registry', 'https://registry.npmjs.org', '--tag', 'latest', '--dry-run=false',
    ]))
  })

  it('accepts a successful publish', () => {
    expect(classifyPublishResult({ status: 0, stdout: '', stderr: '' }, PACKAGES[0].name, PACKAGES[0].version))
      .toEqual({ kind: 'published' })
  })

  it('recognizes only npm’s exact accepted/staged conflict', () => {
    expect(classifyPublishResult({
      status: 1,
      stdout: '',
      stderr: '[E409] 409 Conflict - PUT https://registry.npmjs.org/@dshline%2frenderer - Cannot publish over previously staged version "0.20.0".',
    }, PACKAGES[0].name, PACKAGES[0].version)).toMatchObject({
      kind: 'accepted-staged',
      packageName: PACKAGES[0].name,
      version: PACKAGES[0].version,
    })
  })

  it('rejects wrong hosts, mixed errors, extra conflicts, and timeouts', () => {
    for (const result of [
      { status: 1, stdout: '', stderr: '[E409] 409 Conflict - PUT https://evilregistry.npmjs.org/@dshline%2frenderer - Cannot publish over previously staged version "0.20.0".' },
      { status: 1, stdout: '', stderr: '[E409] 409 Conflict - PUT https://registry.npmjs.org/@dshline%2frenderer - Cannot publish over previously staged version "0.20.0". E401 auth failure' },
      { status: 1, stdout: '', stderr: '[E409] 409 Conflict - PUT https://registry.npmjs.org/@dshline%2frenderer - Cannot publish over previously staged version "0.20.0".\n[E409] 409 Conflict - another operation' },
      { status: 2, stdout: '', stderr: '[E409] 409 Conflict - PUT https://registry.npmjs.org/@dshline%2frenderer - Cannot publish over previously staged version "0.20.0".' },
    ]) {
      expect(classifyPublishResult(result, PACKAGES[0].name, PACKAGES[0].version).kind).toBe('failed')
    }
  })

  it('does not suppress auth, unrelated conflict, or server failures', () => {
    for (const result of [
      { status: 1, stdout: '', stderr: 'E401 Unable to authenticate' },
      { status: 1, stdout: '', stderr: '[E409] 409 Conflict - version is immutable for another reason' },
      { status: 1, stdout: '', stderr: '[E503] 503 Service Unavailable' },
      { status: null, stdout: '', stderr: 'spawn pnpm ENOENT' },
    ]) {
      expect(classifyPublishResult(result, PACKAGES[0].name, PACKAGES[0].version).kind).toBe('failed')
    }
  })
})

describe('publishWorkspacePackages()', () => {
  it('skips an exact version already visible without invoking publish', async () => {
    const runPublish = vi.fn()
    const readPublished = vi.fn(async (name, version) => ({ kind: 'visible', manifest: { name, version } }))

    const outcomes = await publishWorkspacePackages({ readPackage: readPublished, runPublish, write: () => {}, allowSourceDirectory: true })

    expect(runPublish).not.toHaveBeenCalled()
    expect(outcomes.map(outcome => outcome.kind)).toEqual(['already-visible', 'already-visible'])
    expect(readPublished).toHaveBeenCalledTimes(2)
  })

  it('publishes an absent package and continues after npm accepts it', async () => {
    const runPublish = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
    const readPublished = vi.fn(async () => ({ kind: 'absent' }))

    const outcomes = await publishWorkspacePackages({ readPackage: readPublished, runPublish, write: () => {}, allowSourceDirectory: true })

    expect(runPublish).toHaveBeenCalledTimes(2)
    expect(outcomes.map(outcome => outcome.kind)).toEqual(['published', 'published'])
  })

  it('continues narrowly after the exact accepted/staged condition', async () => {
    const runPublish = vi.fn(item => ({
      status: 1,
      stdout: '',
      stderr: `[E409] 409 Conflict - PUT https://registry.npmjs.org/${encodeURIComponent(item.name)} - Cannot publish over previously staged version "${item.version}"`,
    }))
    const readPublished = vi.fn(async () => ({ kind: 'absent' }))

    await expect(publishWorkspacePackages({ readPackage: readPublished, runPublish, write: () => {}, allowSourceDirectory: true }))
      .resolves.toHaveLength(2)
  })

  it('fails before publishing when the registry cannot establish absence', async () => {
    const runPublish = vi.fn()
    const readPublished = vi.fn(async () => { throw new RegistryReadError('transient', 'registry returned HTTP 503') })

    await expect(publishWorkspacePackages({ readPackage: readPublished, runPublish, write: () => {}, allowSourceDirectory: true }))
      .rejects.toThrow('registry returned HTTP 503')
    expect(runPublish).not.toHaveBeenCalled()
  })

  it('fails on an auth or unrelated publish error', async () => {
    const readPublished = vi.fn(async () => ({ kind: 'absent' }))
    const runPublish = vi.fn(() => ({ status: 1, stdout: '', stderr: 'E401 auth failure' }))

    await expect(publishWorkspacePackages({ readPackage: readPublished, runPublish, write: () => {}, allowSourceDirectory: true }))
      .rejects.toThrow('@dshline/renderer@0.20.0')
  })

  it('requires an absolute artifact root outside explicit test mode', async () => {
    await expect(publishWorkspacePackages({ readPublished: async () => ({ kind: 'visible' }) }))
      .rejects.toThrow('PUBLISH_ARTIFACT_ROOT')
    await expect(publishWorkspacePackages({ artifactRoot: 'relative', readPublished: async () => ({ kind: 'visible' }) }))
      .rejects.toThrow('PUBLISH_ARTIFACT_ROOT')
  })

  it('publishes only validated downloaded tarballs and binds the dependency generation', async () => {
    const artifactRoot = makeArtifacts()
    const runPublish = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
    try {
      await expect(publishWorkspacePackages({
        artifactRoot,
        readPublished: async () => ({ kind: 'absent' }),
        runPublish,
        write: () => {},
      })).resolves.toHaveLength(2)
      expect(runPublish.mock.calls.map(call => call[1])).toEqual([
        join(artifactRoot, 'renderer.tgz'),
        join(artifactRoot, 'dshline.tgz'),
      ])
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true })
    }
  })

  it('rejects an artifact with a mismatched renderer dependency before publishing', async () => {
    const artifactRoot = makeArtifacts('^0.19.0')
    const runPublish = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
    try {
      await expect(publishWorkspacePackages({
        artifactRoot,
        readPublished: async () => ({ kind: 'absent' }),
        runPublish,
        write: () => {},
      })).rejects.toThrow('wrong renderer dependency')
      expect(runPublish).not.toHaveBeenCalled()
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true })
    }
  })

  it('collects every registry decision before publishing any package', async () => {
    const runPublish = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
    let calls = 0
    await expect(publishWorkspacePackages({
      readPackage: async () => ({ kind: 'absent' }),
      readPublished: async () => {
        calls += 1
        if (calls === 2) throw new RegistryReadError('transient', 'second package unavailable')
        return { kind: 'absent' }
      },
      runPublish,
      write: () => {},
      allowSourceDirectory: true,
    })).rejects.toThrow('second package unavailable')
    expect(runPublish).not.toHaveBeenCalled()
  })
})
