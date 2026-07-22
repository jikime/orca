import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import { isChannelMemberTx } from './channel-store'
import { withTenantTransaction } from './tenant-transaction'

export type ChannelNotificationLevel = 'all' | 'mentions' | 'none'

export type NotificationPreferencesResource = {
  desktopEnabled: boolean
  dndEnabled: boolean
  dndStartMinute: number
  dndEndMinute: number
  timezone: string
  channelLevels: { channelId: string; level: ChannelNotificationLevel }[]
}

const DEFAULT_PREFERENCES: Omit<NotificationPreferencesResource, 'channelLevels'> = {
  desktopEnabled: true,
  dndEnabled: false,
  dndStartMinute: 22 * 60,
  dndEndMinute: 8 * 60,
  timezone: 'UTC'
}

export async function getNotificationPreferences(
  db: Kysely<Database>,
  organizationId: string,
  userId: string
): Promise<NotificationPreferencesResource> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const [preferences, levels] = await Promise.all([
      trx
        .selectFrom('collaboration.notification_preferences')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirst(),
      trx
        .selectFrom('collaboration.channel_notification_preferences')
        .select(['channel_id', 'level'])
        .where('user_id', '=', userId)
        .orderBy('channel_id')
        .execute()
    ])
    return {
      desktopEnabled: preferences?.desktop_enabled ?? DEFAULT_PREFERENCES.desktopEnabled,
      dndEnabled: preferences?.dnd_enabled ?? DEFAULT_PREFERENCES.dndEnabled,
      dndStartMinute: preferences?.dnd_start_minute ?? DEFAULT_PREFERENCES.dndStartMinute,
      dndEndMinute: preferences?.dnd_end_minute ?? DEFAULT_PREFERENCES.dndEndMinute,
      timezone: preferences?.timezone ?? DEFAULT_PREFERENCES.timezone,
      channelLevels: levels.map((row) => ({
        channelId: row.channel_id,
        level: row.level as ChannelNotificationLevel
      }))
    }
  })
}

export async function updateNotificationPreferences(
  db: Kysely<Database>,
  input: {
    organizationId: string
    userId: string
    desktopEnabled?: boolean
    dndEnabled?: boolean
    dndStartMinute?: number
    dndEndMinute?: number
    timezone?: string
  }
): Promise<NotificationPreferencesResource> {
  const current = await getNotificationPreferences(db, input.organizationId, input.userId)
  await withTenantTransaction(db, input.organizationId, async (trx) => {
    await trx
      .insertInto('collaboration.notification_preferences')
      .values({
        organization_id: input.organizationId,
        user_id: input.userId,
        desktop_enabled: input.desktopEnabled ?? current.desktopEnabled,
        dnd_enabled: input.dndEnabled ?? current.dndEnabled,
        dnd_start_minute: input.dndStartMinute ?? current.dndStartMinute,
        dnd_end_minute: input.dndEndMinute ?? current.dndEndMinute,
        timezone: input.timezone ?? current.timezone
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'user_id']).doUpdateSet({
          desktop_enabled: input.desktopEnabled ?? current.desktopEnabled,
          dnd_enabled: input.dndEnabled ?? current.dndEnabled,
          dnd_start_minute: input.dndStartMinute ?? current.dndStartMinute,
          dnd_end_minute: input.dndEndMinute ?? current.dndEndMinute,
          timezone: input.timezone ?? current.timezone,
          updated_at: sql`now()`
        })
      )
      .execute()
  })
  return getNotificationPreferences(db, input.organizationId, input.userId)
}

export async function setChannelNotificationLevel(
  db: Kysely<Database>,
  input: {
    organizationId: string
    channelId: string
    userId: string
    level: ChannelNotificationLevel
  }
): Promise<'updated' | 'channel_not_found' | 'not_a_member'> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const channel = await trx
      .selectFrom('collaboration.channels')
      .select('id')
      .where('id', '=', input.channelId)
      .executeTakeFirst()
    if (!channel) return 'channel_not_found'
    if (!(await isChannelMemberTx(trx, input.channelId, input.userId))) return 'not_a_member'
    await trx
      .insertInto('collaboration.channel_notification_preferences')
      .values({
        organization_id: input.organizationId,
        channel_id: input.channelId,
        user_id: input.userId,
        level: input.level
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'channel_id', 'user_id']).doUpdateSet({
          level: input.level,
          updated_at: sql`now()`
        })
      )
      .execute()
    return 'updated'
  })
}

export async function notificationSuppressedUserIdsTx(
  trx: Transaction<Database>,
  channelId: string,
  candidateUserIds: readonly string[]
): Promise<Set<string>> {
  if (candidateUserIds.length === 0) return new Set()
  const rows = await trx
    .selectFrom('collaboration.channel_notification_preferences')
    .select('user_id')
    .where('channel_id', '=', channelId)
    .where('level', '=', 'none')
    .where('user_id', 'in', [...candidateUserIds])
    .execute()
  return new Set(rows.map((row) => row.user_id))
}

export async function allMessageNotificationUserIdsTx(
  trx: Transaction<Database>,
  channelId: string,
  authorUserId: string
): Promise<string[]> {
  const rows = await trx
    .selectFrom('collaboration.channel_notification_preferences as preference')
    .innerJoin('collaboration.channel_members as member', (join) =>
      join
        .onRef('member.organization_id', '=', 'preference.organization_id')
        .onRef('member.channel_id', '=', 'preference.channel_id')
        .onRef('member.user_id', '=', 'preference.user_id')
    )
    .select('preference.user_id')
    .where('preference.channel_id', '=', channelId)
    .where('preference.level', '=', 'all')
    .where('preference.user_id', '<>', authorUserId)
    .execute()
  return rows.map((row) => row.user_id)
}
