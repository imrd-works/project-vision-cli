import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FakeServer, PROJECT } from './support/fake-server.js'
import { TestRepo } from './support/test-repo.js'

const ZONES = `version: 1
zones:
  auth:
    title: Auth
    paths: [src/auth/**]
  billing:
    title: Billing
    paths: [src/billing/**]
`

const RULES = `version: 1
rules:
  ui-names:
    title: Components in PascalCase
    kind: naming
    naming:
      - paths: ['src/**/ui/*.tsx']
        pattern: ^[A-Z]
`

const LOGIN =
  'export function login(user) {\n  // checks the password\n  return check(user, "ok")\n}\n'

function person(name: string, emails: string[], telegram: string | null = null): object {
  return {
    userId: name,
    name,
    role: 'member',
    emails,
    contacts: { telegram, phone: null, email: null },
    identities: [],
  }
}

describe('ownership and the registry', () => {
  let server: FakeServer
  let repo: TestRepo

  beforeEach(async () => {
    server = new FakeServer()
    await server.start()
    server.repositories = [
      {
        id: 'r1',
        name: 'backend',
        url: 'git@github.com:org/backend.git',
        defaultBranch: 'main',
        status: 'ready',
        syncedAt: null,
        branches: 1,
      },
    ]
    server.people = [
      person('Ann Lee', ['ann@x.io'], '@ann_lee'),
      person('Tess Test', ['test@example.com']),
    ]
    server.owners = [
      {
        ref: 'backend:auth',
        repository: 'backend',
        zone: 'auth',
        title: 'Auth',
        owner: 'ann@x.io',
        proxies: [],
        version: 1,
      },
      {
        ref: 'backend:billing',
        repository: 'backend',
        zone: 'billing',
        title: 'Billing',
        owner: null,
        proxies: [],
        version: 0,
      },
    ]
    repo = TestRepo.create()
      .write('.beacons/zones.yml', ZONES)
      .write('.beacons/rules.yml', RULES)
      .write(
        '.beacons/config.yml',
        `version: 1\nserver:\n  url: ${server.url}\n  project: ${PROJECT}\n`
      )
      .write('src/auth/login.ts', LOGIN)
      .write('src/billing/pay.ts', 'export const pay = () => 1\n')
    repo.git('remote', 'add', 'origin', 'https://github.com/org/backend')
    repo.commitAll('chore: start')
    repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  })

  afterEach(async () => {
    await server.stop()
    repo.remove()
  })

  /** Syncs as Ann, then forgets the token: the author of commits here is Tess. */
  async function syncAndLogout(): Promise<void> {
    await repo.runAsync(['login', '--no-browser'])
    await repo.runAsync(['sync'])
    await repo.runAsync(['logout'])
  }

  function commitMsg(message = 'fix: login\n\n[BEACON: auth]\n'): {
    code: number
    out: string
    err: string
    message: string
  } {
    const file = path.join(repo.root, '.git', 'COMMIT_EDITMSG')
    writeFileSync(file, message)
    return { ...repo.run(['hook', 'commit-msg', file]), message: repo.read('.git/COMMIT_EDITMSG') }
  }

  it("keeps someone else's zone logic to its owner, before the edit and at the commit", async () => {
    await syncAndLogout()

    const rights = repo.run(['rights', '--json'])
    expect(JSON.parse(rights.out)).toMatchObject({
      repository: 'backend',
      person: { name: 'Tess Test' },
      zones: [
        {
          zone: 'auth',
          allowed: false,
          owner: { email: 'ann@x.io', name: 'Ann Lee', contacts: { telegram: '@ann_lee' } },
        },
        { zone: 'billing', allowed: true, via: 'free', owner: null },
      ],
    })
    expect(repo.run(['rights']).out).toContain('✖ auth — владелец Ann Lee <ann@x.io> (@ann_lee)')

    const gate = repo.run(['gate', 'src/auth/login.ts', 'src/billing/pay.ts'])
    expect(gate.code).toBe(1)
    expect(gate.err).toContain(
      '✖ src/auth/login.ts — зона auth: владелец Ann Lee <ann@x.io> (@ann_lee)'
    )
    expect(gate.err).toContain('✓ src/billing/pay.ts — зона billing: владельца нет')

    // Texts and comments are free; the logic is not.
    repo.write('src/auth/login.ts', LOGIN.replace('checks the password', 'verifies the user'))
    repo.git('add', '-A')
    expect(commitMsg().code).toBe(0)
    repo.write('src/auth/login.ts', LOGIN.replace('check(user', 'verify(user'))
    repo.git('add', '-A')
    const refused = commitMsg()
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('✖ beacon: коммит отклонён — правка логики чужих зон')
    expect(refused.err).toContain('auth — владелец Ann Lee <ann@x.io> (@ann_lee)')

    // Made with --no-verify: the push catches it.
    repo.commitAll('fix: login\n\n[BEACON: auth]')
    const head = repo.git('rev-parse', 'HEAD').trim()
    const push = repo.run(['hook', 'pre-push', 'origin'], {
      stdin: `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`,
    })
    expect(push.code).toBe(1)
    expect(push.err).toContain('в пушимых коммитах правки чужих зон без разрешения')

    // The agent's edit is judged before it is written.
    const edit = (old: string, next: string) =>
      repo.run(['gate', '--agent'], {
        stdin: JSON.stringify({
          tool_name: 'Edit',
          tool_input: {
            file_path: path.join(repo.root, 'src/auth/login.ts'),
            old_string: old,
            new_string: next,
          },
        }),
      })
    expect(edit('verify(user', 'verify(admin').out).toContain('"permissionDecision":"deny"')
    expect(edit('checks the password', 'checks it').out).toBe('')
    const agent = (input: unknown) =>
      repo.run(['gate', '--agent'], { stdin: JSON.stringify(input) })
    const file = path.join(repo.root, 'src/auth/session.ts')
    expect(
      agent({ tool_name: 'Write', tool_input: { file_path: file, content: 'export {}\n' } }).out
    ).toContain('"deny"')
    expect(
      agent({
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: path.join(repo.root, 'src/auth/login.ts'),
          edits: [{ old_string: '(user', new_string: '(admin', replace_all: true }],
        },
      }).out
    ).toContain('"deny"')
    expect(
      agent({ tool_name: 'Write', tool_input: { file_path: '/elsewhere/x.ts', content: 'x' } }).out
    ).toBe('')
    expect(
      agent({
        tool_name: 'Write',
        tool_input: { file_path: path.join(repo.root, 'src/billing/x.ts'), content: 'x' },
      }).out
    ).toBe('')
    expect(repo.run(['gate', '--agent'], { stdin: 'not json' }).out).toBe('')
    expect(repo.run(['gate']).code).toBe(2)
  })

  it('lets a grantee change the logic and records the grant in the commit', async () => {
    await repo.runAsync(['login', '--no-browser'])
    await repo.runAsync(['sync'])
    const given = await repo.runAsync([
      'grant',
      'auth',
      'test@example.com',
      '--until',
      '2099-01-01',
      '--reason',
      'Session rewrite',
    ])
    expect(given.out).toContain(
      '✓ Tess Test <test@example.com> может менять логику auth до 2099-01-01'
    )
    expect(server.received).toMatchObject([
      {
        kind: 'grant',
        key: 'backend:auth/test@example.com',
        data: { until: '2099-01-01', reason: 'Session rewrite' },
      },
    ])
    expect((await repo.runAsync(['grants'])).out).toContain(
      '✓ auth → Tess Test <test@example.com> до 2099-01-01, выдал Ann Lee <ann@x.io> (@ann_lee) — Session rewrite'
    )
    await repo.runAsync(['logout'])

    repo.write('src/auth/login.ts', LOGIN.replace('check(user', 'verify(user'))
    repo.git('add', '-A')
    const granted = commitMsg()
    expect(granted.code).toBe(0)
    expect(granted.message).toContain(
      'Beacon-Grant: auth for test@example.com by ann@x.io until 2099-01-01'
    )

    await repo.runAsync(['login', '--no-browser'])
    await repo.runAsync(['grant', 'billing', 'bob@x.io', '--until', '2020-01-01'])
    const listed = await repo.runAsync(['grants', 'billing'])
    expect(listed.out).toContain('○ billing → bob@x.io до 2020-01-01 (истёк), выдал Ann Lee')
    expect(listed.out).not.toContain('auth')
    expect((await repo.runAsync(['grants', 'nowhere'])).out).toContain('• Грантов нет')
    expect((await repo.runAsync(['grant', 'revoke', 'billing', 'bob@x.io'])).out).toContain(
      'отозван'
    )
    expect((await repo.runAsync(['grant', 'auth', 'not-an-email'])).code).toBe(2)
    expect((await repo.runAsync(['grant', 'nowhere', 'a@b.c'])).code).toBe(2)
    expect((await repo.runAsync(['grant', 'auth', 'a@b.c', '--until', 'soon'])).code).toBe(2)
    expect((await repo.runAsync(['grant', 'auth'])).code).toBe(2)
  })

  it('warns instead of blocking when asked, and explains what it cannot check', async () => {
    repo.write('src/auth/login.ts', LOGIN.replace('check(user', 'verify(user'))
    repo.git('add', '-A')
    expect(commitMsg().out).toContain(
      '⚠ beacon: нет данных о владельцах зон — выполните beacon sync'
    )
    expect(repo.run(['rights']).out).toContain('нет данных о владельцах зон')

    await syncAndLogout()
    repo.write(
      '.beacons/config.yml',
      `version: 1\nserver:\n  url: ${server.url}\n  project: ${PROJECT}\nownership:\n  enforce: warn\n`
    )
    const warned = commitMsg()
    expect(warned.code).toBe(0)
    expect(warned.out).toContain('⚠ beacon: предупреждение — правка логики чужих зон')

    // Two repositories in the project and neither is the origin: the config has to say.
    repo.git('remote', 'set-url', 'origin', 'https://github.com/org/other')
    server.repositories = [
      ...server.repositories,
      {
        id: 'r2',
        name: 'web',
        url: 'git@github.com:org/web.git',
        defaultBranch: 'main',
        status: 'ready',
        syncedAt: null,
        branches: 1,
      },
    ]
    server.revision++
    await syncAndLogout()
    expect(commitMsg().out).toContain('укажите server.repository')
  })

  it('records deviations from the rules and the owners decide on them', async () => {
    repo.write('src/auth/ui/card.tsx', 'export const card = 1\n')
    expect(repo.run(['rules']).out).toContain('ui-names  Components in PascalCase [naming]')
    const failing = repo.run(['check'])
    expect(failing.code).toBe(1)
    expect(failing.err).toContain('(правило ui-names)')

    const added = repo.run([
      'exception',
      'add',
      '--rule',
      'ui-names',
      '--zones',
      'auth',
      '--paths',
      'src/auth/ui/card.tsx',
      '--reason',
      'The card is generated by the design tool',
    ])
    expect(added.out).toContain('✓ Исключение ui-names-auth записано')
    expect(repo.read('.beacons/exceptions.yml')).toContain('author: test@example.com')
    expect(repo.run(['check']).out).toContain('по исключению ui-names-auth')
    expect(repo.run(['exceptions']).out).toContain('⏳ ui-names-auth — правило ui-names')
    expect(repo.run(['audit', '--zone', 'auth']).out).toContain(
      '## Правила архитектора и исключения'
    )

    await repo.runAsync(['login', '--no-browser'])
    await repo.runAsync(['sync'])
    const approved = await repo.runAsync(['exception', 'approve', 'ui-names-auth'])
    expect(approved.out).toContain('✓ Исключение ui-names-auth одобрено')
    expect(server.received).toMatchObject([
      { kind: 'exception-approval', key: 'backend:ui-names-auth', data: { decision: 'approved' } },
    ])
    expect(repo.run(['exceptions', '--zone', 'auth']).out).toContain('✓ одобрил ann@x.io')

    expect(
      repo.run(['exception', 'add', '--rule', 'nope', '--zones', 'auth', '--reason', 'x']).code
    ).toBe(2)
    expect((await repo.runAsync(['exception', 'approve', 'missing'])).code).toBe(2)
    const rewritten = repo.run([
      'exception',
      'add',
      '--id',
      'legacy-icons',
      '--rule',
      'ui-names',
      '--paths',
      'src/**/icons.tsx',
      '--reason',
      'Icons are generated',
      '--raw',
      'ну иконки же генерятся',
      '--checkpoint',
      'backend:auth',
    ])
    expect(rewritten.code).toBe(0)
    expect(repo.read('.beacons/exceptions.yml')).toContain('raw: ну иконки же генерятся')
    expect(
      repo.run([
        'exception',
        'add',
        '--id',
        'legacy-icons',
        '--rule',
        'ui-names',
        '--zones',
        'auth',
        '--reason',
        'x',
      ]).err
    ).toContain('уже есть')
    expect(repo.run(['exception', 'add', '--rule', 'ui-names', '--reason', 'x']).err).toContain(
      '--zones или --paths'
    )
    expect(
      repo.run(['exception', 'add', '--rule', 'ui-names', '--zones', 'ghost', '--reason', 'x']).err
    ).toContain('зон ghost нет')
    expect(repo.run(['exception']).code).toBe(2)

    const rejected = await repo.runAsync([
      'exception',
      'approve',
      'ui-names-auth',
      '--reject',
      '--comment',
      'Rename it',
    ])
    expect(rejected.out).toContain('✓ Исключение ui-names-auth отклонено')
    expect(repo.run(['exceptions']).out).toContain('✖ отклонил ann@x.io')
    expect(repo.run(['exceptions', '--zone', 'billing']).out).toContain('• Исключений нет')
    repo.write('.beacons/rules.yml', 'version: 1\n')
    expect(repo.run(['rules']).out).toContain('• Правил нет')
  })

  it('connects the agent gate to Claude Code', () => {
    expect(repo.run(['init', '--agent-hooks']).out).toContain(
      '✓ .claude/settings.json: агент проверяет чужие зоны перед каждой правкой'
    )
    expect(existsSync(path.join(repo.root, '.claude/settings.json'))).toBe(true)
    expect(repo.read('.claude/settings.json')).toContain('gate --agent')
    expect(repo.run(['init', '--agent-hooks']).out).toContain('уже подключена')
    expect(repo.read('AGENTS.md')).toContain('### Чужие зоны')
  })
})
