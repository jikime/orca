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
  version: number
  createdAt: string
  updatedAt: string
}

function mapChannel(row: {
  id: string
  organization_id: string
  name: string
  kind: string
  scope_type: string
  scope_id: string | null
  visibility: string
  version: string | number
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
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

/** The deterministic DM key: sorted participant user-ids joined, so createDm(A,B) and
 *  createDm(B,A) map to the same key (idempotent find-or-create). Group DM (N>2) uses
 *  the same sorted-join; this slice creates 2-party DMs. */
export function computeDmKey(userIds: readonly string[]): string {
  return [...new Set(userIds)].sort().join(':')
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
  changeKind: 'created' | 'updated'
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
    return mapChannel(channel)
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
    return { ok: true, channel: mapChannel(channel) }
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
    return rows.map((row) => mapChannel({ ...row, version: row.version as string | number }))
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
      return { channel: mapChannel(existing), created: false }
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
      return { channel: mapChannel(winner), created: false }
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
    return { channel: mapChannel(inserted), created: true }
  })
}
