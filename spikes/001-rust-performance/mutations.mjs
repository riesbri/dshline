import { studyDirectory } from './study-path.mjs'
/** Demonstrate that exact checks reject two plausible broken optimizations. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { deepStrictEqual, throws } from 'node:assert'
import { loadVerifiedRenderer } from '../../tools/renderer-identity.mjs'
const scratch = studyDirectory(process.argv[2])
const { renderer: reference, identity } = await loadVerifiedRenderer(undefined, { referenceOnly: true })
const require = createRequire(import.meta.url)
const mutations = {
  'wrong-cjk-width': {
    change: source => source.replace('pub fn code_point_width(c: u32) -> i32 {', 'pub fn code_point_width(c: u32) -> i32 {\n    if c == 0x4e00 { return 1; }'),
    probe: addon => deepStrictEqual(addon.codePointWidth(0x4e00), reference.codePointWidth(0x4e00), 'CJK width exactness'),
  },
  'missing-ascii-guard': {
    change: source => source.replace('    if s.iter().any(|&unit| unit != 10 && !(32..127).contains(&unit)) {\n        return wrap_reference(s, n);\n    }', ''),
    probe: addon => {
      const text = '\x1b]link\x07 \x1b[0m\t\x1b]link\x07 中\udfff\x1b'
      deepStrictEqual(addon.wrapToWidth(text, -256), reference.wrapToWidth(text, -256), 'Skipped-space zero-width retention')
    },
  },
}
const result = { identity, mutations: {} }
for (const [name, mutation] of Object.entries(mutations)) {
  const directory = join(scratch, `mutation-${name}`)
  mkdirSync(directory, { recursive: true })
  cpSync(join(scratch, 'candidate/crates'), join(directory, 'crates'), { recursive: true })
  const sourceFile = join(directory, 'crates/dshline-renderer/src/lib.rs')
  const original = readFileSync(sourceFile, 'utf8'), modified = mutation.change(original)
  if (modified === original) throw Error('Mutation did not apply')
  writeFileSync(sourceFile, modified)
  execFileSync('cargo', ['build', '--offline', '--locked', '--release', '--manifest-path', join(directory, 'crates/dshline-renderer-node/Cargo.toml')], { env: { ...process.env, CARGO_TARGET_DIR: join(scratch, 'target') }, stdio: 'inherit' })
  const extension = process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so'
  const addonPath = join(directory, 'renderer.node')
  cpSync(join(scratch, 'target/release', `${process.platform === 'win32' ? '' : 'lib'}dshline_renderer_node.${extension}`), addonPath)
  const addon = require(addonPath)
  throws(() => mutation.probe(addon), error => error.code === 'ERR_ASSERTION', `Mutation ${name} must fail exact comparison, not fail to load`)
  result.mutations[name] = { rejected: true, sourceSha256: createHash('sha256').update(modified).digest('hex'), addonSha256: createHash('sha256').update(readFileSync(addonPath)).digest('hex') }
}
writeFileSync(join(scratch, 'mutations.json'), JSON.stringify(result, null, 2) + '\n')
console.log('Both deliberate semantic mutations were rejected')
