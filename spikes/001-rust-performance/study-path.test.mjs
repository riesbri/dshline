import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { studyDirectory } from './study-path.mjs'
test('private study paths reject missing, existing, shared and symlink paths', t => {
  const parent = mkdtempSync(join(tmpdir(), 'study-path-test-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  assert.throws(() => studyDirectory(undefined), /Pass the private directory/)
  const directory = studyDirectory(join(parent, 'study'), { create: true })
  assert.equal(studyDirectory(directory), directory)
  assert.throws(() => studyDirectory(directory, { create: true }), /EEXIST/)
  if (process.platform !== 'win32') {
    const shared = join(parent, 'shared')
    mkdirSync(shared)
    chmodSync(shared, 0o755)
    assert.throws(() => studyDirectory(shared), /mode 0700/)
    const alias = join(parent, 'alias')
    symlinkSync(directory, alias)
    assert.throws(() => studyDirectory(alias))
  }
})
