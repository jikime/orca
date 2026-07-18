import { type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { toDateString } from './planning-date'
import { auditPlanning, emitPlanningChange } from './planning-resource-change'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 5: effort_entries — the ACTUAL logged effort, timesheet-like and APPEND-ONLY (INSERT +
// SELECT only here, mirroring baseline_entries). A correction is a NEW row (possibly negative), so
// history is never mutated. project_id / wbs_node_id / work_item_id / user_id are OPAQUE links (no
// FK). The variance read joins these actuals to a baseline entry by wbs_node_id.

export type EffortEntryResource = {
  id: string
  organizationId: string
  projectId: string
  wbsNodeId: string | null
  workItemId: string | null
  userId: string
  entryDate: string
  effortHours: string
  note: string | null
  createdAt: string
}

function mapEntry(row: {
  id: string
  organization_id: string
  project_id: string
  wbs_node_id: string | null
  work_item_id: string | null
  user_id: string
  entry_date: Date | string
  effort_hours: string
  note: string | null
  created_at: Date | string
}): EffortEntryResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    wbsNodeId: row.wbs_node_id,
    workItemId: row.work_item_id,
    userId: row.user_id,
    // entry_date is NOT NULL, so toDateString always yields a string here.
    entryDate: toDateString(row.entry_date) ?? '',
    effortHours: String(row.effort_hours),
    note: row.note,
    createdAt: new Date(row.created_at).toISOString()
  }
}

export type LogEffortEntryResult =
  | { ok: true; entry: EffortEntryResource }
  // Non-zero required: a positive log or a negative correcting entry, never a no-op zero.
  | { ok: false; reason: 'invalid_effort' }

export async function logEffortEntry(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    projectId: string
    userId: string
    entryDate: string
    effortHours: number | string
    wbsNodeId?: string | null
    workItemId?: string | null
    note?: string | null
  }
): Promise<LogEffortEntryResult> {
  if (Number(input.effortHours) === 0) {
    return { ok: false, reason: 'invalid_effort' }
  }
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('planning.effort_entries')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        wbs_node_id: input.wbsNodeId ?? null,
        work_item_id: input.workItemId ?? null,
        user_id: input.userId,
        entry_date: input.entryDate,
        effort_hours: input.effortHours,
        note: input.note ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditPlanning(
      trx,
      input.organizationId,
      input.actorUserId,
      'planning.effort_entry.logged',
      'effort_entry',
      row.id
    )
    // Append-only: an entry is only ever 'created' (there is no update/delete route).
    await emitPlanningChange(trx, input.organizationId, 'effort_entry', row.id, 1, 'created')
    return { ok: true, entry: mapEntry(row) }
  })
}

export async function getEffortEntry(
  db: Kysely<Database>,
  organizationId: string,
  entryId: string
): Promise<EffortEntryResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('planning.effort_entries')
      .selectAll()
      .where('id', '=', entryId)
      .executeTakeFirst()
    return row ? mapEntry(row) : null
  })
}

/** Lists a project's effort entries, optionally narrowed to one wbs node and/or one user. */
export async function listEffortEntries(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string,
  filter: { wbsNodeId?: string; userId?: string } = {}
): Promise<EffortEntryResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('planning.effort_entries')
      .selectAll()
      .where('project_id', '=', projectId)
    if (filter.wbsNodeId !== undefined) {
      query = query.where('wbs_node_id', '=', filter.wbsNodeId)
    }
    if (filter.userId !== undefined) {
      query = query.where('user_id', '=', filter.userId)
    }
    const rows = await query.orderBy('entry_date', 'asc').orderBy('id', 'asc').execute()
    return rows.map(mapEntry)
  })
}
