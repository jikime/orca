import { randomUUID } from 'node:crypto'
import type { Kysely, Transaction } from 'kysely'
import {
  emitAgentExecutionChange,
  loadAgentSessionTx,
  type AgentSession,
  type CaptureMode
} from './agent-session-store'
import type { Database } from './database-schema'
import { buildResourceChangeCloudEvent } from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

// R5 slice 5a: the RBAC-gated, OCC-guarded, audited capture-policy mutations (doc 14 §R5 capture
// mode; doc 24 CAP-002). Changing a session's capture mode or a project's default capture mode is
// a policy change, so it is versioned (If-Match), records an audit event, and emits an
// invalidation — mirroring the intake assign/reclassify pattern.

async function writeCaptureAudit(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string,
  action: 'session_capture_mode_set' | 'project_default_capture_mode_set',
  targetType: string,
  targetId: string,
  afterDigest: string
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorUserId,
      action: `agent_capture.${action}`,
      target_type: targetType,
      target_id: targetId,
      after_digest: afterDigest
    })
    .execute()
}

export type SetCaptureModeResult =
  | { ok: true; session: AgentSession }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

/**
 * Sets a session's capture mode with OCC on `version` (If-Match). Audits
 * `agent_capture.session_capture_mode_set` and emits an agent_session `updated` invalidation. The
 * new mode governs the NEXT ingested event — already-stored events are append-only and unchanged.
 */
export async function setSessionCaptureMode(
  db: Kysely<Database>,
  input: {
    organizationId: string
    sessionId: string
    actorUserId: string
    captureMode: CaptureMode
    expectedVersion: number
  }
): Promise<SetCaptureModeResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const session = await loadAgentSessionTx(trx, input.sessionId)
    if (!session) {
      return { ok: false, reason: 'not_found' }
    }
    if (session.version !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion: session.version }
    }
    const newVersion = session.version + 1
    const updated = await trx
      .updateTable('execution.agent_sessions')
      .set({ capture_mode: input.captureMode, version: newVersion, updated_at: new Date() })
      .where('id', '=', session.id)
      // OCC guard on the version we read — a concurrent race loses → version_conflict.
      .where('version', '=', String(session.version))
      .returningAll()
      .executeTakeFirst()
    if (!updated) {
      return { ok: false, reason: 'version_conflict', currentVersion: session.version }
    }
    await writeCaptureAudit(
      trx,
      input.organizationId,
      input.actorUserId,
      'session_capture_mode_set',
      'agent_session',
      session.id,
      `capture_mode:${input.captureMode}`
    )
    await emitAgentExecutionChange(
      trx,
      input.organizationId,
      'agent_session',
      session.id,
      newVersion,
      'updated'
    )
    return {
      ok: true,
      session: { ...session, captureMode: input.captureMode, version: newVersion }
    }
  })
}

export type SetProjectDefaultResult =
  | { ok: true; projectId: string; defaultCaptureMode: CaptureMode; version: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

/**
 * Sets a project's default capture mode (the value a new session inherits) with OCC on the
 * project `version`. Audits `agent_capture.project_default_capture_mode_set` and emits a `project`
 * invalidation on the same outbox the delivery vertical uses.
 */
export async function setProjectDefaultCaptureMode(
  db: Kysely<Database>,
  input: {
    organizationId: string
    projectId: string
    actorUserId: string
    captureMode: CaptureMode
    expectedVersion: number
  }
): Promise<SetProjectDefaultResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const project = await trx
      .selectFrom('delivery.projects')
      .select(['id', 'version'])
      .where('id', '=', input.projectId)
      .executeTakeFirst()
    if (!project) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(project.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('delivery.projects')
      .set({
        default_capture_mode: input.captureMode,
        version: String(newVersion),
        updated_at: new Date()
      })
      .where('id', '=', input.projectId)
      .where('version', '=', String(currentVersion))
      .returning('id')
      .executeTakeFirst()
    if (!updated) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    await writeCaptureAudit(
      trx,
      input.organizationId,
      input.actorUserId,
      'project_default_capture_mode_set',
      'project',
      input.projectId,
      `default_capture_mode:${input.captureMode}`
    )
    const outboxId = randomUUID()
    const occurredAt = new Date().toISOString()
    const cloudEvent = buildResourceChangeCloudEvent({
      organizationId: input.organizationId,
      eventId: outboxId,
      resourceType: 'project',
      resourceId: input.projectId,
      changeKind: 'updated',
      version: newVersion,
      occurredAt
    })
    await trx
      .insertInto('operations.outbox_events')
      .values({
        id: outboxId,
        organization_id: input.organizationId,
        aggregate_type: 'project',
        aggregate_id: input.projectId,
        aggregate_version: newVersion,
        event_type: cloudEvent.type,
        event_schema_version: 1,
        payload: JSON.stringify(cloudEvent),
        occurred_at: occurredAt,
        available_at: occurredAt
      })
      .execute()
    return {
      ok: true,
      projectId: input.projectId,
      defaultCaptureMode: input.captureMode,
      version: newVersion
    }
  })
}
