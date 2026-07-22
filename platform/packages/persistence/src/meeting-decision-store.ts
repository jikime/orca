import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

export type MeetingDecisionStatus = 'proposed' | 'confirmed' | 'superseded' | 'rejected'
export type MeetingOutcomeReviewStatus = 'unreviewed' | 'approved' | 'rejected'

export type MeetingDecisionResource = {
  id: string
  organizationId: string
  meetingId: string
  minutesId: string | null
  statement: string
  status: MeetingDecisionStatus
  ownerUserId: string | null
  projectId: string | null
  ticketId: string | null
  evidenceSegmentId: string | null
  createdBy: 'ai' | 'user'
  reviewStatus: MeetingOutcomeReviewStatus
  reviewedBy: string | null
  reviewedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type DecisionRow = {
  id: string
  organization_id: string
  meeting_id: string
  minutes_id: string | null
  statement: string
  status: string
  owner_user_id: string | null
  project_id: string | null
  ticket_id: string | null
  evidence_segment_id: string | null
  created_by: string
  review_status: string
  reviewed_by: string | null
  reviewed_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapDecision(row: DecisionRow): MeetingDecisionResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    minutesId: row.minutes_id,
    statement: row.statement,
    status: row.status as MeetingDecisionStatus,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    evidenceSegmentId: row.evidence_segment_id,
    createdBy: row.created_by as 'ai' | 'user',
    reviewStatus: row.review_status as MeetingOutcomeReviewStatus,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export async function insertAiMeetingDecisions(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    meetingId: string
    minutesId: string
    items: Array<{ statement: string; evidenceSegmentId: string | null }>
  }
): Promise<void> {
  const items = input.items.filter((item) => item.statement.trim())
  if (items.length === 0) return
  await trx
    .insertInto('meetings.decisions')
    .values(
      items.map((item) => ({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        minutes_id: input.minutesId,
        statement: item.statement.trim(),
        evidence_segment_id: item.evidenceSegmentId,
        created_by: 'ai'
      }))
    )
    .execute()
}

export async function listMeetingDecisions(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingDecisionResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.decisions')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    return rows.map(mapDecision)
  })
}

export async function getMeetingDecision(
  db: Kysely<Database>,
  organizationId: string,
  decisionId: string
): Promise<MeetingDecisionResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.decisions')
      .selectAll()
      .where('id', '=', decisionId)
      .executeTakeFirst()
    return row ? mapDecision(row) : null
  })
}

type DecisionMutationResult =
  | { ok: true; decision: MeetingDecisionResource }
  | { ok: false; reason: 'not_found' | 'version_conflict' | 'evidence_not_found' | 'empty' }

async function matchingEvidence(
  trx: Transaction<Database>,
  meetingId: string,
  segmentId: string | null
): Promise<boolean> {
  if (!segmentId) return true
  const row = await trx
    .selectFrom('meetings.transcript_segments')
    .select('id')
    .where('id', '=', segmentId)
    .where('meeting_id', '=', meetingId)
    .executeTakeFirst()
  return Boolean(row)
}

export async function updateMeetingDecision(
  db: Kysely<Database>,
  input: {
    organizationId: string
    decisionId: string
    actorUserId: string
    expectedVersion: number
    statement: string
    ownerUserId?: string | null
    evidenceSegmentId?: string | null
  }
): Promise<DecisionMutationResult> {
  const statement = input.statement.trim()
  if (!statement) return { ok: false, reason: 'empty' }
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.decisions')
      .selectAll()
      .where('id', '=', input.decisionId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict' }
    }
    const evidenceSegmentId = input.evidenceSegmentId ?? current.evidence_segment_id
    if (!(await matchingEvidence(trx, current.meeting_id, evidenceSegmentId))) {
      return { ok: false, reason: 'evidence_not_found' }
    }
    const version = input.expectedVersion + 1
    const updated = await trx
      .updateTable('meetings.decisions')
      .set({
        statement,
        owner_user_id: input.ownerUserId ?? null,
        evidence_segment_id: evidenceSegmentId,
        status: 'proposed',
        review_status: 'unreviewed',
        reviewed_by: null,
        reviewed_at: null,
        version,
        updated_at: sql`now()`
      })
      .where('id', '=', input.decisionId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.decision.updated',
      'meeting_decision',
      input.decisionId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_decision',
      input.decisionId,
      version,
      'updated'
    )
    return { ok: true, decision: mapDecision(updated) }
  })
}

export async function reviewMeetingDecision(
  db: Kysely<Database>,
  input: {
    organizationId: string
    decisionId: string
    actorUserId: string
    expectedVersion: number
    decision: 'approve' | 'reject'
  }
): Promise<DecisionMutationResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.decisions')
      .selectAll()
      .where('id', '=', input.decisionId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict' }
    }
    const version = input.expectedVersion + 1
    const updated = await trx
      .updateTable('meetings.decisions')
      .set({
        status: input.decision === 'approve' ? 'confirmed' : 'rejected',
        review_status: input.decision === 'approve' ? 'approved' : 'rejected',
        reviewed_by: input.actorUserId,
        reviewed_at: sql`now()`,
        version,
        updated_at: sql`now()`
      })
      .where('id', '=', input.decisionId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `meeting.decision.review.${input.decision}`,
      'meeting_decision',
      input.decisionId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_decision',
      input.decisionId,
      version,
      'updated'
    )
    return { ok: true, decision: mapDecision(updated) }
  })
}
