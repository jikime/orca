import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  attachmentSummariesForMessages,
  linkAttachmentsTx,
  type AttachmentSummary
} from './attachment-store'
import type { Database } from './database-schema'
import { emitCollaborationChange, isChannelMemberTx } from './channel-store'
import { mutedUserIdsForChannelTx } from './channel-mute-store'
import { withTenantTransaction } from './tenant-transaction'

export type MessageVisibility = 'internal' | 'project' | 'customer'

export type ReactionSummary = { emoji: string; count: number; reactedByMe: boolean }

export type MessageResource = {
  id: string
  organizationId: string
  channelId: string
  authorId: string
  body: string
  visibility: MessageVisibility
  version: number
  threadRootMessageId: string | null
  replyCount: number
  reactions: ReactionSummary[]
  attachments: AttachmentSummary[]
  createdAt: string
  // Edit/tombstone markers (doc 33 §1·2). edited==an edit history exists;
  // deleted==a redacted tombstone (body is '', audit metadata retained).
  edited: boolean
  revisionCount: number
  deleted: boolean
  deletedAt: string | null
  deletedBy: string | null
  deletionReason: string | null
}

type MessageRow = {
  id: string
  organization_id: string
  channel_id: string
  author_user_id: string
  body: string
  visibility: string
  version: string | number
  thread_root_message_id: string | null
  deleted_at: Date | string | null
  deleted_by: string | null
  deletion_reason: string | null
  created_at: Date | string
}

function mapMessage(
  row: MessageRow,
  replyCount: number,
  reactions: ReactionSummary[],
  attachments: AttachmentSummary[],
  revisionCount = 0
): MessageResource {
  const deleted = row.deleted_at !== null
  return {
    id: row.id,
    organizationId: row.organization_id,
    channelId: row.channel_id,
    authorId: row.author_user_id,
    body: row.body,
    visibility: row.visibility as MessageVisibility,
    version: Number(row.version),
    threadRootMessageId: row.thread_root_message_id,
    replyCount,
    reactions,
    attachments,
    createdAt: new Date(row.created_at).toISOString(),
    edited: revisionCount > 0,
    revisionCount,
    deleted,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    deletedBy: row.deleted_by,
    deletionReason: row.deletion_reason
  }
}

/**
 * Attaches the read-model extras (reply count per root, reactions summary with
 * reactedByMe) to a page of messages. Both are computed per read rather than
 * denormalized — a hot-path counter is a later optimization.
 */
async function enrichMessages(
  trx: Transaction<Database>,
  rows: MessageRow[],
  userId: string
): Promise<MessageResource[]> {
  if (rows.length === 0) {
    return []
  }
  const ids = rows.map((row) => row.id)
  const replyRows = await trx
    .selectFrom('collaboration.messages')
    .select(['thread_root_message_id', sql<string>`count(*)`.as('count')])
    .where('thread_root_message_id', 'in', ids)
    .groupBy('thread_root_message_id')
    .execute()
  const replyCounts = new Map<string, number>()
  for (const row of replyRows) {
    if (row.thread_root_message_id) replyCounts.set(row.thread_root_message_id, Number(row.count))
  }
  const reactionRows = await trx
    .selectFrom('collaboration.message_reactions')
    .select([
      'message_id',
      'emoji',
      sql<string>`count(*)`.as('count'),
      sql<boolean>`bool_or(user_id = ${userId})`.as('reacted_by_me')
    ])
    .where('message_id', 'in', ids)
    .groupBy(['message_id', 'emoji'])
    .orderBy('emoji')
    .execute()
  const reactionsByMessage = new Map<string, ReactionSummary[]>()
  for (const row of reactionRows) {
    const list = reactionsByMessage.get(row.message_id) ?? []
    list.push({ emoji: row.emoji, count: Number(row.count), reactedByMe: row.reacted_by_me })
    reactionsByMessage.set(row.message_id, list)
  }
  const attachmentsByMessage = await attachmentSummariesForMessages(trx, ids)
  // Edit history size per message → the "(edited)" marker. Counted per read (a hot-path
  // denormalized counter is a later optimization, mirroring reply/reaction counts).
  const revisionRows = await trx
    .selectFrom('collaboration.message_revisions')
    .select(['message_id', sql<string>`count(*)`.as('count')])
    .where('message_id', 'in', ids)
    .groupBy('message_id')
    .execute()
  const revisionCounts = new Map<string, number>()
  for (const row of revisionRows) {
    revisionCounts.set(row.message_id, Number(row.count))
  }
  return rows.map((row) =>
    mapMessage(
      row,
      replyCounts.get(row.id) ?? 0,
      reactionsByMessage.get(row.id) ?? [],
      attachmentsByMessage.get(row.id) ?? [],
      revisionCounts.get(row.id) ?? 0
    )
  )
}

export type PostMessageResult =
  | { ok: true; message: MessageResource }
  | {
      ok: false
      reason: 'channel_not_found' | 'not_a_member' | 'invalid_thread_root' | 'invalid_attachment'
    }

// pino-compatible subset: lets the route pass its request logger so a large-channel
// @channel truncation is recorded, never silent.
export type MentionLogger = { warn: (fields: Record<string, unknown>, message?: string) => void }

// Cap on @channel fan-out: a very large channel could otherwise turn one post into a
// notification storm. Truncation is LOGGED (never silent); members are ordered so the
// kept slice is deterministic.
const CHANNEL_MENTION_CAP = 1000

/**
 * The @channel target set: every current roster member EXCEPT the author (never
 * self-notify via a group scope). Capped at CHANNEL_MENTION_CAP with a logged warning
 * naming how many were dropped.
 */
async function channelMemberMentionTargets(
  trx: Transaction<Database>,
  channelId: string,
  authorUserId: string,
  logger?: MentionLogger
): Promise<string[]> {
  const rows = await trx
    .selectFrom('collaboration.channel_members')
    .select('user_id')
    .where('channel_id', '=', channelId)
    .where('user_id', '!=', authorUserId)
    .orderBy('user_id')
    .execute()
  if (rows.length <= CHANNEL_MENTION_CAP) {
    return rows.map((row) => row.user_id)
  }
  logger?.warn(
    {
      event: 'mention.channel.truncated',
      channelId,
      members: rows.length,
      cap: CHANNEL_MENTION_CAP,
      dropped: rows.length - CHANNEL_MENTION_CAP
    },
    '@channel mention truncated'
  )
  return rows.slice(0, CHANNEL_MENTION_CAP).map((row) => row.user_id)
}

/**
 * A mention target set split by PROVENANCE, so the resolver can apply channel mute:
 *  - explicit: names the user deliberately typed (@user). ALWAYS notifies, even muted.
 *  - broadcast: users swept up by a group scope (@channel ∪ @here). Suppressed for a
 *    user who has MUTED the channel (mute kills group noise, not direct pings).
 */
type MentionTargets = { explicit: readonly string[]; broadcast: readonly string[] }

/**
 * Resolves the message's mentions ONCE at post time (never recomputed on edit): each
 * mentioned user must be a channel member; non-members are silently dropped. Writes
 * a message_mentions row and a durable per-user notification (+ its own realtime
 * invalidation) for each valid mention — all inside the caller's message tx.
 *
 * Channel mute is applied here by PROVENANCE: a direct @mention (explicit) always
 * pierces a mute, while a user reached ONLY by a broadcast (@channel/@here) who has
 * muted the channel is dropped from BOTH the notification and the message_mentions row
 * (they were never individually pinged, only swept up). Dedup keeps one row per user:
 * a user in both scopes is notified via the explicit path and never double-counted.
 */
async function resolveMentions(
  trx: Transaction<Database>,
  organizationId: string,
  channelId: string,
  messageId: string,
  targets: MentionTargets
): Promise<void> {
  const explicit = new Set(targets.explicit)
  // Broadcast-only = reached solely by a group scope (not also a deliberate direct ping).
  const broadcastOnly = [...new Set(targets.broadcast)].filter((id) => !explicit.has(id))
  const muted = await mutedUserIdsForChannelTx(trx, channelId, broadcastOnly)
  // Single notify set: every explicit target + broadcast-only targets that are NOT muted.
  // The two inputs are disjoint and each deduped, so no user appears twice.
  const notifiable = [...explicit, ...broadcastOnly.filter((id) => !muted.has(id))]
  for (const mentionedUserId of notifiable) {
    if (!(await isChannelMemberTx(trx, channelId, mentionedUserId))) {
      continue
    }
    await trx
      .insertInto('collaboration.message_mentions')
      .values({
        organization_id: organizationId,
        message_id: messageId,
        mentioned_user_id: mentionedUserId
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'message_id', 'mentioned_user_id']).doNothing()
      )
      .execute()
    // Explicit id + no RETURNING: the per-user SELECT policy would hide a row this
    // (poster) tx has no pie.user_id for.
    const notificationId = randomUUID()
    await trx
      .insertInto('collaboration.notifications')
      .values({
        organization_id: organizationId,
        id: notificationId,
        user_id: mentionedUserId,
        type: 'mention',
        channel_id: channelId,
        message_id: messageId
      })
      .execute()
    await emitCollaborationChange(trx, organizationId, 'notification', notificationId, 1, 'created')
  }
}

/**
 * Posts a message (optionally a thread reply, optionally with mentions). A reply's
 * threadRootMessageId must be a ROOT in the SAME channel; the roster gate runs inside
 * the tx (no TOCTOU). One tenant tx: message + mentions + per-user notifications +
 * audit + outbox message.created → the same thin realtime invalidation.
 */
export async function postMessage(
  db: Kysely<Database>,
  input: {
    organizationId: string
    channelId: string
    authorUserId: string
    body: string
    visibility?: MessageVisibility
    threadRootMessageId?: string
    mentions?: readonly string[]
    // @channel: server-resolve a durable mention to every channel member (except author).
    mentionChannel?: boolean
    // @here: mention channel members currently present on the gateway. presentUserIds is
    // the route-supplied per-node present set (in-process gateway read); non-members and
    // the author are dropped by the shared member-gated mention path.
    mentionHere?: boolean
    presentUserIds?: readonly string[]
    logger?: MentionLogger
    // Ids of PENDING attachment intents (already uploaded + HEAD-verified by the
    // route) to link to this message. Each must be a pending attachment of THIS channel.
    attachmentIds?: readonly string[]
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
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      // Pre-check (read) so a bad attachment is a clean 422 before the message row.
      const pending = await trx
        .selectFrom('collaboration.message_attachments')
        .select('id')
        .where('id', 'in', input.attachmentIds)
        .where('channel_id', '=', input.channelId)
        .where('status', '=', 'pending')
        .execute()
      if (pending.length !== new Set(input.attachmentIds).size) {
        return { ok: false, reason: 'invalid_attachment' }
      }
    }
    if (input.threadRootMessageId) {
      const root = await trx
        .selectFrom('collaboration.messages')
        .select(['id', 'thread_root_message_id'])
        .where('id', '=', input.threadRootMessageId)
        .where('channel_id', '=', input.channelId)
        .executeTakeFirst()
      // The root must exist in THIS channel and itself be a root (not a reply).
      if (!root || root.thread_root_message_id !== null) {
        return { ok: false, reason: 'invalid_thread_root' }
      }
    }
    const message = await trx
      .insertInto('collaboration.messages')
      .values({
        organization_id: input.organizationId,
        channel_id: input.channelId,
        author_user_id: input.authorUserId,
        body: input.body,
        visibility: input.visibility ?? 'internal',
        thread_root_message_id: input.threadRootMessageId ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    // Split targets by provenance so mute suppresses group noise without silencing a
    // direct ping. explicit = mentions[] (unchanged — may include the author for a
    // deliberate self-mention); broadcast = the server-resolved @channel ∪ @here scopes
    // (both exclude the author). resolveMentions dedups + mute-filters into one pass, so a
    // user in both scopes still gets exactly one notification + one message_mentions row.
    const explicit = input.mentions ?? []
    const broadcast = new Set<string>()
    if (input.mentionChannel) {
      for (const id of await channelMemberMentionTargets(
        trx,
        input.channelId,
        input.authorUserId,
        input.logger
      )) {
        broadcast.add(id)
      }
    }
    if (input.mentionHere && input.presentUserIds) {
      for (const id of input.presentUserIds) {
        if (id !== input.authorUserId) {
          broadcast.add(id)
        }
      }
    }
    if (explicit.length > 0 || broadcast.size > 0) {
      await resolveMentions(trx, input.organizationId, input.channelId, message.id, {
        explicit,
        broadcast: [...broadcast]
      })
    }
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      const linked = await linkAttachmentsTx(trx, input.channelId, message.id, input.attachmentIds)
      if (!linked) {
        // A concurrent post consumed one after our pre-check — roll back this tx.
        throw new Error('attachment link race; retry')
      }
    }
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
    // A brand-new message has no replies/reactions; its just-linked attachments are read back.
    const attachments =
      (await attachmentSummariesForMessages(trx, [message.id])).get(message.id) ?? []
    return { ok: true, message: mapMessage(message, 0, [], attachments) }
  })
}

/** Fetches one message enriched with its reactions summary + reply count (used for
 *  idempotent-replay of postMessage and the reaction responses). */
export async function getMessageWithReactions(
  db: Kysely<Database>,
  organizationId: string,
  messageId: string,
  userId: string
): Promise<MessageResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('collaboration.messages')
      .selectAll()
      .where('id', '=', messageId)
      .executeTakeFirst()
    if (!row) {
      return null
    }
    const [enriched] = await enrichMessages(trx, [row], userId)
    return enriched ?? null
  })
}

export type ListMessagesResult =
  | { ok: true; messages: MessageResource[]; nextCursor: string | null }
  | { ok: false; reason: 'channel_not_found' | 'not_a_member' }

/**
 * Lists a channel's messages oldest first, keyset-paginated by (created_at, id).
 * With threadRootMessageId set it returns only that thread's replies; otherwise the
 * whole channel timeline. Member-gated; each message carries its reply count +
 * reactions summary.
 */
export async function listChannelMessages(
  db: Kysely<Database>,
  organizationId: string,
  channelId: string,
  userId: string,
  options: { limit?: number; afterMessageId?: string; threadRootMessageId?: string } = {}
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
    query =
      options.threadRootMessageId === undefined
        ? query
        : query.where('thread_root_message_id', '=', options.threadRootMessageId)
    if (options.afterMessageId) {
      // Keyset comparison entirely in SQL so the cursor's microsecond timestamp
      // keeps full precision (a JS Date round-trip truncates to ms and re-includes it).
      query = query.where(
        sql<boolean>`(created_at, id) > (select created_at, id from collaboration.messages where id = ${options.afterMessageId})`
      )
    }
    const rows = await query.orderBy('created_at').orderBy('id').limit(limit).execute()
    const messages = await enrichMessages(trx, rows, userId)
    const nextCursor =
      messages.length === limit ? (messages[messages.length - 1]?.id ?? null) : null
    return { ok: true, messages, nextCursor }
  })
}
