/**
 * Architectural guards for the human subagent-conversation path.
 *
 * The load-bearing guarantee is the TYPE: `HumanSubagentSeam` is a `Pick` of
 * `SubagentRuntime` with only `listChildren` and `prompt`, so a call to the
 * model-authored `sendMessage` is a `pnpm typecheck` failure in `src`. These
 * tests are the anti-cast backstop and the packaging check that the seam stays
 * optional and provider-neutral.
 *
 * The scan is comment- and string-aware rather than a substring search, so a
 * comment explaining why `sendMessage` is forbidden cannot fail the guard while
 * a real call cannot hide behind one.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Every file under one production runtime directory, at any depth. */
function runtimeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? runtimeFiles(path) : [path]
  })
}

/**
 * Strip comments and string/template literals, keeping only code.
 *
 * A regex over raw text would flag the comments that explain this very rule and
 * would miss a call whose receiver is spread across lines; a tiny scanner that
 * respects lexical context flags the call and only the call. A template
 * literal's `${…}` expressions are CODE, so they are copied back out rather than
 * discarded with the literal text around them.
 * @param source - one source file's text.
 * @returns the same text with comments and literal contents removed.
 */
export function codeOnly(source: string): string {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === '\'') {
      const quote = char
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2
          continue
        }
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      out += '""'
      continue
    }
    if (char === '`') {
      index += 1
      while (index < source.length) {
        const inner = source[index]
        if (inner === '\\') {
          index += 2
          continue
        }
        if (inner === '`') {
          index += 1
          break
        }
        if (inner === '$' && source[index + 1] === '{') {
          let depth = 1
          index += 2
          const start = index
          while (index < source.length && depth > 0) {
            const inside = source[index]
            if (inside === '\\') {
              index += 2
              continue
            }
            if (inside === '{') depth += 1
            else if (inside === '}') depth -= 1
            index += 1
          }
          out += ` ${source.slice(start, index - 1)} `
          continue
        }
        index += 1
      }
      out += '""'
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** Calls and symbols no human terminal path may reach. */
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['SubagentRuntime.sendMessage access', /\.\s*sendMessage\b/],
  ['private deliverSubagentPrompt symbol', /\bdeliverSubagentPrompt\b/],
  ['host-only queueHostSubagentPrompt helper', /\bqueueHostSubagentPrompt\b/],
  ['host-only steerHostSubagentPrompt helper', /\bsteerHostSubagentPrompt\b/],
  ['provider-specific subagent import', /from\s+["'][^"']*@deepseek-ai\/dsh-subagent-[a-z-]+["']/],
  ['dynamic provider-specific subagent import', /import\s*\(\s*["'][^"']*@deepseek-ai\/dsh-subagent-[a-z-]+["']/],
]

describe('architecture guard: the human subagent path', () => {
  it('calls neither the model-authored sendMessage nor any private host symbol', () => {
    const files = [...runtimeFiles(`${root}src`), ...runtimeFiles(`${root}bin`)]
    const offenders: string[] = []
    for (const file of files) {
      const code = codeOnly(readFileSync(file, 'utf8'))
      for (const [label, pattern] of FORBIDDEN) {
        if (pattern.test(code)) offenders.push(`${file.slice(root.length)}: ${label}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('sees a call in code but not one in a comment, string, or template text', () => {
    expect(codeOnly('const x = seam.sendMessage(a, b)')).toContain('sendMessage')
    expect(codeOnly('const x = `${seam.sendMessage(a, b)}`')).toContain('sendMessage')
    expect(codeOnly('// seam.sendMessage(a, b)')).not.toContain('sendMessage')
    expect(codeOnly("const s = 'seam.sendMessage(a, b)'")).not.toContain('sendMessage')
  })

  it('keeps the subagent seam optional and type-only in the published manifest', () => {
    const manifest = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    // Optional per AGENTS rule 11: the runner needs the types to compile, but a
    // profile that omits the plugin must not get an unmet-peer warning, so the
    // types live in devDependencies and never in dependencies or peers.
    expect(manifest.dependencies?.['@deepseek-ai/dsh-subagent']).toBeUndefined()
    expect(manifest.devDependencies?.['@deepseek-ai/dsh-subagent']).toBeDefined()
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-subagent']).toBeUndefined()
  })

  it('keeps the renderer free of every dependency', () => {
    const manifest = JSON.parse(readFileSync(`${root}../renderer/package.json`, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(manifest.dependencies ?? {}).toEqual({})
    expect(manifest.peerDependencies ?? {}).toEqual({})
  })
})
