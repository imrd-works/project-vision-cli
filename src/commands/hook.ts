import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { type CommitCheck, checkCommit, touchedZones } from '../core/commit-check.js'
import { appendBeacons, parseCommitBeacons } from '../core/commit-message.js'
import { resolveZoneId } from '../core/manifest.js'
import { hasErrors } from '../core/problem.js'
import { commitMessage, commitSubject, gitPath, listCommits, tryGit } from '../workspace/git.js'
import type { HookName } from '../workspace/hooks.js'
import { commitChanges, loadProject, stagedChanges } from '../workspace/project.js'

import { type CommandResult, EXIT, formatProblem, result } from './result.js'

/** Entry points of the git hooks installed by `beacon init`. */
export function hook(
  root: string,
  name: HookName,
  args: readonly string[],
  stdin: string
): CommandResult {
  switch (name) {
    case 'prepare-commit-msg': {
      return prepareCommitMessage(root, args)
    }
    case 'commit-msg': {
      return commitMsg(root, args)
    }
    case 'pre-push': {
      return prePush(root, args, stdin)
    }
  }
}

const OK = result(EXIT.ok, [], { ok: true })

/** Writes beacons of the touched zones into the message before the editor opens. */
function prepareCommitMessage(root: string, [file, source]: readonly string[]): CommandResult {
  if (file === undefined || source === 'merge' || source === 'squash') return OK
  const load = loadProject(root, { from: 'index' })
  // A broken zone map is reported by commit-msg; preparing the message never blocks.
  if (load.kind !== 'ok') return OK

  const message = readFileSync(file, 'utf8')
  const present = new Set(
    parseCommitBeacons(message).beacons.map((b) => resolveZoneId(load.project.manifest, b.id))
  )
  const touched = touchedZones(load.project, stagedChanges(root))
  const toAdd = touched.zones.map((touch) => touch.zone).filter((zone) => !present.has(zone))
  if (toAdd.length > 0) writeFileSync(file, appendBeacons(message, toAdd))
  return result(EXIT.ok, [], { added: toAdd })
}

function commitMsg(root: string, [file]: readonly string[]): CommandResult {
  if (file === undefined || existsSync(gitPath(root, 'MERGE_HEAD'))) return OK
  const load = loadProject(root, { from: 'index' })
  if (load.kind === 'missing') return OK
  if (load.kind === 'invalid') {
    return result(
      EXIT.failed,
      ['✖ beacon: карта зон некорректна', ...load.problems.map((p) => `  ${formatProblem(p)}`)],
      { ok: false, problems: load.problems }
    )
  }
  const check = checkCommit(load.project, stagedChanges(root), readFileSync(file, 'utf8'))
  if (passes(check)) return result(EXIT.ok, [], { ok: true, zones: check.zones })
  return result(EXIT.failed, ['✖ beacon: коммит отклонён', ...explain(check)], {
    ok: false,
    ...check,
  })
}

const ZERO_SHA = /^0+$/

/** Re-checks every pushed commit: catches commits made with `--no-verify`. */
function prePush(
  root: string,
  [remote = 'origin']: readonly string[],
  stdin: string
): CommandResult {
  const failures: { sha: string; subject: string; check: CommitCheck }[] = []
  for (const sha of pushedCommits(root, remote, stdin)) {
    const load = loadProject(root, { from: 'commit', sha })
    if (load.kind !== 'ok') continue // no zone map at that point of history
    const check = checkCommit(load.project, commitChanges(root, sha), commitMessage(root, sha))
    if (!passes(check)) failures.push({ sha, subject: commitSubject(root, sha), check })
  }
  if (failures.length === 0) return result(EXIT.ok, [], { ok: true })
  const lines = failures.flatMap(({ sha, subject, check }) => [
    `✖ ${sha.slice(0, 7)} ${subject}`,
    ...explain(check).map((line) => `  ${line}`),
  ])
  return result(
    EXIT.failed,
    ['beacon: в пушимых коммитах не хватает маяков', ...lines, 'Исправьте: git rebase -i и reword'],
    { ok: false, failures }
  )
}

function pushedCommits(root: string, remote: string, stdin: string): string[] {
  const commits = new Set<string>()
  for (const line of stdin.split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/, 4)
    if (localSha === undefined || remoteSha === undefined || ZERO_SHA.test(localSha)) continue
    const known =
      !ZERO_SHA.test(remoteSha) &&
      tryGit(root, ['cat-file', '-e', `${remoteSha}^{commit}`]) !== undefined
    const range = known ? [`${remoteSha}..${localSha}`] : [localSha, '--not', `--remotes=${remote}`]
    for (const sha of listCommits(root, range)) commits.add(sha)
  }
  return [...commits]
}

function passes(check: CommitCheck): boolean {
  return check.missing.length === 0 && !hasErrors(check.problems)
}

function explain(check: CommitCheck): string[] {
  const lines = check.problems.map((problem) => formatProblem(problem))
  if (check.missing.length > 0) {
    const width = Math.max(...check.missing.map((touch) => touch.zone.length))
    lines.push(
      'Коммит затрагивает зоны, маяков которых нет в сообщении:',
      ...check.missing.map((touch) => `  ${touch.zone.padEnd(width)}  ${touch.files.join(', ')}`),
      `Добавьте в сообщение: ${check.missing.map((touch) => `[BEACON: ${touch.zone}]`).join(' ')}`
    )
  }
  return lines
}
