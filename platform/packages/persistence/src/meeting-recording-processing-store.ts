import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import {
  mapMeetingRecordingRow,
  type MeetingRecordingResource,
  type MeetingRecordingRow
} from './meeting-recording-store'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

export type MeetingRecordingControlState = MeetingRecordingResource & {
  videoEgressId: string | null
  audioEgressId: string | null
  transcriptionDispatchId: string | null
}

function mapControlState(row: MeetingRecordingRow): MeetingRecordingControlState {
  return {
    ...mapMeetingRecordingRow(row),
    videoEgressId: row.video_egress_id,
    audioEgressId: row.audio_egress_id,
    transcriptionDispatchId: row.transcription_dispatch_id
  }
}

export async function attachMeetingRecordingMedia(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    recordingId: string
    expectedVersion: number
    videoEgressId: string
    audioEgressId: string | null
    transcriptionDispatchId: string | null
  }
): Promise<MeetingRecordingResource | null> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const updated = await trx
      .updateTable('meetings.recordings')
      .set({
        video_egress_id: input.videoEgressId,
        audio_egress_id: input.audioEgressId,
        transcription_dispatch_id: input.transcriptionDispatchId,
        version: input.expectedVersion + 1,
        updated_at: sql`now()`
      })
      .where('id', '=', input.recordingId)
      .where('status', '=', 'pending')
      .where('version', '=', String(input.expectedVersion))
      .returningAll()
      .executeTakeFirst()
    if (!updated) return null
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.recording.media_attached',
      'meeting_recording',
      input.recordingId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_recording',
      input.recordingId,
      input.expectedVersion + 1,
      'updated'
    )
    return mapMeetingRecordingRow(updated)
  })
}

export async function failMeetingRecordingStart(
  db: Kysely<Database>,
  input: { organizationId: string; actorUserId: string; recordingId: string; errorCode: string }
): Promise<void> {
  await withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.recordings')
      .select(['status', 'version'])
      .where('id', '=', input.recordingId)
      .forUpdate()
      .executeTakeFirst()
    if (!current || current.status !== 'pending') return
    const version = Number(current.version) + 1
    await trx
      .updateTable('meetings.recordings')
      .set({ status: 'failed', error_code: input.errorCode, version, updated_at: sql`now()` })
      .where('id', '=', input.recordingId)
      .execute()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.recording.start_failed',
      'meeting_recording',
      input.recordingId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_recording',
      input.recordingId,
      version,
      'updated'
    )
  })
}

export async function markMeetingRecordingStopped(
  db: Kysely<Database>,
  input: { organizationId: string; actorUserId: string; recordingId: string }
): Promise<MeetingRecordingResource | null> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.recordings')
      .selectAll()
      .where('id', '=', input.recordingId)
      .forUpdate()
      .executeTakeFirst()
    if (!current || current.status !== 'pending') return null
    if (current.stopped_at) return mapMeetingRecordingRow(current)
    const version = Number(current.version) + 1
    const updated = await trx
      .updateTable('meetings.recordings')
      .set({ stopped_at: sql`now()`, version, updated_at: sql`now()` })
      .where('id', '=', input.recordingId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.recording.stop_requested',
      'meeting_recording',
      input.recordingId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_recording',
      input.recordingId,
      version,
      'updated'
    )
    return mapMeetingRecordingRow(updated)
  })
}

export async function getMeetingRecordingControlState(
  db: Kysely<Database>,
  organizationId: string,
  recordingId: string
): Promise<MeetingRecordingControlState | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.recordings')
      .selectAll()
      .where('id', '=', recordingId)
      .executeTakeFirst()
    return row ? mapControlState(row) : null
  })
}

export async function listActiveMeetingRecordingControlStates(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingRecordingControlState[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.recordings')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .where('status', '=', 'pending')
      .where('stopped_at', 'is', null)
      .execute()
    return rows.map(mapControlState)
  })
}

export type ApplyMeetingEgressEndedResult =
  | { outcome: 'duplicate' | 'recording_not_found' }
  | { outcome: 'updated'; recording: MeetingRecordingResource; output: 'video' | 'audio' }

export async function applyMeetingEgressEnded(
  db: Kysely<Database>,
  input: {
    organizationId: string
    meetingId: string
    eventId: string
    egressId: string
    succeeded: boolean
    durationSeconds: number
    errorCode: string | null
    occurredAt: string
  }
): Promise<ApplyMeetingEgressEndedResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const delivery = await trx
      .insertInto('meetings.media_events')
      .values({
        organization_id: input.organizationId,
        event_id: input.eventId,
        meeting_id: input.meetingId,
        event_type: 'egress_ended',
        occurred_at: input.occurredAt
      })
      .onConflict((conflict) => conflict.columns(['organization_id', 'event_id']).doNothing())
      .returning('event_id')
      .executeTakeFirst()
    if (!delivery) return { outcome: 'duplicate' }

    const row = await trx
      .selectFrom('meetings.recordings')
      .selectAll()
      .where((expression) =>
        expression.or([
          expression('video_egress_id', '=', input.egressId),
          expression('audio_egress_id', '=', input.egressId)
        ])
      )
      .forUpdate()
      .executeTakeFirst()
    if (!row) return { outcome: 'recording_not_found' }
    const output = row.video_egress_id === input.egressId ? 'video' : 'audio'
    const version = Number(row.version) + 1
    const videoChanges =
      output === 'video'
        ? input.succeeded
          ? {
              object_ref: row.id,
              duration_seconds: Math.max(0, Math.round(input.durationSeconds)),
              status: 'available',
              stopped_at: row.stopped_at ?? input.occurredAt,
              error_code: null
            }
          : {
              status: 'failed',
              stopped_at: row.stopped_at ?? input.occurredAt,
              error_code: input.errorCode ?? 'VIDEO_EGRESS_FAILED'
            }
        : input.succeeded
          ? {}
          : { error_code: input.errorCode ?? 'TRANSCRIPTION_AUDIO_EGRESS_FAILED' }
    const updated = await trx
      .updateTable('meetings.recordings')
      .set({ ...videoChanges, version, updated_at: sql`now()` })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow()

    if (output === 'audio' && input.succeeded && row.capture_types.includes('transcription')) {
      await trx
        .insertInto('meetings.processing_jobs')
        .values({
          organization_id: input.organizationId,
          meeting_id: input.meetingId,
          recording_id: row.id,
          job_type: 'transcribe'
        })
        .onConflict((conflict) =>
          conflict.columns(['organization_id', 'recording_id', 'job_type']).doNothing()
        )
        .execute()
    }
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.organizationId,
      `meeting.recording.${output}_egress_ended`,
      'meeting_recording',
      row.id
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_recording',
      row.id,
      version,
      'updated'
    )
    return { outcome: 'updated', recording: mapMeetingRecordingRow(updated), output }
  })
}
