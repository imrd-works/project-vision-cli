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

### Чужие зоны

- До того как писать код, проверь права: \`beacon gate <файлы>\` (MCP: \`gate_check\`). Логику
  чужой зоны меняет только её владелец, доверенное лицо или тот, кому владелец выдал грант.
- Без согласования можно: тексты, комментарии, форматирование, использование компонента как есть.
- Зона чужая — не генерируй правку её логики: остановись и предложи изменение владельцу (имя и
  контакты — в ответе \`gate_check\`).
- Правила архитектора — \`.beacons/rules.yml\`. Осознанное отклонение записывай исключением
  (MCP: \`record_exception\`): перепиши объяснение разработчика коротко и ясно, без слов-паразитов,
  а его исходные слова передай в \`raw\`.
${END}
`

export type GuideResult = 'created' | 'appended' | 'updated' | 'present'

export function ensureAgentsGuide(root: string): GuideResult {
  const file = path.join(root, 'AGENTS.md')
  if (!existsSync(file)) {
    writeFileSync(file, `# AGENTS.md\n\n${GUIDE}`)
    return 'created'
  }
  const current = readFileSync(file, 'utf8')
  const start = current.indexOf(START)
  const end = current.indexOf(END)
  if (start !== -1 && end > start) {
    const block = current.slice(start, end + END.length)
    if (`${block}\n` === GUIDE) return 'present'
    // An older guide of beacon: replaced, the rest of the file stays.
    writeFileSync(
      file,
      `${current.slice(0, start)}${GUIDE.trimEnd()}${current.slice(end + END.length)}`
    )
    return 'updated'
  }
  writeFileSync(file, `${current.replace(/\n*$/, '\n\n')}${GUIDE}`)
  return 'appended'
}
