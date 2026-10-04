import path from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { auditMarkdown } from './audit.js'
import { list } from './list.js'
import { type CommandResult, EXIT, requireProject } from './result.js'
import { packageVersion, type RunContext, untilAborted } from './running.js'
import { status } from './status.js'
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
does not need to be read. Call which_zone before editing a file to learn its zone.`

const filter = {
  tag: z.string().optional().describe('Audit tag, e.g. "security"'),
  zone: z.string().optional().describe('Zone ID; its subzones are included, e.g. "auth"'),
}

export function createMcpServer(root: string): McpServer {
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
  return server
}

export async function mcpCommand(root: string, context: RunContext): Promise<number> {
  const server = createMcpServer(root)
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
