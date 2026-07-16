import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { emitCollaborationChange, isChannelMemberTx } from './channel-store'
import { withTenantTransaction } from './tenant-transaction'

export type MessageVisibility = 'internal' | 'project' | 'customer'

export type MessageResource = {
  id: string
  organizationId: string
  channelId: string
  authorId: string
  body: string
  visibility: MessageVisibility
  version: number
  createdAt: string
}

function mapMessage(row: {
  id: string
  organization_id: string
  channel_id: string
  author_user_id: string
  body: string
  visibility: string
  version: string | number
  created_at: Date | string
}): MessageResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    channelId: row.channel_id,
    authorId: row.author_user_id,
    body: row.body,
    visibility: row.visibility as MessageVisibility,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString()
  }
}

export type PostMessageResult =
  | { ok: true; message: MessageResource }
  | { ok: false; reason: 'channel_not_found' | 'not_a_member' }

/**
 * Posts a message. The channel-roster gate runs INSIDE the transaction (atomic with
 * the insert — no TOCTOU): a non-member is rejected before any write. One tenant tx:
 * message row + audit + outbox message.created → the thin realtime invalidation.
 */
export async function postMessage(
  db: Kysely<Database>,
  input: {
    organizationId: string
    channelId: string
    authorUserId: string
    body: string
    visibility?: MessageVisibility
  }
): Promise<PostMessageResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const channel = await trx
      .selectFrom('collaboration.channels')
      .select('id')
      .where('id', '=', input.channelId)
      .executeTakeFirst()
    if (!channel) {
      return { ok: false, reason: 'channel_not_found' }
    }
    if (!(await isChannelMemberTx(trx, input.channelId, input.authorUserId))) {
      return { ok: false, reason: 'not_a_member' }
    }
    const message = await trx
      .insertInto('collaboration.messages')
      .values({
        organization_id: input.organizationId,
        channel_id: input.channelId,
        author_user_id: input.authorUserId,
        body: input.body,
        visibility: input.visibility ?? 'internal'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.authorUserId,
        action: 'message.created',
        target_type: 'message',
        target_id: message.id
      })
      .execute()
    await emitCollaborationChange(trx, input.organizationId, 'message', message.id, 1, 'created')
    return { ok: true, message: mapMessage(message) }
  })
}

/** Fetches one message by id (used for idempotent-replay of postMessage). */
export async function getMessage(
  db: Kysely<Database>,
  organizationId: string,
  messageId: string
): Promise<MessageResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('collaboration.messages')
      .selectAll()
      .where('id', '=', messageId)
      .executeTakeFirst()
    return row ? mapMessage(row) : null
  })
}

export type ListMessagesResult =
  | { ok: true; messages: MessageResource[]; nextCursor: string | null }
  | { ok: false; reason: 'channel_not_found' | 'not_a_member' }

/**
 * Lists a channel's messages oldest first, keyset-paginated by (created_at, id) —
 * the cursor is the last message id (NOT a stream sequence). Member-gated.
 */
export async function listChannelMessages(
  db: Kysely<Database>,
  organizationId: string,
  channelId: string,
  userId: string,
  options: { limit?: number; afterMessageId?: string } = {}
): Promise<ListMessagesResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    const channel = await trx
      .selectFrom('collaboration.channels')
      .select('id')
      .where('id', '=', channelId)
      .executeTakeFirst()
    if (!channel) {
      return { ok: false, reason: 'channel_not_found' }
    }
    if (!(await isChannelMemberTx(trx, channelId, userId))) {
      return { ok: false, reason: 'not_a_member' }
    }
    let query = trx
      .selectFrom('collaboration.messages')
      .selectAll()
      .where('channel_id', '=', channelId)
    if (options.afterMessageId) {
      // Keyset: rows after the cursor message, comparing (created_at, id) tuples
      // entirely in SQL so the cursor's microsecond timestamp keeps full precision
      // (a JS Date round-trip truncates to ms and re-includes the cursor row).
      query = query.where(
        sql<boolean>`(created_at, id) > (select created_at, id from collaboration.messages where id = ${options.afterMessageId})`
      )
    }
    const rows = await query.orderBy('created_at').orderBy('id').limit(limit).execute()
    const messages = rows.map(mapMessage)
    const nextCursor =
      messages.length === limit ? (messages[messages.length - 1]?.id ?? null) : null
    return { ok: true, messages, nextCursor }
  })
}
