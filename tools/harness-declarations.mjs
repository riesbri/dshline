/**
 * Declaration targets advertised by a linked Harness package.
 *
 * A package can expose declarations only through typed subpath exports. The
 * source-link check therefore validates the targets the manifest advertises,
 * rather than requiring a root `types` field or a root `.` export.
 */

import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Collect string `types` targets from an export condition tree.
 * @param value - one export entry, condition object, or condition array.
 * @param targets - the target set to populate.
 */
function collectExportTypes(value, targets) {
  if (typeof value === 'string' || value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const entry of value) collectExportTypes(entry, targets)
    return
  }
  if (typeof value !== 'object') return
  if (typeof value.types === 'string' && value.types !== '') targets.add(value.types)
  for (const entry of Object.values(value)) {
    if (entry !== null && typeof entry === 'object') collectExportTypes(entry, targets)
  }
}

/**
 * Read and validate the declaration targets advertised by one package.
 * @param target - the package directory.
 * @returns `missing` for no package directory/manifest, `none` for no
 *   advertised declarations, `unbuilt` for advertised targets not yet emitted,
 *   `invalid` for an unreadable manifest, or `built` for all targets present.
 */
export async function declarationState(target) {
  let manifestText
  try {
    manifestText = await readFile(join(target, 'package.json'), 'utf8')
  } catch {
    return { kind: 'missing' }
  }
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) }
  }
  const targets = new Set()
  if (typeof manifest.types === 'string' && manifest.types !== '') targets.add(manifest.types)
  if (manifest.exports !== null && typeof manifest.exports === 'object') {
    collectExportTypes(manifest.exports, targets)
  }
  if (targets.size === 0) return { kind: 'none' }
  const missing = []
  for (const declaration of targets) {
    const path = resolve(target, declaration)
    try {
      await access(path)
    } catch {
      missing.push(path)
    }
  }
  return missing.length === 0 ? { kind: 'built' } : { kind: 'unbuilt', missing }
}
