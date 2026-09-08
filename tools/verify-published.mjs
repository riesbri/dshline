/**
 * Confirm the public registry serves one coherent release.
 *
 * npm accepted publication is not the same moment npm serves the package publicly:
 * trusted publishing and registry validation can leave an accepted version
 * temporarily absent from the public read API. This verifier is intentionally
 * separate from the publish job so a delayed read can fail and be rerun without
 * crossing the irreversible publication boundary again.
 *
 * @module tools/verify-published
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isPrereleaseVersion, VERSION_SHAPE } from './release-version.mjs'

/** Workspace packages and their immutable public identities, in publish order. */
export const PUBLISHED_PACKAGES = Object.freeze([
  Object.freeze({ directory: 'packages/renderer', name: '@dshline/renderer', artifact: 'renderer.tgz' }),
  Object.freeze({ directory: 'packages/dshline', name: '@dshline/dshline', artifact: 'dshline.tgz' }),
])

/** Workspace package directories retained as a small compatibility surface. */
export const PACKAGE_DIRECTORIES = PUBLISHED_PACKAGES.map(item => item.directory)

/** The public npm registry is the authority for externally visible versions. */
export const NPM_REGISTRY = 'https://registry.npmjs.org'

/**
 * Twenty minutes covers npm's current publish-time validation without polling
 * forever. The fixed interval is slow enough not to hammer the registry and
 * simple enough to make the bounded behavior obvious.
 */
export const VERIFY_ATTEMPTS = 60

/** One registry read every twenty seconds after an accepted publication. */
export const VERIFY_DELAY_MS = 20_000

/** One shared deadline covers exact versions, tags, and coherence checks. */
export const VERIFY_WINDOW_MS = 20 * 60 * 1000

/** Keep one hung registry connection from extending the bounded window forever. */
export const REGISTRY_REQUEST_TIMEOUT_MS = 10_000

/** HTTP statuses that describe a temporary registry/network condition. */
const RETRYABLE_STATUS = new Set([408, 425, 429])

/**
 * A registry lookup failed in a way the caller must not misreport as absence.
 * @typedef {'transient' | 'unexpected'} RegistryFailureKind
 */

/**
 * Error from the registry reader, with absence kept separate from failure.
 */
export class RegistryReadError extends Error {
  /**
   * @param {RegistryFailureKind} kind - whether retrying may help.
   * @param {string} message - safe diagnostic without credentials.
   * @param {{retryAfterMs?: number}} details - optional bounded retry hint.
   */
  constructor(kind, message, details = {}) {
    super(message)
    this.name = 'RegistryReadError'
    this.kind = kind
    this.retryAfterMs = details.retryAfterMs ?? 0
  }
}

/**
 * A response body that describes a package version.
 * @typedef {{ kind: 'visible', manifest: Record<string, unknown> } | { kind: 'absent' }} PackageRead
 */

/**
 * Convert a package name to the registry endpoint used for an exact version.
 * @param {string} registry - registry origin.
 * @param {string} name - package name.
 * @param {string} version - exact version.
 * @returns {string} exact package endpoint.
 */
function exactEndpoint(registry, name, version) {
  return `${registry.replace(/\/$/u, '')}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
}

/**
 * Convert a package name to its packument endpoint.
 * @param {string} registry - registry origin.
 * @param {string} name - package name.
 * @returns {string} package metadata endpoint.
 */
function packumentEndpoint(registry, name) {
  return `${registry.replace(/\/$/u, '')}/${encodeURIComponent(name)}`
}

/**
 * Return the configured registry origin, rejecting redirects and non-HTTPS sinks.
 * @param registry - registry origin.
 * @returns normalized registry origin.
 */
function registryOrigin(registry) {
  let parsed
  try {
    parsed = new URL(registry)
  } catch (error) {
    throw new RegistryReadError('unexpected', `registry URL is invalid: ${String(error)}`)
  }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new RegistryReadError('unexpected', `registry URL must be an HTTPS origin: ${registry}`)
  }
  return parsed.origin
}

/**
 * Network errors are retryable; programmer/configuration errors are not.
 * @param error - thrown fetch error.
 * @returns whether the error can plausibly be a temporary network failure.
 */
function isTransientNetworkError(error) {
  return error instanceof TypeError
    || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
}

/**
 * Convert an HTTP Retry-After header into a bounded millisecond hint.
 * @param response - registry response.
 * @returns non-negative milliseconds, or zero when absent/malformed.
 */
function retryAfterMilliseconds(response) {
  const raw = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : undefined
  if (raw === undefined || raw === null || raw === '') return 0
  if (/^\d+(?:\.\d+)?$/u.test(raw)) return Math.max(0, Number(raw) * 1000)
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0
}

/**
 * Read JSON from npm while classifying HTTP/network failures explicitly.
 * @param {typeof fetch} fetchImpl - fetch implementation.
 * @param {string} url - endpoint to read.
 * @param {string} label - safe operation name for diagnostics.
 * @param {number} timeoutMs - maximum time for headers and body.
 * @returns {Promise<{status: number, body: unknown} | {status: 404, body: undefined}>} response status and body.
 * @throws {RegistryReadError} for retryable or unexpected registry failures.
 */
async function readJson(fetchImpl, url, label, timeoutMs = REGISTRY_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const startedAt = performance.now()
  let timedOut = false
  let bodyTimer
  let timer
  const requestTimeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new DOMException('registry request timed out', 'AbortError'))
    }, Math.max(1, timeoutMs))
  })
  let response
  try {
    response = await Promise.race([
      fetchImpl(url, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        redirect: 'manual',
        signal: controller.signal,
      }),
      requestTimeout,
    ])

    if (response.status >= 300 && response.status < 400) {
      throw new RegistryReadError('unexpected', `${label} returned an unexpected redirect`)
    }
    if (response.url !== undefined && response.url !== '' && new URL(response.url).origin !== new URL(url).origin) {
      throw new RegistryReadError('unexpected', `${label} returned a cross-origin response`)
    }
    if (response.status === 404) return { status: 404, body: undefined }
    if (RETRYABLE_STATUS.has(response.status) || response.status >= 500) {
      throw new RegistryReadError(
        'transient',
        `${label} returned HTTP ${String(response.status)}`,
        { retryAfterMs: retryAfterMilliseconds(response) },
      )
    }
    if (response.status !== 200 || !response.ok) {
      throw new RegistryReadError('unexpected', `${label} returned unexpected HTTP ${String(response.status)}`)
    }

    let body
    try {
      const remainingBodyMs = Math.max(1, timeoutMs - (performance.now() - startedAt))
      const bodyTimeout = new Promise((_, reject) => {
        bodyTimer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(new DOMException('registry response body timed out', 'AbortError'))
        }, remainingBodyMs)
      })
      body = await Promise.race([response.json(), bodyTimeout])
    } catch (error) {
      if (timedOut || isTransientNetworkError(error)) {
        throw new RegistryReadError('transient', `${label} timed out while reading JSON`)
      }
      const reason = error instanceof Error ? error.message : String(error)
      throw new RegistryReadError('unexpected', `${label} returned invalid JSON: ${reason}`)
    }
    return { status: response.status, body }
  } catch (error) {
    if (error instanceof RegistryReadError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    if (timedOut || isTransientNetworkError(error)) {
      throw new RegistryReadError('transient', `${label} failed before a response: ${reason}`)
    }
    throw new RegistryReadError('unexpected', `${label} failed unexpectedly: ${reason}`)
  } finally {
    clearTimeout(timer)
    if (bodyTimer !== undefined) clearTimeout(bodyTimer)
  }
}

/**
 * Ask the public registry whether one exact version is externally visible.
 *
 * A 404 is deliberately the only absence result. DNS failures, timeouts, rate
 * limits, 5xx responses, malformed JSON, and other statuses remain failures so
 * a broken registry cannot be reported as a half-release.
 * @param name - package name.
 * @param version - exact version.
 * @param options - injectable registry access for tests.
 * @param options.fetchImpl - fetch implementation.
 * @param options.registry - registry origin.
 * @returns the exact-version observation.
 */
export async function readExactPackage(name, version, {
  fetchImpl = fetch,
  registry = NPM_REGISTRY,
  timeoutMs = REGISTRY_REQUEST_TIMEOUT_MS,
} = {}) {
  const origin = registryOrigin(registry)
  const result = await readJson(
    fetchImpl,
    exactEndpoint(origin, name, version),
    `registry lookup for ${name}@${version}`,
    timeoutMs,
  )
  if (result.status === 404) return { kind: 'absent' }
  if (result.body === null || typeof result.body !== 'object' || Array.isArray(result.body)) {
    throw new RegistryReadError('unexpected', `registry lookup for ${name}@${version} returned a non-object manifest`)
  }
  const manifest = /** @type {Record<string, unknown>} */ (result.body)
  if (manifest.name !== name) {
    throw new RegistryReadError(
      'unexpected',
      `registry lookup for ${name}@${version} returned package ${JSON.stringify(manifest.name)}`,
    )
  }
  if (manifest.version !== version) {
    throw new RegistryReadError(
      'unexpected',
      `registry lookup for ${name}@${version} returned version ${JSON.stringify(manifest.version)}`,
    )
  }
  return { kind: 'visible', manifest }
}

/**
 * Read the public dist-tags for one package.
 * @param name - package name.
 * @param options - injectable registry access for tests.
 * @param options.fetchImpl - fetch implementation.
 * @param options.registry - registry origin.
 * @returns the package's dist-tags map.
 */
export async function readDistTags(name, {
  fetchImpl = fetch,
  registry = NPM_REGISTRY,
  timeoutMs = REGISTRY_REQUEST_TIMEOUT_MS,
} = {}) {
  const origin = registryOrigin(registry)
  const result = await readJson(
    fetchImpl,
    packumentEndpoint(origin, name),
    `registry packument for ${name}`,
    timeoutMs,
  )
  if (result.status === 404) {
    throw new RegistryReadError('unexpected', `registry packument for ${name} disappeared after its version was visible`)
  }
  if (result.body === null || typeof result.body !== 'object' || Array.isArray(result.body)) {
    throw new RegistryReadError('unexpected', `registry packument for ${name} returned a non-object document`)
  }
  const tags = /** @type {Record<string, unknown>} */ (result.body)['dist-tags']
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new RegistryReadError('unexpected', `registry packument for ${name} has no dist-tags object`)
  }
  if (typeof tags.latest !== 'string' || !VERSION_SHAPE.test(tags.latest)) {
    throw new RegistryReadError(
      'unexpected',
      `registry packument for ${name} has an invalid latest tag ${JSON.stringify(tags.latest)}`,
    )
  }
  return /** @type {Record<string, string>} */ (tags)
}

/**
 * Pause between registry reads.
 * @param milliseconds - delay before the next attempt.
 * @returns a promise settled after the delay.
 */
function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

/**
 * Validate a polling attempt count instead of letting NaN or Infinity escape the bound.
 * @param attempts - configured maximum attempts.
 * @returns the validated attempt count.
 */
function validAttempts(attempts) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error(`verify-published: attempts must be a positive safe integer, got ${String(attempts)}`)
  }
  return attempts
}

/**
 * Sleep without extending a shared verification deadline.
 * @param sleep - injectable sleep implementation.
 * @param remainingMs - time remaining in the shared window.
 * @param retryAfterMs - registry requested backoff, if any.
 * @returns a promise settled after the bounded delay.
 */
async function boundedSleep(sleep, remainingMs, retryAfterMs = 0) {
  const duration = Math.min(remainingMs, Math.max(VERIFY_DELAY_MS, retryAfterMs))
  if (duration > 0) await sleep(duration)
}

/**
 * Wait for every exact package version to become visible on npm.
 *
 * Versions already observed are removed from the pending set and never queried
 * again. A temporary 404 is normal during npm validation; a temporary registry
 * failure is retried with a diagnostic, while an unexpected response fails closed.
 * The caller supplies one deadline so exact reads and dist-tag coherence share a
 * single bounded window.
 * @param packages - package names and exact versions expected from this release.
 * @param options - injectable registry reader, delay, clock, and logger for tests.
 * @param options.readPackage - exact-version registry reader.
 * @param options.isPublished - backwards-compatible boolean reader for small callers.
 * @param options.sleep - delay between attempts.
 * @param options.write - observation and retry logger.
 * @param options.onVisible - callback invoked once per visible package.
 * @param options.attempts - maximum registry reads per package.
 * @param options.now - monotonic-clock substitute returning milliseconds.
 * @param options.deadlineAt - shared absolute deadline.
 * @param options.windowMs - window used when deadlineAt is omitted.
 * @returns exact `name@version` strings still missing after all attempts.
 */
export async function waitForPublished(packages, {
  readPackage = readExactPackage,
  isPublished,
  sleep = delay,
  write = text => process.stdout.write(text),
  onVisible,
  attempts = VERIFY_ATTEMPTS,
  now = () => performance.now(),
  deadlineAt,
  windowMs = VERIFY_WINDOW_MS,
} = {}) {
  const reader = isPublished === undefined
    ? readPackage
    : async (name, version, readerOptions) => ({
      kind: (await Promise.resolve(isPublished(name, version, readerOptions))) ? 'visible' : 'absent',
    })
  let pending = [...packages]
  const limit = validAttempts(attempts)
  const deadline = Number.isFinite(deadlineAt) ? deadlineAt : now() + windowMs
  const transientFailures = new Map()

  for (let attempt = 1; attempt <= limit && pending.length > 0; attempt += 1) {
    const missing = []
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index]
      const remainingMs = deadline - now()
      if (remainingMs <= 0) {
        missing.push(...pending.slice(index))
        break
      }
      try {
        const observation = await reader(item.name, item.version, {
          timeoutMs: Math.min(REGISTRY_REQUEST_TIMEOUT_MS, remainingMs),
        })
        const normalized = typeof observation === 'boolean'
          ? { kind: observation ? 'visible' : 'absent' }
          : observation
        if (normalized?.kind === 'visible') {
          write(`verify-published: ${item.name}@${item.version} is on the registry\n`)
          onVisible?.(item, normalized.manifest)
          transientFailures.delete(item.name)
        } else if (normalized?.kind === 'absent') {
          missing.push(item)
          transientFailures.delete(item.name)
        } else {
          throw new RegistryReadError('unexpected', `registry lookup for ${item.name}@${item.version} returned an invalid observation`)
        }
      } catch (error) {
        if (!(error instanceof RegistryReadError) || error.kind !== 'transient') throw error
        transientFailures.set(item.name, error)
        missing.push(item)
        write(`verify-published: retrying ${item.name}@${item.version}: ${error.message}\n`)
      }
    }
    pending = missing
    if (pending.length === 0) break
    const remainingMs = deadline - now()
    if (attempt < limit && remainingMs > 0) {
      const retryAfterMs = Math.max(...pending.map(item => transientFailures.get(item.name)?.retryAfterMs ?? 0), 0)
      await boundedSleep(sleep, remainingMs, retryAfterMs)
    }
  }

  const stillUnavailable = pending
    .filter(item => transientFailures.has(item.name))
    .map(item => `${item.name}@${item.version}: ${transientFailures.get(item.name).message}`)
  if (stillUnavailable.length > 0) {
    throw new RegistryReadError(
      'transient',
      `registry remained unavailable while verifying ${stillUnavailable.join(', ')}`,
    )
  }
  return pending.map(item => `${item.name}@${item.version}`)
}

/**
 * Wait for stable packages' `latest` tags to form one coherent snapshot.
 * @param packages - stable package names and exact versions.
 * @param options - injectable tag reader, timing, and logger.
 * @returns the confirmed dist-tags by package name.
 */
async function waitForStableTags(packages, {
  readTags,
  sleep,
  write,
  attempts,
  options,
  now,
  deadlineAt,
  latestPolicy = 'exact',
}) {
  const limit = validAttempts(attempts)
  const transientFailures = new Map()
  let lastTags = new Map()

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const remainingMs = deadlineAt - now()
    if (remainingMs <= 0) break
    const nextTags = new Map()
    let mismatch = false
    for (const item of packages) {
      const remainingForRead = deadlineAt - now()
      if (remainingForRead <= 0) {
        mismatch = true
        break
      }
      try {
        const tags = await readTags(item.name, {
          ...options,
          timeoutMs: Math.min(REGISTRY_REQUEST_TIMEOUT_MS, remainingForRead),
        })
        nextTags.set(item.name, tags)
        const latestIsStable = typeof tags.latest === 'string'
          && VERSION_SHAPE.test(tags.latest)
          && !tags.latest.split('+', 1)[0].includes('-')
        const matches = latestPolicy === 'stable'
          ? latestIsStable
          : tags.latest === item.version
        if (!matches) {
          mismatch = true
          write(`verify-published: waiting for ${item.name}@latest to become ${item.version}; currently ${JSON.stringify(tags.latest)}\n`)
        }
        transientFailures.delete(item.name)
      } catch (error) {
        if (!(error instanceof RegistryReadError) || error.kind !== 'transient') throw error
        transientFailures.set(item.name, error)
        mismatch = true
        write(`verify-published: retrying ${item.name} dist-tags: ${error.message}\n`)
      }
    }
    if (!mismatch && nextTags.size === packages.length) return nextTags
    lastTags = nextTags
    const remainingAfterRead = deadlineAt - now()
    if (attempt < limit && remainingAfterRead > 0) {
      const retryAfterMs = Math.max(...transientFailures.values().map(error => error.retryAfterMs ?? 0), 0)
      await boundedSleep(sleep, remainingAfterRead, retryAfterMs)
    }
  }

  const unavailable = [...transientFailures.entries()]
    .map(([name, error]) => `${name}: ${error.message}`)
  if (unavailable.length > 0) {
    throw new RegistryReadError('transient', `registry remained unavailable while verifying dist-tags for ${unavailable.join(', ')}`)
  }
  const unresolved = packages
    .filter(item => !lastTags.has(item.name) || (latestPolicy === 'exact' && lastTags.get(item.name).latest !== item.version))
    .map(item => `${item.name}@${item.version}`)
  if (unresolved.length > 0) {
    throw new RegistryReadError('unexpected', `stable latest did not reach the release version for ${unresolved.join(', ')}`)
  }
  return lastTags
}

/**
 * Verify exact versions, stable dist-tags, and the generated workspace dependency.
 * @param packages - package names and exact versions expected from this release.
 * @param options - injectable registry access, timing, and logging.
 * @param options.readPackage - exact-version registry reader.
 * @param options.readTags - package dist-tag reader.
 * @param options.latestPolicy - `exact` for normal releases, `skip` for historical old-tag recovery.
 * @returns observations and dist-tags for the coherent release.
 */
export async function verifyRelease(packages, options = {}) {
  const expectedNames = new Set(PUBLISHED_PACKAGES.map(item => item.name))
  const actualNames = packages.map(item => item?.name)
  const versions = new Set(packages.map(item => item?.version))
  if (
    packages.length !== PUBLISHED_PACKAGES.length
    || actualNames.some(name => !expectedNames.has(name))
    || new Set(actualNames).size !== packages.length
    || versions.size !== 1
    || packages.some(item => typeof item?.version !== 'string' || !VERSION_SHAPE.test(item.version) || item.version.includes('+') || isPrereleaseVersion(item.version))
  ) {
    throw new Error('verify-published: release package set must be the two fixed packages at one stable version')
  }
  const latestPolicy = options.latestPolicy ?? 'exact'
  if (!['exact', 'stable', 'skip'].includes(latestPolicy)) {
    throw new Error(`verify-published: unknown latest policy ${String(latestPolicy)}`)
  }
  const readPackage = options.readPackage ?? readExactPackage
  const readTags = options.readTags ?? readDistTags
  const now = options.now ?? (() => performance.now())
  const deadlineAt = options.deadlineAt ?? now() + (options.windowMs ?? VERIFY_WINDOW_MS)
  const manifests = new Map()
  const missing = await waitForPublished(packages, {
    ...options,
    readPackage: async (name, version, readerOptions = {}) => readPackage(name, version, {
      ...options,
      ...readerOptions,
    }),
    now,
    deadlineAt,
    onVisible: (item, manifest) => {
      if (manifest !== undefined) manifests.set(item.name, manifest)
      options.onVisible?.(item, manifest)
    },
  })
  if (missing.length > 0) return { missing, manifests, distTags: new Map() }

  for (const item of packages) {
    if (manifests.has(item.name)) continue
    const remainingMs = deadlineAt - now()
    if (remainingMs <= 0) throw new RegistryReadError('transient', `verification deadline expired before rereading ${item.name}@${item.version}`)
    const observation = await readPackage(item.name, item.version, {
      ...options,
      timeoutMs: Math.min(REGISTRY_REQUEST_TIMEOUT_MS, remainingMs),
    })
    if (observation?.kind !== 'visible') {
      throw new RegistryReadError('unexpected', `${item.name}@${item.version} disappeared after verification`)
    }
    manifests.set(item.name, observation.manifest)
  }

  const renderer = packages.find(item => item.name === '@dshline/renderer')
  const dshline = packages.find(item => item.name === '@dshline/dshline')
  if (renderer === undefined || dshline === undefined) {
    throw new Error('verify-published: release must contain renderer and dshline packages')
  }

  const dshlineManifest = manifests.get(dshline.name)
  const rendererDependency = dshlineManifest?.dependencies?.['@dshline/renderer']
  const expectedRendererDependency = `^${renderer.version}`
  if (rendererDependency !== expectedRendererDependency) {
    throw new Error(
      `verify-published: ${dshline.name}@${dshline.version} refers to `
      + `${JSON.stringify(rendererDependency)} instead of ${expectedRendererDependency}`,
    )
  }

  const stable = packages.every(item => !item.version.split('+', 1)[0].includes('-'))
  const distTags = stable && latestPolicy !== 'skip'
    ? await waitForStableTags(packages, {
      readTags,
      sleep: options.sleep ?? delay,
      write: options.write ?? (text => process.stdout.write(text)),
      attempts: options.attempts ?? VERIFY_ATTEMPTS,
      options,
      now,
      deadlineAt,
      latestPolicy,
    })
    : new Map()
  return { missing, manifests, distTags }
}

/**
 * Read the release tree's package identities once before polling npm.
 * @param root - repository root whose package manifests should be read.
 * @returns package names and exact versions in publish order.
 */
export function readReleasePackages(root = process.env.RELEASE_ROOT ?? process.cwd()) {
  return PUBLISHED_PACKAGES.map(definition => {
    const manifest = JSON.parse(readFileSync(join(resolve(root), definition.directory, 'package.json'), 'utf8'))
    if (manifest.name !== definition.name) {
      throw new Error(`verify-published: ${definition.directory} must be ${definition.name}, got ${String(manifest.name)}`)
    }
    if (
      typeof manifest.version !== 'string'
      || !VERSION_SHAPE.test(manifest.version)
      || manifest.version.includes('+')
      || isPrereleaseVersion(manifest.version)
    ) {
      throw new Error(`verify-published: ${definition.name} has invalid publish version ${JSON.stringify(manifest.version)}`)
    }
    if (manifest.publishConfig !== undefined && (manifest.publishConfig === null || typeof manifest.publishConfig !== 'object' || Array.isArray(manifest.publishConfig))) {
      throw new Error(`verify-published: ${definition.name} has an invalid publishConfig`)
    }
    if (manifest.publishConfig?.name !== undefined && manifest.publishConfig.name !== definition.name) {
      throw new Error(`verify-published: ${definition.name} has a mismatched publishConfig.name`)
    }
    if (manifest.publishConfig?.registry !== undefined && manifest.publishConfig.registry !== NPM_REGISTRY) {
      throw new Error(`verify-published: ${definition.name} overrides the trusted registry`)
    }
    if (manifest.publishConfig?.tag !== undefined && manifest.publishConfig.tag !== 'latest') {
      throw new Error(`verify-published: ${definition.name} overrides the stable latest tag`)
    }
    if (manifest.publishConfig?.provenance === false) {
      throw new Error(`verify-published: ${definition.name} disables provenance`)
    }
    if (manifest.publishConfig?.directory !== undefined || manifest.publishConfig?.linkDirectory !== undefined) {
      throw new Error(`verify-published: ${definition.name} overrides the packed directory`)
    }
    return { name: definition.name, version: manifest.version }
  })
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    const packages = readReleasePackages()
    const result = await verifyRelease(packages, {
      latestPolicy: process.env.RELEASE_RECOVERY === 'true' ? 'skip' : 'exact',
    })
    if (result.missing.length > 0) {
      process.stderr.write(
        `verify-published: the registry did not serve ${result.missing.join(', ')} within the bounded verification window.\n`
        + 'npm accepted publication is not the same moment npm serves it publicly.\n'
        + 'Rerun registry verification after a delay; do not publish again or create another tag.\n',
      )
      process.exit(1)
    }
    process.stdout.write('verify-published: both packages and the stable release generation are coherent\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`verify-published: ${message}\n`)
    process.exit(1)
  }
}
