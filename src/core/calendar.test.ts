import { describe, expect, it } from 'vitest'

import {
  addDays,
  dateRange,
  daysBetween,
  isWorkingDay,
  median,
  workingDaysBetween,
} from './calendar.js'

describe('calendar', () => {
  it('moves across months and counts days', () => {
    expect(addDays('2026-09-29', 3)).toBe('2026-10-02')
    expect(daysBetween('2026-10-02', '2026-09-29')).toBe(-3)
    expect(dateRange('2026-10-30', '2026-11-01')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ])
  })

  it('counts working days only', () => {
    expect(isWorkingDay('2026-10-03')).toBe(false) // Saturday
    expect(workingDaysBetween('2026-10-02', '2026-10-06')).toBe(2) // Mon, Tue
    expect(workingDaysBetween('2026-10-06', '2026-10-06')).toBe(0)
  })

  it('finds the median of odd and even samples', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeUndefined()
  })
})
