import { createHash, randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withoutTenantContext, withTenantTransaction } from './tenant-transaction'

export type MeetingGuestIdentityMode = 'account_required' | 'limited_guest'
export type MeetingGuestVisibility = 'meeting_only' | 'meeting_and_recap'

export type MeetingGuestLink = {
  id: string
  organizationId: string
  meetingId: string
  identityMode: MeetingGuestIdentityMode
  visibility: MeetingGuestVisibility
  expiresAt: string
  revokedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type GuestLinkRow = {
  id: string
  organization_id: string
  meeting_id: string
  identity_mode: string
  visibility: string
  expires_at: Date | string
  revoked_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function tokenHash(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

function mapGuestLink(row: GuestLinkRow): MeetingGuestLink {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    identityMode: row.identity_mode as MeetingGuestIdentityMode,
    visibility: row.visibility as MeetingGuestVisibility,
    expiresAt: new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export async function createMeetingGuestLink(
  db: Kysely<Database>,
  input: {
    organizationId: string
    meetingId: string
    actorUserId: string
    identityMode: MeetingGuestIdentityMode
    visibility: MeetingGuestVisibility
    expiresInHours: number
  }
): Promise<{ link: MeetingGuestLink; rawToken: string }> {
  const rawToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1_000).toISOString()
  const link = await withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('meetings.guest_links')
      .values({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        token_hash: tokenHash(rawToken),
        identity_mode: input.identityMode,
        visibility: input.visibility,
        expires_at: expiresAt,
        created_by: input.actorUserId
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapGuestLink(row)
  })
  return { link, rawToken }
}

export async function listMeetingGuestLinks(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingGuestLink[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.guest_links')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('id')
      .execute()
    return rows.map(mapGuestLink)
  })
}

export async function revokeMeetingGuestLink(
  db: Kysely<Database>,
  input: { organizationId: string; linkId: string; actorUserId: string; expectedVersion: number }
): Promise<'revoked' | 'not_found' | 'version_conflict'> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.guest_links')
      .select(['version', 'revoked_at'])
      .where('id', '=', input.linkId)
      .executeTakeFirst()
    if (!current) return 'not_found'
    if (Number(current.version) !== input.expectedVersion) return 'version_conflict'
    if (current.revoked_at) return 'revoked'
    await trx
      .updateTable('meetings.guest_links')
      .set({
        revoked_at: sql`now()`,
        revoked_by: input.actorUserId,
        version: sql`version + 1`,
        updated_at: sql`now()`
      })
      .where('id', '=', input.linkId)
      .execute()
    return 'revoked'
  })
}

export type PublicMeetingGuestContext = {
  organizationId: string
  meetingId: string
  title: string
  scheduledStart: string | null
  scheduledEnd: string | null
  timeZone: string
  status: string
  identityMode: MeetingGuestIdentityMode
  visibility: MeetingGuestVisibility
  recap: string | null
}

export async function resolveMeetingGuestLink(
  db: Kysely<Database>,
  rawToken: string
): Promise<
  | { ok: true; context: PublicMeetingGuestContext }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' }
> {
  return withoutTenantContext(db, async (trx) => {
    const link = await trx
      .selectFrom('meetings.guest_links')
      .selectAll()
      .where('token_hash', '=', tokenHash(rawToken))
      .executeTakeFirst()
    if (!link) return { ok: false, reason: 'invalid' }
    if (link.revoked_at) return { ok: false, reason: 'revoked' }
    if (new Date(link.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' }
    const meeting = await trx
      .selectFrom('meetings.meetings')
      .selectAll()
      .where('organization_id', '=', link.organization_id)
      .where('id', '=', link.meeting_id)
      .executeTakeFirstOrThrow()
    const minutes =
      link.visibility === 'meeting_and_recap'
        ? await trx
            .selectFrom('meetings.minutes')
            .select('summary')
            .where('organization_id', '=', link.organization_id)
            .where('meeting_id', '=', link.meeting_id)
            .where('status', '=', 'finalized')
            .orderBy('updated_at', 'desc')
            .executeTakeFirst()
        : null
    return {
      ok: true,
      context: {
        organizationId: link.organization_id,
        meetingId: meeting.id,
        title: meeting.title,
        scheduledStart: meeting.scheduled_start
          ? new Date(meeting.scheduled_start).toISOString()
          : null,
        scheduledEnd: meeting.scheduled_end ? new Date(meeting.scheduled_end).toISOString() : null,
        timeZone: meeting.time_zone,
        status: meeting.status,
        identityMode: link.identity_mode as MeetingGuestIdentityMode,
        visibility: link.visibility as MeetingGuestVisibility,
        recap: minutes?.summary ?? null
      }
    }
  })
}

export type MeetingGuestSession = {
  organizationId: string
  meetingId: string
  guestLinkId: string
  userId: string
  displayName: string
  expiresAt: string
  identityMode: MeetingGuestIdentityMode
  visibility: MeetingGuestVisibility
}

export async function createMeetingGuestSession(
  db: Kysely<Database>,
  input: {
    organizationId: string
    guestLinkId: string
    meetingId: string
    userId: string
    displayName: string
    email?: string | null
  }
): Promise<{ session: MeetingGuestSession; accessToken: string } | null> {
  const accessToken = randomBytes(32).toString('base64url')
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const link = await trx
      .selectFrom('meetings.guest_links')
      .selectAll()
      .where('id', '=', input.guestLinkId)
      .where('meeting_id', '=', input.meetingId)
      .executeTakeFirst()
    if (!link || link.revoked_at || new Date(link.expires_at).getTime() <= Date.now()) return null
    const expiresAt = new Date(
      Math.min(new Date(link.expires_at).getTime(), Date.now() + 12 * 60 * 60 * 1_000)
    ).toISOString()
    await trx
      .insertInto('meetings.guest_sessions')
      .values({
        organization_id: input.organizationId,
        guest_link_id: input.guestLinkId,
        meeting_id: input.meetingId,
        user_id: input.userId,
        display_name: input.displayName,
        email: input.email ?? null,
        access_token_hash: tokenHash(accessToken),
        expires_at: expiresAt
      })
      .execute()
    return {
      accessToken,
      session: {
        organizationId: input.organizationId,
        meetingId: input.meetingId,
        guestLinkId: input.guestLinkId,
        userId: input.userId,
        displayName: input.displayName,
        expiresAt,
        identityMode: link.identity_mode as MeetingGuestIdentityMode,
        visibility: link.visibility as MeetingGuestVisibility
      }
    }
  })
}

export async function resolveMeetingGuestSession(
  db: Kysely<Database>,
  accessToken: string
): Promise<MeetingGuestSession | null> {
  return withoutTenantContext(db, async (trx) => {
    const row = await trx
      .selectFrom('meetings.guest_sessions as session')
      .innerJoin('meetings.guest_links as link', (join) =>
        join
          .onRef('link.organization_id', '=', 'session.organization_id')
          .onRef('link.id', '=', 'session.guest_link_id')
      )
      .select([
        'session.organization_id',
        'session.meeting_id',
        'session.guest_link_id',
        'session.user_id',
        'session.display_name',
        'session.expires_at',
        'session.revoked_at',
        'link.identity_mode',
        'link.visibility',
        'link.expires_at as link_expires_at',
        'link.revoked_at as link_revoked_at'
      ])
      .where('session.access_token_hash', '=', tokenHash(accessToken))
      .executeTakeFirst()
    if (
      !row ||
      row.revoked_at ||
      row.link_revoked_at ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      new Date(row.link_expires_at).getTime() <= Date.now()
    ) {
      return null
    }
    return {
      organizationId: row.organization_id,
      meetingId: row.meeting_id,
      guestLinkId: row.guest_link_id,
      userId: row.user_id,
      displayName: row.display_name,
      expiresAt: new Date(row.expires_at).toISOString(),
      identityMode: row.identity_mode as MeetingGuestIdentityMode,
      visibility: row.visibility as MeetingGuestVisibility
    }
  })
}

export async function findMeetingGuestLinkIdByToken(
  db: Kysely<Database>,
  rawToken: string
): Promise<string | null> {
  return withoutTenantContext(db, async (trx) => {
    const row = await trx
      .selectFrom('meetings.guest_links')
      .select('id')
      .where('token_hash', '=', tokenHash(rawToken))
      .executeTakeFirst()
    return row?.id ?? null
  })
}
