import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, copyFile, writeFile } from 'node:fs/promises'
import { spawnSync, execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rendererNativeInputsDigest } from './renderer-native-inputs.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const required = process.argv[2] === '--required'
if (process.argv.length > (required ? 3 : 2)) throw new Error('usage: node tools/build-renderer-native.mjs [--required]')
const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
if (cargo.error?.code === 'ENOENT') {
  if (required) { console.error('Rust build required, but cargo is not installed/on PATH.'); process.exit(1) }
  console.log('Rust toolchain unavailable; skipping optional native renderer build (TypeScript renderer remains available).')
  process.exit(0)
}
if (cargo.status !== 0) { console.error(cargo.stderr); process.exit(cargo.status ?? 1) }

const platform = `${process.platform}-${process.arch}`
const suffix = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'
if (!['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'].includes(platform)) throw new Error(`Unsupported native build target: ${platform}`)
const crate = join(root, 'crates/dshline-renderer-node')
const target = join(crate, 'target')
const metadata = join(target, `napi-type-def-${process.pid}`)
const native = join(root, 'packages/renderer/native')
const inputDigest = await rendererNativeInputsDigest()
const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'crates/dshline-renderer/Cargo.toml', 'crates/dshline-renderer/Cargo.lock', 'crates/dshline-renderer/src', 'crates/dshline-renderer/tests', 'crates/dshline-renderer-node/Cargo.toml', 'crates/dshline-renderer-node/Cargo.lock', 'crates/dshline-renderer-node/build.rs', 'crates/dshline-renderer-node/src', 'packages/renderer/src', 'packages/renderer/tsconfig.json', 'packages/renderer/native/index.d.ts', 'packages/renderer/native/THIRD_PARTY_NOTICES.txt', 'packages/renderer/native/THIRD_PARTY_NOTICES.json', 'packages/renderer/native/RUST_STANDARD_LIBRARY_NOTICES.html', 'tsconfig.base.json', 'tests/fixtures/renderer-parity', 'tools/build-renderer-native.mjs', 'tools/renderer-native-types.mjs', 'tools/renderer-native-inputs.mjs', 'tools/renderer-native-distribution.mjs', 'tools/check-renderer-native-licenses.mjs', 'tools/check-renderer-native-package.mjs', 'tools/renderer-native.spec.mjs', 'tools/renderer-native-pipeline.spec.mjs', 'tools/renderer-forced-smoke.mjs', 'tools/renderer-napi-host.mjs', 'tools/renderer-parity.mjs', 'tools/renderer-capture.mjs', 'tools/renderer-schema.mjs', 'tools/renderer-parity-corpus.mjs', 'tools/renderer-identity.mjs'], { cwd: root, encoding: 'utf8' })
if (dirty.status !== 0) throw new Error('Unable to inspect native build inputs with git status')
await mkdir(metadata, { recursive: true })
const result = spawnSync('cargo', ['build', '--locked', '--manifest-path', join(crate, 'Cargo.toml'), '--release'], { cwd: root, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target, NAPI_TYPE_DEF_TMP_FOLDER: metadata } })
if (result.status !== 0) process.exit(result.status ?? 1)
const typeFile = join(metadata, 'dshline-renderer-node')
const generatedTypes = join(metadata, 'index.d.ts')
const types = spawnSync(process.execPath, [join(root, 'tools/renderer-native-types.mjs'), typeFile, generatedTypes], { cwd: root, stdio: 'inherit' })
if (types.status !== 0) process.exit(types.status ?? 1)
const committedTypes = execFileSync('git', ['show', 'HEAD:packages/renderer/native/index.d.ts'], { cwd: root })
if (!committedTypes.equals(await readFile(generatedTypes))) throw new Error('Generated native declarations differ; review and commit packages/renderer/native/index.d.ts')
const afterInputDigest = await rendererNativeInputsDigest()
if (afterInputDigest !== inputDigest) throw new Error('Native build inputs changed while building; discard this addon and rebuild from a stable source tree')
const prefix = process.platform === 'win32' ? '' : 'lib'
const binary = join(target, 'release', `${prefix}dshline_renderer_node.${suffix}`)
const destination = join(native, `${platform}.node`)
await mkdir(native, { recursive: true })
await copyFile(binary, destination)
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const hash = createHash('sha256').update(await readFile(destination)).digest('hex')
await writeFile(join(native, `${platform}.provenance.json`), `${JSON.stringify({ schema: 1, platform, commit, inputDigest, cleanInputs: dirty.stdout === '', binarySha256: hash }, null, 2)}\n`)
await rm(metadata, { recursive: true, force: true })
console.log(`Built ${platform} native renderer addon.`)
