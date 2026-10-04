import { spawn } from 'node:child_process'
import { homedir, hostname } from 'node:os'
import path from 'node:path'

/** What the CLI takes from the machine it runs on: kept here, so commands get plain values. */

/** BEACON_CONFIG_DIR, else the platform's config folder (XDG on Linux, ~/.config on macOS). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env['BEACON_CONFIG_DIR']) return env['BEACON_CONFIG_DIR']
  if (process.platform === 'win32' && env['APPDATA']) return path.join(env['APPDATA'], 'beacon')
  return path.join(env['XDG_CONFIG_HOME'] ?? path.join(homedir(), '.config'), 'beacon')
}

/** Starts a program in the background, detached from the CLI. */
export type Launch = (command: string, args: readonly string[]) => void

const launch: Launch = (command, args) => {
  spawn(command, [...args], { detached: true, stdio: 'ignore' })
    .on('error', () => undefined)
    .unref()
}

/** Opens a URL in the default browser; a failure is fine — the URL is printed anyway. */
export function openUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  run: Launch = launch
): void {
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]]
  try {
    run(command, args)
  } catch {
    // No browser on this machine (a server, a container): the user opens the URL by hand.
  }
}

export function deviceName(): string {
  return hostname()
}
