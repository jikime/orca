import type { PieNotificationPreferences } from '../../../../shared/pie-chat-contract'

function minuteInTimezone(now: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now)
    const hour = Number(parts.find((part) => part.type === 'hour')?.value)
    const minute = Number(parts.find((part) => part.type === 'minute')?.value)
    return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null
  } catch {
    return null
  }
}

export function isChatDndActive(
  preferences: PieNotificationPreferences,
  now = new Date()
): boolean {
  if (!preferences.dndEnabled) {
    return false
  }
  const minute = minuteInTimezone(now, preferences.timezone)
  if (minute === null) {
    return false
  }
  const { dndStartMinute: start, dndEndMinute: end } = preferences
  if (start === end) {
    return true
  }
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}
