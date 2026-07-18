import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R7 MEETINGS — AI/human meeting minutes. THE exit condition lives here: a source_type='ai' minutes row
// cannot be FINALIZED while unreviewed (route → 422 MINUTES_REVIEW_REQUIRED). Human approval is a
// precondition, never a substitute — "모델 출력이 승인을 대체하지 않는다" (doc 14 §R7). Mirrors the
// knowledge-article publish gate.

export type MinutesSourceType = 'manual' | 'ai'
export type MinutesReviewStatus = 'unreviewed' | 'approved' | 'rejected'
export type MinutesStatus = 'draft' | 'finalized'

export type MeetingMinutesResource = {
  id: string
  organizationId: string
  meetingId: string
  summary: string
  sourceType: MinutesSourceType
  reviewStatus: MinutesReviewStatus
  reviewedBy: string | null
  reviewedAt: string | null
  status: MinutesStatus
  authorUserId: string
  version: number
  createdAt: string
  updatedAt: string
}

// AI-authored minutes may be finalized only once approved. The single predicate the finalize gate
// consults: human approval is a precondition, not a substitute.
export function isMinutesFinalizable(
  sourceType: MinutesSourceType,
  reviewStatus: MinutesReviewStatus
): boolean {
  return sourceType !== 'ai' || reviewStatus === 'approved'
}

type MinutesRow = {
  id: string
  organization_id: string
  meeting_id: string
  summary: string
  source_type: string
  review_status: string
  reviewed_by: string | null
  reviewed_at: Date | string | null
  status: string
  author_user_id: string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapMinutes(row: MinutesRow): MeetingMinutesResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    summary: row.summary,
    sourceType: row.source_type as MinutesSourceType,
    reviewStatus: row.review_status as MinutesReviewStatus,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    status: row.status as MinutesStatus,
    authorUserId: row.author_user_id,
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

export type CreateMinutesResult =
  | { ok: true; minutes: MeetingMinutesResource }
  | { ok: false; reason: 'meeting_not_found' }

export type CreateMinutesInput = {
  organizationId: string
  actorUserId: string
  meetingId: string
  summary: string
  sourceType?: MinutesSourceType
}

/** Creates minutes in status='draft', review_status='unreviewed'. */
export async function createMeetingMinutes(
  db: Kysely<Database>,
  input: CreateMinutesInput
): Promise<CreateMinutesResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    if (!(await meetingExists(trx, input.meetingId))) {
      return { ok: false, reason: 'meeting_not_found' }
    }
    const row = await trx
      .insertInto('meetings.minutes')
      .values({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        summary: input.summary,
        source_type: input.sourceType ?? 'manual',
        review_status: 'unreviewed',
        status: 'draft',
        author_user_id: input.actorUserId
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.minutes.created',
      'meeting_minutes',
      row.id
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_minutes',
      row.id,
      1,
      'created'
    )
    return { ok: true, minutes: mapMinutes(row) }
  })
}

export async function getMeetingMinutes(
  db: Kysely<Database>,
  organizationId: string,
  minutesId: string
): Promise<MeetingMinutesResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.minutes')
      .selectAll()
      .where('id', '=', minutesId)
      .executeTakeFirst()
    return row ? mapMinutes(row) : null
  })
}

export async function listMeetingMinutes(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingMinutesResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.minutes')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapMinutes)
  })
}

export type MinutesReviewDecision = 'approve' | 'reject'

export type ReviewMinutesResult =
  | { ok: true; minutes: MeetingMinutesResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export type ReviewMinutesInput = {
  organizationId: string
  actorUserId: string
  minutesId: string
  expectedVersion: number
  decision: MinutesReviewDecision
}

/**
 * Records a human review verdict on minutes under OCC — the reviewer and time are stamped. Approving
 * AI minutes is what unlocks finalize; review is a separate act so approval is auditable to a named
 * reviewer, not the model.
 */
export async function reviewMeetingMinutes(
  db: Kysely<Database>,
  input: ReviewMinutesInput
): Promise<ReviewMinutesResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.minutes')
      .selectAll()
      .where('id', '=', input.minutesId)
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
      .updateTable('meetings.minutes')
      .set({
        review_status: input.decision === 'approve' ? 'approved' : 'rejected',
        reviewed_by: input.actorUserId,
        reviewed_at: sql`now()`,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.minutesId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `meeting.minutes.review.${input.decision}`,
      'meeting_minutes',
      input.minutesId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_minutes',
      input.minutesId,
      newVersion,
      'updated'
    )
    return { ok: true, minutes: mapMinutes(updated) }
  })
}

export type FinalizeMinutesResult =
  | { ok: true; minutes: MeetingMinutesResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: MinutesStatus }
  // THE exit condition: unreviewed AI minutes cannot be finalized (route → 422 MINUTES_REVIEW_REQUIRED).
  | { ok: false; reason: 'review_required' }

export type FinalizeMinutesInput = {
  organizationId: string
  actorUserId: string
  minutesId: string
  expectedVersion: number
}

/** Finalizes draft minutes under OCC — AI minutes are refused unless human-approved. */
export async function finalizeMeetingMinutes(
  db: Kysely<Database>,
  input: FinalizeMinutesInput
): Promise<FinalizeMinutesResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.minutes')
      .selectAll()
      .where('id', '=', input.minutesId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as MinutesStatus
    if (from !== 'draft') {
      return { ok: false, reason: 'illegal_transition', from }
    }
    if (
      !isMinutesFinalizable(
        current.source_type as MinutesSourceType,
        current.review_status as MinutesReviewStatus
      )
    ) {
      // ai-minutes-need-review: refuse to finalize unreviewed AI minutes, and audit.
      await auditMeetingEvent(
        trx,
        input.organizationId,
        input.actorUserId,
        'meeting.minutes.finalize_refused',
        'meeting_minutes',
        input.minutesId
      )
      return { ok: false, reason: 'review_required' }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('meetings.minutes')
      .set({ status: 'finalized', version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.minutesId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.minutes.finalized',
      'meeting_minutes',
      input.minutesId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_minutes',
      input.minutesId,
      newVersion,
      'updated'
    )
    return { ok: true, minutes: mapMinutes(updated) }
  })
}
