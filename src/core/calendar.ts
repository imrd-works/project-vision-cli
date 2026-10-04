/** Calendar helpers on ISO dates (YYYY-MM-DD), in UTC so that time zones never shift a day. */

const DAY_MS = 86_400_000

export function parseDay(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

export function formatDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
  return formatDay(parseDay(date) + days * DAY_MS)
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to) - parseDay(from)) / DAY_MS)
}

export function isWorkingDay(date: string): boolean {
  const weekday = new Date(parseDay(date)).getUTCDay()
  return weekday !== 0 && weekday !== 6
}

/** Working days (Mon–Fri) after `from` up to and including `to`. */
export function workingDaysBetween(from: string, to: string): number {
  let count = 0
  for (let day = addDays(from, 1); day <= to; day = addDays(day, 1)) {
    if (isWorkingDay(day)) count++
  }
  return count
}

export function dateRange(from: string, to: string): string[] {
  const dates: string[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) dates.push(day)
  return dates
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}
