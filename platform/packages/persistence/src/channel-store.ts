import { randomUUID } from 'node:crypto'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeResourceType
} from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

export type ChannelVisibility = 'internal' | 'project' | 'customer'
export type ChannelKind = 'channel' | 'dm'

export type ChannelResource = {
  id: string
  organizationId: string
  name: string
  kind: ChannelKind
  scopeType: string
  scopeId: string | null
  visibility: ChannelVisibility
  topic: string
  description: string
  retentionDays: number | null
  version: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  // For DMs/group DMs: the participant user ids, so a client labels the row by the
  // other member(s) instead of the generic stored name. Absent for regular channels.
  memberUserIds?: string[]
  // Unread messages for the requesting user (messages after their read cursor,
  // excluding their own). Set only by the per-member channel list.
  unreadCount?: number
  // Present only on the per-member list so clients can place the unread boundary.
  lastReadMessageId?: string | null
}

export function mapChannelRow(row: {
  id: string
  organization_id: string
  name: string
  kind: string
  scope_type: string
  scope_id: string | null
  visibility: string
  topic: string
  description: string
  retention_days: number | null
  version: string | number
  archived_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}): ChannelResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    kind: row.kind as ChannelKind,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    visibility: row.visibility as ChannelVisibility,
    topic: row.topic,
    description: row.description,
    retentionDays: row.retention_days,
    version: Number(row.version),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

/** The deterministic DM key: sorted participant user-ids joined, so createDm(A,B) and
 *  createDm(B,A) map to the same key (idempotent find-or-create). A group DM (N>2) uses
 *  the SAME sorted-join over ALL participants, so {A,B,C} keys distinctly from {A,B}. */
export function computeDmKey(userIds: readonly string[]): string {
  return [...new Set(userIds)].toSorted().join(':')
}

/**
 * Enqueues a collaboration resource-change on the SAME outbox the delivery/artifact
 * verticals use — so channel/message invalidations ride the existing Worker →
 * gateway path with zero new transport code (the resourceType union was extended).
 */
export async function emitCollaborationChange(
  trx: Transaction<Database>,
  organizationId: string,
  resourceType: ResourceChangeResourceType,
  resourceId: string,
  version: number,
  changeKind: 'created' | 'updated' | 'archived'
): Promise<void> {
  const outboxId = randomUUID()
  const occurredAt = new Date().toISOString()
  const cloudEvent = buildResourceChangeCloudEvent({
    organizationId,
    eventId: outboxId,
    resourceType,
    resourceId,
    changeKind,
    version,
    occurredAt
  })
  await trx
    .insertInto('operations.outbox_events')
    .values({
      id: outboxId,
      organization_id: organizationId,
      aggregate_type: resourceType,
      aggregate_id: resourceId,
      aggregate_version: version,
      event_type: cloudEvent.type,
      event_schema_version: 1,
      payload: JSON.stringify(cloudEvent),
      occurred_at: occurredAt,
      available_at: occurredAt
    })
    .execute()
}

/** True when the user is on the channel's roster (the read/post gate). The roster is
 *  an explicit list (channel_members), distinct from identity.resource_grants. */
export async function isChannelMemberTx(
  trx: Transaction<Database>,
  channelId: string,
  userId: string
): Promise<boolean> {
  const row = await trx
    .selectFrom('collaboration.channel_members')
    .select('user_id')
    .where('channel_id', '=', channelId)
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return row !== undefined
}

/** The user-ids on a channel's roster. The gateway uses this to fan out ephemeral
 *  typing only to a channel's members (a non-member must not learn who is typing). */
export async function listChannelMemberUserIds(
  db: Kysely<Database>,
  organizationId: string,
  channelId: string
): Promise<string[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('collaboration.channel_members')
      .select('user_id')
      .where('channel_id', '=', channelId)
      .execute()
    return rows.map((row) => row.user_id)
  })
}

/** Adds a user to a channel's roster (idempotent). Used by createChannel for the
 *  creator; a join/invite endpoint is a later increment. */
export async function addChannelMember(
  db: Kysely<Database>,
  input: { organizationId: string; channelId: string; userId: string; role?: string }
): Promise<void> {
  await withTenantTransaction(db, input.organizationId, async (trx) => {
    await trx
      .insertInto('collaboration.channel_members')
      .values({
        organization_id: input.organizationId,
        channel_id: input.channelId,
        user_id: input.userId,
        role: input.role ?? 'member'
      })
      .onConflict((oc) => oc.columns(['organization_id', 'channel_id', 'user_id']).doNothing())
      .execute()
  })
}

/**
 * Creates a channel and enrolls the creator as its first member, in one tenant tx
 * (channel + roster row + audit + outbox channel.created).
 */
export async function createChannel(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    name: string
    visibility?: ChannelVisibility
  }
): Promise<ChannelResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const channel = await trx
      .insertInto('collaboration.channels')
      .values({
        organization_id: input.organizationId,
        name: input.name,
        visibility: input.visibility ?? 'internal'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('collaboration.channel_members')
      .values({
        organization_id: input.organizationId,
        channel_id: channel.id,
        user_id: input.actorUserId,
        role: 'owner'
      })
      .execute()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'channel.created',
        target_type: 'channel',
        target_id: channel.id
      })
      .execute()
    await emitCollaborationChange(trx, input.organizationId, 'channel', channel.id, 1, 'created')
    return mapChannelRow(channel)
  })
}

export type GetChannelResult =
  | { ok: true; channel: ChannelResource }
  | { ok: false; reason: 'not_found' | 'not_a_member' }

/** Reads a channel, gated on the caller's roster membership (403 vs the channel
 *  existing is a membership question, not an existence oracle). */
export async function getChannelForMember(
  db: Kysely<Database>,
  organizationId: string,
  channelId: string,
  userId: string
): Promise<GetChannelResult> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const channel = await trx
      .selectFrom('collaboration.channels')
      .selectAll()
      .where('id', '=', channelId)
      .executeTakeFirst()
    if (!channel) {
      return { ok: false, reason: 'not_found' }
    }
    if (!(await isChannelMemberTx(trx, channelId, userId))) {
      return { ok: false, reason: 'not_a_member' }
    }
    return { ok: true, channel: mapChannelRow(channel) }
  })
}

/** The channels the caller is a member of. A DM is just a channel with kind='dm', so
 *  it appears here too; the optional kind filter (?kind=dm) narrows to DMs or normal
 *  channels without a separate resource. */
export async function listChannels(
  db: Kysely<Database>,
  organizationId: string,
  userId: string,
  filter: { kind?: ChannelKind } = {}
): Promise<ChannelResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('collaboration.channels')
      .innerJoin('collaboration.channel_members', (join) =>
        join
          .onRef('collaboration.channel_members.channel_id', '=', 'collaboration.channels.id')
          .on('collaboration.channel_members.user_id', '=', userId)
      )
      .selectAll('collaboration.channels')
    if (filter.kind) {
      query = query.where('collaboration.channels.kind', '=', filter.kind)
    }
    const rows = await query.orderBy('collaboration.channels.created_at').execute()
    const channels = rows.map((row) =>
      mapChannelRow({ ...row, version: row.version as string | number })
    )
    // A DM's stored name is a generic placeholder ('Direct Message'); attach the
    // roster so the client can label the row by the other participant(s).
    const dmIds = channels.filter((channel) => channel.kind === 'dm').map((channel) => channel.id)
    if (dmIds.length > 0) {
      const memberRows = await trx
        .selectFrom('collaboration.channel_members')
        .select(['channel_id', 'user_id'])
        .where('channel_id', 'in', dmIds)
        .execute()
      const byChannel = new Map<string, string[]>()
      for (const member of memberRows) {
        const list = byChannel.get(member.channel_id) ?? []
        list.push(member.user_id)
        byChannel.set(member.channel_id, list)
      }
      for (const channel of channels) {
        if (channel.kind === 'dm') {
          channel.memberUserIds = byChannel.get(channel.id) ?? []
        }
      }
    }
    const channelIds = channels.map((channel) => channel.id)
    if (channelIds.length > 0) {
      const cursorRows = await trx
        .selectFrom('collaboration.read_cursors')
        .select(['channel_id', 'last_read_message_id'])
        .where('user_id', '=', userId)
        .where('channel_id', 'in', channelIds)
        .execute()
      const cursorByChannel = new Map(
        cursorRows.map((row) => [row.channel_id, row.last_read_message_id])
      )
      // Unread = messages after the user's read cursor (last_read_at), excluding
      // their own. A missing cursor row means the whole channel is unread.
      const unreadRows = await trx
        .selectFrom('collaboration.messages')
        .leftJoin('collaboration.read_cursors', (join) =>
          join
            .onRef(
              'collaboration.read_cursors.organization_id',
              '=',
              'collaboration.messages.organization_id'
            )
            .onRef(
              'collaboration.read_cursors.channel_id',
              '=',
              'collaboration.messages.channel_id'
            )
            .on('collaboration.read_cursors.user_id', '=', userId)
        )
        .select('collaboration.messages.channel_id as channelId')
        .select((eb) => eb.fn.countAll<string>().as('unread'))
        .where('collaboration.messages.channel_id', 'in', channelIds)
        .where('collaboration.messages.author_user_id', '<>', userId)
        .where((eb) =>
          eb.or([
            eb('collaboration.read_cursors.last_read_at', 'is', null),
            eb(
              'collaboration.messages.created_at',
              '>',
              eb.ref('collaboration.read_cursors.last_read_at')
            )
          ])
        )
        .groupBy('collaboration.messages.channel_id')
        .execute()
      const unreadByChannel = new Map(unreadRows.map((row) => [row.channelId, Number(row.unread)]))
      for (const channel of channels) {
        channel.unreadCount = unreadByChannel.get(channel.id) ?? 0
        channel.lastReadMessageId = cursorByChannel.get(channel.id) ?? null
      }
    }
    return channels
  })
}

/** Reads a channel's kind for a management gate (channel.manage ops are denied on a
 *  DM regardless of role). Returns null if the channel doesn't exist. */
export async function getChannelKind(
  db: Kysely<Database>,
  organizationId: string,
  channelId: string
): Promise<ChannelKind | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('collaboration.channels')
      .select('kind')
      .where('id', '=', channelId)
      .executeTakeFirst()
    return row ? (row.kind as ChannelKind) : null
  })
}

/** True when the user holds an active membership in the org (used to reject adding a
 *  non-org-member to a channel, and DMing someone outside your org). */
export async function isOrgMember(
  db: Kysely<Database>,
  organizationId: string,
  userId: string
): Promise<boolean> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('identity.memberships')
      .select('user_id')
      .where('user_id', '=', userId)
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .executeTakeFirst()
    return row !== undefined
  })
}

export type CreateDmResult = { channel: ChannelResource; created: boolean }

/**
 * Finds or creates the 2-party DM between the caller and another org member,
 * idempotently via the deterministic dm_key. createDm(A,B) and createDm(B,A) resolve
 * to the same channel; a concurrent double-create resolves to one via the partial
 * unique index (the loser re-reads the winner's row). Both participants become
 * members. The other user MUST be an active member of the SAME org.
 */
export async function createDm(
  db: Kysely<Database>,
  input: { organizationId: string; actorUserId: string; otherUserId: string }
): Promise<CreateDmResult | { error: 'invalid_target' }> {
  const dmKey = computeDmKey([input.actorUserId, input.otherUserId])
  // Known without a query: a 1:1 DM's roster is exactly these two.
  const memberUserIds = [...new Set([input.actorUserId, input.otherUserId])]
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    // The other participant must be a real member of this org — no cross-org DMs.
    const target = await trx
      .selectFrom('identity.memberships')
      .select('user_id')
      .where('user_id', '=', input.otherUserId)
      .where('organization_id', '=', input.organizationId)
      .where('status', '=', 'active')
      .executeTakeFirst()
    if (!target && input.otherUserId !== input.actorUserId) {
      return { error: 'invalid_target' as const }
    }
    const existing = await trx
      .selectFrom('collaboration.channels')
      .selectAll()
      .where('kind', '=', 'dm')
      .where('dm_key', '=', dmKey)
      .executeTakeFirst()
    if (existing) {
      return { channel: { ...mapChannelRow(existing), memberUserIds }, created: false }
    }
    const inserted = await trx
      .insertInto('collaboration.channels')
      .values({
        organization_id: input.organizationId,
        name: 'Direct Message',
        kind: 'dm',
        dm_key: dmKey,
        visibility: 'internal'
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'dm_key']).where('kind', '=', 'dm').doNothing()
      )
      .returningAll()
      .executeTakeFirst()
    if (!inserted) {
      // Lost a concurrent create — the winner's row now exists; return it.
      const winner = await trx
        .selectFrom('collaboration.channels')
        .selectAll()
        .where('kind', '=', 'dm')
        .where('dm_key', '=', dmKey)
        .executeTakeFirstOrThrow()
      return { channel: { ...mapChannelRow(winner), memberUserIds }, created: false }
    }
    for (const userId of new Set([input.actorUserId, input.otherUserId])) {
      await trx
        .insertInto('collaboration.channel_members')
        .values({
          organization_id: input.organizationId,
          channel_id: inserted.id,
          user_id: userId,
          role: 'member'
        })
        .onConflict((oc) => oc.columns(['organization_id', 'channel_id', 'user_id']).doNothing())
        .execute()
    }
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'channel.created',
        target_type: 'channel',
        target_id: inserted.id
      })
      .execute()
    await emitCollaborationChange(trx, input.organizationId, 'channel', inserted.id, 1, 'created')
    return { channel: { ...mapChannelRow(inserted), memberUserIds }, created: true }
  })
}

// Group DM participant bounds (distinct set, including the creator). Min 3 keeps
// /group-dms unambiguous from the 2-party /dms endpoint (a 2-distinct set IS a 1:1 DM).
// Max caps roster/notification blast radius; exceeding it is a create-time rejection,
// never a silent truncation.
export const GROUP_DM_MIN_PARTICIPANTS = 3
export const GROUP_DM_MAX_PARTICIPANTS = 50

export type CreateGroupDmResult =
  | CreateDmResult
  | { error: 'invalid_target' | 'too_few_participants' | 'too_many_participants' }

/**
 * Finds or creates the N-party group DM among the caller and the given org members,
 * idempotently via the deterministic dm_key over the DISTINCT participant set. Because
 * the key includes every participant, {A,B,C} resolves to a different channel than the
 * 1:1 {A,B} — no collision. Same find-or-create race handling as createDm (partial
 * unique index; the loser re-reads the winner). Every participant becomes a member and
 * MUST be an active member of the SAME org. Reuses computeDmKey and the createDm race
 * pattern so the two endpoints never diverge.
 */
export async function createGroupDm(
  db: Kysely<Database>,
  input: { organizationId: string; actorUserId: string; participantUserIds: string[] }
): Promise<CreateGroupDmResult> {
  const distinct = [...new Set([input.actorUserId, ...input.participantUserIds])]
  if (distinct.length < GROUP_DM_MIN_PARTICIPANTS) {
    return { error: 'too_few_participants' as const }
  }
  if (distinct.length > GROUP_DM_MAX_PARTICIPANTS) {
    return { error: 'too_many_participants' as const }
  }
  const dmKey = computeDmKey(distinct)
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    // Every non-actor participant must be an active member of this org — no cross-org
    // group DMs. Reject the whole roster if any is invalid (do not leak which one).
    const others = distinct.filter((id) => id !== input.actorUserId)
    const activeRows = await trx
      .selectFrom('identity.memberships')
      .select('user_id')
      .where('user_id', 'in', others)
      .where('organization_id', '=', input.organizationId)
      .where('status', '=', 'active')
      .execute()
    const activeUserIds = new Set(activeRows.map((row) => row.user_id))
    if (others.some((id) => !activeUserIds.has(id))) {
      return { error: 'invalid_target' as const }
    }
    const existing = await trx
      .selectFrom('collaboration.channels')
      .selectAll()
      .where('kind', '=', 'dm')
      .where('dm_key', '=', dmKey)
      .executeTakeFirst()
    if (existing) {
      return { channel: { ...mapChannelRow(existing), memberUserIds: distinct }, created: false }
    }
    const inserted = await trx
      .insertInto('collaboration.channels')
      .values({
        organization_id: input.organizationId,
        name: 'Group Message',
        kind: 'dm',
        dm_key: dmKey,
        visibility: 'internal'
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'dm_key']).where('kind', '=', 'dm').doNothing()
      )
      .returningAll()
      .executeTakeFirst()
    if (!inserted) {
      // Lost a concurrent create — the winner's row now exists; return it.
      const winner = await trx
        .selectFrom('collaboration.channels')
        .selectAll()
        .where('kind', '=', 'dm')
        .where('dm_key', '=', dmKey)
        .executeTakeFirstOrThrow()
      return { channel: { ...mapChannelRow(winner), memberUserIds: distinct }, created: false }
    }
    for (const userId of distinct) {
      await trx
        .insertInto('collaboration.channel_members')
        .values({
          organization_id: input.organizationId,
          channel_id: inserted.id,
          user_id: userId,
          role: 'member'
        })
        .onConflict((oc) => oc.columns(['organization_id', 'channel_id', 'user_id']).doNothing())
        .execute()
    }
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: 'channel.created',
        target_type: 'channel',
        target_id: inserted.id
      })
      .execute()
    await emitCollaborationChange(trx, input.organizationId, 'channel', inserted.id, 1, 'created')
    return { channel: { ...mapChannelRow(inserted), memberUserIds: distinct }, created: true }
  })
}
