# project-vision-cli

`beacon` — открытое ядро Project Vision: карта зон, маяки в коде и линтер коммитов.

**Зона** — область продукта, за которую кто-то отвечает: «Вход и сессии», «Тарифы на главной».
**Маяк** — метка, указывающая на зону: в коде, в сообщении коммита, в карточке трекера. По маякам
нейросеть на аудите сразу находит нужный код, не перечитывая весь репозиторий, а каждый коммит
прослеживается до зон, которые он затронул.

Полная спецификация формата — [docs/beacon-format.md](docs/beacon-format.md).

## Как это выглядит

```yaml
# .beacons/zones.yml
version: 1
zones:
  home.pricing:
    title: Тарифы
    paths: [src/widgets/pricing/**]
  security.http:
    title: Защита HTTP-слоя
    tags: [security]
```

```ts
// src/app/app.factory.ts
// #region @beacon security.http
await app.register(helmet)
app.enableCors({ origin: config.cors.origins })
// #endregion
```

```
$ git commit -m "feat(home): yearly toggle"
# хук сам дописал в сообщение затронутую зону:
feat(home): yearly toggle

[BEACON: home.pricing]
```

```
$ beacon list --tag security
security.http  Защита HTTP-слоя  [security]  — активна
  src/app/app.factory.ts:41-48
```

## Установка в проект

```bash
npm install --save-dev github:imrd-works/project-vision-cli
npx beacon init
```

`init` создаёт черновик `.beacons/zones.yml` по структуре папок и подключает git-хуки:
`prepare-commit-msg` подставляет маяки затронутых зон, `commit-msg` проверяет, что они на месте,
`pre-push` перепроверяет пушимые коммиты. Если в проекте есть husky, строки дописываются в
`.husky/*`.

## Команды

| Команда                            | Что делает                                                |
| ---------------------------------- | --------------------------------------------------------- |
| `beacon init`                      | Карта зон по структуре папок и git-хуки                   |
| `beacon check [--with <репо>]`     | Проверка карты и разметки; `--with` сверяет ID с соседями |
| `beacon list [--tag t] [--zone z]` | Зоны с файлами и диапазонами строк регионов               |
| `beacon which <файл>`              | Зоны файла и регионов в нём                               |
| `beacon status`                    | Покрытие кода зонами, состояния зон, папки без зон        |
| `beacon mark <файл> <зона>`        | Маяк зоны на файл в комментарии нужного языка             |
| `beacon audit --tag security`      | Пакет контекста для аудита нейросетью: код зон темы       |
| `beacon watch`                     | Индекс обновляется на лету при изменении файлов           |
| `beacon serve`                     | Локальный API для дашборда (127.0.0.1:4317, SSE)          |
| `beacon mcp`                       | MCP-сервер: зоны и код темы для ИИ-агентов                |

У команд чтения есть `--json`, `-C <папка>` работает с другим репозиторием.

## ИИ-агенты

Подключите MCP-сервер, и агент будет брать код темы по зонам, а не читать репозиторий целиком.
Для Claude Code — `.mcp.json` в корне проекта:

```json
{ "mcpServers": { "beacon": { "command": "npx", "args": ["beacon", "mcp"] } } }
```

Без MCP то же самое даёт `beacon audit --tag <тег> > audit.md`.

## Разработка

Нужен Node 24 (`.nvmrc`); пакет работает на Node 22.13+.

```bash
npm install
npm run verify   # формат, линт, типы, тесты с покрытием, knip
npm run build    # dist/cli/main.js
```

Слои: `cli` → `commands` → `workspace` (git, файлы) → `core` (чистая логика без ввода-вывода).
Границы проверяет ESLint.
