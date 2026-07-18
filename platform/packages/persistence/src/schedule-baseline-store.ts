import { type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { toDateString } from './planning-date'
import { auditPlanning, emitPlanningChange } from './planning-resource-change'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 4: schedule baselines — an immutable SNAPSHOT of a project's planned WBS schedule at
// capture time. Capturing reads the LIVE wbs_nodes and copies each one's planned dates/effort into
// append-only baseline_entries in one tenant tx. Nothing here ever updates or deletes an entry, so
// a later edit to a wbs_node cannot alter a captured baseline — that frozen reference is what a
// future variance ("계획 대비") slice compares actuals against.

export type ScheduleBaselineResource = {
  id: string
  organizationId: string
  projectId: string
  name: string
  capturedBy: string | null
  entryCount: number
  capturedAt: string
  createdAt: string
}

export type BaselineEntry = {
  id: string
  wbsNodeId: string
  parentId: string | null
  wbsCode: string
  name: string
  nodeType: string
  sortOrder: number
  plannedStart: string | null
  plannedEnd: string | null
  plannedEffortHours: string | null
}

function mapBaseline(row: {
  id: string
  organization_id: string
  project_id: string
  name: string
  captured_by: string | null
  entry_count: number
  captured_at: Date | string
  created_at: Date | string
}): ScheduleBaselineResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    name: row.name,
    capturedBy: row.captured_by,
    entryCount: row.entry_count,
    capturedAt: new Date(row.captured_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString()
  }
}

function mapEntry(row: {
  id: string
  wbs_node_id: string
  parent_id: string | null
  wbs_code: string
  name: string
  node_type: string
  sort_order: number
  planned_start: Date | string | null
  planned_end: Date | string | null
  planned_effort_hours: string | null
}): BaselineEntry {
  return {
    id: row.id,
    wbsNodeId: row.wbs_node_id,
    parentId: row.parent_id,
    wbsCode: row.wbs_code,
    name: row.name,
    nodeType: row.node_type,
    sortOrder: row.sort_order,
    plannedStart: toDateString(row.planned_start),
    plannedEnd: toDateString(row.planned_end),
    plannedEffortHours: row.planned_effort_hours === null ? null : String(row.planned_effort_hours)
  }
}

/**
 * Captures a baseline: reads the live WBS for the project and writes the header + one immutable
 * entry per node, all in one tenant tx. The entries copy each node's planned dates/effort AS THEY
 * ARE NOW — never linked by FK to the live node, so the snapshot outlives edits and deletes.
 */
export async function captureScheduleBaseline(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    projectId: string
    name: string
  }
): Promise<{ baseline: ScheduleBaselineResource; entries: BaselineEntry[] }> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const nodes = await trx
      .selectFrom('planning.wbs_nodes')
      .select([
        'id',
        'parent_id',
        'wbs_code',
        'name',
        'node_type',
        'sort_order',
        'planned_start',
        'planned_end',
        'planned_effort_hours'
      ])
      .where('project_id', '=', input.projectId)
      .orderBy('sort_order', 'asc')
      .orderBy('wbs_code', 'asc')
      .orderBy('id', 'asc')
      .execute()
    const header = await trx
      .insertInto('planning.schedule_baselines')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        name: input.name,
        captured_by: input.actorUserId,
        entry_count: nodes.length
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const entries: BaselineEntry[] = []
    for (const node of nodes) {
      const entryRow = await trx
        .insertInto('planning.baseline_entries')
        .values({
          organization_id: input.organizationId,
          baseline_id: header.id,
          wbs_node_id: node.id,
          parent_id: node.parent_id,
          wbs_code: node.wbs_code,
          name: node.name,
          node_type: node.node_type,
          sort_order: node.sort_order,
          // Copy the calendar date as a string so pg stores it exactly (a raw Date could shift
          // across the session timezone) — the snapshot must be a faithful copy.
          planned_start: toDateString(node.planned_start),
          planned_end: toDateString(node.planned_end),
          planned_effort_hours: node.planned_effort_hours
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      entries.push(mapEntry(entryRow))
    }
    await auditPlanning(
      trx,
      input.organizationId,
      input.actorUserId,
      'planning.schedule_baseline.captured',
      'schedule_baseline',
      header.id
    )
    await emitPlanningChange(
      trx,
      input.organizationId,
      'schedule_baseline',
      header.id,
      1,
      'created'
    )
    return { baseline: mapBaseline(header), entries }
  })
}

export async function listScheduleBaselines(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string
): Promise<ScheduleBaselineResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('planning.schedule_baselines')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('captured_at', 'desc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapBaseline)
  })
}

export async function getScheduleBaseline(
  db: Kysely<Database>,
  organizationId: string,
  baselineId: string
): Promise<{ baseline: ScheduleBaselineResource; entries: BaselineEntry[] } | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const header = await trx
      .selectFrom('planning.schedule_baselines')
      .selectAll()
      .where('id', '=', baselineId)
      .executeTakeFirst()
    if (!header) {
      return null
    }
    const entryRows = await trx
      .selectFrom('planning.baseline_entries')
      .selectAll()
      .where('baseline_id', '=', baselineId)
      .orderBy('sort_order', 'asc')
      .orderBy('wbs_code', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return { baseline: mapBaseline(header), entries: entryRows.map(mapEntry) }
  })
}
