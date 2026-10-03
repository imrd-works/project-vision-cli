import path from 'node:path'
import { parseArgs, styleText } from 'node:util'

import { audit } from '../commands/audit.js'
import { check } from '../commands/check.js'
import { hook } from '../commands/hook.js'
import { init } from '../commands/init.js'
import { list } from '../commands/list.js'
import { mark } from '../commands/mark.js'
import { mcpCommand } from '../commands/mcp.js'
import { type CommandResult, EXIT, result } from '../commands/result.js'
import { packageVersion, type RunContext } from '../commands/running.js'
import { DEFAULT_ORIGINS, DEFAULT_PORT, serveCommand } from '../commands/serve.js'
import { status } from '../commands/status.js'
import { watchCommand } from '../commands/watch.js'
import { which } from '../commands/which.js'
import { findRepoRoot } from '../workspace/git.js'
import { HOOK_NAMES, type HookName } from '../workspace/hooks.js'

export interface Io {
  cwd: string
  out: (text: string) => void
  err: (text: string) => void
  readStdin: () => string
  color: boolean
  /** Stops long-running commands (watch, serve, mcp). */
  signal?: AbortSignal
}

const HELP = `beacon — зоны и маяки Project Vision

Использование: beacon <команда> [опции]

Команды:
  init                          создать .beacons/zones.yml и подключить git-хуки
  check [--with <репозиторий>]  проверить карту зон и разметку (--with можно повторять)
  list [--tag <тег>] [--zone <id>]
                                зоны с файлами и диапазонами строк
  which <файл>                  зоны файла и регионов в нём
  status                        покрытие кода зонами, состояния зон, папки без зон
  mark <файл> <зона>            поставить маяк зоны на файл
  audit [--tag <тег>] [--zone <id>] [--tests] [--no-code]
                                пакет контекста для аудита нейросетью (Markdown)
  watch                         держать индекс актуальным при изменении файлов
  serve [--port 4317] [--host 127.0.0.1] [--origin <url>]
                                локальный API для дашборда с живыми обновлениями
  mcp                           MCP-сервер для ИИ-агентов (stdio)
  hook <имя> [аргументы git]    точка входа git-хуков (их подключает beacon init)

Опции:
  -C <папка>     работать с репозиторием в этой папке
  --json         вывод в JSON — для плагинов и скриптов
  -h, --help     справка
  -v, --version  версия

Спецификация формата: docs/beacon-format.md`

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

  const root = findRepoRoot(values.dir === undefined ? io.cwd : path.resolve(io.cwd, values.dir))
  if (root === undefined) {
    io.err('✖ beacon работает внутри git-репозитория')
    return EXIT.failed
  }
  const context: Context = { root, io, values }
  if (Object.hasOwn(LONG_RUNNING, command)) return LONG_RUNNING[command]?.(context) ?? EXIT.usage
  const outcome = dispatch(command, rest, context)
  print(outcome, io, values.json === true)
  return outcome.code
}

interface Values {
  tag?: string
  zone?: string
  with?: string[]
  tests?: boolean
  code?: boolean
  port?: string
  host?: string
  origin?: string[]
}

interface Context {
  root: string
  io: Io
  values: Values
}

function runContext({ io }: Context): RunContext {
  return { out: io.out, err: io.err, signal: io.signal ?? new AbortController().signal }
}

const LONG_RUNNING: Record<string, (context: Context) => Promise<number>> = {
  watch: (context) => watchCommand(context.root, runContext(context)),
  mcp: (context) => mcpCommand(context.root, runContext(context)),
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
  init: (_, { root }) => init(root),
  check: (_, { root, io, values }) =>
    check(root, { with: (values.with ?? []).map((dir) => path.resolve(io.cwd, dir)) }),
  list: (_, { root, values: { tag, zone } }) =>
    list(root, { ...(tag === undefined ? {} : { tag }), ...(zone === undefined ? {} : { zone }) }),
  which: ([file], context) =>
    file === undefined
      ? usage('укажите файл: beacon which <файл>')
      : which(context.root, fromCwd(context, file)),
  status: (_, { root }) => status(root),
  audit: (_, { root, values }) =>
    audit(root, {
      tag: values.tag,
      zone: values.zone,
      includeTests: values.tests === true,
      code: values.code !== false,
    }),
  mark: ([file, zone], context) =>
    file === undefined || zone === undefined
      ? usage('beacon mark <файл> <зона>')
      : mark(context.root, fromCwd(context, file), zone),
  hook: ([name, ...args], { root, io }) => {
    if (!isHookName(name)) return usage(`hook: ожидается одно из ${HOOK_NAMES.join(', ')}`)
    if (name === 'pre-push') return hook(root, name, args, io.readStdin())
    // Message hooks get the message file path relative to where git started them.
    const [file, ...rest] = args
    return hook(root, name, file === undefined ? [] : [path.resolve(io.cwd, file), ...rest], '')
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

function usage(message: string): CommandResult {
  return result(EXIT.usage, [`✖ ${message}`], { error: message })
}

function print(outcome: CommandResult, io: Io, json: boolean): void {
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
