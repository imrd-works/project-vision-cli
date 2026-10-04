import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { todoFor } from '../core/timeline.js'
import { authorEmail, findRepoRoot, projectName } from '../workspace/git.js'
import { LiveIndex, type Snapshot } from '../workspace/live-index.js'
import { LiveValidation } from '../workspace/live-validation.js'
import { type LineSource, projectTimeline } from '../workspace/timeline-builder.js'

import { auditMarkdown } from './audit.js'
import { EXIT, requireProject } from './result.js'
import { packageVersion, type RunContext, untilAborted } from './running.js'
import { describe } from './watch.js'
import { which } from './which.js'

/**
 * `beacon serve`: a local read-only HTTP API over the live index — the data source of the
 * dashboard (the model of Sanity Studio: an open local client, a closed UI on top).
 *
 *   GET /api/index           project, zones, files, coverage, problems
 *   GET /api/events          Server-Sent Events: `index` with the new version on every change
 *   GET /api/which?file=…    zones of one file
 *   GET /api/audit?tag=…     audit context pack (Markdown), see `beacon audit`
 *   GET /api/history         commits by zones and development dynamics
 *   GET /api/validation      architecture checks; SSE `validation` when a run finishes
 *   GET /api/timeline        checkpoint lines of this and `--with` repositories
 *   GET /api/todo?owner=…    one developer's debts and items (git user.email by default)
 *
 * The API serves source code, so it answers only to local hosts (no DNS rebinding) and to the
 * allowed browser origins (no reading by arbitrary websites).
 */

export interface ServeOptions {
  port: number
  host: string
  /** Sibling repositories whose checkpoint lines join the timeline. */
  with?: readonly string[]
  /** Browser origins allowed to call the API, e.g. the dashboard dev server. */
  origins: readonly string[]
}

export interface RunningServer {
  url: string
  snapshot: () => Snapshot
  close: () => Promise<void>
}

export const DEFAULT_PORT = 4317
export const DEFAULT_ORIGINS = ['http://localhost:5173']
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const HEARTBEAT_MS = 25_000

interface Context {
  root: string
  live: LiveIndex
  /** Live indexes of the `--with` repositories. */
  others: { root: string; live: LiveIndex }[]
  validation: LiveValidation
  options: ServeOptions
  clients: Set<ServerResponse>
}

export async function startServer(root: string, options: ServeOptions): Promise<RunningServer> {
  const live = new LiveIndex(root).start()
  const validation = new LiveValidation(root, () => live.current().index)
  const others = (options.with ?? []).map((dir) => {
    const otherRoot = findRepoRoot(dir) ?? dir
    return { root: otherRoot, live: new LiveIndex(otherRoot).start() }
  })
  const context: Context = { root, live, others, validation, options, clients: new Set() }
  let version = 0
  const notify = (): void => {
    version++
    for (const client of context.clients) sendEvent(client, 'index', { version })
  }
  const unsubscribe = live.subscribe(() => {
    notify()
    validation.schedule()
  })
  for (const other of others) other.live.subscribe(notify)
  validation.subscribe((snapshot) => {
    const data = { version: snapshot.version, running: snapshot.running }
    for (const client of context.clients) sendEvent(client, 'validation', data)
  })
  validation.schedule(0)
  const server = createServer((request, response) => {
    handle(request, response, context)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, resolve)
  })
  const heartbeat = setInterval(() => {
    for (const client of context.clients) client.write(': ping\n\n')
  }, HEARTBEAT_MS)
  const { port } = server.address() as AddressInfo
  const shownHost = options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host

  return {
    url: `http://${shownHost}:${String(port)}`,
    snapshot: () => live.current(),
    close: async () => {
      clearInterval(heartbeat)
      unsubscribe()
      validation.stop()
      live.stop()
      for (const other of others) other.live.stop()
      for (const client of context.clients) client.end()
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve()
        })
      )
    },
  }
}

export async function serveCommand(
  root: string,
  options: ServeOptions,
  context: RunContext
): Promise<number> {
  const loaded = requireProject(root)
  if ('failure' in loaded) {
    context.err(loaded.failure.text)
    return loaded.failure.code
  }
  const server = await startServer(root, options)
  context.out(
    `beacon serve: ${server.url} — ${projectName(root)}, ${describe(server.snapshot())}\n` +
      `Разрешённые origin: ${options.origins.join(', ')}. Остановить — Ctrl+C`
  )
  await untilAborted(context.signal)
  await server.close()
  return EXIT.ok
}

type Route = (url: URL, response: ServerResponse, context: Context) => void

const ROUTES: Record<string, Route> = {
  '/': (_url, response) => {
    sendJson(response, 200, {
      name: 'beacon',
      version: packageVersion(),
      endpoints: [
        '/api/index',
        '/api/events',
        '/api/which?file=',
        '/api/audit?tag=&zone=',
        '/api/history',
        '/api/validation',
        '/api/timeline',
        '/api/todo?owner=',
      ],
    })
  },
  '/api/index': (_url, response, { root, live }) => {
    sendJson(response, 200, { project: { name: projectName(root), root }, ...live.current() })
  },
  '/api/history': (_url, response, { live }) => {
    const { version, history } = live.current()
    sendJson(response, history ? 200 : 409, { version, history })
  },
  '/api/validation': (_url, response, { validation }) => {
    sendJson(response, 200, validation.current())
  },
  '/api/timeline': (_url, response, context) => {
    sendJson(response, 200, projectTimeline(timelineSources(context)))
  },
  '/api/todo': (url, response, context) => {
    const owner = url.searchParams.get('owner') ?? authorEmail(context.root)
    const built = projectTimeline(timelineSources(context))
    if (owner === undefined || !('timeline' in built)) {
      sendJson(response, 200, { owner, debts: [], items: [], stagnant: [] })
      return
    }
    sendJson(response, 200, todoFor(built.timeline, owner))
  },
  '/api/events': (_url, response, context) => {
    openEventStream(response, context)
  },
  '/api/which': (url, response, { root }) => {
    const file = url.searchParams.get('file')
    if (!file) {
      sendJson(response, 400, { error: 'file-required' })
      return
    }
    const outcome = which(root, file)
    sendJson(response, outcome.code === EXIT.ok ? 200 : 404, outcome.json)
  },
  '/api/audit': (url, response, { root }) => {
    const loaded = requireProject(root)
    if ('failure' in loaded) {
      sendJson(response, 409, loaded.failure.json)
      return
    }
    const markdown = auditMarkdown(loaded.project, {
      tag: url.searchParams.get('tag') ?? undefined,
      zone: url.searchParams.get('zone') ?? undefined,
      includeTests: url.searchParams.get('tests') === '1',
      code: url.searchParams.get('code') !== '0',
    })
    response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }).end(markdown)
  },
}

function timelineSources({ root, live, others, validation }: Context): LineSource[] {
  return [
    { root, index: live.current().index, runs: validation.current().runs },
    ...others.map((other) => ({ root: other.root, index: other.live.current().index })),
  ]
}

function handle(request: IncomingMessage, response: ServerResponse, context: Context): void {
  if (!isLocalHost(request.headers.host, context.options.host)) {
    sendJson(response, 403, { error: 'host-not-allowed' })
    return
  }
  const origin = request.headers.origin
  if (origin !== undefined) {
    if (!context.options.origins.includes(origin)) {
      sendJson(response, 403, { error: 'origin-not-allowed' })
      return
    }
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET' }).end()
    return
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'read-only-api' })
    return
  }

  const url = new URL(request.url ?? '/', 'http://localhost')
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined
  if (route) route(url, response, context)
  else sendJson(response, 404, { error: 'not-found' })
}

/** Rejects requests addressed to foreign host names: protection against DNS rebinding. */
function isLocalHost(header: string | undefined, boundHost: string): boolean {
  if (header === undefined) return false
  const hostname = header.replace(/:\d+$/, '')
  return LOCAL_HOSTS.has(hostname) || hostname === boundHost
}

function openEventStream(response: ServerResponse, context: Context): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  response.write('retry: 2000\n\n')
  sendEvent(response, 'index', { version: context.live.current().version })
  const { version, running } = context.validation.current()
  sendEvent(response, 'validation', { version, running })
  context.clients.add(response)
  response.on('close', () => context.clients.delete(response))
}

function sendEvent(response: ServerResponse, event: 'index' | 'validation', data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response
    .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(body))
}
