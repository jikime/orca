import type { MeetingRecurrence } from './meeting-types'

type WallClock = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const DATE_TIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

function formatWallClock(instant: Date, timeZone: string): WallClock {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  )
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute)
  }
}

function wallClockUtcValue(value: WallClock): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute)
}

function sameWallClock(left: WallClock, right: WallClock): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof WallClock] === right[key as keyof WallClock]
  )
}

export function zonedDateTimeToIso(value: string, timeZone: string): string | null {
  const match = DATE_TIME_LOCAL.exec(value)
  if (!match) {
    return null
  }
  const target: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5])
  }
  let candidate = wallClockUtcValue(target)
  try {
    // Why: a wall clock does not carry an offset. Iterating against Intl preserves the chosen IANA
    // zone across DST without baking the desktop machine's local zone into the meeting.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const observed = formatWallClock(new Date(candidate), timeZone)
      candidate += wallClockUtcValue(target) - wallClockUtcValue(observed)
    }
    return sameWallClock(formatWallClock(new Date(candidate), timeZone), target)
      ? new Date(candidate).toISOString()
      : null
  } catch {
    return null
  }
}

export function isoToZonedDateTimeLocal(value: string, timeZone: string): string {
  const wall = formatWallClock(new Date(value), timeZone)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`
}

function occurrenceWallClock(
  original: WallClock,
  recurrence: Exclude<MeetingRecurrence, 'none'>,
  index: number
): WallClock {
  if (recurrence === 'monthly') {
    const absoluteMonth = original.month - 1 + index
    const year = original.year + Math.floor(absoluteMonth / 12)
    const monthIndex = ((absoluteMonth % 12) + 12) % 12
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
    return { ...original, year, month: monthIndex + 1, day: Math.min(original.day, lastDay) }
  }
  const days = index * (recurrence === 'weekly' ? 7 : 1)
  const date = new Date(Date.UTC(original.year, original.month - 1, original.day + days))
  return {
    ...original,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  }
}

export function nextMeetingOccurrenceStart(
  scheduledStart: string,
  timeZone: string,
  recurrence: MeetingRecurrence,
  nowMs: number
): string | null {
  if (new Date(scheduledStart).getTime() >= nowMs) {
    return scheduledStart
  }
  if (recurrence === 'none') {
    return null
  }
  const original = formatWallClock(new Date(scheduledStart), timeZone)
  for (let index = 1; index <= 10_000; index += 1) {
    const wall = occurrenceWallClock(original, recurrence, index)
    const local = `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}T${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`
    const candidate = zonedDateTimeToIso(local, timeZone)
    if (candidate && new Date(candidate).getTime() >= nowMs) {
      return candidate
    }
  }
  return null
}

export function meetingTimeZones(): string[] {
  const current = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const supported = (
    Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
  ).supportedValuesOf?.('timeZone') ?? ['UTC']
  return [current, 'UTC', ...supported].filter(
    (zone, index, zones) => zones.indexOf(zone) === index
  )
}
