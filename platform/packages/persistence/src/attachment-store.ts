import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import { isChannelMemberTx } from './channel-store'
import { withTenantTransaction } from './tenant-transaction'

export type AttachmentSummary = {
  id: string
  filename: string
  contentType: string
  byteSize: number
}

export type CreateAttachmentIntentResult =
  | { ok: true; attachmentId: string }
  | { ok: false; reason: 'channel_not_found' | 'not_a_member' }

/**
 * Records a PENDING attachment for a channel (message_id NULL) after the caller's
 * membership is confirmed in-tx. The storage_key is server-derived by the caller via
 * the tenant key-builder (the client never supplies a path). The client PUTs the
 * bytes to the presigned URL out of band; a later post finalizes + links it.
 */
export async function createAttachmentIntent(
  db: Kysely<Database>,
  input: {
    organizationId: string
    channelId: string
    userId: string
    objectId: string
    storageKey: string
    filename: string
    contentType: string
    byteSize: number
  }
): Promise<CreateAttachmentIntentResult> {
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
    const row = await trx
      .insertInto('collaboration.message_attachments')
      .values({
        organization_id: input.organizationId,
        channel_id: input.channelId,
        object_id: input.objectId,
        storage_key: input.storageKey,
        filename: input.filename,
        content_type: input.contentType,
        byte_size: input.byteSize,
        status: 'pending'
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { ok: true, attachmentId: row.id }
  })
}

/** A pending attachment's storage facts (for the post route to HEAD-verify + gate to
 *  the right channel before linking). Null if it doesn't exist. */
export async function getPendingAttachment(
  db: Kysely<Database>,
  organizationId: string,
  attachmentId: string
): Promise<{ channelId: string; storageKey: string; byteSize: number; status: string } | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('collaboration.message_attachments')
      .select(['channel_id', 'storage_key', 'byte_size', 'status'])
      .where('id', '=', attachmentId)
      .executeTakeFirst()
    return row
      ? {
          channelId: row.channel_id,
          storageKey: row.storage_key,
          byteSize: Number(row.byte_size),
          status: row.status
        }
      : null
  })
}

/**
 * Links pending attachments to a message inside the post transaction: each must be a
 * PENDING attachment of THIS channel. Returns true only if ALL linked (else the caller
 * rolls back), so a message can't reference a foreign or already-used attachment.
 */
export async function linkAttachmentsTx(
  trx: Transaction<Database>,
  channelId: string,
  messageId: string,
  attachmentIds: readonly string[]
): Promise<boolean> {
  for (const attachmentId of attachmentIds) {
    const updated = await trx
      .updateTable('collaboration.message_attachments')
      .set({ message_id: messageId, status: 'linked' })
      .where('id', '=', attachmentId)
      .where('channel_id', '=', channelId)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst()
    if (!updated) {
      return false
    }
  }
  return true
}

/** Attachment summaries (no storage key) grouped by message id, for the message read
 *  model. The download URL is fetched separately via the member-gated endpoint. */
export async function attachmentSummariesForMessages(
  trx: Transaction<Database>,
  messageIds: readonly string[]
): Promise<Map<string, AttachmentSummary[]>> {
  const byMessage = new Map<string, AttachmentSummary[]>()
  if (messageIds.length === 0) {
    return byMessage
  }
  const rows = await trx
    .selectFrom('collaboration.message_attachments')
    .select(['id', 'message_id', 'filename', 'content_type', 'byte_size'])
    .where('message_id', 'in', messageIds)
    .where('status', '=', 'linked')
    .orderBy('created_at')
    .execute()
  for (const row of rows) {
    if (!row.message_id) continue
    const list = byMessage.get(row.message_id) ?? []
    list.push({
      id: row.id,
      filename: row.filename,
      contentType: row.content_type,
      byteSize: Number(row.byte_size)
    })
    byMessage.set(row.message_id, list)
  }
  return byMessage
}

export type AttachmentDownloadResult =
  | { ok: true; storageKey: string; filename: string; contentType: string }
  | { ok: false; reason: 'not_found' | 'not_a_member' }

/** Resolves an attachment for download, gated on the caller's membership of the
 *  attachment's channel — so a short-lived URL is only issued to a current member. */
export async function getAttachmentForDownload(
  db: Kysely<Database>,
  organizationId: string,
  attachmentId: string,
  userId: string
): Promise<AttachmentDownloadResult> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('collaboration.message_attachments')
      .select(['channel_id', 'storage_key', 'filename', 'content_type'])
      .where('id', '=', attachmentId)
      .where('status', '=', 'linked')
      .executeTakeFirst()
    if (!row) {
      return { ok: false, reason: 'not_found' }
    }
    if (!(await isChannelMemberTx(trx, row.channel_id, userId))) {
      return { ok: false, reason: 'not_a_member' }
    }
    return {
      ok: true,
      storageKey: row.storage_key,
      filename: row.filename,
      contentType: row.content_type
    }
  })
}
