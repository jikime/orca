import { sql, type Kysely } from 'kysely'
import { auditAutomationEvent, emitAutomationResourceChange } from './automation-resource-events'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// A unit of work in the operator queue. :claim (queued → claimed) sets the assignee; :transition
// walks the remaining status edges. subject_id is the OPAQUE id of what it tracks (e.g. a
// runbook_execution).

export type WorkQueueStatus = 'queued' | 'claimed' | 'in_progress' | 'done' | 'cancelled'
export type WorkQueuePriority = 'low' | 'normal' | 'high' | 'urgent'

export type WorkQueueItemResource = {
  id: string
  organizationId: string
  title: string
  description: string | null
  kind: string
  subjectId: string | null
  status: WorkQueueStatus
  assigneeUserId: string | null
  priority: WorkQueuePriority
  version: number
  createdAt: string
  updatedAt: string
}

type WorkQueueItemRow = {
  id: string
  organization_id: string
  title: string
  description: string | null
  kind: string
  subject_id: string | null
  status: string
  assignee_user_id: string | null
  priority: string
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapItem(row: WorkQueueItemRow): WorkQueueItemResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    subjectId: row.subject_id,
    status: row.status as WorkQueueStatus,
    assigneeUserId: row.assignee_user_id,
    priority: row.priority as WorkQueuePriority,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateWorkQueueItemInput = {
  organizationId: string
  actorUserId: string
  title: string
  description?: string | null
  kind: string
  subjectId?: string | null
  priority?: WorkQueuePriority
}

export async function createWorkQueueItem(
  db: Kysely<Database>,
  input: CreateWorkQueueItemInput
): Promise<WorkQueueItemResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('automation.work_queue_items')
      .values({
        organization_id: input.organizationId,
        title: input.title,
        description: input.description ?? null,
        kind: input.kind,
        subject_id: input.subjectId ?? null,
        priority: input.priority ?? 'normal'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditAutomationEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'automation.workqueue.created',
      'work_queue_item',
      row.id
    )
    await emitAutomationResourceChange(
      trx,
      input.organizationId,
      'work_queue_item',
      row.id,
      1,
      'created'
    )
    return mapItem(row)
  })
}

export async function getWorkQueueItem(
  db: Kysely<Database>,
  organizationId: string,
  itemId: string
): Promise<WorkQueueItemResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('automation.work_queue_items')
      .selectAll()
      .where('id', '=', itemId)
      .executeTakeFirst()
    return row ? mapItem(row) : null
  })
}

export type WorkQueuePage = { items: WorkQueueItemResource[]; nextCursor: string | null }

export async function listWorkQueueItems(
  db: Kysely<Database>,
  organizationId: string,
  options: { limit?: number; cursor?: string | null; status?: WorkQueueStatus } = {}
): Promise<WorkQueuePage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('automation.work_queue_items')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.status) {
      query = query.where('status', '=', options.status)
    }
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapItem), nextCursor }
  })
}

export type WorkQueueTransitionResult =
  | { ok: true; item: WorkQueueItemResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: WorkQueueStatus }

// Legal status edges. :claim is queued → claimed (a dedicated verb because it also sets the
// assignee); the rest walk forward or cancel.
const LEGAL_EDGES: Record<WorkQueueStatus, WorkQueueStatus[]> = {
  queued: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'queued', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: [],
  cancelled: []
}

export type ClaimWorkQueueItemInput = {
  organizationId: string
  itemId: string
  actorUserId: string
  expectedVersion: number
}

/** Claims a queued item: queued → claimed, recording the actor as assignee. OCC-guarded. */
export async function claimWorkQueueItem(
  db: Kysely<Database>,
  input: ClaimWorkQueueItemInput
): Promise<WorkQueueTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('automation.work_queue_items')
      .selectAll()
      .where('id', '=', input.itemId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as WorkQueueStatus
    if (!LEGAL_EDGES[from].includes('claimed')) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('automation.work_queue_items')
      .set({
        status: 'claimed',
        assignee_user_id: input.actorUserId,
        version: newVersion,
        updated_at: sql`now()`
      })
      .where('id', '=', input.itemId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditAutomationEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      'automation.workqueue.claimed',
      'work_queue_item',
      updated.id
    )
    await emitAutomationResourceChange(
      trx,
      input.organizationId,
      'work_queue_item',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, item: mapItem(updated) }
  })
}

export type TransitionWorkQueueItemInput = {
  organizationId: string
  itemId: string
  actorUserId: string
  expectedVersion: number
  toStatus: WorkQueueStatus
}

/** Moves an item along a legal status edge (excluding :claim). OCC-guarded. */
export async function transitionWorkQueueItem(
  db: Kysely<Database>,
  input: TransitionWorkQueueItemInput
): Promise<WorkQueueTransitionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('automation.work_queue_items')
      .selectAll()
      .where('id', '=', input.itemId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.status as WorkQueueStatus
    if (!LEGAL_EDGES[from].includes(input.toStatus)) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('automation.work_queue_items')
      .set({ status: input.toStatus, version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.itemId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditAutomationEvent(
      trx,
      input.organizationId,
      input.actorUserId,
      `automation.workqueue.${input.toStatus}`,
      'work_queue_item',
      updated.id
    )
    await emitAutomationResourceChange(
      trx,
      input.organizationId,
      'work_queue_item',
      updated.id,
      newVersion,
      'updated'
    )
    return { ok: true, item: mapItem(updated) }
  })
}
