import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R7 MEETINGS. The signaling/metadata record for a video meeting — the media plane (LiveKit/WebRTC
// transport, screen share, live-caption media) is infra and NOT modeled here. A meeting is scoped to an
// OPAQUE project/ticket context so its result is preserved and retrievable there (the R7 exit
// condition "대화와 회의 결과가 프로젝트·티켓 문맥에 보존된다"): listMeetings filters by that scope.

export type MeetingScopeKind = 'project' | 'ticket' | 'none'
export type MeetingStatus = 'scheduled' | 'live' | 'ended' | 'cancelled'

export type MeetingResource = {
  id: string
  organizationId: string
  title: string
  scopeKind: MeetingScopeKind
  scopeId: string | null
  hostUserId: string
  scheduledStart: string | null
  scheduledEnd: string | null
  status: MeetingStatus
  version: number
  createdAt: string
  updatedAt: string
}

type MeetingRow = {
  id: string
  organization_id: string
  title: string
  scope_kind: string
  scope_id: string | null
  host_user_id: string
  scheduled_start: Date | string | null
  scheduled_end: Date | string | null
  status: string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function isoOrNull(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null
}

function mapMeeting(row: MeetingRow): MeetingResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    title: row.title,
    scopeKind: row.scope_kind as MeetingScopeKind,
    scopeId: row.scope_id,
    hostUserId: row.host_user_id,
    scheduledStart: isoOrNull(row.scheduled_start),
    scheduledEnd: isoOrNull(row.scheduled_end),
    status: row.status as MeetingStatus,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateMeetingInput = {
  organizationId: string
  actorUserId: string
  title: string
  hostUserId: string
  scopeKind?: MeetingScopeKind
  scopeId?: string | null
  scheduledStart?: string | null
  scheduledEnd?: string | null
}

/** Creates a meeting in status='scheduled'. A scoped meeting names the project/ticket its result lives in. */
export async function createMeeting(
  db: Kysely<Database>,
  input: CreateMeetingInput
): Promise<MeetingResource> {
  const scopeKind = input.scopeKind ?? 'none'
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('meetings.meetings')
      .values({
        organization_id: input.organizationId,
        title: input.title,
        scope_kind: scopeKind,
        scope_id: scopeKind === 'none' ? null : (input.scopeId ?? null),
        host_user_id: input.hostUserId,
        scheduled_start: input.scheduledStart ?? null,
        scheduled_end: input.scheduledEnd ?? null,
        status: 'scheduled'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.created',
      'meeting',
      row.id
    )
    await emitMeetingResourceChange(trx, input.organizationId, 'meeting', row.id, 1, 'created')
    return mapMeeting(row)
  })
}

export async function getMeeting(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.meetings')
      .selectAll()
      .where('id', '=', meetingId)
      .executeTakeFirst()
    return row ? mapMeeting(row) : null
  })
}

export type MeetingPage = { items: MeetingResource[]; nextCursor: string | null }

/**
 * Lists meetings, optionally filtered by scope (scopeKind + scopeId). The scope filter is the
 * context-preservation read: a project's/ticket's meetings are retrievable via its opaque scope id.
 */
export async function listMeetings(
  db: Kysely<Database>,
  organizationId: string,
  options: {
    limit?: number
    cursor?: string | null
    scopeKind?: MeetingScopeKind
    scopeId?: string | null
  } = {}
): Promise<MeetingPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('meetings.meetings')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.scopeKind) {
      query = query.where('scope_kind', '=', options.scopeKind)
    }
    if (options.scopeId) {
      query = query.where('scope_id', '=', options.scopeId)
    }
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapMeeting), nextCursor }
  })
}

export type MeetingTransitionResult =
  | { ok: true; meeting: MeetingResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: MeetingStatus }

// Legal status edges: scheduled → live → ended; scheduled | live → cancelled.
const LEGAL_MEETING_EDGES: Record<MeetingStatus, MeetingStatus[]> = {
  scheduled: ['live', 'cancelled'],
  live: ['ended', 'cancelled'],
  ended: [],
  cancelled: []
}

export type TransitionMeetingInput = {
  organizationId: string
  meetingId: string
  actorUserId: string
  expectedVersion: number
  toStatus: MeetingStatus
}

/** Moves a meeting along the scheduled→live→ended lifecycle under OCC. */
export async function transitionMeeting(
  db: Kysely<Database>,
  input: TransitionMeetingInput
): Promise<MeetingTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.meetings')
      .selectAll()
      .where('id', '=', input.meetingId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as MeetingStatus
    if (!LEGAL_MEETING_EDGES[from].includes(input.toStatus)) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('meetings.meetings')
      .set({ status: input.toStatus, version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.meetingId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `meeting.${input.toStatus}`,
      'meeting',
      input.meetingId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting',
      input.meetingId,
      newVersion,
      'updated'
    )
    return { ok: true, meeting: mapMeeting(updated) }
  })
}
