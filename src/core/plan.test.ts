import { describe, expect, it } from 'vitest'

import { describePlan, isOlder, missingFeature, type Plan } from './plan.js'

const team: Plan = {
  plan: 'team',
  status: 'trial',
  features: ['cross-audit', 'signatures', 'exception-registry', 'insights'],
  seats: null,
  developers: 4,
  trialEndsAt: '2027-01-05',
  paidUntil: null,
  graceEndsAt: null,
  source: 'license',
}
const free: Plan = { ...team, plan: 'free', status: 'free', features: [], seats: 3 }

describe('plan', () => {
  it('tells the plan, its period and the seats', () => {
    expect(describePlan(team)).toBe(
      'Тариф Team — пробный период до 2027-01-05 · разработчиков 4 из ∞'
    )
    expect(describePlan({ ...team, status: 'active', paidUntil: '2027-12-31', seats: 10 })).toBe(
      'Тариф Team — по лицензии до 2027-12-31 · разработчиков 4 из 10'
    )
    expect(describePlan({ ...team, status: 'active', source: 'admin' })).toContain(
      'оплачен, без срока'
    )
    expect(
      describePlan({ ...team, status: 'grace', paidUntil: '2026-10-01', graceEndsAt: '2026-10-15' })
    ).toContain('оплата закончилась 2026-10-01, льготный период до 2026-10-15')
    expect(describePlan(free)).toBe(
      'Тариф Free — без кросс-аудита, проверки подписей, реестра исключений и аналитики · разработчиков 4 из 3'
    )
  })

  it('refuses what the plan lacks and lets an older server be', () => {
    expect(missingFeature(team, 'cross-audit')).toBeUndefined()
    expect(missingFeature(undefined, 'cross-audit')).toBeUndefined()
    expect(missingFeature(free, 'exception-registry')).toBe(
      'реестр исключений доступен на тарифе Team (сейчас Free): обратитесь к владельцу проекта'
    )
  })

  it('compares versions', () => {
    expect(isOlder('0.1.0', '0.2.0')).toBe(true)
    expect(isOlder('0.10.0', '0.9.9')).toBe(false)
    expect(isOlder('1.0.0-beta.1', '1.0.0')).toBe(false)
    expect(isOlder('1.0', '1.0.1')).toBe(true)
  })
})
