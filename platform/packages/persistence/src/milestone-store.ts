import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { toDateString } from './planning-date'
import { auditPlanning, emitPlanningChange } from './planning-resource-change'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 4: project milestones — dated checkpoints on the planned schedule. project_id and the
// optional wbs_node_id are OPAQUE links (no FK). status moves via an OCC-guarded :transition.

export type MilestoneStatus = 'planned' | 'met' | 'missed' | 'at_risk'

export type MilestoneResource = {
  id: string
  organizationId: string
  projectId: string
  wbsNodeId: string | null
  name: string
  targetDate: string
  status: MilestoneStatus
  version: number
  createdAt: string
  updatedAt: string
}

function mapMilestone(row: {
  id: string
  organization_id: string
  project_id: string
  wbs_node_id: string | null
  name: string
  target_date: Date | string
  status: string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}): MilestoneResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    wbsNodeId: row.wbs_node_id,
    name: row.name,
    // target_date is NOT NULL, so toDateString always yields a string here.
    targetDate: toDateString(row.target_date) ?? '',
    status: row.status as MilestoneStatus,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export async function createMilestone(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    projectId: string
    name: string
    targetDate: string
    wbsNodeId?: string | null
    status?: MilestoneStatus
  }
): Promise<MilestoneResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('planning.milestones')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        name: input.name,
        target_date: input.targetDate,
        wbs_node_id: input.wbsNodeId ?? null,
        status: input.status ?? 'planned'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditPlanning(
      trx,
      input.organizationId,
      input.actorUserId,
      'planning.milestone.created',
      'milestone',
      row.id
    )
    await emitPlanningChange(trx, input.organizationId, 'milestone', row.id, 1, 'created')
    return mapMilestone(row)
  })
}

export async function getMilestone(
  db: Kysely<Database>,
  organizationId: string,
  milestoneId: string
): Promise<MilestoneResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('planning.milestones')
      .selectAll()
      .where('id', '=', milestoneId)
      .executeTakeFirst()
    return row ? mapMilestone(row) : null
  })
}

export async function listMilestones(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string
): Promise<MilestoneResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('planning.milestones')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('target_date', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapMilestone)
  })
}

export type MilestoneTransitionResult =
  | { ok: true; milestone: MilestoneResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

/** Sets a milestone's status under OCC (planned → met/missed/at_risk, or back to planned). */
export async function transitionMilestone(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    milestoneId: string
    toStatus: MilestoneStatus
    expectedVersion: number
  }
): Promise<MilestoneTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('planning.milestones')
      .selectAll()
      .where('id', '=', input.milestoneId)
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
      .updateTable('planning.milestones')
      .set({ status: input.toStatus, version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.milestoneId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditPlanning(
      trx,
      input.organizationId,
      input.actorUserId,
      'planning.milestone.transition',
      'milestone',
      input.milestoneId
    )
    await emitPlanningChange(
      trx,
      input.organizationId,
      'milestone',
      input.milestoneId,
      newVersion,
      'updated'
    )
    return { ok: true, milestone: mapMilestone(updated) }
  })
}
