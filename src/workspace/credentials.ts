import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

/**
 * Tokens of team servers, per server URL, in `<config dir>/credentials.json` — outside every
 * repository, readable by the user only. The config dir comes from the CLI's environment.
 */

const FILE = 'credentials.json'

const credentialSchema = z.object({
  token: z.string(),
  user: z.object({ email: z.string(), name: z.string() }),
  savedAt: z.string(),
})

const fileSchema = z.object({ servers: z.record(z.string(), credentialSchema) })

export type Credential = z.infer<typeof credentialSchema>

export function loadCredential(configDir: string, server: string): Credential | undefined {
  const servers = readAll(configDir)
  return Object.hasOwn(servers, server) ? servers[server] : undefined
}

export function saveCredential(configDir: string, server: string, credential: Credential): void {
  write(configDir, { ...readAll(configDir), [server]: credential })
}

/** False when there was nothing to forget. */
export function removeCredential(configDir: string, server: string): boolean {
  const servers = readAll(configDir)
  if (!Object.hasOwn(servers, server)) return false
  write(configDir, Object.fromEntries(Object.entries(servers).filter(([url]) => url !== server)))
  return true
}

function readAll(configDir: string): Record<string, Credential> {
  const file = path.join(configDir, FILE)
  if (!existsSync(file)) return {}
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data.servers : {}
  } catch {
    return {} // a damaged file: logging in again rewrites it
  }
}

function write(configDir: string, servers: Record<string, Credential>): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const file = path.join(configDir, FILE)
  writeFileSync(file, `${JSON.stringify({ servers }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}
