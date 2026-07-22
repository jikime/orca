import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { mapMeetingGovernanceRow, type MeetingGovernanceResource } from './meeting-governance-store'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction, withWorkerClaimTransaction } from './tenant-transaction'

export type RequestMeetingDeletionResult =
  | { ok: true; governance: MeetingGovernanceResource }
  | { ok: false; reason: 'not_found' | 'legal_hold' | 'meeting_live' | 'already_deleted' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export async function requestMeetingDeletion(
  db: Kysely<Database>,
  input: {
    organizationId: string
    meetingId: string
    actorUserId: string
    expectedVersion: number
    reason: string
  }
): Promise<RequestMeetingDeletionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.governance')
      .selectAll()
      .where('meeting_id', '=', input.meetingId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    if (current.legal_hold) return { ok: false, reason: 'legal_hold' }
    if (current.deletion_status === 'completed') return { ok: false, reason: 'already_deleted' }
    const meeting = await trx
      .selectFrom('meetings.meetings')
      .select('status')
      .where('id', '=', input.meetingId)
      .executeTakeFirst()
    if (!meeting) return { ok: false, reason: 'not_found' }
    if (meeting.status === 'live') return { ok: false, reason: 'meeting_live' }
    const now = new Date()
    const version = currentVersion + 1
    const updated = await trx
      .updateTable('meetings.governance')
      .set({
        deletion_status: 'queued',
        deletion_requested_at: now,
        deletion_requested_by: input.actorUserId,
        deletion_reason: input.reason,
        deletion_available_at: now,
        deletion_leased_until: null,
        deletion_worker_id: null,
        deletion_last_error: null,
        version,
        updated_at: now
      })
      .where('meeting_id', '=', input.meetingId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.deletion.requested',
      'meeting_governance',
      input.meetingId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_governance',
      input.meetingId,
      version,
      'updated'
    )
    return { ok: true, governance: mapMeetingGovernanceRow(updated) }
  })
}

export type ClaimedMeetingDeletion = {
  organizationId: string
  meetingId: string
  workerId: string
  attempts: number
}

export async function claimMeetingDeletions(
  db: Kysely<Database>,
  input: { workerId: string; batchSize: number; leaseMs: number }
): Promise<ClaimedMeetingDeletion[]> {
  return withWorkerClaimTransaction(db, async (trx) => {
    const due = await trx
      .selectFrom('meetings.governance')
      .select(['organization_id', 'meeting_id'])
      .where('legal_hold', '=', false)
      .where((expression) =>
        expression.or([
          expression.and([
            expression('deletion_status', '=', 'active'),
            expression('retention_until', 'is not', null),
            expression('retention_until', '<=', sql<Date>`now()`)
          ]),
          expression.and([
            expression('deletion_status', 'in', ['queued', 'failed']),
            expression('deletion_available_at', '<=', sql<Date>`now()`)
          ]),
          expression.and([
            expression('deletion_status', '=', 'processing'),
            expression('deletion_leased_until', '<=', sql<Date>`now()`)
          ])
        ])
      )
      .orderBy('retention_until')
      .orderBy('meeting_id')
      .limit(input.batchSize)
      .forUpdate()
      .skipLocked()
      .execute()
    if (due.length === 0) return []
    const leasedUntil = new Date(Date.now() + input.leaseMs)
    const claimed: ClaimedMeetingDeletion[] = []
    for (const item of due) {
      const row = await trx
        .updateTable('meetings.governance')
        .set({
          deletion_status: 'processing',
          deletion_attempts: sql`deletion_attempts + 1`,
          deletion_worker_id: input.workerId,
          deletion_leased_until: leasedUntil,
          updated_at: sql`now()`
        })
        .where('organization_id', '=', item.organization_id)
        .where('meeting_id', '=', item.meeting_id)
        .returning(['organization_id', 'meeting_id', 'deletion_attempts'])
        .executeTakeFirstOrThrow()
      claimed.push({
        organizationId: row.organization_id,
        meetingId: row.meeting_id,
        workerId: input.workerId,
        attempts: row.deletion_attempts
      })
    }
    return claimed
  })
}

export type MeetingDeletionObjects = {
  recordingObjectIds: string[]
  transcriptionObjectIds: string[]
}

export async function listMeetingDeletionObjects(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingDeletionObjects> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const recordings = await trx
      .selectFrom('meetings.recordings')
      .select(['id', 'object_ref'])
      .where('meeting_id', '=', meetingId)
      .execute()
    return {
      recordingObjectIds: [
        ...new Set(
          recordings.flatMap((recording) => [recording.id, recording.object_ref].filter(Boolean))
        )
      ] as string[],
      transcriptionObjectIds: recordings.map((recording) => recording.id)
    }
  })
}

export async function completeMeetingDeletion(
  db: Kysely<Database>,
  input: { organizationId: string; meetingId: string; workerId: string }
): Promise<boolean> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const governance = await trx
      .selectFrom('meetings.governance')
      .selectAll()
      .where('meeting_id', '=', input.meetingId)
      .forUpdate()
      .executeTakeFirst()
    if (
      !governance ||
      governance.legal_hold ||
      governance.deletion_status !== 'processing' ||
      governance.deletion_worker_id !== input.workerId
    ) {
      return false
    }
    await trx
      .deleteFrom('meetings.processing_jobs')
      .where('meeting_id', '=', input.meetingId)
      .execute()
    await trx.deleteFrom('meetings.decisions').where('meeting_id', '=', input.meetingId).execute()
    await trx
      .deleteFrom('meetings.action_items')
      .where('meeting_id', '=', input.meetingId)
      .execute()
    const minutes = await trx
      .selectFrom('meetings.minutes')
      .select('id')
      .where('meeting_id', '=', input.meetingId)
      .execute()
    const minuteIds = minutes.map((item) => item.id)
    if (minuteIds.length > 0) {
      await trx
        .deleteFrom('meetings.minute_revisions')
        .where('minutes_id', 'in', minuteIds)
        .execute()
    }
    await trx.deleteFrom('meetings.minutes').where('meeting_id', '=', input.meetingId).execute()
    await trx.deleteFrom('meetings.transcripts').where('meeting_id', '=', input.meetingId).execute()
    await trx.deleteFrom('meetings.recordings').where('meeting_id', '=', input.meetingId).execute()
    await trx
      .deleteFrom('meetings.media_events')
      .where('meeting_id', '=', input.meetingId)
      .execute()
    const version = Number(governance.version) + 1
    await trx
      .updateTable('meetings.governance')
      .set({
        deletion_status: 'completed',
        deletion_completed_at: sql`now()`,
        deletion_leased_until: null,
        deletion_worker_id: null,
        deletion_last_error: null,
        capture_status: 'stopped',
        active_capture_types: [],
        version,
        updated_at: sql`now()`
      })
      .where('meeting_id', '=', input.meetingId)
      .execute()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      governance.deletion_requested_by,
      'meeting.deletion.completed',
      'meeting_governance',
      input.meetingId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_governance',
      input.meetingId,
      version,
      'updated'
    )
    return true
  })
}

export async function requeueMeetingDeletion(
  db: Kysely<Database>,
  input: {
    organizationId: string
    meetingId: string
    workerId: string
    error: string
    retryAt: Date
    terminal: boolean
  }
): Promise<void> {
  await withTenantTransaction(db, input.organizationId, async (trx) => {
    await trx
      .updateTable('meetings.governance')
      .set({
        deletion_status: 'failed',
        deletion_available_at: input.terminal ? null : input.retryAt,
        deletion_leased_until: null,
        deletion_worker_id: null,
        deletion_last_error: input.error.slice(0, 2000),
        updated_at: sql`now()`
      })
      .where('meeting_id', '=', input.meetingId)
      .where('deletion_status', '=', 'processing')
      .where('deletion_worker_id', '=', input.workerId)
      .execute()
  })
}
