import { describe, expect, it } from 'vitest'
import { dueMeetingReminders, meetingReminderKey } from './meeting-reminder-schedule'
import type { MeetingResource } from './meeting-types'

function meeting(overrides: Partial<MeetingResource> = {}): MeetingResource {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000001',
    title: 'Release review',
    scopeKind: 'none',
    scopeId: null,
    hostUserId: '30000000-0000-4000-8000-000000000001',
    scheduledStart: '2026-07-21T04:10:00.000Z',
    scheduledEnd: '2026-07-21T05:00:00.000Z',
    timeZone: 'Asia/Seoul',
    recurrence: 'none',
    seriesId: '20000000-0000-4000-8000-000000000001',
    occurrenceIndex: 0,
    status: 'scheduled',
    version: 1,
    createdAt: '2026-07-21T03:00:00.000Z',
    updatedAt: '2026-07-21T03:00:00.000Z',
    ...overrides
  }
}

describe('meeting reminder schedule', () => {
  it('emits a scheduled meeting once during its ten-minute reminder window', () => {
    const scheduled = meeting()
    const now = new Date('2026-07-21T04:02:00.000Z').getTime()
    expect(dueMeetingReminders([scheduled], now, new Set())).toEqual([
      { meeting: scheduled, occurrenceStart: scheduled.scheduledStart }
    ])
    expect(
      dueMeetingReminders([scheduled], now, new Set([meetingReminderKey(scheduled)!]))
    ).toEqual([])
    expect(dueMeetingReminders([meeting({ status: 'cancelled' })], now, new Set())).toEqual([])
  })

  it('uses the next recurring occurrence in the reminder key', () => {
    const scheduled = meeting({
      scheduledStart: '2026-07-14T04:10:00.000Z',
      scheduledEnd: '2026-07-14T05:00:00.000Z',
      recurrence: 'weekly'
    })
    const now = new Date('2026-07-21T04:02:00.000Z').getTime()
    const [reminder] = dueMeetingReminders([scheduled], now, new Set())
    expect(reminder?.occurrenceStart).toBe('2026-07-21T04:10:00.000Z')
    expect(meetingReminderKey(scheduled, reminder?.occurrenceStart ?? null)).toContain(
      '2026-07-21T04:10:00.000Z'
    )
  })
})
