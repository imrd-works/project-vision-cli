import { describe, expect, it } from 'vitest'

import { onlyRules, parseReport } from './validation.js'

describe('parseReport', () => {
  it('reads ESLint JSON with absolute paths', () => {
    const output = JSON.stringify([
      {
        filePath: '/repo/src/pages/home/ui/Home.tsx',
        messages: [
          {
            ruleId: 'boundaries/dependencies',
            severity: 2,
            message: 'pages must not import app',
            line: 3,
          },
          { ruleId: 'no-console', severity: 1, message: 'Unexpected console' },
          { ruleId: null, severity: 2, message: 'Parsing error' },
        ],
      },
      { filePath: '/repo/src/ok.ts', messages: [] },
    ])
    expect(parseReport('eslint', output, '/repo')).toEqual([
      {
        rule: 'boundaries/dependencies',
        severity: 'error',
        message: 'pages must not import app',
        file: 'src/pages/home/ui/Home.tsx',
        line: 3,
      },
      {
        rule: 'no-console',
        severity: 'warning',
        message: 'Unexpected console',
        file: 'src/pages/home/ui/Home.tsx',
      },
      {
        rule: 'eslint',
        severity: 'error',
        message: 'Parsing error',
        file: 'src/pages/home/ui/Home.tsx',
      },
    ])
  })

  it('reads steiger and dependency-cruiser reports', () => {
    const steiger = JSON.stringify([
      {
        ruleName: 'fsd/forbidden-imports',
        severity: 'error',
        message: 'Forbidden cross-import from slice "user"',
        location: { path: '/repo/src/entities/session/index.ts', start: { line: 2 } },
      },
      {
        ruleName: 'fsd/insignificant-slice',
        severity: 'warn',
        message: 'Slice used once',
        location: { path: '/repo/src/entities/x' },
      },
    ])
    expect(parseReport('steiger', steiger, '/repo')).toEqual([
      {
        rule: 'fsd/forbidden-imports',
        severity: 'error',
        message: 'Forbidden cross-import from slice "user"',
        file: 'src/entities/session/index.ts',
        line: 2,
      },
      {
        rule: 'fsd/insignificant-slice',
        severity: 'warning',
        message: 'Slice used once',
        file: 'src/entities/x',
      },
    ])

    const cruiser = JSON.stringify({
      summary: {
        violations: [
          { from: 'src/a.ts', to: 'src/b.ts', rule: { name: 'no-circular', severity: 'error' } },
        ],
      },
    })
    expect(parseReport('dependency-cruiser', cruiser, '/repo')).toEqual([
      { rule: 'no-circular', severity: 'error', message: 'src/a.ts → src/b.ts', file: 'src/a.ts' },
    ])
  })

  it('throws on output that is not the report', () => {
    expect(() => parseReport('eslint', 'Oops! Something went wrong', '/repo')).toThrow()
    expect(() => parseReport('steiger', '{"a":1}', '/repo')).toThrow()
  })
})

describe('onlyRules', () => {
  const violations = [
    { rule: 'boundaries/dependencies', severity: 'error' as const, message: 'a' },
    { rule: 'import-x/no-cycle', severity: 'error' as const, message: 'b' },
    { rule: 'no-console', severity: 'warning' as const, message: 'c' },
  ]

  it('keeps the architecture rules only', () => {
    expect(
      onlyRules(violations, ['boundaries/*', 'import-x/no-cycle']).map((v) => v.message)
    ).toEqual(['a', 'b'])
    expect(onlyRules(violations, [])).toHaveLength(3)
  })
})
