import { randomUUID } from 'node:crypto'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import { buildResourceChangeCloudEvent } from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

export type CommentVisibility = 'internal' | 'project' | 'customer'

export type CommentResource = {
  id: string
  organizationId: string
  workItemId: string
  authorId: string
  body: string
  visibility: CommentVisibility
  createdAt: string
}

function mapComment(row: {
  id: string
  organization_id: string
  work_item_id: string
  author_id: string
  body: string
  visibility: string
  created_at: Date | string
}): CommentResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workItemId: row.work_item_id,
    authorId: row.author_id,
    body: row.body,
    visibility: row.visibility as CommentVisibility,
    createdAt: new Date(row.created_at).toISOString()
  }
}

async function emitWorkItemInvalidation(
  trx: Transaction<Database>,
  organizationId: string,
  workItemId: string,
  version: number
): Promise<void> {
  const outboxId = randomUUID()
  const occurredAt = new Date().toISOString()
  const cloudEvent = buildResourceChangeCloudEvent({
    organizationId,
    eventId: outboxId,
    resourceType: 'work_item',
    resourceId: workItemId,
    changeKind: 'updated',
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

export type CreateCommentResult =
  | { ok: true; comment: CommentResource }
  | { ok: false; reason: 'work_item_not_found' }

/**
 * Creates a committed comment (doc 27:435 allows a local DRAFT client-side, but the
 * server stores committed ones). One tenant tx: comment row + audit
 * (work_item.commented, so it shows in the item's Activity) + a work_item.updated
 * realtime invalidation — a comment is a child of the work item, so invalidating the
 * work item is the honest minimal signal (no speculative comment event type).
 */
export async function createComment(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    workItemId: string
    body: string
    visibility?: CommentVisibility
  }
): Promise<CreateCommentResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const workItem = await trx
      .selectFrom('delivery.work_items')
      .select('version')
      .where('id', '=', input.workItemId)
      .executeTakeFirst()
    if (!workItem) {
      return { ok: false, reason: 'work_item_not_found' }
    }
    const comment = await trx
      .insertInto('delivery.comments')
      .values({
        organization_id: input.organizationId,
        work_item_id: input.workItemId,
        author_id: input.actorUserId,
        body: input.body,
        visibility: input.visibility ?? 'project'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'work_item.commented',
        target_type: 'work_item',
        target_id: input.workItemId
      })
      .execute()
    await emitWorkItemInvalidation(
      trx,
      input.organizationId,
      input.workItemId,
      Number(workItem.version)
    )
    return { ok: true, comment: mapComment(comment) }
  })
}

/** Lists a work item's comments oldest first. Audience projection (external role →
 *  only customer-visible) is applied by the caller via projectCommentsForAudience. */
export async function listComments(
  db: Kysely<Database>,
  organizationId: string,
  workItemId: string
): Promise<CommentResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('delivery.comments')
      .selectAll()
      .where('work_item_id', '=', workItemId)
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    return rows.map(mapComment)
  })
}
