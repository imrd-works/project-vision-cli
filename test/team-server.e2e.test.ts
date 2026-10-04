import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Operation } from '../src/core/sync.js'
import { collectSnapshot, timelineView } from '../src/lib/index.js'

import { TestRepo } from './support/test-repo.js'

const PROJECT = '54cc4d32-7588-4252-a186-832699730b5a'
const TOKEN = 'bvt_test'

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

/** A team server with just what `beacon login` and `beacon sync` use (backend: cli-auth, sync). */
class FakeServer {
  url = ''
  down = false
  rejectToken = false
  pendingClaims = 0
  expireLogins = false
  rejectOps = false
  revision = 1
  timeline: unknown = { missing: true }
  readonly received: Operation[] = []
  audits: unknown[] = []
  people: unknown[] = []
  owners: unknown[] = []
  signers: unknown = { signers: [], allowedSigners: '' }
  private readonly entities: Record<string, unknown>[] = []
  private server: Server | undefined

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.url = `http://127.0.0.1:${String(port)}`
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.down) {
      request.socket.destroy()
      return
    }
    const url = new URL(request.url ?? '/', this.url)
    const body = await readBody(request)
    const route = `${request.method ?? ''} ${url.pathname.replace('/api/v1', '')}`
    const send = (status: number, payload: unknown): void => {
      response
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify(payload))
    }
    const open: Record<string, () => [number, unknown]> = {
      'POST /cli-auth/logins': () => this.startLogin(),
      'POST /cli-auth/logins/login-1/claim': () => this.claim(body),
    }
    const authorized: Record<string, () => [number, unknown]> = {
      [`GET /projects/${PROJECT}/sync`]: () => this.pull(url.searchParams),
      [`POST /projects/${PROJECT}/sync/operations`]: () => this.push(body),
      [`POST /projects/${PROJECT}/audits/backend%3Aauth/rounds`]: () => this.startRound(),
    }
    const handler = open[route] ?? (this.authorized(request) ? authorized[route] : undefined)
    const [status, payload] = handler?.() ?? [401, { message: 'Invalid or expired access token' }]
    send(status, payload)
  }

  private authorized(request: IncomingMessage): boolean {
    return !this.rejectToken && request.headers.authorization === `Bearer ${TOKEN}`
  }

  private startLogin(): [number, unknown] {
    return [
      201,
      {
        id: 'login-1',
        code: 'ABCD-EFGH',
        pollSecret: 'secret',
        verificationUrl: `${this.url}/cli-login?request=login-1`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ]
  }

  private claim(body: unknown): [number, unknown] {
    if ((body as { pollSecret?: string }).pollSecret !== 'secret') return [404, {}]
    if (this.expireLogins) return [200, { status: 'expired' }]
    if (this.pendingClaims-- > 0) return [200, { status: 'pending' }]
    return [200, { status: 'approved', token: TOKEN, user: { email: 'ann@x.io', name: 'Ann' } }]
  }

  private pull(query: URLSearchParams): [number, unknown] {
    const day = new Date().toLocaleDateString('sv-SE')
    if (query.get('since') === String(this.revision) && query.get('day') === day) {
      return [200, { revision: this.revision, day, changed: false }]
    }
    return [
      200,
      {
        revision: this.revision,
        day,
        changed: true,
        project: { id: PROJECT, name: 'Vision', role: 'owner' },
        repositories: [],
        timeline: this.timeline,
        entities: this.entities,
        conflicts: [],
        audits: this.audits,
        people: this.people,
        owners: this.owners,
        signers: this.signers,
      },
    ]
  }

  private startRound(): [number, unknown] {
    this.revision++
    this.audits = [
      {
        checkpoint: 'backend:auth',
        title: 'Auth API',
        auditors: ['test@example.com'],
        round: 1,
        status: 'auditing',
        closedWithoutAudit: false,
        rounds: [
          {
            round: 1,
            commit: 'abc1234def',
            startedBy: 'ann@x.io',
            startedAt: '2026-10-04T10:00:00.000Z',
            reports: [],
            summary: null,
            signatures: [],
          },
        ],
      },
    ]
    return [201, { round: 1, commit: 'abc1234def' }]
  }

  private push(body: unknown): [number, unknown] {
    const { operations } = body as { operations: Operation[] }
    this.received.push(...operations)
    for (const operation of operations) {
      this.entities.push({
        kind: operation.kind,
        key: operation.key,
        data: operation.data,
        version: 1,
        updatedAt: operation.at,
        updatedBy: { name: 'Ann', email: 'ann@x.io' },
      })
    }
    this.revision++
    return [
      200,
      {
        revision: this.revision,
        results: operations.map((op) =>
          this.rejectOps
            ? { id: op.id, status: 'rejected', reason: 'data: too long' }
            : { id: op.id, status: 'applied', version: 1 }
        ),
      },
    ]
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let text = ''
  for await (const chunk of request) text += String(chunk)
  return text === '' ? undefined : (JSON.parse(text) as unknown)
}

describe('team server', () => {
  let server: FakeServer
  let repo: TestRepo

  beforeEach(async () => {
    server = new FakeServer()
    await server.start()
    repo = TestRepo.create()
      .write('.beacons/zones.yml', ZONES)
      .write('.beacons/checkpoints.yml', PLAN)
    repo.commitAll('chore: plan')
    server.timeline = timelineView(
      [collectSnapshot(repo.root)],
      new Date().toLocaleDateString('sv-SE')
    )
  })

  afterEach(async () => {
    await server.stop()
    repo.remove()
  })

  function configure(): void {
    repo.write(
      '.beacons/config.yml',
      `version: 1\nserver:\n  url: ${server.url}/\n  project: ${PROJECT}\n`
    )
  }

  describe('beacon login', () => {
    it('opens the dashboard, waits for approval and keeps the token', async () => {
      server.pendingClaims = 1
      const result = await repo.runAsync(['login', server.url])

      expect(result.code).toBe(0)
      expect(result.out).toContain('Код ABCD-EFGH')
      expect(result.out).toContain(`✓ Вы вошли на ${server.url} как Ann <ann@x.io>`)
      expect(repo.opened).toEqual([`${server.url}/cli-login?request=login-1`])

      const outside = mkdtempSync(path.join(tmpdir(), 'beacon-outside-'))
      try {
        const out = await repo.runAsync(['logout', `${server.url}/`], { cwd: outside })
        expect(out.out).toContain(`✓ Токен ${server.url} удалён`)
        expect((await repo.runAsync(['logout', server.url], { cwd: outside })).out).toContain(
          'не были вошли'
        )
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('takes the server from the config and explains an unreachable one', async () => {
      configure()
      expect((await repo.runAsync(['login', '--no-browser'])).code).toBe(0)
      expect(repo.opened).toEqual([])

      server.expireLogins = true
      const expired = await repo.runAsync(['login'])
      expect(expired.err).toContain('Запрос входа истёк')

      server.down = true
      const offline = await repo.runAsync(['login'])
      expect(offline.code).toBe(1)
      expect(offline.err).toContain(`⚠ Сервер ${server.url} недоступен`)
    })
  })

  describe('beacon sync', () => {
    it('explains what is missing: the server, then the login', async () => {
      const none = await repo.runAsync(['sync'])
      expect(none.code).toBe(2)
      expect(none.err).toContain('Не знаю, с каким сервером синхронизироваться')

      configure()
      const anonymous = await repo.runAsync(['sync'])
      expect(anonymous.err).toContain(`✖ Вы не вошли на ${server.url}: beacon login ${server.url}`)
    })

    it('keeps the project for offline work and sends notes made offline', async () => {
      configure()
      await repo.runAsync(['login', '--no-browser'])

      const first = await repo.runAsync(['sync'])
      expect(first.out).toContain('✓ Синхронизировано: «Vision», ревизия 1')
      expect(first.out).toContain('Линии: backend · людей: 0 · заметок: 0 · конфликтов: 0')
      expect((await repo.runAsync(['sync'])).out).toContain('✓ Без изменений')

      const team = repo.run(['checkpoints', '--team'])
      expect(team.out).toContain(`Сервер ${server.url} · «Vision»`)
      expect(team.out).toContain('○ auth  Auth API')
      expect(repo.run(['todo', '--team']).out).toContain('auth.api (backend:auth)')

      server.down = true
      const offline = await repo.runAsync(['note', 'backend:auth', 'Waiting', 'for', 'design'])
      expect(offline.code).toBe(0)
      expect(offline.out).toContain('✓ заметка к backend:auth сохранена')
      expect(offline.out).toContain('Ждут отправки: 1')
      expect(repo.run(['checkpoints', '--team']).out).toContain(
        '✎ Waiting for design (не отправлена)'
      )

      server.down = false
      const back = await repo.runAsync(['sync'])
      expect(back.out).toContain('Отправлено изменений: 1 — применено 1')
      expect(back.out).toContain('заметок: 1')
      expect(server.received).toMatchObject([
        { kind: 'note', key: 'backend:auth', data: { text: 'Waiting for design' }, baseVersion: 0 },
      ])
      expect(repo.run(['checkpoints', '--team']).out).toContain('✎ Waiting for design\n')

      // Sent once: nothing waits any more.
      await repo.runAsync(['sync'])
      expect(server.received).toHaveLength(1)
    })

    it('works offline before the first sync and reports rejected changes', async () => {
      configure()
      await repo.runAsync(['login', '--no-browser'])
      server.down = true
      const offline = await repo.runAsync(['sync'])
      expect(offline.code).toBe(1)
      expect(offline.err).toContain('Данных сервера ещё нет')

      server.down = false
      server.rejectOps = true
      const sent = await repo.runAsync(['note', 'backend:auth', 'x'])
      expect(sent.out).toContain('✖ изменение отклонено: data: too long')

      // The plans were removed: a new revision on the server.
      server.timeline = { missing: true }
      server.revision++
      await repo.runAsync(['sync'])
      expect(repo.run(['checkpoints', '--team']).out).toContain('нет планов чекпоинтов')

      // Another project: what was kept for the old one does not apply.
      repo.write(
        '.beacons/config.yml',
        `version: 1\nserver:\n  url: ${server.url}\n  project: 11111111-2222-4333-8444-555555555555\n`
      )
      expect(repo.run(['checkpoints', '--team']).err).toContain('выполните beacon sync')
    })

    it('asks to log in again when the token is refused and checks note arguments', async () => {
      configure()
      await repo.runAsync(['login', '--no-browser'])
      expect(repo.run(['checkpoints', '--team']).err).toContain('выполните beacon sync')

      server.rejectToken = true
      const refused = await repo.runAsync(['sync'])
      expect(refused.code).toBe(1)
      expect(refused.err).toContain('не принял токен — войдите снова')

      expect((await repo.runAsync(['note', 'auth', 'text'])).err).toContain('линия:id')
      expect((await repo.runAsync(['note', 'backend:auth'])).code).toBe(2)
      expect((await repo.runAsync(['note', 'backend:auth', '--delete'])).out).toContain(
        'удаление заметки к backend:auth сохранена'
      )
    })
  })

  describe('cross-audit with the team', () => {
    it('opens a round on the server and signs it', async () => {
      configure()
      await repo.runAsync(['login', '--no-browser'])
      expect((await repo.runAsync(['sign', 'auth', 'agree'])).err).toContain('не открыт')

      const started = await repo.runAsync(['audit', 'start', 'auth'])
      expect(started.out).toContain('✓ Раунд 1 кросс-аудита backend:auth открыт на коммите abc1234')
      expect(repo.run(['checkpoints', '--team']).out).toContain(
        '◎ кросс-аудит: раунд 1, подписей 0/1, отчётов 0'
      )
      expect(repo.run(['audit', 'report', 'auth']).out).toContain('round-1/test-example-com.md')

      expect((await repo.runAsync(['sign', 'auth', 'maybe'])).code).toBe(2)
      expect((await repo.runAsync(['sign', 'auth', 'object'])).err).toContain('--comment')
      const signed = await repo.runAsync([
        'sign',
        'auth',
        'accept-risk',
        '--comment',
        'Rate limit later',
      ])
      expect(signed.out).toContain('✓ Подпись под раундом 1 backend:auth: accept-risk')
      expect(server.received).toMatchObject([
        {
          kind: 'signature',
          key: 'backend:auth/1/ann@x.io',
          data: { verdict: 'accept-risk', commit: 'abc1234def', comment: 'Rate limit later' },
          baseVersion: 0,
        },
      ])
      expect((await repo.runAsync(['audit', 'start'])).code).toBe(2)
      expect((await repo.runAsync(['sign', 'auth'])).code).toBe(2)
    })
  })

  describe('people and commit authors', () => {
    let keys: string
    const keyOf = (name: string): string => readFileSync(path.join(keys, `${name}.pub`), 'utf8')

    function person(name: string, emails: string[], extra: object = {}): object {
      return {
        userId: name,
        name,
        role: 'member',
        emails,
        contacts: { telegram: null, phone: null, email: null },
        identities: [{ provider: 'github', login: name.split(' ', 1)[0], signingKeys: 1 }],
        ...extra,
      }
    }

    beforeEach(async () => {
      keys = mkdtempSync(path.join(tmpdir(), 'beacon-keys-'))
      for (const name of ['ann', 'bob']) {
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(keys, name)])
      }
      const ann = ['ann@x.io', 'test@example.com']
      server.people = [
        person('Ann Lee', ann, { contacts: { telegram: '@ann_lee', phone: null, email: null } }),
        person('Bob Kim', ['bob@x.io']),
      ]
      server.owners = [
        {
          ref: 'backend:auth.api',
          repository: 'backend',
          zone: 'auth.api',
          title: 'Auth API',
          owner: 'ann@x.io',
          proxies: ['bob@x.io'],
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
      server.signers = {
        signers: [
          { name: 'Ann Lee', emails: ann, keys: [keyOf('ann').trim()] },
          { name: 'Bob Kim', emails: ['bob@x.io'], keys: [keyOf('bob').trim()] },
        ],
        allowedSigners: [
          `${ann.join(',')} namespaces="git" ${keyOf('ann').trim()}`,
          `bob@x.io namespaces="git" ${keyOf('bob').trim()}`,
          '',
        ].join('\n'),
      }
      configure()
      await repo.runAsync(['login', '--no-browser'])
    })

    afterEach(() => {
      rmSync(keys, { recursive: true, force: true })
    })

    function identity(check: string): void {
      repo.write(
        '.beacons/config.yml',
        `version: 1\nserver:\n  url: ${server.url}\n  project: ${PROJECT}\nidentity:\n  check: ${check}\n`
      )
    }

    function commitMsg(): { code: number; out: string; err: string } {
      const file = path.join(repo.root, '.git', 'COMMIT_EDITMSG')
      writeFileSync(file, 'docs: readme\n')
      return repo.run(['hook', 'commit-msg', file])
    }

    function prePush(): { code: number; out: string; err: string } {
      const head = repo.git('rev-parse', 'HEAD').trim()
      return repo.run(['hook', 'pre-push', 'origin'], {
        stdin: `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`,
      })
    }

    it('tells who I am and who owns the zones', async () => {
      expect((await repo.runAsync(['whoami'])).err).toContain('выполните beacon sync')
      expect((await repo.runAsync(['sync'])).out).toContain('людей: 2')

      const me = await repo.runAsync(['whoami'])
      expect(me.code).toBe(0)
      expect(me.out).toContain('Вы: Ann Lee <ann@x.io>, владелец проекта')
      expect(me.out).toContain('✓ Коммиты здесь — от вашего имени: test@example.com')
      expect(me.out).toContain('✓ github: Ann, ключей подписи: 1')
      expect(me.out).toContain('⚠ Коммиты не подписываются — beacon signing setup')
      expect(me.out).toContain('• Зоны: backend:auth.api')
      expect(me.out).toContain('• Контакты: telegram @ann_lee')

      const all = await repo.runAsync(['owners'])
      expect(all.out).toContain(
        'backend:auth.api  Ann Lee <ann@x.io>; доверенные: Bob Kim <bob@x.io>'
      )
      expect(all.out).toContain('backend:billing   не назначен')
      expect((await repo.runAsync(['owners', 'billing'])).out).not.toContain('auth.api')
      expect((await repo.runAsync(['owners', 'nope'])).code).toBe(1)
      expect(me.out).toContain('почта; данные старше 7 дн. только предупреждают')
    })

    it('signs commits with my own key', async () => {
      await repo.runAsync(['sync'])
      const bob = await repo.runAsync(['signing', 'setup', '--key', path.join(keys, 'bob.pub')])
      expect(bob.out).toContain('⚠ Это ключ Bob Kim, а не ваш')

      const ann = await repo.runAsync(['signing', 'setup', '--key', path.join(keys, 'ann.pub')])
      expect(ann.out).toContain('✓ Ключ привязан к вашему git-аккаунту')
      expect(repo.git('config', 'user.signingkey').trim()).toBe(path.join(keys, 'ann'))
      expect(repo.git('config', 'commit.gpgsign').trim()).toBe('true')
      expect((await repo.runAsync(['whoami'])).out).toContain(
        '✓ Коммиты подписываются ключом вашего git-аккаунта'
      )
      repo.write('README.md', 'signed\n')
      repo.git('add', '-A')
      repo.git('commit', '-q', '--no-verify', '-m', 'docs: signed')
      expect(repo.git('log', '--show-signature', '-1')).toContain(
        'Good "git" signature for ann@x.io'
      )
      expect((await repo.runAsync(['signing', 'oops'])).code).toBe(2)
    })

    it('checks the authors of commits in the hooks', async () => {
      await repo.runAsync(['sync'])
      // The plan is already on the remote: only new commits are pushed.
      repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
      identity('signature')
      expect(commitMsg().err).toContain('коммиты не подписываются SSH-ключом')

      const bob = await repo.runAsync(['signing', 'setup', '--key', path.join(keys, 'bob.pub')])
      expect(bob.out).toContain('⚠ Это ключ Bob Kim, а не ваш')
      expect(commitMsg().err).toContain('ключ подписи принадлежит Bob Kim')
      repo.write('README.md', 'by bob\n')
      repo.git('add', '-A')
      repo.git('commit', '-q', '--no-verify', '-m', 'docs: signed by bob')
      expect(prePush().err).toContain('test@example.com: подписан ключом другого человека')

      const ann = await repo.runAsync(['signing', 'setup', '--key', path.join(keys, 'ann.pub')])
      expect(ann.out).toContain('✓ Ключ привязан к вашему git-аккаунту')
      expect(repo.git('config', 'user.signingkey').trim()).toBe(path.join(keys, 'ann'))
      expect(commitMsg()).toMatchObject({ code: 0, err: '' })
      repo.git('commit', '-q', '--amend', '--no-verify', '-m', 'docs: signed by ann')
      expect(prePush()).toMatchObject({ code: 0, err: '' })
      expect((await repo.runAsync(['whoami'])).out).toContain(
        '✓ Коммиты подписываются ключом вашего git-аккаунта'
      )

      repo.write('README.md', 'unsigned\n')
      repo.git('add', '-A')
      repo.git('-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'docs: unsigned')
      expect(prePush().err).toContain('docs: unsigned — test@example.com: не подписан')

      // Trusting the author's email: an unsigned commit of a person passes, a stranger's does not.
      identity('email')
      expect(prePush().code).toBe(0)
      repo.git('config', 'user.email', 'eve@nowhere.io')
      expect(commitMsg().err).toContain('eve@nowhere.io — не почта участника проекта')
      repo.write('README.md', 'by eve\n')
      repo.git('add', '-A')
      repo.git('-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'docs: eve')
      expect(prePush().err).toContain('eve@nowhere.io: автор — не участник проекта')
    })

    it('holds commits on stale data when the team asks so', async () => {
      repo.write(
        '.beacons/config.yml',
        `version: 1\nserver:\n  url: ${server.url}\n  project: ${PROJECT}\nidentity:\n  whenStale: hold\n`
      )
      expect(commitMsg().err).toContain('нет данных о людях проекта — выполните beacon sync')
      expect(prePush().err).toContain('нет данных о людях проекта')
      identity('email')
      expect(commitMsg()).toMatchObject({
        code: 0,
        out: expect.stringContaining('⚠ beacon: нет данных') as string,
      })
      expect((await repo.runAsync(['signing', 'oops'])).code).toBe(2)
    })
  })
})
