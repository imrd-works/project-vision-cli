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
export type { CommitRecord, History } from '../core/history.js'
export type { Problem } from '../core/problem.js'
export type { ProjectIndex } from '../core/project-index.js'
export {
  historyView,
  indexView,
  type IndexView,
  type RepositorySnapshot,
  timelineView,
  type TimelineResult,
} from '../core/snapshot.js'
export { type Timeline, type Todo, todoFor } from '../core/timeline.js'
export { collectSnapshot } from '../workspace/snapshot.js'
