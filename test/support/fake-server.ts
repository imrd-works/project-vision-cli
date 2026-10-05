import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { Operation } from '../../src/core/sync.js'

export const PROJECT = '54cc4d32-7588-4252-a186-832699730b5a'
const TOKEN = 'bvt_test'

/** A team server with just what `beacon login` and `beacon sync` use (backend: cli-auth, sync). */
export class FakeServer {
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
  repositories: unknown[] = []
  people: unknown[] = []
  owners: unknown[] = []
  signers: unknown = { signers: [], allowedSigners: '' }
  cards: unknown[] = []
  qa: unknown = undefined
  role = 'owner'
  /** Who the next `beacon login` signs in as. */
  user = { email: 'ann@x.io', name: 'Ann' }
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
    return [200, { status: 'approved', token: TOKEN, user: this.user }]
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
        project: { id: PROJECT, name: 'Vision', role: this.role },
        repositories: this.repositories,
        timeline: this.timeline,
        entities: this.entities,
        conflicts: [],
        audits: this.audits,
        people: this.people,
        owners: this.owners,
        signers: this.signers,
        cards: this.cards,
        ...(this.qa === undefined ? {} : { qa: this.qa }),
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
