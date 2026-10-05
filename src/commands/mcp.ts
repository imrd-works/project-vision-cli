import path from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { auditMarkdown } from './audit.js'
import { checkpoints } from './checkpoints.js'
import { findCheckpoint, zonesOf } from './cross-audit.js'
import { list } from './list.js'
import { gate } from './ownership.js'
import { type CommandResult, EXIT, requireProject } from './result.js'
import { packageVersion, type RunContext, untilAborted } from './running.js'
import { status } from './status.js'
import { todo } from './todo.js'
import { tree } from './tree.js'
import { validate } from './validate.js'
import { which } from './which.js'

/**
 * `beacon mcp`: a Model Context Protocol server over stdio. AI agents (Claude Code, Cursor…)
 * ask for zones, a file's zone and audit context directly, instead of crawling the repository.
 */

const INSTRUCTIONS = `This repository is mapped into zones (areas of responsibility) with beacons.
Before reading code for a topic (security, payments…), call list_zones or audit_context with a tag
or zone: they return exactly the files and line ranges of that topic, so the rest of the repository
does not need to be read. Call which_zone before editing a file to learn its zone. For a
checkpoint's cross-audit, audit_checkpoint returns the code of all its zones.
Before changing code, call gate_check with the files: the logic of someone else's zone may be
changed only by its owner, a proxy or under a grant — if it is denied, do not write that change;
suggest it to the owner instead (name and contacts are in the answer). Texts, comments and
formatting are free.`

const filter = {
  tag: z.string().optional().describe('Audit tag, e.g. "security"'),
  zone: z.string().optional().describe('Zone ID; its subzones are included, e.g. "auth"'),
}

export function createMcpServer(root: string, options: { configDir?: string } = {}): McpServer {
  const server = new McpServer(
    { name: 'beacon', version: packageVersion() },
    { instructions: INSTRUCTIONS }
  )

  server.registerTool(
    'list_zones',
    {
      title: 'List zones',
      description: 'Zones with tags, state, files and region line ranges, filtered by tag or zone',
      inputSchema: filter,
    },
    ({ tag, zone }) => json(list(root, { tag, zone }))
  )
  server.registerTool(
    'which_zone',
    {
      title: 'Zone of a file',
      description: 'Zones a file belongs to, and the regions inside it',
      inputSchema: { file: z.string().describe('Path relative to the repository root') },
    },
    ({ file }) => json(which(root, relative(root, file)))
  )
  server.registerTool(
    'audit_context',
    {
      title: 'Audit context',
      description:
        'One Markdown document with the code of all zones of a tag or zone branch, ready for review',
      inputSchema: {
        ...filter,
        include_tests: z.boolean().optional().describe('Include test files (default: false)'),
      },
    },
    ({ tag, zone, include_tests }) => {
      const loaded = requireProject(root)
      if ('failure' in loaded) return json(loaded.failure)
      const markdown = auditMarkdown(loaded.project, {
        tag,
        zone,
        includeTests: include_tests ?? false,
        code: true,
      })
      return { content: [{ type: 'text', text: markdown }] }
    }
  )
  server.registerTool(
    'audit_checkpoint',
    {
      title: 'Checkpoint cross-audit',
      description:
        'The code of every zone of a checkpoint, for a cross-audit; write findings into the file of `beacon audit report <checkpoint>`',
      inputSchema: {
        checkpoint: z.string().describe('Checkpoint ID of this line, e.g. "auth"'),
        include_tests: z.boolean().optional().describe('Include test files (default: false)'),
      },
    },
    ({ checkpoint, include_tests }) => {
      const found = findCheckpoint(root, checkpoint)
      if ('failure' in found) return json(found.failure)
      const loaded = requireProject(root)
      if ('failure' in loaded) return json(loaded.failure)
      const ref = `${found.line}:${found.checkpoint.id}`
      const markdown = auditMarkdown(loaded.project, {
        zones: { ids: zonesOf(found.checkpoint), label: `чекпоинт ${ref}` },
        includeTests: include_tests ?? false,
        code: true,
      })
      return { content: [{ type: 'text', text: markdown }] }
    }
  )
  server.registerTool(
    'zone_status',
    {
      title: 'Zone map status',
      description: 'Coverage of the code by zones, zone states and folders without zones',
    },
    () => json(status(root))
  )
  server.registerTool(
    'architecture_tree',
    {
      title: 'Architecture tree',
      description:
        'Folders of the project with file counts and zones — check structure against it instead of listing the disk',
      inputSchema: { depth: z.number().int().min(1).optional().describe('Folder levels to show') },
    },
    ({ depth }) => {
      const outcome = tree(root, { depth })
      return { content: [{ type: 'text', text: outcome.text }], isError: outcome.code !== EXIT.ok }
    }
  )
  server.registerTool(
    'validate_architecture',
    {
      title: 'Validate architecture',
      description:
        "Runs the project's architecture checks (ESLint boundaries, steiger, dependency-cruiser) and returns violations with their zones",
    },
    async () => json(await validate(root))
  )
  server.registerTool(
    'checkpoints',
    {
      title: 'Checkpoints',
      description:
        'Checkpoint lines with item progress, stoppers, technical debt (overdue, unblocked) and stuck developers',
    },
    () => json(checkpoints(root, { with: [] }))
  )
  server.registerTool(
    'todo',
    {
      title: 'Developer todo',
      description: "A developer's technical debt (priority first) and unfinished checkpoint items",
      inputSchema: {
        owner: z.string().optional().describe('git user.email; the local author by default'),
      },
    },
    ({ owner }) => json(todo(root, { owner, with: [] }))
  )
  registerOwnershipTools(server, root, options.configDir ?? '')
  return server
}

/** The gate before an edit. */
function registerOwnershipTools(server: McpServer, root: string, configDir: string): void {
  server.registerTool(
    'gate_check',
    {
      title: 'May I change these files',
      description:
        "Before an edit: for each file, its zones and whether the logged-in person may change their logic (owner, proxy, grant), else the owner's name and contacts",
      inputSchema: {
        files: z.array(z.string()).min(1).describe('Paths relative to the repository root'),
      },
    },
    ({ files }) => {
      const outcome = gate(
        root,
        files.map((file) => relative(root, file)),
        configDir
      )
      // A refusal is an answer, not a failure of the tool.
      return { content: [{ type: 'text', text: JSON.stringify(outcome.json, null, 2) }] }
    }
  )
}

export async function mcpCommand(
  root: string,
  context: RunContext,
  options: { configDir?: string } = {}
): Promise<number> {
  const server = createMcpServer(root, options)
  const transport = new StdioServerTransport()
  const closed = new Promise<void>((resolve) => {
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callbacks, not EventTarget
    transport.onclose = resolve
  })
  await server.connect(transport)
  await Promise.race([closed, untilAborted(context.signal)])
  await server.close()
  return EXIT.ok
}

function json(outcome: CommandResult): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome.json, null, 2) }],
    isError: outcome.code !== EXIT.ok,
  }
}

function relative(root: string, file: string): string {
  const absolute = path.resolve(root, file)
  return path.relative(root, absolute).split(path.sep).join('/')
}
