import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ServerClient, ServerError } from './server-client.js'

describe('ServerClient', () => {
  let server: Server
  let url: string
  let reply: { status: number; body: string } = { status: 200, body: '{}' }

  beforeEach(async () => {
    server = createServer((_request, response) => {
      response.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  async function failure(call: () => Promise<unknown>): Promise<ServerError> {
    try {
      await call()
    } catch (error) {
      if (error instanceof ServerError) return error
      throw error
    }
    throw new Error('expected a ServerError')
  }

  it('tells errors of the server, broken contracts and refused tokens apart', async () => {
    const client = new ServerClient(url, 'bvt_x')

    reply = { status: 500, body: '{"message":"boom"}' }
    expect(await failure(() => client.pull('p'))).toMatchObject({
      kind: 'http',
      message: '500: boom',
    })
    reply = { status: 404, body: 'not json' }
    expect(await failure(() => client.pull('p'))).toMatchObject({ kind: 'http', message: '404' })
    reply = { status: 200, body: '{"unexpected":true}' }
    expect(await failure(() => client.pull('p'))).toMatchObject({ kind: 'contract' })
    reply = { status: 401, body: '{}' }
    expect(await failure(() => client.pull('p'))).toMatchObject({ kind: 'unauthorized' })
  })

  it('reports an unreachable server as offline', async () => {
    await new Promise((resolve) => server.close(resolve))
    server = createServer()
    expect(await failure(() => new ServerClient(url).startLogin('laptop'))).toMatchObject({
      kind: 'offline',
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })
})
