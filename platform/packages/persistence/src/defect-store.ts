import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { auditQaEvent, emitQaResourceChange } from './qa-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R6 qa — a DEFECT raised against a project, optionally tied to the test_case that found it, the work
// item that owns the fix, or the deliverable it blocks. Traces to a requirement THROUGH its test_case
// / deliverable so the qa-traceability read can surface "defects raised against this requirement's
// tests/산출물". A status change is the OCC :transition. project_id / test_case_id / work_item_id /
// deliverable_id are OPAQUE cross-schema ids — no FK, same-tenant integrity via organization_id.

export type DefectSeverity = 'low' | 'medium' | 'high' | 'critical'
export type DefectStatus = 'open' | 'triaged' | 'in_progress' | 'resolved' | 'closed' | 'wontfix'
export type DefectAction = 'triage' | 'start' | 'resolve' | 'close' | 'reopen' | 'wontfix'

export type DefectResource = {
  id: string
  organizationId: string
  projectId: string
  testCaseId: string | null
  workItemId: string | null
  deliverableId: string | null
  title: string
  description: string | null
  severity: DefectSeverity
  status: DefectStatus
  version: number
  createdAt: string
  updatedAt: string
}

type DefectRow = {
  id: string
  organization_id: string
  project_id: string
  test_case_id: string | null
  work_item_id: string | null
  deliverable_id: string | null
  title: string
  description: string | null
  severity: string
  status: string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapDefect(row: DefectRow): DefectResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    testCaseId: row.test_case_id,
    workItemId: row.work_item_id,
    deliverableId: row.deliverable_id,
    title: row.title,
    description: row.description,
    severity: row.severity as DefectSeverity,
    status: row.status as DefectStatus,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateDefectInput = {
  organizationId: string
  actorUserId: string
  projectId: string
  testCaseId?: string | null
  workItemId?: string | null
  deliverableId?: string | null
  title: string
  description?: string | null
  severity?: DefectSeverity
}

/** Creates a defect in status='open'. Its lifecycle advances only via the :transition chain. */
export async function createDefect(
  db: Kysely<Database>,
  input: CreateDefectInput
): Promise<DefectResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('qa.defects')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        test_case_id: input.testCaseId ?? null,
        work_item_id: input.workItemId ?? null,
        deliverable_id: input.deliverableId ?? null,
        title: input.title,
        description: input.description ?? null,
        severity: input.severity ?? 'medium',
        status: 'open'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditQaEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'defect.created',
      'defect',
      row.id
    )
    await emitQaResourceChange(trx, input.organizationId, 'defect', row.id, 1, 'created')
    return mapDefect(row)
  })
}

export async function getDefect(
  db: Kysely<Database>,
  organizationId: string,
  defectId: string
): Promise<DefectResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('qa.defects')
      .selectAll()
      .where('id', '=', defectId)
      .executeTakeFirst()
    return row ? mapDefect(row) : null
  })
}

export type DefectPage = { items: DefectResource[]; nextCursor: string | null }

export async function listDefectsByProject(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<DefectPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('qa.defects')
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
    return { items: page.map(mapDefect), nextCursor }
  })
}

export type UpdateDefectResult =
  | { ok: true; defect: DefectResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export type UpdateDefectInput = {
  organizationId: string
  defectId: string
  actorUserId: string
  expectedVersion: number
  title?: string
  description?: string | null
  severity?: DefectSeverity
  testCaseId?: string | null
  workItemId?: string | null
  deliverableId?: string | null
}

/** Edits defect metadata (incl. severity) under OCC (If-Match). Status is changed via :transition. */
export async function updateDefect(
  db: Kysely<Database>,
  input: UpdateDefectInput
): Promise<UpdateDefectResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('qa.defects')
      .selectAll()
      .where('id', '=', input.defectId)
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
      .updateTable('qa.defects')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.severity === undefined ? {} : { severity: input.severity }),
        ...(input.testCaseId === undefined ? {} : { test_case_id: input.testCaseId }),
        ...(input.workItemId === undefined ? {} : { work_item_id: input.workItemId }),
        ...(input.deliverableId === undefined ? {} : { deliverable_id: input.deliverableId })
      })
      .where('id', '=', input.defectId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditQaEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'defect.updated',
      'defect',
      updated.id
    )
    await emitQaResourceChange(
      trx,
      input.organizationId,
      'defect',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, defect: mapDefect(updated) }
  })
}

export type DefectTransitionResult =
  | { ok: true; defect: DefectResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: DefectStatus }

// Legal edges. resolve is reachable from any live (non-terminal) status so a defect can be closed out
// directly (the test's open→resolved path). closed/wontfix are terminal but reopen returns to open.
const LEGAL_FROM: Record<DefectAction, readonly DefectStatus[]> = {
  triage: ['open'],
  start: ['triaged', 'open'],
  resolve: ['open', 'triaged', 'in_progress'],
  close: ['resolved'],
  reopen: ['resolved', 'closed', 'wontfix'],
  wontfix: ['open', 'triaged', 'in_progress']
}
const TO_STATUS: Record<DefectAction, DefectStatus> = {
  triage: 'triaged',
  start: 'in_progress',
  resolve: 'resolved',
  close: 'closed',
  reopen: 'open',
  wontfix: 'wontfix'
}

/** Advances a defect's status under OCC (If-Match). */
export async function transitionDefect(
  db: Kysely<Database>,
  input: {
    organizationId: string
    defectId: string
    actorUserId: string
    action: DefectAction
    expectedVersion: number
  }
): Promise<DefectTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('qa.defects')
      .selectAll()
      .where('id', '=', input.defectId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as DefectStatus
    if (!LEGAL_FROM[input.action].includes(from)) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('qa.defects')
      .set({ status: TO_STATUS[input.action], version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.defectId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditQaEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `defect.${input.action}`,
      'defect',
      input.defectId
    )
    await emitQaResourceChange(
      trx,
      input.organizationId,
      'defect',
      input.defectId,
      newVersion,
      'updated'
    )
    return { ok: true, defect: mapDefect(updated) }
  })
}
