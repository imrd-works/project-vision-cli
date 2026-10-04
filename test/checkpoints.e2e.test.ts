import { get } from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startServer } from '../src/commands/serve.js'

import { TestRepo } from './support/test-repo.js'

const FRONT_ZONES = `version: 1
zones:
  ui.button:
    title: Button
    paths: [src/ui/button/**]
  ui.input:
    title: Input
    paths: [src/ui/input/**]
  auth.page:
    title: Login page
    paths: [src/pages/login/**]
`

const FRONT_PLAN = `# The frontend plan — keep this comment
version: 1
line: frontend
title: Frontend
checkpoints:
  ui-kit:
    title: UI kit
    items:
      - zone: ui.button
      - zone: ui.input
        owner: ann@x.io
      - id: design
        check: Approved by the designer
  login:
    title: Login
    after: [ui-kit]
    dependsOn: [backend:auth-api]
    items:
      - zone: auth.page
        owner: ann@x.io
`

const BACK_ZONES =
  'version: 1\nzones:\n  auth.api:\n    title: Auth API\n    paths: [src/auth/**]\n'
const BACK_PLAN = `version: 1
line: backend
checkpoints:
  auth-api:
    title: Auth API
    items:
      - zone: auth.api
`

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () => {
        resolve(JSON.parse(body))
      })
    }).on('error', reject)
  })
}

describe('checkpoints', () => {
  let front: TestRepo
  let back: TestRepo

  beforeEach(() => {
    front = TestRepo.create()
      .write('.beacons/zones.yml', FRONT_ZONES)
      .write('.beacons/checkpoints.yml', FRONT_PLAN)
      .write('src/ui/button/Button.tsx', 'export const Button = 1\n')
      .write('src/ui/input/Input.tsx', 'export const Input = 1\n')
      .write('src/pages/login/Login.tsx', 'export const Login = 1\n')
    front.git('config', 'user.email', 'ann@x.io')
    front.commitAll(
      'feat(ui): button done [BEACON: ui.button completed] [BEACON: ui.input] [BEACON: auth.page]'
    )
    back = TestRepo.create()
      .write('.beacons/zones.yml', BACK_ZONES)
      .write('.beacons/checkpoints.yml', BACK_PLAN)
      .write('src/auth/api.ts', 'export const api = 1\n')
    back.commitAll('feat(auth): api [BEACON: auth.api]')
  })

  afterEach(() => {
    front.remove()
    back.remove()
  })

  it('shows lines, links across repositories and stoppers', () => {
    const result = front.run(['checkpoints', '--with', back.root])
    expect(result.code).toBe(0)
    expect(result.out).toContain('Frontend (frontend) — пунктов 1 из 4, 25%')
    expect(result.out).toContain('○ ui-kit  UI kit — открыт, 1/3')
    expect(result.out).toContain('⧗ ждёт: backend:auth-api')
    expect(result.out).toContain('⛔ стопер — его ждут: frontend:login')
    // Without the backend repository the link cannot be resolved.
    expect(front.run(['checkpoints']).out).toContain('связь frontend:login → backend:auth-api')
  })

  it('explains a missing or broken plan', () => {
    front.git('rm', '-q', '-f', '.beacons/checkpoints.yml')
    expect(front.run(['checkpoints']).out).toContain('Чекпоинтов нет')
    front.write(
      '.beacons/checkpoints.yml',
      'version: 1\nline: x\ncheckpoints:\n  a:\n    title: A\n    items:\n      - zone: ghost\n'
    )
    expect(front.run(['checkpoints']).err).toContain('зоны "ghost"')
  })

  it('records ticks and closures in the plan, keeping its comments', () => {
    expect(front.run(['checkpoint', 'close', 'ui-kit']).err).toContain(
      'Не все пункты закрыты: ui.input, design'
    )
    expect(front.run(['checkpoint', 'tick', 'ui-kit', 'design']).out).toContain(
      'пункт «design» отмечен'
    )
    expect(front.run(['checkpoint', 'tick', 'ui-kit', 'ui.input']).err).toContain(
      'закрываются сами'
    )

    expect(front.run(['checkpoint', 'close', 'ui-kit', '--conditional']).err).toContain('--reason')
    const closed = front.run([
      'checkpoint',
      'close',
      'ui-kit',
      '--conditional',
      '--reason',
      'Input waits for the API',
      '--deadline',
      '2026-01-10',
      '--waits-for',
      'backend:auth-api',
    ])
    expect(closed.out).toContain(
      '◐ ui-kit закрыт условно, техдолг ui-kit-debt: ann@x.io, до 2026-01-10'
    )
    const plan = front.read('.beacons/checkpoints.yml')
    expect(plan).toContain('# The frontend plan — keep this comment')
    expect(plan).toMatch(/done: \{ date: \d{4}-\d{2}-\d{2}, by: ann@x\.io \}/)
    expect(plan).toContain('zones:\n          - ui.input')
    expect(front.run(['checkpoint', 'close', 'ui-kit']).err).toContain('уже закрыт')

    const listed = front.run(['checkpoints'])
    expect(listed.out).toContain('◐ ui-kit  UI kit — закрыт условно')
    expect(listed.out).toMatch(
      /⚑ техдолг ui-kit-debt: Input waits for the API — ann@x\.io, до \d{4}-\d{2}-\d{2} \(просрочен, продлён ×\d+\)/
    )

    expect(front.run(['debt', 'close', 'ui-kit', 'ui-kit-debt']).out).toContain(
      'техдолг ui-kit-debt закрыт'
    )
    expect(front.run(['debt', 'close', 'ui-kit', 'ui-kit-debt']).err).toContain('уже закрыт')
    expect(front.run(['checkpoints']).out).toContain('● ui-kit  UI kit — закрыт')
    expect(front.run(['checkpoint', 'oops']).code).toBe(2)
    expect(front.run(['debt', 'close', 'nope', 'x']).err).toContain('нет техдолга')
  })

  it('puts debt whose blocker is done first in the todo list', () => {
    front.run(['checkpoint', 'tick', 'ui-kit', 'design'])
    front.run([
      'checkpoint',
      'close',
      'ui-kit',
      '--conditional',
      '--reason',
      'API',
      '--deadline',
      '2099-01-01',
      '--waits-for',
      'backend:auth-api',
    ])
    back.commitAll('feat(auth): api done [BEACON: auth.api completed]')
    back.run(['checkpoint', 'close', 'auth-api'])

    const list = front.run(['todo', '--with', back.root])
    expect(list.out).toContain('Задачи ann@x.io:')
    expect(list.out).toContain(
      '1. ★ техдолг ui-kit-debt (frontend:ui-kit): API, до 2099-01-01 — ПРИОРИТЕТ: backend:auth-api готов'
    )
    expect(list.out).toContain('• auth.page (frontend:login): Login page')
    expect(front.run(['todo', '--owner', 'nobody@x.io']).out).toContain('Ничего не висит')
  })

  it('rejects commits outside debt zones over the debt limit', () => {
    front.write('.beacons/config.yml', 'version: 1\ntechDebt:\n  limitPerDeveloper: 0\n')
    front.run(['checkpoint', 'tick', 'ui-kit', 'design'])
    front.run([
      'checkpoint',
      'close',
      'ui-kit',
      '--conditional',
      '--reason',
      'Later',
      '--deadline',
      '2099-01-01',
    ])
    front.commitAll('chore(plan): close ui kit conditionally')

    const hook = (message: string) => {
      front.git('add', '-A')
      front.write('.git/COMMIT_EDITMSG', message)
      return front.run(['hook', 'commit-msg', '.git/COMMIT_EDITMSG'])
    }
    front.write('src/pages/login/Login.tsx', 'export const Login = 2\n')
    const rejected = hook('feat(auth): next task [BEACON: auth.page]\n')
    expect(rejected.code).toBe(1)
    expect(rejected.err).toContain('превышен лимит техдолга')
    expect(rejected.err).toContain('Коммит трогает зоны вне техдолга: auth.page')

    expect(
      hook('feat(auth): urgent [BEACON: auth.page] [DEBT-OVERRIDE: prod is down]\n').code
    ).toBe(0)

    front.git('reset', '-q', '--hard')
    front.write('src/ui/input/Input.tsx', 'export const Input = 2\n')
    expect(hook('fix(ui): pay the debt [BEACON: ui.input]\n').code).toBe(0)
  })

  it('serves the timeline and a todo list over the local API', async () => {
    const server = await startServer(front.root, {
      port: 0,
      host: '127.0.0.1',
      origins: [],
      with: [back.root],
    })
    try {
      expect(await getJson(`${server.url}/api/timeline`)).toMatchObject({
        timeline: {
          lines: [
            { line: 'frontend' },
            { line: 'backend', checkpoints: [{ blocks: ['frontend:login'] }] },
          ],
        },
      })
      expect(await getJson(`${server.url}/api/todo`)).toMatchObject({
        owner: 'ann@x.io',
        items: [{ zone: 'ui.input' }, { zone: 'auth.page' }],
      })
    } finally {
      await server.close()
    }
  })

  it('reports late checkpoints, overdue and unblocked debt, stuck developers and gaps', () => {
    const stuck = TestRepo.create()
    try {
      stuck
        .write('.beacons/zones.yml', FRONT_ZONES)
        .write('src/pages/login/Login.tsx', 'export const Login = 1\n')
        .write('src/ui/input/Input.tsx', 'export const Input = 1\n')
      stuck.git('config', 'user.email', 'bob@x.io')
      stuck.commitAll('feat(auth): start [BEACON: auth.page]', '2025-01-06')
      stuck.commitAll('feat(ui): input [BEACON: ui.input]', '2025-01-20')
      stuck.write(
        '.beacons/checkpoints.yml',
        `version: 1
line: frontend
checkpoints:
  login:
    title: Login
    deadline: 2025-02-01
    items:
      - zone: auth.page
        owner: bob@x.io
      - id: copy
        check: Texts
        done: { date: 2025-01-10, by: ann@x.io }
  profile:
    title: Profile
    items:
      - id: avatar
        check: Avatar
    closed: { date: 2025-01-15, conditional: true }
    debts:
      - id: wait-login
        reason: Needs login
        owner: bob@x.io
        created: 2025-01-15
        deadline: 2025-01-20
        waitsFor: login
      - id: done-already
        reason: Old
        owner: bob@x.io
        created: 2025-01-15
        deadline: 2025-01-20
        closed: 2025-01-18
`
      )
      const listed = stuck.run(['checkpoints']).out
      expect(listed).toContain('срок 2025-02-01 — просрочен')
      expect(listed).toContain('✓ copy  Texts (2025-01-10, ann@x.io)')
      expect(listed).toMatch(
        /⏸ застой: bob@x\.io — \d+ раб\. дн\. без коммитов в своих зонах \(с 2025-01-06\)/
      )
      expect(listed).toContain('· ждёт frontend:login')
      expect(listed).toContain('✓ техдолг done-already закрыт 2025-01-18')
      expect(listed).toContain('⛔ стопер — его ждут: frontend:profile')

      const list = stuck.run(['todo']).out
      expect(list).toMatch(/1\. ⚑ техдолг wait-login \(frontend:profile\)/)
      expect(list).toContain('нужна помощь?')

      const history = stuck.run(['history']).out
      expect(history).toContain('Провалы (рабочие дни без коммитов в зонах):')
      expect(history).toContain('2025-01-07 — 2025-01-17: 9 дней')
    } finally {
      stuck.remove()
    }
  })
})
