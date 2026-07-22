import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  MEETING_CORE_CAPTURE_TYPES,
  type MeetingCaptureType
} from './meeting-capture-consent-store'
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
  stoppedAt: string | null
  errorCode: string | null
  captureTypes: MeetingCaptureType[]
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingRecordingRow = {
  id: string
  organization_id: string
  meeting_id: string
  object_ref: string | null
  status: string
  duration_seconds: number | null
  started_at: Date | string
  video_egress_id: string | null
  audio_egress_id: string | null
  transcription_dispatch_id: string | null
  stopped_at: Date | string | null
  error_code: string | null
  capture_types: string[]
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapMeetingRecordingRow(row: MeetingRecordingRow): MeetingRecordingResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    objectRef: row.object_ref,
    status: row.status as RecordingStatus,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    startedAt: new Date(row.started_at).toISOString(),
    stoppedAt: row.stopped_at ? new Date(row.stopped_at).toISOString() : null,
    errorCode: row.error_code,
    captureTypes: row.capture_types as MeetingCaptureType[],
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

async function meetingStatus(
  trx: Transaction<Database>,
  meetingId: string
): Promise<string | null> {
  const row = await trx
    .selectFrom('meetings.meetings')
    .select('status')
    .where('id', '=', meetingId)
    .forUpdate()
    .executeTakeFirst()
  return row?.status ?? null
}

async function joinedParticipantConsentState(
  trx: Transaction<Database>,
  meetingId: string,
  captureTypes: readonly MeetingCaptureType[]
): Promise<'empty' | 'consented' | 'missing_consent'> {
  const participants = await trx
    .selectFrom('meetings.participants')
    .select('id')
    .where('meeting_id', '=', meetingId)
    .where('joined_at', 'is not', null)
    .where('left_at', 'is', null)
    .execute()
  if (participants.length === 0) return 'empty'
  const governance = await trx
    .selectFrom('meetings.governance')
    .select('policy_version')
    .where('meeting_id', '=', meetingId)
    .executeTakeFirst()
  if (!governance) return 'missing_consent'
  const consents = await trx
    .selectFrom('meetings.capture_consents')
    .select(['participant_id', 'capture_type'])
    .where(
      'participant_id',
      'in',
      participants.map((participant) => participant.id)
    )
    .where('capture_type', 'in', [...captureTypes])
    .where('policy_version', '=', governance.policy_version)
    .where('status', '=', 'granted')
    .where((expression) =>
      expression.or([
        expression('expires_at', 'is', null),
        expression('expires_at', '>', sql<Date>`now()`)
      ])
    )
    .execute()
  return consents.length === participants.length * captureTypes.length
    ? 'consented'
    : 'missing_consent'
}

export type StartRecordingResult =
  | { ok: true; recording: MeetingRecordingResource }
  | { ok: false; reason: 'meeting_not_found' }
  | { ok: false; reason: 'meeting_not_live' }
  | { ok: false; reason: 'no_joined_participants' }
  | { ok: false; reason: 'consent_required' }
  | { ok: false; reason: 'active_recording' }

export type StartRecordingInput = {
  organizationId: string
  actorUserId: string
  meetingId: string
  captureTypes?: readonly MeetingCaptureType[]
}

/** Starts a recording (status='pending') — REFUSED unless every joined participant has consented. */
export async function startMeetingRecording(
  db: Kysely<Database>,
  input: StartRecordingInput
): Promise<StartRecordingResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const captureTypes = input.captureTypes ?? MEETING_CORE_CAPTURE_TYPES
    const status = await meetingStatus(trx, input.meetingId)
    if (!status) {
      return { ok: false, reason: 'meeting_not_found' }
    }
    if (status !== 'live') return { ok: false, reason: 'meeting_not_live' }
    const active = await trx
      .selectFrom('meetings.recordings')
      .select('id')
      .where('meeting_id', '=', input.meetingId)
      .where('status', '=', 'pending')
      .where('stopped_at', 'is', null)
      .executeTakeFirst()
    if (active) return { ok: false, reason: 'active_recording' }
    const consentState = await joinedParticipantConsentState(trx, input.meetingId, captureTypes)
    if (consentState === 'empty') {
      return { ok: false, reason: 'no_joined_participants' }
    }
    if (consentState === 'missing_consent') {
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
        capture_types: [...captureTypes],
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
    return { ok: true, recording: mapMeetingRecordingRow(row) }
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
    return { ok: true, recording: mapMeetingRecordingRow(updated) }
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
    return row ? mapMeetingRecordingRow(row) : null
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
    return rows.map(mapMeetingRecordingRow)
  })
}
