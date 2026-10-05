import { describe, expect, it } from 'vitest'

import { type Qa, qaBlockers, qaByCheckpoint } from './qa.js'

const qa: Qa = {
  testCases: [
    { id: '1', checkpoint: 'web:auth', zone: 'auth', title: 'Login', result: null },
    {
      id: '2',
      checkpoint: 'web:auth',
      zone: null,
      title: 'Logout',
      result: { verdict: 'passed', by: 'qa@x.io', at: '2026-10-05' },
    },
    {
      id: '3',
      checkpoint: 'web:pay',
      zone: null,
      title: 'Refund',
      result: { verdict: 'failed', by: 'qa@x.io', at: '2026-10-05' },
    },
  ],
  bugs: [
    {
      id: '7',
      title: 'No retry',
      severity: 'major',
      status: 'fixed',
      zone: 'auth',
      owner: null,
      checkpoints: ['web:auth'],
    },
    {
      id: '8',
      title: 'Old',
      severity: 'minor',
      status: 'closed',
      zone: null,
      owner: null,
      checkpoints: ['web:auth'],
    },
    {
      id: '9',
      title: 'Crash',
      severity: 'critical',
      status: 'open',
      zone: null,
      owner: null,
      checkpoints: ['web:pay'],
    },
  ],
  ready: [],
}

describe('the testers’ state', () => {
  it('names what keeps a checkpoint open', () => {
    expect(qaBlockers(qa, 'web:auth')).toEqual([
      'тест-кейс «Login» не проверен',
      'баг #7 «No retry» ждёт подтверждения тестировщика',
    ])
    expect(qaBlockers(qa, 'web:pay')).toEqual([
      'тест-кейс «Refund» не пройден',
      'баг #9 «Crash» открыт',
    ])
    expect(qaBlockers(undefined, 'web:auth')).toEqual([])
  })

  it('sums it up by checkpoint', () => {
    expect([...qaByCheckpoint(qa)]).toEqual([
      [
        'web:auth',
        ['🧪 тест-кейсы: пройдено 1/2', '🐞 баг #7 «No retry» — исправлен, ждёт подтверждения'],
      ],
      ['web:pay', ['🧪 тест-кейсы: пройдено 0/1', '🐞 баг #9 «Crash» — открыт']],
    ])
    expect(qaByCheckpoint(undefined).size).toBe(0)
  })
})
