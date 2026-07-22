import type { MeetingCalendarProvider, MeetingRecurrence, MeetingResource } from '@pie/persistence'

export type MeetingCalendarEventInput = {
  meeting: MeetingResource
  attendeeEmails: string[]
  existingEventId: string | null
}

export type MeetingCalendarEventResult = { eventId: string; webUrl: string | null }

export interface MeetingCalendarAdapter {
  readonly provider: MeetingCalendarProvider
  readonly calendarId: string
  upsertEvent(input: MeetingCalendarEventInput): Promise<MeetingCalendarEventResult>
}

export interface MeetingCalendarService {
  configuredProviders(): MeetingCalendarProvider[]
  calendarId(provider: MeetingCalendarProvider): string | null
  upsertEvent(
    provider: MeetingCalendarProvider,
    input: MeetingCalendarEventInput
  ): Promise<MeetingCalendarEventResult>
}

function recurrenceFrequency(recurrence: MeetingRecurrence): string | null {
  const frequencies: Record<MeetingRecurrence, string | null> = {
    none: null,
    daily: 'DAILY',
    weekly: 'WEEKLY',
    monthly: 'MONTHLY'
  }
  return frequencies[recurrence]
}

async function providerJson(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit
): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`calendar provider ${response.status}: ${text.slice(0, 500)}`)
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

export class GoogleWorkspaceCalendarAdapter implements MeetingCalendarAdapter {
  readonly provider = 'google_workspace' as const

  constructor(
    readonly calendarId: string,
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async upsertEvent(input: MeetingCalendarEventInput): Promise<MeetingCalendarEventResult> {
    const { meeting } = input
    if (!meeting.scheduledStart || !meeting.scheduledEnd)
      throw new Error('meeting is not scheduled')
    const recurrence = recurrenceFrequency(meeting.recurrence)
    const calendar = encodeURIComponent(this.calendarId)
    const event = input.existingEventId ? `/${encodeURIComponent(input.existingEventId)}` : ''
    const body = {
      summary: meeting.title,
      description: `Pie meeting ${meeting.id}`,
      start: { dateTime: meeting.scheduledStart, timeZone: meeting.timeZone },
      end: { dateTime: meeting.scheduledEnd, timeZone: meeting.timeZone },
      attendees: input.attendeeEmails.map((email) => ({ email })),
      ...(recurrence ? { recurrence: [`RRULE:FREQ=${recurrence};INTERVAL=1`] } : {}),
      visibility: 'private',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] }
    }
    const result = await providerJson(
      this.fetchFn,
      `https://www.googleapis.com/calendar/v3/calendars/${calendar}/events${event}?sendUpdates=all`,
      {
        method: input.existingEventId ? 'PUT' : 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    )
    if (typeof result.id !== 'string') throw new Error('Google Calendar returned no event id')
    return {
      eventId: result.id,
      webUrl: typeof result.htmlLink === 'string' ? result.htmlLink : null
    }
  }
}

function graphWallClock(iso: string, timeZone: string): { date: string; dateTime: string } {
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
  const date = `${parts.year}-${parts.month}-${parts.day}`
  return { date, dateTime: `${date}T${parts.hour}:${parts.minute}:${parts.second}` }
}

function microsoftRecurrence(meeting: MeetingResource): Record<string, unknown> | undefined {
  if (meeting.recurrence === 'none' || !meeting.scheduledStart) return undefined
  const start = graphWallClock(meeting.scheduledStart, meeting.timeZone)
  const local = new Date(`${start.dateTime}Z`)
  const weekDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const pattern =
    meeting.recurrence === 'daily'
      ? { type: 'daily', interval: 1 }
      : meeting.recurrence === 'weekly'
        ? { type: 'weekly', interval: 1, daysOfWeek: [weekDays[local.getUTCDay()]] }
        : { type: 'absoluteMonthly', interval: 1, dayOfMonth: local.getUTCDate() }
  return { pattern, range: { type: 'noEnd', startDate: start.date } }
}

export class Microsoft365CalendarAdapter implements MeetingCalendarAdapter {
  readonly provider = 'microsoft_365' as const

  constructor(
    readonly calendarId: string,
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async upsertEvent(input: MeetingCalendarEventInput): Promise<MeetingCalendarEventResult> {
    const { meeting } = input
    if (!meeting.scheduledStart || !meeting.scheduledEnd)
      throw new Error('meeting is not scheduled')
    const start = graphWallClock(meeting.scheduledStart, meeting.timeZone)
    const end = graphWallClock(meeting.scheduledEnd, meeting.timeZone)
    const collection =
      this.calendarId === 'primary'
        ? '/me/calendar/events'
        : `/me/calendars/${encodeURIComponent(this.calendarId)}/events`
    const eventPath = input.existingEventId
      ? `/me/events/${encodeURIComponent(input.existingEventId)}`
      : collection
    const body = {
      subject: meeting.title,
      body: { contentType: 'text', content: `Pie meeting ${meeting.id}` },
      start: { dateTime: start.dateTime, timeZone: meeting.timeZone },
      end: { dateTime: end.dateTime, timeZone: meeting.timeZone },
      attendees: input.attendeeEmails.map((address) => ({
        emailAddress: { address },
        type: 'required'
      })),
      ...(microsoftRecurrence(meeting) ? { recurrence: microsoftRecurrence(meeting) } : {}),
      isReminderOn: true,
      reminderMinutesBeforeStart: 10,
      sensitivity: 'private',
      transactionId: meeting.id
    }
    const result = await providerJson(
      this.fetchFn,
      `https://graph.microsoft.com/v1.0${eventPath}`,
      {
        method: input.existingEventId ? 'PATCH' : 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    )
    const eventId = typeof result.id === 'string' ? result.id : input.existingEventId
    if (!eventId) throw new Error('Microsoft Graph returned no event id')
    return { eventId, webUrl: typeof result.webLink === 'string' ? result.webLink : null }
  }
}

export function createMeetingCalendarService(
  adapters: MeetingCalendarAdapter[]
): MeetingCalendarService {
  const byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]))
  return {
    configuredProviders: () => [...byProvider.keys()],
    calendarId: (provider) => byProvider.get(provider)?.calendarId ?? null,
    upsertEvent: (provider, input) => {
      const adapter = byProvider.get(provider)
      if (!adapter) throw new Error(`${provider} calendar is not configured`)
      return adapter.upsertEvent(input)
    }
  }
}
