#!/usr/bin/env node
import { readFileSync } from 'node:fs'

import { runCli } from './run.js'

process.exitCode = runCli(process.argv.slice(2), {
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
