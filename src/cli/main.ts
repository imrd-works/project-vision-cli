#!/usr/bin/env node
import { readFileSync } from 'node:fs'

// The index cache uses node:sqlite, which Node 22 still flags with an ExperimentalWarning on
// every run. The API we use is stable; silence that one warning before the module loads.
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message
  if (text.includes('SQLite')) return
  ;(emitWarning as (...args: unknown[]) => void)(warning, ...rest)
})

const { runCli } = await import('./run.js')

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => {
    console.log(text)
  },
  err: (text) => {
    console.error(text)
  },
  readStdin: () => (process.stdin.isTTY ? '' : readFileSync(0, 'utf8')),
  color: process.stdout.isTTY && !process.env['NO_COLOR'],
})
