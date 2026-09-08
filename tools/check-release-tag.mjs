/**
 * Refuse a release whose tag disagrees with what would be published.
 *
 * A tag is a human gesture and the version in a manifest is a separate one, so
 * they drift: pushing `v0.1.1` from a tree still carrying `0.1.0` would publish
 * 0.1.0 under a tag that claims otherwise, and a published version cannot be
 * replaced. Provenance makes this worse rather than better — the attestation
 * would faithfully bind the wrong version to a real commit.
 *
 * Reads the tag from the environment rather than from an interpolated command, so
 * a tag name can never become shell.
 * @module tools/check-release-tag
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { NPM_REGISTRY, PUBLISHED_PACKAGES } from './verify-published.mjs'
import { VERSION_SHAPE, versionFromReleaseTag } from './release-version.mjs'

export { versionFromReleaseTag }

/**
 * Root of the tree being checked. Recovery uses the workflow checkout plus an
 * exact-tag worktree, so new validation code can inspect the immutable tag
 * without pretending that the tag already contains this recovery workflow.
 */
const root = resolve(process.env.RELEASE_ROOT ?? process.cwd())

/**
 * A version the SOURCE embeds rather than reads from its manifest.
 *
 * The runner prints this in its opening banner, so a release that bumped both
 * manifests and missed it would publish a correctly tagged package that identifies
 * itself as an older one. Checked here because it is a second home for the same
 * fact, and this is the gate that makes the duplication safe.
 */
const EMBEDDED = {
  path: 'packages/dshline/src/index.ts',
  pattern: /^const VERSION = '(?<version>[^']+)'$/mgu,
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const tag = process.env.RELEASE_TAG ?? ''
  let expected
  try {
    expected = versionFromReleaseTag(tag)
  } catch (error) {
    process.stderr.write(`check-release-tag: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }

  const mismatched = []
  for (const definition of PUBLISHED_PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(root, definition.directory, 'package.json'), 'utf8'))
    if (manifest.name !== definition.name) mismatched.push(`${definition.directory} is ${manifest.name}, expected ${definition.name}`)
    if (typeof manifest.version !== 'string' || !VERSION_SHAPE.test(manifest.version) || manifest.version !== expected) {
      mismatched.push(`${definition.name} is ${manifest.version}`)
    }
    if (manifest.publishConfig !== undefined && (manifest.publishConfig === null || typeof manifest.publishConfig !== 'object' || Array.isArray(manifest.publishConfig))) {
      mismatched.push(`${definition.name} has an invalid publishConfig`)
    }
    if (manifest.publishConfig?.name !== undefined && manifest.publishConfig.name !== definition.name) {
      mismatched.push(`${definition.name} has mismatched publishConfig.name`)
    }
    if (manifest.publishConfig?.registry !== undefined && manifest.publishConfig.registry !== NPM_REGISTRY) {
      mismatched.push(`${definition.name} overrides the npm registry`)
    }
    if (manifest.publishConfig?.tag !== undefined && manifest.publishConfig.tag !== 'latest') {
      mismatched.push(`${definition.name} overrides the latest dist-tag`)
    }
    if (manifest.publishConfig?.provenance === false) {
      mismatched.push(`${definition.name} disables provenance`)
    }
    if (manifest.publishConfig?.directory !== undefined || manifest.publishConfig?.linkDirectory !== undefined) {
      mismatched.push(`${definition.name} overrides the packed directory`)
    }
  }

  const source = readFileSync(join(root, EMBEDDED.path), 'utf8')
  const embeddedMatches = [...source.matchAll(EMBEDDED.pattern)]
  if (embeddedMatches.length !== 1 || embeddedMatches[0]?.groups?.version === undefined) {
    process.stderr.write(`check-release-tag: expected exactly one VERSION constant in ${EMBEDDED.path}\n`)
    process.exit(2)
  }
  const embedded = embeddedMatches[0]
  if (embedded.groups.version !== expected) {
    mismatched.push(`the banner in ${EMBEDDED.path} says ${embedded.groups.version}`)
  }

  if (mismatched.length > 0) {
    process.stderr.write(
      `check-release-tag: tag ${tag} expects version ${expected}, but ${mismatched.join(', ')}.\n`
      + 'Bump the manifests and re-tag; a published version cannot be taken back.\n',
    )
    process.exit(1)
  }

  process.stdout.write(`check-release-tag: ${tag} matches ${expected} in ${String(PUBLISHED_PACKAGES.length)} packages\n`)
}
