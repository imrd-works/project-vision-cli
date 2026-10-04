import { describe, expect, it } from 'vitest'

import { reportLine, type ZoneFacts } from './checkpoint-report.js'
import type { CheckpointPlan } from './checkpoints.js'
import { type Activity, buildTimeline, todoFor } from './timeline.js'

const FACTS: Record<string, ZoneFacts> = {
  'ui.button': { title: 'Button', state: 'completed', architectureErrors: 0 },
  'ui.input': { title: 'Input', state: 'completed', architectureErrors: 2 },
  'auth.page': { title: 'Login page', state: 'active', architectureErrors: 0 },
  'auth.api': { title: 'Auth API', state: 'completed', architectureErrors: 0 },
  'billing.api': { title: 'Billing API', state: 'active', architectureErrors: 0 },
}
const facts = (zone: string) => FACTS[zone]
const options = { today: '2026-10-23', extendDays: 7 }

const frontend: CheckpointPlan = {
  line: 'frontend',
  title: 'Frontend',
  checkpoints: [
    {
      id: 'ui-kit',
      title: 'UI kit',
      deadline: '2026-10-20',
      after: [],
      dependsOn: [],
      items: [{ zone: 'ui.button' }, { zone: 'ui.input', owner: 'ann@x.io' }],
      debts: [],
    },
    {
      id: 'login',
      title: 'Login',
      after: ['ui-kit'],
      dependsOn: ['backend:auth-api', 'backend:ghost'],
      items: [{ zone: 'auth.page', owner: 'bob@x.io' }],
      debts: [],
    },
    {
      id: 'profile',
      title: 'Profile',
      after: [],
      dependsOn: [],
      items: [{ id: 'copy', check: 'Texts', done: { date: '2026-10-01' } }],
      closed: { date: '2026-10-10', conditional: true },
      debts: [
        {
          id: 'no-api',
          reason: 'Backend busy',
          owner: 'ann@x.io',
          created: '2026-10-10',
          deadline: '2026-10-15',
          waitsFor: 'backend:auth-api',
          zones: ['auth.page'],
        },
        {
          id: 'billing',
          reason: 'Billing later',
          owner: 'ann@x.io',
          created: '2026-10-10',
          deadline: '2026-11-01',
          waitsFor: 'backend:billing',
          zones: [],
        },
      ],
    },
  ],
}

const backend: CheckpointPlan = {
  line: 'backend',
  title: 'Backend',
  checkpoints: [
    {
      id: 'auth-api',
      title: 'Auth API',
      after: [],
      dependsOn: [],
      items: [{ zone: 'auth.api' }],
      closed: { date: '2026-10-20', conditional: false },
      debts: [],
    },
    {
      id: 'billing',
      title: 'Billing',
      after: [],
      dependsOn: [],
      items: [{ zone: 'billing.api', owner: 'cid@x.io' }],
      debts: [],
    },
  ],
}

const activity: Activity = {
  last: (email, zones) => {
    if (email === 'bob@x.io') return zones.length > 0 ? '2026-10-12' : '2026-10-12'
    if (email === 'cid@x.io') return '2026-10-22'
    return undefined
  },
  durations: [1, 2],
}

describe('reportLine', () => {
  const line = reportLine(frontend, facts, options)
  const [uiKit, login, profile] = line.checkpoints

  it('closes zone items on completion with clean architecture', () => {
    expect(uiKit?.items.map((item) => item.done)).toEqual([true, false])
    expect(uiKit).toMatchObject({ state: 'open', late: true, progress: { done: 1, total: 2 } })
    expect(login?.dependsOn).toEqual(['backend:auth-api', 'backend:ghost'])
  })

  it('keeps a conditionally closed checkpoint with open debt and extends overdue debt', () => {
    expect(profile).toMatchObject({ state: 'conditional', late: false })
    expect(profile?.debts[0]).toMatchObject({
      overdue: true,
      extensions: 2,
      effectiveDeadline: '2026-10-29',
      open: true,
    })
    expect(line.progress).toEqual({ done: 2, total: 4 })
  })
})

describe('buildTimeline', () => {
  const timeline = buildTimeline(
    [reportLine(frontend, facts, options), reportLine(backend, facts, options)],
    activity,
    { today: options.today, stagnationDays: 3 }
  )
  const find = (ref: string) =>
    timeline.lines.flatMap((line) => line.checkpoints).find((c) => c.ref === ref)

  it('links lines, finds stoppers and warns about missing ones', () => {
    // auth-api is closed, so login waits only for nothing it can find; billing blocks a debt.
    expect(find('frontend:login')?.blockedBy).toEqual([])
    expect(find('backend:billing')?.blocks).toEqual(['frontend:profile'])
    expect(timeline.problems.map((p) => p.message).join(',')).toContain(
      'frontend:login → backend:ghost'
    )
  })

  it('raises debts whose blocker is done and spots stuck developers', () => {
    expect(find('frontend:profile')?.debts.map((debt) => debt.unblocked)).toEqual([true, false])
    expect(find('frontend:login')?.stagnant).toEqual([
      { owner: 'bob@x.io', since: '2026-10-12', workingDays: 9 },
    ])
    expect(find('backend:billing')?.stagnant).toEqual([])
  })

  it('builds a personal list, priority debts first', () => {
    const todo = todoFor(timeline, 'ANN@x.io')
    expect(todo.debts.map((debt) => debt.id)).toEqual(['no-api', 'billing'])
    expect(todo.items.map((item) => item.checkpoint)).toEqual(['frontend:ui-kit'])
    expect(todoFor(timeline, 'bob@x.io').stagnant).toEqual([
      { checkpoint: 'frontend:login', since: '2026-10-12', workingDays: 9 },
    ])
  })

  it('raises the stagnation threshold to twice the median completion time', () => {
    const slow = { ...activity, durations: [4, 5, 6, 7, 8] }
    const withHistory = buildTimeline([reportLine(frontend, facts, options)], slow, {
      today: options.today,
      stagnationDays: 3,
    })
    expect(withHistory.stagnationDays).toBe(12)
  })
})
