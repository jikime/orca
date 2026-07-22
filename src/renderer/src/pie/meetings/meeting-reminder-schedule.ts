import type { MeetingResource } from './meeting-types'
import { nextMeetingOccurrenceStart } from './meeting-schedule-time'

export const MEETING_REMINDER_LEAD_MS = 10 * 60 * 1_000

export function meetingReminderKey(
  meeting: MeetingResource,
  occurrenceStart: string | null = meeting.scheduledStart
): string | null {
  return occurrenceStart ? `pie-meeting-reminder:${meeting.id}:${occurrenceStart}` : null
}

export type DueMeetingReminder = { meeting: MeetingResource; occurrenceStart: string }

export function dueMeetingReminders(
  meetings: MeetingResource[],
  nowMs: number,
  notifiedKeys: ReadonlySet<string>
): DueMeetingReminder[] {
  return meetings.flatMap((meeting) => {
    if (!meeting.scheduledStart || meeting.status !== 'scheduled') {
      return []
    }
    const occurrenceStart = nextMeetingOccurrenceStart(
      meeting.scheduledStart,
      meeting.timeZone,
      meeting.recurrence,
      nowMs
    )
    const key = meetingReminderKey(meeting, occurrenceStart)
    if (!occurrenceStart || !key || notifiedKeys.has(key)) {
      return []
    }
    const untilStart = new Date(occurrenceStart).getTime() - nowMs
    return untilStart >= 0 && untilStart <= MEETING_REMINDER_LEAD_MS
      ? [{ meeting, occurrenceStart }]
      : []
  })
}
