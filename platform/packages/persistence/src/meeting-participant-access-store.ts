import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  mapMeetingParticipantRow,
  type MeetingParticipantResource,
  type MeetingParticipantRole
} from './meeting-participant-store'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

export type RequestMeetingAdmissionResult =
  | { ok: true; participant: MeetingParticipantResource }
  | { ok: false; reason: 'not_found' | 'participant_user_mismatch' }

export async function requestMeetingParticipantAdmission(
  db: Kysely<Database>,
  input: { organizationId: string; participantId: string; actorUserId: string }
): Promise<RequestMeetingAdmissionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.participants')
      .selectAll()
      .where('id', '=', input.participantId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (current.user_id !== input.actorUserId) {
      // Waiting-room requests are personal and cannot be submitted for another user.
      return { ok: false, reason: 'participant_user_mismatch' }
    }
    if (current.access_status !== 'invited') {
      return { ok: true, participant: mapMeetingParticipantRow(current) }
    }
    const version = Number(current.version) + 1
    const updated = await trx
      .updateTable('meetings.participants')
      .set({ access_status: 'waiting', version, updated_at: sql`now()` })
      .where('id', '=', input.participantId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await recordParticipantChange(trx, {
      ...input,
      action: 'meeting.participant.admission_requested',
      version
    })
    return { ok: true, participant: mapMeetingParticipantRow(updated) }
  })
}

export type SetMeetingParticipantAccessResult =
  | { ok: true; participant: MeetingParticipantResource }
  | { ok: false; reason: 'not_found' | 'host_protected' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export async function setMeetingParticipantAccess(
  db: Kysely<Database>,
  input: {
    organizationId: string
    participantId: string
    actorUserId: string
    expectedVersion: number
    accessStatus: 'admitted' | 'denied'
  }
): Promise<SetMeetingParticipantAccessResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.participants')
      .selectAll()
      .where('id', '=', input.participantId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (current.role === 'host') return { ok: false, reason: 'host_protected' }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    if (current.access_status === input.accessStatus) {
      return { ok: true, participant: mapMeetingParticipantRow(current) }
    }
    const version = currentVersion + 1
    const updated = await trx
      .updateTable('meetings.participants')
      .set({
        access_status: input.accessStatus,
        ...(input.accessStatus === 'denied' ? { left_at: sql`now()` } : {}),
        version,
        updated_at: sql`now()`
      })
      .where('id', '=', input.participantId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await recordParticipantChange(trx, {
      ...input,
      action:
        input.accessStatus === 'admitted'
          ? 'meeting.participant.admitted'
          : 'meeting.participant.denied',
      version
    })
    return { ok: true, participant: mapMeetingParticipantRow(updated) }
  })
}

export type SetMeetingParticipantRoleResult =
  | { ok: true; participant: MeetingParticipantResource }
  | { ok: false; reason: 'not_found' | 'host_protected' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export async function setMeetingParticipantRole(
  db: Kysely<Database>,
  input: {
    organizationId: string
    participantId: string
    actorUserId: string
    expectedVersion: number
    role: Exclude<MeetingParticipantRole, 'host'>
  }
): Promise<SetMeetingParticipantRoleResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.participants')
      .selectAll()
      .where('id', '=', input.participantId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (current.role === 'host') return { ok: false, reason: 'host_protected' }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    if (current.role === input.role) {
      return { ok: true, participant: mapMeetingParticipantRow(current) }
    }
    const version = currentVersion + 1
    const updated = await trx
      .updateTable('meetings.participants')
      .set({ role: input.role, version, updated_at: sql`now()` })
      .where('id', '=', input.participantId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await recordParticipantChange(trx, {
      ...input,
      action: 'meeting.participant.role_changed',
      version
    })
    return { ok: true, participant: mapMeetingParticipantRow(updated) }
  })
}

async function recordParticipantChange(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    participantId: string
    actorUserId: string
    action: string
    version: number
  }
): Promise<void> {
  await auditMeetingEvent(
    trx,
    input.organizationId,
    input.actorUserId,
    input.action,
    'meeting_participant',
    input.participantId
  )
  await emitMeetingResourceChange(
    trx,
    input.organizationId,
    'meeting_participant',
    input.participantId,
    input.version,
    'updated'
  )
}
