import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  emitCollaborationChange,
  mapChannelRow,
  type ChannelResource,
  type ChannelVisibility
} from './channel-store'
import { withTenantTransaction } from './tenant-transaction'

export type ContextChannelScope = 'team' | 'project' | 'customer' | 'ticket' | 'meeting'

export type CreateContextChannelResult =
  | { ok: true; channel: ChannelResource; created: boolean }
  | { ok: false; reason: 'context_not_found' }

async function contextExists(
  trx: Transaction<Database>,
  scopeType: ContextChannelScope,
  scopeId: string
): Promise<boolean> {
  if (scopeType === 'team') {
    return Boolean(
      await trx
        .selectFrom('delivery.teams')
        .select('id')
        .where('id', '=', scopeId)
        .executeTakeFirst()
    )
  }
  if (scopeType === 'project') {
    return Boolean(
      await trx
        .selectFrom('delivery.projects')
        .select('id')
        .where('id', '=', scopeId)
        .executeTakeFirst()
    )
  }
  if (scopeType === 'customer') {
    return Boolean(
      await trx.selectFrom('crm.accounts').select('id').where('id', '=', scopeId).executeTakeFirst()
    )
  }
  if (scopeType === 'ticket') {
    return Boolean(
      await trx
        .selectFrom('service.tickets')
        .select('id')
        .where('id', '=', scopeId)
        .executeTakeFirst()
    )
  }
  return Boolean(
    await trx
      .selectFrom('meetings.meetings')
      .select('id')
      .where('id', '=', scopeId)
      .executeTakeFirst()
  )
}

async function joinContextChannel(
  trx: Transaction<Database>,
  organizationId: string,
  channelId: string,
  userId: string,
  role: 'owner' | 'member'
): Promise<void> {
  await trx
    .insertInto('collaboration.channel_members')
    .values({
      organization_id: organizationId,
      channel_id: channelId,
      user_id: userId,
      role
    })
    .onConflict((oc) => oc.columns(['organization_id', 'channel_id', 'user_id']).doNothing())
    .execute()
}

// A context owns one canonical channel. Opening it from another authorized
// surface joins that user instead of creating a parallel conversation.
export async function createOrJoinContextChannel(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    name: string
    visibility?: ChannelVisibility
    scopeType: ContextChannelScope
    scopeId: string
  }
): Promise<CreateContextChannelResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    if (!(await contextExists(trx, input.scopeType, input.scopeId))) {
      return { ok: false, reason: 'context_not_found' }
    }
    const existing = await trx
      .selectFrom('collaboration.channels')
      .selectAll()
      .where('scope_type', '=', input.scopeType)
      .where('scope_id', '=', input.scopeId)
      .executeTakeFirst()
    if (existing) {
      await joinContextChannel(trx, input.organizationId, existing.id, input.actorUserId, 'member')
      return { ok: true, channel: mapChannelRow(existing), created: false }
    }

    const inserted = await trx
      .insertInto('collaboration.channels')
      .values({
        organization_id: input.organizationId,
        name: input.name,
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        visibility: input.visibility ?? 'internal'
      })
      .onConflict((oc) => oc.columns(['organization_id', 'scope_type', 'scope_id']).doNothing())
      .returningAll()
      .executeTakeFirst()
    if (!inserted) {
      const winner = await trx
        .selectFrom('collaboration.channels')
        .selectAll()
        .where('scope_type', '=', input.scopeType)
        .where('scope_id', '=', input.scopeId)
        .executeTakeFirstOrThrow()
      await joinContextChannel(trx, input.organizationId, winner.id, input.actorUserId, 'member')
      return { ok: true, channel: mapChannelRow(winner), created: false }
    }
    await joinContextChannel(trx, input.organizationId, inserted.id, input.actorUserId, 'owner')
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
    return { ok: true, channel: mapChannelRow(inserted), created: true }
  })
}
