import {
  createMeetingCalendarService,
  GoogleWorkspaceCalendarAdapter,
  Microsoft365CalendarAdapter,
  type MeetingCalendarAdapter,
  type MeetingCalendarService
} from './meeting-calendar-service'

export function loadMeetingCalendarFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MeetingCalendarService | null {
  const adapters: MeetingCalendarAdapter[] = []
  if (env.PIE_GOOGLE_CALENDAR_ACCESS_TOKEN) {
    adapters.push(
      new GoogleWorkspaceCalendarAdapter(
        env.PIE_GOOGLE_CALENDAR_ID?.trim() || 'primary',
        env.PIE_GOOGLE_CALENDAR_ACCESS_TOKEN
      )
    )
  }
  if (env.PIE_MICROSOFT_CALENDAR_ACCESS_TOKEN) {
    adapters.push(
      new Microsoft365CalendarAdapter(
        env.PIE_MICROSOFT_CALENDAR_ID?.trim() || 'primary',
        env.PIE_MICROSOFT_CALENDAR_ACCESS_TOKEN
      )
    )
  }
  return adapters.length > 0 ? createMeetingCalendarService(adapters) : null
}
