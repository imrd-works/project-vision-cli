import { describe, expect, it } from 'vitest'

import { type ChangedFile, checkCommit, touchedZones } from './commit-check.js'
import { parseManifest } from './manifest.js'
import { createZoneResolver } from './zone-resolver.js'

function context() {
  const result = parseManifest(`
version: 1
zones:
  home:
    title: Главная
    paths: [src/pages/home/**]
  home.pricing:
    title: Тарифы
    paths: [src/widgets/pricing/**]
    formerly: [pricing]
  security.http:
    title: Защита HTTP
`)
  if (!result.ok) throw new Error('invalid test manifest')
  return { manifest: result.manifest, resolver: createZoneResolver(result.manifest) }
}

const APP = [
  'const app = create()', // 1
  '// #region @beacon security.http', // 2
  'app.use(helmet())', // 3
  '// #endregion', // 4
  'app.listen()', // 5
].join('\n')

function modified(path: string, text: string, lines: number[]): ChangedFile {
  const ranges = lines.map((line) => ({ start: line, end: line }))
  return {
    oldPath: path,
    newPath: path,
    oldText: text,
    newText: text,
    oldRanges: ranges,
    newRanges: ranges,
  }
}

describe('touchedZones', () => {
  it('collects zones by paths, file beacons and touched regions', () => {
    const files: ChangedFile[] = [
      modified('src/widgets/pricing/Toggle.tsx', 'x', [1]),
      modified('src/shared/lib/money.ts', '// @beacon pricing\nexport {}', [2]),
      modified('src/app.ts', APP, [3]),
    ]
    expect(touchedZones(context(), files).zones).toEqual([
      {
        zone: 'home.pricing',
        files: ['src/shared/lib/money.ts', 'src/widgets/pricing/Toggle.tsx'],
      },
      { zone: 'security.http', files: ['src/app.ts'] },
    ])
  })

  it('does not count a region when the change is outside it', () => {
    expect(touchedZones(context(), [modified('src/app.ts', APP, [5])]).zones).toEqual([])
  })

  it('counts the old location of moved and deleted files', () => {
    const moved: ChangedFile = {
      oldPath: 'src/pages/home/Banner.tsx',
      newPath: 'src/shared/Banner.tsx',
      oldRanges: [],
      newRanges: [],
    }
    const deleted: ChangedFile = {
      oldPath: 'src/x.ts',
      oldText: '// #region @beacon security.http\nx\n// #endregion',
      oldRanges: [{ start: 1, end: 3 }],
      newRanges: [],
    }
    expect(touchedZones(context(), [moved, deleted]).zones.map((z) => z.zone)).toEqual([
      'home',
      'security.http',
    ])
  })

  it('reports unknown zones in new code only', () => {
    const file: ChangedFile = {
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      oldText: '// @beacon removed-zone',
      newText: '// @beacon typo-zone',
      oldRanges: [],
      newRanges: [{ start: 1, end: 1 }],
    }
    const { problems } = touchedZones(context(), [file])
    expect(problems.map((p) => p.message)).toEqual([expect.stringContaining('typo-zone')])
  })
})

describe('checkCommit', () => {
  const files = [modified('src/widgets/pricing/Toggle.tsx', 'x', [1])]

  it('passes when every touched zone has its beacon, former IDs included', () => {
    const check = checkCommit(context(), files, 'feat(home): toggle [BEACON: pricing completed]')
    expect(check.missing).toEqual([])
    expect(check.problems).toEqual([])
    expect(check.completed).toEqual(['home.pricing'])
  })

  it('requires the most specific zone, not its parent', () => {
    const check = checkCommit(context(), files, 'feat(home): toggle [BEACON: home]')
    expect(check.missing.map((touch) => touch.zone)).toEqual(['home.pricing'])
  })

  it('rejects beacons of unknown zones', () => {
    const check = checkCommit(context(), [], 'chore: x [BEACON: nope]')
    expect(check.problems).toHaveLength(1)
  })

  it('lets files outside zones through without beacons', () => {
    const check = checkCommit(context(), [modified('README.md', 'x', [1])], 'docs: readme')
    expect(check.missing).toEqual([])
    expect(check.zones).toEqual([])
  })

  it('reports files claimed by unrelated zones', () => {
    const conflicting = parseManifest(
      'version: 1\nzones:\n  a:\n    title: A\n    paths: [src/**]\n  b:\n    title: B\n    paths: [src/x/**]\n'
    )
    if (!conflicting.ok) throw new Error('invalid test manifest')
    const ctx = {
      manifest: conflicting.manifest,
      resolver: createZoneResolver(conflicting.manifest),
    }
    const check = checkCommit(ctx, [modified('src/x/y.ts', 'y', [1])], 'fix: y')
    expect(check.problems[0]?.message).toContain('несвязанные зоны a, b')
  })
})
