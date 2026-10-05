import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The gate before an AI agent's edit: a PreToolUse hook of Claude Code in `.claude/settings.json`
 * asks `beacon gate --agent` about every Edit and Write — someone else's zone logic is denied
 * before the code is written, texts and comments pass.
 */

const SETTINGS = '.claude/settings.json'
export const AGENT_GATE_COMMAND =
  'beacon_bin=node_modules/.bin/beacon; [ -x "$beacon_bin" ] || beacon_bin=beacon; "$beacon_bin" gate --agent'

interface HookEntry {
  matcher?: string
  hooks?: { type?: string; command?: string }[]
}

export function installAgentHooks(root: string): 'installed' | 'present' {
  const file = path.join(root, SETTINGS)
  const settings = readSettings(file)
  const hooks = (settings['hooks'] ?? {}) as Record<string, HookEntry[] | undefined>
  const preToolUse = hooks['PreToolUse'] ?? []
  const present = preToolUse.some((entry) =>
    entry.hooks?.some((hook) => hook.command?.includes('gate --agent'))
  )
  if (present) return 'present'
  hooks['PreToolUse'] = [
    ...preToolUse,
    { matcher: 'Edit|MultiEdit|Write', hooks: [{ type: 'command', command: AGENT_GATE_COMMAND }] },
  ]
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`)
  return 'installed'
}

function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
