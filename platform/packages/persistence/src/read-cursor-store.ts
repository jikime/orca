import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { isChannelMemberTx } from './channel-store'
import { withTenantTransaction } from './tenant-transaction'

export type ReadCursorResource = {
  organizationId: string
  channelId: string
  userId: string
  lastReadMessageId: string | null
  lastReadAt: string
}

function mapReadCursor(row: {
  organization_id: string
  channel_id: string
  user_id: string
  last_read_message_id: string | null
  last_read_at: Date | string
}): ReadCursorResource {
  return {
    organizationId: row.organization_id,
    channelId: row.channel_id,
    userId: row.user_id,
    lastReadMessageId: row.last_read_message_id,
    lastReadAt: new Date(row.last_read_at).toISOString()
  }
}

export type MarkReadResult =
  | { ok: true; cursor: ReadCursorResource }
  | { ok: false; reason: 'channel_not_found' | 'not_a_member' | 'message_not_found' }

/**
 * Advances the caller's OWN read cursor in a channel to a message id (doc 08 읽음).
 * Keyed by message id, never by a stream sequence. Member-gated, and the target
 * message must belong to the channel. Upsert on (org, channel, user).
 */
export async function markChannelRead(
  db: Kysely<Database>,
  input: {
    organizationId: string
    channelId: string
    userId: string
    lastReadMessageId: string
  }
): Promise<MarkReadResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const channel = await trx
      .selectFrom('collaboration.channels')
      .select('id')
      .where('id', '=', input.channelId)
      .executeTakeFirst()
    if (!channel) {
      return { ok: false, reason: 'channel_not_found' }
    }
    if (!(await isChannelMemberTx(trx, input.channelId, input.userId))) {
      return { ok: false, reason: 'not_a_member' }
    }
    const message = await trx
      .selectFrom('collaboration.messages')
      .select('id')
      .where('id', '=', input.lastReadMessageId)
      .where('channel_id', '=', input.channelId)
      .executeTakeFirst()
    if (!message) {
      return { ok: false, reason: 'message_not_found' }
    }
    const cursor = await trx
      .insertInto('collaboration.read_cursors')
      .values({
        organization_id: input.organizationId,
        channel_id: input.channelId,
        user_id: input.userId,
        last_read_message_id: input.lastReadMessageId
      })
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'channel_id', 'user_id'])
          .doUpdateSet({ last_read_message_id: input.lastReadMessageId, last_read_at: sql`now()` })
      )
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ok: true, cursor: mapReadCursor(cursor) }
  })
}

/** Reads the caller's own cursor for a channel, or null if never set. */
export async function getReadCursor(
  db: Kysely<Database>,
  organizationId: string,
  channelId: string,
  userId: string
): Promise<ReadCursorResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('collaboration.read_cursors')
      .selectAll()
      .where('channel_id', '=', channelId)
      .where('user_id', '=', userId)
      .executeTakeFirst()
    return row ? mapReadCursor(row) : null
  })
}
