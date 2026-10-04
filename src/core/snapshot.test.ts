import { describe, expect, it } from 'vitest'

import type { CommitRecord } from './history.js'
import type { ProjectIndex } from './project-index.js'
import {
  auditView,
  historyView,
  indexView,
  type RepositorySnapshot,
  timelineView,
} from './snapshot.js'

const ZONES = 'version: 1\nzones:\n  auth.api:\n    title: Auth API\n    paths: [src/auth/**]\n'

const BACK_PLAN = `version: 1
line: backend
checkpoints:
  auth-api:
    title: Auth API
    items:
      - zone: auth.api
        owner: bob@x.io
`

const FRONT_ZONES = 'version: 1\nzones:\n  auth.page:\n    title: Login page\n'
const FRONT_PLAN = `version: 1
line: frontend
checkpoints:
  login:
    title: Login
    dependsOn: [backend:auth-api]
    items:
      - zone: auth.page
        owner: ann@x.io
`

function index(zones: ProjectIndex['zones']): ProjectIndex {
  return {
    version: 1,
    zones,
    files: [],
    coverage: { sourceFiles: 0, zonedSourceFiles: 0 },
    unzonedDirs: [],
    tree: { name: '', path: '', files: 0, zonedFiles: 0, zones: [], children: [] },
    problems: [],
  }
}

function commit(sha: string, email: string, date: string, beacon: string): CommitRecord {
  return {
    sha,
    author: { name: email, email },
    date: `${date}T10:00:00+03:00`,
    subject: `feat: ${beacon}`,
    beacons: [{ id: beacon, completed: false }],
  }
}

function snapshot(overrides: Partial<RepositorySnapshot>): RepositorySnapshot {
  return {
    format: 1,
    name: 'demo',
    generatedAt: '2026-10-01T00:00:00.000Z',
    files: {},
    commits: [],
    ...overrides,
  }
}

const backend = snapshot({
  name: 'project-vision-backend',
  files: { zones: ZONES, checkpoints: BACK_PLAN, config: 'version: 1\nstagnation:\n  days: 2\n' },
  index: index([
    {
      id: 'auth.api',
      title: 'Auth API',
      tags: [],
      paths: ['src/auth/**'],
      state: 'active',
      files: [],
      regions: [],
    },
  ]),
  commits: [commit('b1', 'bob@x.io', '2026-09-24', 'auth.api')],
})

const frontend = snapshot({
  name: 'project-vision-frontend',
  files: { zones: FRONT_ZONES, checkpoints: FRONT_PLAN },
  index: index([
    {
      id: 'auth.page',
      title: 'Login page',
      tags: [],
      paths: [],
      state: 'planned',
      files: [],
      regions: [],
    },
  ]),
})

describe('indexView', () => {
  it('shows the index only with a valid zone map', () => {
    expect(indexView(backend)).toMatchObject({
      project: { name: 'project-vision-backend' },
      manifest: 'ok',
      problems: [],
      index: { zones: [{ id: 'auth.api' }] },
    })
    expect(indexView(snapshot({}))).toMatchObject({ manifest: 'missing', index: undefined })
    expect(
      indexView(snapshot({ files: { zones: 'version: 2\n' }, index: index([]) }))
    ).toMatchObject({
      manifest: 'invalid',
      problems: [expect.objectContaining({ severity: 'error' })],
      index: undefined,
    })
  })
})

describe('historyView', () => {
  it('computes the dynamics up to the given day', () => {
    const history = historyView(backend, '2026-09-30')
    expect(history).toMatchObject({ totalCommits: 1, markedCommits: 1 })
    expect(history?.dynamics.days.at(-1)?.date).toBe('2026-09-30')
    expect(historyView(snapshot({}), '2026-09-30')).toBeUndefined()
  })
})

describe('timelineView', () => {
  it('links lines of several repositories and computes stagnation for the day', () => {
    const result = timelineView([backend, frontend], '2026-10-05')
    if (!('timeline' in result)) throw new Error('expected a timeline')
    const [back, front] = result.timeline.lines
    expect(back?.checkpoints[0]).toMatchObject({
      ref: 'backend:auth-api',
      state: 'open',
      blocks: ['frontend:login'],
      // The last commit in the zone was 7 working days before; the backend allows 2.
      stagnant: [{ owner: 'bob@x.io', since: '2026-09-24', workingDays: 7 }],
    })
    expect(front?.checkpoints[0]).toMatchObject({ blockedBy: ['backend:auth-api'] })
    expect(result.timeline.problems).toEqual([])
  })

  it('keeps the other lines when one plan is broken', () => {
    const broken = snapshot({
      name: 'broken',
      files: { zones: ZONES, checkpoints: 'version: 2\n' },
    })
    const result = timelineView([broken, frontend], '2026-10-05')
    if (!('timeline' in result)) throw new Error('expected a timeline')
    expect(result.timeline.lines.map((line) => line.line)).toEqual(['frontend'])
    expect(result.timeline.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', message: expect.stringMatching(/^broken: /) }),
      ])
    )
    expect(timelineView([broken], '2026-10-05')).toEqual({
      problems: expect.arrayContaining([expect.objectContaining({ severity: 'error' })]),
    })
  })

  it('reports a missing plan', () => {
    expect(timelineView([], '2026-10-05')).toEqual({ missing: true })
    expect(timelineView([snapshot({ files: { zones: ZONES } })], '2026-10-05')).toEqual({
      missing: true,
    })
  })
})

describe('auditView', () => {
  it('gives the audits of the line, by checkpoint', () => {
    const audited = {
      ...backend,
      audits: [
        {
          path: '.beacons/audits/auth-api/round-1/bob-x-io.md',
          text: '---\nauthor: bob@x.io\n---\n### [low] A\n',
        },
      ],
    }
    expect(auditView(audited)).toMatchObject({
      line: 'backend',
      audits: [
        { checkpoint: 'auth-api', rounds: [{ round: 1, reports: [{ author: 'bob@x.io' }] }] },
      ],
    })
    // Without a plan there is no line, and audit files mean nothing.
    expect(auditView({ ...audited, files: { zones: ZONES } })).toEqual({ audits: [] })
  })
})
