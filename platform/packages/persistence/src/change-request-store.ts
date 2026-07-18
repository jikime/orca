import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { buildResourceChangeCloudEvent } from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

// PROJECT-EXECUTION change requests. A scope/schedule/cost change proposed WHILE a project runs,
// gated on customer approval. The load-bearing exit condition "승인 전 실행을 제한한다" lives in
// applyChangeRequest: a request that is not 'approved' cannot be :applied (the execution step).

export type ChangeRequestStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'applied'

export type ChangeRequestResource = {
  id: string
  organizationId: string
  projectId: string
  wbsNodeId: string | null
  requirementId: string | null
  title: string
  description: string | null
  status: ChangeRequestStatus
  scopeDelta: string | null
  scheduleDeltaDays: number | null
  costDelta: string | null
  requestedBy: string | null
  approverUserId: string | null
  decidedAt: string | null
  appliedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

// A change request is APPLICABLE only when approved. The single predicate the execution gate
// consults — no change is applied to a running project before the customer approves it.
export function isChangeRequestApplicable(status: ChangeRequestStatus): boolean {
  return status === 'approved'
}

type ChangeRequestRow = {
  id: string
  organization_id: string
  project_id: string
  wbs_node_id: string | null
  requirement_id: string | null
  title: string
  description: string | null
  status: string
  scope_delta: string | null
  schedule_delta_days: number | null
  cost_delta: string | number | null
  requested_by: string | null
  approver_user_id: string | null
  decided_at: Date | string | null
  applied_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapChangeRequest(row: ChangeRequestRow): ChangeRequestResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    wbsNodeId: row.wbs_node_id,
    requirementId: row.requirement_id,
    title: row.title,
    description: row.description,
    status: row.status as ChangeRequestStatus,
    scopeDelta: row.scope_delta,
    scheduleDeltaDays: row.schedule_delta_days,
    costDelta: row.cost_delta === null ? null : String(row.cost_delta),
    requestedBy: row.requested_by,
    approverUserId: row.approver_user_id,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

async function emitChangeRequestEvent(
  trx: Transaction<Database>,
  organizationId: string,
  changeRequestId: string,
  version: number,
  changeKind: 'created' | 'updated'
): Promise<void> {
  const outboxId = randomUUID()
  const occurredAt = new Date().toISOString()
  const cloudEvent = buildResourceChangeCloudEvent({
    organizationId,
    eventId: outboxId,
    resourceType: 'change_request',
    resourceId: changeRequestId,
    changeKind,
    version,
    occurredAt
  })
  await trx
    .insertInto('operations.outbox_events')
    .values({
      id: outboxId,
      organization_id: organizationId,
      aggregate_type: 'change_request',
      aggregate_id: changeRequestId,
      aggregate_version: version,
      event_type: cloudEvent.type,
      event_schema_version: 1,
      payload: JSON.stringify(cloudEvent),
      occurred_at: occurredAt,
      available_at: occurredAt
    })
    .execute()
}

async function audit(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string,
  action: string,
  changeRequestId: string
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorUserId,
      action,
      target_type: 'change_request',
      target_id: changeRequestId
    })
    .execute()
}

export type CreateChangeRequestInput = {
  organizationId: string
  actorUserId: string
  projectId: string
  title: string
  description?: string | null
  scopeDelta?: string | null
  scheduleDeltaDays?: number | null
  costDelta?: number | string | null
  wbsNodeId?: string | null
  requirementId?: string | null
}

/**
 * Creates a change request in status='draft'. A draft is inert — it must pass
 * submit → approve before :apply can execute it against the running project.
 */
export async function createChangeRequest(
  db: Kysely<Database>,
  input: CreateChangeRequestInput
): Promise<ChangeRequestResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('change.change_requests')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        wbs_node_id: input.wbsNodeId ?? null,
        requirement_id: input.requirementId ?? null,
        title: input.title,
        description: input.description ?? null,
        status: 'draft',
        scope_delta: input.scopeDelta ?? null,
        schedule_delta_days: input.scheduleDeltaDays ?? null,
        cost_delta: input.costDelta ?? null,
        requested_by: input.actorUserId
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(trx, input.organizationId, input.actorUserId, 'change.request.created', row.id)
    await emitChangeRequestEvent(trx, input.organizationId, row.id, 1, 'created')
    return mapChangeRequest(row)
  })
}

export async function getChangeRequest(
  db: Kysely<Database>,
  organizationId: string,
  changeRequestId: string
): Promise<ChangeRequestResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('change.change_requests')
      .selectAll()
      .where('id', '=', changeRequestId)
      .executeTakeFirst()
    return row ? mapChangeRequest(row) : null
  })
}

export type ChangeRequestPage = { items: ChangeRequestResource[]; nextCursor: string | null }

export async function listChangeRequestsByProject(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<ChangeRequestPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('change.change_requests')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapChangeRequest), nextCursor }
  })
}

export type UpdateChangeRequestResult =
  | { ok: true; changeRequest: ChangeRequestResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  // Only a draft may be edited — a submitted/decided request is frozen.
  | { ok: false; reason: 'not_editable'; from: ChangeRequestStatus }

export type UpdateChangeRequestInput = {
  organizationId: string
  changeRequestId: string
  actorUserId: string
  expectedVersion: number
  title?: string
  description?: string | null
  scopeDelta?: string | null
  scheduleDeltaDays?: number | null
  costDelta?: number | string | null
  wbsNodeId?: string | null
  requirementId?: string | null
}

/** Edits a draft change request under OCC. Refused once the request has left draft. */
export async function updateChangeRequest(
  db: Kysely<Database>,
  input: UpdateChangeRequestInput
): Promise<UpdateChangeRequestResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('change.change_requests')
      .selectAll()
      .where('id', '=', input.changeRequestId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as ChangeRequestStatus
    if (from !== 'draft') {
      return { ok: false, reason: 'not_editable', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('change.change_requests')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.scopeDelta === undefined ? {} : { scope_delta: input.scopeDelta }),
        ...(input.scheduleDeltaDays === undefined
          ? {}
          : { schedule_delta_days: input.scheduleDeltaDays }),
        ...(input.costDelta === undefined ? {} : { cost_delta: input.costDelta }),
        ...(input.wbsNodeId === undefined ? {} : { wbs_node_id: input.wbsNodeId }),
        ...(input.requirementId === undefined ? {} : { requirement_id: input.requirementId })
      })
      .where('id', '=', input.changeRequestId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(trx, input.organizationId, input.actorUserId, 'change.request.updated', updated.id)
    await emitChangeRequestEvent(trx, input.organizationId, updated.id, newVersion, 'updated')
    return { ok: true, changeRequest: mapChangeRequest(updated) }
  })
}

export type ChangeRequestTransitionResult =
  | { ok: true; changeRequest: ChangeRequestResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: ChangeRequestStatus }
  // The exit condition: :apply is refused before approval.
  | { ok: false; reason: 'not_approved'; status: ChangeRequestStatus }

export type ChangeRequestAction = 'submit-for-approval' | 'approve' | 'reject' | 'apply'

type TransitionInput = {
  organizationId: string
  changeRequestId: string
  actorUserId: string
  expectedVersion: number
}

// Legal status edges: draft → submitted (submit); submitted → approved|rejected (the customer
// decision, records approver + decided_at); approved → applied (execution, records applied_at).
const LEGAL_FROM: Record<ChangeRequestAction, ChangeRequestStatus> = {
  'submit-for-approval': 'draft',
  approve: 'submitted',
  reject: 'submitted',
  apply: 'approved'
}

const TO_STATUS: Record<ChangeRequestAction, ChangeRequestStatus> = {
  'submit-for-approval': 'submitted',
  approve: 'approved',
  reject: 'rejected',
  apply: 'applied'
}

async function transitionChangeRequest(
  db: Kysely<Database>,
  action: ChangeRequestAction,
  input: TransitionInput
): Promise<ChangeRequestTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('change.change_requests')
      .selectAll()
      .where('id', '=', input.changeRequestId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as ChangeRequestStatus
    if (from !== LEGAL_FROM[action]) {
      if (action === 'apply' && !isChangeRequestApplicable(from)) {
        // pre-approval-execution-gate: refuse to execute a change that is not approved, and audit.
        await audit(
          trx,
          input.organizationId,
          input.actorUserId,
          'change.request.apply_refused',
          input.changeRequestId
        )
        return { ok: false, reason: 'not_approved', status: from }
      }
      return { ok: false, reason: 'illegal_transition', from }
    }
    const newVersion = currentVersion + 1
    const isDecision = action === 'approve' || action === 'reject'
    const updated = await trx
      .updateTable('change.change_requests')
      .set({
        status: TO_STATUS[action],
        version: newVersion,
        updated_at: sql`now()`,
        // Record WHO decided and WHEN so the approver (≠ requester) is auditable.
        ...(isDecision ? { approver_user_id: input.actorUserId, decided_at: sql`now()` } : {}),
        ...(action === 'apply' ? { applied_at: sql`now()` } : {})
      })
      .where('id', '=', input.changeRequestId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      `change.request.${action === 'submit-for-approval' ? 'submit' : action}`,
      input.changeRequestId
    )
    await emitChangeRequestEvent(
      trx,
      input.organizationId,
      input.changeRequestId,
      newVersion,
      'updated'
    )
    return { ok: true, changeRequest: mapChangeRequest(updated) }
  })
}

export function submitChangeRequestForApproval(
  db: Kysely<Database>,
  input: TransitionInput
): Promise<ChangeRequestTransitionResult> {
  return transitionChangeRequest(db, 'submit-for-approval', input)
}

export function approveChangeRequest(
  db: Kysely<Database>,
  input: TransitionInput
): Promise<ChangeRequestTransitionResult> {
  return transitionChangeRequest(db, 'approve', input)
}

export function rejectChangeRequest(
  db: Kysely<Database>,
  input: TransitionInput
): Promise<ChangeRequestTransitionResult> {
  return transitionChangeRequest(db, 'reject', input)
}

// The EXECUTION STEP. Applying an approved change into the running project. Gated: a non-approved
// change request is refused with 'not_approved' (route → 422 CHANGE_NOT_APPROVED) — the
// "승인 전 실행 제한" exit condition.
export function applyChangeRequest(
  db: Kysely<Database>,
  input: TransitionInput
): Promise<ChangeRequestTransitionResult> {
  return transitionChangeRequest(db, 'apply', input)
}
