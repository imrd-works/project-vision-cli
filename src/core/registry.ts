import picomatch from 'picomatch'
import { parseDocument } from 'yaml'
import { z } from 'zod'

import { type Manifest, resolveZoneId } from './manifest.js'
import { error, type Problem, warning } from './problem.js'
import { isAncestorOrSelf } from './zone-id.js'

/**
 * The architect's registry, in git next to the code:
 *
 *   .beacons/rules.yml        required conditions: architecture, API structure, naming
 *   .beacons/exceptions.yml   deliberate deviations: which rule, where, why, who asked
 *
 * An exception names the zones it applies to, so an audit of a topic sees the deviations of its
 * zones right beside their code. Who approved it is not written here — anyone can edit a file:
 * approvals live on the team server and are made by zone or project owners.
 * @see docs/beacon-format.md#правила-и-исключения
 */

export const RULES_PATH = '.beacons/rules.yml'
export const EXCEPTIONS_PATH = '.beacons/exceptions.yml'

export const RULE_KINDS = ['architecture', 'api', 'naming', 'other'] as const

const SLUG = /^[a-z][a-z0-9-]*$/
const slug = z.string().regex(SLUG, 'латиница в нижнем регистре, цифры, дефис')
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата в формате ГГГГ-ММ-ДД')
const email = z.string().regex(/^[^\s@]+@[^\s@]+$/, 'email из git config user.email')
const text = z.string().trim().min(1)
const list = <T extends z.ZodType>(item: T): z.ZodDefault<z.ZodArray<T>> =>
  z.array(item).default([])

const ruleSchema = z.strictObject({
  title: text,
  kind: z.enum(RULE_KINDS).default('other'),
  description: z.string().trim().optional(),
  /** Zones (with their subzones) the rule applies to; none — the whole repository. */
  zones: list(z.string()),
  /** Rules of the project's validators (globs over rule IDs) that check this rule. */
  validatorRules: list(text),
  /** File names that must match a pattern: `{ paths: [src/**\/ui/*.tsx], pattern: ^[A-Z] }`. */
  naming: list(
    z.strictObject({ paths: z.array(text).min(1), pattern: text, message: z.string().optional() })
  ),
})

const exceptionSchema = z.strictObject({
  id: slug,
  rule: slug,
  zones: list(z.string()),
  /** Files it covers (globs); none — every file of its zones. */
  paths: list(text),
  /** The deviation and why, in clean words. */
  reason: text,
  /** The developer's own words, when an assistant rewrote them into `reason`. */
  raw: z.string().trim().optional(),
  author: email,
  date: day,
  /** The checkpoint it was agreed for: `line:id` or `id`. */
  checkpoint: z.string().optional(),
})

const rulesFile = z.strictObject({
  version: z.literal(1),
  rules: z
    .record(slug, ruleSchema)
    .nullish()
    .transform((value) => value ?? {}),
})

const exceptionsFile = z.strictObject({
  version: z.literal(1),
  exceptions: z
    .array(exceptionSchema)
    .nullish()
    .transform((value) => value ?? []),
})

export type Rule = z.infer<typeof ruleSchema> & { id: string }
export type ArchException = z.infer<typeof exceptionSchema>

export interface Registry {
  rules: Rule[]
  exceptions: ArchException[]
  problems: Problem[]
}

/** A naming check that failed: which rule, which file. */
export interface NamingViolation {
  rule: string
  file: string
  message: string
}

/** Rules and exceptions of a repository; missing files are an empty registry. */
export function parseRegistry(
  files: { rules?: string | undefined; exceptions?: string | undefined },
  manifest: Manifest | undefined
): Registry {
  const rules = parseRules(files.rules)
  const exceptions = parseExceptions(files.exceptions, rules.rules, manifest)
  const zoneProblems = manifest
    ? rules.rules.flatMap((rule) =>
        unknownZones(rule.zones, manifest).map((zone) =>
          warning(`правило "${rule.id}": зоны "${zone}" нет в zones.yml`, { file: RULES_PATH })
        )
      )
    : []
  return {
    rules: rules.rules,
    exceptions: exceptions.exceptions,
    problems: [...rules.problems, ...zoneProblems, ...exceptions.problems],
  }
}

function parseRules(source: string | undefined): { rules: Rule[]; problems: Problem[] } {
  if (source === undefined) return { rules: [], problems: [] }
  const parsed = parseYaml(source, rulesFile, RULES_PATH)
  if (!parsed.ok) return { rules: [], problems: parsed.problems }
  const rules = Object.entries(parsed.data.rules).map(([id, rule]) => ({ ...rule, id }))
  const problems = rules.flatMap((rule) =>
    rule.naming.flatMap((check) => {
      try {
        new RegExp(check.pattern, 'u')
        return []
      } catch {
        return [at(RULES_PATH, `правило "${rule.id}": некорректный шаблон "${check.pattern}"`)]
      }
    })
  )
  return { rules, problems }
}

function parseExceptions(
  source: string | undefined,
  rules: readonly Rule[],
  manifest: Manifest | undefined
): { exceptions: ArchException[]; problems: Problem[] } {
  if (source === undefined) return { exceptions: [], problems: [] }
  const parsed = parseYaml(source, exceptionsFile, EXCEPTIONS_PATH)
  if (!parsed.ok) return { exceptions: [], problems: parsed.problems }
  const problems: Problem[] = []
  const seen = new Set<string>()
  const exceptions = parsed.data.exceptions.map((exception) => {
    const where = `исключение "${exception.id}"`
    if (seen.has(exception.id)) problems.push(at(EXCEPTIONS_PATH, `${where} указано дважды`))
    seen.add(exception.id)
    if (rules.every((rule) => rule.id !== exception.rule)) {
      problems.push(at(EXCEPTIONS_PATH, `${where}: правила "${exception.rule}" нет в rules.yml`))
    }
    if (exception.zones.length === 0 && exception.paths.length === 0) {
      problems.push(at(EXCEPTIONS_PATH, `${where}: укажите zones или paths — к чему оно относится`))
    }
    if (!manifest) return exception
    for (const zone of unknownZones(exception.zones, manifest)) {
      problems.push(at(EXCEPTIONS_PATH, `${where}: зоны "${zone}" нет в zones.yml`))
    }
    return {
      ...exception,
      zones: exception.zones.map((zone) => resolveZoneId(manifest, zone) ?? zone),
    }
  })
  return { exceptions, problems }
}

/** Rules that apply to a zone: rules without zones apply everywhere. */
export function rulesOfZone(rules: readonly Rule[], zone: string): Rule[] {
  return rules.filter(
    (rule) => rule.zones.length === 0 || rule.zones.some((id) => isAncestorOrSelf(id, zone))
  )
}

/** Exceptions made in a zone or its subzones. */
export function exceptionsOfZone(
  exceptions: readonly ArchException[],
  zone: string
): ArchException[] {
  return exceptions.filter((exception) =>
    exception.zones.some((id) => isAncestorOrSelf(zone, id) || isAncestorOrSelf(id, zone))
  )
}

/** File names against the naming checks of the rules. */
export function namingViolations(
  rules: readonly Rule[],
  files: readonly string[]
): NamingViolation[] {
  return rules.flatMap((rule) =>
    rule.naming.flatMap((check) => {
      const inScope = picomatch(check.paths, { dot: true })
      const pattern = new RegExp(check.pattern, 'u')
      return files
        .filter((file) => inScope(file) && !pattern.test(file.split('/').at(-1) ?? file))
        .map((file) => ({
          rule: rule.id,
          file,
          message: check.message ?? `«${rule.title}»: имя не подходит под ${check.pattern}`,
        }))
    })
  )
}

/**
 * The exception that covers a deviation: of the same rule (or, for a validator's finding, a rule
 * that names that validator rule) and in its scope — its paths, or else its zones.
 */
export function coveringException(
  registry: Pick<Registry, 'rules' | 'exceptions'>,
  deviation: { rule?: string; validatorRule?: string; file?: string; zones: readonly string[] }
): ArchException | undefined {
  const rules = new Set(
    deviation.validatorRule === undefined
      ? [deviation.rule]
      : registry.rules
          .filter((rule) => picomatch.isMatch(deviation.validatorRule ?? '', rule.validatorRules))
          .map((rule) => rule.id)
  )
  return registry.exceptions.find((exception) => {
    if (!rules.has(exception.rule)) return false
    if (exception.paths.length > 0) {
      return deviation.file !== undefined && picomatch.isMatch(deviation.file, exception.paths)
    }
    return deviation.zones.some((zone) => exception.zones.some((id) => isAncestorOrSelf(id, zone)))
  })
}

function unknownZones(zones: readonly string[], manifest: Manifest): string[] {
  return zones.filter((zone) => resolveZoneId(manifest, zone) === undefined)
}

function parseYaml<T extends z.ZodType>(
  source: string,
  schema: T,
  file: string
): { ok: true; data: z.infer<T> } | { ok: false; problems: Problem[] } {
  const document = parseDocument(source, { prettyErrors: false })
  if (document.errors.length > 0) {
    return { ok: false, problems: document.errors.map((e) => at(file, `YAML: ${e.message}`)) }
  }
  const parsed = schema.safeParse(document.toJS())
  if (parsed.success) return { ok: true, data: parsed.data }
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) =>
      at(file, `${issue.path.join('.') || 'корень'}: ${issue.message}`)
    ),
  }
}

function at(file: string, message: string): Problem {
  return error(message, { file })
}
