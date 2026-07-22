import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

export type MeetingCalendarProvider = 'google_workspace' | 'microsoft_365'
export type MeetingCalendarSyncStatus = 'pending' | 'synced' | 'failed'

export type MeetingCalendarLink = {
  id: string
  organizationId: string
  meetingId: string
  provider: MeetingCalendarProvider
  calendarId: string
  eventId: string | null
  webUrl: string | null
  syncStatus: MeetingCalendarSyncStatus
  lastError: string | null
  lastSyncedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type CalendarRow = {
  id: string
  organization_id: string
  meeting_id: string
  provider: string
  calendar_id: string
  event_id: string | null
  web_url: string | null
  sync_status: string
  last_error: string | null
  last_synced_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapCalendarLink(row: CalendarRow): MeetingCalendarLink {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    provider: row.provider as MeetingCalendarProvider,
    calendarId: row.calendar_id,
    eventId: row.event_id,
    webUrl: row.web_url,
    syncStatus: row.sync_status as MeetingCalendarSyncStatus,
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export async function getMeetingCalendarLink(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string,
  provider: MeetingCalendarProvider
): Promise<MeetingCalendarLink | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.calendar_links')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .where('provider', '=', provider)
      .executeTakeFirst()
    return row ? mapCalendarLink(row) : null
  })
}

export async function listMeetingCalendarLinks(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingCalendarLink[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.calendar_links')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('id')
      .execute()
    return rows.map(mapCalendarLink)
  })
}

export async function beginMeetingCalendarSync(
  db: Kysely<Database>,
  input: {
    organizationId: string
    meetingId: string
    provider: MeetingCalendarProvider
    calendarId: string
    actorUserId: string
  }
): Promise<MeetingCalendarLink> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('meetings.calendar_links')
      .values({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        provider: input.provider,
        calendar_id: input.calendarId,
        created_by: input.actorUserId,
        sync_status: 'pending'
      })
      .onConflict((conflict) =>
        conflict.columns(['organization_id', 'meeting_id', 'provider']).doUpdateSet({
          calendar_id: input.calendarId,
          sync_status: 'pending',
          last_error: null,
          updated_at: sql`now()`,
          version: sql`meetings.calendar_links.version + 1`
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapCalendarLink(row)
  })
}

export async function finishMeetingCalendarSync(
  db: Kysely<Database>,
  input: {
    organizationId: string
    linkId: string
    eventId?: string
    webUrl?: string | null
    error?: string
  }
): Promise<MeetingCalendarLink> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const succeeded = Boolean(input.eventId)
    const row = await trx
      .updateTable('meetings.calendar_links')
      .set({
        sync_status: succeeded ? 'synced' : 'failed',
        event_id: input.eventId ?? undefined,
        web_url: succeeded ? (input.webUrl ?? null) : undefined,
        last_error: succeeded ? null : (input.error ?? 'calendar sync failed').slice(0, 1_000),
        last_synced_at: succeeded ? sql`now()` : undefined,
        updated_at: sql`now()`,
        version: sql`version + 1`
      })
      .where('id', '=', input.linkId)
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapCalendarLink(row)
  })
}

export async function listMeetingAttendeeEmails(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<string[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.participants as participant')
      .innerJoin('identity.user_accounts as account', 'account.id', 'participant.user_id')
      .select('account.email')
      .where('participant.meeting_id', '=', meetingId)
      .where('participant.access_status', 'in', ['invited', 'waiting', 'admitted'])
      .execute()
    return [...new Set(rows.map((row) => row.email))]
  })
}
