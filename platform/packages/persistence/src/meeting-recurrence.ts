import type { MeetingRecurrence } from './meeting-store'

type WallClock = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallClock(iso: string, timeZone: string): WallClock {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value])
  )
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  }
}

function utcValue(value: WallClock): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second)
}

function nextWallClock(
  current: WallClock,
  recurrence: Exclude<MeetingRecurrence, 'none'>
): WallClock {
  if (recurrence === 'monthly') {
    const nextMonth = current.month === 12 ? 1 : current.month + 1
    const nextYear = current.month === 12 ? current.year + 1 : current.year
    const finalDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate()
    return { ...current, year: nextYear, month: nextMonth, day: Math.min(current.day, finalDay) }
  }
  const date = new Date(
    Date.UTC(current.year, current.month - 1, current.day + (recurrence === 'weekly' ? 7 : 1))
  )
  return {
    ...current,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  }
}

function wallClockToIso(target: WallClock, timeZone: string): string {
  let candidate = utcValue(target)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    candidate += utcValue(target) - utcValue(wallClock(new Date(candidate).toISOString(), timeZone))
  }
  return new Date(candidate).toISOString()
}

export function nextRecurringMeetingSchedule(input: {
  scheduledStart: string
  scheduledEnd: string
  timeZone: string
  recurrence: Exclude<MeetingRecurrence, 'none'>
}): { scheduledStart: string; scheduledEnd: string } {
  const duration = new Date(input.scheduledEnd).getTime() - new Date(input.scheduledStart).getTime()
  const nextStart = wallClockToIso(
    nextWallClock(wallClock(input.scheduledStart, input.timeZone), input.recurrence),
    input.timeZone
  )
  return {
    scheduledStart: nextStart,
    scheduledEnd: new Date(new Date(nextStart).getTime() + duration).toISOString()
  }
}
