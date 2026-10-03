import { get, type IncomingHttpHeaders } from 'node:http'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMcpServer } from '../src/commands/mcp.js'
import { type RunningServer, startServer } from '../src/commands/serve.js'
import { LiveIndex } from '../src/workspace/live-index.js'

import { TestRepo, ZONES } from './support/test-repo.js'

const DIST_MAIN = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))
const ORIGIN = 'http://localhost:5173'
const WAIT = { timeout: 10_000, interval: 50 }

interface Response {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function request(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    get(url, { headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
      })
    }).on('error', reject)
  })
}

describe('local client', () => {
  let repo: TestRepo

  beforeEach(() => {
    repo = TestRepo.create()
      .write('.beacons/zones.yml', ZONES)
      .write('src/widgets/pricing/Toggle.tsx', 'export const Toggle = 1\n')
      .write('src/app.ts', 'a()\n// #region @beacon security.http\nhelmet()\n// #endregion\n')
      .write('src/app.test.ts', '// @beacon security.http\nit()\n')
    repo.commitAll('chore: seed')
  })

  afterEach(() => {
    repo.remove()
  })

  describe('beacon audit', () => {
    it('packs the code of a topic, from another folder with -C', () => {
      const result = repo.run(['-C', repo.root, 'audit', '--tag', 'security'], { cwd: '/' })
      expect(result.code).toBe(0)
      expect(result.out).toContain('# Аудит: тег security')
      expect(result.out).toContain('### src/app.ts · строки 2–4 (регион)')
      expect(result.out).not.toContain('app.test.ts')

      const withTests = repo.run(['audit', '--tag', 'security', '--tests', '--no-code', '--json'])
      const { markdown } = JSON.parse(withTests.out) as { markdown: string }
      expect(markdown).toContain('### src/app.test.ts')
      expect(markdown).not.toContain('helmet()')
    })
  })

  describe('beacon watch', () => {
    it('reports index changes as files change', async () => {
      const watch = repo.start(['watch'])
      expect(watch.output.out).toContain('Слежу за')
      repo.write('src/new.ts', '// @beacon billing\n')
      await vi.waitFor(() => {
        expect(watch.output.out).toContain('↻')
      }, WAIT)
      expect(await watch.stop()).toMatchObject({ code: 0 })
    })

    it('needs a zone map', async () => {
      repo.git('rm', '-q', '.beacons/zones.yml')
      const watch = repo.start(['watch'])
      expect(await watch.stop()).toMatchObject({ code: 1 })
    })
  })

  describe('LiveIndex', () => {
    it('tracks the zone map lifecycle and ignores no-op refreshes', () => {
      const live = new LiveIndex(repo.root)
      expect(live.current()).toMatchObject({ version: 0, manifest: 'ok' })
      expect(live.refresh()).toBe(false)
      repo.write('.beacons/zones.yml', 'version: 1\nzones:\n  Bad:\n    title: x\n')
      expect(live.refresh()).toBe(true)
      expect(live.current()).toMatchObject({ version: 1, manifest: 'invalid', index: undefined })
      repo.git('rm', '-q', '-f', '.beacons/zones.yml')
      expect(live.refresh()).toBe(true)
      expect(live.current().manifest).toBe('missing')
      live.stop()
    })
  })

  describe('beacon serve', () => {
    let server: RunningServer

    beforeEach(async () => {
      server = await startServer(repo.root, { port: 0, host: '127.0.0.1', origins: [ORIGIN] })
    })

    afterEach(async () => {
      await server.close()
    })

    it('serves the index to allowed origins only', async () => {
      repo.git('remote', 'add', 'origin', 'git@github.com:acme/shop-backend.git')
      const index = await request(`${server.url}/api/index`, { Origin: ORIGIN })
      expect(index.status).toBe(200)
      expect(index.headers['access-control-allow-origin']).toBe(ORIGIN)
      expect(JSON.parse(index.body)).toMatchObject({
        project: { name: 'shop-backend' },
        manifest: 'ok',
        version: 0,
        index: { zones: expect.arrayContaining([expect.objectContaining({ id: 'home.pricing' })]) },
      })
      expect(
        (await request(`${server.url}/api/index`, { Origin: 'https://evil.example' })).status
      ).toBe(403)
      expect((await request(`${server.url}/api/index`, { Host: 'evil.example' })).status).toBe(403)
    })

    it('answers which, audit, unknown paths and preflight', async () => {
      const which = await request(`${server.url}/api/which?file=src/app.ts`)
      expect(JSON.parse(which.body)).toMatchObject({ regions: [{ zones: ['security.http'] }] })
      expect((await request(`${server.url}/api/which`)).status).toBe(400)
      expect((await request(`${server.url}/api/which?file=missing.ts`)).status).toBe(404)

      const pack = await request(`${server.url}/api/audit?zone=home&code=0`)
      expect(pack.headers['content-type']).toContain('text/markdown')
      expect(pack.body).toContain('### src/widgets/pricing/Toggle.tsx')
      expect(pack.body).not.toContain('```')

      expect((await request(`${server.url}/nope`)).status).toBe(404)
      expect(JSON.parse((await request(`${server.url}/`)).body)).toMatchObject({ name: 'beacon' })
    })

    it('rejects writes and answers CORS preflight', async () => {
      const call = (method: string) =>
        fetch(`${server.url}/api/index`, { method, headers: { Origin: ORIGIN } })
      expect((await call('POST')).status).toBe(405)
      const preflight = await call('OPTIONS')
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-methods')).toBe('GET')
    })

    it('pushes a new index version over SSE when files change', async () => {
      let stream = ''
      const events = get(`${server.url}/api/events`, (response) => {
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (stream += chunk))
      })
      await vi.waitFor(() => {
        expect(stream).toContain('data: {"version":0}')
      }, WAIT)
      repo.write('src/widgets/pricing/Yearly.tsx', 'export const Yearly = 1\n')
      await vi.waitFor(() => {
        expect(stream).toContain('data: {"version":1}')
      }, WAIT)
      events.destroy()
      const index = JSON.parse((await request(`${server.url}/api/index`)).body) as {
        index: { zones: { id: string; files: string[] }[] }
      }
      expect(index.index.zones.find((zone) => zone.id === 'home.pricing')?.files).toContain(
        'src/widgets/pricing/Yearly.tsx'
      )
    })
  })

  describe('beacon serve from the CLI', () => {
    it('prints its address and rejects a bad port', async () => {
      const serve = repo.start(['serve', '--port', '0', '--origin', ORIGIN])
      await vi.waitFor(() => {
        expect(serve.output.out).toMatch(/beacon serve: http:\/\/127\.0\.0\.1:\d+/)
      }, WAIT)
      expect(await serve.stop()).toMatchObject({ code: 0 })
      expect(await repo.start(['serve', '--port', 'abc']).stop()).toMatchObject({ code: 2 })
    })
  })

  describe('beacon mcp', () => {
    it('exposes zones, file zones, audit context and status as tools', async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      const server = createMcpServer(repo.root)
      await server.connect(serverSide)
      const client = new Client({ name: 'test', version: '1.0.0' })
      await client.connect(clientSide)

      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'audit_context',
        'list_zones',
        'which_zone',
        'zone_status',
      ])
      const text = async (name: string, args: Record<string, unknown> = {}) => {
        const result = (await client.callTool({ name, arguments: args })) as {
          content: { text: string }[]
          isError?: boolean
        }
        return { text: result.content[0]?.text ?? '', isError: result.isError === true }
      }
      expect((await text('list_zones', { tag: 'security' })).text).toContain('security.http')
      expect((await text('which_zone', { file: `${repo.root}/src/app.ts` })).text).toContain(
        '"security.http"'
      )
      expect((await text('audit_context', { zone: 'security.http' })).text).toContain('helmet()')
      expect((await text('zone_status')).text).toContain('"coverage"')
      expect((await text('which_zone', { file: 'missing.ts' })).isError).toBe(true)

      repo.git('rm', '-q', '.beacons/zones.yml')
      expect((await text('audit_context', {})).isError).toBe(true)
      await client.close()
    })

    it('runs as a stdio server from the built binary', async () => {
      const client = new Client({ name: 'test', version: '1.0.0' })
      await client.connect(
        new StdioClientTransport({ command: 'node', args: [DIST_MAIN, 'mcp'], cwd: repo.root })
      )
      expect(client.getInstructions()).toContain('list_zones')
      const result = (await client.callTool({
        name: 'list_zones',
        arguments: { zone: 'home' },
      })) as {
        content: { text: string }[]
      }
      expect(result.content[0]?.text).toContain('home.pricing')
      await client.close()
    })
  })
})
