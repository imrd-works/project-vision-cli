import path from 'node:path'

import picomatch from 'picomatch'
import { z } from 'zod'

import type { ValidatorTool } from './config.js'

/**
 * Architecture violations from the project's own tools (ESLint with boundary rules, steiger,
 * dependency-cruiser), brought to one shape: what rule, where, how bad.
 */
export interface Violation {
  rule: string
  severity: 'error' | 'warning'
  message: string
  /** Repository-relative path. */
  file?: string
  line?: number
}

const eslintReport = z.array(
  z.object({
    filePath: z.string(),
    messages: z.array(
      z.object({
        ruleId: z.string().nullable().optional(),
        severity: z.number(),
        message: z.string(),
        line: z.number().optional(),
      })
    ),
  })
)

const steigerReport = z.array(
  z.object({
    ruleName: z.string(),
    severity: z.enum(['error', 'warn']).optional(),
    message: z.string(),
    location: z.object({
      path: z.string(),
      start: z.object({ line: z.number().optional() }).optional(),
    }),
  })
)

const dependencyCruiserReport = z.object({
  summary: z.object({
    violations: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        rule: z.object({ name: z.string(), severity: z.string() }),
      })
    ),
  }),
})

/** Parses a tool's JSON report; throws when the output is not that report. */
export function parseReport(tool: ValidatorTool, output: string, root: string): Violation[] {
  const json: unknown = JSON.parse(output)
  switch (tool) {
    case 'eslint': {
      return eslintReport.parse(json).flatMap((file) =>
        file.messages.map((message) => ({
          rule: message.ruleId ?? 'eslint',
          severity: message.severity === 2 ? ('error' as const) : ('warning' as const),
          message: message.message,
          file: relative(root, file.filePath),
          ...(message.line === undefined ? {} : { line: message.line }),
        }))
      )
    }
    case 'steiger': {
      return steigerReport.parse(json).map((diagnostic) => ({
        rule: diagnostic.ruleName,
        severity: diagnostic.severity === 'warn' ? ('warning' as const) : ('error' as const),
        message: diagnostic.message,
        file: relative(root, diagnostic.location.path),
        ...(diagnostic.location.start?.line === undefined
          ? {}
          : { line: diagnostic.location.start.line }),
      }))
    }
    case 'dependency-cruiser': {
      return dependencyCruiserReport.parse(json).summary.violations.map((violation) => ({
        rule: violation.rule.name,
        severity: violation.rule.severity === 'error' ? ('error' as const) : ('warning' as const),
        message: `${violation.from} → ${violation.to}`,
        file: violation.from,
      }))
    }
  }
}

/** Keeps violations of the given rule globs; no globs — keeps everything. */
export function onlyRules(violations: readonly Violation[], rules: readonly string[]): Violation[] {
  if (rules.length === 0) return [...violations]
  const matches = picomatch([...rules])
  return violations.filter((violation) => matches(violation.rule))
}

function relative(root: string, file: string): string {
  return path.isAbsolute(file) ? path.relative(root, file).split(path.sep).join('/') : file
}
