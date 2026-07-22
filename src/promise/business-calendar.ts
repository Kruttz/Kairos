import type { BusinessCalendarRef, SlaSpec } from './types.js'

/**
 * Business-calendar duration arithmetic (Phase 4, docs/plans/process-contract-promise-engine-plan.md
 * §5.3). Codex's explicit caution: "handle business calendars carefully. If calendar logic is
 * nontrivial, start with simple documented rules and avoid overclaiming precision." Every
 * simplification below is named as one, not silently assumed away.
 *
 * Method: minute-granularity, not a range-overlap algorithm. Walking each minute between two
 * timestamps and checking whether it falls in a weekly-hours window is easy to verify correct by
 * inspection (a real property for something whose whole job is not overclaiming precision) --
 * timezone/DST correctness comes from Intl.DateTimeFormat's own timezone database, not
 * hand-rolled offset math. A multi-day span is at most tens of thousands of minute checks, well
 * under a second -- but nothing in this file's own callers restricts `end` to be "recent" (an
 * old, still-open promise instance evaluated against the real current time is a real, normal
 * case, not an edge case), so a multi-YEAR span is also real and must stay fast: each minute
 * check's own `Intl.DateTimeFormat` instance is cached per timezone (below), not reconstructed
 * per call, after a live multi-year gap was found to hang for 90+ seconds before that fix
 * (roadmap item 11, docs/plans/contract-evolution-ops-roadmap-plan.md §3, item 11).
 */

const WEEKDAY_MAP: Record<string, BusinessCalendarRef['weeklyHours'][number]['day']> = {
  Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun',
}

/** Per-timezone `Intl.DateTimeFormat` instances, reused rather than reconstructed. A real,
 * severe performance bug found live (roadmap item 11, docs/plans/
 * contract-evolution-ops-roadmap-plan.md §3, item 11's own test/checkpoint discipline): the
 * original `isBusinessMinute()` constructed a BRAND NEW `Intl.DateTimeFormat` on every single
 * call -- fine at the "multi-day span" scale this file's own original doc comment assumed, but
 * `businessMinutesBetween()` walks MINUTE BY MINUTE, and any real caller evaluating an old,
 * still-open promise instance (e.g. `kairos contract evolve run`, `kairos contract report`,
 * `kairos watch --contracts` -- none of which restrict themselves to "recent" data, by design)
 * against the real, far-future `now` could trigger millions of minute checks, each constructing
 * a fresh formatter -- confirmed live to hang for 90+ seconds (a ~2.5-year gap, ~1.3M minutes)
 * before this fix. `Intl.DateTimeFormat` construction is known to be far more expensive than
 * calling `.formatToParts()`/`.format()` on an already-built instance -- reusing one, keyed by
 * timezone, is a pure performance fix with zero behavior change: the formatter's OUTPUT for a
 * given instant is identical either way, only the redundant construction cost is removed. */
const weekdayFormatterCache = new Map<string, Intl.DateTimeFormat>()
const isoDateFormatterCache = new Map<string, Intl.DateTimeFormat>()

function weekdayFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = weekdayFormatterCache.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    weekdayFormatterCache.set(timezone, formatter)
  }
  return formatter
}

function isoDateFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = isoDateFormatterCache.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    isoDateFormatterCache.set(timezone, formatter)
  }
  return formatter
}

function isBusinessMinute(date: Date, calendar: BusinessCalendarRef): boolean {
  const parts = weekdayFormatter(calendar.timezone).formatToParts(date)

  const weekdayPart = parts.find(p => p.type === 'weekday')?.value
  const day = weekdayPart ? WEEKDAY_MAP[weekdayPart] : undefined
  if (!day) return false

  if (calendar.holidays?.length) {
    const isoDate = isoDateFormatter(calendar.timezone).format(date)
    if (calendar.holidays.includes(isoDate)) return false
  }

  // n8n-style 24h "HH:MM" strings compare correctly as plain strings.
  let hour = parts.find(p => p.type === 'hour')?.value ?? '00'
  if (hour === '24') hour = '00' // some locales render midnight as "24:00" with hour12: false
  const minute = parts.find(p => p.type === 'minute')?.value ?? '00'
  const hhmm = `${hour}:${minute}`

  return calendar.weeklyHours.some(w => w.day === day && hhmm >= w.start && hhmm < w.end)
}

/** A hard cap on how far this will walk minute-by-minute, protecting against a malformed
 * timestamp (e.g. a corrupted year) turning into a runaway loop -- not a real business scenario,
 * a defensive bound. ~5.5 years of minutes. */
const MAX_MINUTES_WALKED = 3_000_000

/** Total business-calendar minutes between two ISO timestamps -- 0 if end <= start. */
export function businessMinutesBetween(startISO: string, endISO: string, calendar: BusinessCalendarRef): number {
  const start = new Date(startISO)
  const end = new Date(endISO)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0

  let minutes = 0
  const cursor = new Date(start)
  cursor.setSeconds(0, 0)
  let steps = 0
  while (cursor < end && steps < MAX_MINUTES_WALKED) {
    if (isBusinessMinute(cursor, calendar)) minutes++
    cursor.setMinutes(cursor.getMinutes() + 1)
    steps++
  }
  return minutes
}

/**
 * A named simplification, not calendar-date counting: "1 business day" is approximated as this
 * calendar's average open-day length (total weeklyHours minutes / number of distinct open days),
 * not "advance N calendar dates that happen to be open." Chosen specifically because it lets
 * business_days reuse the exact same, already-verified businessMinutesBetween() rather than a
 * second, differently-shaped date-counting algorithm -- one mechanism to get right and test, not
 * two. Documented here per Codex's explicit instruction not to overclaim precision: a contract
 * with very uneven daily hours (e.g. 2 hours on Friday, 10 on every other day) will see
 * business_days durations that are somewhat looser or tighter than a literal "N distinct open
 * calendar dates" reading would produce. Real, named, not hidden.
 */
export function averageBusinessMinutesPerDay(calendar: BusinessCalendarRef): number {
  const openDays = new Set(calendar.weeklyHours.map(w => w.day))
  if (openDays.size === 0) return 0
  let totalMinutes = 0
  for (const w of calendar.weeklyHours) {
    const [sh, sm] = w.start.split(':').map(Number)
    const [eh, em] = w.end.split(':').map(Number)
    totalMinutes += (eh! * 60 + em!) - (sh! * 60 + sm!)
  }
  return totalMinutes / openDays.size
}

/**
 * Elapsed time between two ISO timestamps, expressed in the SAME unit a SlaSpec/ExpirationRule
 * duration uses -- so callers just compare the result against `duration.amount` directly.
 * `calendar` is required for business_hours/business_days; its absence there returns 0 (the
 * conservative direction -- never fabricates elapsed business time) rather than throwing, since
 * Phase 0's validator rule 8 already guarantees a valid contract has a calendar whenever a
 * business-aware unit is used -- this is a defensive fallback, not the expected path.
 */
export function elapsedInDurationUnits(
  startISO: string,
  endISO: string,
  unit: SlaSpec['duration']['unit'],
  calendar?: BusinessCalendarRef,
): number {
  const start = new Date(startISO).getTime()
  const end = new Date(endISO).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0
  const wallMinutes = (end - start) / 60_000

  switch (unit) {
    case 'minutes':
      return wallMinutes
    case 'hours':
      return wallMinutes / 60
    case 'business_hours':
      return calendar ? businessMinutesBetween(startISO, endISO, calendar) / 60 : 0
    case 'business_days': {
      if (!calendar) return 0
      const perDay = averageBusinessMinutesPerDay(calendar)
      return perDay > 0 ? businessMinutesBetween(startISO, endISO, calendar) / perDay : 0
    }
  }
}
