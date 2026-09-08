import { describe, expect, it, vi } from 'vitest'
import {
  NPM_REGISTRY,
  PACKAGE_DIRECTORIES,
  RegistryReadError,
  readDistTags,
  readExactPackage,
  verifyRelease,
  waitForPublished,
} from './verify-published.mjs'

const PACKAGES = [
  { name: '@dshline/renderer', version: '0.20.0' },
  { name: '@dshline/dshline', version: '0.20.0' },
]

/** Minimal fetch response for the registry reader tests. */
function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] },
    json: async () => body,
  }
}

describe('waitForPublished()', () => {
  it('covers every published workspace package', () => {
    expect(PACKAGE_DIRECTORIES).toEqual(['packages/renderer', 'packages/dshline'])
  })

  it('reports one package immediately and waits for the other beyond the old minute', async () => {
    const seen = new Map(PACKAGES.map(item => [item.name, 0]))
    const readPackage = vi.fn(async name => {
      const count = (seen.get(name) ?? 0) + 1
      seen.set(name, count)
      return name === PACKAGES[0].name || count >= 7
        ? { kind: 'visible', manifest: { name, version: '0.20.0' } }
        : { kind: 'absent' }
    })
    const sleep = vi.fn(async () => {})
    const write = vi.fn()
    const onVisible = vi.fn()

    await expect(waitForPublished(PACKAGES, {
      readPackage,
      sleep,
      write,
      onVisible,
      attempts: 7,
    })).resolves.toEqual([])
    expect(sleep).toHaveBeenCalledTimes(6)
    expect(readPackage.mock.calls.map(call => call[0])).toEqual([
      PACKAGES[0].name,
      PACKAGES[1].name,
      PACKAGES[1].name,
      PACKAGES[1].name,
      PACKAGES[1].name,
      PACKAGES[1].name,
      PACKAGES[1].name,
      PACKAGES[1].name,
    ])
    expect(onVisible).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledWith(expect.stringContaining(`${PACKAGES[0].name}@0.20.0`))
    expect(write).toHaveBeenCalledWith(expect.stringContaining(`${PACKAGES[1].name}@0.20.0`))
  })

  it('does not query packages already observed', async () => {
    const readPackage = vi.fn(async name => ({
      kind: name === PACKAGES[0].name ? 'visible' : 'absent',
      manifest: { name, version: '0.20.0' },
    }))
    const sleep = vi.fn(async () => {})

    await expect(waitForPublished(PACKAGES, { readPackage, sleep, write: () => {}, attempts: 3 }))
      .resolves.toEqual([`${PACKAGES[1].name}@0.20.0`])
    expect(readPackage.mock.calls.map(call => call[0])).toEqual([
      PACKAGES[0].name,
      PACKAGES[1].name,
      PACKAGES[1].name,
      PACKAGES[1].name,
    ])
  })

  it('returns only genuinely missing packages at the bounded timeout', async () => {
    const sleep = vi.fn(async () => {})
    const missing = await waitForPublished(PACKAGES, {
      readPackage: async name => name === PACKAGES[0].name
        ? { kind: 'visible', manifest: { name, version: '0.20.0' } }
        : { kind: 'absent' },
      sleep,
      write: () => {},
      attempts: 3,
    })

    expect(missing).toEqual([`${PACKAGES[1].name}@0.20.0`])
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('retries transient registry errors instead of calling them absence', async () => {
    let calls = 0
    const sleep = vi.fn(async () => {})
    const readPackage = vi.fn(async name => {
      calls += 1
      if (calls === 1) throw new RegistryReadError('transient', 'registry returned HTTP 503')
      return { kind: 'visible', manifest: { name, version: '0.20.0' } }
    })

    await expect(waitForPublished(PACKAGES, { readPackage, sleep, write: () => {}, attempts: 2 }))
      .resolves.toEqual([])
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(readPackage).toHaveBeenCalledTimes(3)
  })

  it('fails with a useful error when a transient registry failure persists', async () => {
    const sleep = vi.fn(async () => {})
    await expect(waitForPublished(PACKAGES, {
      readPackage: async () => {
        throw new RegistryReadError('transient', 'registry returned HTTP 503')
      },
      sleep,
      write: () => {},
      attempts: 2,
    })).rejects.toThrow('registry remained unavailable')
  })

  it('shares one bounded deadline instead of granting every phase a new window', async () => {
    let clock = 0
    const readPackage = vi.fn(async name => ({ kind: 'absent', manifest: { name, version: '0.20.0' } }))
    const sleep = vi.fn(async milliseconds => { clock += milliseconds })
    await expect(waitForPublished(PACKAGES, {
      readPackage,
      sleep,
      now: () => clock,
      windowMs: 100,
      attempts: 60,
      write: () => {},
    })).resolves.toEqual(PACKAGES.map(item => `${item.name}@${item.version}`))
    expect(readPackage).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(100)
  })

  it('fails explicitly for an unexpected registry response', async () => {
    await expect(waitForPublished(PACKAGES, {
      readPackage: async () => {
        throw new RegistryReadError('unexpected', 'registry returned HTTP 403')
      },
      sleep: async () => {},
      write: () => {},
    })).rejects.toThrow('HTTP 403')
  })
})

describe('readExactPackage()', () => {
  it('distinguishes an absent exact version from registry failures', async () => {
    await expect(readExactPackage('@dshline/renderer', '0.20.0', {
      fetchImpl: async () => response(undefined, 404),
    })).resolves.toEqual({ kind: 'absent' })
    await expect(readExactPackage('@dshline/renderer', '0.20.0', {
      fetchImpl: async () => response({}, 503),
    })).rejects.toMatchObject({ kind: 'transient' })
    await expect(readExactPackage('@dshline/renderer', '0.20.0', {
      fetchImpl: async () => response({}, 403),
    })).rejects.toMatchObject({ kind: 'unexpected' })
    await expect(readExactPackage('@dshline/renderer', '0.20.0', {
      fetchImpl: async () => response({}, 429, { 'retry-after': '3' }),
    })).rejects.toMatchObject({ kind: 'transient', retryAfterMs: 3000 })
    await expect(readExactPackage('@dshline/renderer', '0.20.0', {
      timeoutMs: 5,
      fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
    })).rejects.toMatchObject({ kind: 'transient' })
    await expect(readExactPackage('@dshline/renderer', '0.20.0', {
      timeoutMs: 5,
      fetchImpl: () => new Promise(() => {}),
    })).rejects.toMatchObject({ kind: 'transient' })
    await expect(readExactPackage('@dshline/renderer', '0.20.0', {
      fetchImpl: async () => { throw new Error('DNS unavailable') },
    })).rejects.toThrow('DNS unavailable')
  })

  it('uses the public npm registry exact-version endpoint', async () => {
    const fetchImpl = vi.fn(async () => response({ name: '@dshline/renderer', version: '0.20.0' }))
    await expect(readExactPackage('@dshline/renderer', '0.20.0', { fetchImpl })).resolves.toMatchObject({ kind: 'visible' })
    expect(fetchImpl.mock.calls[0][0]).toBe(`${NPM_REGISTRY}/%40dshline%2Frenderer/0.20.0`)
    expect(fetchImpl.mock.calls[0][1].headers['Cache-Control']).toBe('no-cache')
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual')
  })

  it('rejects a malformed latest dist-tag instead of waiting on it', async () => {
    await expect(readDistTags('@dshline/renderer', {
      fetchImpl: async () => response({ 'dist-tags': { latest: null } }),
    })).rejects.toMatchObject({ kind: 'unexpected' })
  })
})

describe('verifyRelease()', () => {
  it('verifies the published dependency generation and stable latest tags', async () => {
    const manifests = new Map([
      [PACKAGES[0].name, { name: PACKAGES[0].name, version: '0.20.0' }],
      [PACKAGES[1].name, {
        name: PACKAGES[1].name,
        version: '0.20.0',
        dependencies: { '@dshline/renderer': '^0.20.0' },
      }],
    ])
    const readPackage = vi.fn(async name => ({ kind: 'visible', manifest: manifests.get(name) }))
    const readTags = vi.fn(async () => ({ latest: '0.20.0' }))

    await expect(verifyRelease(PACKAGES, { readPackage, readTags, sleep: async () => {}, write: () => {} }))
      .resolves.toMatchObject({ missing: [], distTags: expect.any(Map) })
    expect(readTags).toHaveBeenCalledTimes(2)
  })

  it('waits for stable latest tags without re-reading confirmed package tags', async () => {
    const readPackage = async name => ({
      kind: 'visible',
      manifest: name === PACKAGES[1].name
        ? { name, version: '0.20.0', dependencies: { '@dshline/renderer': '^0.20.0' } }
        : { name, version: '0.20.0' },
    })
    const counts = new Map()
    const readTags = vi.fn(async name => {
      const count = (counts.get(name) ?? 0) + 1
      counts.set(name, count)
      return { latest: name === PACKAGES[0].name || count >= 2 ? '0.20.0' : '0.19.0' }
    })

    await expect(verifyRelease(PACKAGES, { readPackage, readTags, sleep: async () => {}, write: () => {}, attempts: 2 }))
      .resolves.toMatchObject({ missing: [] })
    expect(readTags.mock.calls.map(call => call[0])).toEqual([
      PACKAGES[0].name,
      PACKAGES[1].name,
      PACKAGES[0].name,
      PACKAGES[1].name,
    ])
  })

  it('recovers an old exact tag without consulting mutable latest tags', async () => {
    const readPackage = async name => ({
      kind: 'visible',
      manifest: name === PACKAGES[1].name
        ? { name, version: '0.20.0', dependencies: { '@dshline/renderer': '^0.20.0' } }
        : { name, version: '0.20.0' },
    })
    const readTags = vi.fn(() => { throw new Error('latest must not be read during historical recovery') })

    await expect(verifyRelease(PACKAGES, {
      readPackage,
      readTags,
      latestPolicy: 'skip',
      sleep: async () => {},
      write: () => {},
    })).resolves.toMatchObject({ missing: [], distTags: new Map() })
    expect(readTags).not.toHaveBeenCalled()
  })

  it('rejects a published manifest from the wrong renderer generation', async () => {
    const readPackage = async name => ({
      kind: 'visible',
      manifest: name === PACKAGES[1].name
        ? { name, version: '0.20.0', dependencies: { '@dshline/renderer': '^0.19.0' } }
        : { name, version: '0.20.0' },
    })

    await expect(verifyRelease(PACKAGES, { readPackage, sleep: async () => {}, write: () => {} }))
      .rejects.toThrow('instead of ^0.20.0')
  })
})
