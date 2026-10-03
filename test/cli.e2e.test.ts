import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TestRepo, ZONES } from './support/test-repo.js'

const DIST_MAIN = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))

const APP = [
  'const app = create()', // 1
  '// #region @beacon security.http', // 2
  'app.use(helmet())', // 3
  '// #endregion', // 4
  'app.listen()', // 5
  '',
].join('\n')

describe('beacon CLI', () => {
  let repo: TestRepo

  beforeEach(() => {
    repo = TestRepo.create()
  })

  afterEach(() => {
    repo.remove()
  })

  /** A repository with the test zone map and some code, everything committed. */
  function seeded(): TestRepo {
    repo
      .write('.beacons/zones.yml', ZONES)
      .write('src/pages/home/HomePage.tsx', 'export const Home = 1\n')
      .write('src/widgets/pricing/Toggle.tsx', 'export const Toggle = 1\n')
      .write('src/app.ts', APP)
      .write('src/shared/money.ts', '// @beacon pricing\nexport const money = 1\n')
      .write('src/core/log.ts', 'export const log = 1\n')
      .commitAll('chore: seed')
    return repo
  }

  function stageAndHook(
    hook: 'prepare-commit-msg' | 'commit-msg',
    message: string,
    ...extra: string[]
  ) {
    repo.git('add', '-A')
    repo.write('.git/COMMIT_EDITMSG', message)
    const result = repo.run(['hook', hook, '.git/COMMIT_EDITMSG', ...extra])
    return { ...result, message: repo.read('.git/COMMIT_EDITMSG') }
  }

  describe('cli basics', () => {
    it('prints help, version and usage errors', () => {
      expect(repo.run(['--help'])).toMatchObject({
        code: 0,
        out: expect.stringContaining('beacon init'),
      })
      expect(repo.run(['--version']).out.trim()).toMatch(/^\d+\.\d+\.\d+$/)
      expect(repo.run([]).code).toBe(2)
      expect(repo.run(['--nope']).code).toBe(2)
      expect(repo.run(['fly']).err).toContain('неизвестная команда')
      expect(repo.run(['hook', 'post-merge']).code).toBe(2)
      expect(repo.run(['which']).code).toBe(2)
      expect(repo.run(['mark', 'a.ts']).code).toBe(2)
    })

    it('works only inside a git repository', () => {
      const outside = mkdtempSync(path.join(tmpdir(), 'beacon-nogit-'))
      try {
        expect(repo.run(['status'], { cwd: outside })).toMatchObject({ code: 1 })
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('asks for a zone map before anything else', () => {
      const result = repo.run(['status'])
      expect(result.code).toBe(1)
      expect(result.err).toContain('beacon init')
    })

    it('explains an invalid zone map', () => {
      repo.write('.beacons/zones.yml', 'version: 1\nzones:\n  Bad:\n    title: x\n')
      const result = repo.run(['check', '--json'])
      expect(result.code).toBe(1)
      expect(JSON.parse(result.out)).toMatchObject({ error: 'invalid-manifest' })
    })
  })

  describe('beacon init', () => {
    it('drafts zones from folders and installs git hooks', () => {
      repo.write('src/modules/auth/auth.service.ts', 'export {}\n')
      const first = repo.run(['init'])
      expect(first.code).toBe(0)
      expect(repo.read('.beacons/zones.yml')).toContain('src/modules/auth/**')
      expect(readdirSync(path.join(repo.root, '.beacons'))).toEqual(['zones.yml'])
      expect(repo.read('.git/hooks/commit-msg')).toContain('hook commit-msg')

      const again = repo.run(['init', '--json'])
      expect(JSON.parse(again.out)).toMatchObject({
        draftedZones: [],
        hooks: {
          installed: [],
          alreadyInstalled: ['prepare-commit-msg', 'commit-msg', 'pre-push'],
        },
      })
    })

    it('appends to husky hooks and leaves foreign git hooks alone', () => {
      repo.write('.husky/pre-push', 'npm run verify\n')
      repo.run(['init'])
      expect(repo.read('.husky/pre-push')).toMatch(/^npm run verify\n.*hook pre-push/s)

      const plain = TestRepo.create()
      try {
        plain.write('.git/hooks/commit-msg', '#!/bin/sh\nexit 0\n')
        const result = plain.run(['init'])
        expect(result.out).toContain('чужой хук')
        expect(plain.read('.git/hooks/commit-msg')).toBe('#!/bin/sh\nexit 0\n')
      } finally {
        plain.remove()
      }
    })
  })

  describe('reading commands', () => {
    beforeEach(() => seeded())

    it('check passes on clean markup and fails on mistakes', () => {
      expect(repo.run(['check'])).toMatchObject({ code: 0, out: expect.stringContaining('✓') })
      repo.write('src/broken.ts', '// @beacon no-such-zone\n// #region @beacon billing\n')
      const result = repo.run(['check'])
      expect(result.code).toBe(1)
      expect(result.err).toContain('src/broken.ts:1: маяк неизвестной зоны "no-such-zone"')
      expect(result.err).toContain('не закрыт')
    })

    it('check --with compares zone IDs with another repository', () => {
      const other = TestRepo.create()
      try {
        other.write(
          '.beacons/zones.yml',
          'version: 1\nzones:\n  home:\n    title: H\n  devops:\n    title: D\n'
        )
        const result = repo.run(['check', '--with', other.root])
        expect(result.code).toBe(0)
        expect(result.out).toContain('зона "devops" есть только в')
        expect(result.out).toContain('зона "billing" есть только здесь')
        expect(repo.run(['check', '--with', '/nonexistent']).out).toContain('не найдена')
      } finally {
        other.remove()
      }
    })

    it('list gives files and region ranges by tag or zone branch', () => {
      const security = repo.run(['list', '--tag', 'security'])
      expect(security.out).toContain('security.http  Защита HTTP  [security]  — активна')
      expect(security.out).toContain('src/app.ts:2-4')
      expect(security.out).not.toContain('home')

      const home = JSON.parse(repo.run(['list', '--zone', 'home', '--json']).out) as {
        zones: { id: string; files: string[] }[]
      }
      expect(home.zones.map((zone) => zone.id)).toEqual(['home', 'home.pricing'])
      expect(home.zones[1]?.files).toEqual([
        'src/shared/money.ts',
        'src/widgets/pricing/Toggle.tsx',
      ])
      expect(repo.run(['list', '--tag', 'nothing']).out).toContain('Подходящих зон нет')
    })

    it('which resolves paths from the current folder', () => {
      expect(repo.run(['which', 'app.ts'], { cwd: path.join(repo.root, 'src') }).out).toContain(
        'security.http  строки 2-4'
      )
      expect(repo.run(['which', 'src/core/log.ts']).out).toContain('вне зон')
      expect(repo.run(['which', 'src/missing.ts']).code).toBe(1)
      const json = JSON.parse(repo.run(['which', 'src/shared/money.ts', '--json']).out) as unknown
      expect(json).toMatchObject({ zones: [{ id: 'home.pricing', tags: ['ux'] }] })
    })

    it('status shows coverage, states and unmapped folders', () => {
      repo.commitAll('feat(billing): done [BEACON: home completed]')
      const result = repo.run(['status'])
      expect(result.out).toContain('Покрытие: 80% исходных файлов в зонах (4 из 5)')
      expect(result.out).toContain('✓ home')
      expect(result.out).toContain('○ billing')
      expect(result.out).toContain('Папки без зон:\n  src/core')
      // The index cache lives in the git directory, out of formatters' and linters' way.
      expect(existsSync(path.join(repo.root, '.git/beacon/index.db'))).toBe(true)
      expect(repo.git('status', '--porcelain')).toBe('')
    })

    it('mark adds a file beacon in the right comment syntax', () => {
      repo.write('src/server/headers.py', '#!/usr/bin/env python\nimport os\n')
      expect(repo.run(['mark', 'src/server/headers.py', 'security.http']).code).toBe(0)
      expect(repo.read('src/server/headers.py')).toBe(
        '#!/usr/bin/env python\n# @beacon security.http\nimport os\n'
      )
      expect(repo.run(['mark', 'src/server/headers.py', 'security.http']).out).toContain(
        'уже в зоне'
      )
      expect(repo.run(['mark', 'src/core/log.ts', 'pricing']).out).toContain('прежнее имя')
      expect(repo.run(['mark', 'src/core/log.ts', 'ghost']).code).toBe(1)
      expect(repo.run(['mark', 'src/none.ts', 'billing']).code).toBe(1)
      repo.write('data.json', '{}')
      expect(repo.run(['mark', 'data.json', 'billing']).err).toContain('paths')
    })
  })

  describe('commit hooks', () => {
    beforeEach(() => seeded())

    it('prepare-commit-msg writes beacons of the touched zones', () => {
      repo.write('src/widgets/pricing/Toggle.tsx', 'export const Toggle = 2\n')
      repo.write('src/app.ts', APP.replace('helmet()', 'helmet({})'))
      const result = stageAndHook('prepare-commit-msg', 'feat(home): toggle\n', 'message')
      expect(result.message).toBe(
        'feat(home): toggle\n\n[BEACON: home.pricing]\n[BEACON: security.http]\n'
      )
    })

    it('prepare-commit-msg keeps existing beacons and skips merges', () => {
      repo.write('src/widgets/pricing/Toggle.tsx', 'export const Toggle = 2\n')
      expect(stageAndHook('prepare-commit-msg', 'x [BEACON: pricing]\n').message).toBe(
        'x [BEACON: pricing]\n'
      )
      expect(stageAndHook('prepare-commit-msg', 'Merge\n', 'merge').message).toBe('Merge\n')
    })

    it('commit-msg rejects missing beacons and accepts complete ones', () => {
      repo.write('src/app.ts', APP.replace('helmet()', 'helmet({})'))
      const rejected = stageAndHook('commit-msg', 'fix(app): headers\n')
      expect(rejected.code).toBe(1)
      expect(rejected.err).toContain('Добавьте в сообщение: [BEACON: security.http]')

      expect(stageAndHook('commit-msg', 'fix(app): headers [BEACON: security.http]\n').code).toBe(0)
    })

    it('commit-msg ignores changes outside zones and regions', () => {
      repo.write('src/app.ts', APP.replace('app.listen()', 'app.listen(3000)'))
      repo.write('src/core/log.ts', 'export const log = 2\n')
      expect(stageAndHook('commit-msg', 'fix(app): port\n').code).toBe(0)
    })

    it('commit-msg reports a broken zone map and stays out of repos without one', () => {
      repo.write('.beacons/zones.yml', 'version: 1\nzones:\n  Bad:\n    title: x\n')
      expect(stageAndHook('commit-msg', 'chore: x\n').err).toContain('карта зон некорректна')

      const bare = TestRepo.create()
      try {
        bare.write('a.ts', 'x').write('.git/COMMIT_EDITMSG', 'x')
        bare.git('add', '-A')
        expect(bare.run(['hook', 'commit-msg', '.git/COMMIT_EDITMSG']).code).toBe(0)
        expect(bare.run(['hook', 'prepare-commit-msg', '.git/COMMIT_EDITMSG']).code).toBe(0)
      } finally {
        bare.remove()
      }
    })
  })

  describe('pre-push', () => {
    beforeEach(() => seeded())

    it('re-checks pushed commits, including those made with --no-verify', () => {
      const base = repo.git('rev-parse', 'HEAD').trim()
      repo.write('src/widgets/pricing/Toggle.tsx', 'export const Toggle = 2\n')
      const bad = repo.commitAll('feat(home): sneaky')
      repo.write('src/pages/home/HomePage.tsx', 'export const Home = 2\n')
      const good = repo.commitAll('feat(home): ok [BEACON: home]')
      const zero = '0'.repeat(40)

      const pushed = repo.run(['hook', 'pre-push', 'origin', 'url'], {
        stdin: `refs/heads/main ${good} refs/heads/main ${base}\n`,
      })
      expect(pushed.code).toBe(1)
      expect(pushed.err).toContain(`✖ ${bad.slice(0, 7)} feat(home): sneaky`)
      expect(pushed.err).not.toContain('feat(home): ok')

      // A new branch: commits that no remote has yet. There is no remote, so all of them.
      const fresh = repo.run(['hook', 'pre-push', 'origin', 'url'], {
        stdin: `refs/heads/feat ${good} refs/heads/feat ${zero}\n`,
      })
      expect(fresh.code).toBe(1)

      // Deleting a remote branch pushes nothing.
      const deletion = repo.run(['hook', 'pre-push', 'origin', 'url'], {
        stdin: `(delete) ${zero} refs/heads/old ${base}\n`,
      })
      expect(deletion.code).toBe(0)
    })
  })

  describe('real git hooks', () => {
    it('auto-fills beacons on commit and blocks unknown ones', () => {
      seeded().linkBuiltCli(DIST_MAIN)
      expect(repo.run(['init']).code).toBe(0)

      repo.write('src/widgets/pricing/Toggle.tsx', 'export const Toggle = 3\n')
      repo.git('add', '-A')
      repo.git('commit', '-q', '-m', 'feat(home): yearly toggle')
      expect(repo.git('log', '-1', '--format=%B')).toBe(
        'feat(home): yearly toggle\n\n[BEACON: home.pricing]\n\n'
      )

      repo.write('src/core/log.ts', 'export const log = 3\n')
      repo.git('add', '-A')
      expect(() => repo.git('commit', '-q', '-m', 'chore: x [BEACON: typo]')).toThrow(
        /такой зоны нет/
      )
      expect(readFileSync(path.join(repo.root, '.git/hooks/pre-push'), 'utf8')).toContain('beacon')
      // The binary itself starts and answers.
      expect(execFileSync('node', [DIST_MAIN, '--version'], { encoding: 'utf8' })).toMatch(
        /\d+\.\d+/
      )
    })
  })
})
