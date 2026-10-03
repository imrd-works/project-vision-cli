/** A finding about the zone map or beacon markup, reported by `check`, hooks and the index. */
export interface Problem {
  severity: 'error' | 'warning'
  message: string
  /** Repository-relative path, when the problem is tied to a file. */
  file?: string
  /** 1-based line number inside `file`. */
  line?: number
}

export function error(message: string, at?: { file: string; line?: number }): Problem {
  return { severity: 'error', message, ...at }
}

export function warning(message: string, at?: { file: string; line?: number }): Problem {
  return { severity: 'warning', message, ...at }
}

export function hasErrors(problems: readonly Problem[]): boolean {
  return problems.some((problem) => problem.severity === 'error')
}
