import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  insertPendingMeetingCaptureConsents,
  resetMeetingCaptureConsentsForParticipant,
  setLegacyMeetingCaptureConsentSet
} from './meeting-capture-consent-store'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R7 MEETINGS — participants. A participant's consent_recording is the 녹화 동의 the recording gate
// consults (meeting-recording-store): recording is refused unless every currently-joined participant
// has consented.

export type MeetingParticipantRole = 'host' | 'co_host' | 'presenter' | 'participant'
export type MeetingParticipantAccessStatus =
  | 'invited'
  | 'waiting'
  | 'admitted'
  | 'denied'
  | 'blocked'

export type MeetingParticipantResource = {
  id: string
  organizationId: string
  meetingId: string
  userId: string
  role: MeetingParticipantRole
  accessStatus: MeetingParticipantAccessStatus
  consentRecording: boolean
  joinedAt: string | null
  leftAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingParticipantRow = {
  id: string
  organization_id: string
  meeting_id: string
  user_id: string
  role: string
  access_status: string
  consent_recording: boolean
  joined_at: Date | string | null
  left_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapMeetingParticipantRow(row: MeetingParticipantRow): MeetingParticipantResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    userId: row.user_id,
    role: row.role as MeetingParticipantRole,
    accessStatus: row.access_status as MeetingParticipantAccessStatus,
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
}

/** Adds an invited participant; signed media presence records the actual join time later. */
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
      .selectAll()
      .where('meeting_id', '=', input.meetingId)
      .where('user_id', '=', input.userId)
      .forUpdate()
      .executeTakeFirst()
    if (duplicate) {
      if (duplicate.access_status === 'blocked' || duplicate.access_status === 'denied') {
        const version = Number(duplicate.version) + 1
        const restored = await trx
          .updateTable('meetings.participants')
          .set({
            access_status: 'invited',
            role: input.role ?? 'participant',
            left_at: null,
            consent_recording: false,
            version,
            updated_at: sql`now()`
          })
          .where('id', '=', duplicate.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        await resetMeetingCaptureConsentsForParticipant(trx, {
          organizationId: input.organizationId,
          meetingId: input.meetingId,
          participantId: restored.id,
          actorUserId: input.actorUserId
        })
        await auditMeetingEvent(
          trx,
          input.organizationId,
          input.actorUserId,
          'meeting.participant.reinvited',
          'meeting_participant',
          duplicate.id
        )
        await emitMeetingResourceChange(
          trx,
          input.organizationId,
          'meeting_participant',
          duplicate.id,
          version,
          'updated'
        )
        return { ok: true, participant: mapMeetingParticipantRow(restored) }
      }
      return { ok: false, reason: 'already_added' }
    }
    const row = await trx
      .insertInto('meetings.participants')
      .values({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        user_id: input.userId,
        role: input.role ?? 'participant',
        access_status: input.role === 'host' ? 'admitted' : 'invited',
        consent_recording: false,
        joined_at: null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await insertPendingMeetingCaptureConsents(trx, {
      organizationId: input.organizationId,
      meetingId: input.meetingId,
      participantId: row.id
    })
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
    return { ok: true, participant: mapMeetingParticipantRow(row) }
  })
}

export type ConsentParticipantResult =
  | { ok: true; participant: MeetingParticipantResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'participant_user_mismatch' }
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
    if (current.user_id !== input.actorUserId) {
      // Recording consent is a personal legal choice; meeting managers cannot grant it for others.
      return { ok: false, reason: 'participant_user_mismatch' }
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
    await setLegacyMeetingCaptureConsentSet(trx, {
      organizationId: input.organizationId,
      meetingId: updated.meeting_id,
      participantId: updated.id,
      actorUserId: input.actorUserId,
      granted: input.consent
    })
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
    return { ok: true, participant: mapMeetingParticipantRow(updated) }
  })
}

export async function getMeetingParticipantForUser(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string,
  userId: string
): Promise<MeetingParticipantResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.participants')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .where('user_id', '=', userId)
      .executeTakeFirst()
    return row ? mapMeetingParticipantRow(row) : null
  })
}

export async function ensureMeetingHostParticipant(
  db: Kysely<Database>,
  input: { organizationId: string; meetingId: string; hostUserId: string }
): Promise<MeetingParticipantResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const inserted = await trx
      .insertInto('meetings.participants')
      .values({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        user_id: input.hostUserId,
        role: 'host',
        access_status: 'admitted',
        consent_recording: false,
        joined_at: null
      })
      .onConflict((conflict) =>
        conflict.columns(['organization_id', 'meeting_id', 'user_id']).doNothing()
      )
      .returningAll()
      .executeTakeFirst()
    if (inserted) {
      await insertPendingMeetingCaptureConsents(trx, {
        organizationId: input.organizationId,
        meetingId: input.meetingId,
        participantId: inserted.id
      })
      await auditMeetingEvent(
        trx,
        input.organizationId,
        input.hostUserId,
        'meeting.participant.added',
        'meeting_participant',
        inserted.id
      )
      await emitMeetingResourceChange(
        trx,
        input.organizationId,
        'meeting_participant',
        inserted.id,
        1,
        'created'
      )
      return mapMeetingParticipantRow(inserted)
    }
    const existing = await trx
      .selectFrom('meetings.participants')
      .selectAll()
      .where('meeting_id', '=', input.meetingId)
      .where('user_id', '=', input.hostUserId)
      .executeTakeFirstOrThrow()
    return mapMeetingParticipantRow(existing)
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
    return rows.map(mapMeetingParticipantRow)
  })
}

export async function getMeetingParticipant(
  db: Kysely<Database>,
  organizationId: string,
  participantId: string
): Promise<MeetingParticipantResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.participants')
      .selectAll()
      .where('id', '=', participantId)
      .executeTakeFirst()
    return row ? mapMeetingParticipantRow(row) : null
  })
}

export type BlockMeetingParticipantResult =
  | { ok: true; participant: MeetingParticipantResource }
  | { ok: false; reason: 'not_found' | 'host_protected' }

export async function blockMeetingParticipant(
  db: Kysely<Database>,
  input: { organizationId: string; participantId: string; actorUserId: string }
): Promise<BlockMeetingParticipantResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.participants')
      .selectAll()
      .where('id', '=', input.participantId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (current.role === 'host') return { ok: false, reason: 'host_protected' }
    const version = Number(current.version) + 1
    const updated = await trx
      .updateTable('meetings.participants')
      .set({
        access_status: 'blocked',
        left_at: sql`now()`,
        version,
        updated_at: sql`now()`
      })
      .where('id', '=', input.participantId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.participant.removed',
      'meeting_participant',
      input.participantId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_participant',
      input.participantId,
      version,
      'updated'
    )
    return { ok: true, participant: mapMeetingParticipantRow(updated) }
  })
}

export async function auditMeetingParticipantMuted(
  db: Kysely<Database>,
  input: { organizationId: string; participantId: string; actorUserId: string }
): Promise<void> {
  await withTenantTransaction(db, input.organizationId, async (trx) => {
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.participant.muted',
      'meeting_participant',
      input.participantId
    )
  })
}
