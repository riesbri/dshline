/** Keep shipped native notices bound to the reviewed locked dependency graph. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const catalog = JSON.parse(read('packages/renderer/native/THIRD_PARTY_NOTICES.json'))
const lock = read('crates/dshline-renderer-node/Cargo.lock')
if (catalog.schema !== 1 || catalog.cargoLockSha256 !== hash(lock)
  || catalog.noticeSha256 !== hash(read('packages/renderer/native/THIRD_PARTY_NOTICES.txt'))
  || catalog.rustStandardLibraryNoticesSha256 !== hash(read('packages/renderer/native/RUST_STANDARD_LIBRARY_NOTICES.html'))) throw Error('Native license texts or Cargo graph changed: review and refresh the shipped notice catalog')
// Cargo-generated v4 lock entries contain unambiguous quoted name/version/source
// fields. Only registry packages require external notices; the two path crates
// are this repository's own code under its MIT license.
const packages = [...lock.toString('utf8').matchAll(/\[\[package\]\]\n([\s\S]*?)(?=\n\[\[package\]\]|$)/gu)]
  .map(([, block]) => Object.fromEntries([...block.matchAll(/^(name|version|source) = "([^"\n]+)"$/gmu)].map(([, key, value]) => [key, value])))
  .filter(p => p.source).map(p => `${p.name}@${p.version}`).sort()
const recorded = catalog.packages.map(p => `${p.name}@${p.version}`).sort()
if (JSON.stringify(packages) !== JSON.stringify(recorded) || catalog.packages.some(p => !p.license || !p.texts?.length)) throw Error('Native notices do not cover the exact locked dependency graph')
process.stdout.write(`Native dependency notices match ${recorded.length} locked packages; Rust std catalog ${catalog.rustVersion}.\n`)
