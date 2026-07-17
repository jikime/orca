import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import { emitCollaborationChange, isChannelMemberTx } from './channel-store'
import { enrichMessagesByIdsTx, type MessageResource } from './message-store'
import { withTenantTransaction } from './tenant-transaction'

// Per-channel pin cap (doc 33 §3: "상한 캡"). A member may pin up to this many messages in
// a channel; the (cap+1)th is rejected at create time (never silently dropped).
export const MAX_PINS_PER_CHANNEL = 50

export type PinMessageResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_a_member' | 'already_deleted' | 'cap_exceeded' }

export type UnpinMessageResult = { ok: true } | { ok: false; reason: 'not_a_member' }

// One pinned message in the read model: the shared message summary plus who pinned it and
// when. Most-recent-pin first (doc 33 §3 GET .../pins).
export type PinnedMessage = {
  message: MessageResource
  pinnedBy: string
  pinnedAt: string
}

export type ListPinsResult =
  | { ok: true; pins: PinnedMessage[] }
  | { ok: false; reason: 'channel_not_found' | 'not_a_member' }

/**
 * Pins a message in its channel (doc 33 §3). The actor must be a channel member; the
 * message must exist IN that channel and NOT be a tombstone (a deleted message is not
 * pinnable). Idempotent on (channel, message) via the unique key. Enforces a per-channel
 * cap at create time. Emits a `message` invalidation for the pinned message — a pin changes
 * the message's presentation, so it rides the existing message realtime path (no new
 * transport, mirroring reactions).
 */
export async function pinMessage(
  db: Kysely<Database>,
  input: { organizationId: string; channelId: string; messageId: string; actorUserId: string }
): Promise<PinMessageResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    if (!(await isChannelMemberTx(trx, input.channelId, input.actorUserId))) {
      return { ok: false, reason: 'not_a_member' }
    }
    const message = await trx
      .selectFrom('collaboration.messages')
      .select(['id', 'version', 'deleted_at'])
      .where('id', '=', input.messageId)
      .where('channel_id', '=', input.channelId)
      .executeTakeFirst()
    if (!message) {
      return { ok: false, reason: 'not_found' }
    }
    // Don't pin a tombstone — its body is redacted; pinning it would surface an empty card.
    if (message.deleted_at !== null) {
      return { ok: false, reason: 'already_deleted' }
    }
    // An already-pinned message is idempotently fine and must not count against the cap;
    // only a genuinely new pin is capped. Serialized by the unique-key onConflict below.
    const existing = await trx
      .selectFrom('collaboration.message_pins')
      .select('id')
      .where('channel_id', '=', input.channelId)
      .where('message_id', '=', input.messageId)
      .executeTakeFirst()
    if (!existing) {
      const { count } = await trx
        .selectFrom('collaboration.message_pins')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('channel_id', '=', input.channelId)
        .executeTakeFirstOrThrow()
      if (Number(count) >= MAX_PINS_PER_CHANNEL) {
        return { ok: false, reason: 'cap_exceeded' }
      }
    }
    const inserted = await trx
      .insertInto('collaboration.message_pins')
      .values({
        organization_id: input.organizationId,
        channel_id: input.channelId,
        message_id: input.messageId,
        pinned_by: input.actorUserId
      })
      .onConflict((oc) => oc.columns(['organization_id', 'channel_id', 'message_id']).doNothing())
      .returning('id')
      .executeTakeFirst()
    // Only invalidate when the pin is new (a repeat pin changes nothing).
    if (inserted) {
      await emitPinChange(trx, input.organizationId, input.messageId, message.version)
    }
    return { ok: true }
  })
}

/**
 * Unpins a message (doc 33 §3). Same member-gate as pinMessage. Idempotent — removing an
 * absent pin is a no-op (the route returns 204 either way). Invalidates only when a row was
 * actually removed.
 */
export async function unpinMessage(
  db: Kysely<Database>,
  input: { organizationId: string; channelId: string; messageId: string; actorUserId: string }
): Promise<UnpinMessageResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    if (!(await isChannelMemberTx(trx, input.channelId, input.actorUserId))) {
      return { ok: false, reason: 'not_a_member' }
    }
    const removed = await trx
      .deleteFrom('collaboration.message_pins')
      .where('channel_id', '=', input.channelId)
      .where('message_id', '=', input.messageId)
      .returning('id')
      .executeTakeFirst()
    if (removed) {
      const message = await trx
        .selectFrom('collaboration.messages')
        .select('version')
        .where('id', '=', input.messageId)
        .executeTakeFirst()
      if (message) {
        await emitPinChange(trx, input.organizationId, input.messageId, message.version)
      }
    }
    return { ok: true }
  })
}

/**
 * Lists a channel's pinned messages, most-recent-pin first (doc 33 §3). Member-gated. Each
 * item carries the full message summary (reusing the message read model) plus who pinned it
 * and when. A pin whose message was deleted is cascaded away by the FK, so it never appears.
 */
export async function listPins(
  db: Kysely<Database>,
  organizationId: string,
  channelId: string,
  userId: string
): Promise<ListPinsResult> {
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
    const pinRows = await trx
      .selectFrom('collaboration.message_pins')
      .select(['message_id', 'pinned_by', 'created_at'])
      .where('channel_id', '=', channelId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute()
    const enriched = await enrichMessagesByIdsTx(
      trx,
      pinRows.map((row) => row.message_id),
      userId
    )
    const pins: PinnedMessage[] = []
    for (const row of pinRows) {
      const message = enriched.get(row.message_id)
      if (message) {
        pins.push({
          message,
          pinnedBy: row.pinned_by,
          pinnedAt: new Date(row.created_at).toISOString()
        })
      }
    }
    return { ok: true, pins }
  })
}

// A pin/unpin rides the pinned message's own `message` invalidation (reuse the existing
// resourceType — no new realtime transport). version is the message's live version.
async function emitPinChange(
  trx: Transaction<Database>,
  organizationId: string,
  messageId: string,
  version: string | number
): Promise<void> {
  await emitCollaborationChange(
    trx,
    organizationId,
    'message',
    messageId,
    Number(version),
    'updated'
  )
}
