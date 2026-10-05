import { get } from 'node:http'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type RunningServer, startServer } from '../src/commands/serve.js'

import { TestRepo, ZONES } from './support/test-repo.js'

const WAIT = { timeout: 15_000, interval: 50 }

/** An ESLint JSON report with one boundary violation in a zoned file and one style warning. */
function eslintReport(root: string): string {
  return JSON.stringify([
    {
      filePath: `${root}/src/widgets/pricing/Toggle.tsx`,
      messages: [
        {
          ruleId: 'boundaries/dependencies',
          severity: 2,
          message: 'widgets must not import pages',
          line: 4,
        },
        { ruleId: 'no-console', severity: 1, message: 'Unexpected console', line: 9 },
      ],
    },
  ])
}

function config(command: string): string {
  return `version: 1\nvalidation:\n  - name: architecture\n    tool: eslint\n    command: ${command}\ndynamics:\n  gapDays: 2\n`
}

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

describe('live widgets', () => {
  let repo: TestRepo

  beforeEach(() => {
    repo = TestRepo.create()
      .write('.beacons/zones.yml', ZONES)
      .write('src/widgets/pricing/Toggle.tsx', 'export const Toggle = 1\n')
      .write('src/pages/home/Home.tsx', 'export const Home = 1\n')
      .write('src/core/log.ts', 'export const log = 1\n')
    repo.commitAll('feat(home): pages [BEACON: home]')
    repo.write('src/widgets/pricing/Toggle.tsx', 'export const Toggle = 2\n')
    repo.commitAll('feat(home): pricing [BEACON: home.pricing completed]')
  })

  afterEach(() => {
    repo.remove()
  })

  describe('beacon validate', () => {
    it('reports architecture violations with their zones and fails', async () => {
      repo
        .write('eslint-report.json', eslintReport(repo.root))
        .write('.beacons/config.yml', config('cat eslint-report.json'))
      const run = repo.start(['validate'])
      const result = await run.stop()
      expect(result.code).toBe(1)
      expect(result.err).toContain('✖ architecture: 1 нарушение архитектуры')
      expect(result.err).toContain(
        'src/widgets/pricing/Toggle.tsx:4  boundaries/dependencies: widgets must not import pages  [home.pricing]'
      )
      // Only architecture rules count: no-console is not a boundary rule.
      expect(result.err).not.toContain('no-console')
    })

    it('counts a violation the registry excuses as a deliberate deviation', async () => {
      repo
        .write('eslint-report.json', eslintReport(repo.root))
        .write('.beacons/config.yml', config('cat eslint-report.json'))
        .write(
          '.beacons/rules.yml',
          'version: 1\nrules:\n  layers:\n    title: Layers\n    validatorRules: [boundaries/*]\n'
        )
        .write(
          '.beacons/exceptions.yml',
          'version: 1\nexceptions:\n  - id: pricing-imports-page\n    rule: layers\n    zones: [home.pricing]\n    reason: The toggle reads the page state until the store exists\n    author: test@example.com\n    date: 2026-10-05\n'
        )
      const result = await repo.start(['validate']).stop()
      expect(result.code).toBe(0)
      expect(result.out).toContain('✓ architecture: нарушений архитектуры нет, по исключениям: 1')
      expect(result.out).toContain('— по исключению pricing-imports-page')
    })

    it('passes, explains a missing setup and reports a broken tool', async () => {
      repo.write('.beacons/config.yml', config("echo '[]'"))
      expect(await repo.start(['validate']).stop()).toMatchObject({
        code: 0,
        out: expect.stringContaining('✓ architecture: нарушений архитектуры нет'),
      })

      repo.write('.beacons/config.yml', config('echo Oops >&2; exit 2'))
      const broken = await repo.start(['validate', '--json']).stop()
      expect(broken.code).toBe(1)
      expect(JSON.parse(broken.out)).toMatchObject({
        runs: [{ status: 'error', error: expect.stringContaining('кодом 2 без отчёта: Oops') }],
      })

      repo.write('.beacons/config.yml', 'version: 1\n')
      expect((await repo.start(['validate']).stop()).out).toContain('не настроены')
      repo.write('.beacons/config.yml', 'version: 2\n')
      expect((await repo.start(['validate']).stop()).err).toContain('некорректен')
    })
  })

  describe('beacon tree and history', () => {
    it('draws the architecture tree', () => {
      const result = repo.run(['tree', '--depth', '2'])
      expect(result.out).toContain('├── pages/ (1)  — home')
      expect(result.out).toContain('└── widgets/ (1)  — home.pricing')
      expect(result.out).not.toContain('pricing/ (1)')
      expect(repo.run(['tree', '--depth', '0']).code).toBe(2)
    })

    it('summarizes commits by zones', () => {
      const result = repo.run(['history'])
      expect(result.out).toContain('Коммитов: 2, с маяками зон: 2')
      expect(result.out).toContain('home.pricing  1 коммит · Test User (1)')
      const json = JSON.parse(repo.run(['history', '--json']).out) as {
        dynamics: { days: { completed: number }[] }
      }
      expect(json.dynamics.days.at(-1)?.completed).toBe(1)
    })
  })

  describe('beacon init', () => {
    it('writes a config for the architecture linters the project has', () => {
      const fresh = TestRepo.create()
      try {
        fresh.write(
          'package.json',
          JSON.stringify({ devDependencies: { 'eslint-plugin-boundaries': '7.2.0' } })
        )
        expect(fresh.run(['init']).out).toContain('проверка архитектуры — eslint')
        expect(fresh.read('.beacons/config.yml')).toContain('  - tool: eslint')
        expect(fresh.run(['init']).out).not.toContain('проверка архитектуры')
      } finally {
        fresh.remove()
      }
    })
  })

  describe('beacon serve', () => {
    let server: RunningServer

    beforeEach(async () => {
      repo
        .write('eslint-report.json', eslintReport(repo.root))
        .write('.beacons/config.yml', config('cat eslint-report.json'))
      server = await startServer(repo.root, { port: 0, host: '127.0.0.1', origins: [] })
    })

    afterEach(async () => {
      await server.close()
    })

    it('serves history, the tree and live validation results', async () => {
      expect(await getJson(`${server.url}/api/history`)).toMatchObject({
        history: { markedCommits: 2, zones: [{ zone: 'home' }, { zone: 'home.pricing' }] },
      })
      expect(await getJson(`${server.url}/api/index`)).toMatchObject({
        index: {
          tree: { children: expect.arrayContaining([expect.objectContaining({ name: 'src' })]) },
        },
      })

      let stream = ''
      const events = get(`${server.url}/api/events`, (response) => {
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (stream += chunk))
      })
      await vi.waitFor(async () => {
        expect(await getJson(`${server.url}/api/validation`)).toMatchObject({
          version: 1,
          configured: true,
          runs: [{ status: 'failed', violations: [{ zones: ['home.pricing'] }] }],
        })
      }, WAIT)

      repo.write('eslint-report.json', '[]')
      repo.write('src/pages/home/Banner.tsx', 'export const Banner = 1\n')
      await vi.waitFor(() => {
        expect(stream).toContain('event: validation\ndata: {"version":2,"running":false}')
      }, WAIT)
      expect(await getJson(`${server.url}/api/validation`)).toMatchObject({
        runs: [{ status: 'passed' }],
      })
      events.destroy()
    })
  })

  describe('beacon watch', () => {
    it('prints validation results next to index changes', async () => {
      repo
        .write('eslint-report.json', eslintReport(repo.root))
        .write('.beacons/config.yml', config('cat eslint-report.json'))
      const watch = repo.start(['watch'])
      await vi.waitFor(() => {
        expect(watch.output.out).toContain('✖ architecture: 1 нарушение архитектуры')
      }, WAIT)
      await watch.stop()
    })
  })
})
