import { parseDocument } from 'yaml'
import { z } from 'zod'

import { error, type Problem } from './problem.js'

/**
 * `.beacons/config.yml`: how the project checks its architecture and how the dynamics chart
 * finds gaps. Optional — without it there are no architecture checks.
 * @see docs/beacon-format.md#проверка-архитектуры
 */
export const CONFIG_PATH = '.beacons/config.yml'

export const VALIDATOR_TOOLS = ['eslint', 'steiger', 'dependency-cruiser'] as const
export type ValidatorTool = (typeof VALIDATOR_TOOLS)[number]

export interface Validator {
  name: string
  tool: ValidatorTool
  /** Shell command run in the repository root; prints the tool's JSON report. */
  command: string
  /** Rule IDs (globs) that count as architecture rules; empty — every rule of the tool. */
  rules: string[]
}

export interface BeaconConfig {
  validation: Validator[]
  dynamics: { gapDays: number }
  techDebt: {
    /** Open debts a developer may carry; beyond it, commits outside debt zones are rejected. */
    limitPerDeveloper: number
    /** An overdue debt is extended by this many days at a time. */
    extendDays: number
  }
  /** Working days without commits in one's zones before a developer counts as stuck. */
  stagnation: { days: number }
  /** The team server and the project this repository is a line of (`beacon sync`). */
  server?: { url: string; project: string }
}

/** The project's own tools in their JSON mode. `--no`: never download a missing tool. */
const DEFAULTS: Record<ValidatorTool, { command: string; rules: string[] }> = {
  eslint: {
    command: 'npx --no eslint . --format json',
    rules: ['boundaries/*', 'import/no-cycle', 'import-x/no-cycle'],
  },
  steiger: { command: 'npx --no steiger src --reporter json', rules: [] },
  'dependency-cruiser': { command: 'npx --no depcruise src --output-type json', rules: [] },
}

export const DEFAULT_CONFIG: BeaconConfig = {
  validation: [],
  dynamics: { gapDays: 3 },
  techDebt: { limitPerDeveloper: 2, extendDays: 7 },
  stagnation: { days: 3 },
}

const configSchema = z.strictObject({
  version: z.literal(1),
  validation: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).optional(),
        tool: z.enum(VALIDATOR_TOOLS),
        command: z.string().trim().min(1).optional(),
        rules: z.array(z.string().trim().min(1)).optional(),
      })
    )
    .default([]),
  dynamics: z
    .strictObject({ gapDays: z.number().int().min(1).max(30).default(3) })
    .default({ gapDays: 3 }),
  techDebt: z
    .strictObject({
      limitPerDeveloper: z.number().int().min(0).max(50).default(2),
      extendDays: z.number().int().min(1).max(90).default(7),
    })
    .default({ limitPerDeveloper: 2, extendDays: 7 }),
  stagnation: z
    .strictObject({ days: z.number().int().min(1).max(60).default(3) })
    .default({ days: 3 }),
  server: z
    .strictObject({
      url: z.url({ protocol: /^https?$/ }).transform((url) => url.replace(/\/+$/, '')),
      project: z.uuid(),
    })
    .optional(),
})

export type ConfigResult = { ok: true; config: BeaconConfig } | { ok: false; problems: Problem[] }

/** Undefined text — no config file: the defaults apply. */
export function parseConfig(text: string | undefined): ConfigResult {
  if (text === undefined) return { ok: true, config: DEFAULT_CONFIG }
  const document = parseDocument(text, { prettyErrors: false })
  if (document.errors.length > 0) {
    return { ok: false, problems: document.errors.map((e) => at(`YAML: ${e.message}`)) }
  }
  const parsed = configSchema.safeParse(document.toJS())
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) =>
        at(`${issue.path.join('.') || 'корень'}: ${issue.message}`)
      ),
    }
  }
  return {
    ok: true,
    config: {
      dynamics: parsed.data.dynamics,
      techDebt: parsed.data.techDebt,
      stagnation: parsed.data.stagnation,
      ...(parsed.data.server === undefined ? {} : { server: parsed.data.server }),
      validation: parsed.data.validation.map((entry) => ({
        name: entry.name ?? entry.tool,
        tool: entry.tool,
        command: entry.command ?? DEFAULTS[entry.tool].command,
        rules: entry.rules ?? DEFAULTS[entry.tool].rules,
      })),
    },
  }
}

/** A starter config for the architecture tools found among the project's dependencies. */
export function draftConfig(dependencies: ReadonlySet<string>): string | undefined {
  const tools = VALIDATOR_TOOLS.filter((tool) =>
    TOOL_PACKAGES[tool].some((name) => dependencies.has(name))
  )
  if (tools.length === 0) return undefined
  const entries = tools.map((tool) => `  - tool: ${tool}`).join('\n')
  return `# Настройки beacon: чем проверять архитектуру (команда и правила — по умолчанию для
# инструмента) и с какого числа рабочих дней без коммитов в зонах показывать провал на графике.
# Спецификация: https://github.com/imrd-works/project-vision-cli/blob/main/docs/beacon-format.md

version: 1

validation:
${entries}

dynamics:
  gapDays: 3

techDebt:
  limitPerDeveloper: 2
  extendDays: 7

stagnation:
  days: 3
`
}

const TOOL_PACKAGES: Record<ValidatorTool, string[]> = {
  eslint: ['eslint-plugin-boundaries'],
  steiger: ['steiger'],
  'dependency-cruiser': ['dependency-cruiser'],
}

function at(message: string): Problem {
  return error(message, { file: CONFIG_PATH })
}
