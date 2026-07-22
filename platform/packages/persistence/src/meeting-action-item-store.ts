import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { auditMeetingEvent, emitMeetingResourceChange } from './meeting-resource-events'
import { withTenantTransaction } from './tenant-transaction'
import { createWorkItemTx, type WorkItemPriority } from './work-item-store'

export type MeetingActionItemStatus =
  | 'proposed'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'cancelled'

export type MeetingActionItemResource = {
  id: string
  organizationId: string
  meetingId: string
  minutesId: string | null
  task: string
  assigneeUserId: string | null
  assigneeLabel: string | null
  dueAt: string | null
  dueText: string | null
  priority: WorkItemPriority
  status: MeetingActionItemStatus
  projectId: string | null
  ticketId: string | null
  workItemId: string | null
  evidenceSegmentId: string | null
  createdBy: 'ai' | 'user'
  reviewStatus: 'unreviewed' | 'approved' | 'rejected'
  reviewedBy: string | null
  reviewedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type ActionItemRow = {
  id: string
  organization_id: string
  meeting_id: string
  minutes_id: string | null
  task: string
  assignee_user_id: string | null
  assignee_label: string | null
  due_at: Date | string | null
  due_text: string | null
  priority: string
  status: string
  project_id: string | null
  ticket_id: string | null
  work_item_id: string | null
  evidence_segment_id: string | null
  created_by: string
  review_status: string
  reviewed_by: string | null
  reviewed_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapActionItem(row: ActionItemRow): MeetingActionItemResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    minutesId: row.minutes_id,
    task: row.task,
    assigneeUserId: row.assignee_user_id,
    assigneeLabel: row.assignee_label,
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
    dueText: row.due_text,
    priority: row.priority as WorkItemPriority,
    status: row.status as MeetingActionItemStatus,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    workItemId: row.work_item_id,
    evidenceSegmentId: row.evidence_segment_id,
    createdBy: row.created_by as 'ai' | 'user',
    reviewStatus: row.review_status as 'unreviewed' | 'approved' | 'rejected',
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

function parsedDueAt(value: string | null): Date | null {
  if (!value) return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null
}

export async function insertAiMeetingActionItems(
  trx: Transaction<Database>,
  input: {
    organizationId: string
    meetingId: string
    minutesId: string
    items: Array<{
      task: string
      owner: string | null
      due: string | null
      evidenceSegmentId: string | null
    }>
  }
): Promise<void> {
  const items = input.items.filter((item) => item.task.trim())
  if (items.length === 0) return
  await trx
    .insertInto('meetings.action_items')
    .values(
      items.map((item) => ({
        organization_id: input.organizationId,
        meeting_id: input.meetingId,
        minutes_id: input.minutesId,
        task: item.task.trim(),
        assignee_label: item.owner?.trim() || null,
        due_at: parsedDueAt(item.due),
        due_text: item.due?.trim() || null,
        evidence_segment_id: item.evidenceSegmentId,
        created_by: 'ai'
      }))
    )
    .execute()
}

export async function listMeetingActionItems(
  db: Kysely<Database>,
  organizationId: string,
  meetingId: string
): Promise<MeetingActionItemResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('meetings.action_items')
      .selectAll()
      .where('meeting_id', '=', meetingId)
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    return rows.map(mapActionItem)
  })
}

export async function getMeetingActionItem(
  db: Kysely<Database>,
  organizationId: string,
  actionItemId: string
): Promise<MeetingActionItemResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('meetings.action_items')
      .selectAll()
      .where('id', '=', actionItemId)
      .executeTakeFirst()
    return row ? mapActionItem(row) : null
  })
}

type ActionMutationFailure = {
  ok: false
  reason: 'not_found' | 'version_conflict' | 'evidence_not_found' | 'empty' | 'already_converted'
}

type ActionMutationResult =
  | { ok: true; actionItem: MeetingActionItemResource }
  | ActionMutationFailure

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

export async function updateMeetingActionItem(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actionItemId: string
    actorUserId: string
    expectedVersion: number
    task: string
    assigneeUserId?: string | null
    dueAt?: string | null
    priority?: WorkItemPriority
    evidenceSegmentId?: string | null
  }
): Promise<ActionMutationResult> {
  const task = input.task.trim()
  if (!task) return { ok: false, reason: 'empty' }
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.action_items')
      .selectAll()
      .where('id', '=', input.actionItemId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict' }
    }
    if (current.work_item_id) return { ok: false, reason: 'already_converted' }
    const evidenceSegmentId = input.evidenceSegmentId ?? current.evidence_segment_id
    if (!(await matchingEvidence(trx, current.meeting_id, evidenceSegmentId))) {
      return { ok: false, reason: 'evidence_not_found' }
    }
    const version = input.expectedVersion + 1
    const updated = await trx
      .updateTable('meetings.action_items')
      .set({
        task,
        assignee_user_id: input.assigneeUserId ?? null,
        due_at: parsedDueAt(input.dueAt ?? null),
        due_text: input.dueAt ?? null,
        priority: input.priority ?? (current.priority as WorkItemPriority),
        evidence_segment_id: evidenceSegmentId,
        status: 'proposed',
        review_status: 'unreviewed',
        reviewed_by: null,
        reviewed_at: null,
        version,
        updated_at: sql`now()`
      })
      .where('id', '=', input.actionItemId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.action_item.updated',
      'meeting_action_item',
      input.actionItemId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_action_item',
      input.actionItemId,
      version,
      'updated'
    )
    return { ok: true, actionItem: mapActionItem(updated) }
  })
}

export async function reviewMeetingActionItem(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actionItemId: string
    actorUserId: string
    expectedVersion: number
    decision: 'approve' | 'reject'
  }
): Promise<ActionMutationResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.action_items')
      .selectAll()
      .where('id', '=', input.actionItemId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict' }
    }
    if (current.work_item_id) return { ok: false, reason: 'already_converted' }
    const version = input.expectedVersion + 1
    const updated = await trx
      .updateTable('meetings.action_items')
      .set({
        status: input.decision === 'approve' ? 'accepted' : 'cancelled',
        review_status: input.decision === 'approve' ? 'approved' : 'rejected',
        reviewed_by: input.actorUserId,
        reviewed_at: sql`now()`,
        version,
        updated_at: sql`now()`
      })
      .where('id', '=', input.actionItemId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `meeting.action_item.review.${input.decision}`,
      'meeting_action_item',
      input.actionItemId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_action_item',
      input.actionItemId,
      version,
      'updated'
    )
    return { ok: true, actionItem: mapActionItem(updated) }
  })
}

export type ConvertMeetingActionItemResult =
  | { ok: true; actionItem: MeetingActionItemResource; workItemIdentifier: string }
  | {
      ok: false
      reason:
        | ActionMutationFailure['reason']
        | 'review_required'
        | 'team_not_found'
        | 'invalid_state'
        | 'project_not_found'
    }

export async function convertMeetingActionItemToWorkItem(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actionItemId: string
    actorUserId: string
    expectedVersion: number
    teamId: string
    projectId?: string | null
  }
): Promise<ConvertMeetingActionItemResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('meetings.action_items')
      .selectAll()
      .where('id', '=', input.actionItemId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict' }
    }
    if (current.work_item_id) return { ok: false, reason: 'already_converted' }
    if (current.review_status !== 'approved') return { ok: false, reason: 'review_required' }
    const created = await createWorkItemTx(trx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      teamId: input.teamId,
      projectId: input.projectId ?? current.project_id,
      title: current.task.slice(0, 500),
      description: `Created from meeting action item ${current.id} in meeting ${current.meeting_id}.`,
      priority: current.priority as WorkItemPriority,
      // Why: a converted action without an explicit owner must still appear in
      // the converter's My Work projection immediately.
      assigneeId: current.assignee_user_id ?? input.actorUserId
    })
    if (!created.ok) return created
    const version = input.expectedVersion + 1
    const updated = await trx
      .updateTable('meetings.action_items')
      .set({
        work_item_id: created.workItem.id,
        project_id: input.projectId ?? current.project_id,
        version,
        updated_at: sql`now()`
      })
      .where('id', '=', input.actionItemId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditMeetingEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'meeting.action_item.converted',
      'meeting_action_item',
      input.actionItemId
    )
    await emitMeetingResourceChange(
      trx,
      input.organizationId,
      'meeting_action_item',
      input.actionItemId,
      version,
      'updated'
    )
    return {
      ok: true,
      actionItem: mapActionItem(updated),
      workItemIdentifier: created.workItem.identifier
    }
  })
}
