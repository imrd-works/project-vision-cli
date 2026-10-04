import { randomUUID } from 'node:crypto'

import { type AuditState, type Verdict, VERDICTS, versionOf } from '../core/sync.js'
import { loadCredential } from '../workspace/credentials.js'
import { ServerClient } from '../workspace/server-client.js'
import { readCache, writeCache } from '../workspace/sync-cache.js'

import { findCheckpoint } from './cross-audit.js'
import { serverFailure } from './login.js'
import { type CommandResult, EXIT, result } from './result.js'
import { sync, type Target } from './sync.js'

/**
 * The team's side of a cross-audit: opening rounds on the server and signing them. A signature
 * is a critical entity — made against an outdated round it becomes a conflict, not a vote.
 */

/** The cross-audit of a checkpoint as of the last sync. */
export function cachedAudit(root: string, target: Target, ref: string): AuditState | undefined {
  return readCache(root, target).bundle?.audits?.find((audit) => audit.checkpoint === ref)
}

/** `beacon audit start <чп>`: the next round, on the current commit of the line. */
export async function startAudit(
  root: string,
  target: Target,
  configDir: string,
  checkpoint: string
): Promise<CommandResult> {
  const found = findCheckpoint(root, checkpoint)
  if ('failure' in found) return found.failure
  const credential = loadCredential(configDir, target.server)
  if (!credential) return notLoggedIn(target)
  const ref = `${found.line}:${found.checkpoint.id}`
  try {
    const started = await new ServerClient(target.server, credential.token).startRound(
      target.project,
      ref
    )
    await sync(root, target, configDir)
    return result(
      EXIT.ok,
      [
        `✓ Раунд ${String(started.round)} кросс-аудита ${ref} открыт на коммите ${started.commit.slice(0, 7)}`,
        `  Каждый аудитор: beacon audit report ${found.checkpoint.id}, затем beacon sign ${found.checkpoint.id} …`,
      ],
      { checkpoint: ref, ...started }
    )
  } catch (error) {
    return serverFailure(target.server, error)
  }
}

/** `beacon sign <чп> agree|accept-risk|object [--comment …]`: queued, then sent. */
export async function sign(
  root: string,
  target: Target,
  configDir: string,
  input: { checkpoint: string; verdict: string; comment: string | undefined }
): Promise<CommandResult> {
  const invalid = checkSignature(input)
  if (invalid) return invalid
  const found = findCheckpoint(root, input.checkpoint)
  if ('failure' in found) return found.failure
  const credential = loadCredential(configDir, target.server)
  if (!credential) return notLoggedIn(target)
  const ref = `${found.line}:${found.checkpoint.id}`
  const current = cachedAudit(root, target, ref)?.rounds.at(-1)
  if (!current) {
    return result(
      EXIT.failed,
      [`✖ Раунд кросс-аудита ${ref} не открыт (beacon sync, beacon audit start)`],
      {
        error: 'no-round',
      }
    )
  }
  const key = `${ref}/${String(current.round)}/${credential.user.email}`
  const cache = readCache(root, target)
  cache.outbox.push({
    id: randomUUID(),
    kind: 'signature',
    key,
    data: {
      verdict: input.verdict as Verdict,
      commit: current.commit,
      ...(input.comment ? { comment: input.comment } : {}),
    },
    baseVersion: versionOf(cache.bundle?.entities ?? [], 'signature', key),
    at: new Date().toISOString(),
  })
  writeCache(root, cache)
  const sent = await sync(root, target, configDir)
  return result(
    EXIT.ok,
    [`✓ Подпись под раундом ${String(current.round)} ${ref}: ${input.verdict}`, sent.text],
    { signed: key, sync: sent.json }
  )
}

function checkSignature(input: {
  verdict: string
  comment: string | undefined
}): CommandResult | undefined {
  if (!isVerdict(input.verdict)) return usage(`подпись: ${VERDICTS.join(' | ')}`)
  if (input.verdict !== 'agree' && !input.comment) {
    return usage('принятый риск и возражение объясняются: --comment "…"')
  }
  return undefined
}

function isVerdict(value: string): value is Verdict {
  return (VERDICTS as readonly string[]).includes(value)
}

function notLoggedIn(target: Target): CommandResult {
  return result(EXIT.failed, [`✖ Вы не вошли на ${target.server}: beacon login ${target.server}`], {
    error: 'not-logged-in',
  })
}

function usage(message: string): CommandResult {
  return result(EXIT.usage, [`✖ ${message}`], { error: message })
}
