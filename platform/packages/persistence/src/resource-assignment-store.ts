import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { toDateString } from './planning-date'
import { auditPlanning, emitPlanningChange } from './planning-resource-change'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 5: resource assignments — a person (OPAQUE user_id) committed to a project (and
// optionally a specific wbs_node) over a period at some % of capacity. project_id / wbs_node_id /
// user_id are opaque cross-schema links (no FK). Over-allocation across overlapping assignments is
// DELIBERATELY allowed at write; the utilization read is what surfaces it. Only sanity checks live
// here: allocation_pct >= 0 and start_date <= end_date.

export type ResourceAssignmentResource = {
  id: string
  organizationId: string
  projectId: string
  wbsNodeId: string | null
  userId: string
  allocationPct: string
  startDate: string
  endDate: string
  plannedEffortHours: string | null
  roleLabel: string | null
  version: number
  createdAt: string
  updatedAt: string
}

function mapAssignment(row: {
  id: string
  organization_id: string
  project_id: string
  wbs_node_id: string | null
  user_id: string
  allocation_pct: string
  start_date: Date | string
  end_date: Date | string
  planned_effort_hours: string | null
  role_label: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}): ResourceAssignmentResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    wbsNodeId: row.wbs_node_id,
    userId: row.user_id,
    allocationPct: String(row.allocation_pct),
    // start/end are NOT NULL, so toDateString always yields a string here.
    startDate: toDateString(row.start_date) ?? '',
    endDate: toDateString(row.end_date) ?? '',
    plannedEffortHours: row.planned_effort_hours === null ? null : String(row.planned_effort_hours),
    roleLabel: row.role_label,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateResourceAssignmentResult =
  | { ok: true; assignment: ResourceAssignmentResource }
  | { ok: false; reason: 'invalid_allocation' }
  | { ok: false; reason: 'invalid_period' }

export async function createResourceAssignment(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    projectId: string
    userId: string
    allocationPct: number | string
    startDate: string
    endDate: string
    wbsNodeId?: string | null
    plannedEffortHours?: number | string | null
    roleLabel?: string | null
  }
): Promise<CreateResourceAssignmentResult> {
  if (Number(input.allocationPct) < 0) {
    return { ok: false, reason: 'invalid_allocation' }
  }
  if (input.startDate > input.endDate) {
    return { ok: false, reason: 'invalid_period' }
  }
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('planning.resource_assignments')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        wbs_node_id: input.wbsNodeId ?? null,
        user_id: input.userId,
        allocation_pct: input.allocationPct,
        start_date: input.startDate,
        end_date: input.endDate,
        planned_effort_hours: input.plannedEffortHours ?? null,
        role_label: input.roleLabel ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditPlanning(
      trx,
      input.organizationId,
      input.actorUserId,
      'planning.resource_assignment.created',
      'resource_assignment',
      row.id
    )
    await emitPlanningChange(trx, input.organizationId, 'resource_assignment', row.id, 1, 'created')
    return { ok: true, assignment: mapAssignment(row) }
  })
}

export type ResourceAssignmentMutationResult =
  | { ok: true; assignment: ResourceAssignmentResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'invalid_allocation' }
  | { ok: false; reason: 'invalid_period' }

/** Edits an assignment's period / allocation / effort under OCC. */
export async function updateResourceAssignment(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    assignmentId: string
    expectedVersion: number
    allocationPct?: number | string
    startDate?: string
    endDate?: string
    wbsNodeId?: string | null
    plannedEffortHours?: number | string | null
    roleLabel?: string | null
  }
): Promise<ResourceAssignmentMutationResult> {
  if (input.allocationPct !== undefined && Number(input.allocationPct) < 0) {
    return { ok: false, reason: 'invalid_allocation' }
  }
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('planning.resource_assignments')
      .selectAll()
      .where('id', '=', input.assignmentId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    // Validate the resulting period against whichever endpoint is unchanged.
    const nextStart = input.startDate ?? toDateString(current.start_date) ?? ''
    const nextEnd = input.endDate ?? toDateString(current.end_date) ?? ''
    if (nextStart > nextEnd) {
      return { ok: false, reason: 'invalid_period' }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('planning.resource_assignments')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.allocationPct === undefined ? {} : { allocation_pct: input.allocationPct }),
        ...(input.startDate === undefined ? {} : { start_date: input.startDate }),
        ...(input.endDate === undefined ? {} : { end_date: input.endDate }),
        ...(input.wbsNodeId === undefined ? {} : { wbs_node_id: input.wbsNodeId }),
        ...(input.plannedEffortHours === undefined
          ? {}
          : { planned_effort_hours: input.plannedEffortHours }),
        ...(input.roleLabel === undefined ? {} : { role_label: input.roleLabel })
      })
      .where('id', '=', input.assignmentId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditPlanning(
      trx,
      input.organizationId,
      input.actorUserId,
      'planning.resource_assignment.updated',
      'resource_assignment',
      input.assignmentId
    )
    await emitPlanningChange(
      trx,
      input.organizationId,
      'resource_assignment',
      input.assignmentId,
      newVersion,
      'updated'
    )
    return { ok: true, assignment: mapAssignment(updated) }
  })
}

export async function getResourceAssignment(
  db: Kysely<Database>,
  organizationId: string,
  assignmentId: string
): Promise<ResourceAssignmentResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('planning.resource_assignments')
      .selectAll()
      .where('id', '=', assignmentId)
      .executeTakeFirst()
    return row ? mapAssignment(row) : null
  })
}

export async function listResourceAssignments(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string
): Promise<ResourceAssignmentResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('planning.resource_assignments')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('start_date', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapAssignment)
  })
}
