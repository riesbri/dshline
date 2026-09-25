/** Declaration-target validation for source-linked Harness packages. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { declarationState } from './harness-declarations.mjs'

/** @type {string | undefined} */
let root

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Write a package manifest and any declaration files it advertises.
 * @param {string} manifestText - package.json contents.
 * @param {readonly string[]} declarations - declaration paths to emit.
 * @returns {Promise<string>} the package directory.
 */
async function packageFixture(manifestText, declarations = []) {
  root = await mkdtemp(join(tmpdir(), 'harness-declarations-'))
  await writeFile(join(root, 'package.json'), manifestText)
  for (const declaration of declarations) {
    const path = join(root, declaration)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, 'export {}\n')
  }
  return root
}

describe('declarationState()', () => {
  it('accepts a subpath-only typed package without a root types or . export', async () => {
    const target = await packageFixture(JSON.stringify({
      name: '@deepseek-ai/node-addon-system',
      exports: {
        './landlock-run': { types: './lib/index.d.ts', import: './lib/index.js' },
        './flock': { types: './lib/flock.d.ts', import: './lib/flock.js' },
      },
    }), ['lib/index.d.ts', 'lib/flock.d.ts'])

    await expect(declarationState(target)).resolves.toEqual({ kind: 'built' })
  })

  it('collects root types, root export types, and typed subpaths together', async () => {
    const target = await packageFixture(JSON.stringify({
      types: './lib/root.d.ts',
      exports: {
        '.': { types: './lib/root-export.d.ts' },
        './feature': { types: './lib/feature.d.ts' },
      },
    }), ['lib/root.d.ts', 'lib/root-export.d.ts', 'lib/feature.d.ts'])

    await expect(declarationState(target)).resolves.toEqual({ kind: 'built' })
  })

  it('distinguishes no declarations from a missing package manifest', async () => {
    const noTypes = await packageFixture(JSON.stringify({ name: 'plain-package' }))
    await expect(declarationState(noTypes)).resolves.toEqual({ kind: 'none' })

    const missing = await packageFixture(JSON.stringify({ name: 'temporary' }))
    await rm(join(missing, 'package.json'))
    await expect(declarationState(missing)).resolves.toEqual({ kind: 'missing' })
  })

  it('reports advertised subpath declarations that have not been built', async () => {
    const target = await packageFixture(JSON.stringify({
      name: 'subpath-package',
      exports: { './flock': { types: './lib/flock.d.ts' } },
    }))

    await expect(declarationState(target)).resolves.toMatchObject({ kind: 'unbuilt' })
  })
})
