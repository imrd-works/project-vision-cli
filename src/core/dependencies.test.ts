import { describe, expect, it } from 'vitest'

import { aliasesOf, parseImports, resolveImport, zoneDependencies } from './dependencies.js'

describe('imports', () => {
  it('finds the modules a file imports', () => {
    const text = `import { a } from './a.js'
import type { B } from "../b"
import './styles.css'
export * from './c'
export { d } from '@/shared/d'
const e = await import('./e')
const f = require('f-package')
import { a as again } from './a.js'`
    expect(parseImports(text)).toEqual([
      './a.js',
      '../b',
      './styles.css',
      './c',
      '@/shared/d',
      './e',
      'f-package',
    ])
  })

  it('resolves relative paths, TypeScript extensions, folders and aliases', () => {
    const files = new Set([
      'src/app/a.ts',
      'src/b.tsx',
      'src/app/c/index.ts',
      'src/shared/d.ts',
      'src/app/styles.css',
    ])
    const aliases = aliasesOf(
      `{
        // comments and trailing commas, as tsconfig has them
        "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], }, },
      }`,
      ''
    )
    expect(aliases).toEqual([{ prefix: '@/', target: 'src' }])
    const from = 'src/app/main.ts'
    expect(resolveImport(from, './a.js', files, aliases)).toBe('src/app/a.ts')
    expect(resolveImport(from, '../b', files, aliases)).toBe('src/b.tsx')
    expect(resolveImport(from, './c', files, aliases)).toBe('src/app/c/index.ts')
    expect(resolveImport(from, '@/shared/d', files, aliases)).toBe('src/shared/d.ts')
    expect(resolveImport(from, './styles.css', files, aliases)).toBe('src/app/styles.css')
    expect(resolveImport(from, 'react', files, aliases)).toBeUndefined()
    expect(resolveImport(from, './missing', files, aliases)).toBeUndefined()
    expect(aliasesOf('{ not json', '')).toEqual([])
    expect(aliasesOf('{"compilerOptions":{}}', '')).toEqual([])
  })

  it('counts imports between zones', () => {
    const zones: Record<string, string[]> = {
      'src/a.ts': ['web'],
      'src/b.ts': ['api'],
      'src/c.ts': ['web'],
    }
    expect(
      zoneDependencies(
        { 'src/a.ts': ['src/b.ts', 'src/c.ts'], 'src/c.ts': ['src/b.ts', 'src/lib.ts'] },
        (file) => zones[file] ?? []
      )
    ).toEqual([{ from: 'web', to: 'api', imports: 2 }])
  })
})
