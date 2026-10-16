/** Reproduce the public entry-point inventory and declaration snapshot after build. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { rendererIdentity } from './renderer-identity.mjs'
import { z } from 'zod'
import { ADMISSION, CaptureInputSchema, MarkdownTransitionInputSchema, MarkdownTransitionOutputSchema, NativeResultSchema, PresentationSchema } from './renderer-schema.mjs'
const root = new URL('../', import.meta.url)
export async function extractApi() {
  const source = await readFile(new URL('packages/renderer/src/index.ts', root), 'utf8')
  const identity = rendererIdentity()
  const exportStatements = source.replace(/\/\*[\s\S]*?\*\//gu, '').trim().split('\n').filter(line => line.trim() !== '')
  if (exportStatements.some(line => !/^export (?:type )?\{[^}]+\} from '\.\/[^']+\.ts'$/u.test(line.trim()))) throw new Error('Unsupported renderer entry-point syntax; update the fail-closed API extractor')
  const exports = []
  const modules = {}
  for (const match of source.matchAll(/export (type )?\{([^}]+)\} from '\.\/([^']+)\.ts'/gu)) {
    const [, typeOnly, names, module] = match
    exports.push(...names.split(',').map(name => ({ name: name.trim(), kind: typeOnly ? 'type' : 'value', module })))
    modules[module] ??= await readFile(new URL(`packages/renderer/lib/${module}.d.ts`, root), 'utf8')
  }
  // Re-exported primitive signatures remain part of the snapshot, even though
  // their implementation is now below the host/composite dispatch layer.
  for (const module of Object.keys(modules)) {
    const pending = [module]
    while (pending.length) {
      const current = pending.pop()
      for (const match of modules[current].matchAll(/from ['"]\.\/([^'"]+)\.js['"]/gu)) {
        if (modules[match[1]] !== undefined) continue
        modules[match[1]] = await readFile(new URL(`packages/renderer/lib/${match[1]}.d.ts`, root), 'utf8')
        pending.push(match[1])
      }
    }
  }
  return { version: 1, identity, admission: { ...ADMISSION, fileBytes: 1_048_576, estimate: '(stringValueUnits + min(maxAbsNumericValue, 256) + arrayEntries + 1)^2 * 1024; codePointWidth.code contributes zero to maxAbsNumericValue; sum per-case estimates for capture', failures: ['INVALID_INPUT', 'RESOURCE_LIMIT', 'BACKEND_FAILURE'], fallbackEligible: false }, entryPoint: '@dshline/renderer', exports, declarations: modules,
    declarationScope: 'Verbatim module declarations include internal module exports; only the exports list is public package API.',
    presentationSchema: z.toJSONSchema(PresentationSchema),
    captureInputSchema: z.toJSONSchema(CaptureInputSchema),
    nativeMarkdownTransition: { input: z.toJSONSchema(MarkdownTransitionInputSchema), output: z.toJSONSchema(MarkdownTransitionOutputSchema), result: z.toJSONSchema(NativeResultSchema), status: 'specified; not implemented or dispatched' },
    limitations: ['Normalized requests are a subset of published API, not a replacement public API.', 'Bounded integer inputs only; rejected normalized work is never automatically retried through an unbounded fallback. Public direct TS calls remain unchanged.', 'Resolved palette snapshots are explicit presentation data; arbitrary callbacks and mutable host objects never cross native boundary.'],
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const spec = `${JSON.stringify(await extractApi(), null, 2)}\n`
  const path = new URL('docs/renderer-spec.json', root)
  if (process.argv[2] === '--write') await writeFile(path, spec)
  else if (await readFile(path, 'utf8') !== spec) throw new Error('Renderer spec drift; build then node tools/renderer-spec.mjs --write and review')
}
