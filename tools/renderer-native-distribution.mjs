import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rendererNativeInputsDigest } from './renderer-native-inputs.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const native = join(root, 'packages/renderer/native')
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']

export async function validateNativeDistribution({ nativeDirectory, commit, inputDigest, mode }) {
  if (!['write', 'check'].includes(mode)) throw new Error('native distribution mode must be write or check')
  const files = {}
  for (const platform of platforms) {
    const bytes = await readFile(join(nativeDirectory, `${platform}.node`))
    const binarySha256 = createHash('sha256').update(bytes).digest('hex')
    const proof = JSON.parse(await readFile(join(nativeDirectory, `${platform}.provenance.json`), 'utf8'))
    if (proof.schema !== 1 || proof.platform !== platform || proof.commit !== commit || proof.inputDigest !== inputDigest || proof.cleanInputs !== true || proof.binarySha256 !== binarySha256) throw new Error(`${platform} artifact is stale, dirty-built, or lacks matching source/build-input provenance`)
    files[platform] = { binarySha256, inputDigest }
  }
  const expected = { schema: 1, commit, files }
  const manifestPath = join(nativeDirectory, 'manifest.json')
  if (mode === 'write') await writeFile(manifestPath, `${JSON.stringify(expected, null, 2)}\n`)
  else {
    const actual = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('native distribution is incomplete, stale for this source commit, or has modified artifacts; rebuild the six-platform distribution')
  }
  return expected
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2]
  if (process.argv.length !== 3 || !['--write', '--check'].includes(arg)) throw new Error('usage: node tools/renderer-native-distribution.mjs --write|--check')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const inputDigest = await rendererNativeInputsDigest()
  await validateNativeDistribution({ nativeDirectory: native, commit, inputDigest, mode: arg === '--write' ? 'write' : 'check' })
}
