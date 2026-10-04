import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createMcpServer } from '../src/commands/mcp.js'

import { TestRepo } from './support/test-repo.js'

const ZONES = `version: 1
zones:
  auth.api:
    title: Auth API
    paths: [src/auth/**]
  web.home:
    title: Home
    paths: [src/web/**]
`

const PLAN = `version: 1
line: backend
checkpoints:
  auth:
    title: Auth API
    items:
      - zone: auth.api
        owner: test@example.com
    audit:
      auditors: [test@example.com, bob@example.com]
`

const FINDINGS = `
### [high] Token compared with ===
- Файл: src/auth/login.ts:1
- Зона: auth.api

Use a constant-time comparison.
`

describe('cross-audit in the working copy', () => {
  let repo: TestRepo

  beforeEach(() => {
    repo = TestRepo.create()
      .write('.beacons/zones.yml', ZONES)
      .write('.beacons/checkpoints.yml', PLAN)
      .write('src/auth/login.ts', 'export const login = (a: string, b: string) => a === b\n')
      .write('src/web/home.ts', 'export const home = 1\n')
    repo.commitAll('feat: auth [BEACON: auth.api]')
  })

  afterEach(() => {
    repo.remove()
  })

  it('packs the code of the checkpoint zones only', () => {
    const pack = repo.run(['audit', '--checkpoint', 'auth'])
    expect(pack.code).toBe(0)
    expect(pack.out).toContain('чекпоинт backend:auth')
    expect(pack.out).toContain('src/auth/login.ts')
    expect(pack.out).not.toContain('src/web/home.ts')
    expect(repo.run(['audit', '--checkpoint', 'nope']).err).toContain('Чекпоинта nope нет')
  })

  it('runs a round: reports, the merge, the summary, then the next round', () => {
    const created = repo.run(['audit', 'report', 'auth', '--model', 'opus'])
    expect(created.out).toContain(
      '✓ Отчёт раунда 1: .beacons/audits/auth/round-1/test-example-com.md'
    )
    expect(repo.run(['audit', 'report', 'backend:auth']).out).toContain('уже есть')
    const mine = '.beacons/audits/auth/round-1/test-example-com.md'
    expect(repo.read(mine)).toContain('model: opus')
    repo.write(mine, repo.read(mine) + FINDINGS)
    repo.write(
      '.beacons/audits/auth/round-1/bob-example-com.md',
      `---\nauthor: bob@example.com\nmodel: gpt\n---\n## Находки\n${FINDINGS}`
    )

    const status = repo.run(['audit', 'status', 'auth'])
    expect(status.out).toContain('Раунд 1: отчётов 2')
    expect(status.out).toContain('• test@example.com (opus) — находок: 1')

    const merged = repo.run(['audit', 'merge', 'auth'])
    expect(merged.out).toContain('## src/auth/login.ts')
    expect(merged.out).toContain('✓ Сводка для решений: .beacons/audits/auth/round-1/summary.md')
    const summary = repo.read('.beacons/audits/auth/round-1/summary.md')
    expect(summary.match(/### \[\?\]/g)).toHaveLength(2)
    expect(repo.run(['audit', 'merge', 'auth']).out).toContain('• Сводка уже есть')

    repo.write(
      '.beacons/audits/auth/round-1/summary.md',
      summary.replace('### [?]', '### [fixed]').replace('### [?]', '### [disputed]')
    )
    expect(repo.run(['audit', 'status', 'auth']).out).toContain(
      'сводка: исправлено 1, оспорено 1, риск принят 0, без решения 0'
    )
    // Without a team server the next report goes to the next round once a summary exists.
    expect(repo.run(['audit', 'report', 'auth']).out).toContain('Отчёт раунда 2')
  })

  it('explains what is missing', () => {
    expect(repo.run(['audit', 'merge', 'auth']).err).toContain('ещё нет отчётов')
    expect(repo.run(['audit', 'status', 'auth']).out).toContain('Отчётов пока нет')
    expect(repo.run(['audit', 'review', 'auth']).code).toBe(2)
    expect(repo.run(['audit', 'report', 'web:auth']).err).toContain('нет в линии backend')
    repo.write('.beacons/checkpoints.yml', 'version: 1\nline: backend\n')
    expect(repo.run(['audit', 'report', 'auth']).err).toContain('Чекпоинта auth нет')
  })

  it('gives AI agents the checkpoint code through MCP', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await createMcpServer(repo.root).connect(serverSide)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(clientSide)
    const call = async (checkpoint: string) =>
      (await client.callTool({ name: 'audit_checkpoint', arguments: { checkpoint } })) as {
        content: { text: string }[]
      }
    expect((await call('auth')).content[0]?.text).toContain('src/auth/login.ts')
    expect((await call('nope')).content[0]?.text).toContain('Чекпоинта nope нет')
    await client.close()
  })
})
