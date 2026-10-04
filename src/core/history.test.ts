import { describe, expect, it } from 'vitest'

import { buildHistory, parseCommitLog } from './history.js'
import { parseManifest } from './manifest.js'

const manifestResult = parseManifest(
  'version: 1\nzones:\n  auth:\n    title: A\n    formerly: [login]\n  users:\n    title: U\n'
)
if (!manifestResult.ok) throw new Error('invalid test manifest')
const manifest = manifestResult.manifest

function entry(sha: string, name: string, date: string, body: string): string {
  return [sha, name, `${name.toLowerCase()}@x.io`, date, body].join('\u{1F}')
}

// Newest first, as git log prints them.
const LOG = [
  entry('e5', 'Ann', '2026-09-21T12:00:00+03:00', 'fix(users): x [BEACON: users]'),
  entry('d4', 'Bob', '2026-09-14T10:00:00+03:00', 'feat(auth): done\n\n[BEACON: auth completed]'),
  entry('c3', 'Ann', '2026-09-08T10:00:00+03:00', 'chore: deps'),
  entry(
    'b2',
    'Ann',
    '2026-09-08T09:00:00+03:00',
    'feat(auth): login [BEACON: login] [BEACON: users]'
  ),
  entry('a1', 'Bob', '2026-09-07T09:00:00+03:00', 'feat(auth): init [BEACON: auth]'),
].join('\n\u{1E}')

describe('parseCommitLog', () => {
  it('splits records and reads beacons from the body', () => {
    const commits = parseCommitLog(`${LOG}\n\u{1E}`)
    expect(commits).toHaveLength(5)
    expect(commits[1]).toMatchObject({
      sha: 'd4',
      author: { name: 'Bob', email: 'bob@x.io' },
      subject: 'feat(auth): done',
      beacons: [{ id: 'auth', completed: true }],
    })
  })
})

describe('buildHistory', () => {
  const history = buildHistory(parseCommitLog(LOG), manifest, { gapDays: 3, today: '2026-09-23' })

  it('groups commits by zone with authors, former IDs included', () => {
    expect(history.totalCommits).toBe(5)
    expect(history.markedCommits).toBe(4)
    expect(history.zones).toEqual([
      {
        zone: 'auth',
        commits: 3,
        authors: [
          { name: 'Bob', email: 'bob@x.io', commits: 2 },
          { name: 'Ann', email: 'ann@x.io', commits: 1 },
        ],
        last: { sha: 'd4', subject: 'feat(auth): done', date: '2026-09-14T10:00:00+03:00' },
      },
      expect.objectContaining({ zone: 'users', commits: 2 }),
    ])
  })

  it('builds daily dynamics with cumulative completed zones', () => {
    const { days } = history.dynamics
    expect(days[0]).toEqual({ date: '2026-09-07', commits: 1, completed: 0 })
    expect(days.find((day) => day.date === '2026-09-14')).toEqual({
      date: '2026-09-14',
      commits: 1,
      completed: 1,
    })
    expect(days.at(-1)).toEqual({ date: '2026-09-23', commits: 0, completed: 1 })
  })

  it('finds gaps in working days, skipping weekends', () => {
    // 2026-09-09 (Wed) … 2026-09-11 (Fri): 3 working days; 2026-09-15 … 2026-09-18 (Tue–Fri): 4.
    expect(history.dynamics.gaps).toEqual([
      { from: '2026-09-09', to: '2026-09-11', workingDays: 3 },
      { from: '2026-09-15', to: '2026-09-18', workingDays: 4 },
    ])
  })

  it('is empty without marked commits', () => {
    expect(buildHistory([], manifest, { gapDays: 3, today: '2026-09-23' })).toEqual({
      totalCommits: 0,
      markedCommits: 0,
      zones: [],
      dynamics: { days: [], gaps: [] },
    })
  })
})
