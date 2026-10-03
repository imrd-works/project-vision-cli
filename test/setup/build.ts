import { execFileSync } from 'node:child_process'

/** The git-hooks scenario runs the real `beacon` binary, so build it once before e2e tests. */
export function setup(): void {
  execFileSync('npm', ['run', 'build'], { stdio: 'ignore' })
}
