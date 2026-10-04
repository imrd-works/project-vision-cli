import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { collectSnapshot, historyView, indexView, timelineView } from '../src/lib/index.js'

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
    expect(indexView(snapshot).index?.zones).toContainEqual(
      expect.objectContaining({ id: 'home.pricing', state: 'completed' })
    )
    expect(historyView(snapshot, '2026-10-01')?.markedCommits).toBe(1)
    const result = timelineView([snapshot], '2026-10-01')
    expect(result).toMatchObject({
      timeline: { lines: [{ line: 'web', checkpoints: [{ id: 'pricing', state: 'ready' }] }] },
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
