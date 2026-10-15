/** Verify executed artifacts against a fresh isolated emission by the repository compiler. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const defaultRoot = fileURLToPath(new URL('../', import.meta.url))
const verified = new Set()
function digest(files) {
  const hash = createHash('sha256')
  for (const [name, bytes] of files) hash.update(name).update('\0').update(bytes).update('\0')
  return hash.digest('hex')
}
function filesAt(directory, suffix) {
  return readdirSync(directory).filter(name => suffix.test(name)).sort().map(name => [name, readFileSync(join(directory, name))])
}
export function rendererIdentity(root = defaultRoot) {
  const source = filesAt(join(root, 'packages/renderer/src'), /\.ts$/u)
  const config = ['tsconfig.base.json', 'packages/renderer/tsconfig.json', 'node_modules/typescript/package.json'].map(name => [name, readFileSync(join(root, name))])
  const build = filesAt(join(root, 'packages/renderer/lib'), /(?:\.js|\.d\.ts)$/u)
  const identity = { algorithm: 'sha256-name-NUL-bytes-NUL-sorted', source: digest(source), executedBuild: digest(build), compilerAndConfig: digest(config) }
  const key = JSON.stringify(identity)
  if (!verified.has(key)) {
    const scratch = mkdtempSync(join(tmpdir(), 'renderer-fresh-build-'))
    try {
      execFileSync(process.execPath, [resolve(defaultRoot, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'packages/renderer/tsconfig.json'), '--outDir', scratch, '--tsBuildInfoFile', join(scratch, 'fresh.tsbuildinfo')], { encoding: 'utf8', stdio: 'pipe' })
      const fresh = filesAt(scratch, /(?:\.js|\.d\.ts)$/u)
      if (digest(fresh) !== identity.executedBuild) throw new Error('Renderer build is stale or modified; run pnpm build before recording reference artifacts')
      verified.add(key)
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  }
  return identity
}

/** Execute verified bytes from a unique complete module graph, never the caller's ESM cache. */
export async function loadVerifiedRenderer(root = defaultRoot, { referenceOnly = false } = {}) {
  const identity = rendererIdentity(root)
  const build = filesAt(join(root, 'packages/renderer/lib'), /(?:\.js|\.d\.ts)$/u)
  if (digest(build) !== identity.executedBuild) throw new Error('Renderer changed while snapshotting verified artifacts')
  const snapshot = mkdtempSync(join(tmpdir(), 'renderer-verified-modules-'))
  try {
    writeFileSync(join(snapshot, 'package.json'), '{"type":"module"}')
    for (const [name, bytes] of build) writeFileSync(join(snapshot, name), bytes)
    if (digest(filesAt(snapshot, /(?:\.js|\.d\.ts)$/u)) !== identity.executedBuild) throw new Error('Renderer snapshot digest mismatch')
    const renderer = referenceOnly
      ? Object.assign({}, ...await Promise.all(['width', 'text', 'box', 'markdown', 'screen', 'theme'].map(name => import(pathToFileURL(join(snapshot, `${name}.js`)).href))))
      : await import(pathToFileURL(join(snapshot, 'index.js')).href)
    if (JSON.stringify(rendererIdentity(root)) !== JSON.stringify(identity)) throw new Error('Renderer changed during module loading')
    return { identity, renderer }
  } finally { rmSync(snapshot, { recursive: true, force: true }) }
}
