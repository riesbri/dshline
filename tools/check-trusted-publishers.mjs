/**
 * Verify that npm will exchange this workflow's GitHub OIDC identity for both
 * packages before a workspace publish can become half-complete.
 *
 * A recursive publish authenticates one package at a time. If only the renderer
 * trusted this workflow, it could be published before the bundle's exchange
 * failed, and npm versions cannot be replaced. This preflight performs both
 * exchanges first and deliberately discards the short-lived publish tokens.
 * @module tools/check-trusted-publishers
 */

import { PUBLISHED_PACKAGES as RELEASE_PACKAGES } from './verify-published.mjs'

/** Published workspace package names, shared with registry and publish gates. */
export const PUBLISHED_PACKAGES = Object.freeze(RELEASE_PACKAGES.map(item => item.name))

/** npm's expected audience for a GitHub-issued identity token. */
const NPM_AUDIENCE = 'npm:registry.npmjs.org'

/** npm registry origin and OIDC exchange root. */
const NPM_REGISTRY = 'https://registry.npmjs.org'

/**
 * Fetch and validate JSON without ever including a bearer token in an error.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @param url - endpoint to call.
 * @param init - request options.
 * @param label - safe operation name for failures.
 * @returns the parsed JSON object.
 */
async function fetchJson(fetchImpl, url, init, label) {
  const response = await fetchImpl(url, init)
  if (!response.ok) throw new Error(`${label} failed with HTTP ${String(response.status)}`)
  const value = await response.json()
  if (value === null || typeof value !== 'object') throw new Error(`${label} returned invalid JSON`)
  return value
}

/**
 * Verify every package's trusted-publisher exchange for one GitHub Actions job.
 * @param options - injectable environment and fetch implementation.
 * @param options.env - GitHub's OIDC request variables.
 * @param options.fetchImpl - fetch implementation.
 * @returns the package names whose exchanges succeeded.
 */
export async function checkTrustedPublishers({ env = process.env, fetchImpl = fetch } = {}) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (typeof requestUrl !== 'string' || requestUrl === '' || typeof requestToken !== 'string' || requestToken === '') {
    throw new Error('GitHub OIDC is unavailable; the job needs id-token: write')
  }

  let identityUrl
  try {
    identityUrl = new URL(requestUrl)
  } catch {
    throw new Error('GitHub OIDC request URL is invalid')
  }
  if (identityUrl.protocol !== 'https:' || !identityUrl.hostname.endsWith('.actions.githubusercontent.com')) {
    throw new Error('GitHub OIDC request URL must use the GitHub Actions HTTPS issuer')
  }
  identityUrl.searchParams.set('audience', NPM_AUDIENCE)
  const identity = await fetchJson(fetchImpl, identityUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${requestToken}`,
    },
  }, 'GitHub OIDC identity request')
  if (!('value' in identity) || typeof identity.value !== 'string' || identity.value === '') {
    throw new Error('GitHub OIDC identity response contained no token')
  }

  for (const name of PUBLISHED_PACKAGES) {
    const exchangeUrl = `${NPM_REGISTRY}/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(name)}`
    const exchanged = await fetchJson(fetchImpl, exchangeUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${identity.value}`,
        'Content-Length': '0',
      },
      body: '',
    }, `npm trusted-publisher exchange for ${name}`)
    if (!('token' in exchanged) || typeof exchanged.token !== 'string' || exchanged.token === '') {
      throw new Error(`npm trusted-publisher exchange for ${name} returned no token`)
    }
    process.stdout.write(`trusted-publisher: npm accepted ${name}\n`)
  }

  return [...PUBLISHED_PACKAGES]
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await checkTrustedPublishers()
}
