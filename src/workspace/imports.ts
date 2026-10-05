import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import {
  type Alias,
  aliasesOf,
  parseImports,
  resolveImport,
  SOURCE_FILE,
} from '../core/dependencies.js'

import { listFiles } from './git.js'

/** Generated bundles and dumps are not read for imports. */
const MAX_BYTES = 512 * 1024

/**
 * The imports of every JavaScript and TypeScript file git sees, resolved to repository files:
 * what the dependency map of zones and the code viewer's related files are made of.
 */
export function collectImports(root: string): Record<string, string[]> {
  const files = listFiles(root)
  const known = new Set(files)
  const aliases = files
    .filter((file) => /^tsconfig[\w.-]*\.json$/.test(file))
    .flatMap((file) => tsconfigAliases(root, file))
  const imports: Record<string, string[]> = {}
  for (const file of files.filter((candidate) => SOURCE_FILE.test(candidate))) {
    const text = readSmall(path.join(root, file))
    if (text === undefined) continue
    const targets = parseImports(text).flatMap((spec) => {
      const target = resolveImport(file, spec, known, aliases)
      return target === undefined || target === file ? [] : [target]
    })
    if (targets.length > 0) imports[file] = [...new Set(targets)]
  }
  return imports
}

function tsconfigAliases(root: string, file: string): Alias[] {
  const text = readSmall(path.join(root, file))
  return text === undefined ? [] : aliasesOf(text, '')
}

function readSmall(file: string): string | undefined {
  try {
    return statSync(file).size > MAX_BYTES ? undefined : readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}
