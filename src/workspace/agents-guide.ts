import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Rules for AI agents in AGENTS.md — the file Codex, Cursor, Claude Code and others read. */

const START = '<!-- beacon:agents -->'
const END = '<!-- /beacon:agents -->'

const GUIDE = `${START}
## Зоны и маяки (beacon)

Проект размечен на зоны ответственности: карта — \`.beacons/zones.yml\`, формат —
https://github.com/imrd-works/project-vision-cli/blob/main/docs/beacon-format.md

- Перед правкой файла узнай его зону: \`beacon which <файл>\` (MCP: \`which_zone\`).
- Для аудита или задачи по теме не читай весь репозиторий: \`beacon audit --tag <тег>\` или
  \`beacon list --zone <id>\` (MCP: \`audit_context\`, \`list_zones\`) отдают ровно нужные файлы
  и фрагменты.
- Новый файл вне путей своей зоны помечай: \`beacon mark <файл> <зона>\`; фрагмент чужого файла —
  регионом \`// #region @beacon <зона>\` … \`// #endregion\`.
- В сообщении коммита нужен маяк каждой затронутой зоны: \`[BEACON: <зона>]\`. Хук
  \`prepare-commit-msg\` подставляет их сам — не удаляй.
${END}
`

export type GuideResult = 'created' | 'appended' | 'present'

export function ensureAgentsGuide(root: string): GuideResult {
  const file = path.join(root, 'AGENTS.md')
  if (!existsSync(file)) {
    writeFileSync(file, `# AGENTS.md\n\n${GUIDE}`)
    return 'created'
  }
  const current = readFileSync(file, 'utf8')
  if (current.includes(START)) return 'present'
  writeFileSync(file, `${current.replace(/\n*$/, '\n\n')}${GUIDE}`)
  return 'appended'
}
