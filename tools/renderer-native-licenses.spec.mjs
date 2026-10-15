import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
const root = fileURLToPath(new URL('../', import.meta.url))
it('rejects changed shipped notices and a changed Cargo graph rather than silently reblessing them', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'renderer-license-integrity-'))
  const files = ['tools/check-renderer-native-licenses.mjs', 'crates/dshline-renderer-node/Cargo.lock', 'packages/renderer/native/THIRD_PARTY_NOTICES.txt', 'packages/renderer/native/THIRD_PARTY_NOTICES.json', 'packages/renderer/native/RUST_STANDARD_LIBRARY_NOTICES.html']
  try {
    for (const file of files) { mkdirSync(dirname(join(scratch, file)), { recursive: true }); cpSync(join(root, file), join(scratch, file)) }
    const run = () => execFileSync(process.execPath, ['tools/check-renderer-native-licenses.mjs'], { cwd: scratch, encoding: 'utf8', stdio: 'pipe' })
    expect(run()).toContain('38 locked packages')
    const notices = join(scratch, files[2])
    const original = readFileSync(notices)
    writeFileSync(notices, 'lost copyright notice')
    expect(run).toThrow()
    writeFileSync(notices, original)
    const lockPath = join(scratch, files[1])
    const changed = readFileSync(lockPath, 'utf8') + '\n[[package]]\nname = "new-unreviewed-crate"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n'
    writeFileSync(lockPath, changed)
    expect(run).toThrow()
    // Even updating only the lock hash must not bless a missing attribution.
    const catalogPath = join(scratch, files[3])
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
    catalog.cargoLockSha256 = createHash('sha256').update(changed).digest('hex')
    writeFileSync(catalogPath, JSON.stringify(catalog))
    expect(run).toThrow()
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
