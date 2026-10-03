import { readFileSync } from 'node:fs'

/** What long-running commands (watch, serve, mcp) get: output channels and a stop signal. */
export interface RunContext {
  out: (text: string) => void
  err: (text: string) => void
  /** Aborted on Ctrl+C / SIGTERM; the command stops and resolves its exit code. */
  signal: AbortSignal
}

export function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else
      signal.addEventListener(
        'abort',
        () => {
          resolve()
        },
        { once: true }
      )
  })
}

export function packageVersion(): string {
  const file = new URL('../../package.json', import.meta.url)
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version
}
