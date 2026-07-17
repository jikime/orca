import type { Kysely, Transaction } from 'kysely'
import { emitAgentExecutionChange, loadAgentSessionTx } from './agent-session-store'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// R5 slice 4b: the unassigned-session INTAKE queue (doc 19 :162, doc 24 CAP-001). A session that
// exists without a work_item binding lands here; a human then EXPLICITLY assigns it (which is the
// only path that sets session.work_item_id). The server never auto-attaches a session to a
// project — CAP-001's mitigation is exactly this queue + explicit binding.

export type IntakeSourceType = 'unassigned_agent_session'
export type IntakeStatus = 'pending' | 'assigned' | 'dismissed'
export type IntakeDetectedReason = 'no_work_item' | 'binding_failed' | 'started_outside_app'

export type AgentSessionIntake = {
  id: string
  organizationId: string
  agentSessionId: string
  sourceType: IntakeSourceType
  status: IntakeStatus
  detectedReason: IntakeDetectedReason
  hostId: string
  workspaceId: string | null
  provider: string
  workItemId: string | null
  assignedBy: string | null
  assignedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type IntakeRow = {
  id: string
  organization_id: string
  agent_session_id: string
  source_type: string
  status: string
  detected_reason: string
  host_id: string
  workspace_id: string | null
  provider: string
  work_item_id: string | null
  assigned_by: string | null
  assigned_at: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapAgentSessionIntake(row: IntakeRow): AgentSessionIntake {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentSessionId: row.agent_session_id,
    sourceType: row.source_type as IntakeSourceType,
    status: row.status as IntakeStatus,
    detectedReason: row.detected_reason as IntakeDetectedReason,
    hostId: row.host_id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    workItemId: row.work_item_id,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at ? new Date(row.assigned_at).toISOString() : null,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type EnsurePendingIntakeInput = {
  agentSessionId: string
  hostId: string
  provider: string
  workspaceId?: string | null
  detectedReason?: IntakeDetectedReason
}

/**
 * Ensures EXACTLY ONE pending intake row exists for an unbound session, inside the caller's
 * tenant tx (session-create or event ingest). Idempotent: the (org, agent_session_id) UNIQUE key
 * + ON CONFLICT DO NOTHING means a replayed event or a repeated create never spawns a second
 * intake row. CAP-001: the caller only invokes this when the session has NO work_item — a bound
 * session is never queued, and this never binds the session to anything (assign does that).
 * Emits an agent_session_intake `created` invalidation and returns the new row, or null if one
 * already existed.
 */
export async function ensurePendingIntakeTx(
  trx: Transaction<Database>,
  organizationId: string,
  input: EnsurePendingIntakeInput
): Promise<AgentSessionIntake | null> {
  const inserted = await trx
    .insertInto('execution.agent_session_intake')
    .values({
      organization_id: organizationId,
      agent_session_id: input.agentSessionId,
      source_type: 'unassigned_agent_session',
      status: 'pending',
      detected_reason: input.detectedReason ?? 'no_work_item',
      host_id: input.hostId,
      workspace_id: input.workspaceId ?? null,
      provider: input.provider
    })
    .onConflict((oc) => oc.columns(['organization_id', 'agent_session_id']).doNothing())
    .returningAll()
    .executeTakeFirst()
  if (!inserted) {
    return null
  }
  const intake = mapAgentSessionIntake(inserted)
  await emitAgentExecutionChange(
    trx,
    organizationId,
    'agent_session_intake',
    intake.id,
    intake.version,
    'created'
  )
  return intake
}

async function writeIntakeAudit(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string,
  action: 'assigned' | 'reclassified' | 'dismissed',
  intakeId: string,
  afterDigest: string
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorUserId,
      action: `agent_session_intake.${action}`,
      target_type: 'agent_session_intake',
      target_id: intakeId,
      after_digest: afterDigest
    })
    .execute()
}

async function loadIntakeTx(
  trx: Transaction<Database>,
  intakeId: string
): Promise<AgentSessionIntake | null> {
  const row = await trx
    .selectFrom('execution.agent_session_intake')
    .selectAll()
    .where('id', '=', intakeId)
    .executeTakeFirst()
  return row ? mapAgentSessionIntake(row) : null
}

export type AssignIntakeResult =
  | { ok: true; intake: AgentSessionIntake }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'already_terminal'; status: IntakeStatus }

/**
 * EXPLICITLY binds the queued session to a work item (doc 24 CAP-001: a human assigns, never the
 * server). In ONE tenant tx it sets session.work_item_id (the only place a session is bound),
 * flips the intake to `assigned` with assigned_by/at, and bumps both versions — with OCC on the
 * intake `version` (If-Match). An already-assigned/dismissed intake is a 409 conflict (a bound
 * session must not be silently re-pointed). Audits `agent_session_intake.assigned` and emits both
 * the intake and the session invalidation so the queue and the session update live.
 */
export async function assignIntake(
  db: Kysely<Database>,
  input: {
    organizationId: string
    intakeId: string
    actorUserId: string
    workItemId: string
    expectedVersion: number
  }
): Promise<AssignIntakeResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const intake = await loadIntakeTx(trx, input.intakeId)
    if (!intake) {
      return { ok: false, reason: 'not_found' }
    }
    if (intake.status !== 'pending') {
      return { ok: false, reason: 'already_terminal', status: intake.status }
    }
    if (intake.version !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion: intake.version }
    }
    const session = await loadAgentSessionTx(trx, intake.agentSessionId)
    if (!session) {
      return { ok: false, reason: 'not_found' }
    }
    const newVersion = intake.version + 1
    const now = new Date()
    const updated = await trx
      .updateTable('execution.agent_session_intake')
      .set({
        status: 'assigned',
        work_item_id: input.workItemId,
        assigned_by: input.actorUserId,
        assigned_at: now,
        version: newVersion,
        updated_at: now
      })
      .where('id', '=', intake.id)
      // OCC guard on the same version we read — loses a concurrent race → version_conflict.
      .where('version', '=', String(intake.version))
      .returningAll()
      .executeTakeFirst()
    if (!updated) {
      return { ok: false, reason: 'version_conflict', currentVersion: intake.version }
    }
    // The single explicit-binding step: the session gets its work_item_id here and NOWHERE by
    // automatic inference. Its version bumps so live views re-read the now-bound session.
    const sessionVersion = session.version + 1
    await trx
      .updateTable('execution.agent_sessions')
      .set({ work_item_id: input.workItemId, version: sessionVersion, updated_at: now })
      .where('id', '=', session.id)
      .execute()
    await writeIntakeAudit(
      trx,
      input.organizationId,
      input.actorUserId,
      'assigned',
      intake.id,
      `work_item:${input.workItemId}`
    )
    await emitAgentExecutionChange(
      trx,
      input.organizationId,
      'agent_session_intake',
      intake.id,
      newVersion,
      'updated'
    )
    await emitAgentExecutionChange(
      trx,
      input.organizationId,
      'agent_session',
      session.id,
      sessionVersion,
      'updated'
    )
    return { ok: true, intake: mapAgentSessionIntake(updated) }
  })
}

export type ReclassifyIntakeResult =
  | { ok: true; intake: AgentSessionIntake }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'already_terminal'; status: IntakeStatus }

/**
 * Reclassifies a PENDING intake — changes its detected_reason/source_type, or dismisses it
 * (status=dismissed) — with OCC on `version` (If-Match). An already-assigned/dismissed intake is
 * terminal (409). Audits `agent_session_intake.reclassified` (or `.dismissed`) and emits an
 * update. Never touches the session binding (dismiss just removes it from the queue).
 */
export async function reclassifyIntake(
  db: Kysely<Database>,
  input: {
    organizationId: string
    intakeId: string
    actorUserId: string
    expectedVersion: number
    dismiss?: boolean
    detectedReason?: IntakeDetectedReason
    sourceType?: IntakeSourceType
  }
): Promise<ReclassifyIntakeResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const intake = await loadIntakeTx(trx, input.intakeId)
    if (!intake) {
      return { ok: false, reason: 'not_found' }
    }
    if (intake.status !== 'pending') {
      return { ok: false, reason: 'already_terminal', status: intake.status }
    }
    if (intake.version !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion: intake.version }
    }
    const newVersion = intake.version + 1
    const now = new Date()
    const nextStatus: IntakeStatus = input.dismiss ? 'dismissed' : 'pending'
    const updated = await trx
      .updateTable('execution.agent_session_intake')
      .set({
        status: nextStatus,
        detected_reason: input.detectedReason ?? intake.detectedReason,
        source_type: input.sourceType ?? intake.sourceType,
        version: newVersion,
        updated_at: now
      })
      .where('id', '=', intake.id)
      .where('version', '=', String(intake.version))
      .returningAll()
      .executeTakeFirst()
    if (!updated) {
      return { ok: false, reason: 'version_conflict', currentVersion: intake.version }
    }
    const mapped = mapAgentSessionIntake(updated)
    await writeIntakeAudit(
      trx,
      input.organizationId,
      input.actorUserId,
      input.dismiss ? 'dismissed' : 'reclassified',
      intake.id,
      `${mapped.status}:${mapped.detectedReason}`
    )
    await emitAgentExecutionChange(
      trx,
      input.organizationId,
      'agent_session_intake',
      intake.id,
      newVersion,
      'updated'
    )
    return { ok: true, intake: mapped }
  })
}
