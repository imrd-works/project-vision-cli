import { setTimeout as sleep } from 'node:timers/promises'

import { removeCredential, saveCredential } from '../workspace/credentials.js'
import { ServerClient, ServerError } from '../workspace/server-client.js'

import { type CommandResult, EXIT, result } from './result.js'

export interface LoginOptions {
  server: string
  deviceName: string
  configDir: string
  openUrl: (url: string) => void
  out: (text: string) => void
  signal: AbortSignal
  pollMs?: number
}

const POLL_MS = 2000

/**
 * `beacon login <server>`, as Sanity Studio does it: the browser opens the dashboard, the user
 * approves this device there, and the CLI picks its token up.
 */
export async function login(options: LoginOptions): Promise<CommandResult> {
  const client = new ServerClient(options.server)
  try {
    const started = await client.startLogin(options.deviceName)
    options.out(
      `Подтвердите вход в браузере: ${started.verificationUrl}\n` +
        `Код ${started.code} — сверьте его со страницей. Ждём подтверждения…`
    )
    options.openUrl(started.verificationUrl)
    const deadline = Date.parse(started.expiresAt)
    while (!options.signal.aborted && Date.now() < deadline) {
      const claim = await client.claimLogin(started.id, started.pollSecret)
      if (claim.status === 'approved' && claim.token !== undefined && claim.user) {
        saveCredential(options.configDir, options.server, {
          token: claim.token,
          user: claim.user,
          savedAt: new Date().toISOString(),
        })
        return result(
          EXIT.ok,
          [`✓ Вы вошли на ${options.server} как ${claim.user.name} <${claim.user.email}>`],
          { server: options.server, user: claim.user }
        )
      }
      if (claim.status === 'expired') break
      await pause(options.pollMs ?? POLL_MS, options.signal)
    }
    return result(
      EXIT.failed,
      [
        options.signal.aborted
          ? '✖ Вход отменён'
          : '✖ Запрос входа истёк — запустите beacon login снова',
      ],
      { error: 'login-not-approved' }
    )
  } catch (error) {
    return serverFailure(options.server, error)
  }
}

export function logout(configDir: string, server: string): CommandResult {
  const removed = removeCredential(configDir, server)
  return result(
    EXIT.ok,
    [removed ? `✓ Токен ${server} удалён` : `• Вы и не были вошли на ${server}`],
    { server, removed }
  )
}

/** How a failed call to the server reads in the terminal. */
export function serverFailure(server: string, error: unknown): CommandResult {
  if (!(error instanceof ServerError)) throw error
  const lines: Record<ServerError['kind'], string> = {
    offline: `⚠ Сервер ${server} недоступен: ${error.message}`,
    unauthorized: `✖ Сервер ${server} не принял токен — войдите снова: beacon login ${server}`,
    http: `✖ Сервер ${server} ответил ошибкой ${error.message}`,
    contract: `✖ Сервер ${server}: ${error.message} — версии beacon и сервера не совпадают?`,
  }
  return result(EXIT.failed, [lines[error.kind]], { error: error.kind, message: error.message })
}

/** Waits between polls; Ctrl+C ends the wait at once. */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal })
  } catch {
    // Aborted: the loop sees the signal and stops.
  }
}
