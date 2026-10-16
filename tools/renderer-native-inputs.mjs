import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const canonicalRelativePath = (base, file) => relative(base, file).split(sep).join('/')
const scan = async (path, result = []) => {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (entry.isDirectory()) await scan(file, result)
    else if (entry.isFile()) result.push(file)
  }
  return result
}

export async function rendererNativeInputsDigest() {
  const files = [
    join(root, 'crates/dshline-renderer/Cargo.toml'),
    join(root, 'crates/dshline-renderer/Cargo.lock'),
    ...(await scan(join(root, 'crates/dshline-renderer/src'))),
    ...(await scan(join(root, 'crates/dshline-renderer/tests'))),
    join(root, 'crates/dshline-renderer-node/Cargo.toml'),
    join(root, 'crates/dshline-renderer-node/Cargo.lock'),
    join(root, 'crates/dshline-renderer-node/build.rs'),
    ...(await scan(join(root, 'crates/dshline-renderer-node/src'))),
    ...(await scan(join(root, 'packages/renderer/src'))),
    join(root, 'tsconfig.base.json'),
    join(root, 'packages/renderer/tsconfig.json'),
    ...(await scan(join(root, 'tests/fixtures/renderer-parity'))),
    join(root, 'packages/renderer/native/index.d.ts'),
    join(root, 'packages/renderer/native/THIRD_PARTY_NOTICES.txt'),
    join(root, 'packages/renderer/native/THIRD_PARTY_NOTICES.json'),
    join(root, 'packages/renderer/native/RUST_STANDARD_LIBRARY_NOTICES.html'),
    join(root, 'tools/build-renderer-native.mjs'),
    join(root, 'tools/generate-renderer-lookup.mjs'),
    join(root, 'tools/renderer-lookup.spec.mjs'),
    join(root, 'tools/renderer-leaf.spec.mjs'),
    join(root, 'tools/renderer-native-types.mjs'),
    join(root, 'tools/renderer-native-inputs.mjs'),
    join(root, 'tools/renderer-native-distribution.mjs'),
    join(root, 'tools/check-renderer-native-licenses.mjs'),
    join(root, 'tools/check-renderer-native-package.mjs'),
    join(root, 'tools/renderer-native.spec.mjs'),
    join(root, 'tools/renderer-native-pipeline.spec.mjs'),
    join(root, 'tools/renderer-forced-smoke.mjs'),
    join(root, 'tools/renderer-napi-host.mjs'),
    join(root, 'tools/renderer-parity.mjs'),
    join(root, 'tools/renderer-capture.mjs'),
    join(root, 'tools/renderer-schema.mjs'),
    join(root, 'tools/renderer-parity-corpus.mjs'),
    join(root, 'tools/renderer-identity.mjs'),
  ].sort()
  const hash = createHash('sha256')
  for (const file of files) hash.update(canonicalRelativePath(root, file)).update('\0').update(await readFile(file)).update('\0')
  return hash.digest('hex')
}
