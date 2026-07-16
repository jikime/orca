import { randomUUID } from 'node:crypto'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeResourceType
} from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

export type ChannelVisibility = 'internal' | 'project' | 'customer'

export type ChannelResource = {
  id: string
  organizationId: string
  name: string
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
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    visibility: row.visibility as ChannelVisibility,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
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

/** The channels the caller is a member of. */
export async function listChannels(
  db: Kysely<Database>,
  organizationId: string,
  userId: string
): Promise<ChannelResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('collaboration.channels')
      .innerJoin('collaboration.channel_members', (join) =>
        join
          .onRef('collaboration.channel_members.channel_id', '=', 'collaboration.channels.id')
          .on('collaboration.channel_members.user_id', '=', userId)
      )
      .selectAll('collaboration.channels')
      .orderBy('collaboration.channels.created_at')
      .execute()
    return rows.map((row) => mapChannel({ ...row, version: row.version as string | number }))
  })
}
