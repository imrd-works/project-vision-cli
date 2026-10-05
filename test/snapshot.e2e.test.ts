import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  collectSnapshot,
  dependencyView,
  fileLinks,
  historyView,
  indexView,
  timelineView,
} from '../src/lib/index.js'

import { TestRepo, ZONES } from './support/test-repo.js'

const PLAN = `version: 1
line: web
checkpoints:
  pricing:
    title: Pricing
    items:
      - zone: home.pricing
`

describe('collectSnapshot', () => {
  let repo: TestRepo

  beforeEach(() => {
    repo = TestRepo.create()
      .write('.beacons/zones.yml', ZONES)
      .write('.beacons/checkpoints.yml', PLAN)
      .write('src/widgets/pricing/Toggle.tsx', 'export const Toggle = 1\n')
      .write('.beacons/audits/pricing/round-1/ann-x-io.md', '---\nauthor: ann@x.io\n---\n')
    repo.commitAll(
      'feat(home): pricing [BEACON: home.pricing completed]',
      '2026-09-30T12:00:00+03:00'
    )
  })

  afterEach(() => {
    repo.remove()
  })

  it('captures a checked-out commit in a form that survives JSON', () => {
    // Through JSON on purpose, as a server stores it: structuredClone would keep Maps alive.
    const stored = JSON.stringify(collectSnapshot(repo.root))
    const snapshot = JSON.parse(stored) as ReturnType<typeof collectSnapshot>
    expect(snapshot).toMatchObject({
      format: 1,
      files: { zones: ZONES, checkpoints: PLAN },
      commits: [{ subject: 'feat(home): pricing [BEACON: home.pricing completed]' }],
    })
    expect(snapshot.files.config).toBeUndefined()
    expect(snapshot.audits).toEqual([
      { path: '.beacons/audits/pricing/round-1/ann-x-io.md', text: '---\nauthor: ann@x.io\n---\n' },
    ])
    expect(indexView(snapshot).index?.zones).toContainEqual(
      expect.objectContaining({ id: 'home.pricing', state: 'completed' })
    )
    expect(historyView(snapshot, '2026-10-01')?.markedCommits).toBe(1)
    const result = timelineView([snapshot], '2026-10-01')
    expect(result).toMatchObject({
      timeline: { lines: [{ line: 'web', checkpoints: [{ id: 'pricing', state: 'ready' }] }] },
    })
  })

  it('knows which zones depend on which through their imports', () => {
    repo
      .write('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }')
      .write('src/pages/home/Home.tsx', "import { Toggle } from '@/widgets/pricing/Toggle'\n")
      .write('src/pages/home/Hero.tsx', "export { Home } from './Home'\n")
    repo.commitAll('feat(home): page')
    const snapshot = collectSnapshot(repo.root)
    expect(snapshot.imports).toEqual({
      'src/pages/home/Hero.tsx': ['src/pages/home/Home.tsx'],
      'src/pages/home/Home.tsx': ['src/widgets/pricing/Toggle.tsx'],
    })
    expect(dependencyView(snapshot)).toEqual([{ from: 'home', to: 'home.pricing', imports: 1 }])
    expect(fileLinks(snapshot, 'src/pages/home/Home.tsx')).toEqual({
      zones: ['home'],
      sameZone: ['src/pages/home/Hero.tsx'],
      imports: ['src/widgets/pricing/Toggle.tsx'],
      importedBy: ['src/pages/home/Hero.tsx'],
    })
    expect(fileLinks(snapshot, 'README.md')).toEqual({
      zones: [],
      sameZone: [],
      imports: [],
      importedBy: [],
    })
  })

  it('has no index without a zone map', () => {
    const bare = TestRepo.create().write('README.md', '# Bare\n')
    try {
      bare.commitAll('docs: readme')
      const snapshot = collectSnapshot(bare.root)
      expect(snapshot.index).toBeUndefined()
      expect(snapshot.files).toEqual({})
      expect(indexView(snapshot).manifest).toBe('missing')
    } finally {
      bare.remove()
    }
  })
})
