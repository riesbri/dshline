/** Private scratch ownership shared by all research entry points. */
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Create a fresh private study, or verify an explicitly named existing one.
 * @param {string | undefined} argument - Requested study directory.
 * @param {{create?: boolean}} options - Whether to create a new study.
 * @returns {string} Private directory, never a predictable shared default.
 */
export function studyDirectory(argument, { create = false } = {}) {
  if (!create && !argument) throw Error('Pass the private directory created by prepare.mjs')
  let directory
  if (create && !argument) directory = mkdtempSync(join(tmpdir(), 'dshline-performance-'))
  else {
    directory = resolve(argument)
    if (create) mkdirSync(directory, { mode: 0o700 }) // EEXIST is intentional; never adopt someone else's path.
  }
  const descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isDirectory()) throw Error('Study path is not a directory')
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) throw Error('Study directory must be owned by this user with mode 0700')
  } finally { closeSync(descriptor) }
  return directory
}
