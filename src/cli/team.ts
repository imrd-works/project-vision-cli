import { login, logout } from '../commands/login.js'
import type { CommandResult } from '../commands/result.js'
import {
  note,
  serverCheckpoints,
  serverTodo,
  sync,
  syncTarget,
  type Target,
} from '../commands/sync.js'

import { type Context, print, usage } from './context.js'

/** The team server: logging in, syncing, notes, and the project's views as of the last sync. */

/** The server of `login`/`logout`: the argument, else the repository's config. */
function serverOf({ root, args, values }: Context): string | CommandResult {
  const [explicit] = args
  if (explicit !== undefined) return explicit.replace(/\/+$/, '')
  const target = syncTarget(root, { server: values.server, project: values.project ?? '-' })
  return 'server' in target ? target.server : target
}

async function printed(
  context: Context,
  outcome: Promise<CommandResult> | CommandResult
): Promise<number> {
  const done = await outcome
  print(done, context.io, context.values.json === true)
  return done.code
}

function withTarget(
  context: Context,
  run: (target: Target) => Promise<CommandResult> | CommandResult
): Promise<number> {
  const target = syncTarget(context.root, context.values)
  return printed(context, 'server' in target ? run(target) : target)
}

export const TEAM_COMMANDS: Record<string, (context: Context) => Promise<number>> = {
  login: (context) => {
    const server = serverOf(context)
    if (typeof server !== 'string') return printed(context, server)
    return printed(
      context,
      login({
        server,
        deviceName: context.io.deviceName,
        configDir: context.io.configDir,
        openUrl: context.values.browser === false ? () => undefined : context.io.openUrl,
        out: context.io.out,
        signal: context.io.signal ?? new AbortController().signal,
      })
    )
  },
  logout: (context) => {
    const server = serverOf(context)
    return printed(
      context,
      typeof server === 'string' ? logout(context.io.configDir, server) : server
    )
  },
  sync: (context) =>
    withTarget(context, (target) => sync(context.root, target, context.io.configDir)),
  note: (context) => {
    const [ref, ...words] = context.args
    if (ref === undefined || (words.length === 0) === (context.values.delete !== true)) {
      return printed(context, usage('beacon note <линия:чекпоинт> <текст> | --delete'))
    }
    const text = context.values.delete === true ? undefined : words.join(' ')
    return withTarget(context, (target) =>
      note(context.root, target, context.io.configDir, { ref, text })
    )
  },
}

/** `checkpoints --team`, `todo --team`: the whole project as of the last `beacon sync`. */
export function teamView(
  command: 'checkpoints' | 'todo',
  { root, values }: Context
): CommandResult {
  const target = syncTarget(root, values)
  if (!('server' in target)) return target
  return command === 'checkpoints'
    ? serverCheckpoints(root, target)
    : serverTodo(root, target, values.owner)
}
