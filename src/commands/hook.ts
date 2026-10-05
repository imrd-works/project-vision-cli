import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { type CommitCheck, checkCommit, touchedZones } from '../core/commit-check.js'
import { appendBeacons, parseCommitBeacons } from '../core/commit-message.js'
import type { IdentityPolicy } from '../core/config.js'
import {
  checkAuthor,
  commitVerdict,
  type IdentityCheck,
  type TeamPeople,
  VERDICT_TEXT,
  verdictPasses,
} from '../core/identity.js'
import { resolveZoneId } from '../core/manifest.js'
import { hasErrors } from '../core/problem.js'
import { loadCredential } from '../workspace/credentials.js'
import { debtLimitViolation } from '../workspace/debt-limit.js'
import {
  authorEmail,
  commitMessage,
  commitSubject,
  gitPath,
  pushedCommits,
} from '../workspace/git.js'
import type { HookName } from '../workspace/hooks.js'
import { commitSignatures, signingSetup, teamPeople } from '../workspace/identity.js'
import { commitChanges, loadConfig, loadProject, stagedChanges } from '../workspace/project.js'

import { commitOwnership, pushOwnership } from './ownership.js'
import { type CommandResult, EXIT, formatProblem, result } from './result.js'

/** Entry points of the git hooks installed by `beacon init`. */
export function hook(
  root: string,
  name: HookName,
  args: readonly string[],
  options: { stdin: string; configDir: string }
): CommandResult {
  switch (name) {
    case 'prepare-commit-msg': {
      return prepareCommitMessage(root, args)
    }
    case 'commit-msg': {
      const checked = commitMsg(root, args)
      return chain(
        checked.code === EXIT.ok ? withAuthorCheck(checked, root, options.configDir) : checked,
        () => commitOwnership(root, args[0])
      )
    }
    case 'pre-push': {
      const [remote = 'origin'] = args
      return chain(
        chain(prePush(root, args, options.stdin), () =>
          verifyPushedAuthors(root, args, options.stdin)
        ),
        () => pushOwnership(root, remote, options.stdin)
      )
    }
  }
}

/** The next check runs only when the previous one let the change through; warnings add up. */
function chain(first: CommandResult, next: () => CommandResult): CommandResult {
  if (first.code !== EXIT.ok) return first
  const second = next()
  return {
    code: second.code,
    text: [first.text, second.text].filter((text) => text !== '').join('\n'),
    json: { ...(first.json as object), ...(second.json as object) },
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
  const message = readFileSync(file, 'utf8')
  const check = checkCommit(load.project, stagedChanges(root), message)
  if (passes(check)) {
    const limit = debtLimitViolation(
      load.project,
      check.zones.map((touch) => touch.zone),
      message
    )
    if (limit === undefined) return result(EXIT.ok, [], { ok: true, zones: check.zones })
    return result(EXIT.failed, ['✖ beacon: коммит отклонён — превышен лимит техдолга', ...limit], {
      ok: false,
      debtLimit: limit,
    })
  }
  return result(EXIT.failed, ['✖ beacon: коммит отклонён', ...explain(check)], {
    ok: false,
    ...check,
  })
}

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

/** The team server of this repository, its people as of the last sync and the check to apply. */
function identityContext(
  root: string
): { policy: IdentityPolicy; server: string; team: TeamPeople | undefined } | undefined {
  const config = loadConfig(root)
  if (!config.ok || !config.config.server || config.config.identity.check === 'off')
    return undefined
  const { url: server, project } = config.config.server
  return { policy: config.config.identity, server, team: teamPeople(root, { server, project }) }
}

/** Who makes the commit: the author belongs to the project, and signs with their own key. */
function withAuthorCheck(checked: CommandResult, root: string, configDir: string): CommandResult {
  const context = identityContext(root)
  if (!context) return checked
  const check: IdentityCheck = checkAuthor({
    ...context,
    author: authorEmail(root),
    signing: signingSetup(root),
    loggedIn: loadCredential(configDir, context.server)?.user.email,
    now: new Date(),
  })
  const warnings = check.warnings.map((warning) => `⚠ beacon: ${warning}`)
  if (check.errors.length === 0) {
    return result(EXIT.ok, warnings, { ...(checked.json as object), identity: check })
  }
  return result(
    EXIT.failed,
    [
      '✖ beacon: коммит отклонён — автор не подтверждён',
      ...check.errors.map((e) => `  ${e}`),
      ...warnings,
    ],
    { ok: false, identity: check }
  )
}

/** The signatures of pushed commits against the team's keys: made commits, `--no-verify` too. */
function verifyPushedAuthors(
  root: string,
  [remote = 'origin']: readonly string[],
  stdin: string
): CommandResult {
  const context = identityContext(root)
  if (!context) return OK
  const { policy, team } = context
  if (!team) {
    return policy.whenStale === 'hold'
      ? result(EXIT.failed, ['✖ beacon: нет данных о людях проекта — выполните beacon sync'], {
          ok: false,
          error: 'not-synced',
        })
      : OK
  }
  const commits = commitSignatures(
    root,
    pushedCommits(root, remote, stdin),
    team.signers.allowedSigners
  )
  const failures = commits
    .map((commit) => ({ ...commit, verdict: commitVerdict(team.people, commit) }))
    .filter((commit) => !verdictPasses(policy, commit.verdict))
  if (failures.length === 0) return OK
  return result(
    EXIT.failed,
    [
      'beacon: авторство пушимых коммитов не подтверждено',
      ...failures.map(
        (commit) =>
          `✖ ${commit.sha.slice(0, 7)} ${commitSubject(root, commit.sha)} — ${commit.email}: ${VERDICT_TEXT[commit.verdict]}`
      ),
      policy.check === 'signature'
        ? 'Подпишите коммиты своим ключом: beacon signing setup, затем git rebase --exec "git commit --amend --no-edit -S"'
        : 'Коммиты должны быть от почты участника проекта (git config user.email)',
    ],
    { ok: false, authors: failures }
  )
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
