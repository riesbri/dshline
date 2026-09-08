/**
 * Publish each validated package artifact without repeating an accepted immutable version.
 *
 * The registry preflight is deliberately per package because a workspace publish
 * is not atomic. A visible exact version is skipped, an absent version is sent to
 * npm once, and the registry-verification job remains the authority for an
 * accepted version that npm has not exposed yet.
 *
 * The OIDC job publishes prebuilt tarballs with `--ignore-scripts`, not workspace
 * directories. That keeps package prepare/prepublish code in the no-identity
 * preflight and binds the publish target to an artifact whose name and version
 * are checked before the irreversible command.
 *
 * @module tools/publish-packages
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import {
  NPM_REGISTRY,
  PUBLISHED_PACKAGES,
  readExactPackage,
} from './verify-published.mjs'
import { isPrereleaseVersion, VERSION_SHAPE } from './release-version.mjs'

/** Arguments shared by every individual trusted publication. */
export const PUBLISH_ARGUMENTS = [
  '--access', 'public',
  '--provenance',
  '--no-git-checks',
  '--ignore-scripts',
  '--registry', NPM_REGISTRY,
  '--tag', 'latest',
  '--dry-run=false',
  '--config.minimum-release-age=0',
]

/** A hung npm operation is ambiguous and must fail rather than be retried. */
export const PUBLISH_TIMEOUT_MS = 120_000

/** Exact registry wording npm uses for an accepted staged version. */
function stagedMessage(version) {
  return `Cannot publish over previously staged version "${version}"`
}

/**
 * Classify one publish process result without turning arbitrary failures green.
 * @param result - process result with captured output.
 * @param result.status - process exit status.
 * @param result.stdout - standard output.
 * @param result.stderr - standard error.
 * @param packageName - package being published.
 * @param version - immutable version being published.
 * @returns the safe publication outcome.
 */
export function classifyPublishResult(result, packageName, version) {
  if (result.status === 0) return { kind: 'published' }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const conflictLines = output.split(/\r?\n/u).filter(line => line.includes('[E409] 409 Conflict'))
  const expectedLine = conflictLines.length === 1 ? conflictLines[0].match(
    /\[E409\] 409 Conflict - PUT (\S+) - (.+)$/u,
  ) : null
  let exactStagedConflict = false
  if (expectedLine !== null) {
    try {
      const endpoint = new URL(expectedLine[1])
      const message = expectedLine[2].trim().replace(/\.$/u, '')
      exactStagedConflict = endpoint.origin === NPM_REGISTRY
        && decodeURIComponent(endpoint.pathname) === `/${packageName}`
        && message === stagedMessage(version)
    } catch {
      exactStagedConflict = false
    }
  }
  const mixedFatalOutput = /\bE(?:401|403|409|5\d\d)\b|authentication|permission denied|forbidden/iu.test(
    output.replace(conflictLines[0] ?? '', ''),
  )
  if (result.status === 1 && exactStagedConflict && !mixedFatalOutput) {
    return { kind: 'accepted-staged', packageName, version }
  }
  return {
    kind: 'failed',
    packageName,
    version,
    status: result.status,
  }
}

/**
 * Read and validate a workspace package identity before registry lookup.
 * @param definition - fixed directory/name/artifact identity.
 * @returns package name, version, directory, and artifact filename.
 */
function validatePublishConfig(manifest, item, source) {
  const publishConfig = manifest.publishConfig
  if (publishConfig !== undefined && (publishConfig === null || typeof publishConfig !== 'object' || Array.isArray(publishConfig))) {
    throw new Error(`publish-packages: ${source} has an invalid publishConfig`)
  }
  if (publishConfig?.name !== undefined && publishConfig.name !== item.name) {
    throw new Error(`publish-packages: ${source} has a mismatched publishConfig.name`)
  }
  if (publishConfig?.registry !== undefined && publishConfig.registry !== NPM_REGISTRY) {
    throw new Error(`publish-packages: ${source} overrides the trusted registry`)
  }
  if (publishConfig?.tag !== undefined && publishConfig.tag !== 'latest') {
    throw new Error(`publish-packages: ${source} overrides the stable latest tag`)
  }
  if (publishConfig?.provenance === false) {
    throw new Error(`publish-packages: ${source} disables provenance`)
  }
  if (publishConfig?.directory !== undefined || publishConfig?.linkDirectory !== undefined) {
    throw new Error(`publish-packages: ${source} overrides the packed directory`)
  }
}

/** @param definition - fixed package identity. @returns validated package item. */
function readPackage(definition) {
  const manifest = JSON.parse(readFileSync(resolve(definition.directory, 'package.json'), 'utf8'))
  if (manifest.name !== definition.name) {
    throw new Error(`publish-packages: ${definition.directory} must be ${definition.name}, got ${String(manifest.name)}`)
  }
  if (
    typeof manifest.version !== 'string'
    || !VERSION_SHAPE.test(manifest.version)
    || manifest.version.includes('+')
    || isPrereleaseVersion(manifest.version)
  ) {
    throw new Error(`publish-packages: ${definition.name} has invalid publish version ${JSON.stringify(manifest.version)}`)
  }
  validatePublishConfig(manifest, definition, definition.directory)
  return {
    ...definition,
    version: manifest.version,
    dependencies: manifest.dependencies,
    publishConfig: manifest.publishConfig,
  }
}

/**
 * Validate the identity embedded in a prebuilt npm tarball.
 * @param item - expected package identity.
 * @param artifact - tarball path.
 * @returns nothing when the tarball manifest is exact.
 */
function validateArtifact(item, artifact) {
  let manifest
  try {
    manifest = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    }))
  } catch (error) {
    throw new Error(`publish-packages: could not inspect ${artifact}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`publish-packages: artifact ${artifact} has no object package manifest`)
  }
  if (manifest.name !== item.name || manifest.version !== item.version) {
    throw new Error(
      `publish-packages: artifact ${artifact} is ${String(manifest.name)}@${String(manifest.version)}, `
      + `expected ${item.name}@${item.version}`,
    )
  }
  if (item.name === '@dshline/dshline' && manifest.dependencies?.['@dshline/renderer'] !== `^${item.rendererVersion}`) {
    throw new Error(`publish-packages: artifact ${artifact} has the wrong renderer dependency`)
  }
  validatePublishConfig(manifest, item, artifact)
}

/**
 * Publish one package artifact with captured output and status.
 * @param item - package identity.
 * @param target - workspace directory or prebuilt tarball.
 * @returns captured process output and status.
 */
function safeLog(text) {
  return String(text).replaceAll('::', '%3A%3A')
}

function runPublish(item, target) {
  const result = spawnSync('pnpm', ['publish', target, ...PUBLISH_ARGUMENTS], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: PUBLISH_TIMEOUT_MS,
    killSignal: 'SIGTERM',
  })
  if (result.stdout !== undefined) process.stdout.write(safeLog(result.stdout))
  if (result.stderr !== undefined) process.stderr.write(safeLog(result.stderr))
  if (result.error !== undefined) {
    return {
      status: null,
      stdout: result.stdout ?? '',
      stderr: `${result.stderr ?? ''}\n${result.error.message}`,
    }
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * Normalize the registry reader for tests that use a boolean answer.
 * @param value - exact registry observation.
 * @returns a visible/absent observation.
 */
function normalizeObservation(value, item, allowLegacyBoolean = false) {
  if (typeof value === 'boolean') {
    if (!allowLegacyBoolean) throw new Error(`publish-packages: registry returned a legacy boolean for ${item.name}@${item.version}`)
    return { kind: value ? 'visible' : 'absent' }
  }
  if (value?.kind === 'visible') {
    if (
      value.manifest !== undefined
      && (value.manifest === null || typeof value.manifest !== 'object'
        || value.manifest.name !== item.name || value.manifest.version !== item.version)
    ) {
      throw new Error(`publish-packages: registry returned the wrong manifest for ${item.name}@${item.version}`)
    }
    return value
  }
  if (value?.kind === 'absent') return value
  return { kind: 'unexpected' }
}

/**
 * Publish every workspace package once, in dependency order.
 * @param options - injectable registry reader, publisher, and logger.
 * @param options.readManifest - workspace manifest reader for tests.
 * @param options.readPublished - exact-version registry reader.
 * @param options.runPublish - publication process.
 * @param options.write - status logger.
 * @param options.artifactRoot - downloaded prebuilt tarball directory.
 * @param options.allowSourceDirectory - test-only escape hatch; CLI never enables it.
 * @returns one outcome per package.
 */
export async function publishWorkspacePackages({
  readManifest = readPackage,
  readPublished,
  readPackage: legacyReadPublished,
  runPublish: publish = runPublish,
  write = text => process.stdout.write(text),
  artifactRoot = process.env.PUBLISH_ARTIFACT_ROOT,
  allowSourceDirectory = false,
} = {}) {
  const usingLegacyReader = readPublished === undefined && legacyReadPublished !== undefined
  const registryReader = readPublished ?? legacyReadPublished ?? readExactPackage
  if (allowSourceDirectory && process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
    throw new Error('publish-packages: source-directory publishing is test-only')
  }
  if (!allowSourceDirectory && (typeof artifactRoot !== 'string' || artifactRoot === '' || !isAbsolute(artifactRoot))) {
    throw new Error('publish-packages: PUBLISH_ARTIFACT_ROOT must be a non-empty absolute directory')
  }
  const outcomes = []
  const rawManifests = PUBLISHED_PACKAGES.map(definition => readManifest(definition))
  const manifests = rawManifests.map((manifest, index) => {
    const definition = PUBLISHED_PACKAGES[index]
    if (
      manifest === null
      || typeof manifest !== 'object'
      || manifest.name !== definition.name
      || manifest.directory !== definition.directory
      || manifest.artifact !== definition.artifact
    ) {
      throw new Error(`publish-packages: manifest identity for ${definition.name} is not the fixed release identity`)
    }
    const item = { ...definition, ...manifest }
    if (typeof item.version !== 'string' || !VERSION_SHAPE.test(item.version) || item.version.includes('+') || isPrereleaseVersion(item.version)) {
      throw new Error(`publish-packages: ${item.name} has invalid stable publish version ${JSON.stringify(item.version)}`)
    }
    validatePublishConfig(item, definition, definition.directory)
    return item
  })
  const rendererVersion = manifests.find(item => item.name === '@dshline/renderer')?.version
  if (rendererVersion === undefined || manifests.some(item => item.version !== rendererVersion)) {
    throw new Error('publish-packages: both packages must share one stable version')
  }
  for (const item of manifests) item.rendererVersion = rendererVersion

  const decisions = []
  for (const item of manifests) {
    const existing = normalizeObservation(
      await registryReader(item.name, item.version, { registry: NPM_REGISTRY }),
      item,
      usingLegacyReader,
    )
    if (existing.kind !== 'visible' && existing.kind !== 'absent') {
      throw new Error(`publish-packages: registry did not provide a safe publish decision for ${item.name}@${item.version}`)
    }
    decisions.push({ item, existing })
  }
  const needsArtifacts = decisions.some(({ existing }) => existing.kind === 'absent')
  if (needsArtifacts && !allowSourceDirectory) {
    for (const { item, existing } of decisions) {
      if (existing.kind === 'absent') validateArtifact(item, resolve(artifactRoot, item.artifact))
    }
  }

  for (const { item, existing } of decisions) {
    if (existing.kind === 'visible') {
      write(`publish-packages: skipping ${item.name}@${item.version}; exact version is already visible\n`)
      outcomes.push({ ...item, kind: 'already-visible' })
      continue
    }
    const target = allowSourceDirectory ? item.directory : resolve(artifactRoot, item.artifact)
    const result = publish(item, target)
    const outcome = classifyPublishResult(result, item.name, item.version)
    if (outcome.kind === 'failed') {
      throw new Error(`publish-packages: publishing ${item.name}@${item.version} failed with exit ${String(outcome.status)}`)
    }
    if (outcome.kind === 'accepted-staged') {
      write(
        `publish-packages: npm accepted ${item.name}@${item.version} in its staged/validation state; `
        + 'registry verification remains authoritative\n',
      )
    } else {
      write(`publish-packages: npm accepted ${item.name}@${item.version}\n`)
    }
    outcomes.push({ ...item, kind: outcome.kind })
  }
  return outcomes
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    await publishWorkspacePackages()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`publish-packages: ${message}\n`)
    process.exit(1)
  }
}
