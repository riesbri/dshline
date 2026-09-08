import { describe, expect, it, vi } from 'vitest'
import {
  createGithubRelease,
  ensureGithubRelease,
  readGithubRelease,
  ReleaseCreateError,
  validateReleaseTag,
} from './ensure-github-release.mjs'

const OPTIONS = {
  apiUrl: 'https://api.github.test',
  repository: 'riesbri/dshline',
  tag: 'v0.20.0',
  token: 'github-token',
}

/** Minimal GitHub API response for the release helper tests. */
function response(body, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

describe('validateReleaseTag()', () => {
  it('accepts only stable release tags', () => {
    expect(validateReleaseTag('v0.20.0')).toBe('v0.20.0')
    expect(() => validateReleaseTag('v1.2.3-rc.1')).toThrow()
  })

  it('rejects unsafe or non-version input', () => {
    for (const tag of ['', 'main', 'v0.20.0/../../main', 'v0.20.0\n--repo']) {
      expect(() => validateReleaseTag(tag)).toThrow()
    }
  })
})

describe('ensureGithubRelease()', () => {
  it('does not POST or rewrite an existing release for the exact tag', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200))
      .mockResolvedValueOnce(response({ tag_name: OPTIONS.tag, draft: false, prerelease: false }, 200))
    const createRelease = vi.fn()

    await expect(ensureGithubRelease({ ...OPTIONS, fetchImpl, createRelease, write: () => {} }))
      .resolves.toMatchObject({ kind: 'existing' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(createRelease).not.toHaveBeenCalled()
  })

  it('creates only after an explicit release 404 and existing tag response', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200))
      .mockResolvedValueOnce(response({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200))
      .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200))
      .mockResolvedValueOnce(response({ tag_name: OPTIONS.tag, draft: false, prerelease: false }, 200))
    const createRelease = vi.fn(async request => ({ tag_name: request.tag, draft: false, prerelease: false }))

    await expect(ensureGithubRelease({ ...OPTIONS, fetchImpl, createRelease, write: () => {} }))
      .resolves.toMatchObject({ kind: 'created' })
    expect(createRelease).toHaveBeenCalledWith(expect.objectContaining(OPTIONS))
  })

  it('bounds post-create readback while tolerating GitHub Release propagation', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200))
      .mockResolvedValueOnce(response({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200))
      .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200))
      .mockResolvedValueOnce(response({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(response({ tag_name: OPTIONS.tag, draft: false, prerelease: false }, 200))
    const sleep = vi.fn(async () => {})
    await expect(ensureGithubRelease({
      ...OPTIONS,
      fetchImpl,
      createRelease: async request => ({ tag_name: request.tag, draft: false, prerelease: false }),
      sleep,
      readbackAttempts: 2,
      write: () => {},
    })).resolves.toMatchObject({ kind: 'created' })
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('handles a create race by accepting the exact release that appeared', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200))
      .mockResolvedValueOnce(response({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200))
      .mockResolvedValueOnce(response({ tag_name: OPTIONS.tag, draft: false, prerelease: false }, 200))
    const createRelease = vi.fn(async () => {
      throw new ReleaseCreateError('conflict', 'GitHub Release creation raced another creator')
    })

    await expect(ensureGithubRelease({ ...OPTIONS, fetchImpl, createRelease, write: () => {} }))
      .resolves.toMatchObject({ kind: 'existing' })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('uses generated notes, an explicit repository, and verify-tag without creating a tag', () => {
    const exec = vi.fn()
    const release = createGithubRelease({ ...OPTIONS, exec })
    expect(release).toMatchObject({ tag_name: OPTIONS.tag, draft: false, prerelease: false })
    expect(exec).toHaveBeenCalledWith('gh', [
      'release', 'create', OPTIONS.tag,
      '--repo', OPTIONS.repository,
      '--generate-notes', '--verify-tag',
    ], expect.objectContaining({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    vi.stubEnv('GH_HOST', 'evil.example.test')
    const isolatedExec = vi.fn()
    createGithubRelease({ ...OPTIONS, apiUrl: 'https://api.github.com', exec: isolatedExec })
    expect(isolatedExec.mock.calls[0][2].env.GH_HOST).toBeUndefined()
    vi.unstubAllEnvs()
  })

  it('classifies only the exact duplicate-release create response as a race', () => {
    const duplicate = () => {
      const error = new Error('gh failed')
      error.stderr = "HTTP 422: Validation Failed {resource:'Release', code:'already_exists', field:'tag_name'}"
      throw error
    }
    expect(() => createGithubRelease({ ...OPTIONS, exec: duplicate })).toThrow(ReleaseCreateError)
    const unrelated = () => {
      const error = new Error('gh failed')
      error.stderr = 'HTTP 422: Validation Failed {resource:"Release", code:"invalid", field:"tag_name"}'
      throw error
    }
    expect(() => createGithubRelease({ ...OPTIONS, exec: unrelated })).toThrow('gh failed')
  })

  it('fails closed on a lookup outage or malformed release', async () => {
    await expect(ensureGithubRelease({
      ...OPTIONS,
      fetchImpl: async () => response({}, 500),
      createRelease: vi.fn(),
    })).rejects.toThrow('HTTP 500')
    await expect(ensureGithubRelease({
      ...OPTIONS,
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200))
        .mockResolvedValueOnce(response({ tag_name: 'v0.19.0', draft: false, prerelease: false }, 200)),
      createRelease: vi.fn(),
    })).rejects.toThrow('does not point at v0.20.0')
    await expect(ensureGithubRelease({
      ...OPTIONS,
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200))
        .mockResolvedValueOnce(response({}, 404))
        .mockResolvedValueOnce(response({ ref: `refs/tags/${OPTIONS.tag}`, object: { sha: 'tag-sha', type: 'tag' } }, 200)),
      createRelease: vi.fn(async () => ({ tag_name: 'v0.19.0', draft: false, prerelease: false })),
    })).rejects.toThrow('did not return a valid v0.20.0 release')
    await expect(ensureGithubRelease({
      ...OPTIONS,
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(response({}, 404)),
      createRelease: vi.fn(),
    })).rejects.toThrow('does not exist; refusing to create it')
  })

  it('does not accept an existing draft as a completed public release', async () => {
    await expect(readGithubRelease({
      ...OPTIONS,
      fetchImpl: async () => response({ tag_name: OPTIONS.tag, draft: true }, 200),
    })).rejects.toThrow('published state')
  })
})
