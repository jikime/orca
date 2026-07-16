import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withTenantUserTransaction } from './tenant-transaction'

export type NotificationType = 'mention'

export type NotificationResource = {
  id: string
  organizationId: string
  userId: string
  type: NotificationType
  channelId: string | null
  messageId: string | null
  seen: boolean
  read: boolean
  createdAt: string
}

function mapNotification(row: {
  id: string
  organization_id: string
  user_id: string
  type: string
  channel_id: string | null
  message_id: string | null
  seen: boolean
  read: boolean
  created_at: Date | string
}): NotificationResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    type: row.type as NotificationType,
    channelId: row.channel_id,
    messageId: row.message_id,
    seen: row.seen,
    read: row.read,
    createdAt: new Date(row.created_at).toISOString()
  }
}

/**
 * Lists the CALLER's own notifications, most recent first. Runs in a per-user tx so
 * the RLS `user_id = pie.user_id` policy restricts the read to their own rows — an
 * org peer can never read another user's inbox. Optional unread-only filter.
 */
export async function listNotifications(
  db: Kysely<Database>,
  organizationId: string,
  userId: string,
  options: { limit?: number; afterId?: string; unreadOnly?: boolean } = {}
): Promise<{ items: NotificationResource[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantUserTransaction(db, organizationId, userId, async (trx) => {
    let query = trx.selectFrom('collaboration.notifications').selectAll()
    if (options.unreadOnly) {
      query = query.where('read', '=', false)
    }
    if (options.afterId) {
      query = query.where(
        sql<boolean>`(created_at, id) < (select created_at, id from collaboration.notifications where id = ${options.afterId})`
      )
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute()
    const items = rows.map(mapNotification)
    const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null
    return { items, nextCursor }
  })
}

export type MarkNotificationReadResult =
  | { ok: true; notification: NotificationResource }
  | { ok: false; reason: 'not_found' }

/** Marks ONE of the caller's own notifications read (idempotent). RLS ensures a
 *  caller can only touch their own — a foreign id simply matches no row. */
export async function markNotificationRead(
  db: Kysely<Database>,
  organizationId: string,
  userId: string,
  notificationId: string
): Promise<MarkNotificationReadResult> {
  return withTenantUserTransaction(db, organizationId, userId, async (trx) => {
    const updated = await trx
      .updateTable('collaboration.notifications')
      .set({ read: true, seen: true })
      .where('id', '=', notificationId)
      .returningAll()
      .executeTakeFirst()
    return updated
      ? { ok: true, notification: mapNotification(updated) }
      : { ok: false, reason: 'not_found' }
  })
}

/** Marks ALL of the caller's own unread notifications read; returns the count. */
export async function markAllNotificationsRead(
  db: Kysely<Database>,
  organizationId: string,
  userId: string
): Promise<number> {
  return withTenantUserTransaction(db, organizationId, userId, async (trx) => {
    const result = await trx
      .updateTable('collaboration.notifications')
      .set({ read: true, seen: true })
      .where('read', '=', false)
      .executeTakeFirst()
    return Number(result.numUpdatedRows)
  })
}
