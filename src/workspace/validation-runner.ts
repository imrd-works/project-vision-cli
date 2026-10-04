import { spawn } from 'node:child_process'

import type { Validator } from '../core/config.js'
import { onlyRules, parseReport, type Violation } from '../core/validation.js'

export interface ZonedViolation extends Violation {
  /** Zones of the file with the violation: whose architecture is broken. */
  zones: string[]
}

export interface ValidationRun {
  name: string
  tool: Validator['tool']
  /** passed: no errors (warnings allowed); failed: architecture errors; error: the tool itself failed. */
  status: 'passed' | 'failed' | 'error'
  violations: ZonedViolation[]
  error?: string
  durationMs: number
  finishedAt: string
}

const TIMEOUT_MS = 5 * 60 * 1000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const STDERR_TAIL = 600

/** Runs one validator's command in the repository root and reads its JSON report. */
export async function runValidator(
  root: string,
  validator: Validator,
  zonesOf: (file: string) => string[]
): Promise<ValidationRun> {
  const started = Date.now()
  const { code, stdout, stderr } = await run(validator.command, root)
  const finish = (
    fields: Pick<ValidationRun, 'status' | 'violations'> & { error?: string }
  ): ValidationRun => ({
    name: validator.name,
    tool: validator.tool,
    ...fields,
    durationMs: Date.now() - started,
    finishedAt: new Date().toISOString(),
  })
  let violations: Violation[]
  try {
    violations = onlyRules(parseReport(validator.tool, stdout, root), validator.rules)
  } catch {
    const detail = stderr.trim().slice(-STDERR_TAIL) || stdout.trim().slice(0, STDERR_TAIL)
    return finish({
      status: 'error',
      violations: [],
      error: `«${validator.command}» завершилась с кодом ${String(code)} без отчёта${detail ? `: ${detail}` : ''}`,
    })
  }
  const zoned = violations.map((violation) => ({
    ...violation,
    zones: violation.file === undefined ? [] : zonesOf(violation.file),
  }))
  return finish({
    status: zoned.some((violation) => violation.severity === 'error') ? 'failed' : 'passed',
    violations: zoned,
  })
}

function run(
  command: string,
  cwd: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_OUTPUT_BYTES) stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS)
    const done = (code: number | null): void => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    }
    child.on('error', () => {
      done(null)
    })
    child.on('close', done)
  })
}
