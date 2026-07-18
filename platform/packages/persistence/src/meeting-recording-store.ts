import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R7 MEETINGS — recording references. The media upload itself is infra (object_ref is an OPAQUE storage
// object id). THE load-bearing gate: recording-needs-consent — a recording may not START unless every
// currently-joined participant has granted recording consent (the 녹화 동의). An ungated start is
// refused (route → 422 CONSENT_REQUIRED) and audited.

export type RecordingStatus = 'pending' | 'available' | 'failed'

export type MeetingRecordingResource = {
  id: string
  organizationId: string
  meetingId: string
  objectRef: string | null
  status: RecordingStatus
  durationSeconds: number | null
  startedAt: string
  version: number
  createdAt: string
  updatedAt: string
}

type RecordingRow = {
  id: string
  organization_id: string
  meeting_id: string
  object_ref: string | null
  status: string
  duration_seconds: number | null
  started_at: Date | string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapRecording(row: RecordingRow): MeetingRecordingResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    objectRef: row.object_ref,
    status: row.status as RecordingStatus,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    startedAt: new Date(row.started_at).toISOString(),
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

// recording-needs-consent: true only when no currently-joined participant (joined_at set, left_at null)
// is missing consent_recording. Vacuously true if there are no joined participants.
async function everyJoinedParticipantConsented(
  trx: Transaction<Database>,
  meetingId: string
): Promise<boolean> {
  const dissenter = await trx
    .selectFrom('meetings.participants')
    .select('id')
    .where('meeting_id', '=', meetingId)
    .where('joined_at', 'is not', null)
    .where('left_at', 'is', null)
    .where('consent_recording', '=', false)
    .executeTakeFirst()
  return !dissenter
}

export type StartRecordingResult =
  | { ok: true; recording: MeetingRecordingResource }
  | { ok: false; reason: 'meeting_not_found' }
  | { ok: false; reason: 'consent_required' }

export type StartRecordingInput = {
  organizationId: string
  actorUserId: string
  meetingId: string
}

/** Starts a recording (status='pending') — REFUSED unless every joined participant has consented. */
export async function startMeetingRecording(
  db: Kysely<Database>,
  input: StartRecordingInput
): Promise<StartRecordingResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    if (!(await meetingExists(trx, input.meetingId))) {
      return { ok: false, reason: 'meeting_not_found' }
    }
    if (!(await everyJoinedParticipantConsented(trx, input.meetingId))) {
      // recording-needs-consent: refuse to start and audit the refusal.
      await auditMeetingEvent(
        trx,
        input.organizationId,
        input.actorUserId,
        'meeting.recording.start_refused',
        'meeting_recording',
        input.meetingId
      )
      return { ok: false, reason: 'consent_required' }
    }
    const row = await trx
      .insertInto('meetings.recordings')
      .values({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        status: 'pending',
        started_at: sql`now()`
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.recording.started',
      'meeting_recording',
      row.id
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_recording',
      row.id,
      1,
      'created'
    )
    return { ok: true, recording: mapRecording(row) }
  })
}

export type FinalizeRecordingResult =
  | { ok: true; recording: MeetingRecordingResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'not_pending'; from: RecordingStatus }

export type FinalizeRecordingInput = {
  organizationId: string
  actorUserId: string
  recordingId: string
  expectedVersion: number
  objectRef: string
  durationSeconds: number
  failed?: boolean
}

/** Finalizes a pending recording: attaches the object_ref + duration and marks it available (or failed). */
export async function finalizeMeetingRecording(
  db: Kysely<Database>,
  input: FinalizeRecordingInput
): Promise<FinalizeRecordingResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.recordings')
      .selectAll()
      .where('id', '=', input.recordingId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as RecordingStatus
    if (from !== 'pending') {
      return { ok: false, reason: 'not_pending', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('meetings.recordings')
      .set({
        object_ref: input.objectRef,
        duration_seconds: input.durationSeconds,
        status: input.failed ? 'failed' : 'available',
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.recordingId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.recording.finalized',
      'meeting_recording',
      input.recordingId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_recording',
      input.recordingId,
      newVersion,
      'updated'
    )
    return { ok: true, recording: mapRecording(updated) }
  })
}

export async function getMeetingRecording(
  db: Kysely<Database>,
  organizationId: string,
  recordingId: string
): Promise<MeetingRecordingResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.recordings')
      .selectAll()
      .where('id', '=', recordingId)
      .executeTakeFirst()
    return row ? mapRecording(row) : null
  })
}

export async function listMeetingRecordings(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingRecordingResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.recordings')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapRecording)
  })
}
