import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs, styleText } from 'node:util'

import { check } from '../commands/check.js'
import { hook } from '../commands/hook.js'
import { init } from '../commands/init.js'
import { list } from '../commands/list.js'
import { mark } from '../commands/mark.js'
import { type CommandResult, EXIT, result } from '../commands/result.js'
import { status } from '../commands/status.js'
import { which } from '../commands/which.js'
import { findRepoRoot } from '../workspace/git.js'
import { HOOK_NAMES, type HookName } from '../workspace/hooks.js'

export interface Io {
  cwd: string
  out: (text: string) => void
  err: (text: string) => void
  readStdin: () => string
  color: boolean
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
  hook <имя> [аргументы git]    точка входа git-хуков (их подключает beacon init)

Опции:
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
} as const

export function runCli(argv: readonly string[], io: Io): number {
  let parsed
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error_) {
    io.err(`${error_ instanceof Error ? error_.message : String(error_)}\n\n${HELP}`)
    return EXIT.usage
  }
  const { values, positionals } = parsed
  if (values.version) {
    io.out(version())
    return EXIT.ok
  }
  const [command, ...rest] = positionals
  if (values.help || command === undefined || command === 'help') {
    io.out(HELP)
    return command === undefined && !values.help ? EXIT.usage : EXIT.ok
  }

  const root = findRepoRoot(io.cwd)
  if (root === undefined) {
    io.err('✖ beacon работает внутри git-репозитория')
    return EXIT.failed
  }
  const outcome = dispatch(command, rest, { root, io, values })
  print(outcome, io, values.json === true)
  return outcome.code
}

interface Context {
  root: string
  io: Io
  values: { tag?: string; zone?: string; with?: string[] }
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

function version(): string {
  const file = new URL('../../package.json', import.meta.url)
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version: string }
  return pkg.version
}
