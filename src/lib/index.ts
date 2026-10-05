/**
 * The library entry of the open core (`import … from 'project-vision-cli'`): what a server needs
 * to show a team's state from repositories it keeps — snapshots of a checked-out commit and the
 * views over them, computed for a given day. Everything else is the `beacon` command.
 */
export type {
  CheckpointReport,
  DebtReport,
  ItemReport,
  LineReport,
} from '../core/checkpoint-report.js'
export type {
  AuditReport,
  AuditRound,
  AuditSummary,
  CheckpointAudit,
  Finding,
} from '../core/audit.js'
export { type CardBeacon, type CardLink, parseCardBeacons } from '../core/card-beacons.js'
export type { CommitRecord, History } from '../core/history.js'
export type { Problem } from '../core/problem.js'
export type { ProjectIndex } from '../core/project-index.js'
export type { ArchException, Registry, Rule } from '../core/registry.js'
export {
  auditView,
  historyView,
  indexView,
  type IndexView,
  registryView,
  type RepositorySnapshot,
  timelineView,
  type TimelineResult,
} from '../core/snapshot.js'
export { type Timeline, type Todo, todoFor } from '../core/timeline.js'
export { collectSnapshot } from '../workspace/snapshot.js'
