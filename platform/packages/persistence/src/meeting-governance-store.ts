import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import type { MeetingCaptureType } from './meeting-capture-consent-store'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

export type MeetingCaptureStatus = 'idle' | 'active' | 'paused' | 'stopped'
export type MeetingDeletionStatus = 'active' | 'queued' | 'processing' | 'completed' | 'failed'

export type MeetingGovernanceResource = {
  meetingId: string
  organizationId: string
  policyVersion: number
  purpose: string
  retentionDays: number | null
  retentionUntil: string | null
  legalHold: boolean
  captureStatus: MeetingCaptureStatus
  activeCaptureTypes: MeetingCaptureType[]
  deletionStatus: MeetingDeletionStatus
  deletionRequestedAt: string | null
  deletionRequestedBy: string | null
  deletionReason: string | null
  deletionCompletedAt: string | null
  deletionAttempts: number
  deletionLastError: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type MeetingGovernanceRow = {
  organization_id: string
  meeting_id: string
  policy_version: string | number
  purpose: string
  retention_days: number | null
  retention_until: Date | string | null
  legal_hold: boolean
  capture_status: string
  active_capture_types: string[]
  deletion_status: string
  deletion_requested_at: Date | string | null
  deletion_requested_by: string | null
  deletion_reason: string | null
  deletion_completed_at: Date | string | null
  deletion_attempts: number
  deletion_last_error: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function isoOrNull(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null
}

export function mapMeetingGovernanceRow(row: MeetingGovernanceRow): MeetingGovernanceResource {
  return {
    meetingId: row.meeting_id,
    organizationId: row.organization_id,
    policyVersion: Number(row.policy_version),
    purpose: row.purpose,
    retentionDays: row.retention_days,
    retentionUntil: isoOrNull(row.retention_until),
    legalHold: row.legal_hold,
    captureStatus: row.capture_status as MeetingCaptureStatus,
    activeCaptureTypes: row.active_capture_types as MeetingCaptureType[],
    deletionStatus: row.deletion_status as MeetingDeletionStatus,
    deletionRequestedAt: isoOrNull(row.deletion_requested_at),
    deletionRequestedBy: row.deletion_requested_by,
    deletionReason: row.deletion_reason,
    deletionCompletedAt: isoOrNull(row.deletion_completed_at),
    deletionAttempts: row.deletion_attempts,
    deletionLastError: row.deletion_last_error,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export async function insertMeetingGovernance(
  trx: Transaction<Database>,
  input: { organizationId: string; meetingId: string }
): Promise<void> {
  await trx
    .insertInto('meetings.governance')
    .values({ organization_id: input.organizationId, meeting_id: input.meetingId })
    .onConflict((conflict) => conflict.columns(['organization_id', 'meeting_id']).doNothing())
    .execute()
}

export async function getMeetingGovernance(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingGovernanceResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.governance')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .executeTakeFirst()
    return row ? mapMeetingGovernanceRow(row) : null
  })
}

export type UpdateMeetingGovernanceResult =
  | { ok: true; governance: MeetingGovernanceResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export async function updateMeetingGovernance(
  db: Kysely<Database>,
  input: {
    organizationId: string
    meetingId: string
    actorUserId: string
    expectedVersion: number
    purpose?: string
    retentionDays?: number | null
    legalHold?: boolean
  }
): Promise<UpdateMeetingGovernanceResult> {
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
    const meeting = await trx
      .selectFrom('meetings.meetings')
      .select('status')
      .where('id', '=', input.meetingId)
      .executeTakeFirstOrThrow()
    const retentionDays =
      input.retentionDays === undefined ? current.retention_days : input.retentionDays
    const retentionUntil =
      meeting.status === 'ended' || meeting.status === 'cancelled'
        ? retentionDays === null
          ? null
          : new Date(Date.now() + retentionDays * 86_400_000)
        : current.retention_until
    const version = currentVersion + 1
    const updated = await trx
      .updateTable('meetings.governance')
      .set({
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        ...(input.retentionDays === undefined ? {} : { retention_days: input.retentionDays }),
        ...(input.legalHold === undefined ? {} : { legal_hold: input.legalHold }),
        retention_until: retentionUntil,
        policy_version: sql`policy_version + 1`,
        ...(input.legalHold === true && current.deletion_status !== 'completed'
          ? {
              deletion_status: 'active',
              deletion_available_at: null,
              deletion_leased_until: null,
              deletion_worker_id: null
            }
          : {}),
        version,
        updated_at: sql`now()`
      })
      .where('meeting_id', '=', input.meetingId)
      .returningAll()
      .executeTakeFirstOrThrow()
    const participants = await trx
      .updateTable('meetings.participants')
      .set({ consent_recording: false, version: sql`version + 1`, updated_at: sql`now()` })
      .where('meeting_id', '=', input.meetingId)
      .returning(['id', 'version'])
      .execute()
    for (const participant of participants) {
      await emitMeetingResourceChange(
        trx,
        input.organizationId,
        'meeting_participant',
        participant.id,
        Number(participant.version),
        'updated'
      )
    }
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.governance.updated',
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

export async function scheduleMeetingRetentionOnEnd(
  trx: Transaction<Database>,
  input: { organizationId: string; meetingId: string; actorUserId: string }
): Promise<void> {
  const current = await trx
    .selectFrom('meetings.governance')
    .selectAll()
    .where('meeting_id', '=', input.meetingId)
    .forUpdate()
    .executeTakeFirst()
  if (!current) return
  const version = Number(current.version) + 1
  await trx
    .updateTable('meetings.governance')
    .set({
      retention_until:
        current.retention_days === null
          ? null
          : new Date(Date.now() + current.retention_days * 86_400_000),
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
    input.actorUserId,
    'meeting.retention.scheduled',
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
}

export async function setMeetingCaptureStatus(
  db: Kysely<Database>,
  input: {
    organizationId: string
    meetingId: string
    actorUserId: string
    status: MeetingCaptureStatus
    captureTypes?: readonly MeetingCaptureType[]
  }
): Promise<MeetingGovernanceResource | null> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.governance')
      .selectAll()
      .where('meeting_id', '=', input.meetingId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return null
    const version = Number(current.version) + 1
    const updated = await trx
      .updateTable('meetings.governance')
      .set({
        capture_status: input.status,
        ...(input.captureTypes ? { active_capture_types: [...input.captureTypes] } : {}),
        version,
        updated_at: sql`now()`
      })
      .where('meeting_id', '=', input.meetingId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `meeting.capture.${input.status}`,
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
    return mapMeetingGovernanceRow(updated)
  })
}

export type MeetingGovernanceAuditEntry = {
  id: string
  actorId: string | null
  action: string
  occurredAt: string
}

export async function listMeetingGovernanceAudit(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingGovernanceAuditEntry[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('audit.audit_events')
      .select(['id', 'actor_id', 'action', 'occurred_at'])
      .where('target_type', '=', 'meeting_governance')
      .where('target_id', '=', meetingId)
      .orderBy('occurred_at', 'desc')
      .limit(200)
      .execute()
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      occurredAt: new Date(row.occurred_at).toISOString()
    }))
  })
}

export async function auditMeetingGovernanceExport(
  db: Kysely<Database>,
  input: { organizationId: string; meetingId: string; actorUserId: string }
): Promise<void> {
  await withTenantTransaction(db, input.organizationId, async (trx) => {
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.governance.exported',
      'meeting_governance',
      input.meetingId
    )
  })
}
