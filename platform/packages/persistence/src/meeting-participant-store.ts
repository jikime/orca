import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R7 MEETINGS — participants. A participant's consent_recording is the 녹화 동의 the recording gate
// consults (meeting-recording-store): recording is refused unless every currently-joined participant
// has consented.

export type MeetingParticipantRole = 'host' | 'participant'

export type MeetingParticipantResource = {
  id: string
  organizationId: string
  meetingId: string
  userId: string
  role: MeetingParticipantRole
  consentRecording: boolean
  joinedAt: string | null
  leftAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type ParticipantRow = {
  id: string
  organization_id: string
  meeting_id: string
  user_id: string
  role: string
  consent_recording: boolean
  joined_at: Date | string | null
  left_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapParticipant(row: ParticipantRow): MeetingParticipantResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    userId: row.user_id,
    role: row.role as MeetingParticipantRole,
    consentRecording: row.consent_recording,
    joinedAt: row.joined_at ? new Date(row.joined_at).toISOString() : null,
    leftAt: row.left_at ? new Date(row.left_at).toISOString() : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

async function meetingExists(trx: Transaction<Database>, meetingId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('meetings.meetings')
    .select('id')
    .where('id', '=', meetingId)
    .executeTakeFirst()
  return Boolean(row)
}

export type AddParticipantResult =
  | { ok: true; participant: MeetingParticipantResource }
  | { ok: false; reason: 'meeting_not_found' }
  | { ok: false; reason: 'already_added' }

export type AddParticipantInput = {
  organizationId: string
  actorUserId: string
  meetingId: string
  userId: string
  role?: MeetingParticipantRole
  consentRecording?: boolean
}

/** Adds a participant to a meeting (joined_at set = they have joined); consent defaults false. */
export async function addMeetingParticipant(
  db: Kysely<Database>,
  input: AddParticipantInput
): Promise<AddParticipantResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    if (!(await meetingExists(trx, input.meetingId))) {
      return { ok: false, reason: 'meeting_not_found' }
    }
    const duplicate = await trx
      .selectFrom('meetings.participants')
      .select('id')
      .where('meeting_id', '=', input.meetingId)
      .where('user_id', '=', input.userId)
      .executeTakeFirst()
    if (duplicate) {
      return { ok: false, reason: 'already_added' }
    }
    const row = await trx
      .insertInto('meetings.participants')
      .values({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        user_id: input.userId,
        role: input.role ?? 'participant',
        consent_recording: input.consentRecording ?? false,
        joined_at: sql`now()`
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.participant.added',
      'meeting_participant',
      row.id
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_participant',
      row.id,
      1,
      'created'
    )
    return { ok: true, participant: mapParticipant(row) }
  })
}

export type ConsentParticipantResult =
  | { ok: true; participant: MeetingParticipantResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export type ConsentParticipantInput = {
  organizationId: string
  actorUserId: string
  participantId: string
  expectedVersion: number
  consent: boolean
}

/** Records a participant's recording consent (the 녹화 동의) under OCC. */
export async function setMeetingParticipantConsent(
  db: Kysely<Database>,
  input: ConsentParticipantInput
): Promise<ConsentParticipantResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.participants')
      .selectAll()
      .where('id', '=', input.participantId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('meetings.participants')
      .set({
        consent_recording: input.consent,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.participantId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      input.consent ? 'meeting.participant.consent_granted' : 'meeting.participant.consent_revoked',
      'meeting_participant',
      input.participantId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_participant',
      input.participantId,
      newVersion,
      'updated'
    )
    return { ok: true, participant: mapParticipant(updated) }
  })
}

export async function listMeetingParticipants(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingParticipantResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.participants')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapParticipant)
  })
}
