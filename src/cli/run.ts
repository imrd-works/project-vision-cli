import path from 'node:path'
import { parseArgs } from 'node:util'

import { agentGate } from '../commands/agent-gate.js'
import { check } from '../commands/check.js'
import { checkpointCommand, debtCommand } from '../commands/checkpoint.js'
import { checkpoints } from '../commands/checkpoints.js'
import { history } from '../commands/history.js'
import { hook } from '../commands/hook.js'
import { init } from '../commands/init.js'
import { list } from '../commands/list.js'
import { mark } from '../commands/mark.js'
import { mcpCommand } from '../commands/mcp.js'
import { gate } from '../commands/ownership.js'
import { type CommandResult, EXIT } from '../commands/result.js'
import { rights } from '../commands/rights.js'
import { packageVersion } from '../commands/running.js'
import { DEFAULT_ORIGINS, DEFAULT_PORT, serveCommand } from '../commands/serve.js'
import { status } from '../commands/status.js'
import { todo } from '../commands/todo.js'
import { tree } from '../commands/tree.js'
import { validate } from '../commands/validate.js'
import { watchCommand } from '../commands/watch.js'
import { which } from '../commands/which.js'
import { findRepoRoot } from '../workspace/git.js'
import { HOOK_NAMES, type HookName } from '../workspace/hooks.js'

import { auditCommand } from './audit-command.js'
import { type Context, type Io, print, runContext, usage } from './context.js'
import { HELP } from './help.js'
import { TEAM_COMMANDS, teamView } from './team.js'

export type { Io } from './context.js'

const OPTIONS = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  tag: { type: 'string' },
  zone: { type: 'string' },
  with: { type: 'string', multiple: true },
  dir: { type: 'string', short: 'C' },
  tests: { type: 'boolean' },
  code: { type: 'boolean', default: true },
  port: { type: 'string' },
  host: { type: 'string' },
  origin: { type: 'string', multiple: true },
  depth: { type: 'string' },
  conditional: { type: 'boolean' },
  reason: { type: 'string' },
  owner: { type: 'string' },
  deadline: { type: 'string' },
  'waits-for': { type: 'string' },
  zones: { type: 'string' },
  'debt-id': { type: 'string' },
  checkpoint: { type: 'string' },
  model: { type: 'string' },
  comment: { type: 'string' },
  team: { type: 'boolean' },
  server: { type: 'string' },
  project: { type: 'string' },
  browser: { type: 'boolean', default: true },
  delete: { type: 'boolean' },
  key: { type: 'string' },
  agent: { type: 'boolean' },
  'agent-hooks': { type: 'boolean' },
  until: { type: 'string' },
  rule: { type: 'string' },
  paths: { type: 'string' },
  raw: { type: 'string' },
  id: { type: 'string' },
  reject: { type: 'boolean' },
} as const

const PARSE_CONFIG = {
  options: OPTIONS,
  allowPositionals: true,
  allowNegative: true,
  strict: true,
} as const
type Parsed = ReturnType<typeof parseArgs<typeof PARSE_CONFIG>>

function parse(argv: readonly string[], io: Io): Parsed | undefined {
  try {
    return parseArgs({ ...PARSE_CONFIG, args: [...argv] })
  } catch (error_) {
    io.err(`${error_ instanceof Error ? error_.message : String(error_)}\n\n${HELP}`)
    return undefined
  }
}

/** `--version`, `--help` and a bare `beacon`: answered without a repository. */
function answerWithoutRepo(
  command: string | undefined,
  values: { help?: boolean; version?: boolean },
  io: Io
): number | undefined {
  if (values.version) {
    io.out(packageVersion())
    return EXIT.ok
  }
  if (values.help || command === undefined || command === 'help') {
    io.out(HELP)
    return command === undefined && !values.help ? EXIT.usage : EXIT.ok
  }
  return undefined
}

export function runCli(argv: readonly string[], io: Io): number | Promise<number> {
  const parsed = parse(argv, io)
  if (!parsed) return EXIT.usage
  const { values, positionals } = parsed
  const [command, ...rest] = positionals
  const early = answerWithoutRepo(command, values, io)
  if (early !== undefined || command === undefined) return early ?? EXIT.usage

  const context = contextFor(command, rest, values, io)
  if (context === undefined) {
    io.err('✖ beacon работает внутри git-репозитория')
    return EXIT.failed
  }
  const long = longRunning(command, rest)
  if (long) return long(context)
  const outcome = dispatch(command, rest, context)
  print(outcome, io, values.json === true)
  return outcome.code
}

/** `audit start` talks to the server; the other audit steps work in the working copy. */
function longRunning(
  command: string,
  args: readonly string[]
): ((context: Context) => Promise<number>) | undefined {
  const sub = `${command} ${args[0] ?? ''}`
  const name = sub === 'audit start' ? sub : command
  return Object.hasOwn(LONG_RUNNING, name) ? LONG_RUNNING[name] : undefined
}

/** The repository to work in; logging in and out of a named server needs none. */
function contextFor(
  command: string,
  args: string[],
  values: Context['values'],
  io: Io
): Context | undefined {
  const root = findRepoRoot(values.dir === undefined ? io.cwd : path.resolve(io.cwd, values.dir))
  if (root !== undefined) return { root, io, values, args }
  const repoless = (command === 'login' || command === 'logout') && args[0] !== undefined
  return repoless ? { root: io.cwd, io, values, args } : undefined
}

const LONG_RUNNING: Record<string, (context: Context) => Promise<number>> = {
  ...TEAM_COMMANDS,
  watch: (context) => watchCommand(context.root, runContext(context)),
  mcp: (context) =>
    mcpCommand(context.root, runContext(context), { configDir: context.io.configDir }),
  validate: async ({ root, io, values }) => {
    const outcome = await validate(root)
    print(outcome, io, values.json === true)
    return outcome.code
  },
  serve: async (context) => {
    const port = Number(context.values.port ?? DEFAULT_PORT)
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      print(
        usage(`--port: ожидается номер порта, получено "${context.values.port ?? ''}"`),
        context.io,
        false
      )
      return EXIT.usage
    }
    const options = {
      port,
      host: context.values.host ?? '127.0.0.1',
      origins: context.values.origin ?? DEFAULT_ORIGINS,
      with: (context.values.with ?? []).map((dir) => path.resolve(context.io.cwd, dir)),
    }
    return serveCommand(context.root, options, runContext(context))
  },
}

type Handler = (args: string[], context: Context) => CommandResult

/** Repository-relative POSIX path for a path the user typed relative to the current folder. */
function fromCwd({ root, io }: Context, file: string): string {
  return path.relative(root, path.resolve(io.cwd, file)).split(path.sep).join('/')
}

const COMMANDS: Record<string, Handler> = {
  init: (_, { root, values }) => init(root, { agentHooks: values['agent-hooks'] === true }),
  gate: (files, context) => {
    const { root, io, values } = context
    if (values.agent === true) return agentGate(root, io.readStdin(), io.configDir)
    if (files.length === 0) return usage('beacon gate <файлы…>')
    return gate(
      root,
      files.map((file) => fromCwd(context, file)),
      io.configDir
    )
  },
  rights: (_, { root, io }) => rights(root, io.configDir),
  check: (_, { root, io, values }) =>
    check(root, { with: (values.with ?? []).map((dir) => path.resolve(io.cwd, dir)) }),
  list: (_, { root, values: { tag, zone } }) =>
    list(root, { ...(tag === undefined ? {} : { tag }), ...(zone === undefined ? {} : { zone }) }),
  which: ([file], context) =>
    file === undefined
      ? usage('укажите файл: beacon which <файл>')
      : which(context.root, fromCwd(context, file)),
  status: (_, { root }) => status(root),
  history: (_, { root }) => history(root),
  checkpoints: (_, context) => {
    const { root, io, values } = context
    if (values.team === true) return teamView('checkpoints', context)
    return checkpoints(root, { with: (values.with ?? []).map((dir) => path.resolve(io.cwd, dir)) })
  },
  checkpoint: (args, { root, values }) =>
    checkpointCommand(root, args, {
      conditional: values.conditional,
      reason: values.reason,
      owner: values.owner,
      deadline: values.deadline,
      waitsFor: values['waits-for'],
      zones: values.zones,
      debtId: values['debt-id'],
    }),
  debt: (args, { root }) => debtCommand(root, args),
  todo: (_, context) => {
    const { root, io, values } = context
    if (values.team === true) return teamView('todo', context)
    return todo(root, {
      owner: values.owner,
      with: (values.with ?? []).map((dir) => path.resolve(io.cwd, dir)),
    })
  },
  tree: (_, { root, values }) => {
    const depth = values.depth === undefined ? undefined : Number(values.depth)
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) {
      return usage(`--depth: ожидается целое число от 1, получено "${values.depth ?? ''}"`)
    }
    return tree(root, { depth })
  },
  audit: (args, context) => auditCommand(args, context),
  mark: ([file, zone], context) =>
    file === undefined || zone === undefined
      ? usage('beacon mark <файл> <зона>')
      : mark(context.root, fromCwd(context, file), zone),
  hook: ([name, ...args], { root, io }) => {
    if (!isHookName(name)) return usage(`hook: ожидается одно из ${HOOK_NAMES.join(', ')}`)
    const { configDir } = io
    if (name === 'pre-push') return hook(root, name, args, { stdin: io.readStdin(), configDir })
    // Message hooks get the message file path relative to where git started them.
    const [file, ...rest] = args
    const resolved = file === undefined ? [] : [path.resolve(io.cwd, file), ...rest]
    return hook(root, name, resolved, { stdin: '', configDir })
  },
}

function dispatch(command: string, args: string[], context: Context): CommandResult {
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined
  return handler
    ? handler(args, context)
    : usage(`неизвестная команда "${command}" — см. beacon --help`)
}

function isHookName(name: string | undefined): name is HookName {
  return HOOK_NAMES.includes(name as HookName)
}
