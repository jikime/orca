import type { MeetingResource } from '@pie/persistence'
import { describe, expect, it, vi } from 'vitest'
import {
  GoogleWorkspaceCalendarAdapter,
  Microsoft365CalendarAdapter
} from './meeting-calendar-service'

function meeting(overrides: Partial<MeetingResource> = {}): MeetingResource {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000001',
    title: 'Release review',
    scopeKind: 'project',
    scopeId: '30000000-0000-4000-8000-000000000001',
    hostUserId: '40000000-0000-4000-8000-000000000001',
    scheduledStart: '2026-07-21T05:00:00.000Z',
    scheduledEnd: '2026-07-21T06:00:00.000Z',
    timeZone: 'Asia/Seoul',
    recurrence: 'weekly',
    seriesId: '20000000-0000-4000-8000-000000000001',
    occurrenceIndex: 0,
    status: 'scheduled',
    version: 1,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides
  }
}

describe('meeting calendar adapters', () => {
  it('exports an IANA-zoned recurring Google Calendar event with attendees', async () => {
    const calls: Array<[Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]]> = []
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push([input, init])
      return new Response(
        JSON.stringify({ id: 'google-event', htmlLink: 'https://calendar.google/e/1' }),
        { status: 200 }
      )
    })
    const adapter = new GoogleWorkspaceCalendarAdapter(
      'primary',
      'secret-token',
      fetchFn as typeof fetch
    )
    const result = await adapter.upsertEvent({
      meeting: meeting(),
      attendeeEmails: ['member@pie.test'],
      existingEventId: null
    })
    expect(result.eventId).toBe('google-event')
    const [url, init] = calls[0]!
    expect(String(url)).toContain('/calendars/primary/events?sendUpdates=all')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=1'],
      attendees: [{ email: 'member@pie.test' }]
    })
  })

  it('uses Microsoft Graph PATCH for an existing event and preserves local wall time', async () => {
    const calls: Array<[Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]]> = []
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push([input, init])
      return new Response(
        JSON.stringify({ id: 'ms-event', webLink: 'https://outlook.office/e/1' }),
        { status: 200 }
      )
    })
    const adapter = new Microsoft365CalendarAdapter(
      'primary',
      'secret-token',
      fetchFn as typeof fetch
    )
    await adapter.upsertEvent({
      meeting: meeting(),
      attendeeEmails: [],
      existingEventId: 'ms-event'
    })
    const [url, init] = calls[0]!
    expect(String(url)).toContain('/me/events/ms-event')
    expect(init?.method).toBe('PATCH')
    const body = JSON.parse(String(init?.body)) as {
      start: { dateTime: string; timeZone: string }
      recurrence: { pattern: { type: string } }
    }
    expect(body.start).toEqual({ dateTime: '2026-07-21T14:00:00', timeZone: 'Asia/Seoul' })
    expect(body.recurrence.pattern.type).toBe('weekly')
  })
})
