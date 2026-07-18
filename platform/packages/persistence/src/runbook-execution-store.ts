import { sql, type Kysely, type Transaction } from 'kysely'
import { auditAutomationEvent, emitAutomationResourceChange } from './automation-resource-events'
import type { Database } from './database-schema'
import { getRunbook } from './runbook-store'
import { withTenantTransaction } from './tenant-transaction'

// A single RUN of a runbook. The load-bearing R7 gate lives here: an execution of an
// approval-required runbook is created in 'pending_approval' and :run is refused until an approver
// moves it to 'approved' (run-requires-approval). Every transition audits, so target, approval,
// result, and rollback all land in the audit trail.

export type RunbookExecutionStatus =
  | 'pending_approval'
  | 'approved'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rolled_back'
  | 'rejected'

export type RunbookExecutionResource = {
  id: string
  organizationId: string
  runbookId: string
  targetId: string
  targetKind: string
  status: RunbookExecutionStatus
  requestedBy: string | null
  approverUserId: string | null
  approvedAt: string | null
  result: unknown | null
  rollbackOfExecutionId: string | null
  startedAt: string | null
  finishedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type RunbookExecutionRow = {
  id: string
  organization_id: string
  runbook_id: string
  target_id: string
  target_kind: string
  status: string
  requested_by: string | null
  approver_user_id: string | null
  approved_at: Date | string | null
  result: unknown | null
  rollback_of_execution_id: string | null
  started_at: Date | string | null
  finished_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapExecution(row: RunbookExecutionRow): RunbookExecutionResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    runbookId: row.runbook_id,
    targetId: row.target_id,
    targetKind: row.target_kind,
    status: row.status as RunbookExecutionStatus,
    requestedBy: row.requested_by,
    approverUserId: row.approver_user_id,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    result: row.result ?? null,
    rollbackOfExecutionId: row.rollback_of_execution_id,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateRunbookExecutionResult =
  | { ok: true; execution: RunbookExecutionResource }
  | { ok: false; reason: 'runbook_not_found' }

export type CreateRunbookExecutionInput = {
  organizationId: string
  actorUserId: string
  runbookId: string
  targetId: string
  targetKind: string
}

/**
 * Opens a run of a runbook against a target. If the runbook requires approval the run is created in
 * 'pending_approval' (inert until approved); otherwise it opens 'approved' and may :run at once. The
 * target is recorded on the row and the request is audited.
 */
export async function createRunbookExecution(
  db: Kysely<Database>,
  input: CreateRunbookExecutionInput
): Promise<CreateRunbookExecutionResult> {
  const runbook = await getRunbook(db, input.organizationId, input.runbookId)
  if (!runbook) {
    return { ok: false, reason: 'runbook_not_found' }
  }
  const initialStatus: RunbookExecutionStatus = runbook.requiresApproval
    ? 'pending_approval'
    : 'approved'
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('automation.runbook_executions')
      .values({
        organization_id: input.organizationId,
        runbook_id: input.runbookId,
        target_id: input.targetId,
        target_kind: input.targetKind,
        status: initialStatus,
        requested_by: input.actorUserId
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditAutomationEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'automation.runbook.execution.requested',
      'runbook_execution',
      row.id
    )
    await emitAutomationResourceChange(
      trx,
      input.organizationId,
      'runbook_execution',
      row.id,
      1,
      'created'
    )
    return { ok: true, execution: mapExecution(row) }
  })
}

export async function getRunbookExecution(
  db: Kysely<Database>,
  organizationId: string,
  executionId: string
): Promise<RunbookExecutionResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('automation.runbook_executions')
      .selectAll()
      .where('id', '=', executionId)
      .executeTakeFirst()
    return row ? mapExecution(row) : null
  })
}

export type RunbookExecutionPage = {
  items: RunbookExecutionResource[]
  nextCursor: string | null
}

export async function listRunbookExecutions(
  db: Kysely<Database>,
  organizationId: string,
  runbookId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<RunbookExecutionPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('automation.runbook_executions')
      .selectAll()
      .where('runbook_id', '=', runbookId)
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapExecution), nextCursor }
  })
}

export type RunbookExecutionAction = 'approve' | 'reject' | 'run' | 'complete'

export type RunbookExecutionTransitionResult =
  | { ok: true; execution: RunbookExecutionResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: RunbookExecutionStatus }
  // The exit condition: :run is refused before approval.
  | { ok: false; reason: 'not_approved'; status: RunbookExecutionStatus }

export type RunbookExecutionTransitionInput = {
  organizationId: string
  executionId: string
  actorUserId: string
  expectedVersion: number
  result?: unknown
}

// Legal status edges: pending_approval → approved|rejected (the approval decision, records approver +
// approved_at); approved → running (:run, records started_at); running → completed (records result +
// finished_at). A :run from any un-approved state is refused (not_approved).
const LEGAL_FROM: Record<RunbookExecutionAction, RunbookExecutionStatus> = {
  approve: 'pending_approval',
  reject: 'pending_approval',
  run: 'approved',
  complete: 'running'
}

const TO_STATUS: Record<RunbookExecutionAction, RunbookExecutionStatus> = {
  approve: 'approved',
  reject: 'rejected',
  run: 'running',
  complete: 'completed'
}

// States a run has never been approved out of — a :run here is the gated refusal, not a mis-ordered
// transition, so it maps to 422 RUNBOOK_NOT_APPROVED.
function isUnapprovedForRun(status: RunbookExecutionStatus): boolean {
  return status === 'pending_approval' || status === 'rejected'
}

const AUDIT_ACTION: Record<RunbookExecutionAction, string> = {
  approve: 'automation.runbook.execution.approved',
  reject: 'automation.runbook.execution.rejected',
  run: 'automation.runbook.execution.ran',
  complete: 'automation.runbook.execution.completed'
}

async function transitionExecution(
  db: Kysely<Database>,
  action: RunbookExecutionAction,
  input: RunbookExecutionTransitionInput
): Promise<RunbookExecutionTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('automation.runbook_executions')
      .selectAll()
      .where('id', '=', input.executionId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as RunbookExecutionStatus
    if (from !== LEGAL_FROM[action]) {
      if (action === 'run' && isUnapprovedForRun(from)) {
        // run-requires-approval: refuse to run an unapproved execution, and audit the refusal.
        await auditAutomationEvent(
          trx,
          input.organizationId,
          input.actorUserId,
          'automation.runbook.execution.run_refused',
          'runbook_execution',
          input.executionId
        )
        return { ok: false, reason: 'not_approved', status: from }
      }
      return { ok: false, reason: 'illegal_transition', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('automation.runbook_executions')
      .set({
        status: TO_STATUS[action],
        version: newVersion,
        updated_at: sql`now()`,
        // Record WHO approved and WHEN so the approver (≠ requester) is auditable.
        ...(action === 'approve'
          ? { approver_user_id: input.actorUserId, approved_at: sql`now()` }
          : {}),
        ...(action === 'run' ? { started_at: sql`now()` } : {}),
        ...(action === 'complete'
          ? { finished_at: sql`now()`, result: JSON.stringify(input.result ?? {}) }
          : {})
      })
      .where('id', '=', input.executionId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditAutomationEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      AUDIT_ACTION[action],
      'runbook_execution',
      input.executionId
    )
    await emitAutomationResourceChange(
      trx,
      input.organizationId,
      'runbook_execution',
      input.executionId,
      newVersion,
      'updated'
    )
    return { ok: true, execution: mapExecution(updated) }
  })
}

export function approveRunbookExecution(
  db: Kysely<Database>,
  input: RunbookExecutionTransitionInput
): Promise<RunbookExecutionTransitionResult> {
  return transitionExecution(db, 'approve', input)
}

export function rejectRunbookExecution(
  db: Kysely<Database>,
  input: RunbookExecutionTransitionInput
): Promise<RunbookExecutionTransitionResult> {
  return transitionExecution(db, 'reject', input)
}

// THE approval gate: moving approved → running. A pending_approval/rejected execution is refused
// with 'not_approved' (route → 422 RUNBOOK_NOT_APPROVED) — the R7 exit condition.
export function runRunbookExecution(
  db: Kysely<Database>,
  input: RunbookExecutionTransitionInput
): Promise<RunbookExecutionTransitionResult> {
  return transitionExecution(db, 'run', input)
}

export function completeRunbookExecution(
  db: Kysely<Database>,
  input: RunbookExecutionTransitionInput
): Promise<RunbookExecutionTransitionResult> {
  return transitionExecution(db, 'complete', input)
}

export type RollbackRunbookExecutionResult =
  | { ok: true; execution: RunbookExecutionResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  // Only a completed run can be rolled back.
  | { ok: false; reason: 'illegal_transition'; from: RunbookExecutionStatus }

export type RollbackRunbookExecutionInput = {
  organizationId: string
  executionId: string
  actorUserId: string
  expectedVersion: number
}

/**
 * Rolls back a completed execution. rollback-is-new-execution: rather than mutating history, this
 * creates a NEW execution row (status 'rolled_back') whose rollback_of_execution_id references the
 * original run it reverses — the AUDITED rollback (mirrors the governance decision-log's superseding
 * row). Returns the new compensating execution.
 */
export async function rollbackRunbookExecution(
  db: Kysely<Database>,
  input: RollbackRunbookExecutionInput
): Promise<RollbackRunbookExecutionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const original = await trx
      .selectFrom('automation.runbook_executions')
      .selectAll()
      .where('id', '=', input.executionId)
      .forUpdate()
      .executeTakeFirst()
    if (!original) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(original.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = original.status as RunbookExecutionStatus
    if (from !== 'completed') {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const rollback = await createRollbackRow(trx, input, original)
    await auditAutomationEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'automation.runbook.execution.rolled_back',
      'runbook_execution',
      rollback.id
    )
    await emitAutomationResourceChange(
      trx,
      input.organizationId,
      'runbook_execution',
      rollback.id,
      1,
      'created'
    )
    return { ok: true, execution: mapExecution(rollback) }
  })
}

async function createRollbackRow(
  trx: Transaction<Database>,
  input: RollbackRunbookExecutionInput,
  original: RunbookExecutionRow
): Promise<RunbookExecutionRow> {
  return trx
    .insertInto('automation.runbook_executions')
    .values({
      organization_id: input.organizationId,
      runbook_id: original.runbook_id,
      target_id: original.target_id,
      target_kind: original.target_kind,
      status: 'rolled_back',
      requested_by: input.actorUserId,
      rollback_of_execution_id: original.id,
      started_at: sql`now()`,
      finished_at: sql`now()`,
      result: JSON.stringify({ rolledBackExecutionId: original.id })
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}
