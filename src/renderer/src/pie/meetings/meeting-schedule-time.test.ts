import { describe, expect, it } from 'vitest'
import {
  isoToZonedDateTimeLocal,
  nextMeetingOccurrenceStart,
  zonedDateTimeToIso
} from './meeting-schedule-time'

describe('meeting schedule time', () => {
  it('keeps a Seoul wall clock independent of the desktop time zone', () => {
    expect(zonedDateTimeToIso('2026-07-21T14:30', 'Asia/Seoul')).toBe('2026-07-21T05:30:00.000Z')
    expect(isoToZonedDateTimeLocal('2026-07-21T05:30:00.000Z', 'Asia/Seoul')).toBe(
      '2026-07-21T14:30'
    )
  })

  it('preserves local time when a weekly meeting crosses daylight saving time', () => {
    expect(
      nextMeetingOccurrenceStart(
        '2026-03-01T14:00:00.000Z',
        'America/New_York',
        'weekly',
        new Date('2026-03-02T00:00:00.000Z').getTime()
      )
    ).toBe('2026-03-08T13:00:00.000Z')
  })
})
