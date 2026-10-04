import { styleText } from 'node:util'

import { type CommandResult, EXIT, result } from '../commands/result.js'
import type { RunContext } from '../commands/running.js'

/** What every command gets from the CLI: the machine's I/O, the options and the repository. */

export interface Io {
  cwd: string
  out: (text: string) => void
  err: (text: string) => void
  readStdin: () => string
  color: boolean
  /** Stops long-running commands (watch, serve, mcp). */
  signal?: AbortSignal
  /** Where `beacon login` keeps tokens of team servers (outside every repository). */
  configDir: string
  /** Opens the dashboard for `beacon login`. */
  openUrl: (url: string) => void
  /** This computer, as the server lists its CLI tokens. */
  deviceName: string
}

export interface Values {
  dir?: string
  tag?: string
  zone?: string
  with?: string[]
  tests?: boolean
  code?: boolean
  port?: string
  host?: string
  origin?: string[]
  depth?: string
  json?: boolean
  conditional?: boolean
  reason?: string
  owner?: string
  deadline?: string
  'waits-for'?: string
  zones?: string
  'debt-id'?: string
  team?: boolean
  server?: string
  project?: string
  browser?: boolean
  delete?: boolean
}

export interface Context {
  root: string
  io: Io
  values: Values
  /** Positional arguments after the command. */
  args: string[]
}

export function runContext({ io }: Context): RunContext {
  return { out: io.out, err: io.err, signal: io.signal ?? new AbortController().signal }
}

export function usage(message: string): CommandResult {
  return result(EXIT.usage, [`✖ ${message}`], { error: message })
}

export function print(outcome: CommandResult, io: Io, json: boolean): void {
  if (json) {
    io.out(JSON.stringify(outcome.json, null, 2))
    return
  }
  if (outcome.text === '') return
  const text = io.color ? colorize(outcome.text) : outcome.text
  if (outcome.code === EXIT.ok) io.out(text)
  else io.err(text)
}

const COLORS = { '✖': 'red', '⚠': 'yellow', '✓': 'green' } as const

function colorize(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const mark = line.trimStart()[0] as keyof typeof COLORS | undefined
      const color = mark === undefined ? undefined : COLORS[mark]
      return color === undefined ? line : styleText(color, line, { validateStream: false })
    })
    .join('\n')
}
