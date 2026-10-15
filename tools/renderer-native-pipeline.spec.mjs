import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalRelativePath } from './renderer-native-inputs.mjs'
import { validateNativeDistribution } from './renderer-native-distribution.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']
const scratchPaths = new Set()
async function scratch() {
  const path = await mkdtemp(join(tmpdir(), 'renderer-native-pipeline-'))
  scratchPaths.add(path)
  return path
}
afterEach(async () => {
  await Promise.all([...scratchPaths].map(path => rm(path, { recursive: true, force: true })))
  scratchPaths.clear()
})
async function distribution(directory, { commit = 'commit-a', inputDigest = 'digest-a', cleanInputs = true } = {}) {
  await mkdir(directory, { recursive: true })
  for (const platform of platforms) {
    const bytes = Buffer.from(`synthetic fixture bytes: ${platform}`)
    await writeFile(join(directory, `${platform}.node`), bytes)
    await writeFile(join(directory, `${platform}.provenance.json`), JSON.stringify({
      schema: 1,
      platform,
      commit,
      inputDigest,
      cleanInputs,
      binarySha256: createHash('sha256').update(bytes).digest('hex'),
    }))
  }
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

describe('optional native build boundaries', () => {
  it('skips successfully without Cargo by default and fails when required', async () => {
    const path = await scratch()
    const script = join(root, 'tools/build-renderer-native.mjs')
    for (const [args, expected] of [[[], 0], [['--required'], 1]]) {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: path } })
      expect(result.status).toBe(expected)
      expect(result.stdout + result.stderr).toContain(args.length ? 'cargo is not installed/on PATH' : 'Rust toolchain unavailable; skipping optional native renderer build')
    }
  })
})

describe('native distribution provenance gate', () => {
  const subject = { commit: 'commit-a', inputDigest: 'digest-a' }

  it('requires all six artifacts and provenance records', async () => {
    await expect(validateNativeDistribution({ nativeDirectory: await scratch(), ...subject, mode: 'write' })).rejects.toThrow()
  })

  it('writes and checks a complete same-commit manifest', async () => {
    const directory = await scratch()
    await distribution(directory, subject)
    const manifest = await validateNativeDistribution({ nativeDirectory: directory, ...subject, mode: 'write' })
    expect(Object.keys(manifest.files)).toEqual(platforms)
    await expect(validateNativeDistribution({ nativeDirectory: directory, ...subject, mode: 'check' })).resolves.toEqual(manifest)
  })

  it('rejects stale commits, changed inputs, mutated binaries, and dirty builds', async () => {
    for (const proof of [
      { ...subject, commit: 'old-commit' },
      { ...subject, inputDigest: 'old-input' },
      { ...subject, cleanInputs: false },
    ]) {
      const directory = await scratch()
      await distribution(directory, { ...subject, ...(proof.cleanInputs === false ? { cleanInputs: false } : {}) })
      if (proof.commit !== undefined || proof.inputDigest !== undefined) {
        const sidecar = join(directory, 'linux-x64.provenance.json')
        const value = JSON.parse(await readFile(sidecar, 'utf8'))
        Object.assign(value, proof)
        await writeFile(sidecar, JSON.stringify(value))
      }
      await expect(validateNativeDistribution({ nativeDirectory: directory, ...subject, mode: 'write' })).rejects.toThrow(/stale|dirty-built/u)
    }
    const directory = await scratch()
    await distribution(directory, subject)
    await writeFile(join(directory, 'linux-x64.node'), 'mutated')
    await expect(validateNativeDistribution({ nativeDirectory: directory, ...subject, mode: 'write' })).rejects.toThrow(/stale|dirty-built/u)
  })

  it('rejects a manifest changed after validation', async () => {
    const directory = await scratch()
    await distribution(directory, subject)
    await validateNativeDistribution({ nativeDirectory: directory, ...subject, mode: 'write' })
    await writeFile(join(directory, 'manifest.json'), '{}\n')
    await expect(validateNativeDistribution({ nativeDirectory: directory, ...subject, mode: 'check' })).rejects.toThrow(/incomplete|stale/u)
  })

  it.runIf(process.platform !== 'win32')('checks packed bytes against the native manifest and rejects a tampered archive', async () => {
    const directory = await scratch()
    const pkgRoot = join(directory, 'package')
    const native = join(pkgRoot, 'native')
    await mkdir(native, { recursive: true })
    await writeFile(join(pkgRoot, 'package.json'), JSON.stringify({ files: ['lib', 'native'], dependencies: {} }))
    for (const path of ['index.d.ts', 'THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.json', 'RUST_STANDARD_LIBRARY_NOTICES.html']) await writeFile(join(native, path), `synthetic ${path}`)
    const files = {}
    for (const platform of platforms) {
      const bytes = platform === 'win32-arm64'
        ? Buffer.alloc(2 * 1024 * 1024, 0x5a)
        : Buffer.from(`synthetic packed binary: ${platform}`)
      const binarySha256 = digest(bytes)
      files[platform] = { binarySha256, inputDigest: subject.inputDigest }
      await writeFile(join(native, `${platform}.node`), bytes)
      await writeFile(join(native, `${platform}.provenance.json`), JSON.stringify({ schema: 1, platform, commit: subject.commit, inputDigest: subject.inputDigest, cleanInputs: true, binarySha256 }))
    }
    await writeFile(join(native, 'manifest.json'), JSON.stringify({ schema: 1, commit: subject.commit, files }))
    const archive = join(directory, 'renderer.tgz')
    const pack = () => spawnSync('tar', ['-czf', archive, 'package'], { cwd: directory })
    const check = () => spawnSync(process.execPath, [join(root, 'tools/check-renderer-native-package.mjs'), archive], { cwd: root, encoding: 'utf8' })
    expect(pack().status).toBe(0)
    const accepted = check()
    expect(accepted.status, accepted.stderr).toBe(0)
    await writeFile(join(native, 'linux-x64.node'), 'tampered binary')
    expect(pack().status).toBe(0)
    const rejected = check()
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('payload does not match its validated manifest')
  })
})

it('canonicalizes native input paths with the host separator', async () => {
  const base = await scratch()
  expect(canonicalRelativePath(base, join(base, 'crates', 'renderer'))).toBe('crates/renderer')
})
