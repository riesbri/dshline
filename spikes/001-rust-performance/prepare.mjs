import { studyDirectory } from './study-path.mjs'
/** Build research-only variants in scratch; never replace the package's addon. */
import { cpSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { codePointWidth } from '../../packages/renderer/lib/width.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const here = fileURLToPath(new URL('./', import.meta.url))
const scratch = studyDirectory(process.argv[2], { create: true })
const selected = process.argv.slice(3)
const variants = ['baseline', 'lookup', 'spans', 'combined', 'thin-lto', 'candidate']
if (selected.some(name => !variants.includes(name))) throw Error('Unknown variant')
const hash = value => createHash('sha256').update(value).digest('hex')
const source = readFileSync(join(root, 'crates/dshline-renderer/src/lib.rs'), 'utf8')
function treeFiles(path, base = path) {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = join(path, entry.name)
    return entry.isDirectory() ? treeFiles(file, base) : [[file.slice(base.length + 1), hash(readFileSync(file))]]
  })
}
const pages = [], indexes = [], pageIds = new Map()
for (let start = 0; start < 0x110000; start += 256) {
  const page = Array.from({ length: 256 }, (_, i) => codePointWidth(start + i))
  const key = page.join('')
  if (!pageIds.has(key)) { pageIds.set(key, pages.length); pages.push(page) }
  indexes.push(pageIds.get(key))
}
if (pages.length > 65536) throw Error('Page index overflow')
const table = `// Derived only from the unchanged project Unicode tables.\n// Unicode data copyright Unicode, Inc.; https://www.unicode.org/license.txt\npub static INDEX: [u16; ${indexes.length}] = [${indexes.join(',')}];\npub static PAGES: [[u8; 256]; ${pages.length}] = [${pages.map(p => `[${p.join(',')}]`).join(',')}];\n`
function replaceFunction(input, name, nextName, replacement) {
  const start = input.indexOf(`pub fn ${name}(`)
  const end = input.indexOf(`pub fn ${nextName}(`, start)
  if (start < 0 || end < 0) throw Error(`Source drift at ${name}`)
  return input.slice(0, start) + replacement + '\n' + input.slice(end)
}
console.log(`Private study directory: ${scratch}`)
const evidence = { baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), rustc: execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).trim(), sourceSha256: hash(source), tableBytes: indexes.length * 2 + pages.length * 256, uniquePages: pages.length, variants: {} }
for (const variant of selected.length ? selected : variants) {
  const directory = join(scratch, variant)
  for (const crate of ['dshline-renderer', 'dshline-renderer-node']) {
    const destination = join(directory, 'crates', crate)
    mkdirSync(destination, { recursive: true })
    for (const name of ['Cargo.toml', 'Cargo.lock', 'src', ...(crate.endsWith('-node') ? ['build.rs'] : ['tests'])]) {
      cpSync(join(root, 'crates', crate, name), join(destination, name), { recursive: true })
    }
  }
  let modified = source
  if (['lookup', 'combined', 'thin-lto', 'candidate'].includes(variant)) {
    const start = modified.indexOf('pub fn code_point_width('), end = modified.indexOf('fn point(', start)
    if (start < 0 || end < 0) throw Error('Width source drift')
    modified = modified.slice(0, start) + `mod lookup;\npub fn code_point_width(c: u32) -> i32 {\n    if c < 32 || (127..160).contains(&c) { 0 }\n    else if c < 127 { 1 }\n    else if c <= 0x10ffff { lookup::PAGES[lookup::INDEX[(c >> 8) as usize] as usize][(c & 255) as usize] as i32 }\n    else { 1 }\n}\n` + modified.slice(end)
    writeFileSync(join(directory, 'crates/dshline-renderer/src/lookup.rs'), table)
  }
  if (['spans', 'combined', 'thin-lto', 'candidate'].includes(variant)) {
    if (variant !== 'candidate') modified = replaceFunction(modified, 'tail', 'split_columns', readFileSync(join(here, 'tail.rs'), 'utf8'))
    const reference = source.slice(source.indexOf('pub fn wrap('), source.indexOf('pub fn fit(')).replace('pub fn wrap(', 'fn wrap_reference(')
    modified = replaceFunction(modified, 'wrap', 'fit', readFileSync(join(here, 'wrap.rs'), 'utf8') + '\n' + reference)
  }
  writeFileSync(join(directory, 'crates/dshline-renderer/src/lib.rs'), modified)
  const manifest = join(directory, 'crates/dshline-renderer-node/Cargo.toml')
  if (variant === 'thin-lto') writeFileSync(manifest, readFileSync(manifest, 'utf8') + '\n[profile.release]\nlto = "thin"\ncodegen-units = 1\npanic = "unwind"\n')
  const env = { ...process.env, CARGO_TARGET_DIR: join(scratch, 'target') }
  const start = performance.now()
  execFileSync('cargo', ['build', '--offline', '--locked', '--release', '--manifest-path', manifest], { env, stdio: 'inherit' })
  const extension = process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so'
  const binary = join(scratch, 'target/release', `${process.platform === 'win32' ? '' : 'lib'}dshline_renderer_node.${extension}`)
  const addon = join(directory, 'renderer.node')
  copyFileSync(binary, addon)
  evidence.variants[variant] = { sourceSha256: hash(modified), manifestSha256: hash(readFileSync(manifest)), inputs: treeFiles(join(directory, 'crates')), addonSha256: hash(readFileSync(addon)), bytes: readFileSync(addon).length, buildSeconds: (performance.now() - start) / 1000 }
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ...evidence, variants: { [variant]: evidence.variants[variant] } }, null, 2) + '\n')
  console.log(`Built research variant ${variant}: ${evidence.variants[variant].bytes} bytes`)
}
writeFileSync(join(scratch, 'builds.json'), JSON.stringify(evidence, null, 2) + '\n')
