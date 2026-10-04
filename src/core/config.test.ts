import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, draftConfig, parseConfig } from './config.js'

describe('parseConfig', () => {
  it('falls back to defaults without a config file', () => {
    expect(parseConfig(undefined)).toEqual({ ok: true, config: DEFAULT_CONFIG })
  })

  it('fills in tool defaults and keeps overrides', () => {
    const result = parseConfig(`
version: 1
validation:
  - tool: eslint
  - name: fsd
    tool: steiger
    command: npx steiger app --reporter json
    rules: [fsd/*]
dynamics:
  gapDays: 5
`)
    expect(result).toEqual({
      ok: true,
      config: {
        dynamics: { gapDays: 5 },
        validation: [
          {
            name: 'eslint',
            tool: 'eslint',
            command: 'npx --no eslint . --format json',
            rules: ['boundaries/*', 'import/no-cycle', 'import-x/no-cycle'],
          },
          {
            name: 'fsd',
            tool: 'steiger',
            command: 'npx steiger app --reporter json',
            rules: ['fsd/*'],
          },
        ],
      },
    })
  })

  it.each([
    ['YAML syntax', 'version: 1\nvalidation: [', 'YAML'],
    ['unknown tool', 'version: 1\nvalidation:\n  - tool: tslint', 'validation.0.tool'],
    ['bad gap', 'version: 1\ndynamics:\n  gapDays: 0', 'dynamics.gapDays'],
    ['unknown field', 'version: 1\nowners: []', 'owners'],
  ])('rejects %s', (_, text, fragment) => {
    const result = parseConfig(text)
    const problems = result.ok ? [] : result.problems
    expect(problems.map((p) => p.message).join('\n')).toContain(fragment)
    expect(problems[0]).toMatchObject({ file: '.beacons/config.yml' })
  })
})

describe('draftConfig', () => {
  it('lists the architecture tools found among dependencies', () => {
    const draft = draftConfig(new Set(['react', 'eslint-plugin-boundaries', 'steiger']))
    expect(draft).toContain('  - tool: eslint\n  - tool: steiger\n')
    expect(parseConfig(draft).ok).toBe(true)
    expect(draftConfig(new Set(['react']))).toBeUndefined()
  })
})
