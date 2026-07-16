import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { buildResourceChangeCloudEvent } from './resource-change-event'
import { defaultStateIdForTeam } from './workflow-store'
import { withTenantTransaction } from './tenant-transaction'

export type WorkItemPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low'

export type WorkItemResource = {
  id: string
  organizationId: string
  teamId: string
  projectId: string | null
  identifier: string
  title: string
  description: string | null
  stateId: string
  workflowVersion: number
  sortKey: number
  priority: WorkItemPriority
  assigneeId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type WorkItemRow = {
  id: string
  organization_id: string
  team_id: string
  project_id: string | null
  identifier: string
  title: string
  description: string | null
  state_id: string
  workflow_version: string | number
  sort_key: string | number
  priority: string
  assignee_id: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapWorkItem(row: WorkItemRow): WorkItemResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    teamId: row.team_id,
    projectId: row.project_id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    stateId: row.state_id,
    workflowVersion: Number(row.workflow_version),
    sortKey: Number(row.sort_key),
    priority: row.priority as WorkItemPriority,
    assigneeId: row.assignee_id,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

async function emitWorkItemChange(
  trx: Transaction<Database>,
  organizationId: string,
  workItemId: string,
  version: number,
  changeKind: 'created' | 'updated'
): Promise<void> {
  const outboxId = randomUUID()
  const occurredAt = new Date().toISOString()
  const cloudEvent = buildResourceChangeCloudEvent({
    organizationId,
    eventId: outboxId,
    resourceType: 'work_item',
    resourceId: workItemId,
    changeKind,
    version,
    occurredAt
  })
  await trx
    .insertInto('operations.outbox_events')
    .values({
      id: outboxId,
      organization_id: organizationId,
      aggregate_type: 'work_item',
      aggregate_id: workItemId,
      aggregate_version: version,
      event_type: cloudEvent.type,
      event_schema_version: 1,
      payload: JSON.stringify(cloudEvent),
      occurred_at: occurredAt,
      available_at: occurredAt
    })
    .execute()
}

async function auditWorkItem(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string,
  workItemId: string,
  action: string
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorUserId,
      action,
      target_type: 'work_item',
      target_id: workItemId
    })
    .execute()
}

export type CreateWorkItemResult =
  | { ok: true; workItem: WorkItemResource }
  | { ok: false; reason: 'team_not_found' | 'invalid_state' | 'project_not_found' }

/**
 * Creates a work item and assigns its team-scoped human identifier (team.key + '-'
 * + sequence) by incrementing delivery.team_counters IN THE SAME transaction (doc
 * 30:259). The UPDATE ... RETURNING takes a row lock, so two concurrent creates on
 * one team serialize into distinct sequential identifiers with no gap or dup. The
 * opaque UUID stays the primary key; the identifier is a distinct namespace from
 * Orca's Worktree/Workspace/task IDs.
 */
export async function createWorkItem(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    teamId: string
    projectId?: string | null
    title: string
    description?: string | null
    stateId?: string | null
    priority?: WorkItemPriority
    assigneeId?: string | null
  }
): Promise<CreateWorkItemResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const team = await trx
      .selectFrom('delivery.teams')
      .select(['id', 'key', 'workflow_version'])
      .where('id', '=', input.teamId)
      .executeTakeFirst()
    if (!team) {
      return { ok: false, reason: 'team_not_found' }
    }
    let stateId = input.stateId ?? null
    if (stateId) {
      const state = await trx
        .selectFrom('delivery.workflow_states')
        .select('id')
        .where('id', '=', stateId)
        .where('team_id', '=', input.teamId)
        .executeTakeFirst()
      if (!state) {
        return { ok: false, reason: 'invalid_state' }
      }
    } else {
      stateId = await defaultStateIdForTeam(trx, input.teamId)
      if (!stateId) {
        return { ok: false, reason: 'invalid_state' }
      }
    }
    if (input.projectId) {
      const project = await trx
        .selectFrom('delivery.projects')
        .select('id')
        .where('id', '=', input.projectId)
        .executeTakeFirst()
      if (!project) {
        return { ok: false, reason: 'project_not_found' }
      }
    }
    // Atomic counter bump: RETURNING sees the incremented value, so (next_sequence
    // - 1) is the sequence assigned to THIS item. The row lock serializes races.
    const counter = await trx
      .updateTable('delivery.team_counters')
      .set({ next_sequence: sql`next_sequence + 1` })
      .where('team_id', '=', input.teamId)
      .returning(sql<string>`next_sequence - 1`.as('assigned'))
      .executeTakeFirstOrThrow()
    const sequence = Number(counter.assigned)
    const identifier = `${team.key}-${sequence}`
    const inserted = await trx
      .insertInto('delivery.work_items')
      .values({
        organization_id: input.organizationId,
        team_id: input.teamId,
        project_id: input.projectId ?? null,
        sequence,
        identifier,
        title: input.title,
        description: input.description ?? null,
        state_id: stateId,
        workflow_version: team.workflow_version,
        assignee_id: input.assigneeId ?? null,
        creator_id: input.actorUserId,
        priority: input.priority ?? 'none',
        sort_key: sequence
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditWorkItem(
      trx,
      input.organizationId,
      input.actorUserId,
      inserted.id,
      'work_item.created'
    )
    await emitWorkItemChange(trx, input.organizationId, inserted.id, 1, 'created')
    return { ok: true, workItem: mapWorkItem(inserted) }
  })
}

export async function getWorkItem(
  db: Kysely<Database>,
  organizationId: string,
  workItemId: string
): Promise<WorkItemResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('delivery.work_items')
      .selectAll()
      .where('id', '=', workItemId)
      .executeTakeFirst()
    return row ? mapWorkItem(row) : null
  })
}

export async function listWorkItems(
  db: Kysely<Database>,
  organizationId: string,
  filter: { projectId?: string; assigneeId?: string } = {}
): Promise<WorkItemResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx.selectFrom('delivery.work_items').selectAll().where('archived_at', 'is', null)
    if (filter.projectId) {
      query = query.where('project_id', '=', filter.projectId)
    }
    // My Work: assignee-keyed, backed by work_items_assignee_idx (doc 30:352).
    if (filter.assigneeId) {
      query = query.where('assignee_id', '=', filter.assigneeId)
    }
    const rows = await query.orderBy('sort_key').execute()
    return rows.map(mapWorkItem)
  })
}

export type UpdateWorkItemResult =
  | { ok: true; workItem: WorkItemResource }
  | {
      ok: false
      reason:
        | 'not_found'
        | 'project_not_found'
        | 'state_change_requires_move'
        | 'assignee_change_requires_assign'
    }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

/**
 * Merge-patches the mergeable fields under If-Match optimistic concurrency. Two
 * changes are intentionally rejected here and routed to their own actions so their
 * distinct permission and validation apply: a stateId change must go through
 * moveWorkItemState (validates the team's workflowVersion, doc 23:118-119), and an
 * assigneeId change must go through assignWorkItem (carries work_item.assign).
 */
export async function updateWorkItem(
  db: Kysely<Database>,
  input: {
    organizationId: string
    workItemId: string
    actorUserId: string
    expectedVersion: number
    patch: {
      title?: string
      description?: string | null
      priority?: WorkItemPriority
      assigneeId?: string | null
      projectId?: string | null
      stateId?: string
    }
  }
): Promise<UpdateWorkItemResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('delivery.work_items')
      .selectAll()
      .where('id', '=', input.workItemId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion: Number(current.version) }
    }
    if (input.patch.stateId !== undefined && input.patch.stateId !== current.state_id) {
      return { ok: false, reason: 'state_change_requires_move' }
    }
    if (input.patch.assigneeId !== undefined && input.patch.assigneeId !== current.assignee_id) {
      return { ok: false, reason: 'assignee_change_requires_assign' }
    }
    if (input.patch.projectId) {
      const project = await trx
        .selectFrom('delivery.projects')
        .select('id')
        .where('id', '=', input.patch.projectId)
        .executeTakeFirst()
      if (!project) {
        return { ok: false, reason: 'project_not_found' }
      }
    }
    const newVersion = Number(current.version) + 1
    const updated = await trx
      .updateTable('delivery.work_items')
      .set({
        title: input.patch.title ?? current.title,
        description:
          input.patch.description === undefined ? current.description : input.patch.description,
        priority: input.patch.priority ?? current.priority,
        project_id:
          input.patch.projectId === undefined ? current.project_id : input.patch.projectId,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.workItemId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditWorkItem(
      trx,
      input.organizationId,
      input.actorUserId,
      input.workItemId,
      'work_item.updated'
    )
    await emitWorkItemChange(trx, input.organizationId, input.workItemId, newVersion, 'updated')
    return { ok: true, workItem: mapWorkItem(updated) }
  })
}

export type MoveWorkItemStateResult =
  | { ok: true; workItem: WorkItemResource }
  | { ok: false; reason: 'not_found' | 'invalid_to_state' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'workflow_version_conflict'; currentWorkflowVersion: number }
  | { ok: false; reason: 'from_state_conflict'; currentStateId: string }

/**
 * Board move (doc 23:118-119): validates fromStateId, the item's expectedVersion,
 * AND the team's workflowVersion together, then transitions the state in one tx.
 * This advances the Team WorkItem Workflow ONLY — it deliberately touches no
 * delivery/project row and never auto-advances a Delivery Stage (doc 27:137-146);
 * there is no Delivery Workflow yet and this must not create that coupling.
 */
export async function moveWorkItemState(
  db: Kysely<Database>,
  input: {
    organizationId: string
    workItemId: string
    actorUserId: string
    fromStateId: string
    toStateId: string
    workflowVersion: number
    expectedVersion: number
  }
): Promise<MoveWorkItemStateResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('delivery.work_items')
      .selectAll()
      .where('id', '=', input.workItemId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion: Number(current.version) }
    }
    const team = await trx
      .selectFrom('delivery.teams')
      .select('workflow_version')
      .where('id', '=', current.team_id)
      .executeTakeFirstOrThrow()
    if (Number(team.workflow_version) !== input.workflowVersion) {
      return {
        ok: false,
        reason: 'workflow_version_conflict',
        currentWorkflowVersion: Number(team.workflow_version)
      }
    }
    if (current.state_id !== input.fromStateId) {
      return { ok: false, reason: 'from_state_conflict', currentStateId: current.state_id }
    }
    // Reject a target that is not one of THIS team's states before the FK would —
    // an invalid transition is a clean 4xx, not a 500.
    const toState = await trx
      .selectFrom('delivery.workflow_states')
      .select('id')
      .where('id', '=', input.toStateId)
      .where('team_id', '=', current.team_id)
      .executeTakeFirst()
    if (!toState) {
      return { ok: false, reason: 'invalid_to_state' }
    }
    const newVersion = Number(current.version) + 1
    const updated = await trx
      .updateTable('delivery.work_items')
      .set({
        state_id: input.toStateId,
        workflow_version: team.workflow_version,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.workItemId)
      .returningAll()
      .executeTakeFirstOrThrow()
    // The 'state_moved' reason lives in the audit action; the realtime envelope is
    // a plain work_item.updated invalidation.
    await auditWorkItem(
      trx,
      input.organizationId,
      input.actorUserId,
      input.workItemId,
      'work_item.state_moved'
    )
    await emitWorkItemChange(trx, input.organizationId, input.workItemId, newVersion, 'updated')
    return { ok: true, workItem: mapWorkItem(updated) }
  })
}

export type AssignWorkItemResult =
  | { ok: true; workItem: WorkItemResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

/**
 * Changes a work item's assignee under optimistic concurrency (doc 27:437). Its
 * own action because assignment carries work_item.assign, distinct from the
 * work_item.update that a field PATCH needs. One tenant tx: assignee + version bump
 * + audit + realtime invalidation.
 */
export async function assignWorkItem(
  db: Kysely<Database>,
  input: {
    organizationId: string
    workItemId: string
    actorUserId: string
    assigneeId: string | null
    expectedVersion: number
  }
): Promise<AssignWorkItemResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('delivery.work_items')
      .selectAll()
      .where('id', '=', input.workItemId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion: Number(current.version) }
    }
    const newVersion = Number(current.version) + 1
    const updated = await trx
      .updateTable('delivery.work_items')
      .set({ assignee_id: input.assigneeId, version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.workItemId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditWorkItem(
      trx,
      input.organizationId,
      input.actorUserId,
      input.workItemId,
      'work_item.assigned'
    )
    await emitWorkItemChange(trx, input.organizationId, input.workItemId, newVersion, 'updated')
    return { ok: true, workItem: mapWorkItem(updated) }
  })
}

export type WorkItemActivityEntry = {
  id: string
  workItemId: string
  action: string
  actorId: string | null
  occurredAt: string
}

/**
 * The work item's Activity timeline = its slice of the audit trail (state moves,
 * assignments, comments, field changes), oldest first. audit.audit_events is the
 * source of truth; this is a filtered read (a dedicated projection is a deferred
 * optimization). Work-item-scoped only — never cross-item or cross-tenant.
 */
export async function listWorkItemActivity(
  db: Kysely<Database>,
  organizationId: string,
  workItemId: string
): Promise<WorkItemActivityEntry[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('audit.audit_events')
      .select(['id', 'action', 'actor_id', 'target_id', 'occurred_at'])
      .where('target_type', '=', 'work_item')
      .where('target_id', '=', workItemId)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      workItemId,
      action: row.action,
      actorId: row.actor_id,
      occurredAt: new Date(row.occurred_at).toISOString()
    }))
  })
}
