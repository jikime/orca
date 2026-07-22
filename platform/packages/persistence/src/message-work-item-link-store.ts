import type { Kysely } from 'kysely'
import { emitCollaborationChange, isChannelMemberTx } from './channel-store'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'
import {
  createWorkItemTx,
  getWorkItemTx,
  type WorkItemPriority,
  type WorkItemResource
} from './work-item-store'

// The work-item title upper bound (contract work-item-create.v1: title maxLength 500). A
// title derived from a message body is truncated to this so the reused createWorkItem path
// never rejects an over-long derived title.
const WORK_ITEM_TITLE_MAX = 500
// Fallback when a message body yields no usable title (should not happen for a live message,
// but a create needs a non-empty title — the contract requires minLength 1).
const FALLBACK_TITLE = 'Converted chat message'

export type ConvertMessageToWorkItemResult =
  | { ok: true; workItem: WorkItemResource; linkId: string; created: boolean }
  | {
      ok: false
      reason:
        | 'source_not_found'
        | 'source_forbidden'
        | 'source_deleted'
        | 'team_not_found'
        | 'invalid_state'
        | 'project_not_found'
    }

function deriveTitle(provided: string | undefined, body: string): string {
  const fromInput = provided?.trim()
  if (fromInput) {
    return fromInput.slice(0, WORK_ITEM_TITLE_MAX)
  }
  const fromBody = body.trim()
  if (fromBody) {
    return fromBody.slice(0, WORK_ITEM_TITLE_MAX)
  }
  return FALLBACK_TITLE
}

// The description carries a stable back-reference to the source conversation (doc 33 §4:
// "이 대화에서 생성됨") so the work item records where it came from even though the link row
// is the machine-readable tie.
function buildDescription(channelId: string, messageId: string, body: string): string {
  const excerpt = body.trim()
  const origin = `Converted from chat message ${messageId} in channel ${channelId}.`
  return excerpt ? `${origin}\n\n${excerpt}` : origin
}

/**
 * Converts a chat message into a delivery work item and records the link (doc 33 §4). The
 * WHOLE conversion runs in ONE org tenant transaction: the source-message checks, the work
 * item create (via the shared createWorkItemTx, so the identifier/counter path is never
 * forked), and the link insert all commit together — a failure at any step leaves neither a
 * work item nor a link (no orphan). Because create and link share the tx they carry the
 * identical organization_id, which is the same-org integrity that stands in for the absent
 * cross-schema FK on work_item_id.
 *
 * The dual-permission gate (message.read on the source, work_item.create on the target) is
 * enforced at the ROUTE; the store additionally enforces channel membership on the source.
 * The source message row is locked before checking its existing binding. This makes the
 * source identity, rather than a caller-generated retry key, the final duplicate barrier.
 */
export async function convertMessageToWorkItem(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    channelId: string
    messageId: string
    teamId: string
    projectId?: string | null
    title?: string
    priority?: WorkItemPriority
    assigneeId?: string | null
  }
): Promise<ConvertMessageToWorkItemResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    // (a) The source message must exist in this channel; the actor must be a channel member
    // (a non-member must not convert a message they cannot read), and a tombstone is not
    // convertible.
    const message = await trx
      .selectFrom('collaboration.messages')
      .select(['id', 'body', 'version', 'deleted_at'])
      .where('id', '=', input.messageId)
      .where('channel_id', '=', input.channelId)
      .forUpdate()
      .executeTakeFirst()
    if (!message) {
      return { ok: false, reason: 'source_not_found' }
    }
    if (!(await isChannelMemberTx(trx, input.channelId, input.actorUserId))) {
      return { ok: false, reason: 'source_forbidden' }
    }
    if (message.deleted_at !== null) {
      return { ok: false, reason: 'source_deleted' }
    }
    const existingLinks = await trx
      .selectFrom('collaboration.message_work_item_links')
      .select(['id', 'work_item_id'])
      .where('message_id', '=', input.messageId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute()
    for (const existingLink of existingLinks) {
      const existingWorkItem = await getWorkItemTx(trx, existingLink.work_item_id)
      if (existingWorkItem) {
        return {
          ok: true,
          workItem: existingWorkItem,
          linkId: existingLink.id,
          created: false
        }
      }
      // Why: the cross-schema id is intentionally not an FK; discard a stale
      // binding before recreating so the source never stays permanently broken.
      await trx
        .deleteFrom('collaboration.message_work_item_links')
        .where('id', '=', existingLink.id)
        .execute()
    }
    // (b) Create the work item on the shared identifier/counter path. Its failure reasons
    // propagate unchanged so the route can map them (team_not_found, invalid_state,
    // project_not_found).
    const created = await createWorkItemTx(trx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      teamId: input.teamId,
      projectId: input.projectId ?? null,
      title: deriveTitle(input.title, message.body),
      description: buildDescription(input.channelId, input.messageId, message.body),
      priority: input.priority,
      assigneeId: input.assigneeId ?? null
    })
    if (!created.ok) {
      return created
    }
    // (c) Record the link. onConflict doNothing makes a same-key replay idempotent; the
    // returning may be empty on a repeat, so we re-read the existing link id.
    const inserted = await trx
      .insertInto('collaboration.message_work_item_links')
      .values({
        organization_id: input.organizationId,
        message_id: input.messageId,
        work_item_id: created.workItem.id,
        created_by: input.actorUserId
      })
      .onConflict((oc) => oc.columns(['organization_id', 'message_id', 'work_item_id']).doNothing())
      .returning('id')
      .executeTakeFirst()
    let linkId = inserted?.id
    if (!linkId) {
      const existing = await trx
        .selectFrom('collaboration.message_work_item_links')
        .select('id')
        .where('message_id', '=', input.messageId)
        .where('work_item_id', '=', created.workItem.id)
        .executeTakeFirstOrThrow()
      linkId = existing.id
    }
    // (d) The source message re-renders with its new "converted" reference — rides the
    // existing message invalidation (no new transport), like a reaction or a pin.
    await emitCollaborationChange(
      trx,
      input.organizationId,
      'message',
      input.messageId,
      Number(message.version),
      'updated'
    )
    return { ok: true, workItem: created.workItem, linkId, created: true }
  })
}

export type MessageWorkItemLink = {
  linkId: string
  workItemId: string
  createdBy: string
  createdAt: string
}

/**
 * Lists the work items a message has been converted into, most-recent link first (doc 33
 * §4: a message shows "created WORK-123"). Cheap and additive — a separate read rather than
 * inflating the message enrichment path. Scoped to the org tenant; the route gates on
 * channel membership before calling this.
 */
export async function listWorkItemLinksForMessage(
  db: Kysely<Database>,
  organizationId: string,
  messageId: string
): Promise<MessageWorkItemLink[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('collaboration.message_work_item_links')
      .select(['id', 'work_item_id', 'created_by', 'created_at'])
      .where('message_id', '=', messageId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute()
    return rows.map((row) => ({
      linkId: row.id,
      workItemId: row.work_item_id,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at).toISOString()
    }))
  })
}
