import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
const MAX_ADDON_BYTES = 64 * 1024 * 1024
const [archive, mode] = process.argv.slice(2)
if (!archive || process.argv.length > 4 || (mode && mode !== '--host-only')) throw new Error('usage: node tools/check-renderer-native-package.mjs <renderer.tgz> [--host-only]')
const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
if (list.status !== 0) throw new Error('Could not list packed renderer archive')
const entries = new Set(list.stdout.trim().split('\n'))
const required = ['package/native/index.d.ts', 'package/native/THIRD_PARTY_NOTICES.txt', 'package/native/THIRD_PARTY_NOTICES.json', 'package/native/RUST_STANDARD_LIBRARY_NOTICES.html']
const platforms = mode === '--host-only' ? [`${process.platform}-${process.arch}`] : ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']
for (const platform of platforms) required.push(`package/native/${platform}.node`)
if (!mode) required.push('package/native/manifest.json')
for (const path of required) if (!entries.has(path)) throw new Error(`Packed renderer is missing ${path}`)
const manifest = spawnSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' })
if (manifest.status !== 0) throw new Error('Packed renderer package.json is missing')
const pkg = JSON.parse(manifest.stdout)
if (!pkg.files?.includes('native') || Object.keys(pkg.dependencies ?? {}).length !== 0) throw new Error('Packed renderer must include native artifacts without runtime npm dependencies')
if (!mode) {
  const distribution = spawnSync('tar', ['-xOzf', archive, 'package/native/manifest.json'], { encoding: 'utf8' })
  if (distribution.status !== 0) throw new Error('Packed renderer native manifest is missing')
  const manifestValue = JSON.parse(distribution.stdout)
  if (manifestValue.schema !== 1 || !manifestValue.commit || Object.keys(manifestValue.files ?? {}).sort().join(',') !== ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'].join(',')) throw new Error('Packed renderer native manifest is incomplete')
  for (const platform of platforms) {
    const addon = spawnSync('tar', ['-xOzf', archive, `package/native/${platform}.node`], { maxBuffer: MAX_ADDON_BYTES })
    const proof = spawnSync('tar', ['-xOzf', archive, `package/native/${platform}.provenance.json`], { encoding: 'utf8' })
    if (addon.status !== 0 || proof.status !== 0) throw new Error(`Packed renderer is missing ${platform} bytes or provenance`)
    const evidence = JSON.parse(proof.stdout)
    const binarySha256 = createHash('sha256').update(addon.stdout).digest('hex')
    if (evidence.cleanInputs !== true || evidence.commit !== manifestValue.commit || evidence.binarySha256 !== binarySha256 || manifestValue.files[platform].binarySha256 !== binarySha256 || evidence.inputDigest !== manifestValue.files[platform].inputDigest) throw new Error(`Packed renderer ${platform} payload does not match its validated manifest`)
  }
}
process.stdout.write(`Packed renderer includes ${platforms.length} native addon(s), generated types, and license notices.\n`)
