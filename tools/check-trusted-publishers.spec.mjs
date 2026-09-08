import { describe, expect, it, vi } from 'vitest'
import { checkTrustedPublishers, PUBLISHED_PACKAGES } from './check-trusted-publishers.mjs'

/** Minimal successful fetch response for the preflight's JSON reader. */
function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  }
}

const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/id-token?api-version=1',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-request-token',
}

describe('checkTrustedPublishers()', () => {
  it('covers every published workspace package', () => {
    expect(PUBLISHED_PACKAGES).toEqual([
      '@dshline/renderer',
      '@dshline/dshline',
    ])
  })

  it('gets one npm-audience identity and verifies both package exchanges', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ value: 'github-identity-token' }))
      .mockResolvedValueOnce(response({ token: 'renderer-publish-token' }))
      .mockResolvedValueOnce(response({ token: 'tui-publish-token' }))

    await expect(checkTrustedPublishers({ env: ENV, fetchImpl })).resolves.toEqual(PUBLISHED_PACKAGES)

    const identityUrl = new URL(fetchImpl.mock.calls[0][0])
    expect(identityUrl.searchParams.get('audience')).toBe('npm:registry.npmjs.org')
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer github-request-token')
    expect(String(fetchImpl.mock.calls[1][0])).toContain(encodeURIComponent(PUBLISHED_PACKAGES[0]))
    expect(String(fetchImpl.mock.calls[2][0])).toContain(encodeURIComponent(PUBLISHED_PACKAGES[1]))
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer github-identity-token')
  })

  it('fails before publishing when either package rejects this workflow', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ value: 'github-identity-token' }))
      .mockResolvedValueOnce(response({ token: 'renderer-publish-token' }))
      .mockResolvedValueOnce(response({}, 403))

    await expect(checkTrustedPublishers({ env: ENV, fetchImpl }))
      .rejects.toThrow(`npm trusted-publisher exchange for ${PUBLISHED_PACKAGES[1]} failed with HTTP 403`)
  })

  it('requires the workflow OIDC permission', async () => {
    await expect(checkTrustedPublishers({ env: {}, fetchImpl: vi.fn() }))
      .rejects.toThrow('the job needs id-token: write')
    await expect(checkTrustedPublishers({
      env: { ...ENV, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
      fetchImpl: vi.fn(),
    })).rejects.toThrow('the job needs id-token: write')
    await expect(checkTrustedPublishers({
      env: { ...ENV, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://evil.example.test/token' },
      fetchImpl: vi.fn(),
    })).rejects.toThrow('GitHub Actions HTTPS issuer')
  })
})
