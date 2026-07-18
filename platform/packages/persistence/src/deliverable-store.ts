import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { toDateString } from './planning-date'
import { auditQaEvent, emitQaResourceChange } from './qa-resource-events'
import { withTenantTransaction } from './tenant-transaction'

// R6 qa — a project DELIVERABLE (산출물). Traces to a requirement (opaque requirement_id) so the
// qa-traceability read can answer "which deliverables realize this requirement". Accepting a
// deliverable is the OCC :transition. project_id / requirement_id / wbs_node_id are OPAQUE
// cross-schema ids — no cross-schema FK, same-tenant integrity via the shared organization_id.

export type DeliverableStatus = 'planned' | 'in_progress' | 'submitted' | 'accepted' | 'rejected'

export type DeliverableAction = 'start' | 'submit' | 'accept' | 'reject'

export type DeliverableResource = {
  id: string
  organizationId: string
  projectId: string
  requirementId: string | null
  wbsNodeId: string | null
  name: string
  description: string | null
  status: DeliverableStatus
  dueDate: string | null
  version: number
  createdAt: string
  updatedAt: string
}

type DeliverableRow = {
  id: string
  organization_id: string
  project_id: string
  requirement_id: string | null
  wbs_node_id: string | null
  name: string
  description: string | null
  status: string
  due_date: Date | string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

export function mapDeliverable(row: DeliverableRow): DeliverableResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    requirementId: row.requirement_id,
    wbsNodeId: row.wbs_node_id,
    name: row.name,
    description: row.description,
    status: row.status as DeliverableStatus,
    dueDate: toDateString(row.due_date),
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateDeliverableInput = {
  organizationId: string
  actorUserId: string
  projectId: string
  requirementId?: string | null
  wbsNodeId?: string | null
  name: string
  description?: string | null
  dueDate?: string | null
}

/** Creates a deliverable in status='planned'. It is accepted only via the :transition chain. */
export async function createDeliverable(
  db: Kysely<Database>,
  input: CreateDeliverableInput
): Promise<DeliverableResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('qa.deliverables')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        requirement_id: input.requirementId ?? null,
        wbs_node_id: input.wbsNodeId ?? null,
        name: input.name,
        description: input.description ?? null,
        status: 'planned',
        due_date: input.dueDate ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditQaEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'deliverable.created',
      'deliverable',
      row.id
    )
    await emitQaResourceChange(trx, input.organizationId, 'deliverable', row.id, 1, 'created')
    return mapDeliverable(row)
  })
}

export async function getDeliverable(
  db: Kysely<Database>,
  organizationId: string,
  deliverableId: string
): Promise<DeliverableResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('qa.deliverables')
      .selectAll()
      .where('id', '=', deliverableId)
      .executeTakeFirst()
    return row ? mapDeliverable(row) : null
  })
}

export type DeliverablePage = { items: DeliverableResource[]; nextCursor: string | null }

export async function listDeliverablesByProject(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<DeliverablePage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('qa.deliverables')
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
    return { items: page.map(mapDeliverable), nextCursor }
  })
}

export type UpdateDeliverableResult =
  | { ok: true; deliverable: DeliverableResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

export type UpdateDeliverableInput = {
  organizationId: string
  deliverableId: string
  actorUserId: string
  expectedVersion: number
  name?: string
  description?: string | null
  requirementId?: string | null
  wbsNodeId?: string | null
  dueDate?: string | null
}

/** Edits deliverable metadata under OCC (If-Match). Status is changed only via :transition. */
export async function updateDeliverable(
  db: Kysely<Database>,
  input: UpdateDeliverableInput
): Promise<UpdateDeliverableResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('qa.deliverables')
      .selectAll()
      .where('id', '=', input.deliverableId)
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
      .updateTable('qa.deliverables')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.requirementId === undefined ? {} : { requirement_id: input.requirementId }),
        ...(input.wbsNodeId === undefined ? {} : { wbs_node_id: input.wbsNodeId }),
        ...(input.dueDate === undefined ? {} : { due_date: input.dueDate })
      })
      .where('id', '=', input.deliverableId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditQaEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'deliverable.updated',
      'deliverable',
      updated.id
    )
    await emitQaResourceChange(
      trx,
      input.organizationId,
      'deliverable',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, deliverable: mapDeliverable(updated) }
  })
}

export type DeliverableTransitionResult =
  | { ok: true; deliverable: DeliverableResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: DeliverableStatus }

// Legal status edges: planned → in_progress (start); in_progress → submitted (submit); submitted →
// accepted (accept, the 검수 of a 산출물) | rejected (reject). accepted/rejected are terminal.
const LEGAL_FROM: Record<DeliverableAction, DeliverableStatus> = {
  start: 'planned',
  submit: 'in_progress',
  accept: 'submitted',
  reject: 'submitted'
}
const TO_STATUS: Record<DeliverableAction, DeliverableStatus> = {
  start: 'in_progress',
  submit: 'submitted',
  accept: 'accepted',
  reject: 'rejected'
}

/** Advances a deliverable's status under OCC (If-Match). Accepting is the load-bearing 검수 step. */
export async function transitionDeliverable(
  db: Kysely<Database>,
  input: {
    organizationId: string
    deliverableId: string
    actorUserId: string
    action: DeliverableAction
    expectedVersion: number
  }
): Promise<DeliverableTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('qa.deliverables')
      .selectAll()
      .where('id', '=', input.deliverableId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as DeliverableStatus
    if (from !== LEGAL_FROM[input.action]) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('qa.deliverables')
      .set({ status: TO_STATUS[input.action], version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.deliverableId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditQaEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `deliverable.${input.action}`,
      'deliverable',
      input.deliverableId
    )
    await emitQaResourceChange(
      trx,
      input.organizationId,
      'deliverable',
      input.deliverableId,
      newVersion,
      'updated'
    )
    return { ok: true, deliverable: mapDeliverable(updated) }
  })
}
