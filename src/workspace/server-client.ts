import { z } from 'zod'

import {
  type Bundle,
  bundleSchema,
  type LoginClaim,
  loginClaimSchema,
  type LoginStarted,
  loginStartedSchema,
  type Operation,
  type PushResult,
  pushResultSchema,
  roundStartedSchema,
} from '../core/sync.js'

const API = '/api/v1'
const TIMEOUT_MS = 30_000

/** Why a call to the server failed: offline work goes on, a bad token needs a new login. */
export class ServerError extends Error {
  constructor(
    readonly kind: 'offline' | 'unauthorized' | 'http' | 'contract',
    message: string
  ) {
    super(message)
  }
}

const serverMetaSchema = z.object({
  version: z.string(),
  apiVersion: z.number(),
  minClientVersion: z.string(),
})

export type ServerMeta = z.infer<typeof serverMetaSchema>

/** The team server's API for the CLI (backend: cli-auth and sync modules). */
export class ServerClient {
  constructor(
    private readonly url: string,
    private readonly token?: string
  ) {}

  startLogin(deviceName: string): Promise<LoginStarted> {
    return this.call('POST', '/cli-auth/logins', loginStartedSchema, { deviceName })
  }

  claimLogin(id: string, pollSecret: string): Promise<LoginClaim> {
    return this.call('POST', `/cli-auth/logins/${id}/claim`, loginClaimSchema, { pollSecret })
  }

  /** The server's versions and licensing; public. */
  meta(): Promise<ServerMeta> {
    return this.call('GET', '/meta', serverMetaSchema)
  }

  pull(project: string, since?: { revision: number; day: string }): Promise<Bundle> {
    const query = since ? `?since=${String(since.revision)}&day=${since.day}` : ''
    return this.call('GET', `/projects/${project}/sync${query}`, bundleSchema)
  }

  /** Opens the next cross-audit round of a checkpoint (`line:id`) on its current commit. */
  startRound(project: string, checkpoint: string): Promise<{ round: number; commit: string }> {
    return this.call(
      'POST',
      `/projects/${project}/audits/${encodeURIComponent(checkpoint)}/rounds`,
      roundStartedSchema,
      {}
    )
  }

  push(project: string, operations: readonly Operation[]): Promise<PushResult> {
    return this.call('POST', `/projects/${project}/sync/operations`, pushResultSchema, {
      operations,
    })
  }

  private async call<T>(
    method: 'GET' | 'POST',
    route: string,
    schema: z.ZodType<T>,
    body?: unknown
  ): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.url}${API}${route}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw new ServerError('offline', describe(error))
    }
    if (response.status === 401) throw new ServerError('unauthorized', 'сервер не принял токен')
    const payload = await readJson(response)
    if (!response.ok) {
      const message = (payload as { message?: unknown } | undefined)?.message
      throw new ServerError(
        'http',
        `${String(response.status)}${typeof message === 'string' ? `: ${message}` : ''}`
      )
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) throw new ServerError('contract', 'неожиданный ответ сервера')
    return parsed.data
  }
}

function describe(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } }).cause?.code
  return typeof cause === 'string' ? cause : error instanceof Error ? error.message : String(error)
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined // an empty or non-JSON body: the status says enough
  }
}
