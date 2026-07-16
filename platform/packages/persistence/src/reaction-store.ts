import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import { emitCollaborationChange, isChannelMemberTx } from './channel-store'
import { withTenantTransaction } from './tenant-transaction'

export type ReactionResult =
  | { ok: true }
  | { ok: false; reason: 'message_not_found' | 'not_a_member' }

async function loadMessageForReaction(
  trx: Transaction<Database>,
  channelId: string,
  messageId: string
): Promise<{ channel_id: string; version: string | number } | null> {
  const row = await trx
    .selectFrom('collaboration.messages')
    .select(['channel_id', 'version'])
    .where('id', '=', messageId)
    .where('channel_id', '=', channelId)
    .executeTakeFirst()
  return row ?? null
}

/**
 * Adds the caller's reaction (a durable fact). Idempotent on (message, user, emoji):
 * a repeat add is a no-op via the PK conflict. Member-gated inside the tx. Emits a
 * message.updated invalidation (the reaction changes the message read model, not its
 * version) — same realtime path as messages, no new plumbing.
 */
export async function addReaction(
  db: Kysely<Database>,
  input: {
    organizationId: string
    channelId: string
    messageId: string
    userId: string
    emoji: string
  }
): Promise<ReactionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const message = await loadMessageForReaction(trx, input.channelId, input.messageId)
    if (!message) {
      return { ok: false, reason: 'message_not_found' }
    }
    if (!(await isChannelMemberTx(trx, input.channelId, input.userId))) {
      return { ok: false, reason: 'not_a_member' }
    }
    const inserted = await trx
      .insertInto('collaboration.message_reactions')
      .values({
        organization_id: input.organizationId,
        message_id: input.messageId,
        user_id: input.userId,
        emoji: input.emoji
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'message_id', 'user_id', 'emoji']).doNothing()
      )
      .returning('emoji')
      .executeTakeFirst()
    // Only audit/invalidate when the fact is new (a repeat add changes nothing).
    if (inserted) {
      await trx
        .insertInto('audit.audit_events')
        .values({
          organization_id: input.organizationId,
          actor_id: input.userId,
          action: 'message.reacted',
          target_type: 'message',
          target_id: input.messageId
        })
        .execute()
      await emitCollaborationChange(
        trx,
        input.organizationId,
        'message',
        input.messageId,
        Number(message.version),
        'updated'
      )
    }
    return { ok: true }
  })
}

/**
 * Removes the caller's reaction. Idempotent — removing an absent reaction is a no-op
 * (the route returns 204 either way). Member-gated. Invalidates only when a row was
 * actually removed.
 */
export async function removeReaction(
  db: Kysely<Database>,
  input: {
    organizationId: string
    channelId: string
    messageId: string
    userId: string
    emoji: string
  }
): Promise<ReactionResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const message = await loadMessageForReaction(trx, input.channelId, input.messageId)
    if (!message) {
      return { ok: false, reason: 'message_not_found' }
    }
    if (!(await isChannelMemberTx(trx, input.channelId, input.userId))) {
      return { ok: false, reason: 'not_a_member' }
    }
    const result = await trx
      .deleteFrom('collaboration.message_reactions')
      .where('message_id', '=', input.messageId)
      .where('user_id', '=', input.userId)
      .where('emoji', '=', input.emoji)
      .executeTakeFirst()
    if (Number(result.numDeletedRows) > 0) {
      await emitCollaborationChange(
        trx,
        input.organizationId,
        'message',
        input.messageId,
        Number(message.version),
        'updated'
      )
    }
    return { ok: true }
  })
}
