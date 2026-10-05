import type { Problem } from '../core/problem.js'
import type { ProjectIndex } from '../core/project-index.js'
import { coveringException } from '../core/registry.js'

import { loadConfig, loadProject, scanProject } from './project.js'
import { loadRegistry } from './registry.js'
import { type CoveringException, runValidator, type ValidationRun } from './validation-runner.js'

/** The architecture checks as of the last run. `version` grows with every finished run. */
export interface ValidationSnapshot {
  version: number
  /** False when `.beacons/config.yml` lists no validators. */
  configured: boolean
  running: boolean
  runs: ValidationRun[]
  /** Problems of `.beacons/config.yml` itself. */
  problems: Problem[]
}

type Listener = (snapshot: ValidationSnapshot) => void

/** Runs every configured validator and maps violations to zones. */
export async function validateProject(
  root: string,
  index?: ProjectIndex
): Promise<Omit<ValidationSnapshot, 'version' | 'running'>> {
  const config = loadConfig(root)
  if (!config.ok) return { configured: false, runs: [], problems: config.problems }
  const validators = config.config.validation
  if (validators.length === 0) return { configured: false, runs: [], problems: [] }

  const zonesOf = zoneLookup(root, index)
  const covering = exceptionLookup(root)
  const runs: ValidationRun[] = []
  for (const validator of validators) {
    runs.push(await runValidator(root, validator, zonesOf, covering))
  }
  return { configured: true, runs, problems: [] }
}

/** Violations of rules the registry names, in the scope of an exception, are deviations. */
function exceptionLookup(root: string): CoveringException {
  const load = loadProject(root)
  const registry = loadRegistry(root, load.kind === 'ok' ? load.project.manifest : undefined)
  return (violation) =>
    coveringException(registry, {
      validatorRule: violation.rule,
      ...(violation.file === undefined ? {} : { file: violation.file }),
      zones: violation.zones,
    })?.id
}

/**
 * Re-runs the architecture checks after changes (debounced, one run at a time) — the source of
 * live validation in `beacon watch` and `beacon serve`.
 */
export class LiveValidation {
  private snapshot: ValidationSnapshot = {
    version: 0,
    configured: false,
    running: false,
    runs: [],
    problems: [],
  }
  private readonly listeners = new Set<Listener>()
  private timer: NodeJS.Timeout | undefined
  private pending = false
  private stopped = false

  constructor(
    private readonly root: string,
    private readonly index: () => ProjectIndex | undefined,
    private readonly debounceMs = 1000
  ) {}

  current(): ValidationSnapshot {
    return this.snapshot
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Asks for a run soon; changes during a run trigger one more run right after it. */
  schedule(delayMs = this.debounceMs): void {
    if (this.stopped) return
    if (this.snapshot.running) {
      this.pending = true
      return
    }
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.run(), delayMs)
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.listeners.clear()
  }

  private async run(): Promise<void> {
    this.update({ running: true })
    const result = await validateProject(this.root, this.index())
    if (this.stopped) return
    this.update({ ...result, running: false, version: this.snapshot.version + 1 })
    if (!this.pending) {
      return
    }

    this.pending = false
    this.schedule()
  }

  private update(fields: Partial<ValidationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...fields }
    for (const listener of this.listeners) listener(this.snapshot)
  }
}

/** Zones of a file: by the index when there is one, by the zone map otherwise. */
function zoneLookup(root: string, index: ProjectIndex | undefined): (file: string) => string[] {
  const indexed = index ?? scanIfPossible(root)
  const byFile = new Map(
    (indexed?.files ?? []).map((file) => [
      file.path,
      [...new Set([...file.zones, ...file.regions.flatMap((region) => region.zones)])],
    ])
  )
  return (file) => byFile.get(file) ?? []
}

function scanIfPossible(root: string): ProjectIndex | undefined {
  const load = loadProject(root)
  return load.kind === 'ok' ? scanProject(load.project) : undefined
}
