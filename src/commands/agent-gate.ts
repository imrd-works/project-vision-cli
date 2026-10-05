import path from 'node:path'

import { z } from 'zod'

import type { ChangedFile } from '../core/commit-check.js'
import { editKind } from '../core/ownership.js'

import { describeEntry, FREE_EDITS, gateEntry, prepareGate, readCurrent } from './ownership.js'
import { type CommandResult, EXIT, result } from './result.js'

const agentInput = z.object({
  tool_name: z.string(),
  tool_input: z.object({
    file_path: z.string().optional(),
    content: z.string().optional(),
    old_string: z.string().optional(),
    new_string: z.string().optional(),
    replace_all: z.boolean().optional(),
    edits: z
      .array(
        z.object({
          old_string: z.string(),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
        })
      )
      .optional(),
  }),
})

/**
 * `beacon gate --agent`: the PreToolUse hook of Claude Code. It sees the edit before it is made:
 * texts and comments pass, the logic of someone else's zone is denied with whom to ask.
 */
export function agentGate(root: string, stdin: string, configDir: string): CommandResult {
  const parsed = agentInput.safeParse(safeJson(stdin))
  const filePath = parsed.success ? parsed.data.tool_input.file_path : undefined
  if (!parsed.success || filePath === undefined) return result(EXIT.ok, [], { allowed: true })
  const file = path.relative(root, path.resolve(root, filePath)).split(path.sep).join('/')
  if (file.startsWith('..')) return result(EXIT.ok, [], { allowed: true })
  const prepared = prepareGate(root, configDir)
  if ('failure' in prepared) return result(EXIT.ok, [], { allowed: true })
  const before = readCurrent(root, file)
  const after = applyEdit(before, parsed.data.tool_name, parsed.data.tool_input)
  const change: ChangedFile = {
    ...(before === undefined ? {} : { oldPath: file, oldText: before }),
    newPath: file,
    newText: after,
    oldRanges: before === undefined ? [] : [{ start: 1, end: before.split('\n').length }],
    newRanges: [{ start: 1, end: after.split('\n').length }],
  }
  if (editKind(change) === 'cosmetic') return result(EXIT.ok, [], { allowed: true })
  const entry = gateEntry(prepared, file, change)
  const refused = entry.zones.filter((zone) => !zone.right.allowed)
  if (refused.length === 0) return result(EXIT.ok, [], { allowed: true })
  const reason = [
    `Файл ${file} — в чужой зоне: ${describeEntry({ ...entry, zones: refused }, prepared.ownership.people).join('; ')}.`,
    FREE_EDITS,
    'Логику этой зоны меняет её владелец или кто-то по его гранту: не правьте её, предложите изменение владельцу.',
  ].join(' ')
  const decision = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
  return result(EXIT.ok, [JSON.stringify(decision)], decision)
}

type EditInput = z.infer<typeof agentInput>['tool_input']

function applyEdit(before: string | undefined, tool: string, input: EditInput): string {
  if (tool === 'Write') return input.content ?? ''
  const edits =
    input.edits ??
    (input.old_string === undefined
      ? []
      : [
          {
            old_string: input.old_string,
            new_string: input.new_string ?? '',
            replace_all: input.replace_all,
          },
        ])
  return edits.reduce(
    (text, edit) =>
      // A function replacer: `$&` in the new text is text, not a pattern.
      edit.replace_all === true
        ? text.replaceAll(edit.old_string, () => edit.new_string)
        : text.replace(edit.old_string, () => edit.new_string),
    before ?? ''
  )
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
