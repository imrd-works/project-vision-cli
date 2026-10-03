import { describe, expect, it } from 'vitest'

import { type AuditSource, isTestFile, renderAuditPack, selectZones } from './audit-pack.js'
import type { IndexedZone, ProjectIndex } from './project-index.js'

function zone(id: string, extra: Partial<IndexedZone> = {}): IndexedZone {
  return {
    id,
    title: id.toUpperCase(),
    tags: [],
    paths: [],
    state: 'active',
    files: [],
    regions: [],
    ...extra,
  }
}

const index: ProjectIndex = {
  version: 1,
  zones: [
    zone('auth', {
      tags: ['security'],
      description: 'Вход',
      files: ['src/auth/login.ts', 'src/auth/login.test.ts'],
    }),
    zone('auth.passwords', { tags: ['security'], files: ['src/auth/login.ts'] }),
    zone('billing', { state: 'planned' }),
    zone('http', {
      tags: ['security'],
      regions: [{ file: 'src/app.ts', start: 5, end: 6 }],
    }),
  ],
  files: [],
  coverage: { sourceFiles: 0, zonedSourceFiles: 0 },
  unzonedDirs: [],
  problems: [],
}

const FILES: Record<string, string> = {
  'src/auth/login.ts': 'export const login = () => "```"\n',
  'src/app.ts': Array.from({ length: 12 }, (_, i) => `line ${String(i + 1)}`).join('\n'),
}

const source: AuditSource = {
  project: 'demo',
  index,
  read: (file) => FILES[file],
  date: '2026-10-04',
}

describe('selectZones', () => {
  it('filters by tag and by zone branch', () => {
    expect(selectZones(index, { tag: 'security' }).map((z) => z.id)).toEqual([
      'auth',
      'auth.passwords',
      'http',
    ])
    expect(selectZones(index, { zone: 'auth' }).map((z) => z.id)).toEqual([
      'auth',
      'auth.passwords',
    ])
  })
})

describe('isTestFile', () => {
  it('recognizes test files and folders', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true)
    expect(isTestFile('test/e2e/app.e2e.test.ts')).toBe(true)
    expect(isTestFile('src/__tests__/a.ts')).toBe(true)
    expect(isTestFile('src/latest.ts')).toBe(false)
  })
})

describe('renderAuditPack', () => {
  const pack = renderAuditPack(source, { tag: 'security', includeTests: false, code: true })

  it('lists the zones and their code without tests', () => {
    expect(pack).toContain('# Аудит: тег security — demo')
    expect(pack).toContain('зон — 3, файлов — 1, фрагментов — 1. Тесты исключены.')
    expect(pack).toContain('| `auth` | AUTH | security | 1 | 0 |')
    expect(pack).not.toContain('login.test.ts')
  })

  it('prints a file once and refers to it later', () => {
    expect(pack.match(/export const login/g)).toHaveLength(1)
    expect(pack).toContain('_Приведён выше, в зоне `auth`._')
  })

  it('fences code that itself contains backticks', () => {
    expect(pack).toContain('````ts\nexport const login = () => "```"\n````')
  })

  it('shows regions with context lines', () => {
    expect(pack).toContain('### src/app.ts · строки 5–6 (регион)')
    expect(pack).toContain('```ts\nline 2\n')
    expect(pack).toContain('line 9\n```\n\n_Строки 2–9, с контекстом._')
  })

  it('cuts long files, lists paths only on request and handles empty selections', () => {
    const long = { ...source, read: () => Array.from({ length: 450 }, () => 'x').join('\n') }
    expect(renderAuditPack(long, { zone: 'auth', includeTests: true, code: true })).toContain(
      'Показаны первые 400 строк из 450'
    )
    const paths = renderAuditPack(source, { zone: 'auth', includeTests: true, code: false })
    expect(paths).toContain('### src/auth/login.test.ts')
    expect(paths).not.toContain('```')
    expect(renderAuditPack(source, { tag: 'nope', includeTests: false, code: true })).toContain(
      'Подходящих зон нет.'
    )
  })

  it('mentions planned zones and unreadable files', () => {
    const all = renderAuditPack(
      { ...source, read: () => undefined },
      { includeTests: false, code: true }
    )
    expect(all).toContain('# Аудит: все зоны — demo')
    expect(all).toContain('Зона запланирована: кода пока нет.')
    expect(all).toContain('_Файл недоступен для чтения._')
  })
})
