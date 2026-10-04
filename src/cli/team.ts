import { login, logout } from '../commands/login.js'
import { owners, setupSigning, whoami } from '../commands/people.js'
import type { CommandResult } from '../commands/result.js'
import {
  note,
  serverCheckpoints,
  serverTodo,
  sync,
  syncTarget,
  type Target,
} from '../commands/sync.js'
import { sign, startAudit } from '../commands/team-audit.js'

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
  whoami: (context) =>
    withTarget(context, (target) => whoami(context.root, target, context.io.configDir)),
  owners: (context) =>
    withTarget(context, (target) => owners(context.root, target, context.args[0])),
  signing: (context) => {
    if (context.args[0] !== 'setup') {
      return printed(context, usage('beacon signing setup [--key <файл .pub>]'))
    }
    // Signing works without a team server too; with one, the key is checked against the team's.
    const target = syncTarget(context.root, context.values)
    return printed(
      context,
      setupSigning(context.root, 'server' in target ? target : undefined, {
        key: context.values.key,
        cwd: context.io.cwd,
        configDir: context.io.configDir,
      })
    )
  },
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
  'audit start': (context) => {
    const [, checkpoint] = context.args
    if (checkpoint === undefined) return printed(context, usage('beacon audit start <чекпоинт>'))
    return withTarget(context, (target) =>
      startAudit(context.root, target, context.io.configDir, checkpoint)
    )
  },
  sign: (context) => {
    const [checkpoint, verdict] = context.args
    if (checkpoint === undefined || verdict === undefined) {
      return printed(
        context,
        usage('beacon sign <чекпоинт> agree|accept-risk|object [--comment …]')
      )
    }
    return withTarget(context, (target) =>
      sign(context.root, target, context.io.configDir, {
        checkpoint,
        verdict,
        comment: context.values.comment,
      })
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
