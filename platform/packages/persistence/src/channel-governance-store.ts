import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { emitCollaborationChange } from './channel-store'
import { withTenantTransaction } from './tenant-transaction'

const EXPORT_MESSAGE_LIMIT = 10_000
const RETENTION_BATCH_SIZE = 1_000

export type ChannelAuditEntry = {
  id: string
  actorId: string | null
  action: string
  targetType: string
  targetId: string | null
  reason: string | null
  occurredAt: string
}

export type ChannelMessageExport = {
  exportedAt: string
  truncated: boolean
  messages: Array<{
    id: string
    authorId: string
    body: string
    threadRootMessageId: string | null
    createdAt: string
    editedAt: string
    deletedAt: string | null
    deletedBy: string | null
    deletionReason: string | null
  }>
}

export async function listChannelAuditEntries(
  db: Kysely<Database>,
  organizationId: string,
  channelId: string
): Promise<ChannelAuditEntry[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('audit.audit_events')
      .leftJoin(
        'collaboration.messages',
        'collaboration.messages.id',
        'audit.audit_events.target_id'
      )
      .select([
        'audit.audit_events.id',
        'audit.audit_events.actor_id',
        'audit.audit_events.action',
        'audit.audit_events.target_type',
        'audit.audit_events.target_id',
        'audit.audit_events.occurred_at',
        'collaboration.messages.deletion_reason'
      ])
      .where((eb) =>
        eb.or([
          eb.and([
            eb('audit.audit_events.target_type', '=', 'channel'),
            eb('audit.audit_events.target_id', '=', channelId)
          ]),
          eb.and([
            eb('audit.audit_events.target_type', '=', 'message'),
            eb('collaboration.messages.channel_id', '=', channelId)
          ])
        ])
      )
      .orderBy('audit.audit_events.occurred_at', 'desc')
      .limit(200)
      .execute()
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      reason: row.deletion_reason,
      occurredAt: new Date(row.occurred_at).toISOString()
    }))
  })
}

export async function exportChannelMessages(
  db: Kysely<Database>,
  organizationId: string,
  channelId: string
): Promise<ChannelMessageExport> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('collaboration.messages')
      .select([
        'id',
        'author_user_id',
        'body',
        'thread_root_message_id',
        'created_at',
        'updated_at',
        'deleted_at',
        'deleted_by',
        'deletion_reason'
      ])
      .where('channel_id', '=', channelId)
      .orderBy('created_at')
      .orderBy('id')
      .limit(EXPORT_MESSAGE_LIMIT + 1)
      .execute()
    return {
      exportedAt: new Date().toISOString(),
      truncated: rows.length > EXPORT_MESSAGE_LIMIT,
      messages: rows.slice(0, EXPORT_MESSAGE_LIMIT).map((row) => ({
        id: row.id,
        authorId: row.author_user_id,
        body: row.body,
        threadRootMessageId: row.thread_root_message_id,
        createdAt: new Date(row.created_at).toISOString(),
        editedAt: new Date(row.updated_at).toISOString(),
        deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
        deletedBy: row.deleted_by,
        deletionReason: row.deletion_reason
      }))
    }
  })
}

export async function applyChannelRetention(
  db: Kysely<Database>,
  input: { organizationId: string; channelId: string; actorUserId: string | null }
): Promise<{ ok: true; redactedCount: number } | { ok: false; reason: 'not_found' | 'disabled' }> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const channel = await trx
      .selectFrom('collaboration.channels')
      .select(['retention_days', 'version'])
      .where('id', '=', input.channelId)
      .executeTakeFirst()
    if (!channel) return { ok: false, reason: 'not_found' }
    if (!channel.retention_days) return { ok: false, reason: 'disabled' }
    const cutoff = new Date(Date.now() - channel.retention_days * 86_400_000)
    let redactedCount = 0
    while (true) {
      // Bound each mutation so large channels cannot exceed PostgreSQL's parameter limit.
      const expired = await trx
        .selectFrom('collaboration.messages')
        .select('id')
        .where('channel_id', '=', input.channelId)
        .where('created_at', '<', cutoff)
        .where('deleted_at', 'is', null)
        .orderBy('created_at')
        .orderBy('id')
        .limit(RETENTION_BATCH_SIZE)
        .execute()
      const messageIds = expired.map((row) => row.id)
      if (messageIds.length === 0) break
      const mutationAt = new Date()
      await trx
        .updateTable('collaboration.messages')
        .set({
          body: '',
          deleted_at: mutationAt,
          deleted_by: input.actorUserId,
          deletion_reason: 'retention policy',
          version: sql`version + 1`,
          updated_at: mutationAt
        })
        .where('id', 'in', messageIds)
        .execute()
      await trx
        .updateTable('collaboration.message_revisions')
        .set({ body: '' })
        .where('message_id', 'in', messageIds)
        .execute()
      await trx
        .deleteFrom('collaboration.message_pins')
        .where('message_id', 'in', messageIds)
        .execute()
      redactedCount += messageIds.length
    }
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'channel.retention_applied',
        target_type: 'channel',
        target_id: input.channelId,
        after_digest: `redacted:${redactedCount}`
      })
      .execute()
    const newVersion = Number(channel.version) + 1
    await trx
      .updateTable('collaboration.channels')
      .set({ version: newVersion, updated_at: new Date() })
      .where('id', '=', input.channelId)
      .execute()
    await emitCollaborationChange(
      trx,
      input.organizationId,
      'channel',
      input.channelId,
      newVersion,
      'updated'
    )
    return { ok: true, redactedCount }
  })
}
