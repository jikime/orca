import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { emitCollaborationChange, type ChannelResource } from './channel-store'
import { withTenantTransaction } from './tenant-transaction'

export type ChannelMemberResource = {
  userId: string
  role: string
  addedAt: string
}

export type UpdateChannelResult =
  | { ok: true; channel: ChannelResource }
  | { ok: false; reason: 'not_found' | 'version_conflict' | 'dm_roster_fixed' }

function mapManagedChannel(row: {
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
    kind: row.kind as ChannelResource['kind'],
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    visibility: row.visibility as ChannelResource['visibility'],
    topic: row.topic,
    description: row.description,
    retentionDays: row.retention_days,
    version: Number(row.version),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export async function listChannelMembers(
  db: Kysely<Database>,
  organizationId: string,
  channelId: string
): Promise<ChannelMemberResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('collaboration.channel_members')
      .select(['user_id', 'role', 'added_at'])
      .where('channel_id', '=', channelId)
      .orderBy('added_at')
      .execute()
    return rows.map((row) => ({
      userId: row.user_id,
      role: row.role,
      addedAt: new Date(row.added_at).toISOString()
    }))
  })
}

export async function removeChannelMember(
  db: Kysely<Database>,
  input: { organizationId: string; channelId: string; userId: string }
): Promise<'removed' | 'not_found' | 'last_owner'> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const member = await trx
      .selectFrom('collaboration.channel_members')
      .select('role')
      .where('channel_id', '=', input.channelId)
      .where('user_id', '=', input.userId)
      .executeTakeFirst()
    if (!member) return 'not_found'
    if (member.role === 'owner') {
      const otherOwner = await trx
        .selectFrom('collaboration.channel_members')
        .select('user_id')
        .where('channel_id', '=', input.channelId)
        .where('role', '=', 'owner')
        .where('user_id', '<>', input.userId)
        .executeTakeFirst()
      if (!otherOwner) return 'last_owner'
    }
    await trx
      .deleteFrom('collaboration.channel_members')
      .where('channel_id', '=', input.channelId)
      .where('user_id', '=', input.userId)
      .execute()
    return 'removed'
  })
}

export async function updateChannel(
  db: Kysely<Database>,
  input: {
    organizationId: string
    channelId: string
    actorUserId: string
    expectedVersion: number
    name?: string
    topic?: string
    description?: string
    archived?: boolean
    retentionDays?: number | null
  }
): Promise<UpdateChannelResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('collaboration.channels')
      .selectAll()
      .where('id', '=', input.channelId)
      .executeTakeFirst()
    if (!current) return { ok: false, reason: 'not_found' }
    if (current.kind === 'dm') return { ok: false, reason: 'dm_roster_fixed' }
    if (Number(current.version) !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict' }
    }
    const archivedAt =
      input.archived === undefined
        ? current.archived_at
        : input.archived
          ? (current.archived_at ?? new Date())
          : null
    const nextVersion = Number(current.version) + 1
    const updated = await trx
      .updateTable('collaboration.channels')
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.topic !== undefined ? { topic: input.topic } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.retentionDays !== undefined ? { retention_days: input.retentionDays } : {}),
        archived_at: archivedAt,
        version: nextVersion,
        updated_at: new Date()
      })
      .where('id', '=', input.channelId)
      .where('version', '=', String(input.expectedVersion))
      .returningAll()
      .executeTakeFirst()
    if (!updated) return { ok: false, reason: 'version_conflict' }
    const becameArchived = current.archived_at === null && updated.archived_at !== null
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.actorUserId,
        action: becameArchived
          ? 'channel.archived'
          : current.archived_at !== null && updated.archived_at === null
            ? 'channel.restored'
            : 'channel.updated',
        target_type: 'channel',
        target_id: input.channelId
      })
      .execute()
    await emitCollaborationChange(
      trx,
      input.organizationId,
      'channel',
      input.channelId,
      nextVersion,
      becameArchived ? 'archived' : 'updated'
    )
    return { ok: true, channel: mapManagedChannel(updated) }
  })
}
