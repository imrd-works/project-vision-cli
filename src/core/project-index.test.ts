import { describe, expect, it } from 'vitest'

import { parseManifest } from './manifest.js'
import { parseMarkup } from './markup.js'
import { buildIndex, type ScannedFile } from './project-index.js'
import { createZoneResolver } from './zone-resolver.js'

const manifestResult = parseManifest(`
version: 1
zones:
  auth:
    title: Вход
    tags: [security]
    paths: [src/modules/auth/**]
  auth.passwords:
    title: Пароли
  billing:
    title: Биллинг
  reports:
    title: Отчёты
    paths: [src/modules/reports/**]
`)
if (!manifestResult.ok) throw new Error('invalid test manifest')
const manifest = manifestResult.manifest
const resolver = createZoneResolver(manifest)

function scanned(path: string, text?: string): ScannedFile {
  return {
    path,
    pathZone: resolver(path),
    ...(text === undefined ? {} : { markup: parseMarkup(text, path) }),
  }
}

describe('buildIndex', () => {
  const index = buildIndex(
    manifest,
    [
      scanned('src/modules/auth/login.ts', 'export {}'),
      scanned('src/shared/hash.ts', '// @beacon auth.passwords\nexport {}'),
      scanned('src/app.ts', 'a\n// #region @beacon auth\nb\n// #endregion\n// @beacon ghost'),
      scanned('src/modules/reports/build.ts', 'export {}'),
      scanned('src/core/logger/log.ts', 'export {}'),
      scanned('src/core/db/pool.ts'),
      scanned('assets/logo.png'),
      scanned('README.md', '# readme'),
    ],
    new Set(['reports'])
  )
  const zone = (id: string) => index.zones.find((z) => z.id === id)

  it('lists zone files, regions, inherited tags and computed states', () => {
    expect(zone('auth')).toMatchObject({
      state: 'active',
      files: ['src/modules/auth/login.ts'],
      regions: [{ file: 'src/app.ts', start: 2, end: 4 }],
    })
    expect(zone('auth.passwords')).toMatchObject({
      tags: ['security'],
      files: ['src/shared/hash.ts'],
      state: 'active',
    })
    expect(zone('billing')?.state).toBe('planned')
    expect(zone('reports')?.state).toBe('completed')
  })

  it('reports beacons of unknown zones', () => {
    expect(index.problems).toEqual([
      expect.objectContaining({ file: 'src/app.ts', line: 5, severity: 'error' }),
    ])
  })

  it('measures coverage over source files and finds unmapped folders', () => {
    expect(index.coverage).toEqual({ sourceFiles: 6, zonedSourceFiles: 4 })
    expect(index.unzonedDirs).toEqual(['src/core'])
  })
})
