import { useEffect } from 'react'
import type { MeetingResource } from './meeting-types'
import { dueMeetingReminders, meetingReminderKey } from './meeting-reminder-schedule'

const STORAGE_KEY = 'pie.meeting.reminders.delivered.v1'

function readDelivered(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    return new Set(
      Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    )
  } catch {
    return new Set()
  }
}

export function MeetingReminderScheduler({ meetings }: { meetings: MeetingResource[] }): null {
  useEffect(() => {
    const check = (): void => {
      const delivered = readDelivered()
      const due = dueMeetingReminders(meetings, Date.now(), delivered)
      for (const { meeting, occurrenceStart } of due) {
        const key = meetingReminderKey(meeting, occurrenceStart)
        if (!key) {
          continue
        }
        delivered.add(key)
        void window.api.notifications.dispatch({
          source: 'pie-meeting',
          notificationId: key,
          meetingId: meeting.id,
          meetingTitle: meeting.title,
          meetingStartLabel: new Date(occurrenceStart).toLocaleString()
        })
      }
      // Persist before the next timer so an IPC retry cannot duplicate a native reminder.
      if (due.length > 0) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...delivered].slice(-200)))
      }
    }
    check()
    const interval = window.setInterval(check, 30_000)
    return () => window.clearInterval(interval)
  }, [meetings])
  return null
}
