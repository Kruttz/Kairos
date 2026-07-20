import { describe, it, expect } from 'vitest'
import { businessMinutesBetween, averageBusinessMinutesPerDay, elapsedInDurationUnits } from '../../../src/promise/business-calendar.js'
import type { BusinessCalendarRef } from '../../../src/promise/types.js'

// UTC (not America/Denver) deliberately -- lets every expected value below be hand-computed
// without a second timezone-conversion step, isolating these tests to the calendar-window logic
// itself. Separate tests below cover a real timezone (Empire Homecare's own America/Denver).
// 2024-01-01 is a real, verified Monday.
const UTC_CALENDAR: BusinessCalendarRef = {
  timezone: 'UTC',
  weeklyHours: [
    { day: 'mon', start: '08:00', end: '17:00' },
    { day: 'tue', start: '08:00', end: '17:00' },
    { day: 'wed', start: '08:00', end: '17:00' },
    { day: 'thu', start: '08:00', end: '17:00' },
    { day: 'fri', start: '08:00', end: '17:00' },
  ],
}

describe('businessMinutesBetween', () => {
  it('counts minutes entirely within one business day', () => {
    // Mon 09:00 -> Mon 13:00 = 4 hours, all within the 08:00-17:00 window.
    expect(businessMinutesBetween('2024-01-01T09:00:00Z', '2024-01-01T13:00:00Z', UTC_CALENDAR)).toBe(240)
  })

  it('excludes the weekend entirely', () => {
    // Fri 16:00 -> Mon 09:00: Fri 16:00-17:00 (60min) + weekend (0) + Mon 08:00-09:00 (60min).
    expect(businessMinutesBetween('2024-01-05T16:00:00Z', '2024-01-08T09:00:00Z', UTC_CALENDAR)).toBe(120)
  })

  it('excludes after-hours time on both ends', () => {
    // Mon 18:00 (already after close) -> Tue 10:00: 0 on Monday + Tue 08:00-10:00 (120min).
    expect(businessMinutesBetween('2024-01-01T18:00:00Z', '2024-01-02T10:00:00Z', UTC_CALENDAR)).toBe(120)
  })

  it('excludes a listed holiday entirely, even during its own business hours', () => {
    const calendarWithHoliday = { ...UTC_CALENDAR, holidays: ['2024-01-01'] }
    // Mon (holiday) 09:00 -> Tue 09:00: Monday excluded entirely; Tue 08:00-09:00 (60min).
    expect(businessMinutesBetween('2024-01-01T09:00:00Z', '2024-01-02T09:00:00Z', calendarWithHoliday)).toBe(60)
  })

  it('returns 0 when end is before or equal to start', () => {
    expect(businessMinutesBetween('2024-01-01T13:00:00Z', '2024-01-01T09:00:00Z', UTC_CALENDAR)).toBe(0)
    expect(businessMinutesBetween('2024-01-01T09:00:00Z', '2024-01-01T09:00:00Z', UTC_CALENDAR)).toBe(0)
  })

  it('returns 0 for a malformed timestamp rather than throwing', () => {
    expect(businessMinutesBetween('not-a-date', '2024-01-01T09:00:00Z', UTC_CALENDAR)).toBe(0)
  })

  it('is timezone-aware -- the same instant counts differently under two different calendar timezones', () => {
    // 2024-01-01T23:30:00Z is Mon 23:30 UTC, but Mon 16:30 in America/Denver (UTC-7 in Jan, MST)
    // -- still within Denver's 08:00-17:00 window, outside UTC's.
    const denverCalendar: BusinessCalendarRef = { timezone: 'America/Denver', weeklyHours: UTC_CALENDAR.weeklyHours }
    const start = '2024-01-01T23:00:00Z'
    const end = '2024-01-01T23:30:00Z'
    expect(businessMinutesBetween(start, end, UTC_CALENDAR)).toBe(0) // after hours in UTC
    expect(businessMinutesBetween(start, end, denverCalendar)).toBe(30) // within hours in Denver
  })
})

describe('averageBusinessMinutesPerDay', () => {
  it('computes 9 hours (540 minutes) for a 08:00-17:00, 5-day calendar', () => {
    expect(averageBusinessMinutesPerDay(UTC_CALENDAR)).toBe(540)
  })

  it('returns 0 for a calendar with no weeklyHours at all', () => {
    expect(averageBusinessMinutesPerDay({ timezone: 'UTC', weeklyHours: [] })).toBe(0)
  })

  it('averages uneven days honestly rather than assuming a uniform week', () => {
    const uneven: BusinessCalendarRef = {
      timezone: 'UTC',
      weeklyHours: [
        { day: 'mon', start: '08:00', end: '20:00' }, // 12h = 720min
        { day: 'fri', start: '08:00', end: '10:00' }, // 2h = 120min
      ],
    }
    expect(averageBusinessMinutesPerDay(uneven)).toBe((720 + 120) / 2)
  })
})

describe('elapsedInDurationUnits', () => {
  it('minutes and hours use plain wall-clock time, no calendar needed', () => {
    expect(elapsedInDurationUnits('2024-01-01T09:00:00Z', '2024-01-01T09:30:00Z', 'minutes')).toBe(30)
    expect(elapsedInDurationUnits('2024-01-01T09:00:00Z', '2024-01-01T13:00:00Z', 'hours')).toBe(4)
    // Wall-clock units don't care that this span crosses a weekend/after-hours.
    expect(elapsedInDurationUnits('2024-01-05T16:00:00Z', '2024-01-08T09:00:00Z', 'hours')).toBe(65)
  })

  it('business_hours matches businessMinutesBetween/60', () => {
    const result = elapsedInDurationUnits('2024-01-05T16:00:00Z', '2024-01-08T09:00:00Z', 'business_hours', UTC_CALENDAR)
    expect(result).toBe(businessMinutesBetween('2024-01-05T16:00:00Z', '2024-01-08T09:00:00Z', UTC_CALENDAR) / 60)
    expect(result).toBe(2)
  })

  it('business_days divides business minutes by the calendar\'s average business-day length', () => {
    // A full 9-hour business day (540 min) should read as exactly 1.0 business day.
    const result = elapsedInDurationUnits('2024-01-01T08:00:00Z', '2024-01-01T17:00:00Z', 'business_days', UTC_CALENDAR)
    expect(result).toBe(1)
  })

  it('business_hours/business_days without a calendar returns 0, not a throw (the conservative direction)', () => {
    expect(elapsedInDurationUnits('2024-01-01T09:00:00Z', '2024-01-02T09:00:00Z', 'business_hours')).toBe(0)
    expect(elapsedInDurationUnits('2024-01-01T09:00:00Z', '2024-01-02T09:00:00Z', 'business_days')).toBe(0)
  })

  it('returns 0 when end is before start, for every unit', () => {
    for (const unit of ['minutes', 'hours', 'business_hours', 'business_days'] as const) {
      expect(elapsedInDurationUnits('2024-01-02T09:00:00Z', '2024-01-01T09:00:00Z', unit, UTC_CALENDAR)).toBe(0)
    }
  })
})
