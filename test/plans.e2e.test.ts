import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FakeServer, PROJECT } from './support/fake-server.js'
import { TestRepo } from './support/test-repo.js'

const ZONES = 'version: 1\nzones:\n  auth.api:\n    title: Auth API\n    paths: [src/auth/**]\n'
const PLAN = `version: 1
line: backend
checkpoints:
  auth:
    title: Auth API
    items:
      - zone: auth.api
        owner: test@example.com
`
const RULES = 'version: 1\nrules:\n  layers:\n    title: Layers\n    kind: architecture\n'
const EXCEPTIONS = `version: 1
exceptions:
  - id: legacy
    rule: layers
    zones: [auth.api]
    reason: Old login
    author: test@example.com
    date: 2026-10-05
`

const free = {
  plan: 'free',
  status: 'free',
  features: [],
  seats: 3,
  developers: 2,
  trialEndsAt: '2026-01-05',
  paidUntil: null,
  graceEndsAt: null,
  source: 'license',
}

describe('plans of the team server', () => {
  let server: FakeServer
  let repo: TestRepo

  beforeEach(async () => {
    server = new FakeServer()
    await server.start()
    repo = TestRepo.create()
      .write('.beacons/zones.yml', ZONES)
      .write('.beacons/checkpoints.yml', PLAN)
      .write('.beacons/rules.yml', RULES)
      .write('.beacons/exceptions.yml', EXCEPTIONS)
      .write(
        '.beacons/config.yml',
        `version: 1\nserver:\n  url: ${server.url}\n  project: ${PROJECT}\n`
      )
    repo.commitAll('chore: plan')
    await repo.runAsync(['login', '--no-browser'])
  })

  afterEach(async () => {
    await server.stop()
    repo.remove()
  })

  it('tells the plan and refuses what the free plan lacks', async () => {
    server.plan = free
    const synced = await repo.runAsync(['sync'])
    expect(synced.out).toContain(
      'Тариф Free — без кросс-аудита, проверки подписей, реестра исключений и аналитики · разработчиков 2 из 3'
    )
    expect(repo.run(['checkpoints', '--team']).out).toContain('Тариф Free')

    for (const command of [
      ['audit', 'start', 'auth'],
      ['sign', 'auth', 'agree'],
      ['exception', 'approve', 'legacy'],
    ]) {
      const refused = await repo.runAsync(command)
      expect(refused.code).toBe(1)
      expect(refused.err).toMatch(/доступен на тарифе Team \(сейчас Free\)/)
    }
    expect(server.received).toEqual([])
  })

  it('lets the Team plan through and warns an outdated client', async () => {
    server.plan = { ...free, plan: 'team', status: 'trial', features: ['cross-audit'], seats: null }
    server.minClientVersion = '99.0.0'
    const synced = await repo.runAsync(['sync'])
    expect(synced.out).toContain('Тариф Team — пробный период до 2026-01-05')
    expect(synced.out).toMatch(/⚠ Сервер 2\.0\.0 ждёт beacon 99\.0\.0 или новее \(у вас [\d.]+\)/)
    expect((await repo.runAsync(['audit', 'start', 'auth'])).out).toContain('✓ Раунд 1')

    // An older server says nothing about plans or versions: nothing is refused.
    server.plan = undefined
    server.minClientVersion = undefined
    server.revision++
    const older = await repo.runAsync(['sync'])
    expect(older.out).not.toContain('Тариф')
    expect(older.out).not.toContain('⚠')
  })
})
