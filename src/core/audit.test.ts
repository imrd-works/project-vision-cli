import { describe, expect, it } from 'vitest'

import {
  renderMergedFindings,
  renderReportTemplate,
  renderSummaryTemplate,
} from './audit-templates.js'
import { auditPath, authorSlug, collectAudits, parseReport, parseSummary } from './audit.js'

const REPORT = `---
checkpoint: backend:auth
round: 1
author: ann@x.io
model: opus
commit: abc1234
---

# Аудит

## Находки

### [high] Пароль сравнивается без постоянного времени
- Файл: \`src/auth/password.ts:42\`
- Зона: auth.passwords

Описание.

### [low] Нет лимита попыток
- File: src/auth/login.ts

### [info] Общее замечание
`

describe('parseReport', () => {
  it('reads the header and every finding with its place', () => {
    const { report, problems } = parseReport('x.md', REPORT, 1)
    expect(problems).toEqual([])
    expect(report).toMatchObject({ round: 1, author: 'ann@x.io', model: 'opus', commit: 'abc1234' })
    expect(report.findings).toEqual([
      {
        severity: 'high',
        title: 'Пароль сравнивается без постоянного времени',
        file: 'src/auth/password.ts',
        line: 42,
        zone: 'auth.passwords',
      },
      { severity: 'low', title: 'Нет лимита попыток', file: 'src/auth/login.ts' },
      { severity: 'info', title: 'Общее замечание' },
    ])
  })

  it('reports a missing or broken header', () => {
    expect(parseReport('a.md', '### [low] x', 2).problems[0]?.message).toContain('нет заголовка')
    const broken = parseReport('b.md', '---\nround: two\n---\n', 2)
    expect(broken.problems.map((p) => p.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('заголовок не по формату')])
    )
    expect(broken.report.round).toBe(2)
    expect(parseReport('c.md', '---\nround: 1\n---\n', 1).problems[0]?.message).toContain('author')
    const digits = parseReport('d.md', '---\nauthor: a@x.io\ncommit: 1234567\n---\n', 1)
    expect(digits).toMatchObject({ problems: [], report: { commit: '1234567' } })
  })

  it('ignores the example inside the template comment', () => {
    const template = renderReportTemplate({
      checkpoint: 'backend:auth',
      title: 'Auth',
      round: 2,
      author: 'ann@x.io',
      model: 'opus',
      commit: 'abc',
      zones: ['auth.api'],
    })
    const { report, problems } = parseReport('t.md', template, 2)
    expect(problems).toEqual([])
    expect(report).toMatchObject({ round: 2, author: 'ann@x.io', model: 'opus', findings: [] })
  })
})

describe('summaries', () => {
  it('reads resolutions; undecided ones stay open', () => {
    const { summary } = parseSummary(
      's.md',
      '---\nround: 1\nconsolidator: bob@x.io\ncommit: def\n---\n### [fixed] A — ann\n### [disputed] B\n### [accepted] C\n### [?] D\n',
      1
    )
    expect(summary).toMatchObject({ consolidator: 'bob@x.io', commit: 'def' })
    expect(summary.resolutions.map((r) => r.resolution)).toEqual([
      'fixed',
      'disputed',
      'accepted',
      'open',
    ])
  })

  it('lists every finding of the round for the consolidator', () => {
    const { report } = parseReport('x.md', REPORT, 1)
    const template = renderSummaryTemplate({
      checkpoint: 'backend:auth',
      round: 1,
      consolidator: 'bob@x.io',
      reports: [report],
    })
    expect(parseSummary('s.md', template, 1).summary.resolutions).toHaveLength(3)
    expect(template).toContain('- Важность: high · src/auth/password.ts:42')

    const merged = renderMergedFindings('backend:auth', [report])
    expect(merged).toContain('## src/auth/password.ts')
    expect(merged).toContain(
      '- [high] Пароль сравнивается без постоянного времени (строка 42) — ann@x.io'
    )
    expect(merged).toContain('## (без файла)')
  })
})

describe('collectAudits', () => {
  it('groups reports and summaries by checkpoint and round', () => {
    const audits = collectAudits([
      { path: auditPath('auth', 2, 'bob-x-io'), text: '---\nauthor: bob@x.io\n---\n' },
      { path: auditPath('auth', 1, authorSlug('Bob@x.io')), text: '---\nauthor: bob@x.io\n---\n' },
      { path: auditPath('auth', 1, 'ann-x-io'), text: REPORT },
      { path: auditPath('auth', 1, 'summary'), text: '---\nround: 1\n---\n### [fixed] A\n' },
      { path: '.beacons/audits/README.md', text: 'ignored' },
    ])
    const auth = audits.get('auth')
    expect(auth?.rounds.map((round) => round.round)).toEqual([1, 2])
    expect(auth?.rounds[0]?.reports.map((report) => report.author)).toEqual([
      'ann@x.io',
      'bob@x.io',
    ])
    expect(auth?.rounds[0]?.summary?.resolutions).toHaveLength(1)
    expect(authorSlug('Ann.Lee+audit@X.io')).toBe('ann-lee-audit-x-io')
  })
})
