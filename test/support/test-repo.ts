import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runCli } from '../../src/cli/run.js'

export interface Run {
  code: number
  out: string
  err: string
}

/** A throwaway git repository for end-to-end tests of the CLI. */
export class TestRepo {
  private constructor(readonly root: string) {}

  static create(): TestRepo {
    const root = mkdtempSync(path.join(tmpdir(), 'beacon-e2e-'))
    const repo = new TestRepo(root)
    repo.git('init', '-q', '-b', 'main')
    repo.git('config', 'user.name', 'Test User')
    repo.git('config', 'user.email', 'test@example.com')
    repo.git('config', 'commit.gpgsign', 'false')
    return repo
  }

  write(file: string, content: string): this {
    const absolute = path.join(this.root, file)
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
    return this
  }

  read(file: string): string {
    return readFileSync(path.join(this.root, file), 'utf8')
  }

  git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }

  /** Commits everything without running hooks — the way `--no-verify` does. */
  commitAll(message: string): string {
    this.git('add', '-A')
    this.git('commit', '-q', '--no-verify', '--allow-empty', '-m', message)
    return this.git('rev-parse', 'HEAD').trim()
  }

  /** Runs the CLI in-process, like `beacon <argv>` started in `cwd` (the root by default). */
  run(argv: string[], options: { cwd?: string; stdin?: string } = {}): Run {
    let out = ''
    let err = ''
    const code = runCli(argv, {
      cwd: options.cwd ?? this.root,
      out: (text) => {
        out += `${text}\n`
      },
      err: (text) => {
        err += `${text}\n`
      },
      readStdin: () => options.stdin ?? '',
      color: false,
    })
    return { code, out, err }
  }

  /** Makes `node_modules/.bin/beacon` run the CLI built into `dist`, as an installed package would. */
  linkBuiltCli(distMain: string): void {
    const bin = path.join(this.root, 'node_modules/.bin/beacon')
    this.write('node_modules/.bin/beacon', `#!/bin/sh\nexec node "${distMain}" "$@"\n`)
    chmodSync(bin, 0o755)
    this.write('.gitignore', 'node_modules\n')
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}

export const ZONES = `version: 1
zones:
  home:
    title: Главная
    paths: [src/pages/home/**]
  home.pricing:
    title: Тарифы
    tags: [ux]
    paths: [src/widgets/pricing/**]
    formerly: [pricing]
  security.http:
    title: Защита HTTP
    tags: [security]
  billing:
    title: Биллинг
`
