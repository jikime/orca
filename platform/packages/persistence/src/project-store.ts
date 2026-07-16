import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { projectEntitlementDecision } from './entitlement-check'
import { buildResourceChangeCloudEvent } from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

export type ProjectResource = {
  id: string
  organizationId: string
  name: string
  summary: string | null
  status: string
  version: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

function mapProject(row: {
  id: string
  organization_id: string
  name: string
  summary: string | null
  status: string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
  archived_at: Date | string | null
}): ProjectResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    summary: row.summary,
    status: row.status,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null
  }
}

async function emitProjectChange(
  trx: Transaction<Database>,
  organizationId: string,
  projectId: string,
  version: number,
  changeKind: 'created' | 'updated'
): Promise<void> {
  const outboxId = randomUUID()
  const occurredAt = new Date().toISOString()
  const cloudEvent = buildResourceChangeCloudEvent({
    organizationId,
    eventId: outboxId,
    resourceType: 'project',
    resourceId: projectId,
    changeKind,
    version,
    occurredAt
  })
  await trx
    .insertInto('operations.outbox_events')
    .values({
      id: outboxId,
      organization_id: organizationId,
      aggregate_type: 'project',
      aggregate_id: projectId,
      aggregate_version: version,
      event_type: cloudEvent.type,
      event_schema_version: 1,
      payload: JSON.stringify(cloudEvent),
      occurred_at: occurredAt,
      available_at: occurredAt
    })
    .execute()
}

export type CreateProjectResult =
  | { ok: true; project: ProjectResource }
  // The org is at its project limit (distinct from a permission denial).
  | { ok: false; reason: 'entitlement_shortfall' }

/**
 * Creates a project, links the creating team, audits, and enqueues the outbox
 * project.created event — all in one tenant transaction. The entitlement gate
 * (core.projects) runs first so an over-limit org is blocked before any write.
 */
export async function createProject(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    teamId: string
    name: string
    summary?: string | null
    status?: 'planned' | 'active'
  }
): Promise<CreateProjectResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const entitlement = await projectEntitlementDecision(trx, input.organizationId)
    if (!entitlement.allowed) {
      await trx
        .insertInto('audit.audit_events')
        .values({
          organization_id: input.organizationId,
          actor_id: input.actorUserId,
          action: 'entitlement.shortfall.core_projects',
          target_type: 'core.projects',
          target_id: null
        })
        .execute()
      return { ok: false, reason: 'entitlement_shortfall' }
    }
    const project = await trx
      .insertInto('delivery.projects')
      .values({
        organization_id: input.organizationId,
        name: input.name,
        summary: input.summary ?? null,
        status: input.status ?? 'planned'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    // Link the creating team (same-tenant composite FK rejects a foreign team).
    await trx
      .insertInto('delivery.project_teams')
      .values({
        organization_id: input.organizationId,
        project_id: project.id,
        team_id: input.teamId
      })
      .execute()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'project.created',
        target_type: 'project',
        target_id: project.id
      })
      .execute()
    await emitProjectChange(trx, input.organizationId, project.id, 1, 'created')
    return { ok: true, project: mapProject(project) }
  })
}

export async function getProject(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string
): Promise<ProjectResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('delivery.projects')
      .selectAll()
      .where('id', '=', projectId)
      .executeTakeFirst()
    return row ? mapProject(row) : null
  })
}

export async function listProjects(
  db: Kysely<Database>,
  organizationId: string
): Promise<ProjectResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('delivery.projects')
      .selectAll()
      .orderBy('created_at')
      .execute()
    return rows.map(mapProject)
  })
}

export type UpdateProjectResult =
  | { ok: true; project: ProjectResource }
  | { ok: false; reason: 'not_found' }
  // Optimistic-concurrency (If-Match) failure — the caller had a stale version.
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

/**
 * Updates a project under optimistic concurrency: expectedVersion must match the
 * current version (the route maps a mismatch to 412). Bumps version, audits, and
 * enqueues project.updated — one tenant transaction.
 */
export async function updateProject(
  db: Kysely<Database>,
  input: {
    organizationId: string
    projectId: string
    actorUserId: string
    expectedVersion: number
    patch: { name?: string; summary?: string | null; status?: string }
  }
): Promise<UpdateProjectResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('delivery.projects')
      .selectAll()
      .where('id', '=', input.projectId)
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
      .updateTable('delivery.projects')
      .set({
        name: input.patch.name ?? current.name,
        summary: input.patch.summary === undefined ? current.summary : input.patch.summary,
        status: input.patch.status ?? current.status,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.projectId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'project.updated',
        target_type: 'project',
        target_id: input.projectId
      })
      .execute()
    await emitProjectChange(trx, input.organizationId, input.projectId, newVersion, 'updated')
    return { ok: true, project: mapProject(updated) }
  })
}
